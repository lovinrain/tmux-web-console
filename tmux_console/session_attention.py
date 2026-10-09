from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from .tmux import Session


@dataclass(frozen=True)
class SessionAttention:
    state: str = "unknown"
    awaiting_ready: bool = False
    latest_ready_event: int = 0
    last_checked_event: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "latestReadyEvent": self.latest_ready_event,
            "lastCheckedEvent": self.last_checked_event,
        }

    def observe(self, state: str) -> SessionAttention:
        ready = state == "waiting_human"
        return replace(
            self,
            state=state,
            awaiting_ready=state in {"working", "running_command"}
            or (not ready and state != "other" and self.awaiting_ready),
            latest_ready_event=self.latest_ready_event + int(ready and self.awaiting_ready),
        )

    def update(self, action: str, observed_event: int) -> SessionAttention:
        if action == "read":
            if observed_event > self.latest_ready_event:
                raise ValueError("latestReadyEvent is newer than the session")
            return replace(self, last_checked_event=max(self.last_checked_event, observed_event))
        if action == "unread":
            return replace(
                self,
                latest_ready_event=self.latest_ready_event
                + int(self.latest_ready_event == self.last_checked_event),
            )
        raise ValueError("action must be read or unread")


def initialize_session_attention(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS session_attention (
            tmux_id TEXT NOT NULL, created INTEGER NOT NULL,
            server_started INTEGER NOT NULL, server_pid INTEGER NOT NULL,
            state TEXT NOT NULL, awaiting_ready INTEGER NOT NULL
                CHECK(awaiting_ready IN (0, 1)),
            latest_ready_event INTEGER NOT NULL CHECK(latest_ready_event >= 0),
            last_checked_event INTEGER NOT NULL
                CHECK(last_checked_event >= 0 AND last_checked_event <= latest_ready_event),
            PRIMARY KEY(tmux_id, created, server_started, server_pid)
        )
    """)


def _identity(session: Session) -> tuple[str, int, int, int]:
    return session.id, session.created, session.server_started, session.server_pid


def _load(connection: sqlite3.Connection, session: Session) -> SessionAttention:
    row = connection.execute(
        "SELECT state, awaiting_ready, latest_ready_event, last_checked_event "
        "FROM session_attention WHERE tmux_id = ? AND created = ? "
        "AND server_started = ? AND server_pid = ?",
        _identity(session),
    ).fetchone()
    return SessionAttention(
        state=row[0], awaiting_ready=bool(row[1]),
        latest_ready_event=row[2], last_checked_event=row[3],
    ) if row else SessionAttention()


def _save(connection: sqlite3.Connection, session: Session, attention: SessionAttention) -> None:
    connection.execute("""
        INSERT INTO session_attention VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tmux_id, created, server_started, server_pid) DO UPDATE SET
            state = excluded.state, awaiting_ready = excluded.awaiting_ready,
            latest_ready_event = excluded.latest_ready_event,
            last_checked_event = excluded.last_checked_event
    """, (*_identity(session), attention.state, int(attention.awaiting_ready),
          attention.latest_ready_event, attention.last_checked_event))


def observe_session_attention(
    connection: sqlite3.Connection,
    sessions: Sequence[Session],
    states: Mapping[str, str],
) -> dict[str, dict[str, int]]:
    """Track each work episode once for every browser."""
    result = {}
    for session in sessions:
        previous = _load(connection, session)
        current = previous.observe(states[session.name])
        if current != previous:
            _save(connection, session, current)
        result[session.name] = current.to_dict()
    return result


def update_session_attention(
    connection: sqlite3.Connection, session: Session, action: str, observed_event: int,
) -> dict[str, int]:
    """A read acknowledges only the event that the requesting browser observed."""
    previous = _load(connection, session)
    current = previous.update(action, observed_event)
    if current != previous:
        _save(connection, session, current)
    return current.to_dict()
