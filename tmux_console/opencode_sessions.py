"""Read OpenCode's v1 and v2 native SQLite conversation stores."""

from __future__ import annotations

import json
import re
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any

from .transcript_formats import _argument, _entry, _tool

_SESSION_ID = re.compile(r"ses_[A-Za-z0-9]{26}")
_TITLE_PREFIX = "OC | "
_TITLE_CANDIDATE_LIMIT = 32
_MAX_PARTS_PER_RECORD = 4096
_V2 = ("session_v2", "session_message", "session_part")
_V1 = ("session", "message", "part")


def valid_opencode_session_id(identifier: str) -> bool:
    return _SESSION_ID.fullmatch(identifier) is not None


def locate_opencode_db(root: Path) -> Path | None:
    try:
        path = root.resolve(strict=True) / "opencode.db"
        if not stat.S_ISREG(path.lstat().st_mode):
            raise OSError("OpenCode's native database is not a regular file")
    except FileNotFoundError:
        return None
    for suffix in ("-wal", "-shm"):
        companion = path.with_name(path.name + suffix)
        try:
            if not stat.S_ISREG(companion.lstat().st_mode):
                raise OSError("OpenCode's database companion is not a regular file")
        except FileNotFoundError:
            pass
    return path


def _layouts(connection: sqlite3.Connection) -> list[tuple[str, str, str]]:
    tables = {name for (name,) in connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name IN ('session_v2', 'session_message', 'session_part', 'session', 'message', 'part')"
    )}
    layouts = []
    for layout in (_V2, _V1):
        if not tables.issuperset(layout):
            continue
        required_columns = (
            {"id", "directory", "title", "time_created", "time_updated"},
            {"id", "session_id", "data", "time_created", "time_updated"},
            {"message_id", "session_id", "data", "time_updated"},
        )
        if layout == _V2:
            required_columns[1].update(("seq", "type"))
            required_columns[2].add("ordinal")
        else:
            required_columns[2].update(("id", "time_created"))
        if all(required.issubset({row[1] for row in connection.execute(f"PRAGMA table_info({table})")})
               for table, required in zip(layout, required_columns, strict=True)):
            layouts.append(layout)
    if not layouts:
        raise ValueError("This OpenCode database format is not supported.")
    return layouts


def _layout_for(connection: sqlite3.Connection, identifier: str) -> tuple[str, str, str] | None:
    for layout in _layouts(connection):
        if connection.execute(f"SELECT 1 FROM {layout[0]} WHERE id = ?", (identifier,)).fetchone():
            return layout
    return None


def opencode_has_session(connection: sqlite3.Connection, identifier: str) -> bool:
    return _layout_for(connection, identifier) is not None


def _terminal_title(title: str, suffix: str) -> str:
    # OpenCode uses JavaScript string length and slices at a UTF-16 boundary.
    encoded = title.encode("utf-16-le")
    return title if len(encoded) <= 80 else encoded[:74].decode("utf-16-le", errors="replace") + suffix


def opencode_session_for_pane(root: Path, cwd: str, title: str) -> str | None:
    if not cwd or not title.startswith(_TITLE_PREFIX):
        return None
    title = title.removeprefix(_TITLE_PREFIX)
    if not title:
        return None
    try:
        path = locate_opencode_db(root)
        if path is None:
            return None
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.1)) as connection:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("BEGIN")
            candidates: set[str] = set()
            for layout in _layouts(connection):
                suffix = "…" if layout == _V2 else "..."
                prefix = title.removesuffix(suffix).removesuffix("\ufffd")
                rows = connection.execute(
                    f"SELECT id, title FROM {layout[0]} "
                    "WHERE directory IN (?, ?) AND (title = ? OR substr(title, 1, length(?)) = ?) "
                    "LIMIT ?",
                    (cwd, str(Path(cwd).resolve()), title, prefix, prefix, _TITLE_CANDIDATE_LIMIT),
                ).fetchall()
                if len(rows) == _TITLE_CANDIDATE_LIMIT:
                    return None
                for identifier, stored_title in rows:
                    if (isinstance(identifier, str) and valid_opencode_session_id(identifier)
                            and isinstance(stored_title, str) and _terminal_title(stored_title, suffix) == title):
                        candidates.add(identifier)
            return next(iter(candidates)) if len(candidates) == 1 else None
    except (OSError, sqlite3.Error, ValueError, RuntimeError):
        return None


def opencode_revision(connection: sqlite3.Connection, identifier: str) -> str | None:
    """Track changes to one conversation, including in-place streaming updates."""
    layout = _layout_for(connection, identifier)
    if layout is None:
        return None
    session, message, part = layout
    revision = [session, *connection.execute(
        f"SELECT time_created, time_updated FROM {session} WHERE id = ?", (identifier,),
    ).fetchone()]
    for table in (message, part):
        revision.extend(connection.execute(
            f"SELECT count(*), max(time_updated), sum(time_updated % 1000000007) "
            f"FROM {table} WHERE session_id = ?",
            (identifier,),
        ).fetchone())
    return json.dumps(revision, separators=(",", ":"))


def _object(raw: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def _part_records(
    connection: sqlite3.Connection, layout: tuple[str, str, str], identifier: str,
    message_id: str, byte_limit: int,
) -> tuple[list[dict[str, Any]], int, bool]:
    # Apply byte and row limits before decoding. A tool output that exceeds the
    # record limit can be skipped while smaller parts from the same message fit.
    order = "ordinal" if layout == _V2 else "time_created, id"
    rows = connection.execute(
        f"SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN CAST(data AS BLOB) END "
        f"FROM {layout[2]} WHERE session_id = ? AND message_id = ? "
        f"ORDER BY {order} LIMIT ?",
        (byte_limit, identifier, message_id, _MAX_PARTS_PER_RECORD + 1),
    )
    parts: list[dict[str, Any]] = []
    total = 0
    partial = False
    for index, (raw,) in enumerate(rows):
        if index == _MAX_PARTS_PER_RECORD:
            partial = True
            break
        if raw is None or total + len(raw) > byte_limit:
            partial = True
            continue
        total += len(raw)
        part = _object(raw)
        if part is None:
            partial = True
        else:
            parts.append(part)
    return parts, total, partial


def _visible_entries(
    role: str, metadata: dict[str, Any], parts: list[dict[str, Any]], timestamp: int | None,
    *, message_id: str, partial: bool,
) -> list[dict[str, Any]]:
    text: list[str] = []
    tools: list[str] = []
    direct_text = metadata.get("text")
    if role == "user" and isinstance(direct_text, str) and direct_text.strip():
        text.append(direct_text)
    attachments = role == "user" and bool(metadata.get("files"))
    for part in parts:
        kind = part.get("type")
        body = part.get("text")
        if part.get("ignored") is True or (role == "user" and part.get("synthetic") is True):
            continue
        if kind == "text" and isinstance(body, str) and body.strip():
            text.append(body)
        elif kind == "file" and role == "user":
            attachments = True
        elif kind == "tool" and role == "assistant":
            state = part.get("state")
            state = state if isinstance(state, dict) else {}
            invocation = _tool(part.get("name", part.get("tool")), state.get("input"))
            output = _argument(state.get("output", state.get("error"))).strip()
            tools.append(invocation if not output else f"{invocation}\n{output}")

    if attachments:
        text.append("[Attachments]")
    entries = []
    if text:
        if role == "user":
            kind = "prompt"
        elif metadata.get("summary") is True:
            # The v1 compaction summarizer stores its result as an assistant message.
            kind = "context"
        else:
            finish = metadata.get("finish")
            time = metadata.get("time")
            incomplete = not finish and isinstance(time, dict) and time.get("completed") is None
            activity = finish in ("tool-calls", "tool_calls") or (finish != "stop" and (tools or incomplete))
            kind = "progress" if activity else "response"
        body = "\n\n".join(text)
        entry = _entry(role, kind, body, timestamp)
        if kind == "prompt":
            entry.update(sourceId=message_id, sourceText=body, complete=not attachments and not partial)
        entries.append(entry)
    if tools:
        entries.append(_entry("tool", "tool", "\n\n".join(tools), timestamp))
    return entries


def read_opencode_records(
    connection: sqlite3.Connection, identifier: str, *, offset: int, limit: int, max_record_bytes: int,
) -> Iterator[tuple[list[dict[str, Any]], int, bool]]:
    """Yield visible entries for each native message in its recorded order."""
    layout = _layout_for(connection, identifier)
    if layout is None:
        return
    message_type = "type" if layout == _V2 else "NULL"
    order = "seq" if layout == _V2 else "time_created, id"
    rows = connection.execute(
        f"SELECT id, {message_type}, time_created, "
        "CASE WHEN length(CAST(data AS BLOB)) <= ? THEN CAST(data AS BLOB) END "
        f"FROM {layout[1]} WHERE session_id = ? ORDER BY {order} LIMIT ? OFFSET ?",
        (max_record_bytes, identifier, limit, offset),
    )
    for message_id, native_type, timestamp, raw in rows:
        metadata = _object(raw) if raw is not None else None
        scanned = len(raw) if raw is not None else 0
        if metadata is None:
            yield [], scanned, True
            continue
        role = native_type if layout == _V2 else metadata.get("role")
        if role not in ("assistant", "user"):
            yield [], scanned, False
            continue
        parts: list[dict[str, Any]] = []
        size, partial = 0, False
        if layout == _V1 or role == "assistant":
            parts, size, partial = _part_records(
                connection, layout, identifier, message_id, max_record_bytes - scanned,
            )
        entries = _visible_entries(role, metadata, parts, timestamp, message_id=message_id, partial=partial)
        yield entries, scanned + size, partial or any(entry["truncated"] for entry in entries)
