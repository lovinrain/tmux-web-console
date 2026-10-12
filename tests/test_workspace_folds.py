from __future__ import annotations

import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.workspaces import (
    WORKSPACE_SCHEMA_VERSION,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    WorkspaceUpdateConflict,
)


def create_folded(store):
    return store.create_workspace(
        name="Folded tree", tabs=["root", "a", "child", "gap", "b", "other"],
        active_session="child", parents={"a": "root", "child": "a", "gap": "root", "b": "root"},
        groups=[{"id": "group", "name": "Family", "color": "blue", "collapsed": False,
                 "tabs": ["root", "a", "child", "gap", "b"]}],
        folds=[{"id": "fold", "tabs": ["a", "b"]}],
    )


def test_folds_persist_without_changing_order_active_session_groups_or_parents(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    workspace = create_folded(store)
    assert workspace["tabs"] == ["root", "a", "child", "gap", "b", "other"]
    assert workspace["activeSession"] == "child"
    assert workspace["folds"] == [{"id": "fold", "tabs": ["a", "b"]}]
    assert WorkspaceStore(path).get_workspace(workspace["id"]) == workspace
    assert json.loads(path.read_text())["version"] == WORKSPACE_SCHEMA_VERSION


def test_schema_14_upgrade_preserves_nested_tabs_and_does_not_invent_folds(tmp_path):
    path = tmp_path / "workspaces.json"
    workspace = create_folded(WorkspaceStore(path))
    document = json.loads(path.read_text())
    document["version"] = 14
    del document["workspaces"][0]["folds"]
    path.write_text(json.dumps(document))
    before = path.read_bytes()
    store = WorkspaceStore(path)
    loaded = store.get_workspace(workspace["id"])
    assert loaded["parents"] == workspace["parents"]
    assert loaded.get("folds", []) == []
    assert path.read_bytes() == before
    store.update_workspace(workspace["id"], name="Renamed", update_name=True)
    assert json.loads(path.read_text())["version"] == WORKSPACE_SCHEMA_VERSION
    assert WorkspaceStore(path).get_workspace(workspace["id"])["parents"] == workspace["parents"]


def test_schema_15_keeps_live_folds_and_upgrades_without_inventing_closed_sessions(tmp_path):
    path = tmp_path / "workspaces.json"
    workspace = create_folded(WorkspaceStore(path))
    document = json.loads(path.read_text())
    document["version"] = 15
    path.write_text(json.dumps(document))
    before = path.read_bytes()
    store = WorkspaceStore(path)
    assert store.get_workspace(workspace["id"])["folds"] == workspace["folds"]
    assert path.read_bytes() == before
    store.update_workspace(workspace["id"], name="Upgraded", update_name=True)
    assert json.loads(path.read_text())["version"] == 16
    assert store.get_workspace(workspace["id"])["folds"] == workspace["folds"]


@pytest.mark.parametrize("folds", [
    None, {}, "fold", [{"id": "", "tabs": ["a", "b"]}],
    [{"id": "bad id", "tabs": ["a", "b"]}],
    [{"id": "x" * 65, "tabs": ["a", "b"]}],
    [{"id": "fold", "tabs": ["a", "b"], "extra": True}],
    [{"id": "fold", "tabs": None}], [{"id": "fold", "tabs": []}],
    [{"id": "fold", "tabs": ["unknown", "a"]}],
    [{"id": "fold", "tabs": [True, "a"]}],
    [{"id": "fold", "tabs": ["b"]}],
    [{"id": "fold", "tabs": ["a", "a"]}],
    [{"id": "fold", "tabs": ["b", "a"]}],
    [{"id": "fold", "tabs": ["a", "other"]}],
    [{"id": "fold", "tabs": ["child", "b"]}],
    [{"id": "fold", "tabs": ["root", "other"]}],
    [{"id": "fold", "tabs": ["a", "b"]}, {"id": "fold", "tabs": ["a"]}],
    [{"id": "fold", "tabs": ["a", "b"]}, {"id": "overlap", "tabs": ["a"]}],
])
def test_invalid_fold_changes_are_atomic(tmp_path, folds):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_folded(store)
    before = path.read_bytes()
    with pytest.raises((TypeError, ValueError)):
        store.update_workspace(original["id"], folds=folds, update_folds=True, session_revision=0)
    with pytest.raises((TypeError, ValueError)):
        store.record_activity(
            original["id"], tabs=original["tabs"], active_session="child", session_revision=0,
            folds=folds, update_folds=True,
        )
    assert path.read_bytes() == before
    assert store.get_workspace(original["id"]) == original


def test_legacy_activity_preserves_folds_and_explicit_unfold_checks_revision(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_folded(store)
    updated = store.record_activity(
        original["id"], tabs=original["tabs"], active_session="root", session_revision=0,
    )
    assert updated["folds"] == original["folds"]
    with pytest.raises(WorkspaceUpdateConflict):
        store.update_workspace(
            original["id"], folds=[], update_folds=True, session_revision=0,
            expected_updated_at=original["updatedAt"],
        )
    unfolded = store.update_workspace(
        original["id"], folds=[], update_folds=True, session_revision=0,
        expected_updated_at=updated["updatedAt"],
    )
    assert unfolded.get("folds", []) == []
    assert unfolded["tabs"] == original["tabs"]
    assert unfolded["parents"] == original["parents"]


def test_rename_follows_fold_roots_and_reparent_dissolves_invalid_fold(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_folded(store)
    store.rename_session("a", "renamed")
    renamed = store.get_workspace(original["id"])
    assert renamed["folds"] == [{"id": "fold", "tabs": ["renamed", "b"]}]
    assert renamed["parents"]["child"] == "renamed"
    moved = store.update_workspace(
        original["id"], parents={**renamed["parents"], "b": "gap"}, update_parents=True,
        session_revision=renamed["sessionRevision"],
    )
    assert moved.get("folds", []) == []
    assert moved["tabs"] == renamed["tabs"]


def test_removing_folded_root_dissolves_placeholder_and_promotes_surviving_children(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_folded(store)
    removed = store.record_activity(
        original["id"], tabs=[tab for tab in original["tabs"] if tab != "a"],
        active_session="child", session_revision=0,
    )
    assert removed.get("folds", []) == []
    assert removed["parents"]["child"] == "root"


def test_invalid_persisted_fold_fences_storage_instead_of_overwriting_it(tmp_path):
    path = tmp_path / "workspaces.json"
    workspace = create_folded(WorkspaceStore(path))
    document = json.loads(path.read_text())
    document["workspaces"][0]["folds"][0]["tabs"] = ["unknown", "b"]
    path.write_text(json.dumps(document))
    before = path.read_bytes()
    with pytest.raises(WorkspaceStoreUnavailable):
        WorkspaceStore(path).get_workspace(workspace["id"])
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_fold_api_round_trip_and_stale_unfold_are_guarded(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "workspace-id")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/workspaces", json={
            "name": "Folds", "tabs": ["a", "gap", "b"], "activeSession": "a",
            "folds": [{"id": "fold", "tabs": ["a", "b"]}],
        })
        assert response.status == 201
        original = (await response.json())["workspace"]
        route = "/api/workspaces/workspace-id"
        response = await client.patch(route, json={"folds": []})
        assert response.status == 400
        response = await client.post(f"{route}/activity", json={
            "tabs": original["tabs"], "activeSession": "b", "sessionRevision": 0,
            "folds": [], "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 200
        unfolded = (await response.json())["workspace"]
        assert unfolded.get("folds", []) == []
        response = await client.patch(route, json={
            "folds": original["folds"], "sessionRevision": 0,
            "expectedUpdatedAt": original["updatedAt"],
        })
        assert response.status == 409
        response = await client.patch(route, json={
            "folds": original["folds"], "sessionRevision": 0,
            "expectedUpdatedAt": unfolded["updatedAt"],
        })
        assert response.status == 200
        response = await client.get(route)
        assert (await response.json())["workspace"]["folds"] == original["folds"]
        response = await client.post("/api/workspaces", json={
            "name": "Invalid", "tabs": original["tabs"], "activeSession": "a", "folds": None,
        })
        assert response.status == 400
    assert WorkspaceStore(store.path).get_workspace("workspace-id")["folds"] == original["folds"]
