"""Private, transactional project journal; remote effects require receiver fencing.

The database is authoritative. JSON exports are derived snapshots and SQLite
backup is used instead of copying a live WAL file. Same-UID access is not a
hostile-process security boundary or a tamper-proof audit guarantee.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Any, Self

SCHEMA_VERSION = 1
MAX_PAYLOAD_BYTES = 1_048_576
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_SECRET_KEY = re.compile(
    r"(?:authorization|password|passwd|secret|credential|token|(?:access|refresh|api|auth|bearer)[_-]?token|api[_-]?key|environment|headers)",
    re.IGNORECASE,
)
_SECRET_TEXT = re.compile(
    r"(?i)(?:bearer\s+)[A-Za-z0-9._~+/=-]+|\b(?:sk-[A-Za-z0-9_-]{12,}|(?:mat_|mxpc_)[A-Za-z0-9_-]{8,})"
)


class StoreError(RuntimeError):
    """Durable state could not safely be used."""


class ConflictError(StoreError):
    """An identity already has different immutable content."""


class LeaseError(StoreError):
    """Ownership is unavailable, expired, revoked, or fenced."""


class IntegrityError(StoreError):
    """Schema, identity, or evidence does not match the durable record."""


class CursorGapError(StoreError):
    """A source feed omitted a cursor; catch up or record an explicit gap."""


def default_state_root() -> Path:
    return (
        Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
        / "muxdeck/projects"
    )


def _uuid(value: str) -> str:
    try:
        result = str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("project_id must be a UUID") from error
    return result


def _identity(value: str, name: str = "identity") -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 256
        or any(ord(c) < 32 for c in value)
    ):
        raise ValueError(f"{name} must be a nonempty bounded string")
    return value


def _json(value: Any) -> str:
    try:
        data = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ValueError("payload must contain finite JSON values") from error
    if len(data.encode()) > MAX_PAYLOAD_BYTES:
        raise ValueError("payload exceeds journal size limit")
    return data


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _stamp(now: float) -> str:
    return (
        datetime.fromtimestamp(now, UTC)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _private_directory(path: Path) -> None:
    # Only change directories created by this operation; existing unsafe state is
    # rejected rather than silently chmodding an operator-owned/shared location.
    missing: list[Path] = []
    current = path
    while not current.exists() and not current.is_symlink():
        missing.append(current)
        current = current.parent
    for item in reversed(missing):
        try:
            item.mkdir(mode=0o700)
        except FileExistsError:
            pass
    metadata = path.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise IntegrityError(
            "state directory must be owned by this user with mode 0700"
        )
    # Reject symlink ancestors, including links to otherwise private targets.
    if any(item.is_symlink() for item in [path, *path.parents]):
        raise IntegrityError("state path must not traverse symlinks")


def _private_file(path: Path, *, create: bool = False) -> None:
    flags = os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise IntegrityError("state file must be owned by this user with mode 0600")
    finally:
        os.close(descriptor)


def _atomic_file(path: Path, data: bytes) -> None:
    _private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=".muxpilot-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # The caller owns destination creation; never traverse an existing link.
        if path.is_symlink():
            raise IntegrityError("refusing symlink destination")
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class JournalStore:
    """A UUID-scoped journal shared safely by threads and independent processes.

    Supply ``clock`` for deterministic expiry tests. ``secret_values`` are known
    credential sentinels held only in memory; adapter-controlled transcripts
    must pass through this sanitizer. Ambient provider history is not captured.
    """

    def __init__(
        self,
        state_root: Path | str | None,
        project_id: str,
        repo_root: Path | str | None = None,
        *,
        clock: Callable[[], float] = time.time,
        secret_values: tuple[str, ...] = (),
    ) -> None:
        self.project_id = _uuid(project_id)
        self.state_root = (
            Path(state_root or default_state_root()).expanduser().absolute()
        )
        self.project_dir = self.state_root / self.project_id
        self.path = self.project_dir / "journal.sqlite3"
        self._clock = clock
        self._secrets = tuple(value for value in secret_values if value)
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            _private_directory(self.state_root)
            _private_directory(self.project_dir)
            _private_file(self.path, create=True)
            connection = sqlite3.connect(
                self.path, timeout=10, isolation_level=None, check_same_thread=False
            )
            self._connection = connection
            connection.row_factory = sqlite3.Row
            # Check compatibility before schema writes or journal-mode changes.
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise IntegrityError("unsupported Muxpilot journal schema")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise IntegrityError("Muxpilot journal failed integrity check")
            if (
                connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower()
                != "wal"
            ):
                raise IntegrityError("journal filesystem does not support WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=10000")
            with self.transaction() as db:
                if version == 0:
                    self._schema(db)
                else:
                    self._validate_schema(db)
                metadata = db.execute(
                    "SELECT value FROM metadata WHERE key='project_id'"
                ).fetchone()
                if metadata and metadata[0] != self.project_id:
                    raise IntegrityError("journal belongs to another project")
                db.execute(
                    "INSERT OR IGNORE INTO metadata VALUES ('project_id',?)",
                    (self.project_id,),
                )
                if repo_root is not None:
                    canonical = str(Path(repo_root).expanduser().resolve(strict=True))
                    if not Path(canonical).is_dir():
                        raise ValueError("repository root must be a directory")
                    saved = db.execute(
                        "SELECT value FROM metadata WHERE key='repo_root'"
                    ).fetchone()
                    if saved and saved[0] != canonical:
                        raise ConflictError(
                            "project repository differs; use deliberate remap_repository"
                        )
                    db.execute(
                        "INSERT OR IGNORE INTO metadata VALUES ('repo_root',?)",
                        (canonical,),
                    )
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            self._check_aux_permissions()
        except (OSError, sqlite3.Error) as error:
            self.close()
            raise StoreError("Muxpilot journal unavailable") from error
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _schema(db: sqlite3.Connection) -> None:
        # execute one statement at a time: executescript implicitly commits and
        # would split schema/identity initialization across transactions.
        statements = [
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,schema_version INTEGER NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,origin TEXT NOT NULL,occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,generation INTEGER,operation_id TEXT,message_id TEXT,epic_id TEXT,task_id TEXT,run_id TEXT,source TEXT,source_event_id TEXT,source_cursor INTEGER,fingerprint TEXT NOT NULL,artifacts TEXT NOT NULL,UNIQUE(source,source_event_id))",
            "CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END",
            "CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END",
            "CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY,sequence INTEGER NOT NULL CHECK(sequence>=0),version INTEGER NOT NULL,payload TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS source_cursors (source TEXT PRIMARY KEY,cursor INTEGER NOT NULL,event_sequence INTEGER NOT NULL REFERENCES events(sequence))",
            "CREATE TABLE IF NOT EXISTS lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,generation INTEGER NOT NULL,expires_at REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','confirmed','uncertain','rejected')),receipt TEXT,error TEXT,created_sequence INTEGER NOT NULL REFERENCES events(sequence),updated_sequence INTEGER NOT NULL REFERENCES events(sequence))",
            "CREATE TABLE IF NOT EXISTS mappings (kind TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,version INTEGER NOT NULL,event_sequence INTEGER NOT NULL REFERENCES events(sequence),PRIMARY KEY(kind,identity))",
            "CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,sha256 TEXT NOT NULL,byte_count INTEGER NOT NULL,media_type TEXT NOT NULL,base_sha TEXT,run_id TEXT,event_sequence INTEGER NOT NULL REFERENCES events(sequence))",
        ]
        for statement in statements:
            db.execute(statement)

    @staticmethod
    def _validate_schema(db: sqlite3.Connection) -> None:
        required = {
            "metadata": {"key", "value"},
            "events": {
                "sequence",
                "event_id",
                "schema_version",
                "project_id",
                "kind",
                "payload",
                "actor",
                "origin",
                "occurred_at",
                "observed_at",
                "generation",
                "operation_id",
                "message_id",
                "epic_id",
                "task_id",
                "run_id",
                "source",
                "source_event_id",
                "source_cursor",
                "fingerprint",
                "artifacts",
            },
            "checkpoints": {"name", "sequence", "version", "payload"},
            "source_cursors": {"source", "cursor", "event_sequence"},
            "lease": {"singleton", "owner", "generation", "expires_at", "revoked"},
            "operations": {
                "operation_id",
                "kind",
                "payload",
                "fingerprint",
                "owner",
                "generation",
                "state",
                "receipt",
                "error",
                "created_sequence",
                "updated_sequence",
            },
            "mappings": {"kind", "identity", "payload", "version", "event_sequence"},
            "artifacts": {
                "artifact_id",
                "path",
                "sha256",
                "byte_count",
                "media_type",
                "base_sha",
                "run_id",
                "event_sequence",
            },
        }
        for table, columns in required.items():
            actual = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
            if actual != columns:
                raise IntegrityError("journal schema does not match its version")
        triggers = {
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'")
        }
        if not {"events_no_update", "events_no_delete"}.issubset(triggers):
            raise IntegrityError("journal append-only guards are missing")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise IntegrityError("journal contains invalid projection references")

    def sanitize(self, value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                str(key): "[REDACTED]"
                if _SECRET_KEY.search(str(key))
                else self.sanitize(item)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [self.sanitize(item) for item in value]
        if isinstance(value, str):
            result = _SECRET_TEXT.sub("[REDACTED]", value)
            for secret in self._secrets:
                result = result.replace(secret, "[REDACTED]")
            return result
        return value

    def register_secret(self, value: str) -> None:
        """Register a newly issued credential in memory, never in the journal."""
        if not isinstance(value, str) or not value:
            raise ValueError("secret must be a nonempty string")
        with self._lock:
            if value not in self._secrets:
                self._secrets = (*self._secrets, value)

    def _check_aux_permissions(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(self.path) + suffix)
            if path.exists():
                _private_file(path)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            if self._connection is None:
                raise StoreError("Muxpilot journal is closed")
            db = self._connection
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except BaseException as error:
                db.rollback()
                if isinstance(error, sqlite3.Error):
                    raise StoreError("Muxpilot journal transaction failed") from error
                raise

    def _event(
        self,
        db: sqlite3.Connection,
        kind: str,
        payload: dict[str, Any],
        *,
        actor: str = "system",
        origin: str = "muxpilot",
        event_id: str | None = None,
        source: str | None = None,
        source_event_id: str | None = None,
        source_cursor: int | None = None,
        occurred_at: str | None = None,
        generation: int | None = None,
        operation_id: str | None = None,
        message_id: str | None = None,
        epic_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        artifacts: list[str] | None = None,
        _allow_sparse_cursor: bool = False,
    ) -> dict[str, Any]:
        _identity(kind, "event kind")
        _identity(actor, "actor")
        _identity(origin, "origin")
        if not isinstance(payload, dict):
            raise TypeError("event payload must be an object")
        if source_event_id is not None and not source:
            raise ValueError("source_event_id requires source")
        if source_cursor is not None and (
            not source
            or not source_event_id
            or not isinstance(source_cursor, int)
            or isinstance(source_cursor, bool)
            or source_cursor < 1
        ):
            raise ValueError(
                "source cursor requires source identity and positive integer"
            )
        now = _stamp(self._clock())
        sanitized = self.sanitize(payload)
        references = artifacts or []
        for reference in references:
            if not db.execute(
                "SELECT 1 FROM artifacts WHERE artifact_id=?", (reference,)
            ).fetchone():
                raise IntegrityError("event references an unrecorded artifact")
        fingerprint = _hash(
            _json(
                {
                    "kind": kind,
                    "payload": payload,
                    "actor": actor,
                    "origin": origin,
                    "source": source,
                    "source_event_id": source_event_id,
                    "source_cursor": source_cursor,
                    "occurred_at": occurred_at,
                    "generation": generation,
                    "operation_id": operation_id,
                    "message_id": message_id,
                    "epic_id": epic_id,
                    "task_id": task_id,
                    "run_id": run_id,
                    "artifacts": references,
                }
            ).encode()
        )
        event_id = event_id or str(uuid.uuid4())
        _identity(event_id, "event_id")
        existing = db.execute(
            "SELECT * FROM events WHERE event_id=? OR (source=? AND source_event_id=?)",
            (event_id, source, source_event_id),
        ).fetchone()
        if existing:
            if existing["fingerprint"] != fingerprint:
                raise ConflictError("duplicate event identity has different content")
            return self._decode_event(existing)
        if source_cursor is not None:
            current = db.execute(
                "SELECT cursor FROM source_cursors WHERE source=?", (source,)
            ).fetchone()
            expected = current[0] + 1 if current else 1
            if source_cursor != expected and not (
                _allow_sparse_cursor and source_cursor >= expected
            ):
                raise CursorGapError(
                    f"source cursor gap: expected {expected}, received {source_cursor}"
                )
        row = db.execute(
            "INSERT INTO events (event_id,schema_version,project_id,kind,payload,actor,origin,occurred_at,observed_at,generation,operation_id,message_id,epic_id,task_id,run_id,source,source_event_id,source_cursor,fingerprint,artifacts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                event_id,
                SCHEMA_VERSION,
                self.project_id,
                kind,
                _json(sanitized),
                actor,
                origin,
                occurred_at or now,
                now,
                generation,
                operation_id,
                message_id,
                epic_id,
                task_id,
                run_id,
                source,
                source_event_id,
                source_cursor,
                fingerprint,
                _json(references),
            ),
        )
        sequence = row.lastrowid
        if source_cursor is not None:
            db.execute(
                "INSERT INTO source_cursors VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,event_sequence=excluded.event_sequence",
                (source, source_cursor, sequence),
            )
        db.execute(
            "INSERT INTO checkpoints VALUES ('journal',?,1,'{}') ON CONFLICT(name) DO UPDATE SET sequence=excluded.sequence,version=checkpoints.version+1",
            (sequence,),
        )
        return self._decode_event(
            db.execute("SELECT * FROM events WHERE sequence=?", (sequence,)).fetchone()
        )

    @staticmethod
    def _decode_event(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result.pop("fingerprint", None)
        result["payload"] = json.loads(result["payload"])
        result["artifacts"] = json.loads(result["artifacts"])
        return result

    def append_event(
        self, kind: str, payload: dict[str, Any], **metadata: Any
    ) -> dict[str, Any]:
        with self.transaction() as db:
            return self._event(db, kind, payload, **metadata)

    def ingest_events(
        self,
        source: str,
        events: list[dict[str, Any]],
        *,
        previous_cursor: int | None = None,
        page_complete: bool = False,
    ) -> list[dict[str, Any]]:
        """Commit a complete ordered source page and cursor atomically.

        Contiguous cursors are the default. A sparse project-filtered stream
        needs the source to attest that this page contains every scoped event
        after ``previous_cursor``. This declaration cannot recover retention
        gaps: callers must use record_feed_gap for lost source history.
        """
        _identity(source, "source")
        with self.transaction() as db:
            current_row = db.execute(
                "SELECT cursor FROM source_cursors WHERE source=?", (source,)
            ).fetchone()
            current = current_row[0] if current_row else 0
            sparse = page_complete is True and previous_cursor is not None
            if sparse:
                if (
                    not isinstance(previous_cursor, int)
                    or isinstance(previous_cursor, bool)
                    or previous_cursor < 0
                ):
                    raise ValueError("previous cursor must be nonnegative")
                cursors = [event["cursor"] for event in events]
                if any(
                    not isinstance(cursor, int) or isinstance(cursor, bool)
                    for cursor in cursors
                ):
                    raise ValueError("source cursors must be integers")
                if any(cursor <= previous_cursor for cursor in cursors) or any(
                    right <= left for left, right in pairwise(cursors)
                ):
                    raise CursorGapError(
                        "source page is not strictly ordered after its predecessor"
                    )
                replay_only = previous_cursor < current and all(
                    cursor <= current for cursor in cursors
                )
                if previous_cursor != current and not replay_only:
                    raise CursorGapError(
                        "source page predecessor differs from durable cursor"
                    )
            elif previous_cursor is not None or page_complete:
                raise ValueError(
                    "sparse source pages require predecessor and completeness proof"
                )
            return [
                self._event(
                    db,
                    event["kind"],
                    event.get("payload", {}),
                    source=source,
                    source_event_id=event["event_id"],
                    source_cursor=event["cursor"],
                    actor=event.get("actor", source),
                    origin=source,
                    occurred_at=event.get("occurred_at"),
                    operation_id=event.get("operation_id"),
                    task_id=event.get("task_id"),
                    run_id=event.get("run_id"),
                    _allow_sparse_cursor=sparse,
                )
                for event in events
            ]

    def source_cursor(self, source: str) -> int:
        with self.transaction() as db:
            row = db.execute(
                "SELECT cursor FROM source_cursors WHERE source=?", (source,)
            ).fetchone()
            return row[0] if row else 0

    def record_feed_gap(
        self,
        source: str,
        snapshot_cursor: int,
        reason: str,
        snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _identity(source, "source")
        if (
            not isinstance(snapshot_cursor, int)
            or isinstance(snapshot_cursor, bool)
            or snapshot_cursor < 0
        ):
            raise ValueError("snapshot cursor must be nonnegative")
        with self.transaction() as db:
            current = db.execute(
                "SELECT cursor FROM source_cursors WHERE source=?", (source,)
            ).fetchone()
            if current and snapshot_cursor < current[0]:
                raise ConflictError("snapshot watermark cannot regress")
            event = self._event(
                db,
                "audit.gap",
                {
                    "source": source,
                    "previous_cursor": current[0] if current else 0,
                    "snapshot_cursor": snapshot_cursor,
                    "reason": reason,
                    "snapshot": snapshot or {},
                    "coverage": "historical events unavailable; current snapshot only",
                },
            )
            db.execute(
                "INSERT INTO source_cursors VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,event_sequence=excluded.event_sequence",
                (source, snapshot_cursor, event["sequence"]),
            )
            return event

    def events(
        self, after: int = 0, limit: int = 1000, *, watermark: int | None = None
    ) -> list[dict[str, Any]]:
        if after < 0 or not 1 <= limit <= 10000:
            raise ValueError("invalid event range")
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
                (after, watermark if watermark is not None else 2**63 - 1, limit),
            ).fetchall()
            return [self._decode_event(row) for row in rows]

    def checkpoint(self, name: str = "journal") -> dict[str, Any] | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM checkpoints WHERE name=?", (name,)
            ).fetchone()
            return {**dict(row), "payload": json.loads(row["payload"])} if row else None

    def _assert_lease(
        self, db: sqlite3.Connection, owner: str, generation: int
    ) -> dict[str, Any]:
        lease = db.execute("SELECT * FROM lease WHERE singleton=1").fetchone()
        if (
            not lease
            or lease["owner"] != owner
            or lease["generation"] != generation
            or lease["revoked"]
            or lease["expires_at"] <= self._clock()
        ):
            raise LeaseError("coordinator ownership is expired, revoked, or fenced")
        return dict(lease)

    @staticmethod
    def _ttl(ttl: float) -> float:
        if (
            not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or not 0 < ttl <= 3600
        ):
            raise ValueError("lease ttl must be between 0 and 3600 seconds")
        return float(ttl)

    def acquire_lease(self, owner: str, ttl: float = 60) -> dict[str, Any]:
        _identity(owner, "owner")
        ttl = self._ttl(ttl)
        with self.transaction() as db:
            old = db.execute("SELECT * FROM lease WHERE singleton=1").fetchone()
            if old and not old["revoked"] and old["expires_at"] > self._clock():
                if old["owner"] != owner:
                    raise LeaseError("another coordinator owns this project")
                return dict(old)
            generation = old["generation"] + 1 if old else 1
            expires = self._clock() + ttl
            db.execute(
                "INSERT INTO lease VALUES (1,?,?,?,0) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,revoked=0",
                (owner, generation, expires),
            )
            self._event(
                db,
                "coordinator.acquired",
                {"owner": owner, "expires_at": expires},
                actor=owner,
                generation=generation,
            )
            return dict(db.execute("SELECT * FROM lease WHERE singleton=1").fetchone())

    @contextmanager
    def authority_guard(self, owner: str, generation: int) -> Iterator[dict[str, Any]]:
        """Serialize a bounded receiver effect with takeover across processes.

        Lease validity is checked at admission; the write lock prevents a new
        epoch taking ownership while the effect executes. Record journal output
        after leaving the guard: calling store methods within it would nest a
        transaction. This cannot fence an unrelated remote service.
        """
        with self.transaction() as db:
            yield self._assert_lease(db, owner, generation)

    def assert_lease(self, owner: str, generation: int) -> dict[str, Any]:
        with self.transaction() as db:
            return self._assert_lease(db, owner, generation)

    def renew_lease(
        self, owner: str, generation: int, ttl: float = 60
    ) -> dict[str, Any]:
        ttl = self._ttl(ttl)
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            expires = self._clock() + ttl
            db.execute("UPDATE lease SET expires_at=? WHERE singleton=1", (expires,))
            self._event(
                db,
                "coordinator.renewed",
                {"expires_at": expires},
                actor=owner,
                generation=generation,
            )
            return dict(db.execute("SELECT * FROM lease WHERE singleton=1").fetchone())

    def release_lease(self, owner: str, generation: int) -> None:
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            db.execute("UPDATE lease SET revoked=1 WHERE singleton=1")
            self._event(
                db, "coordinator.released", {}, actor=owner, generation=generation
            )

    @staticmethod
    def _decode_operation(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result.pop("fingerprint", None)
        result["payload"] = json.loads(result["payload"])
        result["receipt"] = (
            json.loads(result["receipt"]) if result["receipt"] is not None else None
        )
        return result

    def prepare_operation(
        self,
        operation_id: str,
        kind: str,
        payload: dict[str, Any],
        owner: str,
        generation: int,
    ) -> dict[str, Any]:
        _identity(operation_id, "operation_id")
        fingerprint = _hash(_json({"kind": kind, "payload": payload}).encode())
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            row = db.execute(
                "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
            ).fetchone()
            if row:
                if row["fingerprint"] != fingerprint:
                    raise ConflictError("operation ID already has different intent")
                return self._decode_operation(row)
            event = self._event(
                db,
                "operation.prepared",
                {"kind": kind, "intent": payload},
                actor=owner,
                generation=generation,
                operation_id=operation_id,
            )
            db.execute(
                "INSERT INTO operations VALUES (?,?,?,?,?,?,'prepared',NULL,NULL,?,?)",
                (
                    operation_id,
                    kind,
                    _json(self.sanitize(payload)),
                    fingerprint,
                    owner,
                    generation,
                    event["sequence"],
                    event["sequence"],
                ),
            )
            return self._decode_operation(
                db.execute(
                    "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
                ).fetchone()
            )

    def operation(self, operation_id: str) -> dict[str, Any] | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
            ).fetchone()
            return self._decode_operation(row) if row else None

    get_operation = operation

    def pending_operations(self) -> list[dict[str, Any]]:
        with self.transaction() as db:
            return [
                self._decode_operation(row)
                for row in db.execute(
                    "SELECT * FROM operations WHERE state IN ('prepared','dispatched','uncertain') ORDER BY created_sequence"
                )
            ]

    def _transition(
        self,
        operation_id: str,
        state: str,
        owner: str,
        generation: int,
        *,
        receipt: dict[str, Any] | None = None,
        error: str | None = None,
        reconciliation: bool = False,
    ) -> dict[str, Any]:
        allowed = {
            "prepared": {"dispatched", "rejected", "uncertain"},
            "dispatched": {"confirmed", "rejected", "uncertain"},
            "uncertain": {"confirmed", "rejected"},
            "confirmed": set(),
            "rejected": set(),
        }
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            row = db.execute(
                "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
            ).fetchone()
            if not row:
                raise ConflictError("operation intent does not exist")
            safe_receipt = (
                _json(self.sanitize(receipt)) if receipt is not None else None
            )
            safe_error = self.sanitize(error)
            if row["state"] == state:
                if row["receipt"] != safe_receipt or row["error"] != safe_error:
                    raise ConflictError(
                        "operation result already has different content"
                    )
                return self._decode_operation(row)
            if not reconciliation and (
                row["owner"] != owner or row["generation"] != generation
            ):
                raise LeaseError(
                    "operation belongs to an older epoch; reconcile its outcome"
                )
            permitted_reconciliation = (
                reconciliation
                and row["state"] in {"prepared", "dispatched", "uncertain"}
                and state in {"confirmed", "rejected", "uncertain"}
            )
            if state not in allowed[row["state"]] and not permitted_reconciliation:
                raise ConflictError("invalid operation transition")
            if state == "confirmed" and receipt is None:
                raise ValueError("confirmed operation requires authoritative receipt")
            event = self._event(
                db,
                "operation.reconciled" if reconciliation else f"operation.{state}",
                {
                    "state": state,
                    "receipt": receipt,
                    "error": error,
                    "intent_generation": row["generation"],
                },
                actor=owner,
                generation=generation,
                operation_id=operation_id,
            )
            db.execute(
                "UPDATE operations SET state=?,receipt=?,error=?,updated_sequence=? WHERE operation_id=?",
                (state, safe_receipt, safe_error, event["sequence"], operation_id),
            )
            return self._decode_operation(
                db.execute(
                    "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
                ).fetchone()
            )

    def mark_dispatched(
        self, operation_id: str, owner: str, generation: int
    ) -> dict[str, Any]:
        return self._transition(operation_id, "dispatched", owner, generation)

    def complete_operation(
        self, operation_id: str, receipt: dict[str, Any], owner: str, generation: int
    ) -> dict[str, Any]:
        return self._transition(
            operation_id, "confirmed", owner, generation, receipt=receipt
        )

    def mark_uncertain(
        self, operation_id: str, error: str, owner: str, generation: int
    ) -> dict[str, Any]:
        return self._transition(
            operation_id, "uncertain", owner, generation, error=error
        )

    def reject_operation(
        self, operation_id: str, error: str, owner: str, generation: int
    ) -> dict[str, Any]:
        return self._transition(
            operation_id, "rejected", owner, generation, error=error
        )

    def reconcile_operation(
        self,
        operation_id: str,
        state: str,
        owner: str,
        generation: int,
        *,
        receipt: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        if state not in {"confirmed", "rejected", "uncertain"}:
            raise ValueError("reconciliation must classify authoritative outcome")
        return self._transition(
            operation_id,
            state,
            owner,
            generation,
            receipt=receipt,
            error=error,
            reconciliation=True,
        )

    def commit_decision(
        self,
        owner: str,
        generation: int,
        cursor: int,
        summary: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            high = db.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM events"
            ).fetchone()[0]
            old = db.execute(
                "SELECT * FROM checkpoints WHERE name='inbox_ack'"
            ).fetchone()
            if (
                not isinstance(cursor, int)
                or isinstance(cursor, bool)
                or cursor < (old["sequence"] if old else 0)
                or cursor > high
            ):
                raise ConflictError(
                    "acknowledged cursor is outside delivered durable events"
                )
            event = self._event(
                db,
                "coordinator.decision",
                {
                    "summary": summary,
                    "decision": payload or {},
                    "acknowledged_cursor": cursor,
                },
                actor=owner,
                generation=generation,
            )
            db.execute(
                "INSERT INTO checkpoints VALUES ('inbox_ack',?,1,?) ON CONFLICT(name) DO UPDATE SET sequence=excluded.sequence,version=checkpoints.version+1,payload=excluded.payload",
                (
                    cursor,
                    _json(
                        {
                            "decision_sequence": event["sequence"],
                            "generation": generation,
                        }
                    ),
                ),
            )
            return event

    def put_mapping(
        self,
        kind: str,
        identity: str,
        payload: dict[str, Any],
        owner: str,
        generation: int,
        *,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        _identity(kind, "mapping kind")
        _identity(identity)
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            old = db.execute(
                "SELECT * FROM mappings WHERE kind=? AND identity=?", (kind, identity)
            ).fetchone()
            version = old["version"] if old else 0
            if expected_version is not None and version != expected_version:
                raise ConflictError("mapping version is stale")
            event = self._event(
                db,
                "mapping.updated",
                {
                    "kind": kind,
                    "identity": identity,
                    "value": payload,
                    "version": version + 1,
                },
                actor=owner,
                generation=generation,
            )
            db.execute(
                "INSERT INTO mappings VALUES (?,?,?,?,?) ON CONFLICT(kind,identity) DO UPDATE SET payload=excluded.payload,version=excluded.version,event_sequence=excluded.event_sequence",
                (
                    kind,
                    identity,
                    _json(self.sanitize(payload)),
                    version + 1,
                    event["sequence"],
                ),
            )
            return {
                "kind": kind,
                "identity": identity,
                "payload": self.sanitize(payload),
                "version": version + 1,
                "event_sequence": event["sequence"],
            }

    def get_mapping(self, kind: str, identity: str) -> dict[str, Any] | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM mappings WHERE kind=? AND identity=?", (kind, identity)
            ).fetchone()
            return {**dict(row), "payload": json.loads(row["payload"])} if row else None

    def list_mappings(self, kind: str | None = None) -> list[dict[str, Any]]:
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM mappings WHERE (? IS NULL OR kind=?) ORDER BY kind,identity",
                (kind, kind),
            ).fetchall()
            return [
                {**dict(row), "payload": json.loads(row["payload"])} for row in rows
            ]

    def remap_repository(
        self, repo_root: Path | str, owner: str, generation: int, *, reason: str
    ) -> None:
        canonical = str(Path(repo_root).expanduser().resolve(strict=True))
        if not reason or not Path(canonical).is_dir():
            raise ValueError("repository remap requires directory and reason")
        with self.transaction() as db:
            self._assert_lease(db, owner, generation)
            old = db.execute(
                "SELECT value FROM metadata WHERE key='repo_root'"
            ).fetchone()
            self._event(
                db,
                "project.repository_remapped",
                {
                    "previous": old[0] if old else None,
                    "repo_root": canonical,
                    "reason": reason,
                },
                actor=owner,
                generation=generation,
            )
            db.execute(
                "INSERT INTO metadata VALUES ('repo_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (canonical,),
            )

    def _artifact_path(self, relative_path: str) -> Path:
        relative = Path(relative_path)
        if (
            relative.is_absolute()
            or not relative.parts
            or any(part in {"..", "."} for part in relative.parts)
            or relative.parts[0] not in {"inputs", "runs", "artifacts"}
        ):
            raise ValueError("artifact must be a confined inputs/runs/artifacts path")
        path = self.project_dir / relative
        if any(item.is_symlink() for item in [path, *path.parents]):
            raise IntegrityError("artifact path traverses symlink")
        for directory in path.parents:
            if directory == self.project_dir:
                break
            if directory.exists():
                _private_directory(directory)
        return path

    def write_artifact(
        self,
        relative_path: str,
        data: bytes | str,
        *,
        media_type: str = "application/octet-stream",
        base_sha: str | None = None,
        run_id: str | None = None,
        actor: str = "system",
    ) -> dict[str, Any]:
        path = self._artifact_path(relative_path)
        if not isinstance(data, (str, bytes)):
            raise TypeError("artifact must contain bytes or text")
        if media_type == "application/json":
            text = data.decode("utf-8") if isinstance(data, bytes) else data
            data = _json(self.sanitize(json.loads(text))).encode()
        elif media_type == "application/x-ndjson":
            text = data.decode("utf-8") if isinstance(data, bytes) else data
            data = b"".join(
                (_json(self.sanitize(json.loads(line))) + "\n").encode()
                for line in text.splitlines()
                if line.strip()
            )
        elif isinstance(data, str):
            data = self.sanitize(data).encode()
        elif media_type.startswith("text/"):
            data = self.sanitize(data.decode("utf-8")).encode()
        elif any(secret.encode() in data for secret in self._secrets):
            raise ValueError("binary artifact contains a configured credential")
        if not isinstance(data, bytes) or len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("artifact exceeds size limit or is not bytes")
        digest = _hash(data)
        with self.transaction() as db:
            old = db.execute(
                "SELECT * FROM artifacts WHERE path=?", (relative_path,)
            ).fetchone()
            if old:
                if (
                    old["sha256"] != digest
                    or old["byte_count"] != len(data)
                    or old["base_sha"] != base_sha
                    or old["run_id"] != run_id
                    or old["media_type"] != media_type
                ):
                    raise ConflictError(
                        "artifact path is immutable; use a versioned path"
                    )
                if self._verify_artifact(dict(old))["status"] != "ok":
                    raise IntegrityError("existing artifact is missing or corrupt")
                return dict(old)
            if path.exists():
                _private_file(path)
                if _hash(path.read_bytes()) != digest:
                    raise ConflictError(
                        "unreferenced artifact path contains different bytes"
                    )
            else:
                _atomic_file(path, data)
            artifact_id = str(uuid.uuid4())
            event = self._event(
                db,
                "artifact.recorded",
                {
                    "artifact_id": artifact_id,
                    "path": relative_path,
                    "sha256": digest,
                    "byte_count": len(data),
                    "media_type": media_type,
                    "base_sha": base_sha,
                },
                actor=actor,
                run_id=run_id,
            )
            db.execute(
                "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
                (
                    artifact_id,
                    relative_path,
                    digest,
                    len(data),
                    media_type,
                    base_sha,
                    run_id,
                    event["sequence"],
                ),
            )
            return dict(
                db.execute(
                    "SELECT * FROM artifacts WHERE artifact_id=?", (artifact_id,)
                ).fetchone()
            )

    def _verify_artifact(self, record: dict[str, Any]) -> dict[str, Any]:
        result = dict(record)
        try:
            path = self._artifact_path(record["path"])
            _private_file(path)
            data = path.read_bytes()
            result["status"] = (
                "ok"
                if len(data) == record["byte_count"] and _hash(data) == record["sha256"]
                else "corrupt"
            )
        except FileNotFoundError:
            result["status"] = "missing"
        except (OSError, IntegrityError, ValueError):
            result["status"] = "unavailable"
        return result

    def verify_artifacts(self) -> list[dict[str, Any]]:
        with self.transaction() as db:
            return [
                self._verify_artifact(dict(row))
                for row in db.execute("SELECT * FROM artifacts ORDER BY path")
            ]

    def artifact_inventory(self) -> dict[str, Any]:
        records = self.verify_artifacts()
        referenced = {record["path"] for record in records}
        orphans = []
        for directory in ("inputs", "runs", "artifacts"):
            base = self.project_dir / directory
            if base.exists():
                for path in base.rglob("*"):
                    if path.is_file() or path.is_symlink():
                        relative = path.relative_to(self.project_dir).as_posix()
                        if relative not in referenced:
                            orphans.append(relative)
        return {
            "artifacts": records,
            "orphans": sorted(orphans),
            "complete": all(row["status"] == "ok" for row in records),
        }

    def status(self) -> dict[str, Any]:
        with self.transaction() as db:
            metadata = dict(db.execute("SELECT key,value FROM metadata"))
            lease = db.execute("SELECT * FROM lease WHERE singleton=1").fetchone()
            watermark = db.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM events"
            ).fetchone()[0]
            ack = db.execute(
                "SELECT sequence FROM checkpoints WHERE name='inbox_ack'"
            ).fetchone()
            return {
                "schema_version": SCHEMA_VERSION,
                "project_id": self.project_id,
                "repo_root": metadata.get("repo_root"),
                "event_watermark": watermark,
                "inbox_ack": ack[0] if ack else 0,
                "lease": dict(lease) if lease else None,
                "lease_active": bool(
                    lease
                    and not lease["revoked"]
                    and lease["expires_at"] > self._clock()
                ),
                "source_cursors": {
                    row["source"]: row["cursor"]
                    for row in db.execute("SELECT * FROM source_cursors")
                },
                "pending_operations": [
                    self._decode_operation(row)
                    for row in db.execute(
                        "SELECT * FROM operations WHERE state IN ('prepared','dispatched','uncertain') ORDER BY created_sequence"
                    )
                ],
                "journal_mode": db.execute("PRAGMA journal_mode").fetchone()[0],
                "synchronous": db.execute("PRAGMA synchronous").fetchone()[0],
            }

    def export_audit(self, destination: Path | str | None = None) -> dict[str, Any]:
        """Export one consistent watermark with explicit evidence gaps."""
        target = (
            Path(destination).absolute()
            if destination is not None
            else self.project_dir / "exports" / str(uuid.uuid4())
        )
        if target.exists() or target.is_symlink():
            raise ConflictError("export destination already exists")
        _private_directory(target.parent)
        temporary = Path(tempfile.mkdtemp(prefix=".export-", dir=target.parent))
        try:
            with self.transaction() as db:
                events = [
                    self._decode_event(row)
                    for row in db.execute("SELECT * FROM events ORDER BY sequence")
                ]
                records = [
                    self._verify_artifact(dict(row))
                    for row in db.execute("SELECT * FROM artifacts ORDER BY path")
                ]
                cursors = {
                    row["source"]: row["cursor"]
                    for row in db.execute("SELECT * FROM source_cursors")
                }
                checkpoint = db.execute(
                    "SELECT sequence,version FROM checkpoints WHERE name='journal'"
                ).fetchone()
            watermark = events[-1]["sequence"] if events else 0
            data = b"".join((_json(event) + "\n").encode() for event in events)
            _atomic_file(temporary / "events.jsonl", data)
            gaps = [
                event["sequence"] for event in events if event["kind"] == "audit.gap"
            ]
            missing = [record for record in records if record["status"] != "ok"]
            lines = [
                "# Muxpilot audit",
                "",
                f"Project: {self.project_id}",
                f"Event watermark: {watermark}",
                "",
                "Coverage: structured local/backend events only; provider-native hidden reasoning and unmanaged shell activity are unavailable.",
                "Same-user local journal is not tamper-proof.",
                "",
                f"Incomplete evidence: {len(missing)} artifacts; {len(gaps)} historical feed gaps.",
                "",
                "## Chronology",
                "",
            ]
            for event in events:
                lines.append(
                    f"- {event['sequence']} | {event['occurred_at']} | {event['actor']} | {event['kind']} | operation={event['operation_id'] or '-'} source={event['source_event_id'] or '-'} | {_json(event['payload'])}"
                )
            if missing:
                lines.extend(
                    [
                        "",
                        "## Missing evidence",
                        "",
                        *[
                            f"- {record['path']}: {record['status']}"
                            for record in missing
                        ],
                    ]
                )
            markdown = ("\n".join(lines) + "\n").encode()
            _atomic_file(temporary / "status.md", markdown)
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "project_id": self.project_id,
                "event_watermark": watermark,
                "event_count": len(events),
                "checkpoint": dict(checkpoint) if checkpoint else None,
                "source_cursors": cursors,
                "files": {
                    "events.jsonl": {"sha256": _hash(data), "byte_count": len(data)},
                    "status.md": {
                        "sha256": _hash(markdown),
                        "byte_count": len(markdown),
                    },
                },
                "artifacts": records,
                "audit_gaps": gaps,
                "complete": not missing and not gaps,
                "coverage": {
                    "structured_journal": True,
                    "hidden_reasoning": False,
                    "unmanaged_shell": False,
                    "provider_native_history": False,
                },
            }
            _atomic_file(temporary / "manifest.json", (_json(manifest) + "\n").encode())
            os.rename(temporary, target)
            _sync_directory(target.parent)
            return {"path": str(target), **manifest}
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    def backup(self, destination: Path | str | None = None) -> dict[str, Any]:
        """Snapshot committed WAL data and immutable referenced artifacts."""
        target = (
            Path(destination).absolute()
            if destination is not None
            else self.project_dir / "backups" / str(uuid.uuid4())
        )
        if target.exists() or target.is_symlink():
            raise ConflictError("backup destination already exists")
        _private_directory(target.parent)
        temporary = Path(tempfile.mkdtemp(prefix=".backup-", dir=target.parent))
        try:
            backup_path = temporary / "journal.sqlite3"
            _private_file(backup_path, create=True)
            # Separate connection prevents backup on an active write transaction.
            with self._lock:
                if self._connection is None:
                    raise StoreError("journal is closed")
                source = sqlite3.connect(self.path)
                copy = sqlite3.connect(backup_path)
                try:
                    source.backup(copy)
                    if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise IntegrityError("backup database integrity failed")
                    copy.row_factory = sqlite3.Row
                    records = [
                        dict(row)
                        for row in copy.execute("SELECT * FROM artifacts ORDER BY path")
                    ]
                    watermark = copy.execute(
                        "SELECT COALESCE(MAX(sequence),0) FROM events"
                    ).fetchone()[0]
                finally:
                    copy.close()
                    source.close()
            inventory = []
            for record in records:
                checked = self._verify_artifact(record)
                inventory.append(checked)
                if checked["status"] != "ok":
                    raise IntegrityError(
                        "backup cannot certify missing or corrupt artifact"
                    )
                data = self._artifact_path(record["path"]).read_bytes()
                if _hash(data) != record["sha256"] or len(data) != record["byte_count"]:
                    raise IntegrityError("artifact changed during backup")
                _atomic_file(temporary / record["path"], data)
            with backup_path.open("rb") as stream:
                os.fsync(stream.fileno())
            database_data = backup_path.read_bytes()
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "project_id": self.project_id,
                "event_watermark": watermark,
                "database": {
                    "path": "journal.sqlite3",
                    "sha256": _hash(database_data),
                    "byte_count": len(database_data),
                },
                "artifacts": inventory,
                "restore_requires_external_reconciliation": True,
            }
            _atomic_file(temporary / "manifest.json", (_json(manifest) + "\n").encode())
            os.rename(temporary, target)
            _sync_directory(target.parent)
            return {"path": str(target), **manifest}
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    @classmethod
    def restore(cls, backup_dir: Path | str, state_root: Path | str) -> JournalStore:
        """Restore into a new project location, with lease revoked for recovery."""
        backup = Path(backup_dir).absolute()
        _private_directory(backup)
        _private_file(backup / "manifest.json")
        try:
            manifest = json.loads((backup / "manifest.json").read_text())
            if manifest["schema_version"] != SCHEMA_VERSION:
                raise IntegrityError("unsupported backup schema")
            project_id = _uuid(manifest["project_id"])
            database = manifest["database"]
            if database["path"] != "journal.sqlite3":
                raise IntegrityError("invalid backup database path")
            _private_file(backup / "journal.sqlite3")
            data = (backup / "journal.sqlite3").read_bytes()
            if _hash(data) != database["sha256"] or len(data) != database["byte_count"]:
                raise IntegrityError("backup database hash mismatch")
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise IntegrityError("invalid backup manifest") from error
        root = Path(state_root).absolute()
        _private_directory(root)
        target = root / project_id
        if target.exists() or target.is_symlink():
            raise ConflictError("restore destination already exists")
        temporary = Path(tempfile.mkdtemp(prefix=".restore-", dir=root))
        store = None
        try:
            _atomic_file(temporary / "journal.sqlite3", data)
            with sqlite3.connect(temporary / "journal.sqlite3") as db:
                db.row_factory = sqlite3.Row
                if (
                    db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION
                    or db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                ):
                    raise IntegrityError("backup database schema/integrity mismatch")
                identity = db.execute(
                    "SELECT value FROM metadata WHERE key='project_id'"
                ).fetchone()
                records = [
                    dict(row)
                    for row in db.execute("SELECT * FROM artifacts ORDER BY path")
                ]
                if (
                    not identity
                    or identity[0] != project_id
                    or db.execute("PRAGMA foreign_key_check").fetchone()
                ):
                    raise IntegrityError("backup project identity/reference mismatch")
                if records != [
                    {key: value for key, value in record.items() if key != "status"}
                    for record in manifest["artifacts"]
                ]:
                    raise IntegrityError(
                        "backup artifact manifest differs from journal"
                    )
                db.execute("UPDATE lease SET revoked=1")
            for record in records:
                relative = Path(record["path"])
                if (
                    relative.is_absolute()
                    or ".." in relative.parts
                    or not relative.parts
                    or relative.parts[0] not in {"inputs", "runs", "artifacts"}
                ):
                    raise IntegrityError("invalid backup artifact path")
                source = backup / relative
                if any(item.is_symlink() for item in [source, *source.parents]):
                    raise IntegrityError("backup artifact traverses symlink")
                _private_file(source)
                artifact = source.read_bytes()
                if (
                    _hash(artifact) != record["sha256"]
                    or len(artifact) != record["byte_count"]
                ):
                    raise IntegrityError("backup artifact hash mismatch")
                _atomic_file(temporary / relative, artifact)
            os.rename(temporary, target)
            _sync_directory(root)
            store = cls(root, project_id)
            store.append_event(
                "project.restored",
                {
                    "backup_watermark": manifest["event_watermark"],
                    "external_reconciliation_required": True,
                },
            )
            return store
        except BaseException:
            if store:
                store.close()
            shutil.rmtree(temporary, ignore_errors=True)
            # A published directory is retained for diagnosis, never deleted as
            # a recovery shortcut after another process could have opened it.
            raise

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
