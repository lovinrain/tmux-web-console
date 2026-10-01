import hashlib
import sqlite3
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from muxpilot.store import (
    SCHEMA_VERSION,
    ConflictError,
    CursorGapError,
    IntegrityError,
    JournalStore,
    LeaseError,
    StoreError,
)


@pytest.fixture
def project_id() -> str:
    return str(uuid.uuid4())


@pytest.fixture
def store(tmp_path: Path, project_id: str):
    journal = JournalStore(tmp_path / "projects", project_id, tmp_path)
    yield journal
    journal.close()


def test_private_wal_full_schema_and_stable_repository(store, tmp_path, project_id):
    status = store.status()
    assert status["journal_mode"] == "wal"
    assert status["synchronous"] == 2
    assert status["schema_version"] == SCHEMA_VERSION
    for path in (store.state_root, store.project_dir):
        assert path.stat().st_mode & 0o777 == 0o700
    for suffix in ("", "-wal", "-shm"):
        assert Path(str(store.path) + suffix).stat().st_mode & 0o777 == 0o600
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ConflictError, match="remap"):
        JournalStore(store.state_root, project_id, other)
    lease = store.acquire_lease("lead")
    store.remap_repository(
        other, "lead", lease["generation"], reason="operator moved repo"
    )
    reopened = JournalStore(store.state_root, project_id, other)
    assert reopened.status()["repo_root"] == str(other)
    reopened.close()


def test_event_dedup_conflict_and_append_only_sql_guard(store):
    event = store.append_event(
        "input.accepted", {"goal": "test"}, event_id="input-1", actor="human"
    )
    assert (
        store.append_event(
            "input.accepted", {"goal": "test"}, event_id="input-1", actor="human"
        )
        == event
    )
    with pytest.raises(ConflictError):
        store.append_event(
            "input.accepted", {"goal": "changed"}, event_id="input-1", actor="human"
        )
    assert store.checkpoint()["sequence"] == event["sequence"]
    for statement in ("DELETE FROM events", "UPDATE events SET kind='forged'"):
        with pytest.raises(StoreError), store.transaction() as db:
            db.execute(statement)
    assert len(store.events()) == 1


def test_event_projection_transaction_rolls_back_on_failure(store):
    with pytest.raises(RuntimeError), store.transaction() as db:
        store._event(db, "test.intent", {})
        db.execute("INSERT INTO metadata VALUES ('projection','before-crash')")
        raise RuntimeError("injected before commit")
    assert store.events() == []
    assert store.checkpoint() is None
    with store.transaction() as db:
        assert (
            db.execute("SELECT value FROM metadata WHERE key='projection'").fetchone()
            is None
        )


def source_events(*cursors):
    return [
        {
            "event_id": f"backend-{cursor}",
            "cursor": cursor,
            "kind": "human.edit",
            "payload": {"version": cursor},
            "actor": "human-1",
            "occurred_at": "2026-01-01T00:00:00Z",
        }
        for cursor in cursors
    ]


def test_ingest_page_cursor_and_dedup_atomicity(store):
    first = store.ingest_events("multica", source_events(1, 2))
    assert store.source_cursor("multica") == 2
    assert store.ingest_events("multica", source_events(1, 2)) == first
    with pytest.raises(CursorGapError):
        store.ingest_events("multica", source_events(3, 5))
    assert store.source_cursor("multica") == 2
    assert len(store.events()) == 2
    changed = source_events(2)
    changed[0]["payload"] = {"version": "forged"}
    with pytest.raises(ConflictError):
        store.ingest_events("multica", changed)
    gap = store.record_feed_gap(
        "multica", 5, "backend retention expired", {"task_state": "running"}
    )
    assert gap["kind"] == "audit.gap"
    store.ingest_events("multica", source_events(6))
    assert store.source_cursor("multica") == 6
    assert not store.export_audit()["complete"]


def test_lease_expiry_fences_old_owner_and_preserves_uncertain_intent(
    tmp_path, project_id
):
    clock = [1000.0]
    store = JournalStore(tmp_path / "projects", project_id, clock=lambda: clock[0])
    first = store.acquire_lease("one", ttl=5)
    store.prepare_operation(
        "launch",
        "worker.launch",
        {"execution_id": "execution-1"},
        "one",
        first["generation"],
    )
    store.mark_dispatched("launch", "one", first["generation"])
    with pytest.raises(LeaseError):
        store.acquire_lease("two")
    clock[0] += 5
    for operation in (
        lambda: store.renew_lease("one", 1),
        lambda: store.complete_operation("launch", {"run_id": "run-1"}, "one", 1),
    ):
        with pytest.raises(LeaseError):
            operation()
    second = store.acquire_lease("two")
    assert second["generation"] == 2
    with pytest.raises(LeaseError, match="reconcile"):
        store.mark_uncertain("launch", "lost reply", "two", 2)
    result = store.reconcile_operation(
        "launch", "confirmed", "two", 2, receipt={"run_id": "run-1", "recovered": True}
    )
    assert result["generation"] == 1  # immutable original intent epoch
    assert result["receipt"]["run_id"] == "run-1"
    store.close()


def test_operation_idempotency_receipts_and_rejected_transition(store):
    lease = store.acquire_lease("lead")
    generation = lease["generation"]
    payload = {"execution_id": "execution-1"}
    original = store.prepare_operation(
        "launch", "worker.launch", payload, "lead", generation
    )
    assert (
        store.prepare_operation("launch", "worker.launch", payload, "lead", generation)
        == original
    )
    with pytest.raises(ConflictError):
        store.prepare_operation(
            "launch", "worker.launch", {"execution_id": "other"}, "lead", generation
        )
    with pytest.raises(ConflictError):
        store.complete_operation("launch", {}, "lead", generation)
    store.mark_dispatched("launch", "lead", generation)
    store.mark_uncertain("launch", "timeout, outcome unknown", "lead", generation)
    assert store.pending_operations()[0]["state"] == "uncertain"
    with pytest.raises(ConflictError):
        store.mark_dispatched("launch", "lead", generation)
    receipt = {"run_id": "run-1", "execution_id": "execution-1"}
    confirmed = store.complete_operation("launch", receipt, "lead", generation)
    assert store.complete_operation("launch", receipt, "lead", generation) == confirmed
    assert store.pending_operations() == []
    with pytest.raises(ConflictError):
        store.complete_operation("launch", {"run_id": "different"}, "lead", generation)


def test_decision_and_ack_commit_together_without_regression(store):
    lease = store.acquire_lease("lead")
    event = store.append_event("worker.result", {"state": "needs_verification"})
    decision = store.commit_decision(
        "lead",
        lease["generation"],
        event["sequence"],
        "Inspect the commit before accepting",
    )
    checkpoint = store.checkpoint("inbox_ack")
    assert checkpoint["sequence"] == event["sequence"]
    assert checkpoint["payload"]["decision_sequence"] == decision["sequence"]
    count = len(store.events())
    for invalid in (0, decision["sequence"] + 100):
        with pytest.raises(ConflictError):
            store.commit_decision("lead", 1, invalid, "invalid ack")
    assert len(store.events()) == count


def test_mapping_optimistic_version_and_fence(store):
    lease = store.acquire_lease("lead")
    mapping = store.put_mapping(
        "run",
        "run-1",
        {"task_id": "task-1", "session_identity": "$1:server-1"},
        "lead",
        1,
        expected_version=0,
    )
    assert mapping["version"] == 1
    with pytest.raises(ConflictError):
        store.put_mapping("run", "run-1", {}, "lead", 1, expected_version=0)
    assert store.get_mapping("run", "run-1") == mapping
    store.release_lease("lead", lease["generation"])
    with pytest.raises(LeaseError):
        store.put_mapping("run", "run-2", {}, "lead", 1)
    assert store.list_mappings("run") == [mapping]


def test_concurrent_process_connections_dedup_one_intent(tmp_path, project_id):
    stores = [JournalStore(tmp_path / "projects", project_id) for _ in range(2)]
    lease = stores[0].acquire_lease("lead")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda store: store.prepare_operation(
                    "shared", "launch", {}, "lead", lease["generation"]
                ),
                stores,
            )
        )
    assert results[0] == results[1]
    assert [event["kind"] for event in stores[0].events()].count(
        "operation.prepared"
    ) == 1
    for store in stores:
        store.close()


def test_receiver_guard_serializes_takeover_at_effect_admission(tmp_path, project_id):
    clock = [100.0]
    first = JournalStore(tmp_path / "projects", project_id, clock=lambda: clock[0])
    second = JournalStore(tmp_path / "projects", project_id, clock=lambda: clock[0])
    first.acquire_lease("first", ttl=1)
    admitted = threading.Event()
    attempted = threading.Event()
    complete = threading.Event()
    release = threading.Event()

    def effect():
        with first.authority_guard("first", 1):
            admitted.set()
            assert release.wait(5)

    def takeover():
        assert admitted.wait(5)
        clock[0] = 102.0
        attempted.set()
        lease = second.acquire_lease("second")
        complete.set()
        return lease

    with ThreadPoolExecutor(max_workers=2) as pool:
        work = pool.submit(effect)
        replacement = pool.submit(takeover)
        assert attempted.wait(5)
        assert not complete.is_set()
        release.set()
        work.result(timeout=5)
        assert replacement.result(timeout=5)["generation"] == 2
    with pytest.raises(LeaseError), first.authority_guard("first", 1):
        pytest.fail("stale external effect executed")
    first.close()
    second.close()


def test_artifacts_atomic_immutable_and_missing_corrupt_evidence(store):
    record = store.write_artifact(
        "runs/run-1/result-v1.md",
        "verified result",
        media_type="text/markdown",
        run_id="run-1",
        base_sha="a" * 40,
    )
    assert (
        store.write_artifact(
            "runs/run-1/result-v1.md",
            "verified result",
            media_type="text/markdown",
            run_id="run-1",
            base_sha="a" * 40,
        )
        == record
    )
    store.append_event(
        "worker.result", {"run_id": "run-1"}, artifacts=[record["artifact_id"]]
    )
    with pytest.raises(ConflictError):
        store.write_artifact("runs/run-1/result-v1.md", "changed")
    with pytest.raises(IntegrityError):
        store.append_event("worker.result", {}, artifacts=["unknown"])
    path = store.project_dir / record["path"]
    assert path.stat().st_mode & 0o777 == 0o600
    path.write_text("tampered")
    assert store.verify_artifacts()[0]["status"] == "corrupt"
    with pytest.raises(IntegrityError):
        store.backup()
    path.unlink()
    assert store.verify_artifacts()[0]["status"] == "missing"
    export = store.export_audit()
    assert export["complete"] is False
    assert "missing" in (Path(export["path"]) / "status.md").read_text()


def test_artifact_reference_failure_leaves_visible_recoverable_orphan(
    store, monkeypatch
):
    original = store._event

    def failure(*args, **kwargs):
        raise RuntimeError("crash after file write before reference")

    monkeypatch.setattr(store, "_event", failure)
    with pytest.raises(RuntimeError):
        store.write_artifact("runs/run-1/result.md", "orphan")
    assert store.verify_artifacts() == []
    assert store.artifact_inventory()["orphans"] == ["runs/run-1/result.md"]
    monkeypatch.setattr(store, "_event", original)
    assert store.write_artifact("runs/run-1/result.md", "orphan")["byte_count"] == 6
    assert store.artifact_inventory()["orphans"] == []


def test_artifact_paths_and_state_symlinks_are_rejected(store, tmp_path, project_id):
    for path in ("../outside", "/tmp/outside", "journal.sqlite3", "runs/../../outside"):
        with pytest.raises(ValueError):
            store.write_artifact(path, "unsafe")
    (store.project_dir / "runs").symlink_to(tmp_path)
    with pytest.raises(IntegrityError):
        store.write_artifact("runs/outside", "unsafe")
    alias = tmp_path / "alias"
    alias.symlink_to(store.state_root)
    with pytest.raises(IntegrityError):
        JournalStore(alias, project_id)


def test_redaction_export_determinism_and_hashes(tmp_path, project_id):
    secret = "synthetic-private-sentinel"
    store = JournalStore(tmp_path / "projects", project_id, secret_values=(secret,))
    store.append_event(
        "human.input",
        {
            "authorization": "Bearer raw-token",
            "nested": {"api_key": secret},
            "message": f"failed with {secret}",
        },
    )
    store.write_artifact(
        "inputs/brief-0001.md", f"Goal with {secret}", media_type="text/markdown"
    )
    exports = [store.export_audit() for _ in range(2)]
    for name in ("events.jsonl", "status.md", "manifest.json"):
        files = [(Path(export["path"]) / name).read_bytes() for export in exports]
        assert files[0] == files[1]
        assert secret.encode() not in files[0]
        assert b"raw-token" not in files[0]
    for name, expected in exports[0]["files"].items():
        data = (Path(exports[0]["path"]) / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == expected["sha256"]
    store.close()
    assert secret.encode() not in store.path.read_bytes()


def test_export_failure_is_retryable_without_journal_damage(store, monkeypatch):
    store.append_event("input", {"goal": "unchanged"})
    import muxpilot.store as module

    original = module._atomic_file

    def denied(*args):
        raise PermissionError("synthetic export denial")

    monkeypatch.setattr(module, "_atomic_file", denied)
    with pytest.raises(PermissionError):
        store.export_audit()
    assert len(store.events()) == 1
    monkeypatch.setattr(module, "_atomic_file", original)
    assert store.export_audit()["event_count"] == 1


def test_backup_with_wal_restores_artifacts_and_revokes_ownership(store, tmp_path):
    store.acquire_lease("lead")
    store.append_event("goal", {"description": "complete"})
    store.write_artifact(
        "inputs/brief-0001.md", "goal evidence", media_type="text/markdown"
    )
    backup = store.backup()
    store.append_event("after.backup", {})
    restored = JournalStore.restore(backup["path"], tmp_path / "restored")
    assert restored.status()["event_watermark"] == backup["event_watermark"] + 1
    assert restored.events()[-1]["kind"] == "project.restored"
    assert restored.verify_artifacts()[0]["status"] == "ok"
    assert restored.status()["lease_active"] is False
    with pytest.raises(LeaseError):
        restored.assert_lease("lead", 1)
    assert restored.acquire_lease("replacement")["generation"] == 2
    with pytest.raises(ConflictError):
        JournalStore.restore(backup["path"], tmp_path / "restored")
    restored.close()
    artifact = Path(backup["path"]) / "inputs/brief-0001.md"
    artifact.write_text("corrupted backup")
    with pytest.raises(IntegrityError, match="hash mismatch"):
        JournalStore.restore(backup["path"], tmp_path / "bad-restore")
    assert not (tmp_path / "bad-restore" / store.project_id).exists()


def test_future_schema_corruption_and_unsafe_permissions_are_not_repaired(
    tmp_path, project_id
):
    root = tmp_path / "projects"
    store = JournalStore(root, project_id)
    path = store.path
    store.close()
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=99")
    before = path.read_bytes()
    with pytest.raises(IntegrityError, match="unsupported"):
        JournalStore(root, project_id)
    assert path.read_bytes() == before
    path.write_bytes(b"not a database")
    with pytest.raises(StoreError):
        JournalStore(root, project_id)
    assert path.read_bytes() == b"not a database"
    path.chmod(0o644)
    with pytest.raises(IntegrityError, match="0600"):
        JournalStore(root, project_id)
    assert path.stat().st_mode & 0o777 == 0o644


def test_process_crash_preserves_committed_wal_and_discards_open_transaction(
    tmp_path, project_id
):
    root = tmp_path / "projects"
    child = """
import os, sys
from muxpilot.store import JournalStore
store = JournalStore(sys.argv[1], sys.argv[2])
store.append_event("committed", {"intent": "retained"})
with store.transaction() as db:
    store._event(db, "uncommitted", {})
    os._exit(23)
"""
    result = subprocess.run(
        [sys.executable, "-c", child, str(root), project_id],
        check=False,
        capture_output=True,
    )
    assert result.returncode == 23, result.stderr.decode()
    store = JournalStore(root, project_id)
    assert [event["kind"] for event in store.events()] == ["committed"]
    assert store.checkpoint()["sequence"] == 1
    assert store.status()["event_watermark"] == 1
    store.close()


def test_sparse_source_page_requires_authoritative_predecessor_and_completeness(store):
    page = source_events(4, 9)
    with pytest.raises(CursorGapError):
        store.ingest_events("multica", page)
    accepted = store.ingest_events(
        "multica", page, previous_cursor=0, page_complete=True
    )
    assert store.source_cursor("multica") == 9
    assert (
        store.ingest_events("multica", page, previous_cursor=0, page_complete=True)
        == accepted
    )
    with pytest.raises(CursorGapError):
        store.ingest_events(
            "multica", source_events(13), previous_cursor=4, page_complete=True
        )
    with pytest.raises(CursorGapError):
        store.ingest_events(
            "multica", source_events(17, 13), previous_cursor=9, page_complete=True
        )
    assert store.source_cursor("multica") == 9
    store.ingest_events(
        "multica", source_events(13), previous_cursor=9, page_complete=True
    )
    assert store.source_cursor("multica") == 13


def test_zero_cursor_decision_and_schema_damage_detection(store, project_id):
    store.acquire_lease("lead")
    store.commit_decision("lead", 1, 0, "No inbox events consumed yet")
    assert store.status()["inbox_ack"] == 0
    path = store.path
    root = store.state_root
    store.close()
    with sqlite3.connect(path) as db:
        db.execute("DROP TRIGGER events_no_delete")
    with pytest.raises(IntegrityError, match="append-only"):
        JournalStore(root, project_id)


def test_scoped_tokens_newly_issued_secrets_and_json_artifacts_are_redacted(store):
    scoped = "mxpc_" + "syntheticcredential" * 2
    opaque = "opaque-after-opening-credential"
    store.register_secret(opaque)
    event = store.append_event(
        "instruction", {"token": "plain-secret", "text": f"{scoped} {opaque}"}
    )
    assert event["payload"]["token"] == "[REDACTED]"
    assert event["payload"]["text"] == "[REDACTED] [REDACTED]"
    store.write_artifact(
        "runs/r/result.json",
        b'{"token":"plain-secret","safe":"record"}',
        media_type="application/json",
    )
    assert (
        b"plain-secret" not in (store.project_dir / "runs/r/result.json").read_bytes()
    )
    with pytest.raises(ValueError, match="credential"):
        store.write_artifact("artifacts/binary.dat", b"binary:" + opaque.encode())
