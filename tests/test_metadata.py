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
    assert payload == {"starred": [], "titles": {}, "version": 2}


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
    assert store.set_title("cx20", "Updated") == "Updated"
    assert SessionTitleStore(path).is_starred("cx20") is True
    assert store.set_starred("cx20", False) is False
    assert SessionTitleStore(path).is_starred("cx20") is False


def test_session_title_validation_rejects_long_or_control_text():
    with pytest.raises(ValueError, match="80 characters"):
        normalize_title("x" * 81)
    with pytest.raises(ValueError, match="control"):
        normalize_title("line one\nline two")
