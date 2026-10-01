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
        "onHoldSessions": [],
        "latestCallbackAtBySession": {"251": 100},
        "callbackMessageRevision": 1,
    }
    reviewed = store.review(record["id"])
    assert reviewed == {**record, "reviewedAt": 200}
    assert store.review(record["id"]) == reviewed
    assert store.pending_snapshot() == {
        "callbackMessages": [],
        "onHoldSessions": [],
        "latestCallbackAtBySession": {},
        "callbackMessageRevision": 2,
    }
    store.close()

    store = CallbackMessageStore(path)
    assert store.list_messages(status="reviewed")["messages"] == [reviewed]
    assert store.add(payload()) == (reviewed, True)
    assert store.list_messages(status="all")["revision"] == 2
    store.close()


def test_latest_callback_time_includes_reviewed_history_for_watched_sessions(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    now = 100
    store = CallbackMessageStore(path, clock=lambda: now)
    first, _ = store.add(payload())
    now = 200
    second, _ = store.add(payload(requestId="second"))
    other, _ = store.add(payload(requestId="other", sessionName="other"))
    store.review(other["id"])
    assert store.pending_snapshot()["latestCallbackAtBySession"] == {"251": 200}

    now = 300
    store.review(second["id"])
    snapshot = store.pending_snapshot()
    assert snapshot["callbackMessages"] == [first]
    assert snapshot["latestCallbackAtBySession"] == {"251": 200}
    store.review(first["id"])
    assert store.pending_snapshot()["latestCallbackAtBySession"] == {}
    assert store.pending_snapshot(["251", "never-posted"])["latestCallbackAtBySession"] == {
        "251": 200,
    }
    store.close()

    store = CallbackMessageStore(path, clock=lambda: 400)
    assert store.pending_snapshot(["251"])["latestCallbackAtBySession"] == {"251": 200}
    # Re-delivery does not change the recorded callback time or reopen the entry.
    store.add(payload(requestId="second"))
    assert store.pending_snapshot(["251"])["latestCallbackAtBySession"] == {"251": 200}
    assert store.pending_snapshot(["renamed-session"])["latestCallbackAtBySession"] == {}
    store.close()


def test_holds_are_durable_reversible_and_do_not_review_messages(tmp_path):
    path = tmp_path / "callbacks.sqlite3"
    store = CallbackMessageStore(path)
    message, _ = store.add(payload())
    store.set_session_hold("251", True)
    store.set_session_hold("manual", True)
    held = store.pending_snapshot()
    assert held["onHoldSessions"] == ["251", "manual"]
    assert held["callbackMessages"] == [message]
    store.set_session_hold("251", True)
    assert store.pending_snapshot() == held
    store.close()

    store = CallbackMessageStore(path)
    assert store.pending_snapshot() == held
    store.set_session_hold("251", False)
    restored = store.pending_snapshot()
    assert restored["onHoldSessions"] == ["manual"]
    assert restored["callbackMessages"] == [message]
    assert restored["callbackMessageRevision"] > held["callbackMessageRevision"]
    store.set_session_hold("251", False)
    assert store.pending_snapshot() == restored
    store.close()


def test_hold_cleanup_waits_for_last_queue_source_and_rename_preserves_hold(tmp_path):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    message, _ = store.add(payload())
    for name in ("251", "watched", "removed", "temporary"):
        store.set_session_hold(name, True)
    store.clear_unqueued_holds(["251", "watched", "removed"], ["watched"])
    assert store.pending_snapshot()["onHoldSessions"] == ["251", "temporary", "watched"]
    store.review(message["id"])
    store.clear_unqueued_holds(["251", "watched"], [])
    assert store.pending_snapshot()["onHoldSessions"] == ["temporary"]
    store.rename_session("temporary", "renamed")
    assert store.pending_snapshot()["onHoldSessions"] == ["renamed"]
    store.set_session_hold("existing", True)
    store.rename_session("renamed", "existing")
    assert store.pending_snapshot()["onHoldSessions"] == ["existing"]
    store.close()


@pytest.mark.parametrize("name,on_hold", [("", True), ("bad\nname", True), (None, True), ("251", "true"), ("251", 1)])
def test_invalid_hold_is_rejected_without_writing(tmp_path, name, on_hold):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3")
    with pytest.raises((TypeError, ValueError)):
        store.set_session_hold(name, on_hold)
    assert store.pending_snapshot()["onHoldSessions"] == []
    assert store.pending_snapshot()["callbackMessageRevision"] == 0
    store.close()

def test_latest_callback_time_supports_large_combined_workspace_queues(tmp_path):
    store = CallbackMessageStore(tmp_path / "callbacks.sqlite3", clock=lambda: 100)
    watched_sessions = [f"session-{index}" for index in range(1_100)]
    record, _ = store.add(payload(sessionName=watched_sessions[-1]))
    store.review(record["id"])
    assert store.pending_snapshot(watched_sessions)["latestCallbackAtBySession"] == {
        watched_sessions[-1]: 100,
    }
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
