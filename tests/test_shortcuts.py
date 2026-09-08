from __future__ import annotations

import copy
import json
import stat

import pytest

from tmux_console.shortcuts import (
    DEFAULT_SHORTCUT_BINDINGS,
    FLOATING_INPUT_ACTION,
    FLOATING_TERMINAL_ACTION,
    PANE_NAVIGATION_ACTION,
    PREVIOUS_SHORTCUT_DOCUMENT_VERSION,
    QUICK_SESSION_ACTION,
    SHORTCUT_DOCUMENT_VERSION,
    SHORTCUT_STORE_UNAVAILABLE_MESSAGE,
    ShortcutRevisionConflict,
    ShortcutStore,
    ShortcutStoreUnavailable,
    default_shortcuts_path,
    validate_bindings,
)


def bindings() -> dict[str, dict[str, str | None]]:
    return copy.deepcopy(DEFAULT_SHORTCUT_BINDINGS)


def test_shortcut_store_uses_defaults_then_persists_a_revision(tmp_path):
    path = tmp_path / "shortcuts.json"
    store = ShortcutStore(path)

    assert store.get_snapshot() == {"revision": 0, "bindings": bindings()}
    updated = bindings()
    updated["command-palette"]["direct"] = "KeyV"
    updated["terminal-copy-mode"]["direct"] = "KeyH"
    saved = store.replace_bindings(updated, expected_revision=0)

    assert saved == {"revision": 1, "bindings": updated}
    assert ShortcutStore(path).get_snapshot() == saved
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "version": SHORTCUT_DOCUMENT_VERSION,
        **saved,
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(tmp_path.glob(".shortcuts.json.*.tmp")) == []


def test_shortcut_store_upgrades_version_one_with_new_action_bindings(tmp_path):
    path = tmp_path / "shortcuts.json"
    legacy = bindings()
    legacy.pop(QUICK_SESSION_ACTION)
    legacy.pop(FLOATING_INPUT_ACTION)
    legacy.pop(FLOATING_TERMINAL_ACTION)
    legacy.pop(PANE_NAVIGATION_ACTION)
    legacy["command-palette"]["direct"] = "KeyG"
    path.write_text(
        json.dumps({"version": 1, "revision": 7, "bindings": legacy}),
        encoding="utf-8",
    )

    store = ShortcutStore(path)
    snapshot = store.get_snapshot()

    assert snapshot["revision"] == 7
    assert snapshot["bindings"]["command-palette"]["direct"] == "KeyG"
    assert snapshot["bindings"][QUICK_SESSION_ACTION] == {
        "direct": "KeyK",
        "launcher": "KeyK",
    }
    assert snapshot["bindings"][FLOATING_INPUT_ACTION] == {
        "direct": "KeyY",
        "launcher": "KeyY",
    }
    assert snapshot["bindings"][PANE_NAVIGATION_ACTION] == {
        "direct": None,
        "launcher": "KeyG",
    }
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 1

    saved = store.replace_bindings(snapshot["bindings"], expected_revision=7)
    assert saved["revision"] == 8
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == (
        SHORTCUT_DOCUMENT_VERSION
    )


def test_shortcut_store_does_not_override_legacy_default_key_conflicts(tmp_path):
    path = tmp_path / "shortcuts.json"
    legacy = bindings()
    legacy.pop(QUICK_SESSION_ACTION)
    legacy.pop(FLOATING_INPUT_ACTION)
    legacy.pop(FLOATING_TERMINAL_ACTION)
    legacy.pop(PANE_NAVIGATION_ACTION)
    legacy["command-palette"]["direct"] = "KeyK"
    legacy["terminal-copy-mode"]["direct"] = "KeyH"
    legacy["command-palette"]["launcher"] = "KeyK"
    legacy["terminal-copy-mode"]["launcher"] = "KeyH"
    legacy["view-session-tabs"]["direct"] = "KeyY"
    legacy["view-session-tabs"]["launcher"] = "KeyY"
    path.write_text(
        json.dumps({"version": 1, "revision": 2, "bindings": legacy}),
        encoding="utf-8",
    )

    snapshot = ShortcutStore(path).get_snapshot()

    assert snapshot["bindings"][QUICK_SESSION_ACTION] == {
        "direct": None,
        "launcher": None,
    }
    assert snapshot["bindings"][FLOATING_INPUT_ACTION] == {
        "direct": None,
        "launcher": None,
    }


def test_shortcut_store_upgrades_version_two_without_overriding_key_y(tmp_path):
    path = tmp_path / "shortcuts.json"
    previous = bindings()
    previous.pop(FLOATING_INPUT_ACTION)
    previous.pop(FLOATING_TERMINAL_ACTION)
    previous.pop(PANE_NAVIGATION_ACTION)
    previous["command-palette"]["direct"] = "KeyY"
    path.write_text(
        json.dumps({
            "version": PREVIOUS_SHORTCUT_DOCUMENT_VERSION,
            "revision": 4,
            "bindings": previous,
        }),
        encoding="utf-8",
    )

    store = ShortcutStore(path)
    snapshot = store.get_snapshot()

    assert snapshot["revision"] == 4
    assert snapshot["bindings"]["command-palette"]["direct"] == "KeyY"
    assert snapshot["bindings"][FLOATING_INPUT_ACTION] == {
        "direct": None,
        "launcher": "KeyY",
    }
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 2

    store.replace_bindings(snapshot["bindings"], expected_revision=4)
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == SHORTCUT_DOCUMENT_VERSION


def test_version_three_adds_terminal_without_overwriting_custom_bindings(tmp_path):
    path = tmp_path / "shortcuts.json"
    previous = bindings()
    previous.pop(FLOATING_TERMINAL_ACTION)
    previous.pop(PANE_NAVIGATION_ACTION)
    previous["command-palette"]["direct"] = "KeyJ"
    path.write_text(json.dumps({"version": 3, "revision": 9, "bindings": previous}))
    snapshot = ShortcutStore(path).get_snapshot()
    assert snapshot["revision"] == 9
    assert snapshot["bindings"][FLOATING_TERMINAL_ACTION] == {"direct": None, "launcher": "KeyJ"}
    assert snapshot["bindings"][FLOATING_INPUT_ACTION] == previous[FLOATING_INPUT_ACTION]


def test_version_four_adds_pane_navigation_without_overwriting_key_g(tmp_path):
    path = tmp_path / "shortcuts.json"
    previous = bindings()
    previous.pop(PANE_NAVIGATION_ACTION)
    previous["command-palette"]["direct"] = "KeyG"
    path.write_text(json.dumps({"version": 4, "revision": 11, "bindings": previous}))

    snapshot = ShortcutStore(path).get_snapshot()

    assert snapshot["revision"] == 11
    assert snapshot["bindings"][PANE_NAVIGATION_ACTION] == {
        "direct": None,
        "launcher": "KeyG",
    }


def test_shortcut_store_rejects_stale_and_conflicting_bindings(tmp_path):
    store = ShortcutStore(tmp_path / "shortcuts.json")
    current = store.replace_bindings(bindings(), expected_revision=0)

    with pytest.raises(ShortcutRevisionConflict) as caught:
        store.replace_bindings(bindings(), expected_revision=0)
    assert caught.value.current_revision == 1
    assert store.get_snapshot() == current

    duplicate = bindings()
    duplicate["session-end"]["direct"] = duplicate["session-rename"]["direct"]
    with pytest.raises(ValueError, match="direct key KeyR is assigned to both"):
        validate_bindings(duplicate)

    duplicate = bindings()
    duplicate["session-end"]["launcher"] = duplicate["session-rename"]["launcher"]
    with pytest.raises(ValueError, match="launcher key KeyR is assigned to both"):
        validate_bindings(duplicate)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda value: value.pop("session-end"),
            "bindings is missing action: session-end",
        ),
        (
            lambda value: value.__setitem__("unknown", {"direct": None, "launcher": None}),
            "unknown shortcut action: unknown",
        ),
        (
            lambda value: value["session-end"].__setitem__("direct", "Escape"),
            "bindings.session-end.direct is not a supported shortcut key",
        ),
        (
            lambda value: value["view-theme"].__setitem__("direct", "KeyT"),
            "bindings.view-theme.direct must be null",
        ),
        (
            lambda value: value["shortcut-launcher"].__setitem__("launcher", "KeyQ"),
            "bindings.shortcut-launcher.launcher must be null",
        ),
    ],
)
def test_shortcut_binding_validation_is_strict(mutate, message):
    value = bindings()
    mutate(value)
    with pytest.raises(ValueError, match=message):
        validate_bindings(value)


def test_invalid_existing_shortcut_file_fails_closed(tmp_path):
    path = tmp_path / "shortcuts.json"
    original = b"not JSON"
    path.write_bytes(original)
    store = ShortcutStore(path)

    with pytest.raises(ShortcutStoreUnavailable) as caught:
        store.get_snapshot()
    assert str(caught.value) == SHORTCUT_STORE_UNAVAILABLE_MESSAGE
    with pytest.raises(ShortcutStoreUnavailable):
        store.replace_bindings(bindings(), expected_revision=0)
    assert path.read_bytes() == original


def test_default_shortcut_path_honors_environment(tmp_path, monkeypatch):
    configured = tmp_path / "custom.json"
    monkeypatch.setenv("MUXDECK_SHORTCUTS_FILE", str(configured))
    assert default_shortcuts_path() == configured
