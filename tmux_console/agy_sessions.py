"""Read visible Antigravity CLI steps from the conversation database."""
from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

from .transcript_formats import _entry, _tool

_USER_INPUT = 14
_PLANNER_RESPONSE = 15
_ERROR_MESSAGE = 17
_GENERIC_TOOL = 132

WireValue = int | bytes


def locate_agy_db(root: Path, identifier: str) -> Path | None:
    try:
        normalized = str(UUID(identifier))
        if normalized != identifier.lower():
            return None
        directory = root.resolve(strict=True) / "conversations"
    except (ValueError, FileNotFoundError):
        return None

    path = directory / f"{normalized}.db"
    if directory.is_symlink() or path.is_symlink() or any(
        path.with_name(path.name + suffix).is_symlink()
        for suffix in ("-wal", "-shm", "-journal")
    ):
        raise OSError("linked Antigravity transcript is unavailable")
    return path if path.is_file() else None


def agy_has_session(connection: sqlite3.Connection, identifier: str) -> bool:
    rows = connection.execute("SELECT cascade_id FROM trajectory_meta LIMIT 2").fetchall()
    return len(rows) == 1 and rows[0][0] == identifier.lower()


def agy_revision(connection: sqlite3.Connection, identifier: str) -> str | None:
    if not agy_has_session(connection, identifier):
        return None
    summary = connection.execute("""
        SELECT count(*), max(idx), sum(status),
               sum(length(metadata)), sum(length(step_payload))
        FROM steps
    """).fetchone()
    latest = connection.execute("""
        SELECT step_type, status, step_format,
               substr(metadata, 1, 4096), substr(step_payload, 1, 4096),
               substr(step_payload, -4096)
        FROM steps ORDER BY idx DESC LIMIT 1
    """).fetchone()
    return hashlib.sha256(repr((tuple(summary), tuple(latest) if latest else None)).encode()).hexdigest()


def _varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 64, 7):
        if offset == len(data):
            break
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128 and value < 1 << 64:
            return value, offset
    raise ValueError("invalid Antigravity protobuf varint")


def _fields(data: bytes) -> Iterator[tuple[int, WireValue]]:
    offset = 0
    while offset < len(data):
        tag, offset = _varint(data, offset)
        number, wire_type = tag >> 3, tag & 7
        if not 0 < number < 1 << 29:
            raise ValueError("invalid Antigravity protobuf field")
        if wire_type == 0:
            value, offset = _varint(data, offset)
            yield number, value
            continue
        if wire_type == 2:
            length, offset = _varint(data, offset)
        elif wire_type in {1, 5}:
            length = 8 if wire_type == 1 else 4
        else:
            raise ValueError("unsupported Antigravity protobuf wire type")
        end = offset + length
        if end > len(data):
            raise ValueError("truncated Antigravity protobuf field")
        if wire_type == 2:
            yield number, data[offset:end]
        offset = end


def _select(data: bytes, *numbers: int) -> dict[int, WireValue]:
    return {number: value for number, value in _fields(data) if number in numbers}


def _blob(value: WireValue | None) -> bytes:
    if value is None:
        return b""
    if not isinstance(value, bytes):
        raise TypeError("invalid Antigravity protobuf byte field")
    return value


def _text(value: WireValue | None) -> str:
    return _blob(value).decode("utf-8")


def _timestamp(value: WireValue | None) -> int | None:
    if value is None:
        return None
    fields = _select(_blob(value), 1, 2)
    seconds, nanos = fields.get(1, 0), fields.get(2, 0)
    if isinstance(seconds, int) and isinstance(nanos, int) and 0 <= nanos < 10**9:
        millis = seconds * 1000 + nanos // 10**6
        if 0 <= millis <= 8_640_000_000_000_000:
            return millis
    return None


def _user_text(data: bytes) -> tuple[str, bool]:
    # CortexStepUserInput stores the submitted text as user_response. Older
    # steps can represent it as query or a list of text and scope items.
    fields = _select(data, 1, 2, 5, 9)
    text = _text(fields.get(2)) or _text(fields.get(1))
    if not text:
        text = "".join(
            _text(_select(_blob(value), 1).get(1))
            for number, value in _fields(data)
            if number == 3
        )
    attachments = bool(fields.get(5) or fields.get(9))
    if attachments:
        text = f"{text}\n\n[Attachments]" if text else "[Attachments]"
    return text, attachments


def _entries(index: int, step_type: int, payload: bytes, metadata: bytes) -> list[dict[str, Any]]:
    # These are the persisted fields of CortexStep and CortexStepMetadata.
    fields = _select(payload, 5, 19, 20, 24, 140)
    meta = _select(metadata or _blob(fields.get(5)), 1, 3, 4)
    timestamp = _timestamp(meta.get(1))
    if step_type == _USER_INPUT:
        # Source 4 is explicit user input. An omitted source is valid in
        # older records with a CortexStepUserInput.
        if meta.get(3, 0) not in {0, 4}:
            return []
        text, attachments = _user_text(_blob(fields.get(19)))
        if not text.strip():
            return []
        prompt = _entry("user", "prompt", text, timestamp)
        prompt.update(sourceId=index, sourceText=text, complete=not attachments)
        return [prompt]
    if step_type == _PLANNER_RESPONSE:
        reply = _select(_blob(fields.get(20)), 1, 7, 8, 12)
        text = _text(reply.get(8)) or _text(reply.get(1))
        kind = "progress" if reply.get(7) or reply.get(12) == 10 else "response"
        return [_entry("assistant", kind, text, timestamp)] if text.strip() else []
    if step_type == _ERROR_MESSAGE:
        error = _select(_blob(fields.get(24)), 3, 5)
        if error.get(5) != 1:
            return []
        text = _text(_select(_blob(error.get(3)), 1).get(1))
        return [_entry("assistant", "context", text, timestamp)] if text.strip() else []

    # Generic tools store their call in the common metadata and their
    # displayed result in GenericStepResult.result.
    call = _select(_blob(meta.get(4)), 2, 3)
    name = _text(call.get(2))
    generic = _select(_blob(fields.get(140)), 2)
    result = _text(_select(_blob(generic.get(2)), 1).get(1))
    text = "\n\n".join(part for part in (_tool(name, _text(call.get(3))) if name else "", result) if part)
    return [_entry("tool", "tool", text, timestamp)] if text.strip() else []


def read_agy_records(
    connection: sqlite3.Connection,
    identifier: str,
    *,
    offset: int,
    limit: int,
    max_record_bytes: int,
) -> Iterator[tuple[list[dict[str, Any]], int, bool]]:
    """Yield visible entries, bytes read and a partial flag per ordered step."""
    if not agy_has_session(connection, identifier):
        return
    rows = connection.execute("""
        SELECT idx, step_type, step_format, size,
               CASE WHEN size <= ? THEN metadata END,
               CASE WHEN size <= ? THEN step_payload END
        FROM (
            SELECT idx, step_type, step_format, metadata, step_payload,
                   coalesce(length(metadata), 0) + coalesce(length(step_payload), 0) AS size
            FROM steps ORDER BY idx LIMIT ? OFFSET ?
        )
    """, (max_record_bytes, max_record_bytes, limit, offset))
    for index, step_type, step_format, size, metadata, payload in rows:
        if size > max_record_bytes:
            yield [], 0, True
            continue
        if step_format != 0:
            yield [], size, True
            continue
        if step_type not in {_USER_INPUT, _PLANNER_RESPONSE, _ERROR_MESSAGE, _GENERIC_TOOL}:
            yield [], size, False
            continue
        if not isinstance(payload, bytes) or (metadata is not None and not isinstance(metadata, bytes)):
            yield [], size, True
            continue
        try:
            entries = _entries(index, step_type, payload, metadata or b"")
        except (TypeError, ValueError):
            yield [], size, True
        else:
            yield entries, size, False
