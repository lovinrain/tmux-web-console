"""Durable launch receipts: retries cannot silently start a second process."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MAX_LAUNCH_REQUESTS = 100_000
_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class LaunchRequestConflictError(RuntimeError):
    pass


class LaunchRequestUncertainError(RuntimeError):
    pass


class LaunchRequestUnavailableError(RuntimeError):
    pass


class LaunchRequestFailedError(RuntimeError):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def validate_request_id(value: str) -> str:
    if not isinstance(value, str) or not _REQUEST_ID.fullmatch(value):
        raise ValueError("requestId must contain 1-128 letters, digits, '_' or '-'")
    return value


class LaunchRequestStore:
    """A pending reservation stays uncertain across restart rather than rerunning.

    Only a request fingerprint and receipt are retained. Command arguments and
    environment values are never written to this database. Reservations have no
    expiry: expiring a key would make a sufficiently late retry unsafe.
    """

    def __init__(self, path: Path) -> None:
        self.path = path.expanduser()
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                metadata = os.fstat(fd)
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_uid != os.geteuid()
                    or stat.S_IMODE(metadata.st_mode) & 0o077
                ):
                    raise OSError("launch request database is not a private regular file")
            finally:
                os.close(fd)
            self._connection = sqlite3.connect(
                self.path, timeout=5.0, check_same_thread=False
            )
            self._connection.row_factory = sqlite3.Row
            with self._transaction() as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise sqlite3.DatabaseError("unsupported launch request schema")
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS launch_requests (
                        request_id TEXT PRIMARY KEY,
                        fingerprint TEXT NOT NULL,
                        state TEXT NOT NULL CHECK(state IN ('pending', 'complete', 'failed')),
                        response TEXT,
                        failure_status INTEGER,
                        failure_message TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                """)
                connection.execute("PRAGMA user_version = 1")
        except (OSError, sqlite3.Error, LaunchRequestUnavailableError) as error:
            self.close()
            raise LaunchRequestUnavailableError("launch request storage unavailable") from error

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = self._connection
            if connection is None:
                raise LaunchRequestUnavailableError("launch request storage unavailable")
            try:
                connection.execute("BEGIN IMMEDIATE")
                with connection:
                    yield connection
            except sqlite3.Error as error:
                raise LaunchRequestUnavailableError("launch request storage unavailable") from error

    def reserve(self, request_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        validate_request_id(request_id)
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM launch_requests WHERE request_id = ?", (request_id,)
            ).fetchone()
            if row is not None:
                if row["fingerprint"] != fingerprint:
                    raise LaunchRequestConflictError(
                        "requestId was already used for a different launch"
                    )
                if row["state"] == "complete":
                    try:
                        response = json.loads(row["response"])
                    except (TypeError, ValueError) as error:
                        raise LaunchRequestUnavailableError(
                            "launch request receipt is unreadable"
                        ) from error
                    if not isinstance(response, dict):
                        raise LaunchRequestUnavailableError("invalid launch request receipt")
                    return response
                if row["state"] == "failed":
                    raise LaunchRequestFailedError(row["failure_message"], row["failure_status"])
                raise LaunchRequestUncertainError(
                    "launch outcome is uncertain; inspect sessions before deciding how to recover"
                )
            count = connection.execute("SELECT COUNT(*) FROM launch_requests").fetchone()[0]
            if count >= MAX_LAUNCH_REQUESTS:
                raise LaunchRequestUnavailableError("launch request storage is full")
            now = time.time_ns() // 1_000_000
            connection.execute(
                "INSERT INTO launch_requests VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, ?)",
                (request_id, fingerprint, now, now),
            )
        return None

    def complete(self, request_id: str, response: dict[str, Any]) -> None:
        with self._transaction() as connection:
            result = connection.execute(
                "UPDATE launch_requests SET state='complete', response=?, updated_at=? "
                "WHERE request_id=? AND state='pending'",
                (json.dumps(response, ensure_ascii=True), time.time_ns() // 1_000_000, request_id),
            )
            if result.rowcount != 1:
                raise LaunchRequestConflictError("launch reservation is no longer pending")

    def fail(self, request_id: str, *, status: int, error: str) -> None:
        if not 400 <= status <= 599:
            raise ValueError("launch failure status must be an HTTP error")
        with self._transaction() as connection:
            result = connection.execute(
                "UPDATE launch_requests SET state='failed', failure_status=?, "
                "failure_message=?, updated_at=? WHERE request_id=? AND state='pending'",
                (status, error, time.time_ns() // 1_000_000, request_id),
            )
            if result.rowcount != 1:
                raise LaunchRequestConflictError("launch reservation is no longer pending")

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
