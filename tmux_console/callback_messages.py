from __future__ import annotations

import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .messages import validate_session_name
from .tmux import validate_tmux_pane_id, validate_tmux_session_id

MAX_CALLBACK_MESSAGE_LENGTH = 16_384
MAX_PENDING_CALLBACK_MESSAGES = 256
CALLBACK_MESSAGES_UNAVAILABLE_MESSAGE = "callback message storage is unavailable"
_FIELDS = (
    "message",
    "sessionName",
    "agentType",
    "cwd",
    "requestId",
    "tmuxSessionId",
    "tmuxPaneId",
    "host",
)


class CallbackMessageStoreUnavailable(OSError):
    pass


class CallbackMessageConflict(ValueError):
    pass


class CallbackMessageNotFound(KeyError):
    pass


def default_callback_messages_path(workspace_path: Path | None = None) -> Path:
    configured = os.environ.get("MUXDECK_CALLBACKS_FILE")
    if configured:
        return Path(configured).expanduser()
    if workspace_path is not None:
        return workspace_path.parent / "callbacks.sqlite3"
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "callbacks.sqlite3"


def _text(value: object, field: str, maximum: int, *, multiline: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value.strip():
        raise ValueError(f"{field} cannot be blank")
    if len(value) > maximum:
        raise ValueError(f"{field} must be {maximum} characters or fewer")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must contain valid Unicode") from error
    allowed_controls = "\r\n\t" if multiline else ""
    if any((ord(c) < 32 or ord(c) == 127) and c not in allowed_controls for c in value):
        raise ValueError(f"{field} cannot contain control characters")
    return value


def validate_callback_message(payload: object) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise TypeError("request body must be an object")
    required = {"message", "sessionName", "agentType", "cwd"}
    missing = sorted(required - payload.keys())
    if missing:
        raise ValueError(f"{missing[0]} is required")
    unknown = sorted(str(field) for field in payload.keys() - set(_FIELDS))
    if unknown:
        raise ValueError(f"unknown field: {unknown[0]}")
    result: dict[str, Any] = {
        "message": _text(
            payload["message"], "message", MAX_CALLBACK_MESSAGE_LENGTH, multiline=True
        ),
        "sessionName": validate_session_name(
            _text(payload["sessionName"], "sessionName", 256)
        ),
        "agentType": _text(payload["agentType"], "agentType", 64),
        "cwd": _text(payload["cwd"], "cwd", 4096),
    }
    if not Path(result["cwd"]).is_absolute():
        raise ValueError("cwd must be an absolute path")
    for field, maximum in (
        ("requestId", 128),
        ("tmuxSessionId", 64),
        ("tmuxPaneId", 64),
        ("host", 255),
    ):
        value = payload.get(field)
        result[field] = None if value is None else _text(value, field, maximum)
    if result["tmuxSessionId"] is not None:
        validate_tmux_session_id(result["tmuxSessionId"])
    if result["tmuxPaneId"] is not None:
        validate_tmux_pane_id(result["tmuxPaneId"])
    return result


class CallbackMessageStore:
    """Durable, append-only completion reports with an explicit review state."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path or default_callback_messages_path()
        self._clock = clock
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self._connection = sqlite3.connect(
                self.path, timeout=5.0, check_same_thread=False
            )
            self._connection.row_factory = sqlite3.Row
            with self._transaction(write=True) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise sqlite3.DatabaseError("unsupported callback message schema")
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS callback_messages (
                        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                        id TEXT NOT NULL UNIQUE,
                        message TEXT NOT NULL,
                        sessionName TEXT NOT NULL,
                        agentType TEXT NOT NULL,
                        cwd TEXT NOT NULL,
                        requestId TEXT UNIQUE,
                        tmuxSessionId TEXT,
                        tmuxPaneId TEXT,
                        host TEXT,
                        createdAt INTEGER NOT NULL,
                        reviewedAt INTEGER
                    )
                """)
                connection.execute("""
                    CREATE INDEX IF NOT EXISTS callback_messages_pending_idx
                    ON callback_messages (sequence) WHERE reviewedAt IS NULL
                """)
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS callback_message_metadata (
                        id INTEGER PRIMARY KEY CHECK(id = 1),
                        revision INTEGER NOT NULL
                    )
                """)
                connection.execute(
                    "INSERT OR IGNORE INTO callback_message_metadata VALUES (1, 0)"
                )
                connection.execute("PRAGMA user_version = 1")
            os.chmod(self.path, 0o600)
        except (OSError, sqlite3.Error) as error:
            self.close()
            raise CallbackMessageStoreUnavailable(
                CALLBACK_MESSAGES_UNAVAILABLE_MESSAGE
            ) from error

    @contextmanager
    def _transaction(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = self._connection
            if connection is None:
                raise CallbackMessageStoreUnavailable(
                    CALLBACK_MESSAGES_UNAVAILABLE_MESSAGE
                )
            try:
                connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                with connection:
                    yield connection
            except sqlite3.Error as error:
                raise CallbackMessageStoreUnavailable(
                    CALLBACK_MESSAGES_UNAVAILABLE_MESSAGE
                ) from error

    @staticmethod
    def _revision(connection: sqlite3.Connection) -> int:
        return int(
            connection.execute(
                "SELECT revision FROM callback_message_metadata WHERE id = 1"
            ).fetchone()[0]
        )

    @staticmethod
    def _changed(connection: sqlite3.Connection) -> None:
        connection.execute(
            "UPDATE callback_message_metadata SET revision = revision + 1 WHERE id = 1"
        )

    def add(self, payload: object) -> tuple[dict[str, Any], bool]:
        data = validate_callback_message(payload)
        with self._transaction(write=True) as connection:
            if data["requestId"] is not None:
                existing = connection.execute(
                    "SELECT * FROM callback_messages WHERE requestId = ?",
                    (data["requestId"],),
                ).fetchone()
                if existing is not None:
                    record = dict(existing)
                    if any(record[field] != data[field] for field in _FIELDS):
                        raise CallbackMessageConflict(
                            "requestId was already used for different callback content"
                        )
                    return record, True
            count = connection.execute(
                "SELECT COUNT(*) FROM callback_messages WHERE reviewedAt IS NULL"
            ).fetchone()[0]
            if count >= MAX_PENDING_CALLBACK_MESSAGES:
                raise CallbackMessageConflict(
                    f"pending callback messages are full ({MAX_PENDING_CALLBACK_MESSAGES}); review messages before posting more"
                )
            message_id = uuid.uuid4().hex
            connection.execute(
                "INSERT INTO callback_messages "
                "(id, message, sessionName, agentType, cwd, requestId, tmuxSessionId, tmuxPaneId, host, createdAt) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (message_id, *(data[field] for field in _FIELDS), int(self._clock())),
            )
            self._changed(connection)
            return dict(
                connection.execute(
                    "SELECT * FROM callback_messages WHERE id = ?", (message_id,)
                ).fetchone()
            ), False

    def list_messages(
        self, *, status: str = "pending", after: int = 0, limit: int = 100
    ) -> dict[str, Any]:
        if status not in {"pending", "reviewed", "all"}:
            raise ValueError("status must be pending, reviewed, or all")
        if (
            isinstance(after, bool)
            or not isinstance(after, int)
            or not 0 <= after <= 2**63 - 1
        ):
            raise ValueError("after must be a non-negative 64-bit integer")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 200
        ):
            raise ValueError("limit must be between 1 and 200")
        predicate = {
            "pending": " AND reviewedAt IS NULL",
            "reviewed": " AND reviewedAt IS NOT NULL",
            "all": "",
        }[status]
        with self._transaction() as connection:
            records = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM callback_messages WHERE sequence > ?"
                    + predicate
                    + " ORDER BY sequence LIMIT ?",
                    (after, limit + 1),
                )
            ]
            more = len(records) > limit
            records = records[:limit]
            return {
                "messages": records,
                "nextAfter": records[-1]["sequence"] if more else None,
                "revision": self._revision(connection),
            }

    def pending_snapshot(
        self, watched_sessions: Sequence[str] = ()
    ) -> dict[str, Any]:
        with self._transaction() as connection:
            messages = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM callback_messages WHERE reviewedAt IS NULL ORDER BY sequence"
                )
            ]
            session_names = list(dict.fromkeys([
                *watched_sessions, *(message["sessionName"] for message in messages),
            ]))
            latest: dict[str, int] = {}
            # Include reviewed reports without sending unrelated session history.
            # Batches stay within SQLite's variable limit for large global queues.
            for offset in range(0, len(session_names), 500):
                batch = session_names[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                latest.update(
                    (row["sessionName"], row["latestCallbackAt"])
                    for row in connection.execute(
                        "SELECT sessionName, MAX(createdAt) AS latestCallbackAt "
                        "FROM callback_messages "
                        f"WHERE sessionName IN ({placeholders}) GROUP BY sessionName",
                        batch,
                    )
                )
            return {
                "callbackMessages": messages,
                "latestCallbackAtBySession": latest,
                "callbackMessageRevision": self._revision(connection),
            }

    def review(self, message_id: str) -> dict[str, Any]:
        with self._transaction(write=True) as connection:
            record = connection.execute(
                "SELECT * FROM callback_messages WHERE id = ?", (message_id,)
            ).fetchone()
            if record is None:
                raise CallbackMessageNotFound("callback message was not found")
            if record["reviewedAt"] is None:
                connection.execute(
                    "UPDATE callback_messages SET reviewedAt = ? WHERE id = ?",
                    (int(self._clock()), message_id),
                )
                self._changed(connection)
            return dict(
                connection.execute(
                    "SELECT * FROM callback_messages WHERE id = ?", (message_id,)
                ).fetchone()
            )

    def review_sessions(self, sessions: Sequence[str]) -> list[str]:
        if not sessions:
            return []
        with self._transaction(write=True) as connection:
            removed = []
            for session in dict.fromkeys(sessions):
                result = connection.execute(
                    "UPDATE callback_messages SET reviewedAt = ? WHERE sessionName = ? AND reviewedAt IS NULL",
                    (int(self._clock()), session),
                )
                if result.rowcount:
                    removed.append(session)
            if removed:
                self._changed(connection)
            return removed

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
