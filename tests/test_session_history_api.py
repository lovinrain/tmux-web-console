from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.agent_transcripts import AgentTranscriptReader
from tmux_console.app import SESSION_REGISTRY_KEY, create_app
from tmux_console.tmux import Session, TmuxClient


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


@pytest.mark.asyncio
async def test_history_can_be_scoped_to_one_session_over_http(tmp_path):
    """The handler whitelists query fields, so the session filter has to be
    accepted explicitly - and it must match a name exactly, not by substring."""
    socket = f"muxdeck-history-scope-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    client = TestClient(TestServer(create_app(tmux=tmux, agent_references=References(), base_path="")))
    try:
        await client.start_server()
        await tmux.create_session("scope-a", start_directory=str(tmp_path))
        await tmux.create_session("scope-a_2", start_directory=str(tmp_path))
        await client.get("/api/sessions")

        scoped = await client.get("/api/session-history?session=scope-a&recycled=0")
        assert scoped.status == 200
        entries = (await scoped.json())["entries"]
        assert [entry["name"] for entry in entries] == ["scope-a"]
        assert [a["agentType"] for a in entries[0]["agents"]] == ["copilot"]

        everything = await client.get("/api/session-history?recycled=0")
        assert sorted(e["name"] for e in (await everything.json())["entries"]) == [
            "scope-a", "scope-a_2",
        ]

        unknown = await client.get("/api/session-history?nope=1")
        assert unknown.status == 400
    finally:
        await client.close()
        await asyncio.to_thread(
            subprocess.run, ["tmux", "-L", socket, "kill-server"],
            check=False, capture_output=True,
        )


@pytest.mark.asyncio
async def test_history_cursor_is_accepted_and_bound_to_http_filters():
    class EmptyTmux(TmuxClient):
        async def list_sessions(self):
            return []
    app = create_app(tmux=EmptyTmux(binary="must-not-start-tmux"), base_path="")
    for i in range(55):
        app[SESSION_REGISTRY_KEY].observe_history(Session(
            name=f"work-{i}", id=f"${i}", created=100 + i,
            windows=1, attached=0, server_started=90, server_pid=42,
        ))
    async with TestClient(TestServer(app)) as client:
        first = await client.get("/api/session-history", params={"q": "work-", "recycled": "0"})
        assert first.status == 200
        initial = await first.json()
        assert len(initial["entries"]) == 50 and initial["totalCount"] == 55
        second = await client.get("/api/session-history", params={
            "q": "work-", "recycled": "0", "cursor": initial["nextCursor"],
        })
        assert second.status == 200
        rest = await second.json()
        assert len(rest["entries"]) == 5 and rest["nextCursor"] is None
        assert len({e["id"] for e in initial["entries"] + rest["entries"]}) == 55
        mismatch = await client.get("/api/session-history", params={"cursor": initial["nextCursor"], "q": "other"})
        assert mismatch.status == 400
        assert "refresh" in (await mismatch.json())["error"]


@pytest.mark.parametrize("trigger", ["history", "background"])
async def test_codex_exit_banners_repair_existing_metadata_and_live_transcripts(tmp_path, monkeypatch, trigger):
    """Reproduce an exited agent in a real, disposable tmux server."""
    identifiers = [f"{i:08x}-1111-4111-8111-111111111111" for i in range(1, 4)]
    root = tmp_path / "codex"
    for identifier in [identifiers[0], identifiers[-1]]:
        path = root / "sessions/2026/10/03" / f"rollout-2026-10-03T00-00-00-{identifier}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"type": "session_meta", "payload": {"id": identifier, "source": "cli"}}) + "\n"
                        + json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": identifier}]}}) + "\n")
    monkeypatch.setattr("tmux_console.app.SUBMITTED_MESSAGE_POLL_SECONDS", 0.01 if trigger == "background" else 60)
    socket = f"muxdeck-id-recovery-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    app = create_app(tmux=tmux, agent_transcripts=AgentTranscriptReader(roots={"codex": root}), base_path="")
    client = TestClient(TestServer(app))
    try:
        command = "printf '%s\\n' " + " ".join(f"'To reconnect, run:' 'codex resume {identifier}'" for identifier in identifiers)
        created = await tmux.create_session(
            "exited-codex", start_directory=str(tmp_path), launch_mode="command",
            command=["/bin/bash", "--noprofile", "--norc", "-c", command + "; exec /bin/bash --noprofile --norc"],
        )
        native = await tmux.get_session(created.name)
        pane = native.active_pane
        app[SESSION_REGISTRY_KEY].reconcile([native], {native.name: AgentReference("codex", None)})
        for _ in range(100):
            if f"codex resume {identifiers[-1]}" in (await tmux.capture_visible(pane.id)).splitlines():
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("disposable shell did not print its exit banners")
        await client.start_server()
        if trigger == "background":
            for _ in range(100):
                current = app[SESSION_REGISTRY_KEY].list_history()["entries"][0]
                if current["agentSessionId"] == identifiers[-1]:
                    break
                await asyncio.sleep(0.01)
            else:
                pytest.fail("background observation did not recover the IDs")
        response = await client.get("/api/session-history", params={"session": native.name})
        assert response.status == 200
        entry = (await response.json())["entries"][0]
        assert entry["agentSessionId"] == identifiers[-1]
        assert {item["agentSessionId"] for item in entry["agents"]} == {None, *identifiers}
        url = f"/api/panes/%25{pane.id[1:]}/agent-transcript"
        transcript = await (await client.get(url, params={"identity": native.identity})).json()
        assert transcript["status"] == "available"
        assert transcript["selectedSource"] == f"codex:{identifiers[-1]}"
        assert transcript["messages"][0]["text"] == identifiers[-1]
        missing = await (await client.get(url, params={"source": f"codex:{identifiers[1]}"})).json()
        assert missing["status"] == "missing"
        assert (await tmux.get_session(native.name)).identity == native.identity
    finally:
        await client.close()
        await asyncio.to_thread(subprocess.run, ["tmux", "-L", socket, "kill-server"], check=False, capture_output=True)
