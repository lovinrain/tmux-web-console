from __future__ import annotations

import asyncio
import uuid

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from muxpilot.fencing import (
    FencedReceiver,
    FenceError,
    ReceiverContext,
    receiver_middleware,
)
from muxpilot.store import JournalStore
from tmux_console.app import create_app
from tmux_console.tmux import CreatedSession, TmuxClient

IDENTITY = {"sessionId": "$12", "sessionCreated": 1700000000,
            "serverStarted": 1699999900, "serverPid": 4242,
            "paneId": "%23", "panePid": 31337}


@pytest.fixture
def authority(tmp_path, monkeypatch):
    root = tmp_path / "private-projects"
    project = str(uuid.uuid4())
    monkeypatch.setenv("MUXPILOT_STATE_ROOT", str(root))
    with JournalStore(root, project) as store:
        lease = store.acquire_lease("first", 60)
    return root, project, lease


def context(authority, *, owner="first", generation=None, operation=None):
    return ReceiverContext(authority[1], owner, generation or authority[2]["generation"], operation or str(uuid.uuid4()))


def envelope(ctx):
    return {"projectId": ctx.project_id, "owner": ctx.owner,
            "generation": ctx.generation, "operationId": ctx.operation_id}


class ReceiverTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="unused-tmux")
        self.launches, self.inputs = [], []

    async def list_sessions(self):
        return []

    async def create_session(self, name=None, **kwargs):
        self.launches.append((name, kwargs))
        return CreatedSession(name, "$12", directory=kwargs.get("start_directory"),
            pane_id="%23", pane_pid=31337, session_created=1700000000,
            server_started=1699999900, server_pid=4242)

    async def send_pane_input(self, session, **kwargs):
        self.inputs.append((session, kwargs))
        return {**IDENTITY, "session": session, "delivery": "delivered"}


async def test_real_muxdeck_receiver_rejects_delayed_old_launch_and_input(authority):
    root, project, lease = authority
    tmux = ReceiverTmux()
    launch = {"name": "mxp-worker", "launchMode": "shell", "muxpilot": envelope(context(authority))}
    async with TestClient(TestServer(create_app(tmux=tmux, base_path="/mux"))) as client:
        first = await client.post("/mux/api/sessions", json=launch)
        assert first.status == 201
        assert len(tmux.launches) == 1
        with JournalStore(root, project) as store:
            store.release_lease("first", lease["generation"])
            replacement = store.acquire_lease("replacement", 60)
        stale = await client.post("/mux/api/sessions", json={**launch, "name": "mxp-stale"})
        assert stale.status == 409
        assert len(tmux.launches) == 1
        input_body = {**IDENTITY, "text": "stale", "muxpilot": envelope(context(authority))}
        stale_input = await client.post("/mux/api/sessions/mxp-worker/input", json=input_body)
        assert stale_input.status == 409
        assert not tmux.inputs
        missing = await client.post("/mux/api/sessions/mxp-worker/input", json={**IDENTITY, "text": "omitted"})
        assert missing.status == 400
        assert not tmux.inputs
        fresh = context(authority, owner="replacement", generation=replacement["generation"])
        accepted = await client.post("/mux/api/sessions/mxp-worker/input", json={**input_body, "muxpilot": envelope(fresh)})
        assert accepted.status == 200
        assert len(tmux.inputs) == 1


async def test_managed_wrapper_cannot_omit_fence_and_global_launch_works(authority):
    tmux = ReceiverTmux()
    async with TestClient(TestServer(create_app(tmux=tmux, base_path=""))) as client:
        for body in ({"name": "mxp-worker"}, {"name": "ordinary", "environment": {"MUXPILOT_PROJECT_ID": authority[1]}}):
            rejected = await client.post("/api/sessions", json=body)
            assert rejected.status == 400
        global_launch = await client.post("/api/sessions", json={"name": "ordinary"})
        assert global_launch.status == 201
    assert len(tmux.launches) == 1


async def test_receiver_effect_and_takeover_are_serialized_without_event_loop_block(authority):
    root, project, lease = authority
    with JournalStore(root, project) as store:
        store.renew_lease("first", lease["generation"], .05)
    entered, release, attempting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    receiver = FencedReceiver(root)
    effects = []
    async def effect():
        entered.set()
        await release.wait()
        effects.append("old-completed")
        return {"session": "old"}
    operation = asyncio.create_task(receiver.execute(context(authority), "launch", {}, effect))
    await asyncio.wait_for(entered.wait(), 2)
    await asyncio.sleep(.08)
    def takeover():
        with JournalStore(root, project) as replacement_store:
            return replacement_store.acquire_lease("replacement", 60)
    async def acquire():
        attempting.set()
        return await asyncio.to_thread(takeover)
    replacement = asyncio.create_task(acquire())
    await attempting.wait()
    # This coroutine still executes while another thread waits on SQLite.
    await asyncio.sleep(.02)
    assert not replacement.done()
    release.set()
    assert await asyncio.wait_for(operation, 2) == {"session": "old"}
    new_lease = await asyncio.wait_for(replacement, 2)
    assert effects == ["old-completed"]
    assert new_lease["generation"] == lease["generation"] + 1
    with pytest.raises(FenceError, match="stale"):
        await receiver.execute(context(authority), "input", {}, effect)


async def test_immutable_operation_returns_receipt_after_restart_and_never_retains_secrets(authority):
    root, project, _ = authority
    ctx = context(authority)
    calls = []
    async def effect():
        calls.append(1)
        return {"session": "mxp-worker", "status": "created"}
    intent = {"command": ["private-prompt"], "environment": {"TOKEN": "private-key"}}
    expected = await FencedReceiver(root).execute(ctx, "launch", intent, effect)
    receiver = FencedReceiver(root)
    assert await receiver.execute(ctx, "launch", intent, effect) == expected
    assert calls == [1]
    with pytest.raises(FenceError, match="different intent"):
        await receiver.execute(ctx, "launch", {"command": ["changed"]}, effect)
    receipt = await receiver.receipt(project, ctx.operation_id)
    assert receipt["state"] == "confirmed"
    assert receipt["receipt"] == expected
    for path in (root / project).glob("journal.sqlite3*"):
        content = path.read_bytes()
        assert b"private-prompt" not in content
        assert b"private-key" not in content


async def test_lost_effect_receipt_is_uncertain_and_never_replayed(authority):
    receiver = FencedReceiver(authority[0])
    ctx = context(authority)
    calls = []
    async def effect():
        calls.append(1)
        raise RuntimeError("simulated receipt loss")
    with pytest.raises(RuntimeError, match="receipt loss"):
        await receiver.execute(ctx, "input", {}, effect)
    with pytest.raises(FenceError, match="uncertain"):
        await FencedReceiver(authority[0]).execute(ctx, "input", {}, effect)
    assert calls == [1]
    assert (await receiver.receipt(ctx.project_id, ctx.operation_id))["state"] == "uncertain"


async def test_missing_project_authority_fails_closed_without_creating_journal(tmp_path):
    ctx = ReceiverContext(str(uuid.uuid4()), "owner", 1, str(uuid.uuid4()))
    async def effect():
        pytest.fail("missing authority executed effect")
    with pytest.raises(FenceError, match="unavailable"):
        await FencedReceiver(tmp_path / "absent").execute(ctx, "launch", {}, effect)
    assert not (tmp_path / "absent").exists()


async def test_managed_http_errors_do_not_echo_sensitive_launch_diagnostics(authority):
    receiver = FencedReceiver(authority[0])
    app = web.Application(middlewares=[receiver_middleware("", receiver)])
    async def launch(request):
        return web.json_response({"error": "secret-key private-prompt"}, status=503)
    app.router.add_post("/api/sessions", launch)
    async with TestClient(TestServer(app)) as client:
        result = await client.post("/api/sessions", json={"name": "mxp-worker", "muxpilot": envelope(context(authority))})
        assert result.status == 503
        assert "secret-key" not in await result.text()
        assert "private-prompt" not in await result.text()


@pytest.mark.parametrize("field,value", [("operationId", "not-a-uuid"), ("projectId", None),
    ("owner", ""), ("generation", True), ("generation", 0)])
def test_receiver_envelope_requires_complete_valid_identity(authority, field, value):
    payload = envelope(context(authority))
    payload[field] = value
    with pytest.raises(FenceError):
        ReceiverContext.parse(payload)


async def test_managed_workspace_projections_reject_stale_epoch_and_omitted_authority(authority):
    root, project, lease = authority
    async with TestClient(TestServer(create_app(tmux=ReceiverTmux(), base_path=""))) as client:
        created = await client.post("/api/workspaces", json={"name": "Project", "tabs": ["mxp-main"],
            "activeSession": "mxp-main", "muxpilot": envelope(context(authority))})
        assert created.status == 201
        workspace = (await created.json())["workspace"]
        with JournalStore(root, project) as store:
            store.release_lease("first", lease["generation"])
            replacement = store.acquire_lease("replacement", 60)
        path = "/api/workspaces/" + workspace["id"] + "/sessions"
        payload = {"sessions": ["mxp-worker"], "sessionRevision": workspace["sessionRevision"]}
        omitted = await client.post(path, json=payload)
        assert omitted.status == 400
        stale = await client.post(path, json={**payload, "muxpilot": envelope(context(authority))})
        assert stale.status == 409
        fresh = context(authority, owner="replacement", generation=replacement["generation"])
        added = await client.post(path, json={**payload, "muxpilot": envelope(fresh)})
        assert added.status == 200
        assert (await added.json())["workspace"]["tabs"] == ["mxp-main", "mxp-worker"]


async def test_managed_delete_empty_success_retains_confirmed_receipt(authority):
    receiver = FencedReceiver(authority[0])
    ctx = context(authority)
    receiver.bind(ctx, {"session": "mxp-worker", **IDENTITY})
    app = web.Application(middlewares=[receiver_middleware("", receiver)])
    calls = []
    async def remove(request):
        assert "muxpilot" not in await request.json()
        calls.append(1)
        return web.Response(status=204)
    app.router.add_delete("/api/sessions/{session}", remove)
    async with TestClient(TestServer(app)) as client:
        response = await client.delete("/api/sessions/mxp-worker", json={**IDENTITY, "muxpilot": envelope(ctx)})
        assert response.status == 204
    assert calls == [1]
    receipt = await receiver.receipt(ctx.project_id, ctx.operation_id)
    assert receipt["state"] == "confirmed"
    assert receipt["receipt"] == {"status": 204, "body": {}}


async def test_empty_or_invalid_body_cannot_bypass_managed_workspace_delete(authority):
    async with TestClient(TestServer(create_app(tmux=ReceiverTmux(), base_path=""))) as client:
        created = await client.post("/api/workspaces", json={"name": "Project", "tabs": [],
            "activeSession": None, "muxpilot": envelope(context(authority))})
        assert created.status == 201
        workspace_id = (await created.json())["workspace"]["id"]
        path = "/api/workspaces/" + workspace_id
        for content in (None, "not-json", "[]"):
            rejected = await client.delete(path, data=content)
            assert rejected.status == 400
            assert (await client.get(path)).status == 200
        removed = await client.delete(path, json={"muxpilot": envelope(context(authority))})
        assert removed.status == 204
        assert (await client.get(path)).status == 404
