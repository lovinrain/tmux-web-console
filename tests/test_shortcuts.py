from __future__ import annotations

import copy
import json
import stat

import pytest

from tmux_console.shortcuts import (
    DEFAULT_SHORTCUT_BINDINGS,
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
    updated["command-palette"]["direct"] = "KeyK"
    updated["terminal-copy-mode"]["direct"] = "KeyH"
    saved = store.replace_bindings(updated, expected_revision=0)

    assert saved == {"revision": 1, "bindings": updated}
    assert ShortcutStore(path).get_snapshot() == saved
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "version": 1,
        **saved,
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(tmp_path.glob(".shortcuts.json.*.tmp")) == []


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
