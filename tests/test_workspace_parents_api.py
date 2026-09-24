from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.tmux import TmuxClient
from tmux_console.workspaces import WorkspaceStore


@pytest.mark.asyncio
async def test_workspace_parents_round_trip_through_create_patch_activity_and_reload(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/workspaces", json={
            "name": "Tree", "tabs": ["root", "child", "grandchild", "other"],
            "activeSession": "root", "parents": {"child": "root", "grandchild": "child"},
        })
        assert response.status == 201
        original = (await response.json())["workspace"]
        assert original["parents"] == {"child": "root", "grandchild": "child"}
        route = "/api/workspaces/workspace-id"

        response = await client.patch(route, json={"name": "Renamed"})
        assert response.status == 200
        assert (await response.json())["workspace"]["parents"] == original["parents"]

        response = await client.patch(route, json={
            "parents": {"child": "other", "grandchild": "child"}, "sessionRevision": 0,
        })
        assert response.status == 200
        assert (await response.json())["workspace"]["parents"]["child"] == "other"

        response = await client.post(f"{route}/activity", json={
            "tabs": ["root", "child", "grandchild", "other"], "activeSession": "child",
            "parents": original["parents"], "sessionRevision": 0,
        })
        assert response.status == 200
        assert (await response.json())["workspace"]["parents"] == original["parents"]

        response = await client.post(f"{route}/activity", json={
            "tabs": ["root", "grandchild", "other"], "activeSession": "grandchild",
            "sessionRevision": 0,
        })
        assert response.status == 200
        assert (await response.json())["workspace"]["parents"] == {"grandchild": "root"}

        response = await client.get(route)
        assert response.status == 200
        assert (await response.json())["workspace"]["parents"] == {"grandchild": "root"}
    assert WorkspaceStore(path).get_workspace("workspace-id")["parents"] == {"grandchild": "root"}


@pytest.mark.asyncio
@pytest.mark.parametrize("parents", [
    None, [], "root", {"child": None}, {"unknown": "root"},
    {"child": "missing"}, {"child": "child"}, {"root": "child", "child": "root"},
])
async def test_workspace_api_rejects_invalid_parent_relationships_on_all_writes(tmp_path, parents):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "workspace-id")
    original = store.create_workspace(
        name="Tree", tabs=["root", "child"], active_session="root", parents={"child": "root"},
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/workspaces", json={
            "name": "Invalid", "tabs": ["root", "child"], "activeSession": "root",
            "parents": parents,
        })
        assert response.status == 400
        route = "/api/workspaces/workspace-id"
        response = await client.patch(route, json={"parents": parents, "sessionRevision": 0})
        assert response.status == 400
        response = await client.post(f"{route}/activity", json={
            "tabs": ["root", "child"], "activeSession": "root",
            "parents": parents, "sessionRevision": 0,
        })
        assert response.status == 400
    assert store.get_workspace("workspace-id") == original


@pytest.mark.asyncio
async def test_parent_updates_require_session_revision_and_reject_stale_tabs(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "workspace-id")
    original = store.create_workspace(name="Tree", tabs=["root", "child"], active_session="root")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        route = "/api/workspaces/workspace-id"
        response = await client.patch(route, json={"parents": {"child": "root"}})
        assert response.status == 400
        assert "sessionRevision" in (await response.json())["error"]

        response = await client.patch(route, json={
            "parents": {"child": "root"}, "sessionRevision": 0,
            "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 200
        updated = (await response.json())["workspace"]

        response = await client.patch(route, json={
            "parents": {}, "sessionRevision": 0, "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 409
        response = await client.post(f"{route}/activity", json={
            "tabs": original["tabs"], "activeSession": "root", "parents": {},
            "sessionRevision": 0, "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 409
        assert store.get_workspace("workspace-id")["parents"] == updated["parents"]

        store.rename_session("root", "renamed-root")
        response = await client.patch(route, json={"parents": {}, "sessionRevision": 0})
        assert response.status == 409
        assert "reload the workspace" in (await response.json())["error"]


@pytest.mark.asyncio
async def test_explicit_empty_parents_flattens_via_activity(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "workspace-id")
    store.create_workspace(
        name="Tree", tabs=["root", "child"], active_session="root", parents={"child": "root"},
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/workspaces/workspace-id/activity", json={
            "tabs": ["root", "child"], "activeSession": "root", "parents": {}, "sessionRevision": 0,
        })
        assert response.status == 200
        workspace = (await response.json())["workspace"]
        assert workspace.get("parents", {}) == {}
        assert workspace["tabs"] == ["root", "child"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["copy", "move"])
async def test_unsaved_bulk_transfer_api_keeps_selected_parent_relationships(tmp_path, operation):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "destination")
    store.create_workspace(
        name="Destination", tabs=["destination-root", "existing"],
        active_session="destination-root", parents={"existing": "destination-root"},
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/session-workspace-transfer/bulk", json={
            "sessions": ["root", "child", "existing"], "sourceWorkspaceId": None,
            "sourceParents": {"child": "root", "existing": "root"},
            "destinationWorkspaceId": "destination", "operation": operation, "sessionRevision": 0,
        })
        assert response.status == 200
        result = await response.json()
        assert result["sourceWorkspace"] is None
        assert result["destinationWorkspace"]["parents"] == {
            "existing": "destination-root", "child": "root",
        }
    assert WorkspaceStore(path).get_workspace("destination")["parents"] == result["destinationWorkspace"]["parents"]


@pytest.mark.asyncio
@pytest.mark.parametrize("source_parents", [
    None, [], "root", {"child": None}, {"outside": "root"},
    {"child": "outside"}, {"child": "child"}, {"root": "child", "child": "root"},
])
async def test_bulk_transfer_api_rejects_invalid_or_unselected_source_parent_endpoints(tmp_path, source_parents):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "destination")
    original = store.create_workspace(name="Destination", tabs=["outside"], active_session="outside")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/session-workspace-transfer/bulk", json={
            "sessions": ["root", "child"], "sourceParents": source_parents,
            "destinationWorkspaceId": "destination", "operation": "copy", "sessionRevision": 0,
        })
        assert response.status == 400
        assert "unknown field" not in (await response.json())["error"]
    assert store.get_workspace("destination") == original


@pytest.mark.asyncio
async def test_bulk_transfer_api_rejects_nonempty_parent_override_for_saved_source(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json", id_factory=iter(["source", "destination"]).__next__,
    )
    store.create_workspace(
        name="Source", tabs=["root", "child"], active_session="root", parents={"child": "root"},
    )
    original = store.create_workspace(name="Destination", tabs=[], active_session=None)
    payload = {
        "sessions": ["root", "child"], "sourceWorkspaceId": "source",
        "sourceParents": {"child": "root"}, "destinationWorkspaceId": "destination",
        "operation": "copy", "sessionRevision": 0,
    }
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/session-workspace-transfer/bulk", json=payload)
        assert response.status == 400
        assert "unknown field" not in (await response.json())["error"]
        assert store.get_workspace("destination") == original

        response = await client.post(
            "/api/session-workspace-transfer/bulk", json=payload | {"sourceParents": {}},
        )
        assert response.status == 200
        assert (await response.json())["destinationWorkspace"]["parents"] == {"child": "root"}


@pytest.mark.asyncio
@pytest.mark.parametrize("source_parents", [None, [], {"child": "root"}, {"child": "child"}])
async def test_single_transfer_api_validates_source_parents_and_accepts_empty_map(tmp_path, monkeypatch, source_parents):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "destination")
    original = store.create_workspace(name="Destination", tabs=["root"], active_session="root")
    tmux = TmuxClient()
    get_session = AsyncMock(return_value=None)
    monkeypatch.setattr(tmux, "get_session", get_session)
    payload = {
        "session": "child", "sourceParents": source_parents,
        "destinationWorkspaceId": "destination", "operation": "copy", "sessionRevision": 0,
    }
    async with TestClient(TestServer(create_app(tmux=tmux, workspaces=store, base_path=""))) as client:
        response = await client.post("/api/session-workspace-transfer", json=payload)
        assert response.status == 400
        assert "unknown field" not in (await response.json())["error"]
        assert store.get_workspace("destination") == original

        response = await client.post(
            "/api/session-workspace-transfer", json=payload | {"sourceParents": {}},
        )
        assert response.status == 200
        result = await response.json()
        assert result["destinationWorkspace"]["tabs"] == ["root", "child"]
        assert result["destinationWorkspace"].get("parents", {}) == {}
    get_session.assert_awaited_with("child")
