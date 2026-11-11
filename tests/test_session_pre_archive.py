from __future__ import annotations

import asyncio
import os
import subprocess
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.app import create_app
from tmux_console.fold_recovery import session_fence
from tmux_console.metadata import SessionTitleStore
from tmux_console.session_registry import SessionRegistry, SessionRegistryUnavailable
from tmux_console.tmux import TmuxClient, TmuxError
from tmux_console.workspaces import WorkspaceStore

AGENT_ID = "12345678-1234-1234-1234-123456789012"


class References(AgentReferenceDetector):
    async def detect_sessions(self, sessions):
        return {s.name: AgentReference("codex", AGENT_ID) for s in sessions if s.name == "parent"}


@pytest.fixture
async def pre_archive_env(tmp_path):
    socket = f"muxdeck-pre-archive-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    registry = SessionRegistry(tmp_path / "sessions.sqlite3")
    workspaces = WorkspaceStore(tmp_path / "workspaces.json")
    titles = SessionTitleStore(tmp_path / "titles.json")
    client = TestClient(TestServer(create_app(
        tmux=tmux, session_registry=registry, workspaces=workspaces,
        titles=titles, agent_references=References(), base_path="/mux",
    )))
    try:
        for name in ("parent", "child", "sentinel"):
            await tmux.create_shell_session(name, str(tmp_path))
        titles.set_title("parent", "Saved work")
        workspaces.create_workspace(name="First", tabs=["parent", "child", "sentinel"],
                                    parents={"child": "parent"}, active_session="parent")
        workspaces.create_workspace(name="Second", tabs=["sentinel", "parent"], active_session="sentinel")
        await client.start_server()
        target = await tmux.get_session("parent")
        payload = session_fence(target)
        payload.pop("name")
        yield tmux, registry, workspaces, client, target, payload, workspaces.list_workspaces()
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"],
                                check=False, capture_output=True)


@pytest.mark.parametrize("only_session", [False, True])
async def test_pre_archive_saves_metadata_before_closure_keeps_tabs_and_recreates_only_a_shell(pre_archive_env, tmp_path, monkeypatch, only_session):
    tmux, registry, workspaces, client, target, payload, saved_workspaces = pre_archive_env
    if only_session:
        for session in await tmux.list_sessions():
            if session.name != target.name:
                await tmux.terminate_session(session.id, session.created, session.server_started, session.server_pid)
    await tmux.run(["set-option", "-g", "default-command", "printf MUST_NOT_RUN_AN_AGENT"])
    unaffected = {s.name: s.identity for s in await tmux.list_sessions() if s.name != target.name}
    terminate = tmux.terminate_session

    async def guarded_terminate(*identity):
        durable = SessionRegistry(registry.path)
        record = durable.get_recovery_for_identity(target.name, *identity)
        assert record.directory == str(tmp_path)
        assert (record.agent_type, record.agent_session_id) == ("codex", AGENT_ID)
        history = durable.list_history(session_name=target.name)["entries"][0]
        assert history["title"] == "Saved work"
        durable.close()
        assert workspaces.list_workspaces() == saved_workspaces
        await terminate(*identity)

    monkeypatch.setattr(tmux, "terminate_session", guarded_terminate)
    url = "/mux/api/sessions/parent/pre-archive"
    response = await client.post(url, json=payload)
    assert response.status == 200, await response.text()
    recovery = (await response.json())["recovery"]
    assert recovery["preArchived"] is True
    assert recovery["agentSessionId"] == AGENT_ID
    assert {s.name: s.identity for s in await tmux.list_sessions()} == unaffected
    assert workspaces.list_workspaces() == saved_workspaces

    repeated = await client.post(url, json=payload)
    assert repeated.status == 200
    assert (await repeated.json())["recovery"] == recovery
    reopened = SessionRegistry(registry.path)
    assert reopened.reconcile(await tmux.list_sessions())[0].to_dict() == recovery
    reopened.close()
    inventory = await (await client.get("/mux/api/sessions")).json()
    assert inventory["recoverableSessions"] == [recovery]

    response = await client.post(f'/mux/api/recoverable-sessions/{recovery["id"]}/recreate', json={})
    assert response.status == 201, await response.text()
    restored = await tmux.get_session(target.name)
    assert restored.identity != target.identity and restored.active_pane.path == str(tmp_path)
    assert not restored.active_pane.dead
    assert workspaces.list_workspaces() == saved_workspaces
    inventory = await (await client.get("/mux/api/sessions")).json()
    assert inventory["recoverableSessions"] == []
    # A retry cannot close the replacement that now owns this name.
    assert (await client.post(url, json=payload)).status == 409
    assert (await tmux.get_session(target.name)).identity == restored.identity


@pytest.mark.parametrize("failure", ["storage", "tmux"])
async def test_pre_archive_failures_leave_the_live_session_and_its_tab_available(pre_archive_env, monkeypatch, failure):
    tmux, registry, workspaces, client, target, payload, saved_workspaces = pre_archive_env

    def fail_storage(*args, **kwargs):
        raise SessionRegistryUnavailable("simulated full disk")

    async def fail_tmux(*args):
        raise TmuxError("simulated closure failure")

    if failure == "storage":
        monkeypatch.setattr(registry, "record_history_titles", fail_storage)
    else:
        monkeypatch.setattr(tmux, "terminate_session", fail_tmux)
    response = await client.post("/mux/api/sessions/parent/pre-archive", json=payload)
    assert response.status == 503
    assert (await tmux.get_session(target.name)).identity == target.identity
    assert workspaces.list_workspaces() == saved_workspaces
    assert registry.reconcile(await tmux.list_sessions()) == []


async def test_missing_session_is_not_silently_pre_archived(pre_archive_env):
    tmux, _registry, _workspaces, client, target, payload, _saved = pre_archive_env
    await client.get("/mux/api/sessions")
    await tmux.terminate_session(target.id, target.created, target.server_started, target.server_pid)
    response = await client.post("/mux/api/sessions/parent/pre-archive", json=payload)
    assert response.status == 409
    inventory = await (await client.get("/mux/api/sessions")).json()
    assert not inventory["recoverableSessions"][0].get("preArchived")
