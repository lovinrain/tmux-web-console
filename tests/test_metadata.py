import json

import pytest

from tmux_console.metadata import SessionTitleStore, normalize_title


def test_session_titles_persist_and_can_be_cleared(tmp_path):
    path = tmp_path / "titles.json"
    store = SessionTitleStore(path)

    assert store.set_title("cx20", "  Build Muxdeck  ") == "Build Muxdeck"
    assert SessionTitleStore(path).get_title("cx20") == "Build Muxdeck"
    assert store.set_title("cx20", "  ") is None
    assert SessionTitleStore(path).get_title("cx20") is None

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {"ignored": [], "starred": [], "titles": {}, "version": 3}


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

    assert reloaded.set_title("ignored-session", "Updated worker") == "Updated worker"
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
        "titles": {"ignored-session": "Updated worker"},
        "version": 3,
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


def test_session_metadata_moves_to_renamed_native_session(tmp_path):
    path = tmp_path / "titles.json"
    store = SessionTitleStore(path)
    store.set_title("starred-old", "Starred work")
    store.set_starred("starred-old", True)
    store.set_title("ignored-old", "Background work")
    store.set_ignored("ignored-old", True)

    # Stale destination records belong to a previous tmux session and are replaced.
    store.set_title("starred-new", "Stale title")
    store.set_ignored("starred-new", True)
    store.set_title("ignored-new", "Other stale title")
    store.set_starred("ignored-new", True)

    store.rename_session("starred-old", "starred-new")
    store.rename_session("ignored-old", "ignored-new")

    reloaded = SessionTitleStore(path)
    assert reloaded.get_title("starred-old") is None
    assert reloaded.is_starred("starred-old") is False
    assert reloaded.get_title("starred-new") == "Starred work"
    assert reloaded.is_starred("starred-new") is True
    assert reloaded.is_ignored("starred-new") is False
    assert reloaded.get_title("ignored-old") is None
    assert reloaded.is_ignored("ignored-old") is False
    assert reloaded.get_title("ignored-new") == "Background work"
    assert reloaded.is_ignored("ignored-new") is True
    assert reloaded.is_starred("ignored-new") is False


def test_failed_session_metadata_rename_keeps_in_memory_state(tmp_path, monkeypatch):
    store = SessionTitleStore(tmp_path / "titles.json")
    store.set_title("old", "Current title")
    store.set_starred("old", True)
    store.set_title("new", "Stale title")

    def fail_persist(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)

    with pytest.raises(OSError, match="disk full"):
        store.rename_session("old", "new")

    assert store.get_title("old") == "Current title"
    assert store.is_starred("old") is True
    assert store.get_title("new") == "Stale title"
