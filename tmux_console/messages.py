from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger("muxdeck.messages")
MAX_SESSION_NAME_LENGTH = 256
MAX_MESSAGE_LENGTH = 65_536


def default_messages_path() -> Path:
    configured = os.environ.get("MUXDECK_MESSAGES_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "session-messages.json"


def validate_session_name(value: str) -> str:
    if not value.strip():
        raise ValueError("session name is required")
    if len(value) > MAX_SESSION_NAME_LENGTH:
        raise ValueError(
            f"session name must be {MAX_SESSION_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("session name cannot contain control characters")
    return value


def validate_message_text(value: str) -> str:
    if not value.strip():
        raise ValueError("message text cannot be blank")
    if len(value) > MAX_MESSAGE_LENGTH:
        raise ValueError(
            f"message text must be {MAX_MESSAGE_LENGTH} characters or fewer"
        )
    return value


@dataclass(frozen=True)
class QueuedMessage:
    id: str
    text: str
    created_at: int
    updated_at: int

    def to_dict(self, position: int) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "position": position,
        }


class MessageNotFoundError(LookupError):
    pass


class SessionMessageStore:
    def __init__(
        self,
        path: Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.path = path or default_messages_path()
        self._clock = clock
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._lock = threading.RLock()
        self._queues = self._load()

    def list_messages(self, session_name: str) -> list[dict[str, Any]]:
        session_name = validate_session_name(session_name)
        with self._lock:
            return self._serialize(self._queues.get(session_name, ()))

    def count_messages(self, session_name: str) -> int:
        session_name = validate_session_name(session_name)
        with self._lock:
            return len(self._queues.get(session_name, ()))

    def add_message(self, session_name: str, text: str) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        text = validate_message_text(text)
        with self._lock:
            queue = list(self._queues.get(session_name, ()))
            existing_ids = {message.id for message in queue}
            message_id = self._id_factory()
            while message_id in existing_ids:
                message_id = self._id_factory()
            timestamp = self._timestamp()
            message = QueuedMessage(
                id=message_id,
                text=text,
                created_at=timestamp,
                updated_at=timestamp,
            )
            queue.append(message)
            self._replace_queue(session_name, queue)
            return message.to_dict(len(queue) - 1)

    def update_message(
        self,
        session_name: str,
        message_id: str,
        *,
        text: str | None = None,
        position: int | None = None,
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        if text is not None:
            text = validate_message_text(text)

        with self._lock:
            queue = list(self._queues.get(session_name, ()))
            current_position = self._find_position(queue, message_id)
            if position is not None and not 0 <= position < len(queue):
                raise ValueError(f"position must be between 0 and {len(queue) - 1}")

            current = queue.pop(current_position)
            destination = current_position if position is None else position
            updated = QueuedMessage(
                id=current.id,
                text=current.text if text is None else text,
                created_at=current.created_at,
                updated_at=max(self._timestamp(), current.updated_at + 1),
            )
            queue.insert(destination, updated)
            self._replace_queue(session_name, queue)
            return updated.to_dict(destination)

    def delete_message(self, session_name: str, message_id: str) -> None:
        session_name = validate_session_name(session_name)
        with self._lock:
            queue = list(self._queues.get(session_name, ()))
            position = self._find_position(queue, message_id)
            queue.pop(position)
            self._replace_queue(session_name, queue)

    def rename_session(self, current_name: str, new_name: str) -> None:
        current_name = validate_session_name(current_name)
        new_name = validate_session_name(new_name)
        if current_name == new_name:
            raise ValueError("new session name must differ from current session name")

        with self._lock:
            queues = self._queues.copy()
            queue = queues.pop(current_name, None)
            queues.pop(new_name, None)
            if queue:
                queues[new_name] = queue
            self._persist(queues)
            self._queues = queues

    def _replace_queue(
        self, session_name: str, queue: list[QueuedMessage]
    ) -> None:
        queues = self._queues.copy()
        if queue:
            queues[session_name] = tuple(queue)
        else:
            queues.pop(session_name, None)
        self._persist(queues)
        self._queues = queues

    @staticmethod
    def _find_position(queue: list[QueuedMessage], message_id: str) -> int:
        for position, message in enumerate(queue):
            if message.id == message_id:
                return position
        raise MessageNotFoundError(f"queued message not found: {message_id}")

    def _timestamp(self) -> int:
        return int(self._clock() * 1000)

    def _load(self) -> dict[str, tuple[QueuedMessage, ...]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as error:
            LOGGER.warning("Unable to read queued messages from %s: %s", self.path, error)
            return {}

        sessions = payload.get("sessions", {}) if isinstance(payload, dict) else {}
        if not isinstance(sessions, dict):
            return {}

        queues: dict[str, tuple[QueuedMessage, ...]] = {}
        for session_name, records in sessions.items():
            if not isinstance(session_name, str) or not isinstance(records, list):
                continue
            try:
                validate_session_name(session_name)
            except ValueError:
                continue

            loaded: list[tuple[int, int, QueuedMessage]] = []
            seen_ids: set[str] = set()
            for fallback_position, record in enumerate(records):
                message = self._load_message(record)
                if message is None or message.id in seen_ids:
                    continue
                seen_ids.add(message.id)
                position = record.get("position", fallback_position)
                if isinstance(position, bool) or not isinstance(position, int):
                    position = fallback_position
                loaded.append((max(0, position), fallback_position, message))

            if loaded:
                loaded.sort(key=lambda item: (item[0], item[1]))
                queues[session_name] = tuple(item[2] for item in loaded)
        return queues

    @staticmethod
    def _load_message(record: object) -> QueuedMessage | None:
        if not isinstance(record, dict):
            return None
        message_id = record.get("id")
        text = record.get("text")
        created_at = record.get("createdAt")
        updated_at = record.get("updatedAt")
        if not isinstance(message_id, str) or not message_id:
            return None
        if not isinstance(text, str):
            return None
        if (
            isinstance(created_at, bool)
            or not isinstance(created_at, int)
            or created_at < 0
            or isinstance(updated_at, bool)
            or not isinstance(updated_at, int)
            or updated_at < created_at
        ):
            return None
        try:
            validate_message_text(text)
        except ValueError:
            return None
        return QueuedMessage(
            id=message_id,
            text=text,
            created_at=created_at,
            updated_at=updated_at,
        )

    @staticmethod
    def _serialize(messages: tuple[QueuedMessage, ...]) -> list[dict[str, Any]]:
        return [message.to_dict(position) for position, message in enumerate(messages)]

    def _persist(self, queues: dict[str, tuple[QueuedMessage, ...]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(
                    {
                        "version": 1,
                        "sessions": {
                            session_name: self._serialize(messages)
                            for session_name, messages in sorted(queues.items())
                        },
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
