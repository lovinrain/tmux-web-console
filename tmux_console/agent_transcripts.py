"""Read native conversations by recorded agent ID without touching the terminal."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
from contextlib import closing
from pathlib import Path
from typing import Any, BinaryIO

from .agent_reference import UUID_PATTERN
from .transcript_formats import visible_message

AGENTS = ("codex", "claude", "copilot", "cursor", "grok")
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_SCAN_BYTES = 32 * 1024 * 1024
MAX_PAGE_BYTES = 1024 * 1024
MAX_DISCOVERY_ENTRIES = 50_000
MAX_CURSOR_MESSAGES = 100_000
MAX_RECORDS_PER_PAGE = 5_000


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
    return {agent: Path(os.environ.get(f"MUXDECK_{agent.upper()}_TRANSCRIPTS_DIR", root))
            for agent, root in defaults.items()}


def _source_key(agent: dict[str, Any]) -> str:
    return f"{agent['agentType']}:{agent.get('agentSessionId') or ''}"


def _encode_cursor(value: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_cursor(value: str | None, key: str) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        if len(value) > 2048:
            raise ValueError()
        cursor = json.loads(base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True))
        if (not isinstance(cursor, dict) or cursor.get("v") != 1 or cursor.get("source") != key
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


class AgentTranscriptReader:
    def __init__(self, *, roots: dict[str, Path] | None = None) -> None:
        self.roots = default_transcript_roots() if roots is None else roots

    def _locate(self, agent: str, identifier: str) -> Path | None:
        root = self.roots.get(agent)
        if root is None or not root.exists():
            return None
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
        cursor: str | None = None, limit: int = 50,
    ) -> dict[str, Any]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        sources = list({
            _source_key(item): {"key": _source_key(item), "agentType": item["agentType"],
                                "agentSessionId": item.get("agentSessionId")}
            for item in sorted(agents, key=lambda item: item.get("lastSeenAt", 0))
            if item.get("agentType")
        }.values())
        chosen = next((item for item in sources if item["key"] == selected), None) if selected else (sources[-1] if sources else None)
        if selected and chosen is None:
            raise ValueError("conversation does not belong to this session")
        result: dict[str, Any] = {"sources": sources, "selectedSource": chosen["key"] if chosen else None,
                                  "status": "unidentified", "messages": [], "nextCursor": None,
                                  "partial": False, "notice": "No conversation ID has been recorded for this pane."}
        if chosen is None or not chosen["agentSessionId"]:
            return result
        agent, identifier = chosen["agentType"], chosen["agentSessionId"]
        if agent not in AGENTS or not isinstance(identifier, str) or not UUID_PATTERN.fullmatch(identifier):
            result.update(status="unsupported", notice="This agent's native transcript format is not supported.")
            return result
        position = _decode_cursor(cursor, chosen["key"])
        try:
            path = self._locate(agent, identifier.lower())
            if path is None:
                result.update(status="missing", notice="The recorded conversation's local transcript was not found. It may have been removed or stored in a different agent directory.")
                return result
            if agent == "cursor":
                page = self._read_cursor(path, identifier, chosen["key"], position, limit)
            else:
                page = self._read_jsonl(path, agent, identifier, chosen["key"], position, limit)
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
        cursor: dict[str, Any] | None, limit: int,
    ) -> dict[str, Any]:
        with _open_file(path) as source:
            info = os.fstat(source.fileno())
            file_id = [info.st_dev, info.st_ino]
            _native_header(source, agent, identifier)
            end, offset, skipping = info.st_size, 0, False
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
                line = source.readline(min(MAX_RECORD_BYTES + 1, end - start, MAX_SCAN_BYTES - scanned))
                if not line:
                    raise TranscriptChangedError("The transcript changed while being read. Refresh to retry.")
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
                    entry = visible_message(agent, record)
                except (ValueError, TypeError, RecursionError):
                    partial = True
                    continue
                if entry is None:
                    continue
                length = len(entry["text"].encode("utf-8"))
                if messages and size + length > MAX_PAGE_BYTES:
                    source.seek(start)
                    break
                entry["id"] = f"{key}:{start}"
                messages.append(entry)
                size += length
                partial |= entry["truncated"]
            offset = source.tell()
            next_cursor = _encode_cursor({
                "v": 1, "source": key, "file": file_id, "offset": offset, "end": end,
                "skip": skipping, "head": head,
                "anchor": _digest(source, max(0, offset - 256), min(256, offset)),
            }) if offset < end else None
            return {"messages": messages, "nextCursor": next_cursor, "partial": partial}

    def _read_cursor(
        self, path: Path, identifier: str, key: str,
        cursor: dict[str, Any] | None, limit: int,
    ) -> dict[str, Any]:
        info = path.stat()
        file_id = [info.st_dev, info.st_ino]
        if cursor is not None and cursor["file"] != file_id:
            raise TranscriptChangedError("The transcript changed or rotated. Refresh to read it again.")
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)) as connection:
            connection.execute("PRAGMA query_only = ON")
            # A read transaction gives the metadata and its blobs one consistent view,
            # including committed messages in Cursor's live WAL.
            connection.execute("BEGIN")
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
                    offset += 1
                    continue
                scanned += len(row[0])
                try:
                    record = json.loads(row[0])
                    if not isinstance(record, dict):
                        raise TypeError()
                    entry = visible_message("cursor", record)
                except (ValueError, TypeError, RecursionError):
                    entry = None
                    partial = True
                if entry is not None:
                    length = len(entry["text"].encode("utf-8"))
                    if messages and size + length > MAX_PAGE_BYTES:
                        break
                    entry["id"] = f"{key}:{root}:{offset}"
                    messages.append(entry)
                    size += length
                    partial |= entry["truncated"]
                offset += 1
            return {"messages": messages, "partial": partial, "nextCursor": _encode_cursor({
                "v": 1, "source": key, "file": file_id, "root": root, "offset": offset,
            }) if offset < len(ids) else None}


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
