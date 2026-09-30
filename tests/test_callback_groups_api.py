import pytest
from aiohttp.test_utils import TestClient, TestServer
from test_callback_messages_api import callback_payload, make_app, read_event

from tmux_console import app as app_module


def payload(**overrides):
    return {"name": "Release", "workspaceId": None, "sessions": ["agent-one"], "expectedRevision": 0, **overrides}


@pytest.mark.asyncio
async def test_group_api_persists_edits_without_changing_callback_queues_or_reports(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path, base_path="/mux"))) as client:
        response = await client.post("/mux/api/callback-messages", json=callback_payload())
        report = (await response.json())["callback"]
        response = await client.post("/mux/api/callback-groups", json=payload())
        assert response.status == 201
        result = await response.json()
        group = result["group"]
        assert group["sessions"] == ["agent-one"]
        assert result["callbacks"]["callbackMessages"] == [report]
        assert result["callbacks"]["callbackSessions"] == ["agent-one"]
        response = await client.put(f'/mux/api/callback-groups/{group["id"]}', json=payload(
            name="Shipping", sessions=["agent-one", "later"], expectedRevision=1,
        ))
        assert response.status == 200
        updated = (await response.json())["group"]
        assert updated["id"] == group["id"]
        assert updated["name"] == "Shipping"
        response = await client.get("/mux/api/callback-sessions")
        snapshot = await response.json()
        assert snapshot["callbackGroups"] == [updated]
        assert snapshot["callbackGroupRevision"] == 2
        assert snapshot["callbackMessages"] == [report]
        assert snapshot["callbackSessions"] == ["agent-one"]

    async with TestClient(TestServer(make_app(tmp_path, base_path="/mux"))) as client:
        response = await client.get("/mux/api/callback-groups")
        assert await response.json() == {"callbackGroups": [updated], "callbackGroupRevision": 2}
        response = await client.delete(f'/mux/api/callback-groups/{group["id"]}', json={
            "workspaceId": None, "expectedRevision": 2,
        })
        assert response.status == 200
        snapshot = (await response.json())["callbacks"]
        assert snapshot["callbackGroups"] == []
        assert snapshot["callbackMessages"] == [report]
        assert snapshot["callbackSessions"] == ["agent-one"]


@pytest.mark.asyncio
async def test_group_writes_reach_global_and_saved_workspace_streams(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "WORKSPACE_STREAM_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(app_module, "CALLBACK_STREAM_HEARTBEAT_SECONDS", 0.05)
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.post("/api/workspaces", json={"name": "Main", "tabs": ["agent-one"], "activeSession": "agent-one"})
        workspace = (await response.json())["workspace"]
        streams = [await client.get("/api/callback-sessions/stream"), await client.get(f'/api/workspaces/{workspace["id"]}/stream')]
        try:
            await read_event(streams[0], "callbacks")
            await read_event(streams[1], "workspace")
            response = await client.post("/api/callback-groups", json=payload(workspaceId=workspace["id"]))
            assert response.status == 201
            expected = (await response.json())["callbacks"]
            assert await read_event(streams[0], "callbacks") == expected
            assert (await read_event(streams[1], "workspace"))["callbacks"] == expected
            response = await client.delete(f'/api/workspaces/{workspace["id"]}')
            assert response.status == 204
            assert (await read_event(streams[0], "callbacks"))["callbackGroups"] == []
            assert (await read_event(streams[1], "workspace"))["workspace"] is None
        finally:
            for stream in streams:
                stream.close()


@pytest.mark.asyncio
async def test_stale_api_update_and_missing_workspace_are_rejected_without_changes(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        created = await client.post("/api/callback-groups", json=payload())
        group = (await created.json())["group"]
        response = await client.put(f'/api/callback-groups/{group["id"]}', json=payload(sessions=["different"]))
        assert response.status == 409
        response = await client.post("/api/callback-groups", json=payload(workspaceId="missing", expectedRevision=1))
        assert response.status == 404
        response = await client.delete("/api/callback-groups/missing", json={"workspaceId": None, "expectedRevision": 1})
        assert response.status == 404
        response = await client.get("/api/callback-groups")
        assert await response.json() == {"callbackGroups": [group], "callbackGroupRevision": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{}, [], payload(name=""), payload(sessions="a"), payload(expectedRevision=None), payload(unexpected=True)])
async def test_group_api_rejects_invalid_payloads(tmp_path, body):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.post("/api/callback-groups", json=body)
        assert response.status == 400
        response = await client.get("/api/callback-groups")
        assert (await response.json())["callbackGroups"] == []
