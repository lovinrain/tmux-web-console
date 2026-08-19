import json

import pytest

from tmux_console.metadata import (
    SESSION_TAGS,
    SessionMetadataUnavailable,
    SessionTitleStore,
    normalize_tags,
    normalize_title,
)


def test_session_titles_persist_and_can_be_cleared(tmp_path):
    path = tmp_path / "titles.json"
    store = SessionTitleStore(path)

    assert store.set_title("cx20", "  Build Muxdeck  ") == "Build Muxdeck"
    assert SessionTitleStore(path).get_title("cx20") == "Build Muxdeck"
    assert store.set_title("cx20", "  ") is None
    assert SessionTitleStore(path).get_title("cx20") is None

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "ignored": [],
        "starred": [],
        "tags": {},
        "titles": {},
        "version": 4,
    }


def test_session_stars_persist_and_old_title_files_remain_compatible(tmp_path):
    path = tmp_path / "titles.json"
    path.write_text(
        json.dumps({"version": 1, "titles": {"cx20": "Muxdeck"}}),
        encoding="utf-8",
    )
    store = SessionTitleStore(path)

    assert store.get_title("cx20") == "Muxdeck"
    assert store.is_starred("cx20") is False
    assert store.set_starred("cx20", True) is True
    assert store.set_starred("cx20", True) is True
    assert SessionTitleStore(path).is_starred("cx20") is True
    assert SessionTitleStore(path).is_ignored("cx20") is False
    assert store.set_title("cx20", "Updated") == "Updated"
    assert SessionTitleStore(path).is_starred("cx20") is True
    assert store.set_starred("cx20", False) is False
    assert SessionTitleStore(path).is_starred("cx20") is False


def test_session_ignored_status_persists_and_preserves_existing_metadata(tmp_path):
    path = tmp_path / "titles.json"
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "titles": {"ignored-session": "Example worker"},
                "starred": ["ignored-session"],
            }
        ),
        encoding="utf-8",
    )
    store = SessionTitleStore(path)

    assert store.is_ignored("ignored-session") is False
    assert store.set_ignored("ignored-session", True) is True

    reloaded = SessionTitleStore(path)
    assert reloaded.is_ignored("ignored-session") is True
    assert reloaded.get_title("ignored-session") == "Example worker"
    assert reloaded.is_starred("ignored-session") is False

    assert (
        reloaded.set_title("ignored-session", "Updated worker")
        == "Updated worker"
    )
    assert SessionTitleStore(path).is_ignored("ignored-session") is True
    assert reloaded.set_starred("ignored-session", True) is True
    assert SessionTitleStore(path).is_starred("ignored-session") is True
    assert SessionTitleStore(path).is_ignored("ignored-session") is False
    assert reloaded.set_ignored("ignored-session", True) is True
    assert SessionTitleStore(path).is_starred("ignored-session") is False
    assert SessionTitleStore(path).is_ignored("ignored-session") is True
    assert reloaded.set_starred("ignored-session", False) is False
    assert SessionTitleStore(path).is_ignored("ignored-session") is True
    assert reloaded.set_ignored("ignored-session", False) is False
    assert SessionTitleStore(path).is_ignored("ignored-session") is False

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "ignored": [],
        "starred": [],
        "tags": {},
        "titles": {"ignored-session": "Updated worker"},
        "version": 4,
    }


def test_starred_wins_if_stored_attention_states_overlap(tmp_path):
    path = tmp_path / "titles.json"
    path.write_text(
        json.dumps(
            {
                "version": 3,
                "titles": {},
                "starred": ["both", "starred-only"],
                "ignored": ["both", "ignored-only"],
            }
        ),
        encoding="utf-8",
    )
    store = SessionTitleStore(path)

    assert store.is_ignored("both") is False
    assert store.is_starred("both") is True
    assert store.is_starred("starred-only") is True
    assert store.is_ignored("ignored-only") is True

    store.set_title("both", "Normalized")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["starred"] == ["both", "starred-only"]
    assert payload["ignored"] == ["ignored-only"]


def test_session_title_validation_rejects_long_or_control_text():
    with pytest.raises(ValueError, match="80 characters"):
        normalize_title("x" * 81)
    with pytest.raises(ValueError, match="control"):
        normalize_title("line one\nline two")


def test_session_tags_are_predefined_canonical_and_persistent(tmp_path):
    path = tmp_path / "titles.json"
    path.write_text(
        json.dumps(
            {
                "version": 3,
                "titles": {"agent": "Existing title"},
                "starred": ["agent"],
                "ignored": [],
            }
        ),
        encoding="utf-8",
    )
    store = SessionTitleStore(path)

    assert store.get_tags("agent") == []
    assert store.set_tags(
        "agent", ["background", "work", "urgent", "work"]
    ) == ["work", "urgent", "background"]

    reloaded = SessionTitleStore(path)
    assert reloaded.get_tags("agent") == ["work", "urgent", "background"]
    assert reloaded.get_title("agent") == "Existing title"
    assert reloaded.is_starred("agent") is True
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "ignored": [],
        "starred": ["agent"],
        "tags": {"agent": ["work", "urgent", "background"]},
        "titles": {"agent": "Existing title"},
        "version": 4,
    }

    assert reloaded.set_tags("agent", []) == []
    assert SessionTitleStore(path).get_tags("agent") == []


def test_session_tag_validation_rejects_non_arrays_non_strings_and_unknown_tags():
    assert tuple(normalize_tags(list(reversed(SESSION_TAGS)))) == SESSION_TAGS
    with pytest.raises(TypeError, match="array"):
        normalize_tags("work")
    with pytest.raises(TypeError, match="only strings"):
        normalize_tags(["work", 1])
    with pytest.raises(ValueError, match="unknown session tag: invented"):
        normalize_tags(["invented"])


def test_invalid_stored_session_tags_are_read_only_without_losing_valid_tags(tmp_path):
    path = tmp_path / "titles.json"
    path.write_text(
        json.dumps(
            {
                "version": 4,
                "titles": {},
                "starred": [],
                "ignored": [],
                "tags": {
                    "agent": ["work", "invented", 3, "review", "work"],
                    "wrong-shape": "urgent",
                    "": ["urgent"],
                },
            }
        ),
        encoding="utf-8",
    )

    original = path.read_bytes()
    store = SessionTitleStore(path)

    assert store.get_tags("agent") == ["work", "review"]
    assert store.get_tags("wrong-shape") == []
    assert store.get_tags("") == []
    with pytest.raises(SessionMetadataUnavailable, match="metadata is unavailable"):
        store.set_tags("agent", ["urgent"])
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("titles", []),
        ("titles", {"agent": 3}),
        ("titles", {"": "Invalid session"}),
        ("titles", {"agent": "   "}),
        ("starred", {}),
        ("starred", ["agent", 3]),
        ("ignored", "agent"),
        ("ignored", [""]),
        ("tags", []),
        ("tags", {"agent": "work"}),
    ],
)
def test_structurally_invalid_metadata_is_never_overwritten(
    tmp_path, field, invalid_value
):
    path = tmp_path / "titles.json"
    payload = {
        "version": 4,
        "titles": {"agent": "Existing"},
        "starred": ["agent"],
        "ignored": [],
        "tags": {"agent": ["work"]},
    }
    payload[field] = invalid_value
    path.write_text(json.dumps(payload), encoding="utf-8")
    original = path.read_bytes()

    store = SessionTitleStore(path)

    with pytest.raises(SessionMetadataUnavailable, match="metadata is unavailable"):
        store.set_title("other", "New title")
    assert path.read_bytes() == original


def test_unsupported_metadata_version_is_never_overwritten(tmp_path):
    path = tmp_path / "titles.json"
    original = b'{"version":99,"titles":{"agent":"Future"},"futureField":true}\n'
    path.write_bytes(original)
    store = SessionTitleStore(path)

    assert store.get_title("agent") is None
    with pytest.raises(SessionMetadataUnavailable, match="metadata is unavailable"):
        store.set_tags("agent", ["work"])
    assert path.read_bytes() == original


def test_session_metadata_moves_to_renamed_native_session(tmp_path):
    path = tmp_path / "titles.json"
    store = SessionTitleStore(path)
    store.set_title("starred-old", "Starred work")
    store.set_starred("starred-old", True)
    store.set_title("ignored-old", "Background work")
    store.set_ignored("ignored-old", True)
    store.set_tags("starred-old", ["work", "urgent"])
    store.set_tags("ignored-old", ["background"])

    # Stale destination records belong to a previous tmux session and are replaced.
    store.set_title("starred-new", "Stale title")
    store.set_ignored("starred-new", True)
    store.set_title("ignored-new", "Other stale title")
    store.set_starred("ignored-new", True)
    store.set_tags("starred-new", ["blocked"])
    store.set_tags("ignored-new", ["review"])

    store.rename_session("starred-old", "starred-new")
    store.rename_session("ignored-old", "ignored-new")

    reloaded = SessionTitleStore(path)
    assert reloaded.get_title("starred-old") is None
    assert reloaded.is_starred("starred-old") is False
    assert reloaded.get_title("starred-new") == "Starred work"
    assert reloaded.is_starred("starred-new") is True
    assert reloaded.is_ignored("starred-new") is False
    assert reloaded.get_tags("starred-old") == []
    assert reloaded.get_tags("starred-new") == ["work", "urgent"]
    assert reloaded.get_title("ignored-old") is None
    assert reloaded.is_ignored("ignored-old") is False
    assert reloaded.get_title("ignored-new") == "Background work"
    assert reloaded.is_ignored("ignored-new") is True
    assert reloaded.is_starred("ignored-new") is False
    assert reloaded.get_tags("ignored-old") == []
    assert reloaded.get_tags("ignored-new") == ["background"]


def test_failed_session_metadata_rename_keeps_in_memory_state(tmp_path, monkeypatch):
    store = SessionTitleStore(tmp_path / "titles.json")
    store.set_title("old", "Current title")
    store.set_starred("old", True)
    store.set_tags("old", ["work", "review"])
    store.set_title("new", "Stale title")
    store.set_tags("new", ["blocked"])

    def fail_persist(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)

    with pytest.raises(OSError, match="disk full"):
        store.rename_session("old", "new")

    assert store.get_title("old") == "Current title"
    assert store.is_starred("old") is True
    assert store.get_tags("old") == ["work", "review"]
    assert store.get_title("new") == "Stale title"
    assert store.get_tags("new") == ["blocked"]


def test_failed_session_tag_write_keeps_in_memory_state(tmp_path, monkeypatch):
    store = SessionTitleStore(tmp_path / "titles.json")
    store.set_tags("agent", ["work"])

    def fail_persist(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)

    with pytest.raises(OSError, match="disk full"):
        store.set_tags("agent", ["urgent"])

    assert store.get_tags("agent") == ["work"]


def test_session_details_persist_atomically(tmp_path, monkeypatch):
    store = SessionTitleStore(tmp_path / "titles.json")
    store.set_details("agent", "Original", ["work"])

    def fail_persist(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)

    with pytest.raises(OSError, match="disk full"):
        store.set_details("agent", "Changed", ["urgent"])

    assert store.get_title("agent") == "Original"
    assert store.get_tags("agent") == ["work"]
