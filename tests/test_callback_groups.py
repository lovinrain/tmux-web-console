import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from tmux_console import callback_groups
from tmux_console.callback_groups import CallbackGroupConflict, CallbackGroupNotFound
from tmux_console.callback_messages import CallbackMessageStore


def save(store, name="Release", sessions=None, **overrides):
    return store.save_group(**{
        "workspace_id": None, "name": name, "sessions": sessions or [],
        "expected_revision": store.groups_snapshot()["callbackGroupRevision"],
        **overrides,
    })


def test_groups_move_members_atomically_and_survive_reopening(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    store = CallbackMessageStore(path)
    release = save(store, sessions=["a", "b", "b"])
    other = save(store, "Other", ["b", "c"])
    workspace = save(store, "Release", ["a", "b"], workspace_id="workspace-one")
    expected = {
        "callbackGroups": [
            {"id": release, "name": "Release", "workspaceId": None, "sessions": ["a"]},
            {"id": other, "name": "Other", "workspaceId": None, "sessions": ["b", "c"]},
            {"id": workspace, "name": "Release", "workspaceId": "workspace-one", "sessions": ["a", "b"]},
        ], "callbackGroupRevision": 3,
    }
    assert store.groups_snapshot() == expected
    save(store, "Shipping", ["c", "a"], group_id=release)
    assert store.groups_snapshot()["callbackGroups"][:2] == [
        {**expected["callbackGroups"][0], "name": "Shipping", "sessions": ["c", "a"]},
        {**expected["callbackGroups"][1], "sessions": ["b"]},
    ]
    snapshot = store.groups_snapshot()
    save(store, "Shipping", ["c", "a"], group_id=release)
    assert store.groups_snapshot() == snapshot  # An identical save is a no-op.
    store.close()
    store = CallbackMessageStore(path)
    assert store.groups_snapshot() == snapshot
    store.delete_group(release, workspace_id=None, expected_revision=4)
    assert [group["id"] for group in store.groups_snapshot()["callbackGroups"]] == [other, workspace]
    store.close()


def test_stale_simultaneous_group_edits_have_one_winner(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    first = CallbackMessageStore(path)
    group_id = save(first, sessions=["original"])
    second = CallbackMessageStore(path)

    def edit(store):
        try:
            save(store, sessions=["changed"], group_id=group_id, expected_revision=1)
            return True
        except CallbackGroupConflict:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(edit, (first, second))) == [False, True]
    assert first.groups_snapshot()["callbackGroupRevision"] == 2
    assert second.groups_snapshot() == first.groups_snapshot()
    first.close()
    second.close()


@pytest.mark.parametrize("changes", [
    {"name": " "}, {"name": "x" * 41}, {"name": "Ungrouped"}, {"name": "bad\nname"},
    {"name": "\ud800"}, {"name": 4}, {"sessions": "a"}, {"sessions": [None]},
    {"sessions": ["bad\nname"]}, {"sessions": ["\ud800"]}, {"sessions": ["x" * 257]},
    {"sessions": ["a"] * 1025}, {"expected_revision": True}, {"expected_revision": -1},
    {"expected_revision": 2**53}, {"workspace_id": []},
])
def test_invalid_group_edits_never_change_membership(tmp_path, changes):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    group_id = save(store, sessions=["original"])
    before = store.groups_snapshot()
    with pytest.raises((TypeError, ValueError)):
        save(store, group_id=group_id, **changes)
    assert store.groups_snapshot() == before
    store.close()


def test_group_conflicts_and_wrong_scope_preserve_both_groups(tmp_path, monkeypatch):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    first = save(store, "One", ["a"])
    second = save(store, "Two", ["b"])
    before = store.groups_snapshot()
    with pytest.raises(CallbackGroupConflict):
        save(store, " ONE ", ["a"], group_id=second)
    with pytest.raises(CallbackGroupNotFound):
        save(store, "Moved", ["b"], group_id=first, workspace_id="other")
    with pytest.raises(CallbackGroupConflict):
        store.delete_group(first, workspace_id=None, expected_revision=1)
    with pytest.raises(CallbackGroupNotFound):
        store.delete_group(first, workspace_id="other", expected_revision=2)
    monkeypatch.setattr(callback_groups, "MAX_CALLBACK_GROUPS_PER_SCOPE", 2)
    with pytest.raises(CallbackGroupConflict):
        save(store, "Third", ["a"])
    assert store.groups_snapshot() == before
    store.close()


def test_workspace_deletion_and_session_rename_preserve_other_scopes(tmp_path):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    first = save(store, sessions=["old", "keep"])
    save(store, "Existing name", ["new"])
    save(store, sessions=["old"], workspace_id="one")
    other = save(store, sessions=["other"], workspace_id="two")
    store.rename_group_session("old", "new")
    groups = store.groups_snapshot()["callbackGroups"]
    assert groups[0]["id"] == first
    assert groups[0]["sessions"] == ["new", "keep"]
    assert groups[1]["sessions"] == []
    assert groups[2]["sessions"] == ["new"]
    store.delete_workspace_groups("one")
    assert store.groups_snapshot()["callbackGroups"] == [groups[0], groups[1], groups[3]]
    assert groups[3]["id"] == other
    snapshot = store.groups_snapshot()
    store.delete_workspace_groups("absent")
    store.rename_group_session("absent", "new")
    assert store.groups_snapshot() == snapshot
    store.close()


def test_schema_one_upgrade_preserves_reports_and_review_history(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    store = CallbackMessageStore(path)
    report, _ = store.add({"message": "Done", "agentType": "codex", "sessionName": "a", "cwd": "/tmp"})
    store.review(report["id"])
    history = store.list_messages(status="all")
    store.close()
    with sqlite3.connect(path) as connection:
        for table in ("callback_group_members", "callback_groups", "callback_group_metadata"):
            connection.execute(f"DROP TABLE {table}")
        connection.execute("PRAGMA user_version = 1")
    store = CallbackMessageStore(path)
    assert store.list_messages(status="all") == history
    assert store.groups_snapshot() == {"callbackGroups": [], "callbackGroupRevision": 0}
    save(store, sessions=["a"])
    store.close()
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
