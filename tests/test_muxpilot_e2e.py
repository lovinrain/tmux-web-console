"""Real local boundaries with synthetic providers, never valuable tmux sessions.

These tests certify the stated local contracts. They do not certify a real
provider pairing, a natural-language agent, Multica UI, or release readiness.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import shlex
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from muxpilot.integration import Integrator
from muxpilot.runtime import (
    ExecutionContext,
    ResourceConflict,
    WorkerAllocator,
    validate_worker_result,
)
from tmux_console.control_cli import ControlClient

FAKE_CODEX_PROGRAM = r'''
"""Synthetic Codex app-server RPC fixture, with no provider/account access."""
import base64, json, os, pathlib, re, subprocess, sys, threading, time, uuid
if sys.argv[1:] in (['--version'], ['-V']):
    print('codex-cli 0.110.0 (muxpilot deterministic fake)')
    raise SystemExit(0)
if sys.argv[1:] in (['--help'], ['-h']):
    print('Synthetic Codex fixture: app-server')
    raise SystemExit(0)
if 'app-server' not in sys.argv[1:]:
    raise SystemExit('fake Codex only implements app-server')
lock = threading.Lock()
thread_id = 'fake-thread-' + uuid.uuid4().hex
active = {}
def checkpoint(path, value):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    os.replace(temporary, path)
def emit(value):
    with lock:
        print(json.dumps({'jsonrpc': '2.0', **value}), flush=True)
def finish(turn, stop, inputs):
    emit({'method': 'item/agentMessage/delta', 'params': {'threadId': thread_id, 'turnId': turn, 'itemId': 'fake-progress-' + turn, 'delta': 'Deterministic fixture reached its explicit execution checkpoint. '}})
    base = os.environ.get('MUXPILOT_FAKE_CHECKPOINT_DIR')
    if base:
        root = pathlib.Path(base)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        execution = os.environ.get('MUXPILOT_EXECUTION_ID', str(os.getpid()))
        checkpoint(root / (execution + '.ready.json'), {'pid': os.getpid(), 'cwd': os.getcwd(), 'thread_id': thread_id, 'turn_id': turn, 'execution_id': execution, 'project_id': os.environ.get('MUXPILOT_PROJECT_ID'), 'run_id': os.environ.get('MUXPILOT_RUN_ID'), 'task_id': os.environ.get('MUXPILOT_ISSUE_ID')})
        while not (root / (execution + '.release')).exists() and not stop.is_set():
            time.sleep(0.025)
    status = 'interrupted' if stop.is_set() else 'completed'
    result = {'mode': 'deterministic-fake', 'status': status, 'thread_id': thread_id, 'turn_id': turn}
    if status == 'completed':
        text = json.dumps(inputs)
        target = re.search(r'MUXPILOT_FIXTURE_FILE=([a-zA-Z0-9_.-]+)', text)
        content = re.search(r'MUXPILOT_FIXTURE_BASE64=([A-Za-z0-9+/=]+)', text)
        if target and content:
            pathlib.Path(target.group(1)).write_bytes(base64.b64decode(content.group(1)))
            subprocess.run(['git', 'add', '--', target.group(1)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(['git', '-c', 'user.name=Muxpilot synthetic worker', '-c', 'user.email=muxpilot@example.invalid', 'commit', '-m', 'synthetic task result ' + target.group(1)], check=True, stdout=subprocess.DEVNULL)
            result['commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
            result['branch'] = subprocess.check_output(['git', 'symbolic-ref', '--short', 'HEAD'], text=True).strip()
            result['file'] = target.group(1)
        if base:
            checkpoint(root / (execution + '.result.json'), result)
        emit({'method': 'item/completed', 'params': {'threadId': thread_id, 'turnId': turn, 'item': {'id': 'fake-result-' + turn, 'type': 'agentMessage', 'text': 'Synthetic protocol turn completed; this is not goal acceptance or a real-provider proof.'}}})
    emit({'method': 'turn/completed', 'params': {'threadId': thread_id, 'turn': {'id': turn, 'status': status}}})
for line in sys.stdin:
    message = json.loads(line)
    method, identity = message.get('method'), message.get('id')
    if identity is None:
        continue
    if method == 'initialize':
        result = {'userAgent': 'muxpilot-deterministic-fake'}
    elif method == 'model/list':
        result = {'data': [{'id': 'fake', 'model': 'fake', 'displayName': 'Synthetic test model', 'description': 'No account/cost', 'isDefault': True, 'supportedReasoningEfforts': [{'reasoningEffort': 'low', 'description': 'Synthetic'}], 'defaultReasoningEffort': 'low'}], 'nextCursor': None}
    elif method in ('thread/start', 'thread/resume'):
        result = {'thread': {'id': thread_id}, 'model': 'fake', 'modelProvider': 'synthetic', 'cwd': os.getcwd()}
    elif method == 'turn/start':
        turn = 'fake-turn-' + uuid.uuid4().hex
        stop = threading.Event()
        active[turn] = stop
        emit({'id': identity, 'result': {'turn': {'id': turn, 'status': 'inProgress'}}})
        emit({'method': 'turn/started', 'params': {'threadId': thread_id, 'turn': {'id': turn, 'status': 'inProgress'}}})
        threading.Thread(target=finish, args=(turn, stop, message.get('params', {}).get('input', [])), daemon=True).start()
        continue
    elif method == 'turn/interrupt':
        target = message.get('params', {}).get('turnId')
        if target in active:
            active[target].set()
        result = {}
    elif method in ('turn/steer', 'thread/name/set', 'thread/archive'):
        result = {}
    else:
        emit({'id': identity, 'error': {'code': -32601, 'message': 'Unsupported synthetic fixture method'}})
        continue
    emit({'id': identity, 'result': result})
'''


def write_fake_codex(path: Path) -> None:
    """Materialize the same fake RPC provider for an actual Multica daemon run."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(descriptor, "w") as output:
        output.write("#!" + sys.executable + "\n" + FAKE_CODEX_PROGRAM)


def wait_until(predicate: Callable[[], Any], *, timeout: float = 10) -> Any:
    """Poll an observable checkpoint, never use a sleep to infer a state."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.025)
    raise AssertionError("observable checkpoint did not arrive before deadline")


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def commit_file(repo: Path, relative: str, content: str) -> str:
    (repo / relative).write_text(content)
    git(repo, "add", "--", relative)
    git(repo, "commit", "-m", "synthetic bounded worker result")
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "muxpilot-fixture@example.invalid")
    git(repo, "config", "user.name", "Muxpilot synthetic fixture")
    commit_file(repo, "goal.py", "def requested_goal():\n    return 'baseline'\n")
    # An independent dirty source baseline must survive every worktree operation.
    (repo / "unrelated.txt").write_text("private unrelated work\n")
    return repo


class LocalStack:
    def __init__(self, root: Path):
        self.root = root
        self.socket_name = "mxp-e2e-" + uuid.uuid4().hex
        self.tmux = ["tmux", "-L", self.socket_name, "-f", "/dev/null"]
        self.processes: list[subprocess.Popen] = []
        self.finalizers: list[Callable[[], None]] = []
        # Unix sockets have a short kernel pathname limit, independently of the
        # retained evidence directory and pytest's descriptive node name.
        self.service_root = Path(tempfile.mkdtemp(prefix="mxp-e2e-"))
        self.service_socket = self.service_root / "projectd.sock"
        self.token_file = root / "control-token"
        self.token_file.write_text(secrets.token_urlsafe(32) + "\n")
        self.token_file.chmod(0o600)
        self.url = ""

    def retain_resources(self, *, closed: bool = False) -> None:
        path = self.root / "resources.json"
        temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump({"tmux_socket": self.socket_name, "sessions": self.inventory(),
                       "processes": [{"pid": process.pid, "returncode": process.poll()} for process in self.processes],
                       "service_socket": str(self.service_socket), "closed": closed}, output)
        os.replace(temporary, path)

    def launch(self, command: list[str], *, env: dict[str, str] | None = None,
               stdin: Any = subprocess.DEVNULL) -> subprocess.Popen:
        path = self.root / f"process-{len(self.processes)}.log"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as log:
            process = subprocess.Popen(command, env=env, stdin=stdin,
                                       stdout=log, stderr=log, start_new_session=True)
        self.processes.append(process)
        self.retain_resources()
        return process

    def inventory(self) -> dict[str, str]:
        result = subprocess.run([*self.tmux, "list-sessions", "-F", "#{session_name}:#{session_id}"],
                                capture_output=True, text=True, check=False)
        return dict(line.split(":", 1) for line in result.stdout.splitlines())

    def stop(self, process: subprocess.Popen, *, crash: bool = False) -> None:
        if process.poll() is None:
            process.send_signal(signal.SIGKILL if crash else signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def cleanup(self) -> None:
        errors = []
        for finalizer in reversed(self.finalizers):
            try:
                finalizer()
            except Exception as error:  # noqa: BLE001 - teardown all owned resources before reporting
                errors.append(type(error).__name__)
        for name, identity in self.inventory().items():
            captured = subprocess.run([*self.tmux, "capture-pane", "-p", "-t", identity + ":0", "-S", "-150"],
                                      capture_output=True, text=True, check=False, timeout=5).stdout
            path = self.root / ("retained-pane-" + identity.lstrip("$") + ".txt")
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                output.write("fixture session: " + name + "\n" + captured)
        for process in reversed(self.processes):
            self.stop(process)
        # All sessions belong to this freshly generated socket. Do not kill-server,
        # do not target the default socket, and target exact immutable session IDs.
        for identity in self.inventory().values():
            subprocess.run([*self.tmux, "kill-session", "-t", identity],
                           capture_output=True, check=False)
        for path in self.service_root.iterdir():
            path.unlink()
        self.service_root.rmdir()
        self.retain_resources(closed=True)
        if errors:
            path = self.root / "cleanup-errors.json"
            path.write_text(json.dumps({"errors": errors}))
            path.chmod(0o600)
            raise AssertionError("fixture backend cleanup failed: " + ", ".join(errors))


@pytest.fixture
def local_stack(tmp_path: Path) -> LocalStack:
    root = tmp_path / "stack"
    root.mkdir(mode=0o700)
    stack = LocalStack(root)
    (root / "projects").mkdir(mode=0o700)
    subprocess.run([*stack.tmux, "new-session", "-d", "-s", "unrelated", "bash", "--noprofile", "--norc"], check=True)
    subprocess.run([*stack.tmux, "new-session", "-d", "-s", "main", "bash", "--noprofile", "--norc"], check=True)
    ready = root / "muxdeck-ready.json"
    program = """
import asyncio, json, pathlib, signal, sys
from aiohttp import web
from tmux_console.app import create_app
async def main():
    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    pathlib.Path(sys.argv[1]).write_text(json.dumps({'port': site._server.sockets[0].getsockname()[1]}))
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await stop.wait()
    await runner.cleanup()
asyncio.run(main())
"""
    env = dict(os.environ, MUXDECK_TMUX_SOCKET=stack.socket_name,
               MUXDECK_BASE_PATH="", MUXDECK_AUTH_MODE="none",
               MUXPILOT_STATE_ROOT=str(root / "projects"),
               MUXDECK_CONTROL_TOKEN_FILE=str(stack.token_file))
    for key in ("MUXDECK_AUTH_FILE", "MUXDECK_CALLBACK_TOKEN_FILE", "MUXDECK_TRUSTED_ORIGINS"):
        env.pop(key, None)
    env["PYTHONFAULTHANDLER"] = "1"
    for suffix, filename in {"TITLES":"titles.json", "MESSAGES":"messages.json", "SNIPPETS":"snippets.json",
                             "WORKSPACES":"workspaces.json", "SHORTCUTS":"shortcuts.json", "CALLBACKS":"callbacks.sqlite3",
                             "SESSION_REGISTRY":"sessions.sqlite3", "SUBMITTED_MESSAGES":"submitted.sqlite3",
                             "SCROLLBACK":"scrollback.sqlite3", "LAUNCH_REQUESTS":"launch-requests.sqlite3"}.items():
        env["MUXDECK_" + suffix + "_FILE"] = str(root / filename)
    env["MUXDECK_UPLOADS_DIR"] = str(root / "uploads")
    for provider in ("CODEX", "CLAUDE", "COPILOT", "CURSOR", "GROK"):
        env["MUXDECK_" + provider + "_TRANSCRIPTS_DIR"] = str(root / "native-history" / provider.lower())
    stack.launch([sys.executable, "-c", program, str(ready)], env=env)
    try:
        wait_until(ready.exists)
        stack.url = "http://127.0.0.1:" + str(json.loads(ready.read_text())["port"])
        assert ControlClient(stack.url, stack.token_file).request("GET", "/api/sessions")["sessions"]
        yield stack
    finally:
        stack.cleanup()


def test_real_worktree_result_handoff_and_goal_integration_preserve_dirty_source(
    tmp_path: Path, repository: Path,
) -> None:
    project = str(uuid.uuid4())
    (tmp_path / "projects").mkdir(mode=0o700)
    (tmp_path / "projects" / project).mkdir(mode=0o700)
    before = (repository / "unrelated.txt").read_bytes()
    baseline = git(repository, "rev-parse", "HEAD")
    allocation = WorkerAllocator(tmp_path / "projects").allocate(project, "api-task", "api-run", repository)
    assert allocation.dirty_baseline
    assert Path(allocation.snapshot_artifact).is_file()
    assert WorkerAllocator(tmp_path / "projects").allocate(project, "api-task", "api-run", repository) == allocation
    worker = Path(allocation.worktree)
    result_sha = commit_file(worker, "goal.py", "def requested_goal():\n    return 'verified'\n")
    identity = {"project_id": project, "task_id": "api-task", "run_id": "api-run",
                "status": "completed", "commit": result_sha, "branch": allocation.branch}
    with pytest.raises(ResourceConflict, match="verification"):
        validate_worker_result(allocation, identity)
    result = validate_worker_result(allocation, {**identity, "checks": [{"command": "synthetic unit check", "exit_status": 0}]})
    assert result["task_accepted"] is False
    integrator = Integrator(repository, project, tmp_path / "projects" / project)
    integrated = integrator.integrate(result_sha, base=baseline)
    assert integrated["status"] == "integrated"
    target = Path(integrated["path"])
    verification = subprocess.run([sys.executable, "-B", "-c", "from goal import requested_goal; assert requested_goal() == 'verified'"],
                                  cwd=target, capture_output=True, check=False)
    assert verification.returncode == 0, verification.stderr
    integrator.verify_revision(integrated["integration_sha"])
    assert git(repository, "rev-parse", "HEAD") == baseline
    assert (repository / "unrelated.txt").read_bytes() == before


def test_real_git_conflicting_workers_leave_explicit_unresolved_integration(
    tmp_path: Path, repository: Path,
) -> None:
    project = str(uuid.uuid4())
    (tmp_path / "projects").mkdir(mode=0o700)
    (tmp_path / "projects" / project).mkdir(mode=0o700)
    base = git(repository, "rev-parse", "HEAD")
    allocator = WorkerAllocator(tmp_path / "projects")
    first = allocator.allocate(project, "first", "run-first", repository, base_sha=base)
    second = allocator.allocate(project, "second", "run-second", repository, base_sha=base)
    one = commit_file(Path(first.worktree), "goal.py", "def requested_goal():\n    return 'first'\n")
    two = commit_file(Path(second.worktree), "goal.py", "def requested_goal():\n    return 'second'\n")
    integrator = Integrator(repository, project, tmp_path / "projects" / project)
    assert integrator.integrate(one, base=base)["status"] == "integrated"
    conflict = integrator.integrate(two, base=base)
    assert conflict["status"] == "conflict"
    assert conflict["requires_resolution"] is True
    assert conflict["conflict_files"] == "goal.py"
    assert git(Path(conflict["path"]), "diff", "--name-only", "--diff-filter=U") == "goal.py"
    assert (repository / "unrelated.txt").read_text() == "private unrelated work\n"


def test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution(
    tmp_path: Path, repository: Path, local_stack: LocalStack,
) -> None:
    from muxpilot.service import request
    from muxpilot.store import JournalStore

    stack = local_stack
    before = stack.inventory()["unrelated"]
    state = stack.root / "projects"
    state.mkdir(mode=0o700, exist_ok=True)
    service_config = stack.root / "service.json"
    service_config.write_text(json.dumps({"state_root": str(state), "socket_path": str(stack.service_socket)}))
    service_config.chmod(0o600)
    service_command = [sys.executable, "-m", "muxpilot.service", "--config", str(service_config)]
    service = stack.launch(service_command)
    wait_until(stack.service_socket.exists)
    health = request(stack.service_socket, "service.health")
    assert health["pid"] == service.pid
    # A synthetic main owns only this requester. The provider invocation belongs
    # to another process, as it does under Multica's daemon.
    main_ready = stack.root / "main-ready"
    main = stack.launch([sys.executable, "-c",
                         "import pathlib,signal,sys; from muxpilot.service import request; request(sys.argv[1],'service.health'); pathlib.Path(sys.argv[2]).touch(); signal.pause()",
                         str(stack.service_socket), str(main_ready)])
    wait_until(main_ready.exists)
    project = str(uuid.uuid4())
    with JournalStore(state, project, repository) as journal:
        lease = journal.acquire_lease("synthetic-main", ttl=600)
    allocator = WorkerAllocator(state)
    allocation = allocator.allocate(project, "goal", "run-1", repository)
    execution = str(uuid.uuid4())
    worker_config = stack.root / "worker.json"
    configuration = {"state_root": str(state), "project_id": project, "task_id": "goal",
                     "run_id": "run-1", "execution_id": execution,
                     "coordinator_owner": lease["owner"], "generation": lease["generation"],
                     "worktree": allocation.worktree, "muxdeck_url": stack.url,
                     "token_file": str(stack.token_file)}
    worker_config.write_text(json.dumps(configuration))
    worker_config.chmod(0o600)
    provider_ready, release = stack.root / "provider-ready.json", stack.root / "release"
    provider_program = """
import json, os, pathlib, subprocess, sys, time
ready, release = map(pathlib.Path, sys.argv[1:3])
assert 'MUXDECK_CONTROL_TOKEN_FILE' not in os.environ
assert 'MUXPILOT_CONFIG' not in os.environ
ready.write_text(json.dumps({'pid': os.getpid(), 'cwd': os.getcwd()}))
print(json.dumps({'phase': 'progress', 'provider': 'deterministic-fake'}), flush=True)
while not release.exists():
    time.sleep(0.025)
pathlib.Path('goal.py').write_text("def requested_goal():\\n    return 'verified'\\n")
subprocess.run(['git', 'add', '--', 'goal.py'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['git', 'commit', '-m', 'actual synthetic provider goal result'], check=True, stdout=subprocess.DEVNULL)
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
print(json.dumps({'phase': 'complete', 'commit': commit}), flush=True)
"""
    command = [sys.executable, "-m", "muxpilot.worker", "--config", str(worker_config), "--",
               sys.executable, "-B", "-c", provider_program, str(provider_ready), str(release)]
    worker = stack.launch(command)
    context = ExecutionContext(**configuration)
    wait_until(provider_ready.exists)
    provider = json.loads(provider_ready.read_text())
    assert provider["cwd"] == allocation.worktree
    binding = json.loads((context.directory / "session.json").read_text())
    assert binding["identity"]["sessionId"] == stack.inventory()[context.session_name]
    stack.stop(main, crash=True)
    stack.stop(service, crash=True)
    os.kill(provider["pid"], 0)
    assert worker.poll() is None
    assert json.loads((context.directory / "execution.json").read_text())["state"] == "running"
    replacement_service = stack.launch(service_command)
    def replacement_healthy() -> Any:
        try:
            result = request(stack.service_socket, "service.health", timeout=0.2)
            return result if result["pid"] == replacement_service.pid else None
        except (OSError, RuntimeError):
            return None
    assert wait_until(replacement_healthy)["instance_id"] != health["instance_id"]
    release.touch()
    assert worker.wait(timeout=10) == 0
    receipt = json.loads((context.directory / "execution.json").read_text())
    assert receipt["state"] == "completed"
    assert receipt["exit_status"] == 0
    protocol = [json.loads(line) for line in (context.directory / "stdout.bin").read_text().splitlines()]
    assert [item["phase"] for item in protocol] == ["progress", "complete"]
    before_retry = stack.inventory()
    duplicate = stack.launch(command)
    assert duplicate.wait(timeout=5) == 1
    assert stack.inventory() == before_retry
    assert json.loads((context.directory / "execution.json").read_text())["started_at"] == receipt["started_at"]
    # Two genuine invocations within the same run require distinct execution IDs.
    second = {**configuration, "execution_id": str(uuid.uuid4())}
    worker_config.write_text(json.dumps(second))
    second_worker = stack.launch([sys.executable, "-m", "muxpilot.worker", "--config", str(worker_config), "--",
                                  sys.executable, "-B", "-c", "print('second-invocation')"])
    assert second_worker.wait(timeout=10) == 0
    second_context = ExecutionContext(**second)
    assert second_context.request_id != context.request_id
    assert json.loads((second_context.directory / "execution.json").read_text())["state"] == "completed"
    assert (context.directory / "transcript.jsonl").read_bytes()
    assert stack.inventory()["unrelated"] == before
    assert (repository / "unrelated.txt").read_text() == "private unrelated work\n"


def test_real_journal_replay_fencing_artifact_integrity_and_wal_restore(
    tmp_path: Path, repository: Path,
) -> None:
    from muxpilot.store import ConflictError, CursorGapError, JournalStore, LeaseError

    root = tmp_path / "projects"
    project = str(uuid.uuid4())
    now = [1_000.0]
    secret = "e2e-secret-sentinel-never-export"
    store = JournalStore(root, project, repository, clock=lambda: now[0], secret_values=(secret,))
    first = store.acquire_lease("main-before-crash", ttl=10)
    operation = str(uuid.uuid4())
    prepared = store.prepare_operation(operation, "worker.launch", {"run_id": "owned-run"}, first["owner"], first["generation"])
    assert prepared["state"] == "prepared"
    store.close()
    store = JournalStore(root, project, clock=lambda: now[0], secret_values=(secret,))
    assert store.operation(operation)["state"] == "prepared"
    store.mark_dispatched(operation, first["owner"], first["generation"])
    store.mark_uncertain(operation, "external acceptance; local receipt missing", first["owner"], first["generation"])
    now[0] += 11
    successor = store.acquire_lease("main-after-crash", ttl=60)
    assert successor["generation"] > first["generation"]
    with pytest.raises(LeaseError):
        store.complete_operation(operation, {"run_id": "duplicate"}, first["owner"], first["generation"])
    reconciled = store.reconcile_operation(operation, "confirmed", successor["owner"], successor["generation"],
                                           receipt={"run_id": "owned-run", "recovered": True})
    assert reconciled["receipt"]["run_id"] == "owned-run"
    event = {"kind": "human.supplement", "payload": {"message": "reuse existing email service", "token": secret},
             "event_id": "backend-source-1", "cursor": 1, "actor": "human"}
    ingested = store.ingest_events("multica", [event])
    assert store.ingest_events("multica", [event])[0]["sequence"] == ingested[0]["sequence"]
    with pytest.raises(ConflictError):
        store.ingest_events("multica", [{**event, "payload": {"message": "changed retry"}}])
    with pytest.raises(CursorGapError):
        store.ingest_events("multica", [{**event, "event_id": "backend-source-3", "cursor": 3}])
    assert store.source_cursor("multica") == 1
    artifact = store.write_artifact("runs/owned-run/result.md", "confirmed result\n", media_type="text/markdown", base_sha=git(repository, "rev-parse", "HEAD"))
    store.append_event("result.received", {"run_id": "owned-run", "status": "delivered"}, artifacts=[artifact["artifact_id"]])
    # A different process exits without SQLite close after committing WAL pages.
    child = subprocess.run([sys.executable, "-c",
                            "import os,sys; from muxpilot.store import JournalStore; s=JournalStore(sys.argv[1],sys.argv[2]); s.append_event('worker.progress',{'checkpoint':'committed-before-process-crash'}); os._exit(73)",
                            str(root), project], capture_output=True, check=False)
    assert child.returncode == 73, child.stderr
    assert any(item["payload"].get("checkpoint") == "committed-before-process-crash" for item in store.events())
    settings = store.status()
    assert settings["journal_mode"] == "wal"
    assert settings["synchronous"] == 2
    assert Path(str(store.path) + "-wal").stat().st_size > 0
    backup = store.backup()
    with sqlite3.connect(Path(backup["path"]) / "journal.sqlite3") as copied:
        assert copied.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert copied.execute("SELECT COUNT(*) FROM events WHERE kind='worker.progress'").fetchone()[0] == 1
    restored = JournalStore.restore(backup["path"], tmp_path / "restored")
    assert restored.status()["lease_active"] is False
    assert restored.source_cursor("multica") == 1
    assert restored.verify_artifacts()[0]["status"] == "ok"
    assert restored.events()[-1]["payload"]["external_reconciliation_required"] is True
    restored.close()
    original = store.project_dir / artifact["path"]
    original.write_text("corrupt bytes\n")
    assert store.verify_artifacts()[0]["status"] == "corrupt"
    export = store.export_audit()
    assert export["complete"] is False
    assert export["artifacts"][0]["status"] == "corrupt"
    exported = Path(export["path"])
    assert secret not in (exported / "events.jsonl").read_text()
    assert secret not in (exported / "status.md").read_text()
    original.unlink()
    assert store.verify_artifacts()[0]["status"] == "missing"
    assert store.path.stat().st_mode & 0o077 == 0
    assert store.project_dir.stat().st_mode & 0o077 == 0
    store.close()


@pytest.mark.skipif(not os.environ.get("MUXPILOT_PAIRED_CONFIG"), reason="opt-in actual Multica daemon fixture; synthetic provider only")
def test_paired_multica_daemon_three_workers_stage_steering_resume_integration(
    repository: Path, local_stack: LocalStack,
) -> None:
    """Actual backend/daemon and wrapper; fake RPC planner/provider is explicit."""
    from muxpilot.config import Config
    from muxpilot.multica import MulticaClient
    from muxpilot.project import credential_for
    from muxpilot.service import ServiceError, request
    from muxpilot.store import JournalStore

    operator = json.loads(Path(os.environ["MUXPILOT_PAIRED_CONFIG"]).read_text())
    stack = local_stack
    state = stack.root / "projects"
    token = stack.root / "multica-pat"
    token.write_text(operator["token"] + "\n")
    token.chmod(0o600)
    checkpoints = Path("/tmp/muxpilot-deployment/paired/checkpoints")
    checkpoints.mkdir(parents=True, exist_ok=True, mode=0o700)
    base_worker = Path("/tmp/muxpilot-deployment/paired-worker.json")
    base_worker.write_text(json.dumps({"state_root": str(state)}))
    base_worker.chmod(0o600)
    configuration = {"state_root": str(state), "socket_path": str(stack.service_socket),
                     "multica_url": operator["server_url"], "multica_ui_url": operator["app_url"],
                     "multica_token_file": str(token), "multica_workspace_id": operator["workspace_id"],
                     "multica_workspace_slug": operator.get("workspace_slug"),
                     "runtime_profile_id": operator["runtime_profile_id"], "daemon_id": operator["daemon_id"],
                     "muxdeck_url": stack.url, "muxdeck_token_file": str(stack.token_file),
                     "worker_limit": 3, "lease_seconds": 600}
    config_path = stack.root / "paired-config.json"
    config_path.write_text(json.dumps(configuration))
    config_path.chmod(0o600)
    config = Config.load(config_path)
    service = stack.launch([sys.executable, "-m", "muxpilot.service", "--config", str(config_path)])
    wait_until(stack.service_socket.exists)
    wait_until((state / "control.key").exists)
    activation = stack.root / "activation.json"
    main_program = """
import json, os, pathlib, signal, sys
from muxpilot.config import Config
from muxpilot.project import credential_for
from muxpilot.service import request
config = Config.load(sys.argv[1])
result = request(config.socket_path, 'start', {'repo':sys.argv[2], 'goal':'Add password reset API and UI, verify the integrated goal, and deliver its tested commit.', 'owner':'paired-main', 'main_session':'main', '_credential':credential_for(config,'start')})
pathlib.Path(sys.argv[3]).write_text(json.dumps({'activation':result,'pid':os.getpid()}))
signal.pause()
"""
    main_target = stack.inventory()["main"] + ":0"
    subprocess.run([*stack.tmux, "set-option", "-w", "-t", main_target, "remain-on-exit", "on"], check=True)
    subprocess.run([*stack.tmux, "respawn-pane", "-k", "-t", main_target, shlex.join([sys.executable, "-c", main_program, str(config_path), str(repository), str(activation)])], check=True)
    wait_until(activation.exists, timeout=30)
    main = json.loads(activation.read_text())
    started = main["activation"]
    project = started["project"]["project_id"]
    before_sessions = stack.inventory()
    human = MulticaClient(operator["server_url"], token, workspace_id=operator["workspace_id"])

    def tool(tool_action: str, **payload: Any) -> dict[str, Any]:
        return request(config.socket_path, tool_action, {"project": project, "_credential": credential_for(config, tool_action, project), **payload})

    def paired_cleanup() -> None:
        from muxpilot.project import ACTIVE_RUN_STATUSES
        tool("hold", held=True)
        snapshot = tool("status")["backend"]
        controls = []
        for run in snapshot.get("runs", []):
            if run.get("status") in ACTIVE_RUN_STATUSES:
                controls.append({"run_id": run["id"], "receipt": tool("control", action="cancel", run=run["id"], message="Scoped paired fixture cleanup")})
        path = stack.root / "paired-cleanup.json"
        path.write_text(json.dumps({"project_id": project, "controls": controls}, indent=2))
        path.chmod(0o600)

    stack.finalizers.append(paired_cleanup)

    def ready_workers() -> list[dict[str, Any]]:
        assert stack.processes[0].poll() is None, "isolated Muxdeck exited before worker checkpoint; inspect process-0.log"
        assert service.poll() is None, "isolated projectd exited before worker checkpoint"
        found = []
        for path in checkpoints.glob("*.ready.json"):
            item = json.loads(path.read_text())
            if item.get("project_id") == project:
                found.append(item)
        return found

    def task(title: str, filename: str, content: str) -> dict[str, Any]:
        return {"title": title, "agent_id": operator["agent_id"],
                "description": "Deterministic provider fixture; real Git effect after release.\nMUXPILOT_FIXTURE_FILE=" + filename + "\nMUXPILOT_FIXTURE_BASE64=" + base64.b64encode(content.encode()).decode(),
                "acceptance": "Commit the requested fixture file and verify the integrated password-reset goal."}

    criteria = ["password reset API and UI use the existing email service", "integrated goal check passes"]
    plan = {"completion_criteria": criteria, "stages": [
        {"stage": 1, "tasks": [task("Password reset API", "api.py", "def reset_token(user):\n    return 'reset-' + user\n"),
                                task("Password reset UI", "ui.py", "from api import reset_token\ndef reset_view(user):\n    return {'token': reset_token(user), 'email_service': 'existing'}\n")]},
        {"stage": 2, "tasks": [task("Verify integrated password reset", "goal_check.py", "from ui import reset_view\nassert reset_view('shop') == {'token': 'reset-shop', 'email_service': 'existing'}\n")]},
    ]}
    planned = tool("plan", plan=plan)
    assert len(planned["tasks"]) == 3
    snapshot = tool("status")["backend"]
    assert snapshot["runs"] == []
    assert all(issue["status"] == "backlog" and issue["eligible"] is False for issue in snapshot["issues"])
    with pytest.raises(ServiceError):
        tool("activate", stage=2)
    stage1 = tool("activate", stage=1)
    assert len(stage1["task_ids"]) == 2
    workers = wait_until(lambda: ready_workers() if len(ready_workers()) == 2 else None, timeout=60)
    assert all(Path(worker["cwd"]).resolve() != repository.resolve() for worker in workers), "daemon dispatched against original source instead of isolated worktree"
    assert len({worker["cwd"] for worker in workers}) == 2
    assert len({worker["execution_id"] for worker in workers}) == 2
    assert {worker["run_id"] for worker in workers} == set(stage1["task_ids"])
    snapshot = tool("status")["backend"]
    assert not any(run["issue_id"] == planned["tasks"][2]["issue_id"] for run in snapshot["runs"])
    supplement_id = str(uuid.uuid4())
    supplement_route = "/api/issues/" + workers[0]["task_id"] + "/tasks/" + workers[0]["run_id"] + "/supplements"
    supplement = human.request("POST", supplement_route,
                               {"client_request_id": supplement_id, "content": "Reuse our existing email service."})
    repeated = human.request("POST", supplement_route,
                             {"client_request_id": supplement_id, "content": "Reuse our existing email service."})
    assert repeated["id"] == supplement["id"]
    def delivered() -> Any:
        comments = human.request("GET", "/api/issues/" + workers[0]["task_id"] + "/comments")
        comments = comments.get("comments", []) if isinstance(comments, dict) else comments
        return next((item for item in comments if item.get("id") == supplement["id"] and item.get("supplement_status") == "delivered"), None)
    assert wait_until(delivered, timeout=30)
    old_credential = credential_for(config, "hold", project)
    os.kill(main["pid"], signal.SIGKILL)
    for worker in workers:
        os.kill(worker["pid"], 0)
    resumed = tool("resume", owner="paired-main-replacement", takeover=True)
    assert resumed["generation"] > started["generation"]
    assert resumed["duplicate_dispatch"] is False
    with pytest.raises(ServiceError, match="credential|authority|expired"):
        request(config.socket_path, "hold", {"project": project, "held": True, "_credential": old_credential})
    integration = None
    for worker in workers:
        (checkpoints / (worker["execution_id"] + ".release")).touch()
        result_path = checkpoints / (worker["execution_id"] + ".result.json")
        wait_until(result_path.exists, timeout=30)
        result = json.loads(result_path.read_text())
        assert result["status"] == "completed" and result["commit"]
        wait_until(lambda worker=worker: next((run for run in tool("status")["backend"]["runs"] if run["id"] == worker["run_id"] and run["status"] in {"completed", "succeeded"}), None), timeout=30)
        unit_command = [sys.executable, "-B", "-c", "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", result["file"]]
        unit_check = subprocess.run(unit_command, cwd=worker["cwd"], capture_output=True, check=False)
        assert unit_check.returncode == 0, unit_check.stderr
        # The native worktree and source must share this verified commit identity.
        assert git(repository, "cat-file", "-t", result["commit"]) == "commit"
        tool("accept", issue=worker["task_id"], evidence={"run_id": worker["run_id"], "revision": result["commit"], "checks": [{"command": "python -B parse committed worker fixture file", "passed": True, "revision": result["commit"]}]})
        integration = tool("integrate", commit=result["commit"], base=stage1["base_sha"])
        assert integration["status"] == "integrated"
    assert integration is not None
    stage2 = tool("activate", stage=2)
    assert len(stage2["task_ids"]) == 1
    third = wait_until(lambda: next((worker for worker in ready_workers() if worker["run_id"] in stage2["task_ids"]), None), timeout=60)
    assert git(Path(third["cwd"]), "rev-parse", "HEAD") == integration["integration_sha"]
    (checkpoints / (third["execution_id"] + ".release")).touch()
    third_result_path = checkpoints / (third["execution_id"] + ".result.json")
    wait_until(third_result_path.exists, timeout=30)
    third_result = json.loads(third_result_path.read_text())
    wait_until(lambda: next((run for run in tool("status")["backend"]["runs"] if run["id"] == third["run_id"] and run["status"] in {"completed", "succeeded"}), None), timeout=30)
    third_check = subprocess.run([sys.executable, "-B", "goal_check.py"], cwd=third["cwd"], capture_output=True, check=False)
    assert third_check.returncode == 0, third_check.stderr
    tool("accept", issue=third["task_id"], evidence={"run_id": third["run_id"], "revision": third_result["commit"], "checks": [{"command": "python -B goal_check.py", "passed": True, "revision": third_result["commit"]}]})
    final = tool("integrate", commit=third_result["commit"], base=stage2["base_sha"])
    check = subprocess.run([sys.executable, "-B", "goal_check.py"], cwd=final["path"], capture_output=True, check=False)
    assert check.returncode == 0, check.stderr
    with pytest.raises(ServiceError):
        tool("close", evidence={"revision": final["integration_sha"]})
    evidence = {"revision": final["integration_sha"], "checks": [{"command": "python -B goal_check.py", "passed": True, "revision": final["integration_sha"]}],
                "completion_criteria": criteria, "deliverable": {"kind": "commit", "revision": final["integration_sha"]}}
    closed = tool("close", evidence=evidence)
    assert closed["status"] == "closed"
    events = tool("events")["events"]
    assert any(supplement["id"] in json.dumps(event["payload"]) for event in events)
    status = tool("status")
    assert len(status["backend"]["runs"]) == 3
    for run in status["backend"]["runs"]:
        assert run["terminal_url"] and run["session_id"]
    with JournalStore(state, project) as journal:
        for path in (state / project / "runs").glob("*/executions/*/session.json"):
            binding = json.loads(path.read_text())
            journal.write_artifact("artifacts/" + binding["execution_id"] + "-session.json", json.dumps(binding))
    audit = tool("audit")
    assert audit["complete"] is True
    assert stack.inventory()["unrelated"] == before_sessions["unrelated"]
    assert (repository / "unrelated.txt").read_text() == "private unrelated work\n"
    report = {"passed": True, "mode": "actual Multica backend/daemon; deterministic fake Codex RPC provider; scripted coordinator tools",
              "project_id": project, "start": started, "resume": resumed, "runs": status["backend"]["runs"],
              "human_supplement_id": supplement["id"], "integration": final, "closure": closed, "audit": audit,
              "limitations": ["No authenticated real provider or natural-language autonomous reasoning", "No browser UI assertion or external PR created"]}
    (stack.root / "paired-report.json").write_text(json.dumps(report, indent=2))
    (stack.root / "paired-report.json").chmod(0o600)
    assert service.poll() is None
