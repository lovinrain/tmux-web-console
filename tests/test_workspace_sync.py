from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import app as app_module
from tmux_console.app import (
    CALLBACK_STREAM_BROKER_KEY,
    WORKSPACE_STREAM_BROKER_KEY,
    WorkspaceStreamBroker,
    create_app,
)
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.session_registry import SessionRegistry, SessionRegistryUnavailable
from tmux_console.tmux import CreatedSession, TmuxClient
from tmux_console.workspaces import (
    WorkspaceStore,
    WorkspaceUpdateConflict,
    _WorkspaceDirectorySyncError,
)


@pytest.fixture(autouse=True)
def fast_stream_cleanup(monkeypatch):
    monkeypatch.setattr(app_module, "WORKSPACE_STREAM_HEARTBEAT_SECONDS", 0.05)


async def read_workspace_snapshot(response):
    async with asyncio.timeout(2):
        while True:
            record = (await response.content.readuntil(b"\n\n")).decode()
            if record.startswith("event: workspace\n"):
                return json.loads(record.split("data: ", 1)[1])


async def read_workspace_event(response):
    return (await read_workspace_snapshot(response))["workspace"]


@pytest.mark.parametrize("method", ["patch", "activity"])
def test_simultaneous_snapshot_saves_have_exactly_one_winner(tmp_path, method):
    store = WorkspaceStore(tmp_path / "workspaces.json", clock=lambda: 10)
    original = store.create_workspace(
        name="Shared", tabs=["a", "b", "c"], active_session="a"
    )
    barrier = threading.Barrier(2)

    def save(tabs):
        barrier.wait(timeout=2)
        fields = {
            "tabs": tabs,
            "active_session": tabs[0],
            "session_revision": original["sessionRevision"],
            "expected_updated_at": original["updatedAt"],
        }
        try:
            if method == "activity":
                return store.record_activity(original["id"], **fields)
            return store.update_workspace(
                original["id"], update_tabs=True, update_active_session=True, **fields
            )
        except WorkspaceUpdateConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, (["a", "b"], ["a", "c"])))
    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert store.get_workspace(original["id"]) == winners[0]
    assert WorkspaceStore(store.path).get_workspace(original["id"]) == winners[0]
    assert winners[0]["updatedAt"] == original["updatedAt"] + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["patch", "activity"])
async def test_stale_browser_snapshot_cannot_restore_a_closed_tab(tmp_path, method):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a", "b"], active_session="a")
    route = f"/api/workspaces/{original['id']}"
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        closed = await client.patch(route, json={
            "tabs": ["b"], "activeSession": "b", "sessionRevision": 0,
            "expectedUpdatedAt": original["updatedAt"],
        })
        assert closed.status == 200
        canonical = (await closed.json())["workspace"]
        request = client.patch if method == "patch" else client.post
        endpoint = route if method == "patch" else f"{route}/activity"
        stale = await request(endpoint, json={
            "tabs": ["a", "b"], "activeSession": "a", "sessionRevision": 0,
            "expectedUpdatedAt": original["updatedAt"],
        })
        assert stale.status == 409
        assert "workspace update conflict" in (await stale.json())["error"]
        assert store.get_workspace(original["id"]) == canonical
        assert WorkspaceStore(store.path).get_workspace(original["id"]) == canonical
        accepted = await request(endpoint, json={
            "tabs": ["b", "c"], "activeSession": "b", "sessionRevision": 0,
            "expectedUpdatedAt": canonical["updatedAt"],
        })
        assert accepted.status == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, True, False, -1, 1.5, "1", []])
@pytest.mark.parametrize("method", ["patch", "activity"])
async def test_expected_updated_at_rejects_malformed_values(tmp_path, value, method):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a"], active_session="a")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        route = f"/api/workspaces/{original['id']}"
        request = client.patch if method == "patch" else client.post
        endpoint = route if method == "patch" else f"{route}/activity"
        response = await request(endpoint, json={
            "tabs": ["a"], "activeSession": "a", "sessionRevision": 0,
            "expectedUpdatedAt": value,
        })
        assert response.status == 400
        assert "expectedUpdatedAt" in (await response.json())["error"]
        assert store.get_workspace(original["id"]) == original


@pytest.mark.asyncio
async def test_workspace_stream_fanout_reconnect_deletion_and_cleanup(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a", "b"], active_session="a")
    application = create_app(workspaces=store, base_path="/mux")
    broker = application[WORKSPACE_STREAM_BROKER_KEY]
    route = f"/mux/api/workspaces/{original['id']}"
    async with TestClient(TestServer(application)) as client:
        first, second = await asyncio.gather(
            client.get(f"{route}/stream"), client.get(f"{route}/stream")
        )
        assert first.status == second.status == 200
        assert first.headers["Content-Type"].startswith("text/event-stream")
        assert first.headers["X-Accel-Buffering"] == "no"
        assert await read_workspace_snapshot(first) == {
            "workspace": original,
            "callbacks": store.get_global_callback_sessions(),
        }
        assert await read_workspace_event(second) == original
        assert broker.subscriber_count == 2

        response = await client.patch(route, json={
            "tabs": ["b"], "activeSession": "b", "sessionRevision": 0,
            "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 200
        canonical = (await response.json())["workspace"]
        assert await read_workspace_event(first) == canonical
        assert await read_workspace_event(second) == canonical
        first.close()
        reconnected = await client.get(f"{route}/stream")
        assert await read_workspace_event(reconnected) == canonical

        response = await client.delete(route)
        assert response.status == 204
        assert await read_workspace_event(second) is None
        assert await read_workspace_event(reconnected) is None
        missing = await client.get(f"{route}/stream")
        assert missing.status == 200
        assert await read_workspace_event(missing) is None
        second.close()
        reconnected.close()
        missing.close()
        async with asyncio.timeout(2):
            while broker.subscriber_count:
                await asyncio.sleep(0.01)
    assert broker.closed


@pytest.mark.asyncio
async def test_workspace_stream_scopes_resource_writes_and_ignores_failures(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a", "b"], active_session="a")
    other = store.create_workspace(name="Other", tabs=["c"], active_session="c")
    application = create_app(workspaces=store, base_path="")
    broker = application[WORKSPACE_STREAM_BROKER_KEY]
    queue = await broker.subscribe(original["id"], original, store.get_global_callback_sessions())
    await queue.get()
    async with TestClient(TestServer(application)) as client:
        response = await client.patch(f"/api/workspaces/{other['id']}", json={"name": "Other 2"})
        assert response.status == 200
        assert queue.empty()
        route = f"/api/workspaces/{original['id']}"
        response = await client.post(f"{route}/separators", json={
            "session": "a", "placement": "after", "sessionRevision": 0,
        })
        assert response.status == 200
        canonical = json.loads(queue.get_nowait())["workspace"]
        assert canonical["separators"] == ["a"]

        stale = await client.patch(route, json={
            "name": "Stale", "expectedUpdatedAt": original["updatedAt"],
        })
        assert stale.status == 409
        assert queue.empty()

        def fail_persist(*_args):
            raise OSError("disk full")

        monkeypatch.setattr(store, "_persist", fail_persist)
        failed = await client.patch(route, json={"name": "Unsaved"})
        assert failed.status == 500
        assert store.get_workspace(original["id"]) == canonical
        assert queue.empty()
        await broker.unsubscribe(original["id"], queue)


@pytest.mark.asyncio
async def test_workspace_stream_multiplexes_callback_only_updates_and_deduplicates(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a"], active_session="a")
    other = store.create_workspace(name="Other", tabs=["b"], active_session="b")
    application = create_app(workspaces=store, base_path="")
    broker = application[WORKSPACE_STREAM_BROKER_KEY]
    queue = await broker.subscribe(original["id"], original, store.get_global_callback_sessions())
    await queue.get()
    async with TestClient(TestServer(application)) as client:
        stream = await client.get(f"/api/workspaces/{original['id']}/stream")
        assert (await read_workspace_snapshot(stream))["callbacks"]["callbackSessions"] == []
        added = await client.post("/api/callback-sessions", json={
            "sessions": ["global"], "sessionRevision": 0,
        })
        assert added.status == 200
        first = await read_workspace_snapshot(stream)
        assert first["workspace"] == original
        assert first["callbacks"] == store.get_global_callback_sessions()
        assert first["callbacks"]["callbackSessions"] == ["global"]
        assert json.loads(queue.get_nowait()) == first

        duplicate = await client.post("/api/callback-sessions", json={
            "sessions": ["global"], "sessionRevision": 0,
        })
        assert duplicate.status == 200
        assert queue.empty()

        changed = await client.patch(f"/api/workspaces/{other['id']}", json={
            "callbackSessions": ["b"], "sessionRevision": 0,
        })
        assert changed.status == 200
        second = await read_workspace_snapshot(stream)
        assert second["workspace"] == original
        assert second["callbacks"]["callbackSessions"] == ["global", "b"]
        assert second["callbacks"] == store.get_global_callback_sessions()
        assert json.loads(queue.get_nowait()) == second
        stream.close()
        await broker.unsubscribe(original["id"], queue)


@pytest.mark.asyncio
async def test_workspace_broker_bounds_backpressure_and_closes_subscribers():
    broker = WorkspaceStreamBroker()
    first = await broker.subscribe("one", {"id": "one", "updatedAt": 0}, {})
    second = await broker.subscribe("two", {"id": "two", "updatedAt": 0}, {})
    for version in range(100):
        broker.publish([
            {"id": "one", "updatedAt": version},
            {"id": "two", "updatedAt": 0},
        ], {})
    assert first.qsize() == second.qsize() == 1
    assert json.loads(first.get_nowait())["workspace"]["updatedAt"] == 99
    assert json.loads(second.get_nowait())["workspace"]["updatedAt"] == 0
    await broker.close()
    assert first.get_nowait() is None
    assert second.get_nowait() is None
    assert broker.subscriber_count == 0
    with pytest.raises(RuntimeError, match="closed"):
        await broker.subscribe("one", None, {})


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [SessionRegistryUnavailable("unavailable"), OSError("disk full")])
async def test_forget_registry_failure_preserves_workspace_and_emits_no_change(tmp_path, monkeypatch, error):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(
        name="Shared", tabs=["missing", "other"], active_session="missing",
        callback_sessions=["missing"],
    )
    registry = SessionRegistry(tmp_path / "registry.sqlite3", id_factory=lambda: "recovery")
    registry.record_created(CreatedSession("missing", "$old"), str(tmp_path))
    tmux = TmuxClient(binary="unused-tmux")

    async def no_sessions():
        return []

    def fail_forget(_recovery_id):
        raise error

    monkeypatch.setattr(tmux, "list_sessions", no_sessions)
    monkeypatch.setattr(registry, "forget", fail_forget)
    application = create_app(workspaces=store, tmux=tmux, session_registry=registry, base_path="")
    broker = application[WORKSPACE_STREAM_BROKER_KEY]
    queue = await broker.subscribe(original["id"], original, store.get_global_callback_sessions())
    callback_queue = await application[CALLBACK_STREAM_BROKER_KEY].subscribe()
    await queue.get()
    await callback_queue.get()
    async with TestClient(TestServer(application)) as client:
        response = await client.delete("/api/recoverable-sessions/recovery")
        assert response.status == 503
        canonical = store.get_workspace(original["id"])
        assert canonical == original
        assert queue.empty()
        assert callback_queue.empty()


@pytest.mark.asyncio
async def test_durability_error_still_publishes_committed_workspace(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a"], active_session="a")
    application = create_app(workspaces=store, base_path="")
    broker = application[WORKSPACE_STREAM_BROKER_KEY]
    queue = await broker.subscribe(original["id"], original, store.get_global_callback_sessions())
    await queue.get()

    def fail_directory_sync(*_args):
        raise _WorkspaceDirectorySyncError("directory fsync failed after atomic replace")

    monkeypatch.setattr(store, "_persist", fail_directory_sync)
    async with TestClient(TestServer(application)) as client:
        response = await client.patch(f"/api/workspaces/{original['id']}", json={"name": "Committed"})
        assert response.status == 500
        canonical = store.get_workspace(original["id"])
        assert canonical["name"] == "Committed"
        assert json.loads(queue.get_nowait())["workspace"] == canonical


@pytest.mark.asyncio
async def test_workspace_stream_uses_existing_authentication(tmp_path):
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "reader", "correct-horse-battery-staple")
    application = create_app(auth=AuthStore(auth_path), base_path="/mux")
    async with TestClient(TestServer(application)) as client:
        response = await client.get("/mux/api/workspaces/one/stream", allow_redirects=False)
        assert response.status == 401
        assert (await response.json())["error"] == "authentication required"
        assert application[WORKSPACE_STREAM_BROKER_KEY].subscriber_count == 0


@pytest.mark.asyncio
async def test_workspace_stream_checks_revocation_before_sending_a_new_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "WORKSPACE_STREAM_HEARTBEAT_SECONDS", 5)
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "reader", "correct-horse-battery-staple")
    auth = AuthStore(auth_path)
    device, cookie = auth.issue_device("Reader")
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = store.create_workspace(name="Shared", tabs=["a"], active_session="a")
    application = create_app(auth=auth, workspaces=store, base_path="")
    async with TestClient(TestServer(application)) as client:
        response = await client.get(
            f"/api/workspaces/{original['id']}/stream",
            headers={"Cookie": f"muxdeck_device={cookie}"},
        )
        assert await read_workspace_event(response) == original
        assert auth.revoke_device(device.id)
        store.update_workspace(original["id"], name="Private update", update_name=True)
        application[WORKSPACE_STREAM_BROKER_KEY].publish(
            store.list_workspaces(), store.get_global_callback_sessions()
        )
        record = await asyncio.wait_for(response.content.readuntil(b"\n\n"), timeout=2)
        assert record == b'event: auth\ndata: {"authenticated":false}\n\n'
        assert await asyncio.wait_for(response.content.read(), timeout=2) == b""
