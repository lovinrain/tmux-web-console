"""Deterministic fault boundaries over real controller/journal/HTTP transport.

The receiver is a synthetic authoritative backend with disk-persisted receipts.
It creates run records, not provider processes. Provider, daemon and tmux lifetime
claims belong to the separate isolated end-to-end tests and qualification gates.
"""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from muxpilot.config import Config, private_read, private_write
from muxpilot.multica import MulticaClient, MulticaError
from muxpilot.project import ProjectController, ProjectError
from muxpilot.store import (
    ConflictError,
    CursorGapError,
    JournalStore,
    LeaseError,
    StoreError,
)


class CrashBoundary(BaseException):
    """An abrupt boundary bypasses normal exception receipt handling."""


class AuthoritativeBackend:
    """Receiver persists acceptance before replying; restarts reload only disk."""

    def __init__(self, path: Path, project_id: str, *, port: int = 0):
        self.path, self.project_id = path, project_id
        self.mutex = threading.Lock()
        self.receipts: dict[str, dict[str, Any]] = {}
        self.intents: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.attempts: list[str] = []
        self.lookups: list[str] = []
        self.generation = 1
        self.fault: str | None = None
        self.feed_fault: str | None = None
        self.arrived = threading.Event()
        self.release = threading.Event()
        if path.exists():
            saved = json.loads(private_read(path))
            self.receipts, self.intents, self.events = (
                saved["receipts"],
                saved["intents"],
                saved["events"],
            )
            self.attempts, self.lookups = saved["attempts"], saved["lookups"]
            self.generation = saved["generation"]
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def answer(self, status: int, document: dict[str, Any]) -> None:
                data = json.dumps(document).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def drop(self) -> None:
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()

            def do_POST(self) -> None:
                assert (
                    urlsplit(self.path).path
                    == MulticaClient.project_path(backend.project_id) + "/commands"
                )
                length = int(self.headers["Content-Length"])
                command = json.loads(self.rfile.read(length))
                operation_id = command["operation_id"]
                with backend.mutex:
                    backend.attempts.append(operation_id)
                    backend.save()
                    fault, backend.fault = backend.fault, None
                if fault == "before_accept":
                    self.drop()
                    return
                if fault == "defer_accept":
                    backend.arrived.set()
                    assert backend.release.wait(5), (
                        "test did not release receiver checkpoint"
                    )
                with backend.mutex:
                    if (
                        int(self.headers.get("X-Muxpilot-Generation", "0"))
                        != backend.generation
                    ):
                        self.answer(409, {"error": "stale generation"})
                        return
                    if (
                        operation_id in backend.intents
                        and command != backend.intents[operation_id]
                    ):
                        self.answer(409, {"error": "changed immutable intent"})
                        return
                    if operation_id not in backend.receipts:
                        action = command["action"]
                        receipt: dict[str, Any] = {
                            "accepted": True,
                            "operation_id": operation_id,
                            "action": action,
                        }
                        if action in {"activate_stage", "create_task"}:
                            receipt["issue_id"] = str(uuid.uuid4())
                        if action == "activate_stage":
                            receipt["run_id"] = str(uuid.uuid4())
                        if action == "cancel":
                            receipt.update(
                                run_id=command["task_id"], observed_state="cancelled"
                            )
                        backend.intents[operation_id] = command
                        backend.receipts[operation_id] = receipt
                        backend.append_event(
                            "coordinator." + action,
                            {"command": command, "receipt": receipt},
                            operation_id=operation_id,
                        )
                        backend.save()
                    receipt = backend.receipts[operation_id]
                    if fault == "human_edit_then_drop":
                        backend.append_event(
                            "human.task_edit",
                            {"required_check": "new integration check"},
                            actor_type="human",
                            actor_id="fixture-human",
                        )
                        backend.save()
                if fault in {"after_accept", "human_edit_then_drop"}:
                    self.drop()
                else:
                    self.answer(200, receipt)

            def do_GET(self) -> None:
                parsed = urlsplit(self.path)
                prefix = MulticaClient.project_path(backend.project_id)
                with backend.mutex:
                    if parsed.path.startswith(prefix + "/operations/"):
                        operation_id = parsed.path.rsplit("/", 1)[1]
                        backend.lookups.append(operation_id)
                        backend.save()
                        receipt = backend.receipts.get(operation_id)
                        self.answer(
                            200 if receipt else 404,
                            {"status": 200, "response": receipt}
                            if receipt
                            else {"error": "absent"},
                        )
                    elif parsed.path == prefix + "/events":
                        after = int(parse_qs(parsed.query)["after"][0])
                        events = [
                            dict(event)
                            for event in backend.events
                            if event["sequence"] > after
                        ]
                        previous = after
                        if backend.feed_fault == "reverse":
                            events.reverse()
                        elif backend.feed_fault in {"replay", "conflicting_replay"}:
                            events, previous = (
                                [dict(event) for event in backend.events],
                                0,
                            )
                            if backend.feed_fault == "conflicting_replay":
                                events[-1]["payload"] = {"forged": True}
                        self.answer(
                            200,
                            {
                                "events": events,
                                "prev_cursor": previous,
                                "page_complete": True,
                                "cursor": events[-1]["sequence"] if events else after,
                                "retention_gap": backend.feed_fault == "retention_gap",
                            },
                        )
                    elif parsed.path == prefix + "/snapshot":
                        runs = [
                            {
                                "id": receipt["run_id"],
                                "issue_id": receipt.get("issue_id"),
                                "status": "cancelled"
                                if receipt["action"] == "cancel"
                                else "running",
                            }
                            for receipt in backend.receipts.values()
                            if "run_id" in receipt
                        ]
                        self.answer(
                            200,
                            {
                                "runs": runs,
                                "issues": [],
                                "cursor": len(backend.events),
                                "generation": backend.generation,
                            },
                        )
                    else:
                        self.answer(404, {"error": "unknown fixture route"})

        class Server(ThreadingHTTPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server(("127.0.0.1", port), Handler)
        self.port = int(self.server.server_address[1])
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        self.thread.start()

    def append_event(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        operation_id: str | None = None,
        actor_type: str = "coordinator",
        actor_id: str = "fixture-main",
    ) -> None:
        self.events.append(
            {
                "id": str(uuid.uuid4()),
                "sequence": len(self.events) + 1,
                "type": kind,
                "payload": payload,
                "actor_type": actor_type,
                "actor_id": actor_id,
                "occurred_at": "2026-01-01T00:00:00Z",
                "operation_id": operation_id,
            }
        )

    def save(self) -> None:
        private_write(
            self.path,
            json.dumps(
                {
                    "receipts": self.receipts,
                    "intents": self.intents,
                    "events": self.events,
                    "attempts": self.attempts,
                    "lookups": self.lookups,
                    "generation": self.generation,
                },
                sort_keys=True,
            ),
        )

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        assert not self.thread.is_alive()


def git(repo: Path, *arguments: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *arguments], text=True
    ).strip()


@dataclass
class FaultHarness:
    controller: ProjectController
    store: JournalStore
    credentials: dict[str, Any]
    backend: AuthoritativeBackend
    repo: Path

    def execute(
        self, action: str, operation_id: str, *, safe_retry: bool = False
    ) -> dict[str, Any]:
        payload = (
            {"stage": 1, "base_sha": "a" * 40}
            if action == "activate_stage"
            else {
                "task_id": "fixture-live-run",
                "content": "Human requested scoped stop",
            }
        )
        if safe_retry:
            command = {"operation_id": operation_id, "action": action, **payload}
            return self.controller._effect(
                self.store,
                self.credentials,
                operation_id,
                "multica." + action,
                command,
                lambda: self.controller._remote(self.credentials).command(
                    self.store.project_id, command
                ),
                idempotent=True,
            )
        return self.controller._command(
            self.store, self.credentials, action, payload, operation_id
        )

    def reopen(self) -> None:
        root, project = self.store.state_root, self.store.project_id
        self.store.close()
        self.store = JournalStore(root, project, self.repo)

    def reconcile(self, operation_id: str) -> dict[str, Any]:
        receipt = self.controller._remote(self.credentials).operation(
            self.store.project_id, operation_id
        )
        return self.store.reconcile_operation(
            operation_id,
            "confirmed",
            self.credentials["owner"],
            self.credentials["generation"],
            receipt=receipt["response"],
        )

    def restart_backend(self) -> None:
        path, project_id, port = (
            self.backend.path,
            self.backend.project_id,
            self.backend.port,
        )
        self.backend.close()
        self.backend = AuthoritativeBackend(path, project_id, port=port)


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[FaultHarness]:
    project = str(uuid.uuid4())
    backend = AuthoritativeBackend(tmp_path / "backend/authoritative.json", project)
    repo = tmp_path / "repository"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Synthetic fault fixture")
    git(repo, "config", "user.email", "fault@example.invalid")
    git(repo, "commit", "--allow-empty", "-qm", "baseline")
    config = Config(
        tmp_path / "projects",
        tmp_path / "projectd.sock",
        multica_url=backend.url,
        multica_workspace_id=str(uuid.uuid4()),
    )
    controller = ProjectController(config)
    record, _created = controller.registry.get_or_create(repo, "fault-fixture", project)
    store = JournalStore(config.state_root, project, repo)
    lease = store.acquire_lease("fixture-coordinator")
    credentials = {
        "owner": "fixture-coordinator",
        "generation": lease["generation"],
        "remote_generation": 1,
        "multica_project_id": project,
        "token": "synthetic-scoped-token",
    }
    controller._mint_local(credentials)
    private_write(controller._credentials_path(record), json.dumps(credentials))
    result = FaultHarness(controller, store, credentials, backend, repo)
    try:
        yield result
    finally:
        result.store.close()
        result.backend.close()


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_before_intent_commit_has_no_remote_effect_or_phantom_intent(
    harness, monkeypatch, action
):
    operation_id = str(uuid.uuid4())
    original = harness.store._event

    def abort(db, kind, payload, **metadata):
        event = original(db, kind, payload, **metadata)
        if kind == "operation.prepared":
            raise CrashBoundary("after insert before intent transaction commits")
        return event

    monkeypatch.setattr(harness.store, "_event", abort)
    with pytest.raises(CrashBoundary):
        harness.execute(action, operation_id)
    harness.reopen()
    assert harness.store.operation(operation_id) is None
    assert not harness.backend.attempts
    assert not any(
        event["operation_id"] == operation_id for event in harness.store.events()
    )


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_after_intent_before_send_replays_same_operation_identity(
    harness, monkeypatch, action
):
    operation_id = str(uuid.uuid4())

    def abort(*_):
        raise CrashBoundary("before dispatch admission")

    monkeypatch.setattr(harness.store, "mark_dispatched", abort)
    with pytest.raises(CrashBoundary):
        harness.execute(action, operation_id)
    harness.reopen()
    assert harness.store.operation(operation_id)["state"] == "prepared"
    assert harness.backend.attempts == []
    receipt = harness.execute(action, operation_id)
    assert receipt["operation_id"] == operation_id
    assert harness.backend.attempts == [operation_id]
    assert len(harness.backend.receipts) == 1


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_sent_before_acceptance_requires_lookup_before_idempotent_retry(
    harness, action
):
    operation_id = str(uuid.uuid4())
    harness.backend.fault = "before_accept"
    with pytest.raises(MulticaError) as error:
        harness.execute(action, operation_id)
    assert error.value.uncertain
    harness.reopen()
    assert harness.store.operation(operation_id)["state"] == "uncertain"
    with pytest.raises(ProjectError, match="no blind retry"):
        harness.execute(action, operation_id)
    assert len(harness.backend.attempts) == 1
    with pytest.raises(MulticaError) as absent:
        harness.controller._remote(harness.credentials).operation(
            harness.store.project_id, operation_id
        )
    assert absent.value.status == 404
    assert harness.backend.lookups == [operation_id]
    assert not harness.backend.receipts
    harness.store.append_event(
        "recovery.authoritative_lookup",
        {
            "operation_id": operation_id,
            "outcome": "absent",
            "retry_policy": "receiver-proven idempotent same operation identity",
        },
        operation_id=operation_id,
    )
    receipt = harness.execute(action, operation_id, safe_retry=True)
    assert receipt["operation_id"] == operation_id
    assert harness.backend.attempts == [operation_id, operation_id]
    assert len(harness.backend.receipts) == 1


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_remote_acceptance_before_reply_recovers_without_duplicate_effect(
    harness, action
):
    operation_id = str(uuid.uuid4())
    harness.backend.fault = "after_accept"
    with pytest.raises(MulticaError):
        harness.execute(action, operation_id)
    receipt = dict(harness.backend.receipts[operation_id])
    harness.reopen()
    with pytest.raises(ProjectError, match="reconciliation"):
        harness.execute(action, operation_id)
    assert harness.backend.attempts == [operation_id]
    assert harness.reconcile(operation_id)["receipt"] == receipt
    assert harness.execute(action, operation_id) == receipt
    assert harness.backend.attempts == [operation_id]
    assert len(harness.backend.receipts) == 1
    trace = [
        event["kind"]
        for event in harness.store.events()
        if event["operation_id"] == operation_id
    ]
    assert trace == [
        "operation.prepared",
        "operation.dispatched",
        "operation.uncertain",
        "operation.reconciled",
    ]


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_received_receipt_before_local_commit_is_recovered_from_authority(
    harness, monkeypatch, action
):
    operation_id = str(uuid.uuid4())
    original = harness.store._event

    def abort(db, kind, payload, **metadata):
        event = original(db, kind, payload, **metadata)
        if kind == "operation.confirmed":
            raise CrashBoundary("receipt observed but transaction not committed")
        return event

    monkeypatch.setattr(harness.store, "_event", abort)
    with pytest.raises(CrashBoundary):
        harness.execute(action, operation_id)
    harness.reopen()
    assert harness.store.operation(operation_id)["state"] == "dispatched"
    assert harness.store.operation(operation_id)["receipt"] is None
    assert not any(
        event["kind"] == "operation.confirmed" for event in harness.store.events()
    )
    harness.reconcile(operation_id)
    receipt = harness.execute(action, operation_id)
    assert receipt == harness.backend.receipts[operation_id]
    assert harness.backend.lookups == [operation_id]
    assert harness.backend.attempts == [operation_id]


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_checkpoint_failure_rolls_back_receipt_then_reconciles_once(
    harness, action
):
    operation_id = str(uuid.uuid4())
    harness.store.prepare_operation(
        operation_id,
        "multica." + action,
        {
            "operation_id": operation_id,
            "action": action,
            **(
                {"stage": 1, "base_sha": "a" * 40}
                if action == "activate_stage"
                else {
                    "task_id": "fixture-live-run",
                    "content": "Human requested scoped stop",
                }
            ),
        },
        harness.credentials["owner"],
        1,
    )
    harness.store.mark_dispatched(operation_id, harness.credentials["owner"], 1)
    with harness.store.transaction() as db:
        db.execute(
            "CREATE TRIGGER injected_checkpoint_failure BEFORE UPDATE ON checkpoints WHEN NEW.name='journal' BEGIN SELECT RAISE(ABORT,'synthetic disk checkpoint failure'); END"
        )
    # Only the local receipt write fails: invoke the transport after the durable
    # dispatch record, then use the same production receipt transaction.
    command = harness.store.operation(operation_id)["payload"]
    receipt = harness.controller._remote(harness.credentials).command(
        harness.store.project_id, command
    )
    watermark = harness.store.status()["event_watermark"]
    with pytest.raises(StoreError):
        harness.store.complete_operation(
            operation_id, receipt, harness.credentials["owner"], 1
        )
    assert harness.store.status()["event_watermark"] == watermark
    assert harness.store.operation(operation_id)["state"] == "dispatched"
    with harness.store.transaction() as db:
        db.execute("DROP TRIGGER injected_checkpoint_failure")
    harness.reopen()
    harness.reconcile(operation_id)
    assert harness.execute(action, operation_id) == receipt
    assert harness.backend.attempts == [operation_id]


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_backend_outage_restart_restores_disk_receipt_without_new_effect(
    harness, action
):
    operation_id = str(uuid.uuid4())
    harness.backend.fault = "after_accept"
    with pytest.raises(MulticaError):
        harness.execute(action, operation_id)
    path, project_id, port = (
        harness.backend.path,
        harness.backend.project_id,
        harness.backend.port,
    )
    harness.backend.close()
    remote = MulticaClient(harness.backend.url, token="fixture", timeout=0.25)
    with pytest.raises(MulticaError) as unavailable:
        remote.operation(project_id, operation_id)
    assert unavailable.value.uncertain
    with pytest.raises(MulticaError):
        harness.reconcile(operation_id)
    assert harness.store.operation(operation_id)["state"] == "uncertain"
    with pytest.raises(ProjectError, match="no blind retry"):
        harness.execute(action, operation_id)
    assert harness.backend.attempts == [operation_id]
    # New receiver object reloads receipts/events from disk, without sharing the
    # old receiver object or relying on a caller's cached result.
    harness.backend = AuthoritativeBackend(path, project_id, port=port)
    harness.reopen()
    harness.reconcile(operation_id)
    receipt = harness.execute(action, operation_id)
    assert receipt["operation_id"] == operation_id
    assert len(harness.backend.receipts) == 1
    assert harness.backend.attempts == [operation_id]
    assert harness.backend.lookups == [operation_id]


def test_fault_receipt_before_plan_projection_repairs_from_durable_receipt(
    harness, monkeypatch
):
    original = harness.store.put_mapping
    plan = {
        "completion_criteria": ["exact integrated revision passes"],
        "stages": [
            {
                "stage": 1,
                "tasks": [{"title": "bounded worker", "acceptance": ["test evidence"]}],
            }
        ],
    }

    def abort(kind, identity, *args, **kwargs):
        if kind == "epic" and identity == "main":
            raise CrashBoundary("receipt committed; navigation projection absent")
        return original(kind, identity, *args, **kwargs)

    monkeypatch.setattr(harness.store, "put_mapping", abort)
    with pytest.raises(CrashBoundary):
        harness.controller._plan(harness.store, harness.credentials, {"plan": plan})
    assert harness.store.get_mapping("epic", "main") is None
    assert len(harness.backend.receipts) == 1
    operation_id = next(iter(harness.backend.receipts))
    assert harness.store.operation(operation_id)["state"] == "confirmed"
    harness.reopen()
    repaired = harness.controller._plan(
        harness.store, harness.credentials, {"plan": plan}
    )
    assert repaired["revision"] == 1
    assert len(harness.backend.receipts) == 2  # one original epic, one intended task
    assert harness.backend.attempts.count(operation_id) == 1
    assert (
        harness.store.get_mapping("epic", "main")["payload"]["issue_id"]
        == harness.backend.receipts[operation_id]["issue_id"]
    )
    assert harness.store.get_mapping("project", "plan")["payload"] == plan


def test_fault_integration_receipt_before_projection_reuses_actual_git_result(
    harness, monkeypatch
):
    baseline = git(harness.repo, "rev-parse", "HEAD")
    harness.store.put_mapping(
        "project",
        "baseline",
        {"sha": baseline, "dirty": False},
        harness.credentials["owner"],
        harness.credentials["generation"],
    )
    git(harness.repo, "checkout", "-qb", "worker")
    (harness.repo / "requested.py").write_text("verified worker content\n")
    git(harness.repo, "add", "requested.py")
    git(harness.repo, "commit", "-qm", "worker result")
    revision = git(harness.repo, "rev-parse", "HEAD")
    git(harness.repo, "checkout", "-q", "main")
    operation_id = str(uuid.uuid4())
    original = JournalStore.put_mapping

    def abort(store, kind, identity, *args, **kwargs):
        if kind == "project" and identity == "integration":
            raise CrashBoundary("git effect and receipt committed before projection")
        return original(store, kind, identity, *args, **kwargs)

    request = {
        "project": harness.store.project_id,
        "commit": revision,
        "base": baseline,
        "operation_id": operation_id,
        "_credential": harness.controller.credential_for(
            "integrate", harness.store.project_id
        ),
    }
    with monkeypatch.context() as injection:
        injection.setattr(JournalStore, "put_mapping", abort)
        with pytest.raises(CrashBoundary):
            harness.controller.dispatch("integrate", request)
    harness.reopen()
    operation = harness.store.operation(operation_id)
    assert operation["state"] == "confirmed"
    assert operation["payload"]["base"] == baseline
    assert operation["receipt"]["source_commits"] == [revision]
    assert harness.store.get_mapping("project", "integration") is None
    branch = operation["receipt"]["branch"]
    before = git(harness.repo, "rev-parse", branch)
    count = git(harness.repo, "rev-list", "--count", branch)
    repaired = harness.controller.dispatch("integrate", request)
    assert repaired == operation["receipt"]
    assert git(harness.repo, "rev-parse", branch) == before
    assert git(harness.repo, "rev-list", "--count", branch) == count
    assert harness.store.get_mapping("project", "integration")["payload"] == repaired
    assert (harness.repo / "requested.py").exists() is False  # source branch preserved


def test_fault_http_feed_reorder_duplicate_conflict_and_retention_gap_are_explicit(
    harness,
):
    harness.backend.append_event(
        "human.task_edit", {"title": "first"}, actor_type="human", actor_id="human-a"
    )
    harness.backend.append_event(
        "worker.result",
        {"status": "needs_verification"},
        actor_type="worker",
        actor_id="worker-a",
    )
    harness.backend.save()
    harness.backend.feed_fault = "reverse"
    with pytest.raises(CursorGapError):
        harness.controller._ingest(harness.store, harness.credentials)
    assert harness.store.source_cursor("multica") == 0
    assert not any(event["source"] == "multica" for event in harness.store.events())
    harness.backend.feed_fault = None
    harness.controller._ingest(harness.store, harness.credentials)
    sources = [
        event for event in harness.store.events() if event["source"] == "multica"
    ]
    assert [event["source_event_id"] for event in sources] == [
        event["id"] for event in harness.backend.events
    ]
    harness.backend.feed_fault = "replay"
    harness.reopen()
    harness.controller._ingest(harness.store, harness.credentials)
    assert (
        len([event for event in harness.store.events() if event["source"] == "multica"])
        == 2
    )
    harness.backend.feed_fault = "conflicting_replay"
    with pytest.raises(ConflictError):
        harness.controller._ingest(harness.store, harness.credentials)
    assert harness.store.source_cursor("multica") == 2
    harness.backend.append_event(
        "human.scope_changed",
        {"goal": "retained-away human edit"},
        actor_type="human",
        actor_id="human-a",
    )
    harness.backend.feed_fault = "retention_gap"
    with pytest.raises(ProjectError, match="audit is incomplete"):
        harness.controller._ingest(harness.store, harness.credentials)
    assert harness.store.source_cursor("multica") == 3
    gap = harness.store.events()[-1]
    assert gap["kind"] == "audit.gap"
    assert gap["payload"]["snapshot_cursor"] == 3
    assert not harness.store.export_audit()["complete"]


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_human_edit_during_lost_reply_survives_cursor_replay_and_decision(
    harness, action
):
    operation_id = str(uuid.uuid4())
    harness.backend.fault = "human_edit_then_drop"
    with pytest.raises(MulticaError):
        harness.execute(action, operation_id)
    harness.reopen()
    harness.controller._ingest(harness.store, harness.credentials)
    human = next(
        event for event in harness.store.events() if event["kind"] == "human.task_edit"
    )
    assert human["actor"] == "human:fixture-human"
    assert human["payload"]["required_check"] == "new integration check"
    assert harness.store.status()["inbox_ack"] == 0
    harness.reconcile(operation_id)
    decision = harness.store.commit_decision(
        harness.credentials["owner"],
        1,
        human["sequence"],
        "Retain received human constraint before evaluating outcome",
        {
            "source_event_id": human["source_event_id"],
            "operation_id": operation_id,
            "replan_required": True,
        },
    )
    assert (
        harness.store.checkpoint("inbox_ack")["payload"]["decision_sequence"]
        == decision["sequence"]
    )
    harness.backend.feed_fault = "replay"
    harness.controller._ingest(harness.store, harness.credentials)
    assert (
        len(
            [
                event
                for event in harness.store.events()
                if event["source_event_id"] == human["source_event_id"]
            ]
        )
        == 1
    )
    assert harness.backend.attempts == [operation_id]


@pytest.mark.parametrize("action", ["activate_stage", "cancel"])
def test_fault_receiver_rejects_old_epoch_request_already_in_flight(harness, action):
    operation_id = str(uuid.uuid4())
    harness.backend.fault = "defer_accept"
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(harness.execute, action, operation_id)
        assert harness.backend.arrived.wait(5)
        harness.store.release_lease(harness.credentials["owner"], 1)
        lease = harness.store.acquire_lease("replacement-coordinator")
        with harness.backend.mutex:
            harness.backend.generation = 2
            harness.backend.save()
        harness.backend.release.set()
        with pytest.raises((LeaseError, MulticaError)):
            request.result(timeout=5)
    assert lease["generation"] == 2
    assert harness.backend.receipts == {}
    assert harness.backend.attempts == [operation_id]
    assert harness.store.operation(operation_id)["state"] == "dispatched"
    with pytest.raises(MulticaError) as absent:
        MulticaClient(
            harness.backend.url, token="new-fixture-token", generation=2
        ).operation(harness.store.project_id, operation_id)
    assert absent.value.status == 404
    harness.store.reconcile_operation(
        operation_id,
        "rejected",
        "replacement-coordinator",
        2,
        error="authoritative receiver rejected old generation before acceptance",
    )
    assert harness.store.operation(operation_id)["state"] == "rejected"
