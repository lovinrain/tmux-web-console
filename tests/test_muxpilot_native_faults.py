"""Opt-in native process fault drill, isolated from operational Multica/Muxdeck.

Requires a freshly bootstrapped dedicated API/database/daemon/profile and fake
provider; never accepts the paired demonstration profile. Default CI skips it.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.request import urlopen

import pytest
from test_muxpilot_e2e import LocalStack, wait_until
from test_muxpilot_e2e import (
    local_stack as local_stack,  # noqa: PLC0414 -- pytest fixture reexport
)
from test_muxpilot_e2e import (
    repository as repository,  # noqa: PLC0414 -- pytest fixture reexport
)

from muxpilot.config import Config
from muxpilot.multica import MulticaClient, MulticaError
from muxpilot.project import credential_for
from muxpilot.service import request
from muxpilot.store import JournalStore

pytestmark = pytest.mark.skipif(not os.environ.get("MUXPILOT_NATIVE_FAULT_CONFIG"),
    reason="dedicated native API/database/daemon fault fixture; deterministic fake only")


def process_alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()[0]
        return state != "Z"
    except FileNotFoundError:
        return False


def clean_environment() -> dict[str, str]:
    env = dict(os.environ)
    for key in tuple(env):
        if key.startswith("MULTICA_"):
            env.pop(key)
    return env


def native_status(operator: dict[str, Any]) -> dict[str, Any]:
    raw = subprocess.check_output([str(Path(operator["checkout"]) / "server/bin/multica"),
        "daemon", "status", "--profile", operator["profile"], "--output", "json"], env=clean_environment())
    return json.loads(raw)


def restart_component(operator: dict[str, Any], component: str) -> None:
    # This checkout has a separate registry, DB, port and profile. The existing
    # paired/native-account fixture cannot be selected by incoming configuration.
    subprocess.run(["make", "up", "C=" + component], cwd=operator["checkout"],
        env=clean_environment(), check=True, timeout=180, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)


def health(operator: dict[str, Any]) -> dict[str, Any] | None:
    try:
        with urlopen(operator["server_url"] + "/health", timeout=1) as response:
            return json.loads(response.read())
    except OSError:
        return None


def test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker(
    repository: Path, local_stack: LocalStack,
) -> None:
    operator = json.loads(Path(os.environ["MUXPILOT_NATIVE_FAULT_CONFIG"]).read_text())
    assert operator["profile"].startswith("dev-multica_muxpilot_fault_drill-")
    assert operator["checkout"] == "/root/git_farm/multica-muxpilot-fault-drill"
    assert operator["server_url"] == "http://localhost:18902"
    stack = local_stack
    state = stack.root / "projects"
    base_worker = Path(operator["worker_config"])
    base_worker.write_text(json.dumps({"state_root": str(state)}))
    base_worker.chmod(0o600)
    token = stack.root / "native-pat"
    token.write_text(operator["token"] + "\n")
    token.chmod(0o600)
    config_path = stack.root / "native-config.json"
    config_path.write_text(json.dumps({"state_root": str(state), "socket_path": str(stack.service_socket),
        "multica_url": operator["server_url"], "multica_ui_url": operator["app_url"],
        "multica_token_file": str(token), "multica_workspace_id": operator["workspace_id"],
        "multica_workspace_slug": operator["workspace_slug"], "runtime_profile_id": operator["runtime_profile_id"],
        "daemon_id": operator["daemon_id"], "muxdeck_url": stack.url,
        "muxdeck_token_file": str(stack.token_file), "worker_limit": 1, "lease_seconds": 600}))
    config_path.chmod(0o600)
    config = Config.load(config_path)
    service = stack.launch([sys.executable, "-m", "muxpilot.service", "--config", str(config_path)])
    wait_until(stack.service_socket.exists)
    wait_until((state / "control.key").exists)
    started = request(config.socket_path, "start", {"repo": str(repository),
        "goal": "Observe isolated native daemon and API fault recovery using a fake provider.",
        "owner": "native-fault-main", "main_session": "main", "_credential": credential_for(config, "start")})
    project = started["project"]["project_id"]

    def tool(action: str, **payload: Any) -> dict[str, Any]:
        return request(config.socket_path, action, {"project": project,
            "_credential": credential_for(config, action, project), **payload})

    plan = tool("plan", plan={"completion_criteria": ["Exact worker fate is observed without duplicate launch"],
        "stages": [{"stage": 1, "tasks": [{"title": "Native fault checkpoint", "agent_id": operator["agent_id"],
            "description": "Wait at the explicit deterministic fake-provider checkpoint.",
            "acceptance": "Record process identities and reconnect state."}]}]})
    activated = tool("activate", stage=1)
    run_id = activated["task_ids"][0]
    checkpoints = Path(operator["checkpoints"])
    def worker_checkpoint():
        return next((json.loads(path.read_text()) for path in checkpoints.glob("*.ready.json")
            if json.loads(path.read_text()).get("project_id") == project), None)
    worker = wait_until(worker_checkpoint, timeout=90)
    assert worker["run_id"] == run_id
    assert process_alive(worker["pid"])
    report_path = Path(os.environ.get("MUXPILOT_NATIVE_FAULT_REPORT", str(stack.root / "native-fault-report.json")))
    progress_path = report_path.with_name(report_path.stem + "-progress.json")
    progress: list[dict[str, Any]] = []
    def record(phase: str, **details: Any) -> None:
        progress.append({"phase": phase, "observed_at": time.time(), **details})
        progress_path.write_text(json.dumps(progress, indent=2))
        progress_path.chmod(0o600)
    record("provider_checkpoint", project_id=project, run_id=run_id, execution_id=worker["execution_id"], provider_pid=worker["pid"])
    daemon_before = native_status(operator)
    assert daemon_before["status"] == "running"
    assert daemon_before["pid"] != service.pid
    assert Path(f"/proc/{daemon_before['pid']}/exe").resolve() == Path(operator["checkout"]) / "server/bin/multica"
    before_sessions = stack.inventory()
    before_feed = tool("events")
    with JournalStore(state, project) as store:
        cursor_before = store.source_cursor("multica")
    credentials = json.loads((state / project / "coordinator.json").read_text())
    backend = MulticaClient(operator["server_url"], token=credentials["token"],
        generation=credentials["remote_generation"], workspace_id=operator["workspace_id"], timeout=2)
    backend_project = credentials["multica_project_id"]
    hold_operation = str(uuid.uuid4())
    hold_payload = {"action": "hold", "held": True, "operation_id": hold_operation}
    committed = backend.command(backend_project, hold_payload)
    api_before = health(operator)
    assert api_before is not None
    assert api_before["pid"] != daemon_before["pid"]
    assert Path(f"/proc/{api_before['pid']}/exe").resolve().name == "server"
    os.kill(api_before["pid"], signal.SIGKILL)
    wait_until(lambda: health(operator) is None)
    degraded = tool("events")
    assert degraded["degraded"]
    with JournalStore(state, project) as store:
        assert store.source_cursor("multica") == cursor_before
    with pytest.raises(MulticaError):
        backend.command(backend_project, {**hold_payload, "operation_id": str(uuid.uuid4())})
    api_outage_worker_alive = process_alive(worker["pid"])
    assert process_alive(daemon_before["pid"])
    assert process_alive(service.pid)
    record("api_outage", api_pid=api_before["pid"], daemon_pid=daemon_before["pid"], provider_alive=api_outage_worker_alive, feed_degraded=bool(degraded["degraded"]))
    restart_component(operator, "api")
    api_after = wait_until(lambda: health(operator), timeout=60)
    assert api_after["pid"] != api_before["pid"]
    assert backend.operation(backend_project, hold_operation) == {"status": 200, "response": committed}
    assert backend.command(backend_project, hold_payload) == committed
    recovered = tool("events")
    assert recovered["degraded"] is None
    native_feed = backend.events(backend_project, 0)
    assert native_feed["retention_gap"] is False
    assert native_feed["page_complete"] is True
    assert sum(event.get("payload", {}).get("operation_id") == hold_operation for event in native_feed["events"]) == 1
    with JournalStore(state, project) as store:
        imported = [event for event in store.events() if event["source"] == "multica"]
        source_ids = [event["source_event_id"] for event in imported]
        assert len(source_ids) == len(set(source_ids))
        assert {event["source_event_id"] for event in before_feed["events"] if event["source"] == "multica"}.issubset(set(source_ids))
        assert store.source_cursor("multica") >= cursor_before
    # Observe the selected provider's actual fate, without assuming daemon loss
    # preserves it. The daemon owns its stdio; SIGKILL closes those handles.
    record("api_recovered", old_api_pid=api_before["pid"], new_api_pid=api_after["pid"], operation_id=hold_operation, source_event_count=len(source_ids))
    os.kill(daemon_before["pid"], signal.SIGKILL)
    wait_until(lambda: not process_alive(daemon_before["pid"]))
    restart_component(operator, "daemon")
    daemon_after = native_status(operator)
    assert daemon_after["status"] == "running"
    assert daemon_after["pid"] != daemon_before["pid"]
    # Read-only backend recovery may retain an unfinished attempt while its
    # provider outcome is unknown. No resume/continue command is issued here.
    snapshot = backend.snapshot(backend_project)
    old_worker_alive = process_alive(worker["pid"])
    matching = [run for run in snapshot["runs"] if run["id"] == run_id]
    assert len(matching) == 1
    ready = [json.loads(path.read_text()) for path in checkpoints.glob("*.ready.json")]
    current = [item for item in ready if item.get("project_id") == project]
    live = [item for item in current if process_alive(item["pid"])]
    assert len(live) <= 1, "daemon restart started a second live fake provider for one attempt"
    assert snapshot["dispatch_held"] is True
    human = MulticaClient(operator["server_url"], token=operator["token"], workspace_id=operator["workspace_id"])
    history = human.request("GET", "/api/issues/" + matching[0]["issue_id"] + "/task-runs")
    history = history.get("tasks", []) if isinstance(history, dict) else history
    retries = [item for item in history if item["id"] != run_id]
    for retry in retries:
        assert retry["parent_task_id"] == run_id
        assert retry["status"] == "queued"
        assert retry.get("started_at") is None
    assert len(current) == 1, "held native retry acquired a new provider execution"
    assert old_worker_alive is False
    assert matching[0]["status"] in {"failed", "cancelled", "completed"}
    changed = tool("events")
    assert changed["degraded"] is None
    seen_tasks = {event["payload"].get("task_id") for event in changed["events"] if event["source"] == "multica"}
    assert {run["id"] for run in snapshot["runs"]}.issubset(seen_tasks)
    main_snapshot = tool("status")["backend"]
    assert {run["id"] for run in main_snapshot["runs"]} == {run["id"] for run in snapshot["runs"]}
    fate = "provider_alive" if old_worker_alive else "provider_stopped"
    if matching[0].get("status") not in {"completed", "failed", "cancelled"} and not old_worker_alive:
        fate = "provider_stopped_backend_outcome_uncertain"
    with JournalStore(state, project) as store:
        store.append_event("fault.daemon_observed", {"run_id": run_id, "execution_id": worker["execution_id"],
            "provider_pid": worker["pid"], "daemon_before_pid": daemon_before["pid"],
            "daemon_after_pid": daemon_after["pid"], "fate": fate, "run_status": matching[0].get("status")})
    report = {"passed": True, "mode": "actual isolated Multica API/database/daemon; deterministic fake RPC provider",
        "project_id": project, "run_id": run_id, "execution_id": worker["execution_id"],
        "api_before": api_before, "api_after": api_after, "daemon_before_pid": daemon_before["pid"],
        "daemon_after_pid": daemon_after["pid"], "provider_pid": worker["pid"],
        "api_outage_provider_alive": api_outage_worker_alive, "daemon_crash_fate": fate,
        "backend_run": matching[0], "main_pid": os.getpid(), "main_saw_attempt_ids": sorted(task for task in seen_tasks if isinstance(task, str)),
        "automatic_queued_retry": [{key: item.get(key) for key in ("id", "parent_task_id", "attempt", "max_attempts", "status", "started_at")} for item in retries],
        "native_retry_behavior": "Native runtime recovery may queue a distinct attempt with parent lineage; the dispatch hold prevents execution. No resume is issued.",
        "source_cursor_before": cursor_before,
        "source_event_count": len(source_ids), "hold_operation": hold_operation,
        "duplicate_live_provider_count": len(live), "execution_count_after_restart": len(current),
        "retention": "No native event-retention deletion exists; actual outage replay only. Synthetic gap behavior is tested separately.",
        "limits": "No real provider, host/power-loss, natural-language or forced retention-deletion claim.",
        "plan_issue_ids": [task["issue_id"] for task in plan["tasks"]]}
    output = Path(os.environ.get("MUXPILOT_NATIVE_FAULT_REPORT", str(stack.root / "native-fault-report.json")))
    output.write_text(json.dumps(report, indent=2))
    output.chmod(0o600)
    assert stack.inventory().get("unrelated") == before_sessions["unrelated"]
    # End only this dedicated fixture's queued/running run before local-stack
    # cleanup. API cancellation is a request; report never equates it to fate.
    for run in snapshot["runs"]:
        if run["status"] not in {"failed", "cancelled", "completed"}:
            backend.command(backend_project, {"action": "cancel", "task_id": run["id"], "operation_id": str(uuid.uuid4())})
