from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from itertools import permutations

import pytest

from tmux_console.workspaces import (
    MAX_GLOBAL_CALLBACK_SESSIONS,
    MAX_SCOPED_NOTE_PAGES,
    MAX_SESSION_RENAME_REVISION,
    MAX_WORKSPACE_CALLBACK_SESSIONS,
    MAX_WORKSPACE_GROUP_ID_LENGTH,
    MAX_WORKSPACE_GROUP_NAME_LENGTH,
    MAX_WORKSPACE_GROUPS,
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_QUICK_LINKS,
    MAX_WORKSPACE_TABS,
    WORKSPACE_SCHEMA_VERSION,
    WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    WorkspaceNotFoundError,
    WorkspacePinCapacityError,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    WorkspaceTransferConflictError,
    _WorkspaceDirectorySyncError,
    default_workspaces_path,
    normalize_scoped_note,
    validate_scoped_note_notebook,
    validate_session_notes,
    validate_session_quick_links,
    validate_workspace_notes,
    validate_workspace_quick_links,
)


def sequence(values):
    iterator = iter(values)
    return lambda: next(iterator)


def test_separators_persist_follow_renames_and_prune_closed_tabs(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    workspace = store.create_workspace(
        name="Separators", tabs=["a", "b", "c"], active_session="a",
        groups=[workspace_group("pair", ["a", "b"])], separators=["a"],
        separators_before=["a", "b"],
    )
    workspace_id = workspace["id"]
    assert WorkspaceStore(path).get_workspace(workspace_id)["separators"] == ["a"]
    changed = store.update_workspace(
        workspace_id, separators=["b", "a"], update_separators=True, session_revision=0,
    )
    assert changed["separators"] == ["a", "b"]
    assert changed["groups"] == workspace["groups"]
    assert changed["separatorsBefore"] == ["a", "b"]
    store.rename_session("a", "renamed")
    assert store.get_workspace(workspace_id)["separators"] == ["renamed", "b"]
    assert store.get_workspace(workspace_id)["separatorsBefore"] == ["renamed", "b"]
    with pytest.raises(WorkspaceSessionRevisionConflict):
        store.update_workspace(
            workspace_id, separators=["a"], update_separators=True, session_revision=0,
        )
    closed = store.record_activity(
        workspace_id, tabs=["c", "renamed"], active_session="c", session_revision=1,
    )
    assert closed["separators"] == ["renamed"]
    assert closed["separatorsBefore"] == ["renamed"]
    assert WorkspaceStore(path).get_workspace(workspace_id)["separators"] == ["renamed"]


@pytest.mark.parametrize("version", [7, 8, 9])
def test_older_workspace_loads_without_before_separators(tmp_path, version):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path)
    workspace = store.create_workspace(name="Old", tabs=["a"], active_session="a")
    payload = json.loads(path.read_text())
    payload["version"] = version
    for record in payload["workspaces"]:
        if version < 8:
            record.pop("separators")
        if version < 9:
            record.pop("separatorsBefore")
        record.pop("paneLayouts")
    path.write_text(json.dumps(payload))
    restored = WorkspaceStore(path)
    assert restored.get_workspace(workspace["id"])["separators"] == []
    assert restored.get_workspace(workspace["id"])["separatorsBefore"] == []
    restored.update_workspace(
        workspace["id"], separators=["a"], update_separators=True, session_revision=0,
    )
    assert json.loads(path.read_text())["version"] == WORKSPACE_SCHEMA_VERSION


def workspace_group(
    group_id,
    tabs,
    *,
    name="Focus",
    color="blue",
    collapsed=False,
):
    return {
        "id": group_id,
        "name": name,
        "color": color,
        "collapsed": collapsed,
        "tabs": tabs,
    }


def three_pane_layout():
    return {
        "id": "triage",
        "name": "Triage board",
        "root": {
            "id": "split-root",
            "kind": "split",
            "direction": "horizontal",
            "ratio": 0.6,
            "first": {"id": "main", "kind": "pane", "session": "agent-a"},
            "second": {
                "id": "split-right",
                "kind": "split",
                "direction": "vertical",
                "ratio": 0.5,
                "first": {"id": "review", "kind": "pane", "session": "agent-b"},
                "second": {"id": "spare", "kind": "pane", "session": None},
            },
        },
    }


def test_workspace_pane_layouts_persist_rename_and_clear_closed_sessions(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    created = store.create_workspace(
        name="Project",
        tabs=["agent-a", "agent-b", "agent-c"],
        active_session="agent-a",
        pane_layouts=[three_pane_layout()],
    )

    assert created["paneLayouts"] == [three_pane_layout()]
    assert WorkspaceStore(path).get_workspace("workspace-id")["paneLayouts"] == [
        three_pane_layout()
    ]

    assert store.rename_session("agent-b", "reviewer") == 1
    renamed = store.get_workspace("workspace-id")
    right = renamed["paneLayouts"][0]["root"]["second"]
    assert right["first"]["session"] == "reviewer"

    pruned = store.record_activity(
        "workspace-id",
        tabs=["agent-a", "agent-c"],
        active_session="agent-a",
        session_revision=renamed["sessionRevision"],
    )
    assert pruned["paneLayouts"][0]["root"]["second"]["first"]["session"] is None


def test_forget_session_removes_navigation_references_from_every_workspace(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        clock=lambda: 20,
        id_factory=sequence(["primary", "secondary"]),
    )
    store.create_workspace(
        name="Primary",
        tabs=["agent-a", "agent-b", "agent-c"],
        groups=[workspace_group("agents", ["agent-a", "agent-b"])],
        separators=["agent-b"],
        separators_before=["agent-b"],
        pane_layouts=[three_pane_layout()],
        active_session="agent-b",
        callback_sessions=["agent-b", "ended"],
    )
    store.create_workspace(
        name="Secondary",
        tabs=["agent-b", "review"],
        active_session="review",
    )
    store.set_session_workspace_pinned("agent-b", True)
    store.add_global_callback_sessions(sessions=["agent-b"], session_revision=1)

    assert store.forget_session("agent-b") == 2

    primary = store.get_workspace("primary")
    assert primary["tabs"] == ["agent-a", "agent-c"]
    assert primary["groups"][0]["tabs"] == ["agent-a"]
    assert primary["separators"] == []
    assert primary["separatorsBefore"] == []
    assert primary["paneLayouts"][0]["root"]["second"]["first"]["session"] is None
    assert primary["callbackSessions"] == ["ended"]
    assert primary["activeSession"] == "agent-a"
    assert primary["sessionRevision"] == 2
    assert store.get_workspace("secondary")["tabs"] == ["review"]
    assert store.list_pinned_sessions() == ()
    assert store.get_global_callback_sessions()["callbackSessions"] == ["ended"]

    with pytest.raises(WorkspaceSessionRevisionConflict, match="reload the workspace"):
        store.record_activity(
            "primary",
            tabs=["agent-a", "agent-b", "agent-c"],
            active_session="agent-b",
            session_revision=1,
        )


def test_undo_forget_restores_all_navigation_metadata_and_fences_stale_writes(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, clock=lambda: 20, id_factory=sequence(["primary", "secondary"]))
    store.create_workspace(
        name="Primary", tabs=["agent-a", "agent-b", "agent-c"],
        groups=[workspace_group("agents", ["agent-a", "agent-b"])],
        separators=["agent-b"], separators_before=["agent-b"],
        pane_layouts=[three_pane_layout()], active_session="agent-b",
        callback_sessions=["agent-b", "ended"],
    )
    store.set_session_workspace_pinned("agent-b", True)
    store.create_workspace(name="Secondary", tabs=["review"], active_session="review")
    store.add_global_callback_sessions(sessions=["agent-b", "other"], session_revision=1)
    before = {item["id"]: item for item in store.list_workspaces()}
    snapshot = store.capture_forget_session("agent-b")
    store.forget_session("agent-b")

    restored = store.restore_forgotten_session(snapshot)

    assert {item["id"] for item in restored} == {"primary", "secondary"}
    for workspace in restored:
        original = before[workspace["id"]]
        assert workspace["updatedAt"] > original["updatedAt"]
        assert workspace["sessionRevision"] == 3
        assert {key: value for key, value in workspace.items() if key not in {"updatedAt", "sessionRevision"}} == {
            key: value for key, value in original.items() if key not in {"updatedAt", "sessionRevision"}
        }
    assert store.list_pinned_sessions() == ("agent-b",)
    assert store.get_global_callback_sessions()["globalCallbackSessions"] == ["agent-b", "other"]
    assert WorkspaceStore(path).list_workspaces() == store.list_workspaces()
    # The secondary workspace inherited this pin; unpin must remove it there,
    # while retaining the explicit primary workspace membership.
    with pytest.raises(WorkspaceSessionRevisionConflict):
        store.record_activity("primary", tabs=["agent-a"], active_session="agent-a", session_revision=2)
    store.set_session_workspace_pinned("agent-b", False)
    assert store.get_workspace("secondary")["tabs"] == ["review"]
    assert "agent-b" in store.get_workspace("primary")["tabs"]


def test_undo_forget_preserves_subsequent_workspace_edits(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "primary")
    store.create_workspace(
        name="Primary", tabs=["agent-a", "agent-b", "agent-c"], active_session="agent-b",
        groups=[workspace_group("agents", ["agent-a", "agent-b"])],
        pane_layouts=[three_pane_layout()], separators=["agent-b"],
        callback_sessions=["agent-b", "old-callback"],
    )
    snapshot = store.capture_forget_session("agent-b")
    store.forget_session("agent-b")
    layout = three_pane_layout()
    layout["name"] = "Renamed layout"
    layout["root"]["ratio"] = 0.7
    layout["root"]["second"]["first"]["session"] = None
    layout["root"]["second"]["second"]["session"] = "new-tab"
    store.update_workspace(
        "primary", name="Renamed", update_name=True,
        tabs=["agent-c", "agent-a", "new-tab"], update_tabs=True,
        active_session="agent-c", update_active_session=True,
        groups=[workspace_group("agents", ["agent-a"], name="Changed", color="green", collapsed=True)],
        update_groups=True, pane_layouts=[layout], update_pane_layouts=True,
        callback_sessions=["new-callback"], update_callback_sessions=True,
        separators=["agent-c"], update_separators=True, session_revision=1,
    )

    restored = store.restore_forgotten_session(snapshot)[0]

    assert restored["name"] == "Renamed"
    assert restored["tabs"] == ["agent-c", "agent-a", "agent-b", "new-tab"]
    assert restored["activeSession"] == "agent-c"
    assert restored["groups"] == [workspace_group("agents", ["agent-a", "agent-b"], name="Changed", color="green", collapsed=True)]
    assert restored["separators"] == ["agent-c", "agent-b"]
    assert restored["callbackSessions"] == ["agent-b", "new-callback"]
    layout["root"]["second"]["first"]["session"] = "agent-b"
    assert restored["paneLayouts"] == [layout]


@pytest.mark.parametrize("forgotten", list(permutations(["a", "b", "c"])))
@pytest.mark.parametrize("undo_order", list(permutations(["a", "b", "c"])))
def test_multiple_undo_forgets_restore_tab_group_callback_order(tmp_path, forgotten, undo_order):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "primary")
    original = store.create_workspace(
        name="Primary", tabs=["a", "b", "c"], active_session="a",
        groups=[workspace_group("group", ["a", "b", "c"])],
        callback_sessions=["a", "b", "c"],
    )
    store.add_global_callback_sessions(sessions=["a", "b", "c"], session_revision=0)
    snapshots = {}
    for session_name in forgotten:
        snapshots[session_name] = store.capture_forget_session(
            session_name, previous_snapshots=tuple(snapshots.values()),
        )
        store.forget_session(session_name)
    for session_name in undo_order:
        store.restore_forgotten_session(snapshots[session_name])

    restored = store.get_workspace("primary")
    assert restored["tabs"] == original["tabs"]
    assert restored["groups"] == original["groups"]
    assert restored["callbackSessions"] == original["callbackSessions"]
    assert restored["activeSession"] == "a"
    assert store.get_global_callback_sessions()["globalCallbackSessions"] == ["a", "b", "c"]
    assert WorkspaceStore(store.path).get_workspace("primary") == restored


def test_undo_forget_preserves_deleted_workspaces_groups_and_changed_panes(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=sequence(["primary", "deleted"]))
    store.create_workspace(
        name="Primary", tabs=["agent-a", "agent-b", "agent-c"], active_session="agent-b",
        groups=[workspace_group("agents", ["agent-a", "agent-b"])],
        pane_layouts=[three_pane_layout()],
    )
    store.create_workspace(name="Delete me", tabs=["agent-b"], active_session="agent-b")
    snapshot = store.capture_forget_session("agent-b")
    store.forget_session("agent-b")
    store.delete_workspace("deleted")
    layout = three_pane_layout()
    layout["root"]["second"]["first"]["session"] = "agent-c"
    store.update_workspace(
        "primary", groups=[], update_groups=True,
        pane_layouts=[layout], update_pane_layouts=True, session_revision=1,
    )

    restored = store.restore_forgotten_session(snapshot)

    assert len(restored) == 1
    assert restored[0]["groups"] == []
    assert restored[0]["paneLayouts"] == [layout]
    with pytest.raises(WorkspaceNotFoundError):
        store.get_workspace("deleted")


def test_undo_forget_restores_global_pin_to_new_workspace(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "new")
    store.set_session_workspace_pinned("pinned", True)
    snapshot = store.capture_forget_session("pinned")
    store.forget_session("pinned")
    store.create_workspace(name="New", tabs=["own"], active_session="own")

    assert store.restore_forgotten_session(snapshot)[0]["tabs"] == ["own", "pinned"]
    store.set_session_workspace_pinned("pinned", False)
    assert store.get_workspace("new")["tabs"] == ["own"]


def test_undo_forget_capacity_failure_does_not_partially_restore_metadata(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "primary")
    store.create_workspace(name="Primary", tabs=["forgotten"], active_session="forgotten")
    store.add_global_callback_sessions(sessions=["forgotten"], session_revision=0)
    snapshot = store.capture_forget_session("forgotten")
    store.forget_session("forgotten")
    store.record_activity(
        "primary", tabs=[f"new-{index}" for index in range(MAX_WORKSPACE_TABS)],
        active_session="new-0", session_revision=1,
    )
    before = store.get_workspace("primary")

    with pytest.raises(WorkspacePinCapacityError, match="no free tabs"):
        store.restore_forgotten_session(snapshot)

    assert store.get_workspace("primary") == before
    assert store.get_global_callback_sessions()["globalCallbackSessions"] == []


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda layout: layout.update(name=" "), "name cannot be blank"),
        (
            lambda layout: layout["root"].update(ratio=0.99),
            "ratio must be between",
        ),
        (
            lambda layout: layout["root"]["second"]["first"].update(
                session="agent-a"
            ),
            "assigns session more than once",
        ),
        (
            lambda layout: layout["root"]["second"]["first"].update(
                session="outside"
            ),
            "must be one of the workspace tabs",
        ),
    ],
)
def test_workspace_pane_layout_validation_is_strict(tmp_path, mutate, message):
    layout = three_pane_layout()
    mutate(layout)
    store = WorkspaceStore(tmp_path / "workspaces.json")
    with pytest.raises((TypeError, ValueError), match=message):
        store.create_workspace(
            name="Project",
            tabs=["agent-a", "agent-b"],
            active_session="agent-a",
            pane_layouts=[layout],
        )


def test_workspace_callback_sessions_persist_follow_renames_and_fence_stale_writes(
    tmp_path,
):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    created = store.create_workspace(
        name="Callbacks",
        tabs=["agent-a", "agent-b"],
        active_session="agent-a",
        callback_sessions=["agent-a", "ended-session"],
    )
    assert created["callbackSessions"] == ["agent-a", "ended-session"]

    updated = store.update_workspace(
        "workspace-id",
        callback_sessions=["agent-b", "ended-session"],
        update_callback_sessions=True,
        session_revision=0,
    )
    assert updated["callbackSessions"] == ["agent-b", "ended-session"]
    assert updated["tabs"] == created["tabs"]
    assert WorkspaceStore(path).get_workspace("workspace-id") == updated

    assert store.rename_session("agent-b", "review-agent") == 1
    renamed = store.get_workspace("workspace-id")
    assert renamed["callbackSessions"] == ["review-agent", "ended-session"]
    with pytest.raises(WorkspaceSessionRevisionConflict, match="reload the workspace"):
        store.update_workspace(
            "workspace-id",
            callback_sessions=["agent-b"],
            update_callback_sessions=True,
            session_revision=0,
        )
    assert store.get_workspace("workspace-id") == renamed


def test_global_callback_sessions_union_workspace_entries_and_persist(tmp_path):
    path = tmp_path / "workspaces.json"
    ids = iter(["workspace-one", "workspace-two"])
    store = WorkspaceStore(path, id_factory=lambda: next(ids))
    store.create_workspace(
        name="One",
        tabs=["agent-a", "agent-b"],
        active_session="agent-a",
        callback_sessions=["agent-a", "ended"],
    )
    store.create_workspace(
        name="Two",
        tabs=["agent-b", "agent-c"],
        active_session="agent-b",
        callback_sessions=["agent-b", "agent-a"],
    )

    snapshot = store.get_global_callback_sessions()
    assert snapshot["globalCallbackSessions"] == []
    assert snapshot["callbackSessions"] == ["agent-a", "ended", "agent-b"]
    assert snapshot["workspaceCallbacks"] == [
        {
            "workspaceId": "workspace-one",
            "workspaceName": "One",
            "sessions": ["agent-a", "ended"],
        },
        {
            "workspaceId": "workspace-two",
            "workspaceName": "Two",
            "sessions": ["agent-b", "agent-a"],
        },
    ]

    added = store.add_global_callback_sessions(
        sessions=["agent-global", "agent-a"],
        session_revision=0,
    )
    assert added["added"] == ["agent-global", "agent-a"]
    assert added["globalCallbackSessions"] == ["agent-global", "agent-a"]
    assert added["callbackSessions"] == [
        "agent-global", "agent-a", "ended", "agent-b"
    ]
    assert WorkspaceStore(path).get_global_callback_sessions() == {
        key: value for key, value in added.items() if key != "added"
    }

    removed = store.remove_global_callback_sessions(
        sessions=["agent-a", "missing"],
        session_revision=0,
    )
    assert removed["removed"] == ["agent-a"]
    # Workspace-owned agent-a remains in the higher-level effective queue.
    assert "agent-a" in removed["callbackSessions"]

    assert store.rename_session("agent-global", "renamed-global") == 0
    assert store.get_global_callback_sessions()["globalCallbackSessions"] == [
        "renamed-global"
    ]


@pytest.mark.parametrize(
    "sessions",
    [
        None,
        ["agent", "agent"],
        [f"agent-{index}" for index in range(MAX_GLOBAL_CALLBACK_SESSIONS + 1)],
    ],
)
def test_global_callback_sessions_validate_strictly(tmp_path, sessions):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    with pytest.raises((TypeError, ValueError)):
        store.replace_global_callback_sessions(sessions, session_revision=0)


@pytest.mark.parametrize(
    ("callback_sessions", "message"),
    [
        (None, "callbackSessions must be an array"),
        (["agent", "agent"], "callbackSessions contains duplicate session"),
        (
            [f"agent-{index}" for index in range(MAX_WORKSPACE_CALLBACK_SESSIONS + 1)],
            f"callbackSessions cannot contain more than {MAX_WORKSPACE_CALLBACK_SESSIONS}",
        ),
    ],
)
def test_workspace_callback_sessions_validate_strictly(
    tmp_path,
    callback_sessions,
    message,
):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    with pytest.raises((TypeError, ValueError), match=message):
        store.create_workspace(
            name="Callbacks",
            tabs=["agent"],
            active_session="agent",
            callback_sessions=callback_sessions,
        )


def test_version_ten_workspace_loads_with_empty_callbacks_and_upgrades_on_write(
    tmp_path,
):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "legacy-id")
    store.create_workspace(name="Legacy", tabs=["agent"], active_session="agent")
    document = json.loads(path.read_text(encoding="utf-8"))
    document["version"] = 10
    document["workspaces"][0].pop("callbackSessions", None)
    path.write_text(json.dumps(document), encoding="utf-8")

    restored = WorkspaceStore(path)
    assert restored.get_workspace("legacy-id").get("callbackSessions", []) == []
    restored.update_workspace("legacy-id", name="Upgraded", update_name=True)
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == (
        WORKSPACE_SCHEMA_VERSION
    )


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
        "groups": [],
        "quickLinks": [],
        "separators": [],
        "separatorsBefore": [],
        "paneLayouts": [],
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
    assert document["commonQuickLinks"] == []
    assert document["sessionQuickLinks"] == {}
    assert document["commonNote"] == ""
    assert document["workspaceNotes"] == {}
    assert document["sessionNotes"] == {}
    assert document["pinnedSessions"] == []
    persisted_active = {**active}
    del persisted_active["sessionRevision"]
    persisted_active["inheritedPins"] = []
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
    assert upgraded["workspaces"][0]["groups"] == []
    assert upgraded["workspaces"][0]["quickLinks"] == []


def test_version_two_workspace_defaults_groups_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "sessionRenameRevision": 4,
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
    assert legacy["groups"] == []
    assert legacy["quickLinks"] == []
    assert legacy["sessionRevision"] == 4
    store.update_workspace("legacy-id", name="Upgraded", update_name=True)

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["sessionRenameRevision"] == 4
    assert upgraded["workspaces"][0]["groups"] == []
    assert upgraded["workspaces"][0]["quickLinks"] == []


def test_version_three_workspace_defaults_quick_links_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 3,
                "sessionRenameRevision": 4,
                "workspaces": [
                    {
                        "id": "legacy-id",
                        "name": "Legacy workspace",
                        "tabs": ["agent"],
                        "groups": [],
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
    assert legacy["quickLinks"] == []
    assert store.list_common_quick_links() == []
    store.replace_common_quick_links(
        [{"id": "docs", "label": "Docs", "url": "https://example.test/docs"}]
    )

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["commonQuickLinks"] == [
        {"id": "docs", "label": "Docs", "url": "https://example.test/docs"}
    ]
    assert upgraded["workspaces"][0]["quickLinks"] == []


def test_version_four_workspace_defaults_session_links_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 4,
                "sessionRenameRevision": 4,
                "commonQuickLinks": [
                    {
                        "id": "docs",
                        "label": "Docs",
                        "url": "https://example.test/docs",
                    }
                ],
                "workspaces": [
                    {
                        "id": "legacy-id",
                        "name": "Legacy workspace",
                        "tabs": ["agent"],
                        "groups": [],
                        "quickLinks": [
                            {
                                "id": "ticket",
                                "label": "Ticket",
                                "url": "https://example.test/ticket",
                            }
                        ],
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
    store = WorkspaceStore(path)

    assert store.get_session_quick_links("agent") == []
    store.replace_session_quick_links(
        "agent",
        [{"id": "trace", "label": "Trace", "url": "https://trace.test/run"}],
    )

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["sessionQuickLinks"] == {
        "agent": [
            {"id": "trace", "label": "Trace", "url": "https://trace.test/run"}
        ]
    }
    assert upgraded["commonQuickLinks"][0]["id"] == "docs"
    assert upgraded["workspaces"][0]["quickLinks"][0]["id"] == "ticket"


def test_version_five_workspace_defaults_scoped_notes_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 5,
                "sessionRenameRevision": 4,
                "commonQuickLinks": [],
                "sessionQuickLinks": {
                    "agent": [
                        {
                            "id": "trace",
                            "label": "Trace",
                            "url": "https://trace.test/run",
                        }
                    ]
                },
                "workspaces": [
                    {
                        "id": "legacy-id",
                        "name": "Legacy workspace",
                        "tabs": ["agent"],
                        "groups": [],
                        "quickLinks": [],
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
    store = WorkspaceStore(path)

    assert store.get_common_note() == ""
    assert store.get_workspace_note("legacy-id") == ""
    assert store.get_session_note("agent") == ""
    store.replace_workspace_note("legacy-id", "Remember this")

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["commonNote"] == ""
    assert upgraded["workspaceNotes"] == {"legacy-id": "Remember this"}
    assert upgraded["sessionNotes"] == {}
    assert upgraded["sessionQuickLinks"]["agent"][0]["id"] == "trace"


def test_version_six_workspace_defaults_global_pins_and_upgrades_on_write(tmp_path):
    path = tmp_path / "workspaces.json"
    path.write_text(
        json.dumps(
            {
                "version": 6,
                "sessionRenameRevision": 4,
                "commonQuickLinks": [],
                "sessionQuickLinks": {},
                "commonNote": "Shared",
                "workspaceNotes": {},
                "sessionNotes": {},
                "workspaces": [
                    {
                        "id": "legacy-id",
                        "name": "Legacy workspace",
                        "tabs": ["agent"],
                        "groups": [],
                        "quickLinks": [],
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
    store = WorkspaceStore(path)

    assert store.list_pinned_sessions() == ()
    store.replace_common_note("Updated")

    upgraded = json.loads(path.read_text(encoding="utf-8"))
    assert upgraded["version"] == WORKSPACE_SCHEMA_VERSION
    assert upgraded["pinnedSessions"] == []
    assert upgraded["workspaces"][0]["inheritedPins"] == []


def test_global_workspace_pin_deduplicates_and_tracks_inherited_membership(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=lambda: 10,
        id_factory=sequence(["explicit", "inherited", "future"]),
    )
    explicit = store.create_workspace(
        name="Already here",
        tabs=["agent", "other"],
        active_session="other",
    )
    inherited = store.create_workspace(
        name="Needs pin",
        tabs=["other"],
        active_session="other",
    )

    result = store.set_session_workspace_pinned("agent", True)

    assert result == {
        "session": "agent",
        "workspacePinned": True,
        "sessionRevision": 1,
    }
    assert store.list_pinned_sessions() == ("agent",)
    assert store.get_workspace("explicit")["tabs"] == ["agent", "other"]
    assert store.get_workspace("explicit")["updatedAt"] == explicit["updatedAt"]
    assert store.get_workspace("inherited")["tabs"] == ["other", "agent"]
    assert store.get_workspace("inherited")["updatedAt"] > inherited["updatedAt"]

    # Repeating the action is idempotent and never appends another copy.
    assert store.set_session_workspace_pinned("agent", True)["sessionRevision"] == 1
    assert store.get_workspace("inherited")["tabs"].count("agent") == 1

    future = store.create_workspace(
        name="Created later",
        tabs=["future-only"],
        active_session="future-only",
    )
    assert future["tabs"] == ["future-only", "agent"]

    # Stale or ordinary browser activity cannot drop a live global pin.
    saved = store.record_activity(
        "inherited",
        tabs=["other"],
        active_session="other",
        session_revision=1,
    )
    assert saved["tabs"] == ["other", "agent"]

    unpinned = store.set_session_workspace_pinned("agent", False)
    assert unpinned["sessionRevision"] == 2
    assert store.get_workspace("explicit")["tabs"] == ["agent", "other"]
    assert store.get_workspace("inherited")["tabs"] == ["other"]
    assert store.get_workspace("future")["tabs"] == ["future-only"]
    assert WorkspaceStore(path).list_pinned_sessions() == ()


def test_global_workspace_pin_rejects_full_workspace_atomically(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "full",
    )
    full_tabs = [f"session-{index}" for index in range(MAX_WORKSPACE_TABS)]
    original = store.create_workspace(
        name="Full",
        tabs=full_tabs,
        active_session=full_tabs[0],
    )

    with pytest.raises(
        WorkspacePinCapacityError,
        match=rf"already has {MAX_WORKSPACE_TABS} sessions",
    ):
        store.set_session_workspace_pinned("new-agent", True)

    assert store.list_pinned_sessions() == ()
    assert store.get_workspace("full") == original


def test_workspace_session_transfer_copies_deduplicates_and_moves_atomically(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=lambda: 10,
        id_factory=sequence(["source", "destination"]),
    )
    source = store.create_workspace(
        name="Source",
        tabs=["agent", "sidecar"],
        groups=[workspace_group("pair", ["agent", "sidecar"])],
        active_session="agent",
        callback_sessions=["agent"],
    )
    destination = store.create_workspace(
        name="Destination",
        tabs=["review"],
        active_session="review",
    )

    copied = store.transfer_session(
        "agent",
        source_workspace_id="source",
        destination_workspace_id="destination",
        operation="copy",
        session_revision=0,
    )
    assert copied["destinationAdded"] is True
    assert copied["destinationAlreadyContained"] is False
    assert copied["sourceRemoved"] is False
    assert copied["sessionRevision"] == 1
    assert copied["sourceWorkspace"]["tabs"] == source["tabs"]
    assert copied["sourceWorkspace"]["callbackSessions"] == ["agent"]
    assert copied["destinationWorkspace"]["tabs"] == ["review", "agent"]
    assert copied["destinationWorkspace"].get("callbackSessions", []) == []

    repeated = store.transfer_session(
        "agent",
        source_workspace_id="source",
        destination_workspace_id="destination",
        operation="copy",
        session_revision=1,
    )
    assert repeated["destinationAlreadyContained"] is True
    assert repeated["destinationAdded"] is False
    assert repeated["sessionRevision"] == 1
    assert repeated["destinationWorkspace"]["tabs"].count("agent") == 1

    moved = store.transfer_session(
        "agent",
        source_workspace_id="source",
        destination_workspace_id="destination",
        operation="move",
        session_revision=1,
    )
    assert moved["destinationAlreadyContained"] is True
    assert moved["destinationAdded"] is False
    assert moved["sourceRemoved"] is True
    assert moved["sessionRevision"] == 2
    assert moved["sourceWorkspace"]["tabs"] == ["sidecar"]
    assert moved["sourceWorkspace"]["groups"] == [
        workspace_group("pair", ["sidecar"])
    ]
    assert moved["sourceWorkspace"]["activeSession"] == "sidecar"
    assert moved["sourceWorkspace"].get("callbackSessions", []) == []
    assert moved["destinationWorkspace"]["tabs"] == ["review", "agent"]
    assert moved["destinationWorkspace"]["callbackSessions"] == ["agent"]
    assert WorkspaceStore(path).get_workspace("destination")["tabs"].count("agent") == 1
    assert destination["lastActiveAt"] == moved["destinationWorkspace"]["lastActiveAt"]


def test_workspace_session_batch_transfer_preserves_order_and_reconciles_source(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        clock=lambda: 10,
        id_factory=sequence(["source", "destination"]),
    )
    store.create_workspace(
        name="Source",
        tabs=["agent-a", "agent-b", "agent-c"],
        groups=[workspace_group("agents", ["agent-a", "agent-b", "agent-c"])],
        separators=["agent-a", "agent-b", "agent-c"],
        separators_before=["agent-a", "agent-b", "agent-c"],
        pane_layouts=[three_pane_layout()],
        active_session="agent-a",
        callback_sessions=["agent-b", "agent-a"],
    )
    store.create_workspace(
        name="Destination",
        tabs=["review", "agent-b"],
        active_session="review",
    )

    copied = store.transfer_sessions(
        ["agent-a", "agent-b", "agent-c"],
        source_workspace_id="source",
        destination_workspace_id="destination",
        operation="copy",
        session_revision=0,
    )
    assert copied["destinationAlreadyContained"] == ["agent-b"]
    assert copied["destinationAdded"] == ["agent-a", "agent-c"]
    assert copied["sourceRemoved"] == []
    assert copied["destinationWorkspace"]["tabs"] == [
        "review",
        "agent-b",
        "agent-a",
        "agent-c",
    ]
    assert copied["sessionRevision"] == 1

    moved = store.transfer_sessions(
        ["agent-a", "agent-b"],
        source_workspace_id="source",
        destination_workspace_id="destination",
        operation="move",
        session_revision=1,
    )
    assert moved["destinationAlreadyContained"] == ["agent-a", "agent-b"]
    assert moved["destinationAdded"] == []
    assert moved["sourceRemoved"] == ["agent-a", "agent-b"]
    assert moved["sourceWorkspace"]["tabs"] == ["agent-c"]
    assert moved["sourceWorkspace"]["groups"] == [
        workspace_group("agents", ["agent-c"])
    ]
    assert moved["sourceWorkspace"]["separators"] == ["agent-c"]
    assert moved["sourceWorkspace"]["separatorsBefore"] == ["agent-c"]
    assert moved["sourceWorkspace"]["activeSession"] == "agent-c"
    pane_root = moved["sourceWorkspace"]["paneLayouts"][0]["root"]
    assert pane_root["first"]["session"] is None
    assert pane_root["second"]["first"]["session"] is None
    assert moved["sourceWorkspace"].get("callbackSessions", []) == []
    assert moved["destinationWorkspace"]["callbackSessions"] == [
        "agent-b",
        "agent-a",
    ]
    assert moved["destinationWorkspace"]["tabs"] == [
        "review",
        "agent-b",
        "agent-a",
        "agent-c",
    ]
    assert moved["sessionRevision"] == 2


def test_workspace_session_batch_move_rejects_pins_and_capacity_atomically(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=sequence(["source", "destination"]),
    )
    store.create_workspace(
        name="Source",
        tabs=["agent-a", "agent-b"],
        active_session="agent-a",
    )
    store.create_workspace(
        name="Destination",
        tabs=["review"],
        active_session="review",
    )
    store.set_session_workspace_pinned("agent-b", True)
    pinned_source = store.get_workspace("source")
    pinned_destination = store.get_workspace("destination")

    with pytest.raises(WorkspaceTransferConflictError, match="agent-b"):
        store.transfer_sessions(
            ["agent-a", "agent-b"],
            source_workspace_id="source",
            destination_workspace_id="destination",
            operation="move",
            session_revision=1,
        )
    assert store.get_workspace("source") == pinned_source
    assert store.get_workspace("destination") == pinned_destination

    capacity_store = WorkspaceStore(
        tmp_path / "capacity-workspaces.json",
        id_factory=sequence(["capacity-source", "capacity-destination"]),
    )
    capacity_store.create_workspace(
        name="Source",
        tabs=["new-a", "new-b"],
        active_session="new-a",
    )
    destination_tabs = [
        f"session-{index}" for index in range(MAX_WORKSPACE_TABS - 1)
    ]
    full_destination = capacity_store.create_workspace(
        name="Nearly full",
        tabs=destination_tabs,
        active_session=destination_tabs[0],
    )
    capacity_source = capacity_store.get_workspace("capacity-source")

    with pytest.raises(WorkspaceTransferConflictError, match="would exceed"):
        capacity_store.transfer_sessions(
            ["new-a", "new-b"],
            source_workspace_id="capacity-source",
            destination_workspace_id="capacity-destination",
            operation="move",
            session_revision=0,
        )
    assert capacity_store.get_workspace("capacity-source") == capacity_source
    assert capacity_store.get_workspace("capacity-destination") == full_destination

    with pytest.raises(WorkspaceSessionRevisionConflict):
        capacity_store.transfer_sessions(
            ["new-a", "new-b"],
            source_workspace_id="capacity-source",
            destination_workspace_id="capacity-destination",
            operation="copy",
            session_revision=99,
        )


def test_workspace_session_move_preserves_source_when_callback_destination_is_full(
    tmp_path,
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=sequence(["source", "destination"]),
    )
    callbacks = [
        f"callback-{index}" for index in range(MAX_WORKSPACE_CALLBACK_SESSIONS)
    ]
    source = store.create_workspace(
        name="Source",
        tabs=["agent"],
        active_session="agent",
        callback_sessions=["agent"],
    )
    destination = store.create_workspace(
        name="Destination",
        tabs=["agent"],
        active_session="agent",
        callback_sessions=callbacks,
    )

    with pytest.raises(WorkspaceTransferConflictError, match="callback sessions"):
        store.transfer_session(
            "agent",
            source_workspace_id="source",
            destination_workspace_id="destination",
            operation="move",
            session_revision=0,
        )

    assert store.get_workspace("source") == source
    assert store.get_workspace("destination") == destination


def test_workspace_session_transfer_rejects_stale_full_and_pinned_moves(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=sequence(["source", "full"]),
    )
    store.create_workspace(
        name="Source",
        tabs=["agent"],
        active_session="agent",
    )
    full_tabs = [f"session-{index}" for index in range(MAX_WORKSPACE_TABS)]
    full = store.create_workspace(
        name="Full",
        tabs=full_tabs,
        active_session=full_tabs[0],
    )

    with pytest.raises(
        WorkspaceTransferConflictError,
        match=rf"already has {MAX_WORKSPACE_TABS} sessions",
    ):
        store.transfer_session(
            "agent",
            source_workspace_id="source",
            destination_workspace_id="full",
            operation="move",
            session_revision=0,
        )
    assert store.get_workspace("source")["tabs"] == ["agent"]
    assert store.get_workspace("full") == full

    pinned_store = WorkspaceStore(
        tmp_path / "pinned-workspaces.json",
        id_factory=sequence(["pinned-source", "pinned-destination"]),
    )
    pinned_store.create_workspace(
        name="Pinned source",
        tabs=["agent"],
        active_session="agent",
    )
    pinned_store.create_workspace(
        name="Pinned destination",
        tabs=[],
        active_session=None,
    )
    pinned_store.set_session_workspace_pinned("agent", True)
    with pytest.raises(WorkspaceSessionRevisionConflict, match="current revision is 1"):
        pinned_store.transfer_session(
            "agent",
            source_workspace_id="pinned-source",
            destination_workspace_id="pinned-destination",
            operation="copy",
            session_revision=0,
        )
    with pytest.raises(WorkspaceTransferConflictError, match="unpin it first"):
        pinned_store.transfer_session(
            "agent",
            source_workspace_id="pinned-source",
            destination_workspace_id="pinned-destination",
            operation="move",
            session_revision=1,
        )


def test_session_rename_migrates_global_pin_and_its_provenance(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=sequence(["explicit", "inherited"]),
    )
    store.create_workspace(
        name="Explicit",
        tabs=["old"],
        active_session="old",
    )
    store.create_workspace(
        name="Inherited",
        tabs=[],
        active_session=None,
    )
    store.set_session_workspace_pinned("old", True)

    assert store.rename_session("old", "new") == 2
    assert store.list_pinned_sessions() == ("new",)

    store.set_session_workspace_pinned("new", False)
    assert store.get_workspace("explicit")["tabs"] == ["new"]
    assert store.get_workspace("inherited")["tabs"] == []


def test_common_workspace_and_session_quick_links_are_atomic_and_independent(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=sequence([10, 20, 30]),
        id_factory=lambda: "workspace-id",
    )
    created = store.create_workspace(
        name="Project",
        tabs=["agent"],
        active_session="agent",
    )
    common = [
        {"id": "runbook", "label": " Runbook ", "url": "https://docs.test/runbook"}
    ]
    workspace = [
        {"id": "ticket", "label": "Launch ticket", "url": "https://issues.test/42"}
    ]
    session = [
        {"id": "trace", "label": " Agent trace ", "url": "https://trace.test/run"}
    ]

    assert store.replace_common_quick_links(common) == [
        {"id": "runbook", "label": "Runbook", "url": "https://docs.test/runbook"}
    ]
    assert store.get_workspace("workspace-id")["updatedAt"] == created["updatedAt"]
    assert store.replace_session_quick_links("agent", session) == [
        {"id": "trace", "label": "Agent trace", "url": "https://trace.test/run"}
    ]
    assert store.get_session_quick_links("other-agent") == []
    assert store.get_workspace("workspace-id")["updatedAt"] == created["updatedAt"]
    assert store.replace_workspace_quick_links("workspace-id", workspace) == workspace
    updated = store.get_workspace("workspace-id")
    assert updated["quickLinks"] == workspace
    assert updated["updatedAt"] == 20_000
    assert updated["lastActiveAt"] == created["lastActiveAt"]

    active = store.record_activity(
        "workspace-id",
        tabs=["agent"],
        active_session="agent",
        session_revision=0,
    )
    assert active["quickLinks"] == workspace
    reloaded = WorkspaceStore(path)
    assert reloaded.list_common_quick_links() == [
        {"id": "runbook", "label": "Runbook", "url": "https://docs.test/runbook"}
    ]
    assert reloaded.get_workspace_quick_links("workspace-id") == workspace
    assert reloaded.get_session_quick_links("agent") == [
        {"id": "trace", "label": "Agent trace", "url": "https://trace.test/run"}
    ]
    assert reloaded.replace_session_quick_links("agent", []) == []
    assert json.loads(path.read_text(encoding="utf-8"))["sessionQuickLinks"] == {}


def test_scoped_notes_are_independent_normalized_and_persistent(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, clock=lambda: 10, id_factory=lambda: "workspace-id")
    created = store.create_workspace(
        name="Project",
        tabs=["agent"],
        active_session="agent",
    )

    assert store.replace_common_note("Common\r\nchecklist") == "Common\nchecklist"
    assert store.replace_workspace_note("workspace-id", "Workspace plan") == (
        "Workspace plan"
    )
    assert store.replace_session_note("agent", "Session handoff") == (
        "Session handoff"
    )
    assert store.get_session_note("other-agent") == ""
    assert store.get_workspace("workspace-id")["updatedAt"] == created["updatedAt"]

    reloaded = WorkspaceStore(path)
    assert reloaded.get_common_note() == "Common\nchecklist"
    assert reloaded.get_workspace_note("workspace-id") == "Workspace plan"
    assert reloaded.get_session_note("agent") == "Session handoff"

    assert reloaded.replace_session_note("agent", " \n\t") == ""
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["sessionNotes"] == {}
    assert document["workspaceNotes"] == {"workspace-id": "Workspace plan"}

    reloaded.delete_workspace("workspace-id")
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["workspaceNotes"] == {}
    assert document["commonNote"] == "Common\nchecklist"


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (None, "note must be a string"),
        ("unsafe\x00note", "cannot contain control characters"),
    ],
)
def test_scoped_note_validation_rejects_invalid_values(value, message):
    with pytest.raises((TypeError, ValueError), match=message):
        normalize_scoped_note(value)


def test_scoped_note_validation_accepts_large_notes():
    note = "large note\n" * 20_000
    assert normalize_scoped_note(note) == note


def test_scoped_notebooks_migrate_legacy_notes_and_persist_pages(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    store.create_workspace(name="Project", tabs=["agent"], active_session="agent")
    store.replace_workspace_note("workspace-id", "Legacy first page")
    legacy_document = json.loads(path.read_text(encoding="utf-8"))
    legacy_document["version"] = 11
    legacy_document.pop("commonNotebook")
    legacy_document.pop("workspaceNotebooks")
    legacy_document.pop("sessionNotebooks")
    path.write_text(json.dumps(legacy_document), encoding="utf-8")

    migrated = WorkspaceStore(path)
    assert migrated.get_workspace_notebook("workspace-id") == {
        "pages": [
            {"id": "main", "name": "Page 1", "content": "Legacy first page"}
        ]
    }

    notebook = {
        "pages": [
            {"id": "main", "name": "Plan", "content": "First"},
            {"id": "next-steps", "name": "Next steps", "content": "Second"},
        ]
    }
    assert migrated.replace_workspace_notebook("workspace-id", notebook) == notebook
    reloaded = WorkspaceStore(path)
    assert reloaded.get_workspace_notebook("workspace-id") == notebook
    assert reloaded.get_workspace_note("workspace-id") == "First"
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["version"] == WORKSPACE_SCHEMA_VERSION
    assert document["workspaceNotebooks"]["workspace-id"] == notebook


@pytest.mark.parametrize(
    ("notebook", "message"),
    [
        ({}, "missing field: pages"),
        ({"pages": []}, "pages cannot be empty"),
        (
            {"pages": [
                {"id": "same", "name": "One", "content": ""},
                {"id": "same", "name": "Two", "content": ""},
            ]},
            "duplicate id",
        ),
        (
            {"pages": [
                {"id": f"p-{index}", "name": "Page", "content": ""}
                for index in range(MAX_SCOPED_NOTE_PAGES + 1)
            ]},
            "cannot contain more than",
        ),
    ],
)
def test_scoped_notebook_validation_rejects_invalid_values(notebook, message):
    with pytest.raises((TypeError, ValueError), match=message):
        validate_scoped_note_notebook(notebook)


@pytest.mark.parametrize(
    ("validator", "value", "message"),
    [
        (validate_workspace_notes, [], "workspaceNotes must be an object"),
        (validate_workspace_notes, {7: "note"}, "workspace ids must be strings"),
        (validate_workspace_notes, {"bad/id": "note"}, "workspace id can contain"),
        (validate_session_notes, [], "sessionNotes must be an object"),
        (validate_session_notes, {7: "note"}, "session names must be strings"),
        (
            validate_session_notes,
            {"bad\nname": "note"},
            "session name cannot contain control characters",
        ),
    ],
)
def test_scoped_note_map_validation_rejects_malformed_values(
    validator,
    value,
    message,
):
    with pytest.raises((TypeError, ValueError), match=message):
        validator(value)


@pytest.mark.parametrize(
    ("links", "message"),
    [
        ([{"id": "x", "label": "", "url": "https://example.test"}], "label cannot be blank"),
        ([{"id": "x", "label": "Docs", "url": "javascript:alert(1)"}], "valid HTTP or HTTPS URL"),
        ([{"id": "x", "label": "Docs", "url": "https://example.test/\x7f"}], "control characters"),
        ([{"id": "x", "label": "Docs", "url": "https://example.test:bad"}], "valid HTTP or HTTPS URL"),
        ([{"id": "x", "label": "Docs", "url": "https://user:secret@example.test"}], "cannot contain credentials"),
        ([{"id": "x", "label": "Docs", "url": "https://example.test", "extra": True}], "unknown field: extra"),
        (
            [
                {"id": "same", "label": "One", "url": "https://one.test"},
                {"id": "same", "label": "Two", "url": "https://two.test"},
            ],
            "duplicate id: same",
        ),
        (
            [
                {"id": f"link-{index}", "label": str(index), "url": f"https://example.test/{index}"}
                for index in range(MAX_WORKSPACE_QUICK_LINKS + 1)
            ],
            f"more than {MAX_WORKSPACE_QUICK_LINKS} links",
        ),
    ],
)
def test_workspace_quick_link_validation_rejects_unsafe_or_ambiguous_values(
    links,
    message,
):
    with pytest.raises((TypeError, ValueError), match=message):
        validate_workspace_quick_links(links)


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ([], "sessionQuickLinks must be an object"),
        ({7: []}, "session names must be strings"),
        ({"bad\nname": []}, "session name cannot contain control characters"),
        ({"agent": "not-an-array"}, r"sessionQuickLinks\['agent'\] must be an array"),
    ],
)
def test_session_quick_link_map_validation_rejects_malformed_values(value, message):
    with pytest.raises((TypeError, ValueError), match=message):
        validate_session_quick_links(value)


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


def test_workspace_groups_persist_and_sync_as_ordered_activity_state(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=sequence([10, 20, 30, 40, 50]),
        id_factory=lambda: "workspace-id",
    )
    created = store.create_workspace(
        name="Project",
        tabs=["api", "web", "notes", "ops"],
        groups=[
            workspace_group("build", ["api", "web"], name="  Build  "),
            workspace_group(
                "deploy",
                ["ops"],
                name="Deploy",
                color="orange",
                collapsed=True,
            ),
        ],
        active_session="web",
    )

    assert created["groups"] == [
        workspace_group("build", ["api", "web"], name="Build"),
        workspace_group(
            "deploy",
            ["ops"],
            name="Deploy",
            color="orange",
            collapsed=True,
        ),
    ]
    assert WorkspaceStore(path).get_workspace("workspace-id") == created

    collapsed = store.update_workspace(
        "workspace-id",
        groups=[
            workspace_group(
                "build",
                ["api", "web"],
                name="Build",
                collapsed=True,
            ),
            created["groups"][1],
        ],
        update_groups=True,
        session_revision=0,
    )
    assert collapsed["groups"][0]["collapsed"] is True
    assert collapsed["lastActiveAt"] == created["lastActiveAt"]

    reordered = store.record_activity(
        "workspace-id",
        tabs=["ops", "notes", "api", "web"],
        groups=[
            collapsed["groups"][1],
            collapsed["groups"][0],
        ],
        update_groups=True,
        active_session="ops",
        session_revision=0,
    )
    assert [group["id"] for group in reordered["groups"]] == ["deploy", "build"]
    assert reordered["lastActiveAt"] > collapsed["lastActiveAt"]

    legacy_client_update = store.record_activity(
        "workspace-id",
        tabs=["ops", "api", "web"],
        active_session="api",
        session_revision=0,
    )
    assert [group["id"] for group in legacy_client_update["groups"]] == [
        "deploy",
        "build",
    ]
    assert legacy_client_update["groups"][1]["tabs"] == ["api", "web"]

    invalidated_by_legacy_reorder = store.record_activity(
        "workspace-id",
        tabs=["ops", "api", "outside", "web"],
        active_session="outside",
        session_revision=0,
    )
    assert [group["id"] for group in invalidated_by_legacy_reorder["groups"]] == [
        "deploy"
    ]


@pytest.mark.parametrize(
    ("groups", "tabs", "message"),
    [
        (None, ["a"], "groups must be an array"),
        (["group"], ["a"], r"groups\[0\] must be an object"),
        (
            [{"id": "one"}],
            ["a"],
            r"groups\[0\] is missing field",
        ),
        (
            [{**workspace_group("one", ["a"]), "extra": True}],
            ["a"],
            r"groups\[0\] has unknown field: extra",
        ),
        (
            [workspace_group("bad/id", ["a"])],
            ["a"],
            "can contain only ASCII",
        ),
        (
            [workspace_group("x" * (MAX_WORKSPACE_GROUP_ID_LENGTH + 1), ["a"])],
            ["a"],
            f"must be {MAX_WORKSPACE_GROUP_ID_LENGTH} characters or fewer",
        ),
        (
            [workspace_group("one", ["a"], name="x" * (MAX_WORKSPACE_GROUP_NAME_LENGTH + 1))],
            ["a"],
            f"must be {MAX_WORKSPACE_GROUP_NAME_LENGTH} characters or fewer",
        ),
        (
            [workspace_group("one", ["a"], name="  ")],
            ["a"],
            "name cannot be blank",
        ),
        (
            [workspace_group("one", ["a"], color="chartreuse")],
            ["a"],
            "color must be one of",
        ),
        (
            [workspace_group("one", ["a"], collapsed=1)],
            ["a"],
            "collapsed must be a boolean",
        ),
        (
            [workspace_group("one", [])],
            ["a"],
            "tabs cannot be empty",
        ),
        (
            [workspace_group("one", ["a", "a"])],
            ["a"],
            "contains duplicate session",
        ),
        (
            [workspace_group("one", ["missing"])],
            ["a"],
            "outside workspace tabs",
        ),
        (
            [workspace_group("one", ["a", "c"])],
            ["a", "b", "c"],
            "must be contiguous",
        ),
        (
            [workspace_group("one", ["b", "a"])],
            ["a", "b"],
            "must be contiguous",
        ),
        (
            [
                workspace_group("one", ["a"]),
                workspace_group("two", ["a"]),
            ],
            ["a"],
            "more than one group",
        ),
        (
            [
                workspace_group("same", ["a"]),
                workspace_group("same", ["b"]),
            ],
            ["a", "b"],
            "groups contains duplicate id: same",
        ),
        (
            [
                workspace_group("two", ["b"]),
                workspace_group("one", ["a"]),
            ],
            ["a", "b"],
            "groups must follow workspace tab order",
        ),
        (
            [workspace_group(f"group-{index}", [f"s-{index}"]) for index in range(MAX_WORKSPACE_GROUPS + 1)],
            [f"s-{index}" for index in range(MAX_WORKSPACE_GROUPS + 1)],
            f"cannot contain more than {MAX_WORKSPACE_GROUPS} groups",
        ),
    ],
)
def test_workspace_group_validation_rejects_invalid_state(
    tmp_path,
    groups,
    tabs,
    message,
):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")

    with pytest.raises((TypeError, ValueError), match=message):
        store.create_workspace(
            name="Project",
            tabs=tabs,
            groups=groups,
            active_session=None,
        )

    assert store.list_workspaces() == []
    assert not path.exists()


def test_workspace_session_rename_updates_every_reference_without_activity(tmp_path):
    path = tmp_path / "workspaces.json"
    ids = sequence(["one", "two", "unaffected"])
    store = WorkspaceStore(path, clock=lambda: 10, id_factory=ids)
    first = store.create_workspace(
        name="First",
        tabs=["old", "keep", "new"],
        groups=[workspace_group("primary", ["old", "keep"])],
        active_session="old",
    )
    second = store.create_workspace(
        name="Second",
        tabs=["old"],
        groups=[workspace_group("solo", ["old"], color="cyan")],
        active_session=None,
    )
    untouched = store.create_workspace(
        name="Untouched",
        tabs=["keep"],
        groups=[workspace_group("keep", ["keep"], color="green")],
        active_session="keep",
    )
    source_links = [
        {"id": "trace", "label": "Source trace", "url": "https://trace.test/source"}
    ]
    store.replace_session_quick_links("old", source_links)
    store.replace_session_quick_links(
        "new",
        [{"id": "stale", "label": "Stale", "url": "https://trace.test/stale"}],
    )
    store.replace_session_note("old", "Source handoff")
    store.replace_session_note("new", "Stale handoff")

    assert store.rename_session("old", "new") == 2
    renamed_first = store.get_workspace("one")
    renamed_second = store.get_workspace("two")
    assert renamed_first["tabs"] == ["new", "keep"]
    assert renamed_first["activeSession"] == "new"
    assert renamed_second["tabs"] == ["new"]
    assert renamed_first["groups"] == [workspace_group("primary", ["new", "keep"])]
    assert renamed_second["groups"] == [workspace_group("solo", ["new"], color="cyan")]
    assert renamed_first["lastActiveAt"] == first["lastActiveAt"]
    assert renamed_second["lastActiveAt"] == second["lastActiveAt"]
    assert renamed_first["updatedAt"] > first["updatedAt"]
    assert renamed_first["sessionRevision"] == 1
    assert renamed_second["sessionRevision"] == 1
    unaffected = store.get_workspace("unaffected")
    assert {**unaffected, "sessionRevision": 0} == untouched
    assert unaffected["sessionRevision"] == 1
    assert store.get_session_quick_links("old") == []
    assert store.get_session_quick_links("new") == source_links
    assert store.get_session_note("old") == ""
    assert store.get_session_note("new") == "Source handoff"
    assert WorkspaceStore(path).get_workspace("one") == renamed_first
    assert WorkspaceStore(path).get_session_quick_links("new") == source_links
    assert WorkspaceStore(path).get_session_note("new") == "Source handoff"

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


def test_workspace_session_rename_source_group_wins_inverse_collision(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, clock=lambda: 10, id_factory=lambda: "workspace-id")
    store.create_workspace(
        name="Collision",
        tabs=["new", "middle", "old", "friend"],
        groups=[
            workspace_group("stale", ["new"], color="gray"),
            workspace_group(
                "source", ["old", "friend"], color="green", collapsed=True
            ),
        ],
        active_session="old",
    )

    assert store.rename_session("old", "new") == 1
    renamed = store.get_workspace("workspace-id")
    assert renamed["tabs"] == ["middle", "new", "friend"]
    assert renamed["activeSession"] == "new"
    assert renamed["groups"] == [
        workspace_group(
            "source", ["new", "friend"], color="green", collapsed=True
        )
    ]


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

    def fail_persist(
        _workspaces,
        _session_rename_revision,
        _common_quick_links,
        _session_quick_links,
        _notes,
        _pinned_sessions,
    ):
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

    def fail_persist(
        _workspaces,
        _session_rename_revision,
        _common_quick_links,
        _session_quick_links,
        _notes,
        _pinned_sessions,
    ):
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

    def fail_directory_sync(
        _workspaces,
        _session_rename_revision,
        _common_quick_links,
        _session_quick_links,
        _notes,
        _pinned_sessions,
    ):
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
                "commonQuickLinks": [],
                "sessionQuickLinks": {},
                "commonNote": "",
                "workspaceNotes": {},
                "sessionNotes": {},
                "pinnedSessions": [],
                "workspaces": [
                    {
                        "id": "workspace-id",
                        "name": "Project",
                        "tabs": ["old"],
                        "groups": [],
                        "quickLinks": [],
                        "inheritedPins": [],
                        "separators": [],
                        "separatorsBefore": [],
                        "paneLayouts": [],
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


def test_malformed_session_quick_link_state_fails_closed(tmp_path):
    path = tmp_path / "workspaces.json"
    original = json.dumps(
        {
            "version": WORKSPACE_SCHEMA_VERSION,
            "sessionRenameRevision": 0,
            "commonQuickLinks": [],
            "sessionQuickLinks": [],
            "commonNote": "",
            "workspaceNotes": {},
            "sessionNotes": {},
            "pinnedSessions": [],
            "workspaces": [],
        }
    ).encode()
    path.write_bytes(original)
    store = WorkspaceStore(path)

    with pytest.raises(
        WorkspaceStoreUnavailable,
        match=WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    ):
        store.get_session_quick_links("agent")
    with pytest.raises(WorkspaceStoreUnavailable):
        store.replace_session_quick_links("agent", [])
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
