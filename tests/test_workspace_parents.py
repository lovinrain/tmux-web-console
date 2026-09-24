from __future__ import annotations

import json
from itertools import permutations

import pytest

from tmux_console.workspaces import (
    WORKSPACE_SCHEMA_VERSION,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    WorkspaceUpdateConflict,
)


def create_tree(store, **overrides):
    payload = {
        "name": "Tree",
        "tabs": ["root", "child", "grandchild", "sibling", "other"],
        "active_session": "root",
        "parents": {
            "child": "root",
            "grandchild": "child",
            "sibling": "root",
        },
    }
    return store.create_workspace(**(payload | overrides))


def test_nested_sessions_persist_and_explicit_empty_parents_flattens_tree(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_tree(store)

    assert WorkspaceStore(path).get_workspace(original["id"])["parents"] == original["parents"]
    payload = json.loads(path.read_text())
    assert payload["version"] == WORKSPACE_SCHEMA_VERSION == 14
    assert payload["workspaces"][0]["parents"] == original["parents"]

    flat = store.update_workspace(
        original["id"], parents={}, update_parents=True, session_revision=0,
    )
    assert flat.get("parents", {}) == {}
    assert flat["tabs"] == original["tabs"]
    assert "parents" not in json.loads(path.read_text())["workspaces"][0]
    assert WorkspaceStore(path).get_workspace(original["id"]).get("parents", {}) == {}


@pytest.mark.parametrize("version", range(1, 14))
def test_every_legacy_schema_loads_flat_and_upgrades_without_inventing_parents(tmp_path, version):
    path = tmp_path / "workspaces.json"
    record = {
        "id": "legacy", "name": "Legacy", "tabs": ["root", "child"],
        "activeSession": "root", "createdAt": 1000, "updatedAt": 1000,
        "lastActiveAt": 1000,
    }
    for introduced, field in (
        (3, "groups"), (4, "quickLinks"), (7, "inheritedPins"),
        (8, "separators"), (9, "separatorsBefore"), (10, "paneLayouts"),
        (11, "callbackSessions"),
    ):
        if version >= introduced:
            record[field] = []
    payload = {
        "version": version, "sessionRenameRevision": 0, "commonQuickLinks": [],
        "sessionQuickLinks": {}, "commonNote": "", "workspaceNotes": {},
        "sessionNotes": {}, "pinnedSessions": [], "globalCallbackSessions": [],
        "workspaces": [record],
    }
    path.write_text(json.dumps(payload))
    store = WorkspaceStore(path)

    assert store.get_workspace("legacy").get("parents", {}) == {}
    store.update_workspace("legacy", name="Upgraded", update_name=True)
    upgraded = json.loads(path.read_text())
    assert upgraded["version"] == 14
    assert "parents" not in upgraded["workspaces"][0]


@pytest.mark.parametrize("parents", [
    None, [], "child", 1, {"child": None}, {"child": []},
    {1: "root"}, {"": "root"}, {"child": "bad:name"},
    {"missing": "root"}, {"child": "missing"}, {"child": "child"},
    {"root": "child", "child": "root"},
    {"root": "grandchild", "child": "root", "grandchild": "child"},
])
def test_invalid_parent_relationships_do_not_write_partial_workspaces(tmp_path, parents):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_tree(store)
    before = path.read_bytes()

    with pytest.raises((TypeError, ValueError)):
        create_tree(store, parents=parents)
    with pytest.raises((TypeError, ValueError)):
        store.update_workspace(
            original["id"], parents=parents, update_parents=True, session_revision=0,
        )
    assert path.read_bytes() == before
    assert store.get_workspace(original["id"]) == original


def test_corrupt_persisted_parent_cycle_fences_reads_and_writes(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_tree(store)
    payload = json.loads(path.read_text())
    payload["workspaces"][0]["parents"]["root"] = "grandchild"
    path.write_text(json.dumps(payload))
    corrupted = path.read_bytes()
    restored = WorkspaceStore(path)

    with pytest.raises(WorkspaceStoreUnavailable):
        restored.get_workspace(original["id"])
    with pytest.raises(WorkspaceStoreUnavailable):
        restored.update_workspace(original["id"], name="Changed", update_name=True)
    assert path.read_bytes() == corrupted


@pytest.mark.parametrize("operation", ["update", "activity", "replace", "remove"])
def test_removing_parent_promotes_descendants_to_nearest_remaining_ancestor(tmp_path, operation):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_tree(store)
    workspace_id = original["id"]
    remaining = ["root", "grandchild", "sibling", "other"]

    if operation == "update":
        updated = store.update_workspace(
            workspace_id, tabs=remaining, update_tabs=True, session_revision=0,
        )
    elif operation == "activity":
        updated = store.record_activity(
            workspace_id, tabs=remaining, active_session="root", session_revision=0,
        )
    elif operation == "replace":
        updated = store.replace_workspace_sessions(
            workspace_id, sessions=remaining, session_revision=0,
        )["workspace"]
    else:
        updated = store.remove_workspace_sessions(
            workspace_id, sessions=["child"], session_revision=0,
        )["workspace"]

    assert updated["parents"] == {"grandchild": "root", "sibling": "root"}
    flattened = store.record_activity(
        workspace_id, tabs=["grandchild", "sibling", "other"],
        active_session="grandchild", session_revision=0,
    )
    assert flattened.get("parents", {}) == {}


def test_omitted_parents_survive_rename_reordering_and_other_metadata_updates(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_tree(store)
    changed = store.update_workspace(original["id"], name="Changed", update_name=True)
    assert changed["parents"] == original["parents"]

    reordered = store.record_activity(
        original["id"], tabs=list(reversed(original["tabs"])),
        active_session="child", session_revision=0,
    )
    assert reordered["parents"] == original["parents"]
    store.rename_session("root", "renamed-root")
    renamed = store.get_workspace(original["id"])
    assert renamed["parents"] == {
        "child": "renamed-root", "grandchild": "child", "sibling": "renamed-root",
    }
    store.rename_session("child", "renamed-child")
    assert store.get_workspace(original["id"])["parents"] == {
        "renamed-child": "renamed-root", "grandchild": "renamed-child",
        "sibling": "renamed-root",
    }


@pytest.mark.parametrize("source_nested", [True, False])
def test_rename_collision_preserves_source_parent_identity(tmp_path, source_nested):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    parents = {"target": "other", "grandchild": "child"}
    if source_nested:
        parents["child"] = "root"
    original = create_tree(store, tabs=["root", "child", "target", "grandchild", "other"], parents=parents)

    store.rename_session("child", "target")

    renamed = store.get_workspace(original["id"])
    expected = {"grandchild": "target"}
    if source_nested:
        expected["target"] = "root"
    assert renamed["parents"] == expected
    assert renamed["tabs"].count("target") == 1
    assert "child" not in renamed["tabs"]


def test_parent_only_updates_require_revision_and_obey_optimistic_concurrency(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_tree(store)
    changed = store.update_workspace(
        original["id"], parents={"child": "other"}, update_parents=True,
        session_revision=0, expected_updated_at=original["updatedAt"],
    )
    with pytest.raises(WorkspaceUpdateConflict):
        store.update_workspace(
            original["id"], parents=original["parents"], update_parents=True,
            session_revision=0, expected_updated_at=original["updatedAt"],
        )
    assert store.get_workspace(original["id"])["parents"] == changed["parents"]

    store.rename_session("other", "renamed-other")
    with pytest.raises(WorkspaceSessionRevisionConflict):
        store.update_workspace(
            original["id"], parents={}, update_parents=True, session_revision=0,
        )


def test_forget_and_undo_restore_tree_without_reverting_concurrent_reparenting(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_tree(store)
    snapshot = store.capture_forget_session("child")
    store.forget_session("child")
    assert store.get_workspace(original["id"])["parents"] == {
        "grandchild": "root", "sibling": "root",
    }
    restored = store.restore_forgotten_session(snapshot)[0]
    assert restored["parents"] == original["parents"]

    snapshot = store.capture_forget_session("child")
    store.forget_session("child")
    store.update_workspace(
        original["id"], parents={"grandchild": "other", "sibling": "other"},
        update_parents=True, session_revision=3,
    )
    restored = store.restore_forgotten_session(snapshot)[0]
    assert restored["parents"] == {
        "child": "root", "grandchild": "other", "sibling": "other",
    }
    assert WorkspaceStore(path).get_workspace(original["id"])["parents"] == restored["parents"]


@pytest.mark.parametrize("forgotten", list(permutations(["root", "child", "grandchild"])))
@pytest.mark.parametrize("undo_order", list(permutations(["root", "child", "grandchild"])))
def test_multiple_pending_forgets_restore_nested_chain_in_any_order(tmp_path, forgotten, undo_order):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = create_tree(store)
    snapshots = {}
    for session_name in forgotten:
        snapshots[session_name] = store.capture_forget_session(
            session_name, previous_snapshots=tuple(snapshots.values()),
        )
        store.forget_session(session_name)
    for session_name in undo_order:
        store.restore_forgotten_session(snapshots[session_name])

    restored = store.get_workspace(original["id"])
    assert restored["tabs"] == original["tabs"]
    assert restored["parents"] == original["parents"]
    assert WorkspaceStore(path).get_workspace(original["id"])["parents"] == original["parents"]


def test_undo_forget_preserves_concurrent_promotion_to_root(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_tree(store)
    snapshot = store.capture_forget_session("child")
    store.forget_session("child")
    store.update_workspace(
        original["id"], parents={"sibling": "root"},
        update_parents=True, session_revision=1,
    )

    store.restore_forgotten_session(snapshot)

    restored = store.get_workspace(original["id"])
    assert restored["parents"] == {"child": "root", "sibling": "root"}
    assert "grandchild" in restored["tabs"]
    assert "grandchild" not in restored["parents"]


def test_undo_forget_does_not_make_cycle_after_concurrent_session_reintroduction(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    original = create_tree(store)
    snapshot = store.capture_forget_session("child")
    store.forget_session("child")
    # Another tab reattaches the forgotten session beneath its former child.
    # Restoring the original grandchild -> child edge would create a cycle.
    concurrent_parents = {
        "child": "grandchild", "grandchild": "root", "sibling": "root",
    }
    store.update_workspace(
        original["id"], tabs=original["tabs"], update_tabs=True,
        parents=concurrent_parents, update_parents=True, session_revision=1,
    )

    store.restore_forgotten_session(snapshot)

    restored = store.get_workspace(original["id"])
    assert restored["parents"] == concurrent_parents
    assert restored["tabs"].count("child") == 1


def test_unpinning_inherited_parent_promotes_descendants_to_surviving_ancestor(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    original = store.create_workspace(
        name="Inherited pin", tabs=["root", "grandchild"], active_session="root",
    )
    store.set_session_workspace_pinned("child", True)
    store.update_workspace(
        original["id"], parents={"child": "root", "grandchild": "child"},
        update_parents=True, session_revision=1,
    )

    store.set_session_workspace_pinned("child", False)

    updated = store.get_workspace(original["id"])
    assert updated["tabs"] == ["root", "grandchild"]
    assert updated["parents"] == {"grandchild": "root"}
    assert WorkspaceStore(path).get_workspace(original["id"])["parents"] == updated["parents"]


@pytest.mark.parametrize("operation", ["copy", "move"])
def test_transfers_preserve_available_tree_relationships_without_overwriting_destination(tmp_path, operation):
    ids = iter(["source", "destination"])
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: next(ids))
    create_tree(store)
    store.create_workspace(
        name="Destination", tabs=["destination-root", "sibling"],
        active_session="destination-root", parents={"sibling": "destination-root"},
    )

    result = store.transfer_sessions(
        ["root", "child", "sibling"], operation=operation,
        source_workspace_id="source", destination_workspace_id="destination",
        session_revision=0,
    )

    assert result["destinationWorkspace"]["parents"] == {
        "child": "root", "sibling": "destination-root",
    }
    if operation == "move":
        assert result["sourceWorkspace"]["tabs"] == ["grandchild", "other"]
        assert result["sourceWorkspace"].get("parents", {}) == {}
    else:
        assert result["sourceWorkspace"]["parents"]["grandchild"] == "child"


def test_moving_only_parent_promotes_child_but_does_not_copy_absent_ancestor(tmp_path):
    ids = iter(["source", "destination"])
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: next(ids))
    create_tree(store)
    store.create_workspace(name="Destination", tabs=["other"], active_session="other")

    moved = store.transfer_session(
        "child", operation="move", source_workspace_id="source",
        destination_workspace_id="destination", session_revision=0,
    )

    assert moved["sourceWorkspace"]["parents"] == {
        "grandchild": "root", "sibling": "root",
    }
    assert moved["destinationWorkspace"].get("parents", {}) == {}


@pytest.mark.parametrize("operation", ["copy", "move"])
def test_transfer_from_unsaved_workspace_preserves_selected_tree_and_existing_destination_identity(tmp_path, operation):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "destination")
    store.create_workspace(
        name="Destination", tabs=["destination-root", "existing-child", "existing-root"],
        active_session="destination-root", parents={"existing-child": "destination-root"},
    )

    result = store.transfer_sessions(
        ["root", "child", "existing-child", "existing-root"], operation=operation,
        source_workspace_id=None, destination_workspace_id="destination", session_revision=0,
        source_parents={
            "child": "root", "existing-child": "root", "existing-root": "child",
        },
    )

    assert result["sourceWorkspace"] is None
    assert result["sourceRemoved"] == []
    assert result["destinationAdded"] == ["root", "child"]
    assert result["destinationWorkspace"]["parents"] == {
        "existing-child": "destination-root", "child": "root",
    }
    assert "existing-root" not in result["destinationWorkspace"]["parents"]
    assert WorkspaceStore(path).get_workspace("destination")["parents"] == result["destinationWorkspace"]["parents"]


@pytest.mark.parametrize("source_parents", [
    None, [], "root", {"child": None}, {"outside": "root"},
    {"child": "outside"}, {"child": "child"}, {"root": "child", "child": "root"},
])
def test_unsaved_transfer_rejects_invalid_source_parents_without_writes(tmp_path, source_parents):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "destination")
    original = store.create_workspace(name="Destination", tabs=["outside"], active_session="outside")
    before = path.read_bytes()

    with pytest.raises((TypeError, ValueError)):
        store.transfer_sessions(
            ["root", "child"], source_parents=source_parents,
            destination_workspace_id="destination", operation="copy", session_revision=0,
        )

    assert path.read_bytes() == before
    assert store.get_workspace("destination") == original


def test_saved_source_uses_persisted_parents_and_rejects_nonempty_source_override(tmp_path):
    ids = iter(["source", "destination"])
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: next(ids))
    store.create_workspace(
        name="Source", tabs=["root", "child"], active_session="root", parents={"child": "root"},
    )
    original_destination = store.create_workspace(name="Destination", tabs=[], active_session=None)

    with pytest.raises(ValueError):
        store.transfer_sessions(
            ["root", "child"], source_workspace_id="source", source_parents={"child": "root"},
            destination_workspace_id="destination", operation="copy", session_revision=0,
        )
    assert store.get_workspace("destination") == original_destination

    result = store.transfer_sessions(
        ["root", "child"], source_workspace_id="source", source_parents={},
        destination_workspace_id="destination", operation="copy", session_revision=0,
    )
    assert result["destinationWorkspace"]["parents"] == {"child": "root"}


def test_single_unsaved_transfer_validates_source_parents_against_its_selection(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "destination")
    original = store.create_workspace(name="Destination", tabs=["root"], active_session="root")

    with pytest.raises(ValueError):
        store.transfer_session(
            "child", source_parents={"child": "root"}, destination_workspace_id="destination",
            operation="copy", session_revision=0,
        )
    assert store.get_workspace("destination") == original

    result = store.transfer_session(
        "child", source_parents={}, destination_workspace_id="destination",
        operation="copy", session_revision=0,
    )
    assert result["destinationWorkspace"]["tabs"] == ["root", "child"]
    assert result["destinationWorkspace"].get("parents", {}) == {}
