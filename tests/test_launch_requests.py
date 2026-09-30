import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from tmux_console.launch_requests import (
    LaunchRequestConflictError,
    LaunchRequestFailedError,
    LaunchRequestStore,
    LaunchRequestUnavailableError,
    LaunchRequestUncertainError,
    validate_request_id,
)


def test_receipt_survives_restart_and_never_retains_launch_secrets(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    payload = {"command": ["agent", "secret-prompt"], "environment": {"TOKEN": "private-value"}}
    store = LaunchRequestStore(path)
    assert store.reserve("launch-1", payload) is None
    receipt = {"session": "worker", "identity": "$1:10:9:123", "paneId": "%1"}
    store.complete("launch-1", receipt)
    store.close()
    reopened = LaunchRequestStore(path)
    assert reopened.reserve("launch-1", payload) == receipt
    with pytest.raises(LaunchRequestConflictError):
        reopened.reserve("launch-1", {"command": ["different"]})
    reopened.close()
    assert path.stat().st_mode & 0o777 == 0o600
    assert b"secret-prompt" not in path.read_bytes()
    assert b"private-value" not in path.read_bytes()


def test_pending_launch_remains_uncertain_after_restart(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    store = LaunchRequestStore(path)
    store.reserve("crash-window", {"name": "worker"})
    store.close()
    reopened = LaunchRequestStore(path)
    with pytest.raises(LaunchRequestUncertainError, match="inspect sessions"):
        reopened.reserve("crash-window", {"name": "worker"})
    reopened.close()


def test_definite_failure_replays_original_status(tmp_path: Path) -> None:
    store = LaunchRequestStore(tmp_path / "launches.sqlite3")
    store.reserve("failed", {})
    store.fail("failed", status=409, error="session already exists")
    with pytest.raises(LaunchRequestFailedError) as caught:
        store.reserve("failed", {})
    assert caught.value.status == 409
    assert caught.value.message == "session already exists"
    with pytest.raises(LaunchRequestConflictError):
        store.complete("failed", {"session": "other"})
    store.close()


def test_concurrent_connections_reserve_once(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    stores = [LaunchRequestStore(path), LaunchRequestStore(path)]

    def reserve(store: LaunchRequestStore) -> str:
        try:
            assert store.reserve("concurrent", {}) is None
            return "reserved"
        except LaunchRequestUncertainError:
            return "uncertain"

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reserve, stores)) == ["reserved", "uncertain"]
    for store in stores:
        store.close()


def test_storage_refuses_future_schema_without_rewriting(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 99")
    path.chmod(0o600)
    before = path.read_bytes()
    with pytest.raises(LaunchRequestUnavailableError):
        LaunchRequestStore(path)
    assert path.read_bytes() == before


def test_storage_refuses_symlink_and_public_file(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    store = LaunchRequestStore(path)
    store.close()
    link = tmp_path / "link.sqlite3"
    link.symlink_to(path)
    with pytest.raises(LaunchRequestUnavailableError):
        LaunchRequestStore(link)
    path.chmod(0o644)
    with pytest.raises(LaunchRequestUnavailableError):
        LaunchRequestStore(path)


def test_capacity_does_not_evict_old_idempotency_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tmux_console.launch_requests.MAX_LAUNCH_REQUESTS", 1)
    store = LaunchRequestStore(tmp_path / "launches.sqlite3")
    store.reserve("old", {})
    store.complete("old", {"session": "worker"})
    with pytest.raises(LaunchRequestUnavailableError, match="full"):
        store.reserve("new", {})
    assert store.reserve("old", {}) == {"session": "worker"}
    store.close()


@pytest.mark.parametrize("value", ["", "../escape", "a" * 129, "space name", 1, None])
def test_request_id_validation(value: object) -> None:
    with pytest.raises(ValueError):
        validate_request_id(value)  # type: ignore[arg-type]


def test_corrupt_receipt_is_unavailable_instead_of_relaunching(tmp_path: Path) -> None:
    path = tmp_path / "launches.sqlite3"
    store = LaunchRequestStore(path)
    store.reserve("receipt", {})
    store.complete("receipt", {"session": "worker"})
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE launch_requests SET response = ?", (json.dumps([]),))
    with pytest.raises(LaunchRequestUnavailableError):
        store.reserve("receipt", {})
    store.close()
