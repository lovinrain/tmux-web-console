from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import make_mocked_request

from tmux_console.app import create_app
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import CreatedSession, Session, TmuxClient


def live_session():
    return Session(name="source", id="$1", windows=1, attached=0,
                   created=100, server_started=90, server_pid=42)


async def post(app, route_path, payload, **match_info):
    """Exercise routed handlers without requiring a listening HTTP server."""
    route = next(route for route in app.router.routes()
                 if route.method == "POST" and route.resource.canonical == route_path)
    request = make_mocked_request("POST", route_path, app=app, match_info=match_info)
    request.json = AsyncMock(return_value=payload)
    return await route.handler(request)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["split-workspace", "split-tab", "fork"])
async def test_view_activity_is_persisted_for_exact_native_identity(tmp_path, kind):
    live = live_session()
    tmux = TmuxClient()
    tmux.get_session = AsyncMock(return_value=live)
    registry = SessionRegistry(tmp_path / "registry.sqlite3", clock=lambda: 200)
    app = create_app(tmux=tmux, session_registry=registry, base_path="")
    try:
        response = await post(app, "/api/sessions/{session}/view-events", {
            "sessionId": "$1", "sessionCreated": 100, "serverStarted": 90,
            "serverPid": 42, "kind": kind,
        }, session="source")
        assert response.status == 204
        entry = registry.list_history()["entries"][0]
        assert entry["createdAt"] == 100
        assert entry["origin"] is None
        assert entry["viewEvents"][0]["kind"] == kind
        assert entry["viewEvents"][0]["recordedAt"] == 200
    finally:
        registry.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value,status", [
    ("sessionId", "$2", 409), ("sessionCreated", 101, 409),
    ("serverStarted", 91, 409), ("serverPid", 43, 409),
    ("kind", "copy", 400), ("kind", [], 400), ("sessionCreated", True, 400),
    ("serverPid", -1, 400), ("sessionId", None, 400), ("extra", "no", 400),
])
async def test_view_activity_rejects_invalid_or_stale_identity(tmp_path, field, value, status):
    tmux = TmuxClient()
    tmux.get_session = AsyncMock(return_value=live_session())
    registry = SessionRegistry(tmp_path / "registry.sqlite3")
    app = create_app(tmux=tmux, session_registry=registry, base_path="")
    try:
        payload = {"sessionId": "$1", "sessionCreated": 100, "serverStarted": 90,
                   "serverPid": 42, "kind": "fork", field: value}
        response = await post(app, "/api/sessions/{session}/view-events", payload, session="source")
        assert response.status == status
        assert registry.list_history()["entries"] == []
    finally:
        registry.close()


@pytest.mark.asyncio
async def test_copy_records_the_source_snapshot_and_requested_placement(tmp_path):
    source = live_session()
    tmux = TmuxClient()
    tmux.copy_session = AsyncMock(return_value=CreatedSession("source_1", "$2", str(tmp_path), source))
    registry = SessionRegistry(tmp_path / "registry.sqlite3")
    app = create_app(tmux=tmux, session_registry=registry, base_path="")
    try:
        response = await post(app, "/api/sessions/{session}/copy", {
            "sessionId": "$1", "placement": "child", "theme": "dark",
        }, session="source")
        assert response.status == 201
        assert json.loads(response.text) == {"session": "source_1", "sessionId": "$2"}
        entries = registry.list_history()["entries"]
        parent = next(entry for entry in entries if entry["name"] == "source")
        child = next(entry for entry in entries if entry["name"] == "source_1")
        assert child["origin"]["sourceHistoryId"] == parent["id"]
        assert child["origin"]["sourceName"] == "source"
        assert child["origin"]["placement"] == "child"
        assert child["origin"]["kind"] == "copy"
        invalid = await post(app, "/api/sessions/{session}/copy", {
            "sessionId": "$1", "placement": [],
        }, session="source")
        assert invalid.status == 400
        tmux.copy_session.assert_awaited_once()
    finally:
        registry.close()


@pytest.mark.asyncio
async def test_fresh_creation_and_history_recreation_record_distinct_origins(tmp_path):
    tmux = TmuxClient()
    tmux.create_session = AsyncMock(return_value=CreatedSession("source", "$1", str(tmp_path)))
    tmux.create_shell_session = AsyncMock(return_value=CreatedSession("source", "$2", str(tmp_path)))
    tmux.list_sessions = AsyncMock(return_value=[])
    registry = SessionRegistry(tmp_path / "registry.sqlite3")
    app = create_app(tmux=tmux, session_registry=registry, base_path="")
    try:
        response = await post(app, "/api/sessions", {"name": "source"})
        assert response.status == 201
        old = registry.list_history()["entries"][0]
        assert old["origin"]["kind"] == "new"
        response = await post(app, "/api/session-history/{history_id}/restore", {"create": True}, history_id=old["id"])
        assert response.status == 201
        replacement = next(entry for entry in registry.list_history()["entries"] if entry["id"] != old["id"])
        assert replacement["origin"]["kind"] == "recreate"
        assert replacement["origin"]["sourceHistoryId"] == old["id"]
        assert replacement["origin"]["sourceName"] == "source"
    finally:
        registry.close()
