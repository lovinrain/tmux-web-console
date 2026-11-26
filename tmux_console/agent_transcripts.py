"""Read native conversations by recorded agent ID without touching the terminal."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, BinaryIO

from .agent_sources import (
    EXTENDED_TRANSCRIPT_AGENTS,
    UUID_PATTERN,
    default_extended_transcript_roots,
    normalize_agent_session_id,
)
from .agy_sessions import agy_has_session, agy_revision, locate_agy_db, read_agy_records
from .opencode_sessions import (
    locate_opencode_db,
    opencode_has_session,
    opencode_revision,
    read_opencode_records,
)
from .pi_sessions import locate_pi_session, pi_session_header, read_pi_session_header
from .transcript_formats import (
    CONVERSATION_KINDS,
    codex_compaction_matches,
    pi_submitted_message,
    visible_messages,
)

AGENTS = {"codex", "claude", "copilot", "cursor", "grok"} | EXTENDED_TRANSCRIPT_AGENTS
_SQLITE_TRANSCRIPT_AGENTS = {"opencode", "agy"}
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_SCAN_BYTES = 32 * 1024 * 1024
MAX_PAGE_BYTES = 1024 * 1024
MAX_DISCOVERY_ENTRIES = 50_000
MAX_CURSOR_MESSAGES = 100_000
MAX_RECORDS_PER_PAGE = 5_000
MAX_CODEX_COMPACTION_RECORDS = 8


class TranscriptChangedError(ValueError):
    pass


class _Unsupported(ValueError):
    pass


def default_transcript_roots() -> dict[str, Path]:
    home = Path.home()
    defaults = {
        "codex": Path(os.environ.get("CODEX_HOME", home / ".codex")),
        "claude": Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) / "projects",
        "copilot": home / ".copilot" / "session-state",
        "cursor": home / ".cursor" / "chats",
        "grok": Path(os.environ.get("GROK_HOME", home / ".grok")) / "sessions",
    }
    return {
        **{agent: Path(os.environ.get(f"MUXDECK_{agent.upper()}_TRANSCRIPTS_DIR", root))
           for agent, root in defaults.items()},
        **default_extended_transcript_roots(),
    }


def _source_key(agent: dict[str, Any]) -> str:
    return f"{agent['agentType']}:{agent.get('agentSessionId') or ''}"


def _encode_cursor(value: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_cursor(value: str | None, key: str, view: str) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        if len(value) > 2048:
            raise ValueError()
        cursor = json.loads(base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True))
        if (not isinstance(cursor, dict) or cursor.get("v") != 2 or cursor.get("source") != key
                or cursor.get("view") != view
                or type(cursor.get("part")) is not int or not 0 <= cursor["part"] <= 2
                or not isinstance(cursor.get("file"), list) or len(cursor["file"]) != 2
                or any(type(part) is not int or part < 0 for part in cursor["file"])
                or type(cursor.get("offset")) is not int or cursor["offset"] < 0):
            raise ValueError()
        return cursor
    except (ValueError, TypeError, RecursionError, UnicodeError) as error:
        raise ValueError("invalid transcript cursor; refresh the transcript") from error


def _confined_file(root: Path, path: Path) -> Path:
    """Resolve an administrator-selected root, but do not follow child symlinks."""
    base = root.resolve(strict=True)
    current = base
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise OSError("linked transcript is unavailable")
    if not current.is_relative_to(base) or not stat.S_ISREG(current.stat().st_mode):
        raise OSError("transcript is not a regular file")
    return current


def _open_file(path: Path) -> BinaryIO:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("transcript is not a regular file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _digest(source: BinaryIO, start: int, length: int) -> str:
    position = source.tell()
    source.seek(start)
    value = hashlib.sha256(source.read(length)).hexdigest()
    source.seek(position)
    return value


def _native_header(source: BinaryIO, agent: str, identifier: str) -> None:
    if agent in {"pi", "omp"}:
        record = read_pi_session_header(source, allow_title=agent == "omp")
        source.seek(0)
        if not pi_session_header(record, identifier):
            raise _Unsupported("The native transcript header does not match the recorded conversation.")
        return
    if agent not in {"codex", "copilot"}:
        return
    line = source.readline(MAX_RECORD_BYTES + 1)
    source.seek(0)
    try:
        record = json.loads(line)
        if agent == "codex":
            payload = record["payload"]
            valid = record["type"] == "session_meta" and payload.get("id", payload.get("session_id")) == identifier
        else:
            valid = record["type"] == "session.start" and record["data"].get("sessionId") == identifier
        if not valid:
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError) as error:
        raise _Unsupported("The native transcript header does not match the recorded conversation.") from error


def _codex_compaction_follows(
    source: BinaryIO, end: int, message: dict[str, Any],
) -> tuple[bool, int, int]:
    """Look past accounting records only, within this page's pinned snapshot.

    Restore the stream so pagination and message IDs still use native offsets.
    Charge these bounded extra reads to the page's scan and record budgets.
    """
    position = source.tell()
    scanned = records = 0
    response_id = None
    try:
        while source.tell() < end and records < MAX_CODEX_COMPACTION_RECORDS and scanned < MAX_RECORD_BYTES:
            line = source.readline(min(end - source.tell(), MAX_RECORD_BYTES - scanned + 1))
            scanned += len(line)
            records += 1
            if not line:
                raise TranscriptChangedError("The transcript changed while being read. Refresh to retry.")
            if scanned > MAX_RECORD_BYTES or (not line.endswith(b"\n") and source.tell() < end):
                break
            try:
                record = json.loads(line)
            except (ValueError, RecursionError):
                break
            if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
                break
            payload = record["payload"]
            if record.get("type") == "token_usage_record":
                value = payload.get("response_id")
                response_id = value if isinstance(value, str) else None
                continue
            if record.get("type") == "event_msg" and payload.get("type") == "token_count":
                continue
            return codex_compaction_matches(message, record, response_id), scanned, records
        return False, scanned, records
    finally:
        source.seek(position)


@contextmanager
def _native_database(path: Path, *, timeout: float = 1) -> Iterator[sqlite3.Connection]:
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=timeout)) as connection:
        connection.execute("PRAGMA query_only = ON")
        # A read transaction pins metadata and records, including committed WAL data.
        connection.execute("BEGIN")
        yield connection


def _stat_signature(path: Path) -> tuple[int, int, int, int, int]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise OSError("the native transcript is not a regular file")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _database_signature(path: Path) -> tuple[int | None, ...]:
    signature: list[int | None] = list(_stat_signature(path)[:4])
    absent = (None,) * 4
    for suffix in ("-wal", "-journal"):
        try:
            companion = _stat_signature(path.with_name(path.name + suffix))[:4]
            # SQLite may create an empty sidecar or update its inode metadata
            # while opening a WAL-mode database for reading.
            signature.extend(companion if companion[2] else absent)
        except FileNotFoundError:
            signature.extend(absent)
    return tuple(signature)


def _pi_prompt_entries(record: dict[str, Any]) -> list[dict[str, Any]]:
    prompt = pi_submitted_message(record)
    if prompt is None:
        return []
    text, timestamp, complete = prompt
    return [{
        "role": "user", "kind": "prompt", "text": text, "timestamp": timestamp,
        "truncated": False, "complete": complete, "sourceId": record.get("id"),
    }]


def _append_page_entries(
    entries: list[dict[str, Any]], messages: list[dict[str, Any]], *, view: str,
    part: int, limit: int, size: int, key: str,
) -> tuple[int | None, int, bool]:
    """Append visible entries and return the index of the first deferred entry."""
    if part and part >= len(entries):
        raise ValueError("invalid transcript cursor; refresh the transcript")
    partial = False
    for index, entry in enumerate(entries):
        if index < part or view == "conversation" and entry["kind"] not in CONVERSATION_KINDS:
            continue
        if view == "prompts" and entry["kind"] != "prompt":
            continue
        source_text = entry.pop("sourceText", None)
        if view == "prompts":
            if source_text is not None:
                entry["text"], entry["truncated"] = source_text, False
        else:
            entry.pop("sourceId", None)
            entry.pop("complete", None)
        try:
            length = len(entry["text"].encode("utf-8"))
        except UnicodeError:
            partial = True
            continue
        if len(messages) >= limit or messages and size + length > MAX_PAGE_BYTES:
            return index, size, partial
        entry["id"] = f"{key}:{index}"
        messages.append(entry)
        size += length
        partial |= entry["truncated"]
    return None, size, partial


class AgentTranscriptReader:
    def __init__(self, *, roots: dict[str, Path] | None = None) -> None:
        self.roots = default_transcript_roots() if roots is None else roots

    def accepts_codex_reference(self, identifier: str) -> bool:
        """Validate a reconnect ID when its native header is available.

        A missing transcript does not invalidate an explicit exit instruction;
        transcript reads already report that file as unavailable. Never infer a
        conversation from its directory or accept a mismatched/worker header.
        """
        if not UUID_PATTERN.fullmatch(identifier):
            return False
        try:
            path = self._locate("codex", identifier)
            if path is None:
                return True
            with _open_file(path) as source:
                line = source.readline(65_537)
        except (OSError, _Unsupported):
            return True
        try:
            if len(line) > 65_536:
                return False
            record = json.loads(line)
            payload = record["payload"]
            origin = payload.get("source")
            return (record["type"] == "session_meta"
                    and payload.get("id", payload.get("session_id")) == identifier
                    and not (isinstance(origin, dict) and "subagent" in origin))
        except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
            return False

    def accepts_native_reference(self, agent: str, identifier: str) -> bool:
        """Verify the exact recorded ID against its native conversation store."""
        normalized = normalize_agent_session_id(agent, identifier)
        if agent not in EXTENDED_TRANSCRIPT_AGENTS or normalized is None:
            return False
        try:
            path = self._locate(agent, normalized)
            if path is None:
                return False
            if agent in _SQLITE_TRANSCRIPT_AGENTS:
                has_session = opencode_has_session if agent == "opencode" else agy_has_session
                with _native_database(path, timeout=0.1) as connection:
                    return has_session(connection, normalized)
            with _open_file(path) as source:
                _native_header(source, agent, normalized)
            return True
        except (OSError, sqlite3.Error, ValueError):
            return False

    def native_source_signature(self, agent: str, identifier: str) -> tuple | None:
        """Get a cheap freshness check for a submitted-message archive source."""
        normalized = normalize_agent_session_id(agent, identifier)
        if agent not in EXTENDED_TRANSCRIPT_AGENTS or normalized is None:
            return None
        try:
            path = self._locate(agent, normalized)
            if path is None:
                return None
            if agent in _SQLITE_TRANSCRIPT_AGENTS:
                return _database_signature(path)
            return _stat_signature(path)
        except FileNotFoundError:
            return None

    def _locate(self, agent: str, identifier: str) -> Path | None:
        root = self.roots.get(agent)
        if root is None or not root.exists():
            return None
        if agent in {"pi", "omp"}:
            path = locate_pi_session(root, identifier)
            return _confined_file(root, path) if path is not None else None
        if agent == "opencode":
            return locate_opencode_db(root)
        if agent == "agy":
            return locate_agy_db(root, identifier)
        if agent == "copilot":
            path = root / identifier / "events.jsonl"
            return _confined_file(root, path) if path.exists() else None
        # Search fixed native layouts by exact ID; never guess by CWD or newest chat.
        maximum_depth = {"codex": 4, "claude": 1, "cursor": 2, "grok": 2}[agent]
        pending = [(root, 0)]
        candidates: list[Path] = []
        visited = 0
        while pending:
            directory, depth = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_DISCOVERY_ENTRIES:
                        raise _Unsupported("The native transcript directory is too large to scan completely.")
                    if entry.is_symlink():
                        continue
                    path = Path(entry.path)
                    if entry.is_dir(follow_symlinks=False) and depth < maximum_depth:
                        if agent == "codex" and depth == 0 and entry.name not in {"sessions", "archived_sessions"}:
                            continue
                        if agent in {"cursor", "grok"} and depth == 1 and entry.name != identifier:
                            continue
                        pending.append((path, depth + 1))
                    elif entry.is_file(follow_symlinks=False):
                        matches = (
                            agent == "codex" and entry.name.startswith("rollout-") and entry.name.endswith(f"-{identifier}.jsonl")
                            or agent == "claude" and depth == 1 and entry.name == f"{identifier}.jsonl"
                            or agent == "cursor" and depth == 2 and entry.name == "store.db"
                            or agent == "grok" and depth == 2 and entry.name == "chat_history.jsonl"
                        )
                        if matches:
                            candidates.append(_confined_file(root, path))
        if not candidates:
            return None
        # The same Codex conversation can have an archived copy. Prefer its live file.
        candidates.sort(key=lambda path: ("archived_sessions" not in path.parts, path.stat().st_mtime_ns), reverse=True)
        return candidates[0]

    def read(
        self, agents: list[dict[str, Any]], *, selected: str | None = None,
        cursor: str | None = None, limit: int = 50, view: str = "all",
    ) -> dict[str, Any]:
        if view not in {"conversation", "all"}:
            raise ValueError("view must be conversation or all")
        return self._read(agents, selected=selected, cursor=cursor, limit=limit, view=view)

    def read_native_prompts(
        self, agent: str, identifier: str, *, cursor: str | None = None, limit: int = 100,
    ) -> dict[str, Any]:
        """Read submitted input with native source IDs and attachment completeness."""
        if agent not in EXTENDED_TRANSCRIPT_AGENTS:
            raise ValueError("native prompt reader does not support this agent")
        return self._read(
            [{"agentType": agent, "agentSessionId": identifier}],
            selected=None, cursor=cursor, limit=limit, view="prompts",
        )

    def _read(
        self, agents: list[dict[str, Any]], *, selected: str | None, cursor: str | None,
        limit: int, view: str,
    ) -> dict[str, Any]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        sources = list({
            _source_key(item): {"key": _source_key(item), "agentType": item["agentType"],
                                "agentSessionId": item.get("agentSessionId")}
            for item in sorted(agents, key=lambda item: item.get("lastSeenAt", 0))
            if item.get("agentType")
        }.values())
        # A later observation without an ID must not hide a conversation that
        # was actually recorded. Explicit selections still resolve exactly.
        identified = [item for item in sources if item["agentSessionId"]]
        chosen = next((item for item in sources if item["key"] == selected), None) if selected else ((identified or sources)[-1] if sources else None)
        if selected and chosen is None:
            raise ValueError("conversation does not belong to this session")
        result: dict[str, Any] = {"sources": sources, "selectedSource": chosen["key"] if chosen else None,
                                  "status": "unidentified", "messages": [], "nextCursor": None,
                                  "partial": False, "notice": "No conversation ID has been recorded for this pane."}
        if chosen is None or not chosen["agentSessionId"]:
            return result
        agent = chosen["agentType"]
        identifier = normalize_agent_session_id(agent, chosen["agentSessionId"])
        if agent not in AGENTS or identifier is None:
            result.update(status="unsupported", notice="This agent's native transcript format is not supported.")
            return result
        position = _decode_cursor(cursor, chosen["key"], view)
        try:
            path = self._locate(agent, identifier)
            if path is None:
                if position is not None and agent in EXTENDED_TRANSCRIPT_AGENTS:
                    raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
                page = None
            elif agent == "cursor":
                page = self._read_cursor(path, identifier, chosen["key"], position, limit, view)
            elif agent in _SQLITE_TRANSCRIPT_AGENTS:
                page = self._read_sqlite(path, agent, identifier, chosen["key"], position, limit, view)
            else:
                page = self._read_jsonl(path, agent, identifier, chosen["key"], position, limit, view)
            if page is None:
                result.update(status="missing", notice="The recorded conversation's local transcript was not found. It may have been removed or stored in a different agent directory.")
                return result
            result.update(status="available", notice=None, **page)
            if result["partial"]:
                result["notice"] = "Some native records could not be read or were too large. Long entries are marked when shortened."
        except _Unsupported as error:
            result.update(status="unsupported", notice=str(error))
        except (OSError, sqlite3.Error):
            result.update(status="unreadable", notice="The local transcript could not be read. Refresh to retry.")
        return result

    def _read_jsonl(
        self, path: Path, agent: str, identifier: str, key: str,
        cursor: dict[str, Any] | None, limit: int, view: str,
    ) -> dict[str, Any]:
        with _open_file(path) as source:
            info = os.fstat(source.fileno())
            file_id = [info.st_dev, info.st_ino]
            _native_header(source, agent, identifier)
            end, offset, skipping = info.st_size, 0, False
            part = cursor["part"] if cursor else 0
            if cursor is not None:
                cursor_end = cursor.get("end")
                offset, skipping = cursor["offset"], cursor.get("skip", False)
                if not isinstance(cursor_end, int) or isinstance(cursor_end, bool) or not 0 <= offset <= cursor_end or type(skipping) is not bool:
                    raise ValueError("invalid transcript cursor; refresh the transcript")
                end = cursor_end
                if (cursor["file"] != file_id or end > info.st_size
                        or cursor.get("head") != _digest(source, 0, min(end, 4096))
                        or cursor.get("anchor") != _digest(source, max(0, offset - 256), min(256, offset))):
                    raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
            head = _digest(source, 0, min(end, 4096))
            source.seek(offset)
            messages: list[dict[str, Any]] = []
            scanned = size = records = 0
            partial = skipping
            while (source.tell() < end and len(messages) < limit
                   and scanned < MAX_SCAN_BYTES and records < MAX_RECORDS_PER_PAGE):
                records += 1
                start = source.tell()
                line = source.readline(min(MAX_RECORD_BYTES + 1, end - start))
                if not line:
                    raise TranscriptChangedError("The transcript changed while being read. Refresh to retry.")
                # A page budget is not an oversized native record. Leave a valid
                # record whole for the next page instead of discarding its tail.
                if scanned and scanned + len(line) > MAX_SCAN_BYTES:
                    source.seek(start)
                    break
                scanned += len(line)
                if skipping or len(line) > MAX_RECORD_BYTES or (not line.endswith(b"\n") and source.tell() < end):
                    partial = True
                    skipping = not line.endswith(b"\n")
                    continue
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise TypeError()
                    if agent == "claude" and record.get("sessionId", identifier) != identifier:
                        partial = True
                        continue
                    entries = _pi_prompt_entries(record) if view == "prompts" else visible_messages(agent, record)
                except (ValueError, TypeError, RecursionError):
                    partial = True
                    continue
                if agent == "codex" and any(entry["kind"] == "response" for entry in entries):
                    compacted, ahead_bytes, ahead_records = _codex_compaction_follows(source, end, record)
                    scanned += ahead_bytes
                    records += ahead_records
                    if compacted:
                        for entry in entries:
                            if entry["kind"] == "response":
                                entry["kind"] = "context"
                deferred, size, entries_partial = _append_page_entries(
                    entries, messages, view=view, part=part, limit=limit, size=size, key=f"{key}:{start}",
                )
                partial |= entries_partial
                if deferred is not None:
                    part = deferred
                    source.seek(start)
                    break
                part = 0
            offset = source.tell()
            next_cursor = _encode_cursor({
                "v": 2, "source": key, "view": view, "part": part,
                "file": file_id, "offset": offset, "end": end,
                "skip": skipping, "head": head,
                "anchor": _digest(source, max(0, offset - 256), min(256, offset)),
            }) if offset < end else None
            return {"messages": messages, "nextCursor": next_cursor, "partial": partial}

    def _read_cursor(
        self, path: Path, identifier: str, key: str,
        cursor: dict[str, Any] | None, limit: int, view: str,
    ) -> dict[str, Any]:
        info = path.stat()
        file_id = [info.st_dev, info.st_ino]
        if cursor is not None and cursor["file"] != file_id:
            raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
        with _native_database(path) as connection:
            row = connection.execute("SELECT value FROM meta WHERE key = '0' AND length(value) <= ?", (MAX_RECORD_BYTES,)).fetchone()
            try:
                meta = json.loads(bytes.fromhex(row[0])) if row else None
                if not isinstance(meta, dict) or meta.get("agentId") != identifier:
                    raise ValueError()
                root = cursor.get("root") if cursor else meta.get("latestRootBlobId")
                if not isinstance(root, str) or not re.fullmatch(r"[a-f0-9]{64}", root):
                    raise ValueError()
            except (ValueError, TypeError, RecursionError) as error:
                raise _Unsupported("This Cursor conversation's storage format is not supported.") from error
            row = connection.execute("SELECT data FROM blobs WHERE id = ? AND length(data) <= ?", (root, MAX_RECORD_BYTES)).fetchone()
            if row is None:
                raise TranscriptChangedError("Cursor's saved conversation changed. Refresh to read it again.")
            ids = _cursor_message_ids(row[0])
            offset = cursor["offset"] if cursor else 0
            part = cursor["part"] if cursor else 0
            if offset > len(ids):
                raise ValueError("invalid transcript cursor; refresh the transcript")
            messages: list[dict[str, Any]] = []
            partial = False
            size = scanned = records = 0
            while (offset < len(ids) and len(messages) < limit
                   and scanned < MAX_SCAN_BYTES and records < MAX_RECORDS_PER_PAGE):
                records += 1
                row = connection.execute("SELECT data FROM blobs WHERE id = ? AND length(data) <= ?", (ids[offset], MAX_RECORD_BYTES)).fetchone()
                if row is None:
                    partial = True
                    part = 0
                    offset += 1
                    continue
                scanned += len(row[0])
                try:
                    record = json.loads(row[0])
                    if not isinstance(record, dict):
                        raise TypeError()
                    entries = visible_messages("cursor", record)
                except (ValueError, TypeError, RecursionError):
                    entries = []
                    partial = True
                deferred, size, entries_partial = _append_page_entries(
                    entries, messages, view=view, part=part, limit=limit, size=size, key=f"{key}:{root}:{offset}",
                )
                partial |= entries_partial
                if deferred is not None:
                    part = deferred
                    break
                part = 0
                offset += 1
            return {"messages": messages, "partial": partial, "nextCursor": _encode_cursor({
                "v": 2, "source": key, "view": view, "part": part,
                "file": file_id, "root": root, "offset": offset,
            }) if offset < len(ids) else None}


    def _read_sqlite(
        self, path: Path, agent: str, identifier: str, key: str,
        cursor: dict[str, Any] | None, limit: int, view: str,
    ) -> dict[str, Any] | None:
        signature = _database_signature(path)
        file_id = list(signature[:2])
        if cursor is not None and cursor["file"] != file_id:
            raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
        offset = cursor["offset"] if cursor else 0
        part = cursor["part"] if cursor else 0
        if offset >= (1 << 63):
            raise ValueError("invalid transcript cursor; refresh the transcript")
        get_revision = opencode_revision if agent == "opencode" else agy_revision
        read_records = read_opencode_records if agent == "opencode" else read_agy_records
        with _native_database(path) as connection:
            try:
                native_revision = get_revision(connection, identifier)
            except ValueError as error:
                raise _Unsupported(str(error)) from error
            if native_revision is None:
                if cursor is not None:
                    raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
                if agent == "agy":
                    raise _Unsupported("The native transcript metadata does not match the recorded conversation.")
                return None
            # OpenCode shares the database with unrelated sessions. Antigravity's
            # per-conversation file and WAL also detect same-size edits to older steps.
            revision_input = native_revision if agent == "opencode" else repr((native_revision, signature))
            revision = hashlib.sha256(revision_input.encode()).hexdigest()
            if cursor is not None and cursor.get("revision") != revision:
                raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")

            messages: list[dict[str, Any]] = []
            size = scanned = 0
            partial = more = False
            records = read_records(
                connection, identifier, offset=offset,
                limit=MAX_RECORDS_PER_PAGE + 1, max_record_bytes=MAX_RECORD_BYTES,
            )
            for index, (entries, record_bytes, record_partial) in enumerate(records):
                if (index >= MAX_RECORDS_PER_PAGE or len(messages) >= limit or scanned >= MAX_SCAN_BYTES
                        or scanned and scanned + record_bytes > MAX_SCAN_BYTES):
                    more = True
                    break
                scanned += record_bytes
                partial |= record_partial
                deferred, size, entries_partial = _append_page_entries(
                    entries, messages, view=view, part=part, limit=limit, size=size, key=f"{key}:{offset}",
                )
                partial |= entries_partial
                if deferred is not None:
                    part, more = deferred, True
                    break
                part = 0
                offset += 1
            if part and not more:
                raise ValueError("invalid transcript cursor; refresh the transcript")
            if list(_stat_signature(path)[:2]) != file_id:
                raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
            if agent == "agy" and _database_signature(path) != signature:
                raise TranscriptChangedError("The transcript changed while being read. Refresh to retry.")
            return {"messages": messages, "partial": partial, "nextCursor": _encode_cursor({
                "v": 2, "source": key, "view": view, "part": part,
                "file": file_id, "revision": revision, "offset": offset,
            }) if more else None}


def _cursor_message_ids(data: bytes) -> list[str]:
    """Cursor's root protobuf stores ordered message-blob hashes in field 1.

    Follow that list, not SQLite insertion order: abandoned branches and
    generated context blobs also remain in the content-addressed database.
    """
    if not isinstance(data, bytes):
        raise _Unsupported("This Cursor conversation's storage format is not supported.")
    position = 0

    def varint() -> int:
        nonlocal position
        value = 0
        for shift in range(0, 64, 7):
            if position >= len(data):
                break
            byte = data[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise _Unsupported("This Cursor conversation's storage format is not supported.")

    result: list[str] = []
    while position < len(data):
        tag = varint()
        field, wire = tag >> 3, tag & 7
        if field == 0:
            raise _Unsupported("This Cursor conversation's storage format is not supported.")
        if wire == 0:
            varint()
        elif wire in {1, 5}:
            position += 8 if wire == 1 else 4
        elif wire == 2:
            length = varint()
            if field == 1:
                if length != 32 or len(result) >= MAX_CURSOR_MESSAGES:
                    raise _Unsupported("This Cursor conversation's message list is not supported.")
                result.append(data[position:position + length].hex())
            position += length
        else:
            raise _Unsupported("This Cursor conversation's storage format is not supported.")
        if position > len(data):
            raise _Unsupported("This Cursor conversation's storage format is not supported.")
    return result
