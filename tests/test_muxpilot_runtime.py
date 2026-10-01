from __future__ import annotations

import base64
import io
import json
import os
import stat
import subprocess
import sys
import uuid
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from muxpilot.runtime import (
    CapabilityError,
    ExecutionConflict,
    ExecutionContext,
    ProviderBridge,
    ResourceConflict,
    WorkerAllocator,
    WorkerControls,
    ensure_project_workspace,
    inspect_execution,
    launch_main,
    validate_worker_result,
)
from muxpilot.store import JournalStore
from muxpilot.worker import load_context, main


def git(repository: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", "-C", str(repository), *arguments], stderr=subprocess.STDOUT).decode().strip()


@pytest.fixture
def repository(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "fixture@example.test")
    git(root, "config", "user.name", "Fixture")
    (root / "source.txt").write_text("baseline\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "baseline")
    return root


def test_dirty_source_snapshot_and_repeated_allocation_preserve_unrelated_work(tmp_path, repository):
    project = str(uuid.uuid4())
    (repository / "source.txt").write_text("local tracked edit\n")
    (repository / "untracked.bin").write_bytes(b"\x00private local work\xff")
    before = git(repository, "status", "--porcelain=v1")
    allocator = WorkerAllocator(tmp_path / "state")
    first = allocator.allocate(project, "task-a", "run-a", repository)
    second = allocator.allocate(project, "task-b", "run-b", repository)

    assert first.worktree != second.worktree
    assert first.dirty_baseline and second.dirty_baseline
    assert Path(first.worktree, "source.txt").read_text() == "baseline\n"
    assert not Path(first.worktree, "untracked.bin").exists()
    snapshot = json.loads(Path(first.snapshot_artifact).read_text())
    assert base64.b64decode(snapshot["untracked"][0]["content_base64"]) == b"\x00private local work\xff"
    assert b"local tracked edit" in base64.b64decode(snapshot["patch_base64"])
    assert allocator.allocate(project, "task-a", "run-a", repository) == first
    assert git(repository, "status", "--porcelain=v1") == before
    assert stat.S_IMODE(Path(first.snapshot_artifact).stat().st_mode) == 0o600
    with pytest.raises(ResourceConflict, match="identity"):
        allocator.allocate(project, "other-task", "run-a", repository)


def test_allocation_refuses_collisions_and_uncertain_receipts(tmp_path, repository):
    project = str(uuid.uuid4())
    allocator = WorkerAllocator(tmp_path / "state")
    git(repository, "branch", f"muxpilot/{project[:8]}/collision")
    with pytest.raises(ResourceConflict, match="branch already exists"):
        allocator.allocate(project, "task", "collision", repository)
    allocation = allocator.allocate(project, "task", "run", repository)
    receipt = Path(allocation.snapshot_artifact or Path(tmp_path / "state" / project / "runs" / "run" / "allocation.json"))
    saved = json.loads(receipt.read_text())
    saved["state"] = "allocating"
    receipt.write_text(json.dumps(saved))
    with pytest.raises(ResourceConflict, match="uncertain"):
        allocator.allocate(project, "task", "run", repository)


def test_snapshot_limit_refuses_worktree_side_effects(tmp_path, repository):
    project = str(uuid.uuid4())
    (repository / "large").write_bytes(b"x" * 100)
    allocator = WorkerAllocator(tmp_path / "state", snapshot_limit=10)
    with pytest.raises(ResourceConflict, match="exceeds"):
        allocator.allocate(project, "task", "run", repository)
    assert not (tmp_path / "state" / project / "worktrees" / "run").exists()


class LocalClient:
    """Real stdio rendezvous/provider ownership without a live tmux server."""

    def __init__(self):
        self.calls = []
        self.runners = []
        self.group = []
        self.identity = {"sessionId": "$42", "sessionCreated": 100, "serverStarted": 99,
                         "serverPid": 123, "paneId": "%42", "panePid": 124}

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if method == "POST" and path == "/api/sessions":
            if len(payload["command"]) > 1 and "stdio_runner.py" in payload["command"][1]:
                environment = {key: value for key, value in os.environ.items() if key not in {"TMUX", "TMUX_PANE"}}
                self.runners.append(subprocess.Popen(payload["command"], cwd=payload["directory"],
                                                      env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            return {"session": payload["name"], **self.identity}
        if path.startswith("/api/worker-terminal?"):
            return {"state": "live", "historyId": "history-immutable"}
        if method == "POST" and path.endswith("/groups"):
            self.group.append(payload["group"])
            return {"group": payload["group"]}
        if method == "POST" and path == "/api/workspaces":
            return {"workspace": {"id": "workspace-id", "sessionRevision": 1, "updatedAt": "now",
                                  "tabs": payload["tabs"], "groups": self.group}}
        if path.startswith("/api/workspaces/"):
            return {"workspace": {"id": "workspace-id", "sessionRevision": 1, "updatedAt": "now",
                                  "tabs": ["main", "worker"], "groups": self.group}}
        raise AssertionError((method, path, payload))

    def close(self):
        for process in self.runners:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)


@pytest.fixture
def client():
    instance = LocalClient()
    try:
        yield instance
    finally:
        instance.close()


def context(tmp_path, **changes):
    instance = ExecutionContext(str(tmp_path / "state"), str(uuid.uuid4()), "task", "run", str(uuid.uuid4()),
                                str(tmp_path), coordinator_owner="coordinator:fixture", generation=1)
    return replace(instance, **changes)


def test_provider_bytes_exit_receipt_and_bounded_evidence(tmp_path, client):
    instance = context(tmp_path, output_limit=32)
    binary = bytes(range(256))
    output, errors = io.BytesIO(), io.BytesIO()
    status = ProviderBridge(instance, client=client).run(
        [sys.executable, "-c", "import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(b'error'); sys.exit(7)"],
        stdin=io.BytesIO(binary), stdout=output, stderr=errors, environment=dict(os.environ))
    assert status == 7
    assert output.getvalue() == binary
    assert errors.getvalue() == b"error"
    receipt = inspect_execution(instance, max_bytes=16)
    assert receipt["exit_status"] == 7
    assert receipt["artifacts"]["stdout"]["truncated"]
    assert receipt["artifacts"]["stdout"]["observed_byte_count"] == 256
    assert receipt["session"]["identity"] == client.identity
    assert "/worker?" in receipt["session"]["terminal_url"]
    assert "historyId=history-immutable" in receipt["session"]["terminal_url"]
    assert "session=" not in receipt["session"]["terminal_url"]
    launches = [payload for method, path, payload in client.calls if path == "/api/sessions"]
    assert launches[0]["requestId"] == instance.request_id
    assert launches[0]["muxpilot"]["operationId"] == instance.execution_id
    assert "command" not in receipt and "environment" not in receipt
    for file in instance.directory.iterdir():
        assert stat.S_IMODE(file.stat().st_mode) == 0o600


def test_public_worker_url_is_separate_from_loopback_stdio_control(tmp_path, client):
    instance = context(tmp_path, muxdeck_public_url="https://console.example.test/mux")
    assert ProviderBridge(instance, client=client).run([sys.executable, "-c", "print('linked')"],
                                                     stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO()) == 0
    assert instance.muxdeck_url == "http://127.0.0.1:7683/mux"
    assert inspect_execution(instance)["session"]["terminal_url"].startswith("https://console.example.test/mux/worker?")
    with pytest.raises(ValueError, match="same-host"):
        replace(instance, muxdeck_url="https://console.example.test/mux")
    with pytest.raises(ValueError, match="without credentials"):
        replace(instance, muxdeck_public_url="https://console.example.test/mux?token=secret")


def test_execution_retry_refuses_duplicate_but_distinct_invocation_in_run_launches(tmp_path, client):
    instance = context(tmp_path)
    command = [sys.executable, "-c", "print('done')"]
    ProviderBridge(instance, client=client).run(command, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
    with pytest.raises(ExecutionConflict, match="already recorded"):
        ProviderBridge(instance, client=client).run(command, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
    another = replace(instance, execution_id=str(uuid.uuid4()))
    ProviderBridge(another, client=client).run(command, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
    assert len(client.runners) == 2
    assert another.request_id != instance.request_id


def test_known_secrets_redacted_across_chunks_without_changing_provider_protocol(tmp_path, client):
    instance = context(tmp_path)
    secret = "never-persist-this-token"
    command = [sys.executable, "-c", "import os,sys,time; s=os.environ['FAKE_API_KEY']; print(s[:7],end='',flush=True); time.sleep(.2); print(s[7:],flush=True)"]
    output = io.BytesIO()
    ProviderBridge(instance, client=client).run(command, stdin=io.BytesIO(), stdout=output, stderr=io.BytesIO(),
                                              environment={**os.environ, "FAKE_API_KEY": secret})
    assert output.getvalue() == (secret + "\n").encode()
    for file in instance.directory.iterdir():
        assert secret.encode() not in file.read_bytes()
    assert (instance.directory / "stdout.bin").read_bytes() == b"[REDACTED]\n"
    assert inspect_execution(instance)["artifacts"]["stdout"]["redacted"]


def test_probe_bypasses_context_and_terminal_allocation(tmp_path, capfd):
    probe = tmp_path / "probe"
    probe.write_text("#!/bin/sh\nprintf 'fake 1.0\\n'\n")
    probe.chmod(0o700)
    assert main(["--provider", str(probe), "--", "--version"]) == 0
    assert capfd.readouterr().out == "fake 1.0\n"
    assert not (tmp_path / "state").exists()


def test_worker_entrypoint_persists_deduplicable_lifecycle_with_secret_redaction(tmp_path, monkeypatch):
    from muxpilot import worker

    project, execution = str(uuid.uuid4()), str(uuid.uuid4())
    config = tmp_path / "worker-config.json"
    config.write_text(json.dumps({"state_root": str(tmp_path / "state"), "coordinator_owner": "coordinator:fixture",
                                  "generation": 1, "worktree": str(tmp_path)}))
    config.chmod(0o600)
    for key, value in {"MUXPILOT_PROJECT_ID": project, "MUXPILOT_TASK_ID": "attempt",
                       "MUXPILOT_ISSUE_ID": "issue", "MUXPILOT_EXECUTION_ID": execution,
                       "FOOBAR_API_KEY": "never-record-entrypoint-secret"}.items():
        monkeypatch.setenv(key, value)

    class FakeBridge:
        def __init__(self, context, event_callback, secret_values):
            self.context, self.observe = context, event_callback

        def run(self, command, **kwargs):
            payload = {"project_id": project, "task_id": "issue", "run_id": "attempt", "execution_id": execution,
                       "detail": "never-record-entrypoint-secret"}
            for kind in ("execution.prepared", "session.associated", "execution.observed"):
                self.observe(kind, payload)
            return 0

    monkeypatch.setattr(worker, "ProviderBridge", FakeBridge)
    assert worker.main(["--config", str(config), "--", "fake-provider", "app-server"]) == 0
    assert worker.main(["--config", str(config), "--", "fake-provider", "app-server"]) == 0
    journal = JournalStore(tmp_path / "state", project)
    events = journal.events()
    runtime_events = [event for event in events if event["source"] == "runtime"]
    assert [event["kind"] for event in runtime_events] == ["execution.prepared", "session.associated", "execution.observed"]
    assert runtime_events[0]["event_id"] == str(uuid.uuid5(uuid.UUID(execution), "execution.prepared"))
    assert "never-record-entrypoint-secret" not in json.dumps(events)


def test_project_runtime_config_and_daemon_ids_override_static_profile(tmp_path):
    project = str(uuid.uuid4())
    state = tmp_path / "state"
    directory = state / project
    directory.mkdir(parents=True)
    config = directory / "worker.json"
    config.write_text(json.dumps({"project_id": project, "workspace_id": "workspace-id", "group_id": "epic-id",
                                  "coordinator_owner": "coordinator:fixture", "generation": 1}))
    config.chmod(0o600)
    instance = load_context(environment={"MUXPILOT_STATE_ROOT": str(state), "MUXPILOT_PROJECT_ID": project,
                                         "MUXPILOT_TASK_ID": "attempt", "MUXPILOT_ISSUE_ID": "issue",
                                         "MUXPILOT_EXECUTION_ID": str(uuid.uuid4()), "MUXPILOT_GENERATION": "2",
                                         "MUXPILOT_WORKTREE": str(tmp_path)})
    assert instance.task_id == "issue" and instance.run_id == "attempt"
    assert instance.generation == 2 and instance.workspace_id == "workspace-id"


def test_paired_backend_generation_is_verified_before_local_receiver_generation(tmp_path):
    project = str(uuid.uuid4())
    directory = tmp_path / "state" / project
    directory.mkdir(parents=True)
    config = directory / "worker.json"
    config.write_text(json.dumps({"project_id": project, "coordinator_owner": "coordinator:fixture",
                                  "generation": 7, "backend_generation": 2}))
    config.chmod(0o600)
    environment = {"MUXPILOT_STATE_ROOT": str(tmp_path / "state"), "MUXPILOT_PROJECT_ID": project,
                   "MUXPILOT_TASK_ID": "attempt", "MUXPILOT_EXECUTION_ID": str(uuid.uuid4()),
                   "MUXPILOT_GENERATION": "2", "MUXPILOT_WORKTREE": str(tmp_path)}
    assert load_context(environment=environment).generation == 7
    with pytest.raises(ValueError, match="another backend"):
        load_context(environment={**environment, "MUXPILOT_GENERATION": "1"})


def test_actual_worker_environment_has_bounded_role_and_no_controller_config(tmp_path, client):
    instance = context(tmp_path)
    output = io.BytesIO()
    source = "import json,os; print(json.dumps({k:v for k,v in os.environ.items() if k.startswith('MUXPILOT_') or k=='MUXDECK_CONTROL_TOKEN_FILE'}))"
    ProviderBridge(instance, client=client).run([sys.executable, "-c", source], stdin=io.BytesIO(), stdout=output,
                                              stderr=io.BytesIO(), environment={**os.environ, "MUXPILOT_CONFIG": "/private/config",
                                                                                "MUXDECK_CONTROL_TOKEN_FILE": "/private/token"})
    environment = json.loads(output.getvalue())
    assert environment["MUXPILOT_ROLE"] == "worker"
    assert environment["MUXPILOT_RUN_ID"] == instance.run_id
    assert "MUXPILOT_CONFIG" not in environment and "MUXDECK_CONTROL_TOKEN_FILE" not in environment


def test_codex_worker_helper_policy_is_applied_and_conflicting_enable_refused(tmp_path, client):
    instance = context(tmp_path, provider="codex", helper_policy="disable_multi_agent")
    output = io.BytesIO()
    ProviderBridge(instance, client=client).run([sys.executable, "-c", "import sys,json; print(json.dumps(sys.argv[1:]))"],
                                              stdin=io.BytesIO(), stdout=output, stderr=io.BytesIO())
    assert json.loads(output.getvalue()) == ["--disable", "multi_agent"]
    assert inspect_execution(instance)["helper_control"]["enforced"]
    conflicting = replace(instance, execution_id=str(uuid.uuid4()))
    with pytest.raises(CapabilityError, match="hidden"):
        ProviderBridge(conflicting, client=client).run(["codex", "--enable", "multi_agent", "app-server"],
                                                      stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())


def test_observation_failure_is_unknown_and_cannot_reexecute(tmp_path, client):
    instance = context(tmp_path)

    def failure(kind, payload):
        if kind == "session.associated":
            raise OSError("evidence handoff failed")

    with pytest.raises(OSError):
        ProviderBridge(instance, client=client, event_callback=failure).run(
            [sys.executable, "-c", "print('never accepted')"], stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
    assert inspect_execution(instance)["state"] == "outcome_unknown"
    with pytest.raises(ExecutionConflict):
        ProviderBridge(instance, client=client).run([sys.executable, "-c", "pass"],
                                                  stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())


def test_controls_use_exact_execution_and_explicit_capability_receipt():
    backend = SimpleNamespace(control_run=lambda envelope: {"state": "queued", "envelope": envelope})
    controls = WorkerControls(backend, {"supplement": True, "cancel": True})
    arguments = {"project_id": str(uuid.uuid4()), "task_id": "task", "run_id": "run", "execution_id": str(uuid.uuid4()),
                 "operation_id": str(uuid.uuid4()), "generation": 1, "expected_version": 3}
    receipt = controls.control("supplement", message="reuse service", **arguments)
    assert receipt["state"] == "queued"
    assert receipt["envelope"]["execution_id"] == arguments["execution_id"]
    with pytest.raises(CapabilityError):
        controls.control("pause", **arguments)
    with pytest.raises(ValueError, match="exact execution"):
        controls.control("cancel", **{**arguments, "execution_id": None})


def test_result_handoff_checks_association_commit_and_verification(tmp_path, repository):
    allocation = WorkerAllocator(tmp_path / "state").allocate(str(uuid.uuid4()), "task", "run", repository)
    worktree = Path(allocation.worktree)
    (worktree / "worker.txt").write_text("contribution\n")
    git(worktree, "add", ".")
    git(worktree, "commit", "-m", "worker contribution")
    result = {"project_id": allocation.project_id, "task_id": "task", "run_id": "run", "status": "completed",
              "branch": allocation.branch, "commit": git(worktree, "rev-parse", "HEAD"),
              "checks": [{"command": "pytest focused", "exit_status": 0}]}
    assert not validate_worker_result(allocation, result)["task_accepted"]
    with pytest.raises(ResourceConflict, match="verification"):
        validate_worker_result(allocation, {**result, "checks": []})
    with pytest.raises(ResourceConflict, match="another"):
        validate_worker_result(allocation, {**result, "run_id": "other"})


def test_main_launch_is_durable_and_refuses_second_coordinator(tmp_path, repository, client):
    store = JournalStore(tmp_path / "state", str(uuid.uuid4()), repository)
    lease = store.acquire_lease("coordinator:fixture")
    config = SimpleNamespace(muxdeck_url="http://127.0.0.1:7683/mux", muxdeck_public_url="https://console.example.test/mux", muxdeck_token_file=None)
    operation = str(uuid.uuid4())
    receipt = launch_main(config, store, ["fake-main"], repository, lease["owner"], lease["generation"], operation, client=client)
    assert receipt["identity"] == client.identity
    assert receipt["terminal_url"].startswith("https://console.example.test/mux/session/")
    assert launch_main(config, store, ["fake-main"], repository, lease["owner"], lease["generation"], operation, client=client) == receipt
    with pytest.raises(ExecutionConflict, match="already has"):
        launch_main(config, store, ["fake-main"], repository, lease["owner"], lease["generation"], str(uuid.uuid4()), client=client)
    assert len([call for call in client.calls if call[1] == "/api/sessions"]) == 1


def test_workspace_and_first_worker_group_are_reused(tmp_path, repository, client):
    store = JournalStore(tmp_path / "state", str(uuid.uuid4()), repository)
    lease = store.acquire_lease("coordinator:fixture")
    config = SimpleNamespace(state_root=tmp_path / "state", muxdeck_url="http://127.0.0.1:7683/mux",
                             muxdeck_public_url="https://console.example.test/mux", muxdeck_token_file=None)
    placement = ensure_project_workspace(config, store, lease["owner"], lease["generation"], "Project", "main", client=client)
    again = ensure_project_workspace(config, store, lease["owner"], lease["generation"], "Project", "main", client=client)
    assert placement == again
    assert placement["workspace_url"].startswith("https://console.example.test/mux/")
    assert json.loads(Path(placement["worker_config_path"]).read_text())["muxdeck_public_url"] == config.muxdeck_public_url
    instance = context(tmp_path, project_id=store.project_id, workspace_id=placement["workspace_id"], group_id=placement["group_id"])
    assert ProviderBridge(instance, client=client).run([sys.executable, "-c", "print('grouped')"],
                                                    stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO()) == 0
    assert client.group[0]["tabs"] == [instance.session_name]
    assert "main" not in client.group[0]["tabs"]


def retain_receiver_receipt(store, operation_id, receipt, *, state="confirmed"):
    with store.transaction() as database:
        database.execute("CREATE TABLE IF NOT EXISTS receiver_operations (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT)")
        database.execute("INSERT INTO receiver_operations VALUES (?,?,?,?)",
                         (operation_id, "fixture-fingerprint", state, json.dumps(receipt) if receipt is not None else None))


def test_lost_workspace_reply_reconciles_confirmed_receiver_without_second_create(tmp_path, repository):
    store = JournalStore(tmp_path / "state", str(uuid.uuid4()), repository)
    lease = store.acquire_lease("coordinator:fixture")
    config = SimpleNamespace(state_root=tmp_path / "state", muxdeck_url="http://127.0.0.1:7683/mux", muxdeck_token_file=None)

    class LostResponseClient(LocalClient):
        def request(self, method, path, payload=None):
            result = super().request(method, path, payload)
            if method == "POST" and path == "/api/workspaces":
                retain_receiver_receipt(store, payload["muxpilot"]["operationId"], result)
                raise OSError("response lost after receiver commit")
            return result

    client = LostResponseClient()
    with pytest.raises(OSError, match="response lost"):
        ensure_project_workspace(config, store, lease["owner"], lease["generation"], "Project", "main", client=client)
    assert store.pending_operations()[0]["state"] == "uncertain"
    recovered = ensure_project_workspace(config, store, lease["owner"], lease["generation"], "Project", "main", client=client)
    assert recovered["workspace_id"] == "workspace-id"
    assert store.get_mapping("muxdeck_workspace", "project")["payload"]["workspace_id"] == "workspace-id"
    assert not store.pending_operations()
    assert len([call for call in client.calls if call[:2] == ("POST", "/api/workspaces")]) == 1


def test_unknown_workspace_receiver_outcome_never_repeats_create(tmp_path, repository, client):
    store = JournalStore(tmp_path / "state", str(uuid.uuid4()), repository)
    lease = store.acquire_lease("coordinator:fixture")
    config = SimpleNamespace(state_root=tmp_path / "state", muxdeck_url="http://127.0.0.1:7683/mux", muxdeck_token_file=None)
    operation_id = str(uuid.uuid5(uuid.UUID(store.project_id), "workspace-create"))
    store.prepare_operation(operation_id, "workspace.create", {"name": "Project", "main_session": "main"}, lease["owner"], lease["generation"])
    retain_receiver_receipt(store, operation_id, None, state="uncertain")
    with pytest.raises(ExecutionConflict, match="receiver outcome is uncertain"):
        ensure_project_workspace(config, store, lease["owner"], lease["generation"], "Project", "main", client=client)
    assert client.calls == []
    assert store.get_mapping("muxdeck_workspace", "project") is None


def test_lost_main_launch_reply_adopts_exact_receiver_identity_without_second_launch(tmp_path, repository):
    store = JournalStore(tmp_path / "state", str(uuid.uuid4()), repository)
    lease = store.acquire_lease("coordinator:fixture")
    config = SimpleNamespace(muxdeck_url="http://127.0.0.1:7683/mux", muxdeck_token_file=None)
    operation_id = str(uuid.uuid4())

    class LostResponseClient(LocalClient):
        def request(self, method, path, payload=None):
            result = super().request(method, path, payload)
            if method == "POST" and path == "/api/sessions":
                retain_receiver_receipt(store, payload["muxpilot"]["operationId"], result)
                raise OSError("main launch reply lost")
            return result

    client = LostResponseClient()
    with pytest.raises(OSError, match="reply lost"):
        launch_main(config, store, ["fake-main"], repository, lease["owner"], lease["generation"], operation_id, client=client)
    recovered = launch_main(config, store, ["fake-main"], repository, lease["owner"], lease["generation"], operation_id, client=client)
    assert recovered["identity"] == client.identity
    assert store.get_mapping("main_session", "main")["payload"] == recovered
    assert not store.pending_operations()
    assert len([call for call in client.calls if call[:2] == ("POST", "/api/sessions")]) == 1
