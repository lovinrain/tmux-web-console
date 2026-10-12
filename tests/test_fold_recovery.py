from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.app import create_app
from tmux_console.fold_recovery import agent_resume_argv, session_fence
from tmux_console.metadata import SessionTitleStore
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import TmuxClient, TmuxError
from tmux_console.workspaces import WorkspaceStore, WorkspaceStoreUnavailable

AGENT_ID = "12345678-1234-1234-1234-123456789012"


class References(AgentReferenceDetector):
    identifier = AGENT_ID

    async def detect_sessions(self, sessions):
        return {session.name: AgentReference("codex", self.identifier) for session in sessions if session.name == "a"}


@pytest.fixture
async def fold_env(tmp_path, monkeypatch):
    socket = f"muxdeck-fold-recovery-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    registry = SessionRegistry(tmp_path / "registry.sqlite3")
    store = WorkspaceStore(tmp_path / "workspaces.json")
    titles = SessionTitleStore(tmp_path / "titles.json")
    refs = References()
    client = TestClient(TestServer(create_app(tmux=tmux, session_registry=registry, workspaces=store,
                                             titles=titles, agent_references=refs, base_path="")))
    try:
        for name in ("root", "a", "child", "gap", "b", "sentinel"):
            await tmux.create_shell_session(name, str(tmp_path))
        titles.set_title("a", "Recorded title")
        workspace = store.create_workspace(name="Recoverable tree", tabs=["root", "a", "child", "gap", "b", "sentinel"],
                                           parents={"a": "root", "child": "a", "gap": "root", "b": "root"}, active_session="a")
        await client.start_server()
        await client.get("/api/sessions")
        confirmed = [session_fence(await tmux.get_session(name)) for name in ("a", "child", "b")]
        url = f'/api/workspaces/{workspace["id"]}/folds/saved'

        async def close():
            current = store.get_workspace(workspace["id"])
            return await client.post(f"{url}/close", json={"tabs": ["a", "b"], "sessions": confirmed,
                "sessionRevision": current["sessionRevision"], "expectedUpdatedAt": current["updatedAt"]})

        yield tmux, client, store, registry, workspace, url, confirmed, close, refs
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)


@pytest.mark.asyncio
async def test_metadata_is_durable_before_any_session_closes_and_survives_legacy_writes(fold_env, monkeypatch, tmp_path):
    tmux, _client, store, registry, workspace, _url, _confirmed, close, refs = fold_env
    sentinel = session_fence(await tmux.get_session("sentinel"))
    terminate = tmux.terminate_session
    seen = []

    async def guarded_terminate(*identity):
        document = json.loads(store.path.read_text())
        snapshots = document["workspaces"][0]["folds"][0]["closedSessions"]
        assert [item["name"] for item in snapshots] == ["a", "child", "b"]
        assert snapshots[0]["directory"] == str(tmp_path)
        assert snapshots[0]["title"] == "Recorded title"
        assert snapshots[0]["agentSessionId"] == refs.identifier
        assert all(item["historyId"] for item in snapshots)
        seen.append(identity[0])
        await terminate(*identity)

    monkeypatch.setattr(tmux, "terminate_session", guarded_terminate)
    refs.identifier = "87654321-1234-1234-1234-123456789012"
    response = await close()
    assert response.status == 200, await response.text()
    result = await response.json()
    assert result["failures"] == {}
    assert result["closed"] == ["a", "child", "b"]
    assert len(seen) == 3
    assert session_fence(await tmux.get_session("sentinel")) == sentinel
    saved = WorkspaceStore(store.path).get_workspace(workspace["id"])
    assert saved["tabs"] == workspace["tabs"] and saved["parents"] == workspace["parents"]
    assert saved["folds"][0]["closedSessions"][0]["agentSessionId"] == refs.identifier
    # Root-only older clients must preserve the server's recovery snapshot.
    legacy = store.record_activity(workspace["id"], tabs=saved["tabs"], active_session="sentinel", session_revision=0,
                                  folds=[{"id": "saved", "tabs": ["a", "b"]}], update_folds=True)
    assert legacy["folds"] == saved["folds"]
    recovered = registry.reconcile(await tmux.list_sessions())
    assert {record.name for record in recovered} >= {"a", "child", "b"}
    store.rename_session("a", "renamed")
    renamed = store.get_workspace(workspace["id"])
    assert renamed["folds"][0]["closedSessions"][0]["name"] == "renamed"


@pytest.mark.asyncio
async def test_storage_failure_never_closes_sessions(fold_env, monkeypatch):
    tmux, _client, store, _registry, _workspace, _url, _confirmed, close, _refs = fold_env
    before = {session.name: session_fence(session) for session in await tmux.list_sessions()}

    def fail(*args, **kwargs):
        raise WorkspaceStoreUnavailable("simulated full disk")

    monkeypatch.setattr(store, "update_workspace", fail)
    response = await close()
    assert response.status == 503
    assert {session.name: session_fence(session) for session in await tmux.list_sessions()} == before


@pytest.mark.asyncio
async def test_latest_identified_conversation_survives_a_later_unknown_agent_and_tied_timestamps(fold_env):
    tmux, _client, _store, registry, _workspace, _url, _confirmed, _close, _refs = fold_env
    target = await tmux.get_session("a")
    history_id = registry.observe_history(target, AgentReference("codex", AGENT_ID))
    timestamp = registry.get_history(history_id)["last_seen"]
    registry._clock = lambda: timestamp
    newer_id = "87654321-1234-1234-1234-123456789012"
    registry.observe_history(target, AgentReference("claude", newer_id))
    registry.observe_history(target, AgentReference("copilot", None))
    assert registry.latest_recorded_agent(history_id) == {"agentType": "claude", "agentSessionId": newer_id}


@pytest.mark.parametrize("changed", ["version", "identity", "descendants"])
@pytest.mark.asyncio
async def test_stale_or_incomplete_confirmation_is_fenced_before_closure(fold_env, changed):
    tmux, client, store, _registry, workspace, url, confirmed, _close, _refs = fold_env
    before = {session.name: session_fence(session) for session in await tmux.list_sessions()}
    current = store.get_workspace(workspace["id"])
    payload = {"tabs": ["a", "b"], "sessions": [dict(item) for item in confirmed],
               "sessionRevision": current["sessionRevision"], "expectedUpdatedAt": current["updatedAt"]}
    if changed == "version":
        payload["expectedUpdatedAt"] -= 1
    elif changed == "identity":
        payload["sessions"][0]["serverPid"] += 1
    else:
        payload["sessions"] = payload["sessions"][:1]
    response = await client.post(f"{url}/close", json=payload)
    assert response.status == (400 if changed == "descendants" else 409)
    assert {session.name: session_fence(session) for session in await tmux.list_sessions()} == before
    assert not store.get_workspace(workspace["id"]).get("folds")


@pytest.mark.asyncio
async def test_partial_close_can_retry_without_losing_metadata_or_repeating_closed_targets(fold_env, monkeypatch):
    tmux, _client, _store, _registry, _workspace, _url, confirmed, close, _refs = fold_env
    terminate = tmux.terminate_session
    attempts = []
    failed_id = confirmed[-1]["sessionId"]

    async def fail_once(*identity):
        attempts.append(identity[0])
        if identity[0] == failed_id and attempts.count(failed_id) == 1:
            raise TmuxError("simulated close failure")
        await terminate(*identity)

    monkeypatch.setattr(tmux, "terminate_session", fail_once)
    response = await close()
    result = await response.json()
    assert response.status == 200 and set(result["failures"]) == {"b"}
    snapshots = result["workspace"]["folds"][0]["closedSessions"]
    response = await close()
    assert response.status == 200, await response.text()
    retry = await response.json()
    assert retry["failures"] == {} and set(retry["closed"]) == {"a", "child", "b"}
    assert retry["workspace"]["folds"][0]["closedSessions"][:2] == snapshots[:2]
    assert attempts.count(confirmed[0]["sessionId"]) == 1
    assert attempts.count(failed_id) == 2


@pytest.mark.asyncio
async def test_shell_recovery_bypasses_default_command_and_response_retry_reuses_only_its_own_shell(fold_env, tmp_path):
    tmux, client, store, _registry, workspace, url, _confirmed, close, _refs = fold_env
    assert (await close()).status == 200
    await tmux.run(["set-option", "-g", "default-command", "printf UNEXPECTED_DEFAULT_COMMAND"])
    response = await client.post(f"{url}/recover", json={"session": "a", "mode": "shell"})
    assert response.status == 201, await response.text()
    restored = await response.json()
    session = await tmux.get_session("a")
    assert session.id == restored["sessionId"] and not session.active_pane.dead
    assert session.active_pane.path == str(tmp_path)
    assert session.active_pane.command in {"bash", "sh", "zsh", "fish", "dash"}
    retry = await client.post(f"{url}/recover", json={"session": "a", "mode": "shell"})
    assert retry.status == 200 and (await retry.json())["sessionId"] == restored["sessionId"]
    assert store.get_workspace(workspace["id"])["folds"]
    await tmux.create_shell_session("b", session.active_pane.path)
    other = session_fence(await tmux.get_session("b"))
    response = await client.post(f"{url}/recover", json={"session": "b", "mode": "shell"})
    assert response.status == 409
    assert session_fence(await tmux.get_session("b")) == other


@pytest.mark.asyncio
async def test_agent_recovery_uses_exact_saved_id_and_directory_without_typing_into_a_pane(fold_env, tmp_path, monkeypatch):
    tmux, client, _store, _registry, _workspace, url, _confirmed, close, _refs = fold_env
    assert (await close()).status == 200
    root = tmp_path / "native" / "sessions" / "2026" / "10" / "12"
    root.mkdir(parents=True)
    transcript = root / f"rollout-2026-10-12-{AGENT_ID}.jsonl"
    transcript.write_text(json.dumps({"type": "session_meta", "payload": {"id": AGENT_ID, "cwd": str(tmp_path), "source": "cli"}}) + "\n")
    from tmux_console.app import AGENT_TRANSCRIPTS_KEY
    client.app[AGENT_TRANSCRIPTS_KEY].roots["codex"] = tmp_path / "native"
    binary = tmp_path / "codex"
    marker = tmp_path / "agent-started.txt"
    binary.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > {shlex.quote(str(marker))}\npwd >> {shlex.quote(str(marker))}\nexec sleep 60\n")
    binary.chmod(0o700)
    monkeypatch.setattr("tmux_console.fold_recovery.shutil.which", lambda name: str(binary) if name == "codex" else None)
    response = await client.post(f"{url}/recover", json={"session": "a", "mode": "agent"})
    assert response.status == 201, await response.text()
    for _ in range(50):
        if marker.exists():
            break
        await asyncio.sleep(.01)
    assert marker.read_text().splitlines() == ["resume", AGENT_ID, str(tmp_path)]
    assert not (await tmux.get_session("a")).active_pane.dead


@pytest.mark.parametrize("unavailable", ["transcript", "cli", "unidentified"])
@pytest.mark.asyncio
async def test_unavailable_agent_recovery_leaves_the_session_closed_and_shell_recovery_available(fold_env, monkeypatch, unavailable):
    tmux, client, _store, _registry, _workspace, url, _confirmed, close, _refs = fold_env
    assert (await close()).status == 200
    monkeypatch.setattr("tmux_console.fold_recovery.shutil.which", lambda name: None if unavailable == "cli" else "/unused/codex")
    name = "b" if unavailable == "unidentified" else "a"
    response = await client.post(f"{url}/recover", json={"session": name, "mode": "agent"})
    assert response.status == 409, await response.text()
    assert name not in {session.name for session in await tmux.list_sessions()}
    response = await client.post(f"{url}/recover", json={"session": name, "mode": "shell"})
    assert response.status == 201


@pytest.mark.parametrize(("agent", "expected"), [
    ("claude", ["claude", "-r"]), ("codex", ["codex", "resume"]),
    ("cursor", ["cursor-agent", "--resume"]), ("grok", ["grok", "-r"]), ("copilot", None),
])
def test_resume_argv_supports_only_verified_commands_and_exact_identifiers(agent, expected):
    assert agent_resume_argv(agent, AGENT_ID) == ([*expected, AGENT_ID] if expected else None)
    assert agent_resume_argv(agent, "$(touch /tmp/injected)") is None
