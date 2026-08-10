from __future__ import annotations

import json

import pytest

from tmux_console.messages import (
    MAX_MESSAGE_LENGTH,
    MAX_SESSION_NAME_LENGTH,
    MessageNotFoundError,
    SessionMessageStore,
    validate_message_text,
    validate_session_name,
)


def sequence(values):
    iterator = iter(values)
    return lambda: next(iterator)


def test_message_queue_crud_order_and_persistence(tmp_path):
    path = tmp_path / "messages.json"
    store = SessionMessageStore(
        path,
        clock=sequence([10, 11, 12]),
        id_factory=sequence(["first-id", "second-id"]),
    )

    first = store.add_message("cx20", "  first prompt\n")
    second = store.add_message("cx20", "second prompt")

    assert first == {
        "id": "first-id",
        "text": "  first prompt\n",
        "createdAt": 10_000,
        "updatedAt": 10_000,
        "position": 0,
    }
    assert second["position"] == 1
    assert [item["id"] for item in store.list_messages("cx20")] == [
        "first-id",
        "second-id",
    ]

    edited = store.update_message(
        "cx20", "first-id", text="edited\nmessage", position=1
    )
    assert edited == {
        "id": "first-id",
        "text": "edited\nmessage",
        "createdAt": 10_000,
        "updatedAt": 12_000,
        "position": 1,
    }
    assert store.list_messages("cx20") == [
        {
            "id": "second-id",
            "text": "second prompt",
            "createdAt": 11_000,
            "updatedAt": 11_000,
            "position": 0,
        },
        edited,
    ]

    store.delete_message("cx20", "second-id")
    assert SessionMessageStore(path).list_messages("cx20") == [
        {**edited, "position": 0}
    ]

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "version": 1,
        "sessions": {"cx20": [{**edited, "position": 0}]},
    }
    assert list(tmp_path.glob(".messages.json.*.tmp")) == []


def test_message_queues_do_not_leak_between_sessions(tmp_path):
    ids = sequence(["alpha-id", "beta-id"])
    store = SessionMessageStore(tmp_path / "messages.json", id_factory=ids)
    alpha = store.add_message("alpha", "alpha only")
    beta = store.add_message("beta", "beta only")

    assert store.count_messages("alpha") == 1
    assert store.count_messages("beta") == 1
    assert store.list_messages("alpha") == [alpha]
    assert store.list_messages("beta") == [beta]
    with pytest.raises(MessageNotFoundError, match="alpha-id"):
        store.update_message("beta", "alpha-id", text="leaked")
    with pytest.raises(MessageNotFoundError, match="beta-id"):
        store.delete_message("alpha", "beta-id")
    assert store.list_messages("alpha")[0]["text"] == "alpha only"
    assert store.list_messages("beta")[0]["text"] == "beta only"


def test_message_validation_preserves_text_and_enforces_limits():
    formatted = "  keep leading whitespace\n\tand trailing whitespace  "
    assert validate_message_text(formatted) == formatted
    assert validate_message_text("x" * MAX_MESSAGE_LENGTH) == (
        "x" * MAX_MESSAGE_LENGTH
    )

    for blank in ("", "  ", "\n\t"):
        with pytest.raises(ValueError, match="cannot be blank"):
            validate_message_text(blank)
    with pytest.raises(ValueError, match="65536 characters"):
        validate_message_text("x" * (MAX_MESSAGE_LENGTH + 1))

    assert validate_session_name("agent one") == "agent one"
    for invalid in ("", "  ", "agent\nname", "x" * (MAX_SESSION_NAME_LENGTH + 1)):
        with pytest.raises(ValueError):
            validate_session_name(invalid)


def test_failed_persistence_does_not_change_in_memory_queue(tmp_path, monkeypatch):
    store = SessionMessageStore(
        tmp_path / "messages.json", id_factory=lambda: "message-id"
    )

    def fail_persist(_queues):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)
    with pytest.raises(OSError, match="disk full"):
        store.add_message("cx20", "do not retain")

    assert store.list_messages("cx20") == []


def test_invalid_persisted_records_are_ignored_and_positions_are_normalized(tmp_path):
    path = tmp_path / "messages.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "sessions": {
                    "cx20": [
                        {
                            "id": "later",
                            "text": "later",
                            "createdAt": 2,
                            "updatedAt": 2,
                            "position": 9,
                        },
                        {"id": "broken", "text": "missing timestamps"},
                        {
                            "id": "earlier",
                            "text": "earlier",
                            "createdAt": 1,
                            "updatedAt": 1,
                            "position": 2,
                        },
                    ],
                    "\n": [],
                },
            }
        ),
        encoding="utf-8",
    )

    messages = SessionMessageStore(path).list_messages("cx20")

    assert [item["id"] for item in messages] == ["earlier", "later"]
    assert [item["position"] for item in messages] == [0, 1]
