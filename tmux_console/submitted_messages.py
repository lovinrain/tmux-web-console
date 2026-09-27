from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import threading
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from .agent_reference import UUID_PATTERN
from .session_registry import default_session_registry_path

LOGGER = logging.getLogger("muxdeck.submitted_messages")
SUPPORTED_AGENTS = ("claude", "codex")
MAX_NATIVE_RECORD_BYTES = 16 * 1024 * 1024
MAX_TIMESTAMP = 253_402_300_799_999
PASTED_TEXT = re.compile(r"\[Pasted text #(\d+)(?: \+\d+ lines)?\]")
CONTENT_HASH = re.compile(r"[0-9a-f]{16,128}")


class SubmittedMessageStoreUnavailable(OSError):
    pass


def default_submitted_messages_path(registry_path: Path | None = None) -> Path:
    configured = os.environ.get("MUXDECK_SUBMITTED_MESSAGES_FILE")
    return Path(configured).expanduser() if configured else (
        registry_path or default_session_registry_path()
    ).with_name("submitted-messages.sqlite3")


def default_native_history_paths() -> dict[str, Path]:
    return {
        "codex": Path(os.environ.get(
            "MUXDECK_CODEX_HISTORY_FILE",
            str(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "history.jsonl"),
        )).expanduser(),
        "claude": Path(os.environ.get(
            "MUXDECK_CLAUDE_HISTORY_FILE",
            str(Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "history.jsonl"),
        )).expanduser(),
    }


def _references(references: Iterable[Mapping[str, Any]]) -> set[tuple[str, str]]:
    return {
        (str(reference["agentType"]), str(reference["agentSessionId"]).lower())
        for reference in references
        if reference.get("agentType") in SUPPORTED_AGENTS
        and isinstance(reference.get("agentSessionId"), str)
        and UUID_PATTERN.fullmatch(reference["agentSessionId"])
    }


def _claude_text(record: dict[str, Any], cache: Path) -> tuple[str, bool]:
    text = record["display"]
    pasted = record.get("pastedContents")
    pasted = pasted if isinstance(pasted, dict) else {}
    complete = True

    def expand(match: re.Match[str]) -> str:
        nonlocal complete
        item = pasted.get(match[1])
        if isinstance(item, dict) and item.get("type") == "text":
            if isinstance(item.get("content"), str):
                return item["content"]
            digest = item.get("contentHash")
            if isinstance(digest, str) and CONTENT_HASH.fullmatch(digest):
                path = cache / f"{digest}.txt"
                try:
                    if not path.is_symlink() and path.stat().st_size <= MAX_NATIVE_RECORD_BYTES:
                        return path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    pass
        complete = False
        return match[0]

    text = PASTED_TEXT.sub(expand, text)
    # The archive preserves message text, not image bytes or other attachments.
    if re.search(r"\[Image #\d+\]", text):
        complete = False
    return text, complete


class SubmittedMessageStore:
    """Copy native *submitted input* for recorded conversation IDs.

    No terminal keystrokes, drafts, assistant output, or unrelated conversations
    are collected. Re-reading a changed input history also handles native file
    rotation and conversations first discovered after their prompts were sent.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        history_paths: Mapping[str, Path] | None = None,
    ) -> None:
        self.path = path or default_submitted_messages_path()
        self._paths = dict(history_paths if history_paths is not None else default_native_history_paths())
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        self._signatures: dict[str, tuple[Any, ...]] = {}
        self._source_status: dict[str, str] = {}
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self._connection = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            version = self._connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise sqlite3.DatabaseError("unsupported submitted message schema")
            with self._connection:
                self._connection.execute("""
                    CREATE TABLE IF NOT EXISTS submitted_messages (
                        id INTEGER PRIMARY KEY,
                        agent_type TEXT NOT NULL,
                        agent_session_id TEXT NOT NULL,
                        source_key TEXT NOT NULL,
                        submitted_at INTEGER NOT NULL,
                        text TEXT NOT NULL,
                        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
                        UNIQUE(agent_type, agent_session_id, source_key)
                    )
                """)
                self._connection.execute("""
                    CREATE INDEX IF NOT EXISTS submitted_messages_conversation
                    ON submitted_messages(agent_type, agent_session_id, submitted_at DESC, id DESC)
                """)
                self._connection.execute("PRAGMA user_version = 1")
            os.chmod(self.path, 0o600)
        except (OSError, sqlite3.Error):
            self.close()
            LOGGER.error("Submitted-message archive is unavailable; terminal input is unaffected")

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise SubmittedMessageStoreUnavailable("submitted-message archive is unavailable")
        return self._connection

    def sync(self, references: Iterable[Mapping[str, Any]]) -> None:
        known = _references(references)
        with self._lock:
            connection = self._require_connection()
            try:
                for agent in SUPPORTED_AGENTS:
                    ids = frozenset(identifier for kind, identifier in known if kind == agent)
                    if ids:
                        self._sync_source(connection, agent, ids)
            except sqlite3.Error as error:
                raise SubmittedMessageStoreUnavailable("unable to save submitted messages") from error

    def _sync_source(self, connection: sqlite3.Connection, agent: str, ids: frozenset[str]) -> None:
        path = self._paths.get(agent)
        if path is None:
            self._source_status[agent] = "missing"
            return
        try:
            info = path.stat()
            cache = path.parent / "paste-cache"
            try:
                cache_version = cache.stat().st_mtime_ns if agent == "claude" else 0
            except OSError:
                cache_version = 0
            signature = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, cache_version, ids)
            if self._signatures.get(agent) == signature:
                return
            occurrences: Counter[str] = Counter()
            partial = False
            with path.open("rb") as source, connection:
                # Stop at the size observed above, even if a writer is active.
                remaining = info.st_size
                while remaining > 0:
                    line = source.readline(min(MAX_NATIVE_RECORD_BYTES + 1, remaining))
                    remaining -= len(line)
                    if not line:
                        break
                    if len(line) > MAX_NATIVE_RECORD_BYTES:
                        partial = True
                        while line and not line.endswith(b"\n") and remaining > 0:
                            line = source.readline(min(MAX_NATIVE_RECORD_BYTES, remaining))
                            remaining -= len(line)
                        continue
                    if not line.endswith(b"\n"):
                        # An in-progress JSONL append is retried on the next scan.
                        break
                    try:
                        record = json.loads(line)
                    except (ValueError, UnicodeError, RecursionError):
                        partial = True
                        continue
                    if not isinstance(record, dict):
                        continue
                    identifier = record.get("session_id" if agent == "codex" else "sessionId")
                    if not isinstance(identifier, str) or identifier.lower() not in ids:
                        continue
                    text = record.get("text" if agent == "codex" else "display")
                    timestamp = record.get("ts" if agent == "codex" else "timestamp")
                    if (
                        not isinstance(text, str) or not text.strip()
                        or isinstance(timestamp, bool) or not isinstance(timestamp, (int, float))
                        or not 0 <= timestamp <= MAX_TIMESTAMP or not math.isfinite(timestamp)
                    ):
                        partial = True
                        continue
                    submitted_at = int(timestamp * (1000 if agent == "codex" else 1))
                    if submitted_at > MAX_TIMESTAMP:
                        partial = True
                        continue
                    digest = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
                    occurrences[digest] += 1
                    # Retain intentional identical repeats, including within one
                    # second in Codex, without duplicating them on rescans.
                    source_key = f"{digest}:{occurrences[digest]}"
                    text, complete = _claude_text(record, cache) if agent == "claude" else (text, True)
                    try:
                        if len(text.encode("utf-8")) > MAX_NATIVE_RECORD_BYTES:
                            partial = True
                            continue
                    except UnicodeError:
                        partial = True
                        continue
                    connection.execute("""
                        INSERT INTO submitted_messages (
                            agent_type, agent_session_id, source_key, submitted_at, text, complete
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(agent_type, agent_session_id, source_key) DO UPDATE SET
                            text = excluded.text, complete = excluded.complete
                        WHERE submitted_messages.complete = 0 AND excluded.complete = 1
                    """, (agent, identifier.lower(), source_key, submitted_at, text, int(complete)))
            self._source_status[agent] = "partial" if partial else "available"
            self._signatures[agent] = signature
        except FileNotFoundError:
            self._source_status[agent] = "missing"
            self._signatures.pop(agent, None)
        except OSError:
            self._source_status[agent] = "unreadable"
            self._signatures.pop(agent, None)

    def list_messages(
        self,
        references: Iterable[Mapping[str, Any]],
        *,
        before: str | None = None,
        query: str = "",
        limit: int = 50,
    ) -> dict[str, Any]:
        if not 1 <= limit <= 200:
            raise ValueError("limit must be between 1 and 200")
        if len(query) > 256:
            raise ValueError("search cannot exceed 256 characters")
        cursor = None
        if before is not None:
            if not re.fullmatch(r"\d{1,15}:\d{1,19}", before):
                raise ValueError("invalid submitted-message cursor")
            cursor = tuple(int(part) for part in before.split(":"))
            if cursor[0] > MAX_TIMESTAMP or cursor[1] > 9_223_372_036_854_775_807:
                raise ValueError("invalid submitted-message cursor")
        known = sorted(_references(references))
        with self._lock:
            connection = self._require_connection()
            try:
                clauses = ["(" + " OR ".join("(agent_type = ? AND agent_session_id = ?)" for _ in known) + ")"]
                params: list[Any] = [value for pair in known for value in pair]
                if cursor is not None:
                    clauses.append("(submitted_at, id) < (?, ?)")
                    params.extend(cursor)
                if query:
                    clauses.append("instr(lower(text), lower(?)) > 0")
                    params.append(query)
                rows = connection.execute(
                    "SELECT * FROM submitted_messages WHERE " + " AND ".join(clauses)
                    + " ORDER BY submitted_at DESC, id DESC LIMIT ?",
                    [*params, limit + 1],
                ).fetchall() if known else []
            except sqlite3.Error as error:
                raise SubmittedMessageStoreUnavailable("unable to read submitted messages") from error
            messages = [{
                "id": str(row["id"]), "agentType": row["agent_type"],
                "agentSessionId": row["agent_session_id"], "submittedAt": row["submitted_at"],
                "text": row["text"], "complete": bool(row["complete"]),
            } for row in rows[:limit]]
            return {
                "messages": messages,
                "nextCursor": f"{rows[limit - 1]['submitted_at']}:{rows[limit - 1]['id']}" if len(rows) > limit else None,
                "sources": [{
                    "agentType": agent, "status": self._source_status.get(agent, "missing"),
                } for agent in sorted({agent for agent, _ in known})],
            }
