from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .session_registry import SessionRegistry, default_session_registry_path
from .tmux import Pane, Session, TmuxClient, TmuxError, TmuxSessionIdentityChangedError

LOGGER = logging.getLogger("muxdeck.scrollback")
MAX_SAVED_LINES = 2000
MAX_SAVED_BYTES = 1024 * 1024
UNCHANGED_CAPTURE_SECONDS = 30.0


class ScrollbackStoreUnavailable(OSError):
    pass


def default_scrollback_path(registry_path: Path | None = None) -> Path:
    configured = os.environ.get("MUXDECK_SCROLLBACK_FILE")
    return Path(configured).expanduser() if configured else (
        registry_path or default_session_registry_path()
    ).with_name("scrollback.sqlite3")


def _bounded(lines: list[str], *, beginning: bool) -> tuple[list[str], bool]:
    source = lines[:MAX_SAVED_LINES] if beginning else lines[-MAX_SAVED_LINES:]
    result: list[str] = []
    remaining = MAX_SAVED_BYTES
    limited = len(source) < len(lines)
    for line in source if beginning else reversed(source):
        encoded = line.encode("utf-8", "replace")
        if len(encoded) + 1 > remaining:
            budget = max(0, remaining - 1)
            if budget:
                fragment = encoded[:budget] if beginning else encoded[-budget:]
                result.append(fragment.decode("utf-8", "ignore"))
            limited = True
            break
        result.append(encoded.decode("utf-8"))
        remaining -= len(encoded) + 1
    return (result if beginning else list(reversed(result))), limited


def _extends(previous: list[str], current: list[str]) -> bool:
    # The last visible row can be an unfinished line (for example a shell prompt).
    # Only accept append-only growth; redraws and rolling history must never replace
    # the opening with later output that happens to have the same line count.
    return not previous or (
        len(current) >= len(previous)
        and current[:len(previous) - 1] == previous[:-1]
        and current[len(previous) - 1].startswith(previous[-1])
    )


class ScrollbackStore:
    """Bounded opening and recent captures, independent of tmux's rolling buffer."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_scrollback_path()
        self._connection: sqlite3.Connection | None = None
        self._lock = threading.RLock()
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self._connection = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            if self._connection.execute("PRAGMA user_version").fetchone()[0] not in {0, 1}:
                raise sqlite3.DatabaseError("unsupported scrollback schema")
            with self._connection:
                self._connection.execute("""
                    CREATE TABLE IF NOT EXISTS scrollback (
                        id TEXT PRIMARY KEY,
                        history_id TEXT NOT NULL,
                        pane_id TEXT NOT NULL,
                        pane_pid INTEGER NOT NULL,
                        session_created INTEGER NOT NULL,
                        first_captured REAL NOT NULL,
                        beginning_at REAL NOT NULL,
                        beginning TEXT NOT NULL,
                        beginning_sealed INTEGER NOT NULL,
                        beginning_limited INTEGER NOT NULL,
                        recent_at REAL NOT NULL,
                        recent TEXT NOT NULL,
                        recent_limited INTEGER NOT NULL,
                        UNIQUE(history_id, pane_id, pane_pid)
                    )
                """)
                self._connection.execute("PRAGMA user_version = 1")
            os.chmod(self.path, 0o600)
        except (OSError, sqlite3.Error):
            self.close()
            LOGGER.error("Saved scrollback is unavailable; live terminal input is unaffected")

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise ScrollbackStoreUnavailable("saved scrollback is unavailable")
        return self._connection

    def save(
        self, history_id: str, session: Session, pane: Pane,
        beginning: list[str], recent: list[str], *,
        beginning_limited: bool = False, recent_limited: bool = False,
        captured_at: float | None = None,
    ) -> bool | None:
        if not any(line.strip() for line in beginning + recent):
            return None
        beginning, clipped_beginning = _bounded(beginning, beginning=True)
        recent, clipped_recent = _bounded(recent, beginning=False)
        beginning_limited = beginning_limited or clipped_beginning
        recent_limited = recent_limited or clipped_recent
        now = time.time() if captured_at is None else captured_at
        identity = (history_id, pane.id, pane.process_pid)
        with self._lock:
            connection = self._require_connection()
            try:
                with connection:
                    row = connection.execute(
                        "SELECT * FROM scrollback WHERE history_id = ? AND pane_id = ? AND pane_pid = ?",
                        identity,
                    ).fetchone()
                    if row is None:
                        connection.execute("""
                            INSERT INTO scrollback VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (str(uuid.uuid4()), *identity, session.created, now, now,
                              json.dumps(beginning, ensure_ascii=False), int(beginning_limited), int(beginning_limited),
                              now, json.dumps(recent, ensure_ascii=False), int(recent_limited)))
                        return beginning_limited
                    opening = json.loads(row["beginning"])
                    extend = not row["beginning_sealed"] and _extends(opening, beginning)
                    sealed = bool(row["beginning_sealed"]) or not extend or beginning_limited
                    connection.execute("""
                        UPDATE scrollback SET beginning = ?, beginning_at = ?,
                            beginning_sealed = ?, beginning_limited = ?,
                            recent = ?, recent_at = ?, recent_limited = ? WHERE id = ?
                    """, (
                        json.dumps(beginning, ensure_ascii=False) if extend else row["beginning"],
                        now if extend and opening != beginning else row["beginning_at"],
                        int(sealed), int(beginning_limited) if extend else row["beginning_limited"],
                        json.dumps(recent, ensure_ascii=False), now, int(recent_limited), row["id"],
                    ))
                    return sealed
            except (sqlite3.Error, ValueError) as error:
                raise ScrollbackStoreUnavailable("unable to save scrollback") from error

    def read(
        self, history_id: str, *, part: str = "beginning", record_id: str | None = None,
        pane: Pane | None = None,
    ) -> dict[str, Any]:
        if part not in {"beginning", "recent"}:
            raise ValueError("part must be beginning or recent")
        with self._lock:
            try:
                connection = self._require_connection()
                # Fetch only the selected output region, not every pane's two
                # large captures. Old pane incarnations remain selectable.
                rows = connection.execute(
                    "SELECT id, pane_id, pane_pid, first_captured FROM scrollback "
                    "WHERE history_id = ? ORDER BY first_captured, id",
                    (history_id,),
                ).fetchall()
                if pane is not None:
                    rows = [row for row in rows if row["pane_id"] == pane.id and row["pane_pid"] == pane.process_pid]
                selected = next((row for row in rows if row["id"] == record_id), None) if record_id else (rows[0] if rows else None)
                if record_id and selected is None:
                    raise ValueError("saved pane does not belong to this session")
                capture = connection.execute(
                    f"SELECT {part}, {part}_at, {part}_limited, session_created "
                    "FROM scrollback WHERE id = ?", (selected["id"],),
                ).fetchone() if selected else None
            except sqlite3.Error as error:
                raise ScrollbackStoreUnavailable("unable to read saved scrollback") from error
        try:
            lines = json.loads(capture[part]) if capture else []
            if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
                raise ValueError("invalid saved output")
        except (ValueError, TypeError) as error:
            raise ScrollbackStoreUnavailable("unable to read saved scrollback") from error
        return {
            "panes": [{"id": row["id"], "paneId": row["pane_id"], "firstCapturedAt": row["first_captured"]} for row in rows],
            "selectedPane": selected["id"] if selected else None,
            "part": part,
            "lines": lines,
            "capturedAt": capture[f"{part}_at"] if capture else None,
            "firstCapturedAt": selected["first_captured"] if selected else None,
            "sessionCreatedAt": capture["session_created"] if capture else None,
            "limited": bool(capture[f"{part}_limited"]) if capture else False,
            "lineLimit": MAX_SAVED_LINES,
            "byteLimit": MAX_SAVED_BYTES,
        }


def session_identity(session: Session) -> str:
    return f"{session.id}:{session.created}:{session.server_started}:{session.server_pid}"


def _pane_identity(session: Session, pane: Pane) -> tuple[str, str, int]:
    return session_identity(session), pane.id, pane.process_pid


class ScrollbackRecorder:
    def __init__(self, tmux: TmuxClient, registry: SessionRegistry, store: ScrollbackStore) -> None:
        self.tmux = tmux
        self.registry = registry
        self.store = store
        self._last: OrderedDict[tuple[str, str, int], tuple[tuple[Any, ...], float, bool]] = OrderedDict()
        self._lock = asyncio.Lock()
        self._limit = asyncio.Semaphore(3)

    async def sample(
        self, sessions: list[Session], *, force: bool = False, pane_ids: set[str] | None = None,
    ) -> set[tuple[str, str, int]]:
        async with self._lock:
            samples: list[tuple[Session, Pane, list[str], list[str], bool, bool, tuple[Any, ...], float]] = []

            async def capture(session: Session, pane: Pane) -> None:
                if pane_ids is not None and pane.id not in pane_ids:
                    return
                key = _pane_identity(session, pane)
                signature = (pane.activity, pane.history_size, pane.width, pane.height, pane.alternate_on, pane.command, pane.title, pane.dead)
                now = time.monotonic()
                previous = self._last.get(key)
                if not force and previous and previous[0] == signature and now - previous[1] < UNCHANGED_CAPTURE_SECONDS:
                    return
                first_row = -max(0, pane.history_size)
                last_row = max(0, pane.height - 1)
                opening_end = min(last_row, first_row + MAX_SAVED_LINES - 1)
                recent_start = max(first_row, last_row - MAX_SAVED_LINES + 1)
                try:
                    async with self._limit:
                        recent = await self.tmux.capture_history_slice(pane, recent_start, last_row)
                        if previous and previous[2]:
                            opening_lines = []  # A sealed opening never needs recapturing.
                        elif recent_start == first_row and opening_end == last_row:
                            opening_lines = recent.lines
                        else:
                            opening_lines = (await self.tmux.capture_history_slice(pane, first_row, opening_end)).lines
                except TmuxError:
                    return  # A pane can disappear while the inventory is being captured.
                samples.append((session, pane, opening_lines, recent.lines,
                                opening_end < last_row, recent_start > first_row, signature, now))

            await asyncio.gather(*(capture(session, pane) for session in sessions for pane in session.panes))
            if not samples:
                return set()
            # Fence both sides of capture against server restarts, pane replacement,
            # and moves between sessions; never attach another pane's output to an old ID.
            current = await self.tmux.list_sessions()
            live = {_pane_identity(session, pane) for session in current for pane in session.panes}
            saved: set[tuple[str, str, int]] = set()
            for session, pane, opening, recent, opening_limited, recent_limited, signature, now in samples:
                key = _pane_identity(session, pane)
                if key not in live:
                    continue
                history_id = self.registry.observe_history(session)
                sealed = await asyncio.to_thread(
                    self.store.save, history_id, session, pane, opening, recent,
                    beginning_limited=opening_limited, recent_limited=recent_limited,
                )
                if sealed is not None:
                    self._last[key] = (signature, now, sealed)
                    self._last.move_to_end(key)
                saved.add(key)
            while len(self._last) > 512:
                self._last.popitem(last=False)
            return saved

    async def capture_pane(self, pane_id: str, expected_identity: str | None = None) -> tuple[str, Pane]:
        sessions = await self.tmux.list_sessions()
        found = False
        for session in sessions:
            for pane in session.panes:
                if pane.id != pane_id:
                    continue
                found = True
                if expected_identity is not None and session_identity(session) != expected_identity:
                    continue
                saved = await self.sample([session], force=True, pane_ids={pane_id})
                if _pane_identity(session, pane) not in saved:
                    raise TmuxSessionIdentityChangedError("pane changed during capture")
                return self.registry.observe_history(session), pane
        if found:
            raise TmuxSessionIdentityChangedError("session identity changed")
        raise TmuxError("tmux pane not found")
