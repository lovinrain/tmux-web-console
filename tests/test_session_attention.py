from __future__ import annotations

import sqlite3
from dataclasses import replace

import pytest

from tmux_console.session_attention import SessionAttention
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import Session


def session(**overrides) -> Session:
    return Session(**{
        "name": "alpha", "id": "$1", "windows": 1, "attached": 0,
        "created": 100, "server_started": 90, "server_pid": 42, **overrides,
    })


@pytest.mark.parametrize("busy", ["working", "running_command"])
@pytest.mark.parametrize("transient", ["unknown", "waiting_command", "working", "running_command"])
def test_work_episode_survives_transient_signals_and_emits_one_ready_event(busy, transient):
    attention = SessionAttention().observe(busy).observe(transient).observe("waiting_human")
    assert attention.to_dict() == {"latestReadyEvent": 1, "lastCheckedEvent": 0}
    assert attention.observe("waiting_human") == attention
    checked = attention.update("read", 1)
    assert checked.observe(busy).observe("waiting_human").to_dict() == {
        "latestReadyEvent": 2, "lastCheckedEvent": 1,
    }


@pytest.mark.parametrize("initial", ["waiting_human", "unknown", "waiting_command", "other"])
def test_initial_idle_session_does_not_invent_a_completion(initial):
    assert SessionAttention().observe(initial).observe("waiting_human").latest_ready_event == 0


def test_shell_exit_disarms_work_without_erasing_an_existing_unread_marker():
    attention = SessionAttention().update("unread", 0).observe("working")
    shell = attention.observe("other").observe("waiting_human")
    assert shell.to_dict() == {"latestReadyEvent": 1, "lastCheckedEvent": 0}
    assert shell.awaiting_ready is False


@pytest.mark.parametrize("state", ["working", "running_command", "waiting_human", "waiting_command", "unknown", "other"])
def test_manual_unread_is_idempotent_and_keeps_work_episode(state):
    before = SessionAttention().observe(state)
    marked = before.update("unread", 0)
    assert marked.latest_ready_event == 1
    assert marked.state == before.state
    assert marked.awaiting_ready == before.awaiting_ready
    assert marked.update("unread", 0) == marked
    read = marked.update("read", 1)
    assert read.last_checked_event == 1
    assert read.update("unread", 1).latest_ready_event == 2


def test_stale_read_never_acknowledges_a_newer_completion_or_manual_mark():
    first = SessionAttention().observe("working").observe("waiting_human")
    second = first.observe("working").observe("waiting_human")
    assert second.update("read", first.latest_ready_event).to_dict() == {
        "latestReadyEvent": 2, "lastCheckedEvent": 1,
    }
    checked = second.update("read", 2)
    assert checked.update("read", 1) == checked
    assert checked.update("unread", 2).update("read", 2).last_checked_event == 2
    with pytest.raises(ValueError):
        checked.update("read", 3)


def test_shared_attention_survives_registry_restart_and_native_rename(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    original = session()
    registry = SessionRegistry(path)
    registry.observe_ready_attention([original], {"alpha": "working"})
    registry.close()

    registry = SessionRegistry(path)
    assert registry.observe_ready_attention([original], {"alpha": "waiting_human"})["alpha"] == {
        "latestReadyEvent": 1, "lastCheckedEvent": 0,
    }
    registry.update_ready_attention(original, "read", 1)
    registry.close()

    registry = SessionRegistry(path)
    try:
        renamed = replace(original, name="renamed")
        assert registry.observe_ready_attention([renamed], {"renamed": "waiting_human"})["renamed"] == {
            "latestReadyEvent": 1, "lastCheckedEvent": 1,
        }
        total_changes = registry._require_connection().total_changes
        registry.observe_ready_attention([renamed], {"renamed": "waiting_human"})
        assert registry._require_connection().total_changes == total_changes
    finally:
        registry.close()


@pytest.mark.parametrize("field,value", [
    ("id", "$2"), ("created", 101), ("server_started", 91), ("server_pid", 43),
])
def test_recreated_session_does_not_inherit_read_or_unread_markers(tmp_path, field, value):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3")
    try:
        original = session()
        registry.update_ready_attention(original, "unread", 0)
        replacement = replace(original, **{field: value})
        assert registry.observe_ready_attention([replacement], {"alpha": "waiting_human"})["alpha"] == {
            "latestReadyEvent": 0, "lastCheckedEvent": 0,
        }
    finally:
        registry.close()


def test_version_four_upgrade_keeps_session_history_and_adds_attention_atomically(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    registry = SessionRegistry(path)
    history_id = registry.observe_history(session())
    registry.close()
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE session_attention")
        connection.execute("PRAGMA user_version=4")
    registry = SessionRegistry(path)
    try:
        assert registry.get_history(history_id)["name"] == "alpha"
        assert registry._require_connection().execute("PRAGMA user_version").fetchone()[0] == 5
        assert registry.update_ready_attention(session(), "unread", 0)["latestReadyEvent"] == 1
    finally:
        registry.close()
