from __future__ import annotations

import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from .agent_reference import AgentReference
from .tmux import CreatedSession, Session

SESSION_REGISTRY_SCHEMA_VERSION = 1
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
        if version not in {0, SESSION_REGISTRY_SCHEMA_VERSION}:
            raise sqlite3.DatabaseError(
                f"unsupported session registry schema version: {version}"
            )
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
                with connection:
                    for session in sessions:
                        registry_id = self._reconcile_session(
                            connection,
                            session,
                            references.get(session.name),
                            timestamp,
                        )
                        live_registry_ids.add(registry_id)
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
