from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from tmux_console import callback_messages as callbacks
from tmux_console.callback_messages import (
    CallbackMessageConflict,
    CallbackMessageStore,
    CallbackMessageStoreUnavailable,
    default_callback_messages_path,
)


def payload(**overrides):
    return {
        "message": "Completed the task.\nAll checks passed.",
        "sessionName": "251",
        "agentType": "codex",
        "cwd": "/root/project",
        "requestId": "task-one",
        **overrides,
    }


def test_store_retains_report_and_review_state_after_reopening(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    store = CallbackMessageStore(path, clock=lambda: 100)
    record, duplicate = store.add(payload())
    assert duplicate is False
    assert record["createdAt"] == 100
    assert record["reviewedAt"] is None
    assert path.stat().st_mode & 0o777 == 0o600
    store.close()

    store = CallbackMessageStore(path, clock=lambda: 200)
    assert store.pending_snapshot() == {
        "callbackMessages": [record],
        "callbackMessageRevision": 1,
    }
    reviewed = store.review(record["id"])
    assert reviewed == {**record, "reviewedAt": 200}
    assert store.review(record["id"]) == reviewed
    assert store.pending_snapshot() == {
        "callbackMessages": [],
        "callbackMessageRevision": 2,
    }
    store.close()

    store = CallbackMessageStore(path)
    assert store.list_messages(status="reviewed")["messages"] == [reviewed]
    assert store.add(payload()) == (reviewed, True)
    assert store.list_messages(status="all")["revision"] == 2
    store.close()


def test_capacity_rejects_without_discarding_and_review_frees_a_slot(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(callbacks, "MAX_PENDING_CALLBACK_MESSAGES", 2)
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    first, _ = store.add(payload())
    second, _ = store.add(payload(requestId="task-two"))
    with pytest.raises(
        CallbackMessageConflict, match="pending callback messages are full"
    ):
        store.add(payload(requestId="task-three"))
    assert store.add(payload()) == (first, True)
    with pytest.raises(CallbackMessageConflict, match="different callback content"):
        store.add(payload(message="Different result"))
    assert store.list_messages()["messages"] == [first, second]
    assert store.list_messages()["revision"] == 2
    store.review(first["id"])
    third, duplicate = store.add(payload(requestId="task-three"))
    assert duplicate is False
    assert store.list_messages()["messages"] == [second, third]
    assert len(store.list_messages(status="all")["messages"]) == 3
    store.close()


def test_concurrent_stores_serialize_idempotency_and_capacity(tmp_path, monkeypatch):
    monkeypatch.setattr(callbacks, "MAX_PENDING_CALLBACK_MESSAGES", 1)
    path = tmp_path / "callbacks.sqlite3"
    stores = [CallbackMessageStore(path), CallbackMessageStore(path)]
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda store: store.add(payload()), stores))
        assert sorted(duplicate for _, duplicate in results) == [False, True]
        assert results[0][0] == results[1][0]
        with pytest.raises(CallbackMessageConflict):
            stores[1].add(payload(requestId="another"))
        assert stores[0].list_messages()["revision"] == 1
    finally:
        for store in stores:
            store.close()


def test_session_review_archives_only_matching_pending_and_keeps_original_metadata(
    tmp_path,
):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3", clock=lambda: 123)
    first, _ = store.add(payload())
    second, _ = store.add(
        payload(requestId="second", tmuxSessionId="$12", tmuxPaneId="%4", host="local")
    )
    other, _ = store.add(payload(requestId="other", sessionName="252"))
    assert store.review_sessions(["251", "251", "absent"]) == ["251"]
    assert store.review_sessions(["251"]) == []
    assert store.list_messages()["messages"] == [other]
    assert store.list_messages()["revision"] == 4
    assert store.list_messages(status="reviewed")["messages"] == [
        {**first, "reviewedAt": 123},
        {**second, "reviewedAt": 123},
    ]
    store.close()


@pytest.mark.parametrize(
    "changes",
    [
        {"message": "x" * 16_385},
        {"message": "embedded\x00nul"},
        {"message": "\ud800"},
        {"sessionName": "bad\nname"},
        {"agentType": "x" * 65},
        {"cwd": "relative/project"},
        {"cwd": "/a\npath"},
        {"requestId": " "},
        {"host": "x" * 256},
        {"tmuxSessionId": "12"},
        {"tmuxPaneId": "$1"},
        {"unexpected": "field"},
    ],
)
def test_invalid_metadata_is_rejected_before_any_write(tmp_path, changes):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    with pytest.raises((TypeError, ValueError)):
        store.add(payload(**changes))
    assert store.list_messages() == {"messages": [], "nextAfter": None, "revision": 0}
    store.close()


def test_corrupt_database_fails_closed_without_overwriting(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    original = b"This is not a SQLite database."
    path.write_bytes(original)
    with pytest.raises(CallbackMessageStoreUnavailable):
        CallbackMessageStore(path)
    assert path.read_bytes() == original


def test_default_path_supports_explicit_env_workspace_and_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("MUXDECK_CALLBACKS_FILE", str(tmp_path / "explicit.sqlite3"))
    assert (
        default_callback_messages_path(Path("/tmp/workspaces.json"))
        == tmp_path / "explicit.sqlite3"
    )
    monkeypatch.delenv("MUXDECK_CALLBACKS_FILE")
    assert (
        default_callback_messages_path(tmp_path / "workspaces.json")
        == tmp_path / "callbacks.sqlite3"
    )
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    assert (
        default_callback_messages_path() == tmp_path / "state/muxdeck/callbacks.sqlite3"
    )
