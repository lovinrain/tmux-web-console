from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .agent_reference import AgentReference
from .tmux import CreatedSession, Session

SESSION_REGISTRY_SCHEMA_VERSION = 3
LAST_SEEN_WRITE_INTERVAL_SECONDS = 60
SESSION_REGISTRY_UNAVAILABLE_MESSAGE = (
    "session recovery registry is unavailable; repair the configured SQLite "
    "database and restart Muxdeck"
)


class SessionRegistryUnavailable(OSError):
    pass


class RecoveryRecordNotFoundError(KeyError):
    pass


def default_session_registry_path() -> Path:
    configured = os.environ.get("MUXDECK_SESSION_REGISTRY_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "sessions.sqlite3"


@dataclass(frozen=True)
class RecoveryRecord:
    id: str
    name: str
    directory: str
    tmux_session_id: str
    session_created: int
    server_started: int
    server_pid: int
    agent_type: str | None
    agent_session_id: str | None
    first_seen_at: int
    last_seen_at: int
    recoverable: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "directory": self.directory,
            "agentType": self.agent_type,
            "agentSessionId": self.agent_session_id,
            "firstSeenAt": self.first_seen_at,
            "lastSeenAt": self.last_seen_at,
            "directoryAvailable": Path(self.directory).is_dir(),
        }


REGISTRY_COLUMNS = """
    registry_id, tmux_name, working_directory, tmux_session_id,
    session_created, server_started, server_pid, agent_type,
    agent_session_id, first_seen_at, last_seen_at, recoverable
"""
REGISTRY_COLUMN_NAMES = (
    "registry_id",
    "tmux_name",
    "working_directory",
    "tmux_session_id",
    "session_created",
    "server_started",
    "server_pid",
    "agent_type",
    "agent_session_id",
    "first_seen_at",
    "last_seen_at",
    "recoverable",
)


def _row_to_record(row: sqlite3.Row) -> RecoveryRecord:
    return RecoveryRecord(
        id=row["registry_id"],
        name=row["tmux_name"],
        directory=row["working_directory"],
        tmux_session_id=row["tmux_session_id"],
        session_created=row["session_created"],
        server_started=row["server_started"],
        server_pid=row["server_pid"],
        agent_type=row["agent_type"],
        agent_session_id=row["agent_session_id"],
        first_seen_at=row["first_seen_at"],
        last_seen_at=row["last_seen_at"],
        recoverable=bool(row["recoverable"]),
    )


def _identity(session: Session) -> tuple[str, int, int, int]:
    return (
        session.id,
        session.created,
        session.server_started,
        session.server_pid,
    )


class SessionRegistry:
    def __init__(
        self,
        path: Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.path = path or default_session_registry_path()
        self._clock = clock
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self._connection = sqlite3.connect(self.path, timeout=5.0)
            self._connection.row_factory = sqlite3.Row
            self._initialize()
            os.chmod(self.path, 0o600)
        except (OSError, sqlite3.Error) as error:
            self.close()
            raise SessionRegistryUnavailable(
                SESSION_REGISTRY_UNAVAILABLE_MESSAGE
            ) from error

    def _initialize(self) -> None:
        connection = self._require_connection()
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version not in {0, 1, 2, SESSION_REGISTRY_SCHEMA_VERSION}:
            raise sqlite3.DatabaseError(
                f"unsupported session registry schema version: {version}"
            )
        connection.execute("BEGIN")
        with connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    registry_id TEXT PRIMARY KEY,
                    tmux_name TEXT NOT NULL UNIQUE,
                    working_directory TEXT NOT NULL,
                    tmux_session_id TEXT NOT NULL,
                    session_created INTEGER NOT NULL,
                    server_started INTEGER NOT NULL,
                    server_pid INTEGER NOT NULL,
                    agent_type TEXT,
                    agent_session_id TEXT,
                    first_seen_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    recoverable INTEGER NOT NULL DEFAULT 1
                        CHECK (recoverable IN (0, 1))
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS sessions_identity_idx ON sessions "
                "(tmux_session_id, session_created, server_started, server_pid)"
            )
            actual_columns = tuple(
                row[1] for row in connection.execute("PRAGMA table_info(sessions)")
            )
            if actual_columns != REGISTRY_COLUMN_NAMES:
                raise sqlite3.DatabaseError("session registry schema is malformed")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS session_history (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, names TEXT NOT NULL,
                    directory TEXT NOT NULL, tmux_id TEXT NOT NULL,
                    created INTEGER NOT NULL, server_started INTEGER NOT NULL,
                    server_pid INTEGER NOT NULL, agent_type TEXT, agent_id TEXT,
                    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
                    state TEXT NOT NULL, ended_at INTEGER, tab_closed_at INTEGER, title TEXT,
                    UNIQUE(tmux_id, created, server_started, server_pid)
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS history_workspaces (
                    history_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
                    workspace_name TEXT NOT NULL, first_seen INTEGER NOT NULL,
                    last_seen INTEGER NOT NULL, present INTEGER NOT NULL,
                    closed_at INTEGER,
                    PRIMARY KEY(history_id, workspace_id)
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS session_agents (
                    history_id TEXT NOT NULL, agent_type TEXT NOT NULL,
                    agent_id TEXT NOT NULL DEFAULT '',
                    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
                    PRIMARY KEY(history_id, agent_type, agent_id)
                )
            """)
            connection.execute("CREATE INDEX IF NOT EXISTS session_agents_idx ON session_agents(history_id, first_seen)")
            connection.execute("CREATE INDEX IF NOT EXISTS history_workspace_idx ON history_workspaces(workspace_id, last_seen)")
            connection.execute("CREATE INDEX IF NOT EXISTS history_name_idx ON session_history(name, last_seen)")
            if version < 2:
                for row in connection.execute(f"SELECT {REGISTRY_COLUMNS} FROM sessions").fetchall():
                    connection.execute("""
                        INSERT OR IGNORE INTO session_history VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL
                        )
                    """, (
                        str(uuid.uuid4()), row["tmux_name"], json.dumps([row["tmux_name"]]),
                        row["working_directory"], row["tmux_session_id"], row["session_created"],
                        row["server_started"], row["server_pid"], row["agent_type"],
                        row["agent_session_id"], row["first_seen_at"], row["last_seen_at"],
                        "missing" if row["recoverable"] else "ended",
                    ))
            if version < 3:
                connection.execute("""
                    INSERT OR IGNORE INTO session_agents (
                        history_id, agent_type, agent_id, first_seen, last_seen
                    )
                    SELECT id, agent_type, coalesce(agent_id, ''), first_seen, last_seen
                    FROM session_history WHERE agent_type IS NOT NULL
                """)
            connection.execute(f"PRAGMA user_version={SESSION_REGISTRY_SCHEMA_VERSION}")

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise SessionRegistryUnavailable(SESSION_REGISTRY_UNAVAILABLE_MESSAGE)
        return self._connection

    def close(self) -> None:
        with self._lock:
            connection = self._connection
            self._connection = None
            if connection is not None:
                connection.close()

    def _database_error(self, error: BaseException) -> SessionRegistryUnavailable:
        return SessionRegistryUnavailable(SESSION_REGISTRY_UNAVAILABLE_MESSAGE)

    def reconcile(
        self,
        sessions: list[Session],
        references: Mapping[str, AgentReference] | None = None,
        *,
        observed_at: int | None = None,
    ) -> list[RecoveryRecord]:
        timestamp = int(self._clock()) if observed_at is None else int(observed_at)
        references = references or {}
        with self._lock:
            try:
                connection = self._require_connection()
                live_registry_ids: set[str] = set()
                live_history_ids: set[str] = set()
                with connection:
                    for session in sessions:
                        live_history_ids.add(self._observe_history(connection, session, references.get(session.name), timestamp))
                        registry_id = self._reconcile_session(
                            connection,
                            session,
                            references.get(session.name),
                            timestamp,
                        )
                        live_registry_ids.add(registry_id)
                    for history in connection.execute("SELECT id FROM session_history WHERE state = 'live'").fetchall():
                        if history["id"] not in live_history_ids:
                            connection.execute("UPDATE session_history SET state = 'missing', ended_at = ? WHERE id = ?", (timestamp, history["id"]))
                    rows = connection.execute(
                        f"SELECT {REGISTRY_COLUMNS} FROM sessions "
                        "WHERE recoverable = 1 ORDER BY last_seen_at DESC, tmux_name"
                    ).fetchall()
                return [
                    _row_to_record(row)
                    for row in rows
                    if row["registry_id"] not in live_registry_ids
                ]
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error

    def _reconcile_session(
        self,
        connection: sqlite3.Connection,
        session: Session,
        reference: AgentReference | None,
        timestamp: int,
    ) -> str:
        identity = _identity(session)
        identity_row = connection.execute(
            f"SELECT {REGISTRY_COLUMNS} FROM sessions WHERE "
            "tmux_session_id = ? AND session_created = ? AND "
            "server_started = ? AND server_pid = ? "
            "ORDER BY last_seen_at DESC LIMIT 1",
            identity,
        ).fetchone()
        name_row = connection.execute(
            f"SELECT {REGISTRY_COLUMNS} FROM sessions WHERE tmux_name = ?",
            (session.name,),
        ).fetchone()
        row = identity_row or name_row
        if (
            identity_row is not None
            and name_row is not None
            and identity_row["registry_id"] != name_row["registry_id"]
        ):
            connection.execute(
                "DELETE FROM sessions WHERE registry_id = ?",
                (name_row["registry_id"],),
            )

        pane = session.active_pane
        discovered_directory = pane.path if pane is not None and pane.path else None
        if row is None:
            registry_id = self._id_factory()
            agent_type = reference.agent_type if reference is not None else None
            agent_session_id = reference.session_id if reference is not None else None
            connection.execute(
                """
                INSERT INTO sessions (
                    registry_id, tmux_name, working_directory, tmux_session_id,
                    session_created, server_started, server_pid, agent_type,
                    agent_session_id, first_seen_at, last_seen_at, recoverable
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    registry_id,
                    session.name,
                    discovered_directory or str(Path.home()),
                    *identity,
                    agent_type,
                    agent_session_id,
                    timestamp,
                    timestamp,
                ),
            )
            return registry_id

        record = _row_to_record(row)
        effective_agent_type = record.agent_type
        agent_session_id = record.agent_session_id
        if reference is not None and reference.agent_type is not None:
            if reference.agent_type != effective_agent_type:
                effective_agent_type = reference.agent_type
                agent_session_id = reference.session_id
            elif reference.session_id is not None:
                agent_session_id = reference.session_id
        directory = discovered_directory or record.directory
        meaningful_change = (
            record.name != session.name
            or record.directory != directory
            or (
                record.tmux_session_id,
                record.session_created,
                record.server_started,
                record.server_pid,
            )
            != identity
            or record.agent_type != effective_agent_type
            or record.agent_session_id != agent_session_id
            or not record.recoverable
        )
        last_seen_at = (
            timestamp
            if meaningful_change
            or timestamp - record.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_SECONDS
            else record.last_seen_at
        )
        if meaningful_change or last_seen_at != record.last_seen_at:
            connection.execute(
                """
                UPDATE sessions SET
                    tmux_name = ?, working_directory = ?, tmux_session_id = ?,
                    session_created = ?, server_started = ?, server_pid = ?,
                    agent_type = ?, agent_session_id = ?, last_seen_at = ?,
                    recoverable = 1
                WHERE registry_id = ?
                """,
                (
                    session.name,
                    directory,
                    *identity,
                    effective_agent_type,
                    agent_session_id,
                    last_seen_at,
                    record.id,
                ),
            )
        return record.id

    def record_created(
        self,
        created: CreatedSession,
        directory: str,
        *,
        registry_id: str | None = None,
    ) -> RecoveryRecord:
        timestamp = int(self._clock())
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    self._observe_history(connection, Session(
                        name=created.name, id=created.id, windows=1, attached=0,
                        created=0,
                    ), None, timestamp, directory=directory)
                    row = None
                    if registry_id is not None:
                        row = connection.execute(
                            f"SELECT {REGISTRY_COLUMNS} FROM sessions "
                            "WHERE registry_id = ?",
                            (registry_id,),
                        ).fetchone()
                        if row is None:
                            raise RecoveryRecordNotFoundError(registry_id)
                        connection.execute(
                            "DELETE FROM sessions WHERE tmux_name = ? "
                            "AND registry_id != ?",
                            (created.name, registry_id),
                        )
                    if row is None:
                        row = connection.execute(
                            f"SELECT {REGISTRY_COLUMNS} FROM sessions "
                            "WHERE tmux_name = ?",
                            (created.name,),
                        ).fetchone()

                    if row is None:
                        next_id = registry_id or self._id_factory()
                        connection.execute(
                            """
                            INSERT INTO sessions (
                                registry_id, tmux_name, working_directory,
                                tmux_session_id, session_created, server_started,
                                server_pid, agent_type, agent_session_id,
                                first_seen_at, last_seen_at, recoverable
                            ) VALUES (?, ?, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, 1)
                            """,
                            (
                                next_id,
                                created.name,
                                directory,
                                created.id,
                                timestamp,
                                timestamp,
                            ),
                        )
                    else:
                        current = _row_to_record(row)
                        next_id = current.id
                        connection.execute(
                            """
                            UPDATE sessions SET tmux_name = ?, working_directory = ?,
                                tmux_session_id = ?, session_created = 0,
                                server_started = 0, server_pid = 0,
                                last_seen_at = ?, recoverable = 1
                            WHERE registry_id = ?
                            """,
                            (
                                created.name,
                                directory,
                                created.id,
                                timestamp,
                                next_id,
                            ),
                        )
                    saved = connection.execute(
                        f"SELECT {REGISTRY_COLUMNS} FROM sessions "
                        "WHERE registry_id = ?",
                        (next_id,),
                    ).fetchone()
                if saved is None:
                    raise sqlite3.DatabaseError("created registry row disappeared")
                return _row_to_record(saved)
            except RecoveryRecordNotFoundError:
                raise
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error

    def get_recoverable(self, registry_id: str) -> RecoveryRecord:
        with self._lock:
            try:
                row = self._require_connection().execute(
                    f"SELECT {REGISTRY_COLUMNS} FROM sessions "
                    "WHERE registry_id = ? AND recoverable = 1",
                    (registry_id,),
                ).fetchone()
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error
        if row is None:
            raise RecoveryRecordNotFoundError(registry_id)
        return _row_to_record(row)

    def forget(self, registry_id: str) -> bool:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    cursor = connection.execute(
                        "DELETE FROM sessions WHERE registry_id = ?",
                        (registry_id,),
                    )
                return cursor.rowcount > 0
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error

    def set_recovery_for_identity(
        self,
        name: str,
        tmux_session_id: str,
        session_created: int,
        server_started: int,
        server_pid: int,
        recoverable: bool,
    ) -> bool:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    cursor = connection.execute(
                        """
                        UPDATE sessions SET recoverable = ?
                        WHERE tmux_name = ? AND tmux_session_id = ?
                            AND (
                                (session_created = ? AND server_started = ?
                                    AND server_pid = ?)
                                OR (session_created = 0 AND server_started = 0
                                    AND server_pid = 0)
                            )
                        """,
                        (
                            int(recoverable),
                            name,
                            tmux_session_id,
                            session_created,
                            server_started,
                            server_pid,
                        ),
                    )
                return cursor.rowcount > 0
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error

    def _observe_history(
        self, connection: sqlite3.Connection, session: Session,
        reference: AgentReference | None, timestamp: int,
        *, directory: str | None = None,
    ) -> str:
        identity = _identity(session)
        row = connection.execute(
            "SELECT * FROM session_history WHERE tmux_id = ? AND created = ? AND server_started = ? AND server_pid = ?",
            identity,
        ).fetchone()
        if row is None and session.created:
            # Creation is recorded before tmux's full server identity is available.
            row = connection.execute(
                "SELECT * FROM session_history WHERE name = ? AND tmux_id = ? AND created = 0 AND state = 'live'",
                (session.name, session.id),
            ).fetchone()
        directory = directory or (session.active_pane.path if session.active_pane else None) or (row["directory"] if row else str(Path.home()))
        agent_type = reference.agent_type if reference and reference.agent_type else (row["agent_type"] if row else None)
        agent_id = row["agent_id"] if row and row["agent_type"] == agent_type else None
        if reference and reference.session_id:
            agent_id = reference.session_id
        if row is None:
            history_id = str(uuid.uuid4())
            connection.execute("""
                INSERT INTO session_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', NULL, NULL, NULL)
            """, (history_id, session.name, json.dumps([session.name]), directory, *identity,
                  agent_type, agent_id, timestamp, timestamp))
            self._record_agent(connection, history_id, agent_type, agent_id, timestamp)
            return history_id
        names = json.loads(row["names"])
        if session.name not in names:
            names.append(session.name)
        changed = (
            row["name"] != session.name or row["directory"] != directory
            or row["created"] != session.created or row["server_started"] != session.server_started
            or row["server_pid"] != session.server_pid or row["state"] != "live"
            or row["agent_type"] != agent_type or row["agent_id"] != agent_id
            or timestamp - row["last_seen"] >= LAST_SEEN_WRITE_INTERVAL_SECONDS
        )
        if changed:
            connection.execute("""
                UPDATE session_history SET name = ?, names = ?, directory = ?,
                    created = ?, server_started = ?, server_pid = ?, agent_type = ?,
                    agent_id = ?, last_seen = ?, state = 'live', ended_at = NULL WHERE id = ?
            """, (session.name, json.dumps(names), directory, session.created, session.server_started,
                  session.server_pid, agent_type, agent_id, timestamp, row["id"]))
        self._record_agent(connection, str(row["id"]), agent_type, agent_id, timestamp)
        return str(row["id"])

    def _record_agent(
        self,
        connection: sqlite3.Connection,
        history_id: str,
        agent_type: str | None,
        agent_id: str | None,
        timestamp: int,
    ) -> None:
        """A session can run several agents in turn. session_history keeps only
        the newest; this keeps each one that was actually seen."""
        if not agent_type:
            return
        # SQLite treats NULLs as distinct in a primary key, so an unknown id is
        # stored as an empty string to keep repeated observations deduplicated.
        connection.execute("""
            INSERT INTO session_agents (history_id, agent_type, agent_id, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(history_id, agent_type, agent_id) DO UPDATE SET
                last_seen = excluded.last_seen
            WHERE excluded.last_seen - session_agents.last_seen >= ?
        """, (history_id, agent_type, agent_id or "", timestamp, timestamp,
              LAST_SEEN_WRITE_INTERVAL_SECONDS))

    def list_session_agents(self, history_id: str) -> list[dict[str, Any]]:
        with self._lock:
            try:
                connection = self._require_connection()
                return [
                    {
                        "agentType": row["agent_type"],
                        "agentSessionId": row["agent_id"] or None,
                        "firstSeenAt": row["first_seen"],
                        "lastSeenAt": row["last_seen"],
                    }
                    for row in connection.execute(
                        "SELECT agent_type, agent_id, first_seen, last_seen "
                        "FROM session_agents WHERE history_id = ? "
                        "ORDER BY first_seen, agent_type",
                        (history_id,),
                    )
                ]
            except sqlite3.Error as error:
                raise self._database_error(error) from error

    def observe_history(self, session: Session, reference: AgentReference | None = None) -> str:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    return self._observe_history(connection, session, reference, int(self._clock()))
            except sqlite3.Error as error:
                raise self._database_error(error) from error

    def sync_history_workspaces(self, workspaces: list[dict[str, Any]]) -> None:
        """Keep past membership even after a tab, workspace, or native session is gone."""
        timestamp = int(self._clock())
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    by_name: dict[str, str] = {}
                    for row in connection.execute("SELECT id, name FROM session_history ORDER BY last_seen, rowid"):
                        by_name[row["name"]] = row["id"]
                    wanted: set[tuple[str, str]] = set()
                    for workspace in workspaces:
                        for name in workspace["tabs"]:
                            history_id = by_name.get(name)
                            if history_id is None:
                                continue
                            wanted.add((history_id, workspace["id"]))
                            connection.execute("""
                                INSERT INTO history_workspaces VALUES (?, ?, ?, ?, ?, 1, NULL)
                                ON CONFLICT(history_id, workspace_id) DO UPDATE SET
                                    workspace_name = excluded.workspace_name,
                                    last_seen = excluded.last_seen, present = 1
                                WHERE history_workspaces.present = 0
                                   OR history_workspaces.workspace_name != excluded.workspace_name
                                   OR excluded.last_seen - history_workspaces.last_seen >= 60
                            """, (history_id, workspace["id"], workspace["name"], timestamp, timestamp))
                    for row in connection.execute("SELECT history_id, workspace_id FROM history_workspaces WHERE present = 1").fetchall():
                        if (row["history_id"], row["workspace_id"]) not in wanted:
                            connection.execute("UPDATE history_workspaces SET present = 0, closed_at = ? WHERE history_id = ? AND workspace_id = ?", (timestamp, row["history_id"], row["workspace_id"]))
            except sqlite3.Error as error:
                raise self._database_error(error) from error

    def mark_history(self, history_id: str, *, ended: bool = False) -> None:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    if ended:
                        connection.execute("UPDATE session_history SET state = 'ended', ended_at = ? WHERE id = ?", (int(self._clock()), history_id))
                    else:
                        connection.execute("UPDATE session_history SET tab_closed_at = ? WHERE id = ?", (int(self._clock()), history_id))
            except sqlite3.Error as error:
                raise self._database_error(error) from error

    def record_history_titles(self, titles: Mapping[str, str | None]) -> None:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    for name, title in titles.items():
                        connection.execute("UPDATE session_history SET title = ? WHERE name = ? AND state = 'live' AND title IS NOT ?", (title, name, title))
            except sqlite3.Error as error:
                raise self._database_error(error) from error

    def get_history(self, history_id: str) -> dict[str, Any]:
        with self._lock:
            try:
                row = self._require_connection().execute("SELECT * FROM session_history WHERE id = ?", (history_id,)).fetchone()
            except sqlite3.Error as error:
                raise self._database_error(error) from error
            if row is None:
                raise RecoveryRecordNotFoundError(history_id)
            return dict(row)

    def list_history(
        self, *, workspace_id: str | None = None, query: str = "",
        recycled: bool = False, offset: int = 0,
    ) -> dict[str, Any]:
        with self._lock:
            try:
                connection = self._require_connection()
                clauses = ["1 = 1"]
                params: list[Any] = []
                if workspace_id:
                    clauses.append("EXISTS (SELECT 1 FROM history_workspaces w WHERE w.history_id = h.id AND w.workspace_id = ?)")
                    params.append(workspace_id)
                if query:
                    clauses.append("(instr(lower(h.names || ' ' || coalesce(h.title, '') || ' ' || h.directory || ' ' || coalesce(h.agent_type, '') || ' ' || coalesce(h.agent_id, '')), lower(?)) > 0)")
                    params.append(query)
                if recycled:
                    clauses.append("(h.state != 'live' OR h.tab_closed_at IS NOT NULL OR EXISTS (SELECT 1 FROM history_workspaces w WHERE w.history_id = h.id AND w.closed_at IS NOT NULL))")
                rows = connection.execute(
                    "SELECT h.* FROM session_history h WHERE " + " AND ".join(clauses)
                    + " ORDER BY max(h.last_seen, coalesce(h.ended_at, 0), coalesce(h.tab_closed_at, 0), coalesce((SELECT max(coalesce(w.closed_at, w.last_seen)) FROM history_workspaces w WHERE w.history_id = h.id), 0)) DESC, h.id LIMIT 51 OFFSET ?",
                    [*params, offset],
                ).fetchall()
                entries = []
                for row in rows[:50]:
                    memberships = connection.execute("SELECT * FROM history_workspaces WHERE history_id = ? ORDER BY last_seen DESC", (row["id"],)).fetchall()
                    agents = connection.execute(
                        "SELECT agent_type, agent_id, first_seen, last_seen FROM session_agents "
                        "WHERE history_id = ? ORDER BY first_seen, agent_type", (row["id"],),
                    ).fetchall()
                    entries.append({
                        "id": row["id"], "name": row["name"], "names": json.loads(row["names"]), "title": row["title"],
                        "directory": row["directory"], "directoryAvailable": Path(row["directory"]).is_dir(),
                        "agentType": row["agent_type"], "agentSessionId": row["agent_id"],
                        "firstSeenAt": row["first_seen"], "lastSeenAt": row["last_seen"],
                        "state": row["state"], "endedAt": row["ended_at"], "tabClosedAt": row["tab_closed_at"],
                        "workspaces": [{"id": w["workspace_id"], "name": w["workspace_name"], "present": bool(w["present"]), "lastSeenAt": w["last_seen"], "closedAt": w["closed_at"]} for w in memberships],
                        "agents": [{"agentType": a["agent_type"], "agentSessionId": a["agent_id"] or None, "firstSeenAt": a["first_seen"], "lastSeenAt": a["last_seen"]} for a in agents],
                    })
                return {"entries": entries, "nextOffset": offset + 50 if len(rows) > 50 else None}
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error

    def rename_identity(
        self,
        tmux_session_id: str,
        session_created: int,
        server_started: int,
        server_pid: int,
        new_name: str,
    ) -> bool:
        with self._lock:
            try:
                connection = self._require_connection()
                with connection:
                    history = connection.execute("SELECT id, names FROM session_history WHERE tmux_id = ? AND created = ? AND server_started = ? AND server_pid = ?", (tmux_session_id, session_created, server_started, server_pid)).fetchone()
                    if history is not None:
                        names = json.loads(history["names"])
                        if new_name not in names:
                            names.append(new_name)
                        connection.execute("UPDATE session_history SET name = ?, names = ?, last_seen = ? WHERE id = ?", (new_name, json.dumps(names), int(self._clock()), history["id"]))
                    row = connection.execute(
                        """
                        SELECT registry_id FROM sessions
                        WHERE tmux_session_id = ? AND session_created = ?
                            AND server_started = ? AND server_pid = ?
                        ORDER BY last_seen_at DESC LIMIT 1
                        """,
                        (
                            tmux_session_id,
                            session_created,
                            server_started,
                            server_pid,
                        ),
                    ).fetchone()
                    if row is None:
                        return False
                    registry_id = row["registry_id"]
                    connection.execute(
                        "DELETE FROM sessions WHERE tmux_name = ? "
                        "AND registry_id != ?",
                        (new_name, registry_id),
                    )
                    connection.execute(
                        "UPDATE sessions SET tmux_name = ? WHERE registry_id = ?",
                        (new_name, registry_id),
                    )
                return True
            except (OSError, sqlite3.Error) as error:
                raise self._database_error(error) from error
