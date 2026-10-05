from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from aiohttp import WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.pty_bridge import PtyBridge
from tmux_console.tmux import Session, TmuxClient
from tmux_console.workspace_views import (
    ViewAttachment,
    WorkspaceViewRegistry,
    validate_view_id,
    validate_view_scope,
)


def attachment(
    view: str, session: str = "alpha", scope: str | None = "workspace:one",
    group: str | None = "linked",
) -> ViewAttachment:
    websocket = Mock(spec=web.WebSocketResponse)
    websocket.closed = False
    websocket.send_json = AsyncMock()
    websocket.close = AsyncMock()
    bridge = Mock(spec=PtyBridge)
    bridge.close = AsyncMock()
    return ViewAttachment(view, scope, group, session, 100, 30, False, websocket, bridge)


def test_snapshot_groups_panes_tracks_resize_and_separates_legacy_connections():
    registry = WorkspaceViewRegistry()
    first = registry.attach(attachment("source"))
    second = registry.attach(attachment("source", "beta"))
    registry.attach(attachment("independent", group=None))
    registry.attach(attachment("elsewhere", scope="workspace:two"))
    registry.attach(attachment("legacy", scope=None, group=None))
    registry.attach(attachment("unrelated", "gamma", scope=None))
    registry.resize(first, 120, 45)
    snapshot = registry.snapshot("workspace:one", ["alpha", "beta"], "source")
    assert not snapshot["evicted"]
    assert [view["id"] for view in snapshot["views"]] == ["source", "independent", "legacy"]
    source, independent, legacy = snapshot["views"]
    assert source["inScope"] and len(source["terminals"]) == 2
    assert source["terminals"][0] == {
        "session": "alpha", "cols": 120, "rows": 45, "ignoreSize": False,
    }
    assert independent["group"] is None
    assert not legacy["inScope"]
    number = source["number"]
    registry.detach(first)
    assert len(registry.snapshot("workspace:one", [], None)["views"][0]["terminals"]) == 1
    registry.detach(second)
    registry.attach(attachment("source"))
    assert next(view for view in registry.snapshot("workspace:one", [], None)["views"]
                if view["id"] == "source")["number"] == number


@pytest.mark.asyncio
async def test_eviction_closes_all_view_attachments_and_requires_explicit_resume():
    registry = WorkspaceViewRegistry()
    targets = [attachment("target"), attachment("target", "beta")]
    keeper = attachment("keeper")
    for item in [*targets, keeper]:
        registry.attach(item)
    assert not await registry.evict("workspace:other", ["alpha"], "target")
    assert await registry.evict("workspace:one", ["alpha", "beta"], "target")
    assert registry.snapshot("workspace:one", [], "target")["evicted"]
    assert [view["id"] for view in registry.snapshot("workspace:one", [], None)["views"]] == ["keeper"]
    for item in targets:
        item.bridge.close.assert_awaited_once()
        assert [call.args[0]["type"] for call in item.websocket.send_json.await_args_list] == [
            "viewEvicted", "exit",
        ]
        assert item.websocket.close.await_args.kwargs["code"] == 4004
    keeper.bridge.close.assert_not_awaited()
    with pytest.raises(PermissionError):
        registry.attach(attachment("target"))
    registry.resume("target")
    registry.attach(attachment("target"))
    assert not registry.is_evicted("target")


@pytest.mark.asyncio
async def test_shutdown_does_not_revoke_views_or_send_session_exit():
    registry = WorkspaceViewRegistry()
    item = attachment("source")
    registry.attach(item)
    await registry.close()
    assert item.websocket.close.await_args.kwargs["code"] == 1001
    item.websocket.send_json.assert_not_awaited()
    assert not registry.is_evicted("source")


@pytest.mark.asyncio
async def test_slow_notice_does_not_delay_releasing_a_size_contributor():
    registry = WorkspaceViewRegistry()
    item = attachment("slow")
    released = asyncio.Event()
    blocked = asyncio.Event()
    async def blocked_send(_message):
        await blocked.wait()

    item.websocket.send_json.side_effect = blocked_send
    item.bridge.close.side_effect = released.set
    registry.attach(item)
    eviction = asyncio.create_task(registry.evict("workspace:one", [], "slow"))
    try:
        await asyncio.wait_for(released.wait(), 0.5)
        assert registry.snapshot("workspace:one", [], None)["views"] == []
        assert not eviction.done()
        assert await asyncio.wait_for(eviction, 1.5)
    finally:
        eviction.cancel()
        await asyncio.gather(eviction, return_exceptions=True)


@pytest.mark.parametrize("value", ["", "two tabs", "../view", "x" * 129, 4, []])
def test_invalid_view_identifiers(value):
    with pytest.raises(ValueError):
        validate_view_id(value)


@pytest.mark.parametrize("value", ["one", "session:one", "workspace:../one", "fork:", 4, []])
def test_invalid_view_scopes(value):
    with pytest.raises(ValueError):
        validate_view_scope(value)


class ViewTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="unused-tmux")

    async def get_session(self, name: str) -> Session:
        return Session(name=name, id="$1", windows=1, attached=0, created=1700000000)


@pytest.fixture
async def view_client(monkeypatch):
    bridges = []

    async def attach(cls, *_args, **_kwargs):
        del cls
        bridge = Mock(spec=PtyBridge)
        bridge.client_pid = 4321
        bridge.read = asyncio.Event().wait
        bridge.close = AsyncMock()
        bridge.write = AsyncMock(return_value=True)
        bridges.append(bridge)
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(attach))
    async with TestClient(TestServer(create_app(tmux=ViewTmux(), base_path=""))) as client:
        yield client, bridges


@pytest.mark.asyncio
async def test_view_api_grouping_eviction_revocation_and_resume(view_client):
    client, bridges = view_client
    scope = "workspace:one"
    source = await client.ws_connect(f"/ws/terminal?session=alpha&viewId=source&viewScope={scope}")
    target = await client.ws_connect(f"/ws/terminal?session=alpha&viewId=target&viewScope={scope}&viewGroup=linked")
    pane = await client.ws_connect(f"/ws/terminal?session=beta&viewId=target&viewScope={scope}&viewGroup=linked&ignoreSize=1")
    for websocket in [source, target, pane]:
        assert (await websocket.receive_json())["type"] == "ready"
    payload = {"scope": scope, "sessions": ["alpha", "beta"], "viewId": "source"}
    response = await client.post("/api/workspace-views/snapshot", json=payload)
    snapshot = await response.json()
    assert response.status == 200
    assert len(snapshot["views"]) == 2
    assert snapshot["views"][1]["terminals"][1]["ignoreSize"]
    await target.send_json({"type": "resize", "cols": 180, "rows": 48})
    # Acknowledged input orders the preceding resize without timing sleeps.
    await target.send_json({"type": "input", "id": "barrier", "data": "ok"})
    assert (await target.receive_json())["type"] == "inputAck"
    response = await client.post("/api/workspace-views/snapshot", json=payload)
    assert (await response.json())["views"][1]["terminals"][0]["cols"] == 180
    evict = {"scope": scope, "sessions": payload["sessions"], "requesterId": "source"}
    assert (await client.post("/api/workspace-views/source/evict", json=evict)).status == 400
    assert (await client.post("/api/workspace-views/target/evict", json={**evict, "scope": "workspace:other"})).status == 404
    assert (await client.post("/api/workspace-views/target/evict", json=evict)).status == 200
    for websocket in [target, pane]:
        assert (await websocket.receive_json())["type"] == "viewEvicted"
    assert bridges[1].close.await_count >= 1 and bridges[2].close.await_count >= 1
    bridges[0].close.assert_not_awaited()
    with pytest.raises(WSServerHandshakeError) as error:
        await client.ws_connect(f"/ws/terminal?session=alpha&viewId=target&viewScope={scope}")
    assert error.value.status == 423
    response = await client.post("/api/workspace-views/snapshot", json={**payload, "viewId": "target"})
    assert (await response.json())["evicted"]
    assert (await client.post("/api/workspace-views/target/resume")).status == 200
    rejoined = await client.ws_connect(f"/ws/terminal?session=alpha&viewId=target&viewScope={scope}")
    assert (await rejoined.receive_json())["type"] == "ready"
    await rejoined.close()
    await source.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    [], {}, {"scope": "workspace:one", "sessions": ["alpha", "alpha"]},
    {"scope": "workspace:one", "sessions": [4]}, {"scope": "workspace:one", "viewId": "../x"},
])
async def test_snapshot_rejects_invalid_payloads(view_client, payload):
    client, _bridges = view_client
    assert (await client.post("/api/workspace-views/snapshot", json=payload)).status == 400


@pytest.mark.asyncio
async def test_terminal_rejects_invalid_view_metadata(view_client):
    client, bridges = view_client
    for query in ["viewScope=workspace:one", "viewId=bad.id", "viewId=source&viewScope=bad"]:
        with pytest.raises(WSServerHandshakeError) as error:
            await client.ws_connect(f"/ws/terminal?session=alpha&{query}")
        assert error.value.status == 400
    assert not bridges


@pytest.mark.asyncio
async def test_terminal_readiness_failure_does_not_leave_a_ghost_attachment(view_client, monkeypatch):
    client, bridges = view_client
    original = web.WebSocketResponse.send_str

    async def fail_ready(self, data, *args, **kwargs):
        if '"type": "ready"' in data:
            raise ConnectionResetError("browser disappeared during attach")
        return await original(self, data, *args, **kwargs)

    monkeypatch.setattr(web.WebSocketResponse, "send_str", fail_ready)
    websocket = await client.ws_connect("/ws/terminal?session=alpha&viewId=source&viewScope=workspace:one")
    await asyncio.wait_for(websocket.receive(), 1)
    response = await client.post("/api/workspace-views/snapshot", json={"scope": "workspace:one"})
    assert (await response.json())["views"] == []
    bridges[0].close.assert_awaited_once()


@pytest.mark.asyncio
async def test_view_routes_require_browser_authentication(tmp_path):
    path = tmp_path / "auth.json"
    provision_auth_file(path, "user", "test-password")
    app = create_app(tmux=ViewTmux(), base_path="", auth=AuthStore(path), auth_cookie_secure=False)
    async with TestClient(TestServer(app)) as client:
        for route in ["snapshot", "target/evict", "target/resume"]:
            assert (await client.post(f"/api/workspace-views/{route}", json={"scope": "workspace:one"})).status == 401
        login = await client.post("/api/auth/login", json={"username": "user", "password": "test-password"})
        assert login.status == 200
        assert (await client.post("/api/workspace-views/snapshot", json={"scope": "workspace:one"})).status == 200
