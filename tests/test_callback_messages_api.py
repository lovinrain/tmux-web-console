from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import app as app_module
from tmux_console.app import create_app
from tmux_console.callback_messages import CallbackMessageStore
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import TmuxClient
from tmux_console.workspaces import WorkspaceStore


class UnusedTmux(TmuxClient):
    async def _run_command(self, command):
        raise AssertionError(f"callback APIs must not invoke tmux: {command}")


def make_app(tmp_path, *, base_path=""):
    return create_app(
        tmux=UnusedTmux(),
        callback_messages=CallbackMessageStore(tmp_path / "callbacks.sqlite3"),
        session_registry=SessionRegistry(tmp_path / "sessions.sqlite3"),
        workspaces=WorkspaceStore(tmp_path / "workspaces.json"),
        base_path=base_path,
        auth_mode="none",
    )


def callback_payload(**overrides):
    return {
        "message": "Finished the requested fixes. Tests passed.\nReady for review.",
        "sessionName": "agent-one",
        "agentType": "codex",
        "cwd": "/tmp/a project",
        "requestId": "completion-one",
        "tmuxSessionId": "$17",
        "tmuxPaneId": "%23",
        "host": "build-host",
        **overrides,
    }


async def read_event(response, event):
    async with asyncio.timeout(2):
        while True:
            record = (await response.content.readuntil(b"\n\n")).decode()
            if record.startswith(f"event: {event}\n"):
                return json.loads(record.split("data: ", 1)[1])


@pytest.mark.asyncio
async def test_callback_message_lifecycle_and_history_survive_restart(tmp_path):
    payload = callback_payload()
    async with TestClient(TestServer(make_app(tmp_path, base_path="/mux"))) as client:
        route = "/mux/api/callback-messages"
        response = await client.post(route, json=payload)
        assert response.status == 201
        created = await response.json()
        callback = created["callback"]
        assert created["duplicate"] is False
        assert all(callback[key] == value for key, value in payload.items())
        assert isinstance(callback["id"], str) and callback["id"]
        assert callback["sequence"] > 0
        assert callback["createdAt"] > 0
        assert callback["reviewedAt"] is None

        duplicate = await client.post(route, json=payload)
        assert duplicate.status == 200
        assert await duplicate.json() == {"callback": callback, "duplicate": True}
        response = await client.get(route)
        listed = await response.json()
        assert listed["messages"] == [callback]
        assert listed["nextAfter"] is None
        original_revision = listed["revision"]

    async with TestClient(TestServer(make_app(tmp_path))) as client:
        route = "/api/callback-messages"
        response = await client.get(route)
        assert (await response.json())["messages"] == [callback]
        review = await client.post(f"{route}/{callback['id']}/review", json={})
        assert review.status == 200
        reviewed = (await review.json())["callback"]
        assert reviewed["reviewedAt"] >= callback["createdAt"]
        assert {**reviewed, "reviewedAt": None} == callback
        repeated = await client.post(f"{route}/{callback['id']}/review", json={})
        assert repeated.status == 200
        assert (await repeated.json())["callback"] == reviewed
        response = await client.get(route)
        pending = await response.json()
        assert pending["messages"] == []
        assert pending["revision"] > original_revision
        for status in ("reviewed", "all"):
            response = await client.get(route, params={"status": status})
            assert (await response.json())["messages"] == [reviewed]
        missing = await client.post(f"{route}/does-not-exist/review", json={})
        assert missing.status == 404

    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.get("/api/callback-messages?status=reviewed")
        assert (await response.json())["messages"] == [reviewed]
        # Retrying a delivered completion cannot re-open an already reviewed item.
        response = await client.post("/api/callback-messages", json=payload)
        assert response.status == 200
        assert await response.json() == {"callback": reviewed, "duplicate": True}
        response = await client.get("/api/callback-messages")
        assert (await response.json())["messages"] == []


@pytest.mark.asyncio
async def test_callback_messages_support_stable_cursor_pagination(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        records = []
        for index in range(3):
            response = await client.post(
                "/api/callback-messages",
                json=callback_payload(requestId=f"completion-{index}", message=f"Task {index}"),
            )
            assert response.status == 201
            records.append((await response.json())["callback"])
        response = await client.get("/api/callback-messages?status=all&limit=2")
        first = await response.json()
        assert first["messages"] == records[:2]
        assert first["nextAfter"] == records[1]["sequence"]
        response = await client.get(
            "/api/callback-messages",
            params={"status": "all", "limit": "2", "after": str(first["nextAfter"])},
        )
        final = await response.json()
        assert final["messages"] == records[2:]
        assert final["nextAfter"] is None
        assert final["revision"] == first["revision"]


@pytest.mark.asyncio
async def test_callback_message_request_id_rejects_changed_content(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        route = "/api/callback-messages"
        first = await client.post(route, json=callback_payload())
        assert first.status == 201
        original = (await first.json())["callback"]
        for changed in ({"message": "Different result"}, {"sessionName": "another-session"}):
            response = await client.post(route, json=callback_payload(**changed))
            assert response.status == 409
        response = await client.get(route)
        assert (await response.json())["messages"] == [original]


@pytest.mark.asyncio
async def test_callback_message_request_id_and_extra_metadata_are_optional(tmp_path):
    payload = {key: value for key, value in callback_payload().items()
               if key in {"message", "sessionName", "agentType", "cwd"}}
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        records = []
        for _ in range(2):
            response = await client.post("/api/callback-messages", json=payload)
            assert response.status == 201
            records.append((await response.json())["callback"])
        assert records[0]["id"] != records[1]["id"]
        assert all(record["requestId"] is None for record in records)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {},
    [],
    callback_payload(message=""),
    callback_payload(message=" \n "),
    callback_payload(message=["done"]),
    callback_payload(sessionName=""),
    callback_payload(sessionName=None),
    callback_payload(agentType=42),
    callback_payload(cwd=[]),
    callback_payload(requestId=True),
    callback_payload(tmuxPaneId={}),
])
async def test_callback_message_rejects_malformed_payload_without_persisting(tmp_path, payload):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.post("/api/callback-messages", json=payload)
        assert response.status == 400
        assert isinstance((await response.json())["error"], str)
        response = await client.get("/api/callback-messages?status=all")
        assert (await response.json())["messages"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [
    "status=unknown", "after=-1", "after=1.5", "after=wat",
    "limit=0", "limit=201", "limit=-1", "limit=wat",
])
async def test_callback_messages_reject_invalid_list_filters(tmp_path, query):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.get(f"/api/callback-messages?{query}")
        assert response.status == 400
        assert isinstance((await response.json())["error"], str)


@pytest.mark.asyncio
async def test_session_review_archives_all_its_messages_and_preserves_other_sessions(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        workspace = await client.post("/api/workspaces", json={
            "name": "Project", "tabs": ["agent-one"], "activeSession": "agent-one",
            "callbackSessions": ["agent-one"],
        })
        assert workspace.status == 201
        added = await client.post("/api/callback-sessions", json={
            "sessions": ["agent-one", "manual"], "sessionRevision": 0,
        })
        assert added.status == 200
        for index, session in enumerate(("agent-one", "agent-one", "other")):
            response = await client.post("/api/callback-messages", json=callback_payload(
                requestId=f"result-{index}", sessionName=session,
            ))
            assert response.status == 201
        response = await client.get("/api/callback-sessions")
        snapshot = await response.json()
        assert snapshot["globalCallbackSessions"] == ["agent-one", "manual"]
        assert set(snapshot["callbackSessions"]) == {"agent-one", "manual", "other"}
        assert len(snapshot["callbackMessages"]) == 3

        response = await client.post("/api/callback-sessions/review", json={
            "session": "agent-one", "sessionRevision": 0,
        })
        assert response.status == 200
        snapshot = await response.json()
        assert set(snapshot["callbackSessions"]) == {"manual", "other"}
        assert snapshot["globalCallbackSessions"] == ["manual"]
        assert snapshot["workspaceCallbacks"] == []
        assert [item["sessionName"] for item in snapshot["callbackMessages"]] == ["other"]
        response = await client.get("/api/callback-messages?status=reviewed")
        assert [item["sessionName"] for item in (await response.json())["messages"]] == [
            "agent-one", "agent-one",
        ]


@pytest.mark.asyncio
async def test_manual_callback_replacement_preserves_messages_until_session_is_removed(tmp_path):
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.post("/api/callback-messages", json=callback_payload())
        assert response.status == 201
        callback = (await response.json())["callback"]
        response = await client.put("/api/callback-sessions", json={
            "sessions": ["manual"], "sessionRevision": 0,
        })
        assert response.status == 200
        snapshot = await response.json()
        assert snapshot["globalCallbackSessions"] == ["manual"]
        assert snapshot["callbackMessages"] == [callback]
        assert set(snapshot["callbackSessions"]) == {"manual", "agent-one"}

        response = await client.delete("/api/callback-sessions", json={
            "sessions": ["agent-one"], "sessionRevision": 0,
        })
        assert response.status == 200
        snapshot = await response.json()
        assert snapshot["callbackSessions"] == ["manual"]
        assert snapshot["callbackMessages"] == []
        response = await client.get("/api/callback-messages?status=reviewed")
        history = (await response.json())["messages"]
        assert len(history) == 1
        assert history[0]["id"] == callback["id"]
        assert history[0]["reviewedAt"] is not None


@pytest.mark.asyncio
async def test_message_updates_reach_callback_and_workspace_streams(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "CALLBACK_STREAM_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(app_module, "WORKSPACE_STREAM_HEARTBEAT_SECONDS", 0.05)
    async with TestClient(TestServer(make_app(tmp_path))) as client:
        response = await client.post("/api/workspaces", json={
            "name": "Project", "tabs": ["agent-one"], "activeSession": "agent-one",
        })
        workspace = (await response.json())["workspace"]
        callbacks = await client.get("/api/callback-sessions/stream")
        workspaces = await client.get(f"/api/workspaces/{workspace['id']}/stream")
        try:
            initial = await read_event(callbacks, "callbacks")
            initial_workspace = await read_event(workspaces, "workspace")
            assert initial_workspace["callbacks"] == initial
            assert initial["callbackMessages"] == []

            response = await client.post("/api/callback-messages", json=callback_payload())
            assert response.status == 201
            callback = (await response.json())["callback"]
            posted = await read_event(callbacks, "callbacks")
            posted_workspace = await read_event(workspaces, "workspace")
            assert posted["callbackMessages"] == [callback]
            assert posted["callbackSessions"] == ["agent-one"]
            assert posted["globalCallbackSessions"] == []
            assert posted["callbackMessageRevision"] > initial["callbackMessageRevision"]
            assert posted_workspace["callbacks"] == posted
            assert posted_workspace["workspace"] == workspace

            response = await client.post(f"/api/callback-messages/{callback['id']}/review", json={})
            assert response.status == 200
            reviewed = await read_event(callbacks, "callbacks")
            reviewed_workspace = await read_event(workspaces, "workspace")
            assert reviewed["callbackMessages"] == []
            assert reviewed["callbackSessions"] == []
            assert reviewed["callbackMessageRevision"] > posted["callbackMessageRevision"]
            assert reviewed_workspace["callbacks"] == reviewed
        finally:
            callbacks.close()
            workspaces.close()
