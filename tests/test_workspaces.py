from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from tmux_console.workspaces import (
    MAX_SESSION_RENAME_REVISION,
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_TABS,
    WORKSPACE_SCHEMA_VERSION,
    WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    WorkspaceNotFoundError,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    _WorkspaceDirectorySyncError,
    default_workspaces_path,
)


def sequence(values):
    iterator = iter(values)
    return lambda: next(iterator)


def test_workspace_crud_activity_order_and_persistence(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=sequence([10, 20, 30, 40]),
        id_factory=sequence(["first-id", "second-id"]),
    )

    first = store.create_workspace(
        name="  Project alpha  ",
        tabs=["agent-a", "agent-b"],
        active_session="agent-b",
    )
    store.create_workspace(
        name="Empty workspace",
        tabs=[],
        active_session=None,
    )
    assert first == {
        "id": "first-id",
        "name": "Project alpha",
        "tabs": ["agent-a", "agent-b"],
        "activeSession": "agent-b",
        "createdAt": 10_000,
        "updatedAt": 10_000,
        "lastActiveAt": 10_000,
        "sessionRevision": 0,
    }
    assert [workspace["id"] for workspace in store.list_workspaces()] == [
        "second-id",
        "first-id",
    ]

    renamed = store.update_workspace(
        "first-id",
        name="Renamed",
        update_name=True,
    )
    assert renamed["name"] == "Renamed"
    assert renamed["tabs"] == first["tabs"]
    assert renamed["updatedAt"] == 30_000
    assert renamed["lastActiveAt"] == first["lastActiveAt"]

    active = store.record_activity(
        "first-id",
        tabs=["agent-b", "missing-but-preserved"],
        active_session="missing-but-preserved",
        session_revision=0,
    )
    assert active["updatedAt"] == 40_000
    assert active["lastActiveAt"] == 40_000
    assert [workspace["id"] for workspace in store.list_workspaces()] == [
        "first-id",
        "second-id",
    ]
    assert WorkspaceStore(path).get_workspace("first-id") == active

    store.delete_workspace("second-id")
    with pytest.raises(WorkspaceNotFoundError, match="second-id"):
        store.get_workspace("second-id")
    assert [
        workspace["id"] for workspace in WorkspaceStore(path).list_workspaces()
    ] == ["first-id"]

    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["version"] == WORKSPACE_SCHEMA_VERSION
    assert document["sessionRenameRevision"] == 0
    persisted_active = {**active}
    del persisted_active["sessionRevision"]
    assert document["workspaces"] == [persisted_active]
    assert list(tmp_path.glob(".workspaces.json.*.tmp")) == []


def test_workspace_update_is_monotonic_and_requires_consistent_active_tab(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        clock=lambda: 10,
        id_factory=lambda: "workspace-id",
    )
    created = store.create_workspace(
        name="Project",
        tabs=["active", "other"],
        active_session="active",
    )

    with pytest.raises(ValueError, match="activeSession must be one"):
        store.update_workspace(
            "workspace-id",
            tabs=["other"],
            update_tabs=True,
            session_revision=0,
        )
    assert store.get_workspace("workspace-id") == created

    inactive = store.update_workspace(
        "workspace-id",
        active_session=None,
        update_active_session=True,
        session_revision=0,
    )
    updated = store.update_workspace(
        "workspace-id",
        tabs=[],
        update_tabs=True,
        session_revision=0,
    )
    active = store.record_activity(
        "workspace-id",
        tabs=[],
        active_session=None,
        session_revision=0,
    )
    assert inactive["updatedAt"] == created["updatedAt"] + 1
    assert updated["updatedAt"] == inactive["updatedAt"] + 1
    assert active["updatedAt"] == updated["updatedAt"] + 1
    assert active["lastActiveAt"] == active["updatedAt"]
    assert active["lastActiveAt"] > created["lastActiveAt"]


def test_version_one_workspace_defaults_session_revision_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "workspaces": [
                    {
                        "id": "legacy-id",
                        "name": "Legacy workspace",
                        "tabs": ["agent"],
                        "activeSession": "agent",
                        "createdAt": 1_000,
                        "updatedAt": 1_000,
                        "lastActiveAt": 1_000,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    store = WorkspaceStore(path, clock=lambda: 2)

    legacy = store.get_workspace("legacy-id")
    assert legacy["sessionRevision"] == 0
    store.update_workspace("legacy-id", name="Upgraded", update_name=True)

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["sessionRenameRevision"] == 0
    assert "sessionRevision" not in upgraded["workspaces"][0]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"name": "  "}, "name cannot be blank"),
        (
            {"name": "x" * (MAX_WORKSPACE_NAME_LENGTH + 1)},
            f"name must be {MAX_WORKSPACE_NAME_LENGTH} characters or fewer",
        ),
        ({"tabs": "agent"}, "tabs must be an array"),
        (
            {"tabs": [f"agent-{index}" for index in range(MAX_WORKSPACE_TABS + 1)]},
            f"tabs cannot contain more than {MAX_WORKSPACE_TABS} sessions",
        ),
        ({"tabs": ["agent", "agent"]}, "tabs contains duplicate session"),
        ({"tabs": ["agent"], "active_session": "missing"}, "activeSession must"),
        ({"tabs": [], "active_session": "agent"}, "activeSession must"),
    ],
)
def test_workspace_create_validation_does_not_write(tmp_path, kwargs, message):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    fields = {"name": "Project", "tabs": [], "active_session": None} | kwargs

    with pytest.raises((TypeError, ValueError), match=message):
        store.create_workspace(**fields)

    assert store.list_workspaces() == []
    assert not path.exists()


def test_workspace_session_rename_updates_every_reference_without_activity(tmp_path):
    path = tmp_path / "workspaces.json"
    ids = sequence(["one", "two", "unaffected"])
    store = WorkspaceStore(path, clock=lambda: 10, id_factory=ids)
    first = store.create_workspace(
        name="First",
        tabs=["old", "keep", "new"],
        active_session="old",
    )
    second = store.create_workspace(
        name="Second",
        tabs=["old"],
        active_session=None,
    )
    untouched = store.create_workspace(
        name="Untouched",
        tabs=["keep"],
        active_session="keep",
    )

    assert store.rename_session("old", "new") == 2
    renamed_first = store.get_workspace("one")
    renamed_second = store.get_workspace("two")
    assert renamed_first["tabs"] == ["new", "keep"]
    assert renamed_first["activeSession"] == "new"
    assert renamed_second["tabs"] == ["new"]
    assert renamed_first["lastActiveAt"] == first["lastActiveAt"]
    assert renamed_second["lastActiveAt"] == second["lastActiveAt"]
    assert renamed_first["updatedAt"] > first["updatedAt"]
    assert renamed_first["sessionRevision"] == 1
    assert renamed_second["sessionRevision"] == 1
    unaffected = store.get_workspace("unaffected")
    assert {**unaffected, "sessionRevision": 0} == untouched
    assert unaffected["sessionRevision"] == 1
    assert WorkspaceStore(path).get_workspace("one") == renamed_first

    with pytest.raises(WorkspaceSessionRevisionConflict, match="reload the workspace"):
        WorkspaceStore(path).record_activity(
            "one",
            tabs=["old", "ended-but-preserved"],
            active_session="old",
            session_revision=first["sessionRevision"],
        )
    assert WorkspaceStore(path).get_workspace("one") == renamed_first

    resumed = WorkspaceStore(path).record_activity(
        "one",
        tabs=["old", "ended-but-preserved"],
        active_session="old",
        session_revision=renamed_first["sessionRevision"],
    )
    assert resumed["tabs"] == ["old", "ended-but-preserved"]
    assert resumed["activeSession"] == "old"
    assert resumed["sessionRevision"] == renamed_first["sessionRevision"]
    latest = WorkspaceStore(path).record_activity(
        "one",
        tabs=["another-unavailable"],
        active_session="another-unavailable",
        session_revision=renamed_first["sessionRevision"],
    )
    assert latest["tabs"] == ["another-unavailable"]
    assert latest["sessionRevision"] == renamed_first["sessionRevision"]


def test_global_rename_revision_rejects_stale_tab_after_newer_device_removed_it(
    tmp_path,
):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, clock=lambda: 10, id_factory=lambda: "workspace-id")
    created = store.create_workspace(
        name="Project",
        tabs=["old", "keep"],
        active_session="old",
    )
    without_old = store.record_activity(
        "workspace-id",
        tabs=["keep"],
        active_session="keep",
        session_revision=created["sessionRevision"],
    )

    assert store.rename_session("old", "new") == 0
    after_rename = WorkspaceStore(path).get_workspace("workspace-id")
    assert after_rename["tabs"] == ["keep"]
    assert after_rename["sessionRevision"] == without_old["sessionRevision"] + 1

    with pytest.raises(WorkspaceSessionRevisionConflict, match="reload the workspace"):
        WorkspaceStore(path).record_activity(
            "workspace-id",
            tabs=["old", "keep"],
            active_session="old",
            session_revision=without_old["sessionRevision"],
        )
    assert WorkspaceStore(path).get_workspace("workspace-id") == after_rename


def test_failed_persistence_does_not_mutate_memory(tmp_path, monkeypatch):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )

    def fail_persist(_workspaces, _session_rename_revision):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)
    with pytest.raises(OSError, match="disk full"):
        store.create_workspace(name="Lost", tabs=[], active_session=None)

    assert store.list_workspaces() == []


def test_failed_rename_revision_persistence_does_not_advance_memory(
    tmp_path, monkeypatch
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    created = store.create_workspace(
        name="Project", tabs=["old"], active_session="old"
    )

    def fail_persist(_workspaces, _session_rename_revision):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)
    with pytest.raises(OSError, match="disk full"):
        store.rename_session("old", "new")

    assert store.get_workspace("workspace-id") == created
    with pytest.raises(WorkspaceStoreUnavailable):
        store.record_activity(
            "workspace-id",
            tabs=["old"],
            active_session="old",
            session_revision=created["sessionRevision"],
        )


def test_post_replace_directory_sync_failure_advances_without_fencing(
    tmp_path, monkeypatch
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    store.create_workspace(name="Project", tabs=["old"], active_session="old")
    persist = store._persist

    def fail_directory_sync(_workspaces, _session_rename_revision):
        raise _WorkspaceDirectorySyncError("directory sync failed")

    monkeypatch.setattr(store, "_persist", fail_directory_sync)
    with pytest.raises(_WorkspaceDirectorySyncError, match="directory sync failed"):
        store.rename_session("old", "new")

    renamed = store.get_workspace("workspace-id")
    assert renamed["tabs"] == ["new"]
    assert renamed["sessionRevision"] == 1
    monkeypatch.setattr(store, "_persist", persist)
    active = store.record_activity(
        "workspace-id",
        tabs=["new", "unavailable"],
        active_session="unavailable",
        session_revision=renamed["sessionRevision"],
    )
    assert active["tabs"] == ["new", "unavailable"]


def test_session_rename_revision_exhaustion_is_persisted_as_a_write_fence(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": WORKSPACE_SCHEMA_VERSION,
                "sessionRenameRevision": MAX_SESSION_RENAME_REVISION - 1,
                "workspaces": [
                    {
                        "id": "workspace-id",
                        "name": "Project",
                        "tabs": ["old"],
                        "activeSession": "old",
                        "createdAt": 1_000,
                        "updatedAt": 1_000,
                        "lastActiveAt": 1_000,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    store = WorkspaceStore(path, clock=lambda: 2)

    assert store.rename_session("old", "new") == 1
    exhausted = store.get_workspace("workspace-id")
    assert exhausted["tabs"] == ["new"]
    assert exhausted["sessionRevision"] == MAX_SESSION_RENAME_REVISION
    with pytest.raises(WorkspaceStoreUnavailable):
        store.record_activity(
            "workspace-id",
            tabs=["new"],
            active_session="new",
            session_revision=MAX_SESSION_RENAME_REVISION,
        )

    reloaded = WorkspaceStore(path)
    assert reloaded.get_workspace("workspace-id") == exhausted
    with pytest.raises(WorkspaceStoreUnavailable):
        reloaded.update_workspace(
            "workspace-id", name="Blocked", update_name=True
        )


def test_corrupt_or_unsupported_state_fails_closed(tmp_path):
    path = tmp_path / "workspaces.json"
    original = b'{"version": 99, "workspaces": []}'
    path.write_bytes(original)
    store = WorkspaceStore(path)

    with pytest.raises(
        WorkspaceStoreUnavailable,
        match=WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    ):
        store.list_workspaces()
    with pytest.raises(WorkspaceStoreUnavailable):
        store.create_workspace(name="Do not overwrite", tabs=[], active_session=None)
    assert path.read_bytes() == original


def test_concurrent_creates_are_serialized_without_lost_updates(tmp_path):
    path = tmp_path / "workspaces.json"
    id_lock = iter(f"workspace-{index}" for index in range(20))
    store = WorkspaceStore(path, id_factory=lambda: next(id_lock))

    def create(index: int) -> None:
        store.create_workspace(
            name=f"Workspace {index}",
            tabs=[f"session-{index}"],
            active_session=f"session-{index}",
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(create, range(20)))

    workspaces = WorkspaceStore(path).list_workspaces()
    assert len(workspaces) == 20
    assert {workspace["id"] for workspace in workspaces} == {
        f"workspace-{index}" for index in range(20)
    }


def test_default_workspace_path_honors_environment(monkeypatch, tmp_path):
    configured = tmp_path / "nested" / "saved.json"
    monkeypatch.setenv("MUXDECK_WORKSPACES_FILE", str(configured))
    assert default_workspaces_path() == configured
