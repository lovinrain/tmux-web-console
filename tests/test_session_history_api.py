from __future__ import annotations

import asyncio
import os
import subprocess
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.app import create_app
from tmux_console.tmux import TmuxClient


class References(AgentReferenceDetector):
    async def detect_sessions(self, sessions):
        return {s.name: AgentReference("copilot", "reference-only-agent-id") for s in sessions}


@pytest.mark.asyncio
async def test_explicit_shell_recreation_works_without_a_running_tmux_server(tmp_path):
    socket = f"muxdeck-history-empty-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    try:
        assert await tmux.list_sessions() == []
        created = await tmux.create_shell_session("explicit-restored-shell", str(tmp_path))
        restored = await tmux.get_session(created.name)
        assert restored.active_pane.path == str(tmp_path)
        assert not restored.active_pane.dead
    finally:
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)


@pytest.mark.asyncio
async def test_recycle_history_workspace_close_end_and_safe_restore(tmp_path):
    socket = f"muxdeck-history-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    client = TestClient(TestServer(create_app(tmux=tmux, agent_references=References(), base_path="")))
    try:
        await client.start_server()
        source = await tmux.create_session("named-history", start_directory=str(tmp_path))
        await tmux.create_session("sentinel", start_directory=str(tmp_path))
        await client.get("/api/sessions")
        original = await tmux.get_session(source.name)
        response = await client.post("/api/workspaces", json={"name": "Original project", "tabs": [source.name], "activeSession": source.name, "groups": []})
        assert response.status == 201
        workspace = (await response.json())["workspace"]
        async def history():
            response = await client.get("/api/session-history", params={"workspace": workspace["id"]})
            assert response.status == 200
            return (await response.json())["entries"]
        entries = await history()
        assert len(entries) == 1
        entry = entries[0]
        assert entry["agentSessionId"] == "reference-only-agent-id"
        response = await client.post("/api/session-history/close-tab", json={"session": source.name, "sessionId": source.id})
        assert response.status == 204
        assert (await tmux.get_session(source.name)).id == source.id
        response = await client.post(f'/api/workspaces/{workspace["id"]}/activity', json={"tabs": [], "activeSession": None, "sessionRevision": workspace["sessionRevision"]})
        assert response.status == 200
        entries = await history()
        assert entries[0]["workspaces"][0]["present"] is False
        assert entries[0]["tabClosedAt"] is not None
        restore_url = f'/api/session-history/{entry["id"]}/restore'
        response = await client.post(restore_url, json={"create": False})
        assert response.status == 200
        assert (await response.json())["sessionId"] == source.id
        terminate = {"sessionId": source.id, "sessionCreated": original.created, "serverStarted": original.server_started, "serverPid": original.server_pid}
        response = await client.delete(f"/api/sessions/{source.name}", json=terminate)
        assert response.status == 204
        entries = await history()
        assert entries[0]["state"] == "ended"
        assert entries[0]["workspaces"][0]["name"] == "Original project"
        assert entries[0]["agentSessionId"] == "reference-only-agent-id"
        response = await client.post(restore_url, json={"create": False})
        assert response.status == 409
        assert len(await tmux.list_sessions()) == 1
        replacement = await tmux.create_session(source.name, start_directory=str(tmp_path))
        response = await client.post(restore_url, json={"create": True})
        assert response.status == 409
        assert (await tmux.get_session(source.name)).id == replacement.id
        current = await tmux.get_session(source.name)
        await tmux.terminate_session(current.id, current.created, current.server_started, current.server_pid)
        await client.get("/api/session-history")
        await tmux.run(["set-option", "-g", "default-command", "printf AGENT_MUST_NOT_BE_LAUNCHED"])
        response = await client.post(restore_url, json={"create": True})
        assert response.status == 201, await response.text()
        restored = await response.json()
        assert restored["session"] == source.name
        assert restored["sessionId"] not in {source.id, replacement.id}
        assert (await tmux.get_session(source.name)).active_pane.path == str(tmp_path)
        assert (await history())[0]["id"] == entry["id"]
        response = await client.get("/api/session-history", params={"q": source.name})
        assert len((await response.json())["entries"]) == 3
        response = await client.get("/api/session-history", params={"offset": "-1"})
        assert response.status == 400
        response = await client.post(restore_url, json={})
        assert response.status == 400
        response = await client.post("/api/session-history/does-not-exist/restore", json={"create": True})
        assert response.status == 404
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)
