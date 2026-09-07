from __future__ import annotations

import asyncio
import os
import subprocess
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.tmux import TmuxClient


@pytest.mark.asyncio
async def test_workspace_utility_shell_lifecycle_and_identity(tmp_path):
    socket = f"muxdeck-utility-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    key = "temporary:00000000-0000-0000-0000-000000000001"
    try:
        await client.start_server()
        source = await tmux.create_session("source", start_directory=str(tmp_path))
        original = await tmux.get_session(source.name)
        # A utility terminal must not inherit a default command that starts an agent.
        await tmux.run(["set-option", "-g", "default-command", "printf NOT_A_SHELL"])
        payload = {"workspaceKey": key, "sourceSession": source.name, "sourceSessionId": source.id, "create": False}
        response = await client.post("/api/utility-terminal", json=payload)
        assert response.status == 200
        assert await response.json() == {"terminal": None}
        assert len(await tmux.list_sessions()) == 1

        for changes in ({"workspaceKey": "bad"}, {"create": "yes"}, {"sourceSessionId": None}):
            response = await client.post("/api/utility-terminal", json={**payload, **changes})
            assert response.status == 400
        response = await client.post("/api/utility-terminal", json={**payload, "create": True, "sourceSessionId": "$999999"})
        assert response.status == 409

        responses = await asyncio.gather(*(
            client.post("/api/utility-terminal", json={**payload, "create": True}) for _ in range(3)
        ))
        bodies = [await response.json() for response in responses]
        assert all(response.status == 200 for response in responses), bodies
        terminals = [body["terminal"] for body in bodies]
        assert len({terminal["id"] for terminal in terminals}) == 1
        utility = terminals[0]
        assert utility["id"] != source.id
        assert utility["panes"][0]["path"] == str(tmp_path)
        assert len(await tmux.list_sessions()) == 2
        assert (await tmux.get_session(source.name)).to_dict() == original.to_dict()

        # Identity-bound WebSockets cannot attach to a name reused by another session.
        response = await client.get("/ws/terminal", params={"session": utility["name"], "identity": "stale"})
        assert response.status == 409
        identity = f'{utility["id"]}:{utility["created"]}:{utility["serverStarted"]}:{utility["serverPid"]}'
        websocket = await client.ws_connect("/ws/terminal", params={"session": utility["name"], "identity": identity})
        await websocket.close()

        await tmux.run(["rename-session", "-t", utility["id"], "renamed-utility"])
        response = await client.post("/api/utility-terminal", json=payload)
        renamed = (await response.json())["terminal"]
        assert renamed["name"] == "renamed-utility"
        assert renamed["id"] == utility["id"]
        end_payload = {"sessionId": utility["id"], "sessionCreated": utility["created"], "serverStarted": utility["serverStarted"], "serverPid": utility["serverPid"]}
        response = await client.delete("/api/sessions/renamed-utility", json={**end_payload, "sessionCreated": utility["created"] + 1})
        assert response.status == 409
        assert len(await tmux.list_sessions()) == 2
        response = await client.delete("/api/sessions/renamed-utility", json=end_payload)
        assert response.status == 204
        response = await client.post("/api/utility-terminal", json=payload)
        assert await response.json() == {"terminal": None}
        assert [session.id for session in await tmux.list_sessions()] == [source.id]
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)


@pytest.mark.asyncio
async def test_scoped_terminals_follow_owners_without_touching_other_sessions(tmp_path):
    socket = f"muxdeck-scoped-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    try:
        await client.start_server()
        await tmux.create_session("parent", start_directory=str(tmp_path))
        await tmux.create_session("unrelated", start_directory=str(tmp_path))
        parent = await tmux.get_session("parent")
        key = f"session:{parent.id}:{parent.created}:{parent.server_started}:{parent.server_pid}"
        payload = {"workspaceKey": key, "sourceSession": parent.name, "sourceSessionId": parent.id, "create": True}
        response = await client.post("/api/utility-terminal", json=payload)
        assert response.status == 200
        shell = (await response.json())["terminal"]
        response = await client.post("/api/utility-terminal", json=payload)
        assert (await response.json())["terminal"]["id"] == shell["id"]
        await tmux.run(["rename-session", "-t", parent.id, "renamed-parent"])
        response = await client.post("/api/utility-terminal", json={**payload, "sourceSession": "renamed-parent"})
        assert (await response.json())["terminal"]["id"] == shell["id"]
        response = await client.post("/api/utility-terminal", json={**payload, "sourceSession": "renamed-parent", "workspaceKey": key + "0"})
        assert response.status == 409

        await tmux.cleanup_utility_sessions(set())
        assert len(await tmux.list_sessions()) == 3
        # Simulate ending the parent outside the web portal.
        await tmux.terminate_session(parent.id, parent.created, parent.server_started, parent.server_pid)
        await tmux.cleanup_utility_sessions(set())
        assert [s.name for s in await tmux.list_sessions()] == ["unrelated"]
        await tmux.create_session("parent", start_directory=str(tmp_path))
        response = await client.post("/api/utility-terminal", json=payload)
        assert response.status == 409
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)


@pytest.mark.asyncio
async def test_temporary_terminal_release_and_saved_workspace_transfer(tmp_path):
    socket = f"muxdeck-temp-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    key = "temporary:00000000-0000-0000-0000-000000000002"
    try:
        await client.start_server()
        parent = await tmux.create_session("parent", start_directory=str(tmp_path))
        shell = await tmux.utility_session(key, parent.name, parent.id, create=True)
        assert shell is not None
        # Invalid release cannot terminate a session-scoped or saved shell.
        response = await client.post("/api/utility-terminal/release", json={"workspaceKey": "workspace:fake"})
        assert response.status == 400
        response = await client.post("/api/workspaces", json={"name": "Saved", "tabs": [parent.name], "activeSession": parent.name})
        assert response.status == 201, await response.text()
        workspace = (await response.json())["workspace"]
        destination = f'workspace:{workspace["id"]}'
        response = await client.post("/api/utility-terminal/release", json={"workspaceKey": key, "destination": destination})
        assert response.status == 204
        saved = await tmux.utility_session(destination, parent.name, parent.id, create=False)
        assert saved is not None and saved.id == shell.id
        await tmux.release_utility_workspace(key)
        await tmux.cleanup_utility_sessions({workspace["id"]})
        assert len(await tmux.list_sessions()) == 2
        response = await client.delete(f'/api/workspaces/{workspace["id"]}')
        assert response.status == 204
        await tmux.cleanup_utility_sessions(set())
        assert [s.id for s in await tmux.list_sessions()] == [parent.id]
        await tmux.utility_session(key, parent.name, parent.id, create=True)
        response = await client.post("/api/utility-terminal/release", json={"workspaceKey": key})
        assert response.status == 204
        assert [s.id for s in await tmux.list_sessions()] == [parent.id]
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)
