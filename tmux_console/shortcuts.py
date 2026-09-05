from __future__ import annotations

import contextlib
import copy
import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("muxdeck.shortcuts")
MAX_SHORTCUT_REVISION = (1 << 53) - 1
SHORTCUT_DOCUMENT_VERSION = 3
PREVIOUS_SHORTCUT_DOCUMENT_VERSION = 2
LEGACY_SHORTCUT_DOCUMENT_VERSION = 1
QUICK_SESSION_ACTION = "workspace-quick-new-session"
FLOATING_INPUT_ACTION = "view-floating-input"
SHORTCUT_STORE_UNAVAILABLE_MESSAGE = (
    "shortcut storage is unavailable; inspect and repair the configured shortcuts "
    "file, then restart Muxdeck"
)

SUPPORTED_SHORTCUT_CODES = frozenset(
    [f"Key{letter}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
    + [f"Digit{digit}" for digit in "0123456789"]
    + [
        "Backquote",
        "Backslash",
        "BracketLeft",
        "BracketRight",
        "Comma",
        "Equal",
        "Minus",
        "Period",
        "Quote",
        "Semicolon",
        "Slash",
    ]
)


def _binding(direct: str | None, launcher: str | None) -> dict[str, str | None]:
    return {"direct": direct, "launcher": launcher}


DEFAULT_SHORTCUT_BINDINGS: dict[str, dict[str, str | None]] = {
    "command-palette": _binding("KeyH", "KeyH"),
    "shortcut-launcher": _binding("KeyZ", None),
    "workspace-new-session": _binding("KeyB", "KeyB"),
    QUICK_SESSION_ACTION: _binding("KeyK", "KeyK"),
    "session-copy-new": _binding("KeyM", "KeyM"),
    "workspace-find-tab": _binding("Semicolon", "Semicolon"),
    "terminal-return-live": _binding("KeyL", "KeyL"),
    "terminal-page-up": _binding("KeyU", "KeyU"),
    "terminal-page-down": _binding("KeyD", "KeyD"),
    "session-rename": _binding("KeyR", "KeyR"),
    "session-end": _binding("KeyE", "KeyE"),
    "terminal-copy-mode": _binding("KeyC", "KeyC"),
    "view-tab-actions": _binding("KeyA", "KeyA"),
    "view-session-tabs": _binding("KeyS", "KeyS"),
    "view-terminal-focus": _binding("KeyF", "KeyF"),
    FLOATING_INPUT_ACTION: _binding("KeyY", "KeyY"),
    "view-theme": _binding(None, "KeyT"),
    "workspace-previous-tab": _binding("Comma", "Comma"),
    "workspace-next-tab": _binding("Period", "Period"),
    **{
        f"workspace-tab-{position}": _binding(
            f"Digit{position}", f"Digit{position}"
        )
        for position in range(1, 10)
    },
}

DIRECT_DISABLED_ACTIONS = frozenset({"view-theme"})
LAUNCHER_DISABLED_ACTIONS = frozenset({"shortcut-launcher"})


def default_shortcuts_path() -> Path:
    configured = os.environ.get("MUXDECK_SHORTCUTS_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "shortcuts.json"


def _validate_revision(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("revision must be an integer")
    if value < 0:
        raise ValueError("revision cannot be negative")
    if value > MAX_SHORTCUT_REVISION:
        raise ValueError(f"revision cannot exceed {MAX_SHORTCUT_REVISION}")
    return value


@dataclass(frozen=True)
class ShortcutBinding:
    direct: str | None
    launcher: str | None

    def to_dict(self) -> dict[str, str | None]:
        return {"direct": self.direct, "launcher": self.launcher}


def _validate_code(value: object, path: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{path} must be a string or null")
    if value not in SUPPORTED_SHORTCUT_CODES:
        raise ValueError(f"{path} is not a supported shortcut key")
    return value


def validate_bindings(value: object) -> dict[str, ShortcutBinding]:
    if not isinstance(value, dict):
        raise ValueError("bindings must be an object")

    expected_actions = set(DEFAULT_SHORTCUT_BINDINGS)
    actual_actions = set(value)
    missing = sorted(expected_actions - actual_actions)
    if missing:
        raise ValueError(f"bindings is missing action: {missing[0]}")
    unknown = sorted(str(action) for action in actual_actions - expected_actions)
    if unknown:
        raise ValueError(f"unknown shortcut action: {unknown[0]}")

    bindings: dict[str, ShortcutBinding] = {}
    direct_owners: dict[str, str] = {}
    launcher_owners: dict[str, str] = {}
    for action in DEFAULT_SHORTCUT_BINDINGS:
        raw_binding = value[action]
        if not isinstance(raw_binding, dict):
            raise ValueError(f"bindings.{action} must be an object")
        missing_fields = sorted({"direct", "launcher"} - set(raw_binding))
        if missing_fields:
            raise ValueError(
                f"bindings.{action} is missing field: {missing_fields[0]}"
            )
        unknown_fields = sorted(
            str(field) for field in set(raw_binding) - {"direct", "launcher"}
        )
        if unknown_fields:
            raise ValueError(
                f"bindings.{action} has unknown field: {unknown_fields[0]}"
            )

        direct = _validate_code(raw_binding["direct"], f"bindings.{action}.direct")
        launcher = _validate_code(
            raw_binding["launcher"], f"bindings.{action}.launcher"
        )
        if action in DIRECT_DISABLED_ACTIONS and direct is not None:
            raise ValueError(f"bindings.{action}.direct must be null")
        if action in LAUNCHER_DISABLED_ACTIONS and launcher is not None:
            raise ValueError(f"bindings.{action}.launcher must be null")

        if direct is not None:
            previous_action = direct_owners.get(direct)
            if previous_action is not None:
                raise ValueError(
                    f"direct key {direct} is assigned to both "
                    f"{previous_action} and {action}"
                )
            direct_owners[direct] = action
        if launcher is not None:
            previous_action = launcher_owners.get(launcher)
            if previous_action is not None:
                raise ValueError(
                    f"launcher key {launcher} is assigned to both "
                    f"{previous_action} and {action}"
                )
            launcher_owners[launcher] = action

        bindings[action] = ShortcutBinding(direct=direct, launcher=launcher)
    return bindings


def _validate_stored_bindings(
    version: int, value: object
) -> dict[str, ShortcutBinding]:
    if version == SHORTCUT_DOCUMENT_VERSION:
        return validate_bindings(value)
    if version not in {
        LEGACY_SHORTCUT_DOCUMENT_VERSION,
        PREVIOUS_SHORTCUT_DOCUMENT_VERSION,
    }:
        raise ValueError("unsupported document version")
    if not isinstance(value, dict):
        return validate_bindings(value)

    current_actions = set(DEFAULT_SHORTCUT_BINDINGS)
    version_two_actions = current_actions - {FLOATING_INPUT_ACTION}
    version_one_actions = version_two_actions - {QUICK_SESSION_ACTION}
    if set(value) == set(DEFAULT_SHORTCUT_BINDINGS):
        return validate_bindings(value)
    if version == PREVIOUS_SHORTCUT_DOCUMENT_VERSION:
        if set(value) != version_two_actions:
            return validate_bindings(value)
    elif frozenset(value) not in {
        frozenset(version_one_actions),
        frozenset(version_two_actions),
    }:
        return validate_bindings(value)

    upgraded = copy.deepcopy(value)

    def add_available_binding(action: str, code: str) -> None:
        used_direct = {
            binding.get("direct")
            for binding in upgraded.values()
            if isinstance(binding, dict)
        }
        used_launcher = {
            binding.get("launcher")
            for binding in upgraded.values()
            if isinstance(binding, dict)
        }
        upgraded[action] = _binding(
            code if code not in used_direct else None,
            code if code not in used_launcher else None,
        )

    if QUICK_SESSION_ACTION not in upgraded:
        add_available_binding(QUICK_SESSION_ACTION, "KeyK")
    add_available_binding(FLOATING_INPUT_ACTION, "KeyY")
    return validate_bindings(upgraded)


class ShortcutRevisionConflict(LookupError):
    def __init__(self, expected_revision: int, current_revision: int) -> None:
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            "shortcut settings changed; "
            f"expected revision {expected_revision}, current revision is {current_revision}"
        )


class ShortcutStoreUnavailable(RuntimeError):
    pass


class _ShortcutDirectorySyncError(OSError):
    pass


class ShortcutStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_shortcuts_path()
        self._lock = threading.RLock()
        self._load_error: str | None = None
        self._revision, self._bindings = self._load()

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._ensure_available()
            return self._serialize(self._revision, self._bindings)

    def replace_bindings(
        self, bindings: object, *, expected_revision: int
    ) -> dict[str, Any]:
        expected_revision = _validate_revision(expected_revision)
        validated = validate_bindings(bindings)
        with self._lock:
            self._ensure_available()
            if expected_revision != self._revision:
                raise ShortcutRevisionConflict(expected_revision, self._revision)
            if self._revision == MAX_SHORTCUT_REVISION:
                raise ValueError("revision has reached the maximum safe value")
            next_revision = self._revision + 1
            try:
                self._persist(next_revision, validated)
            except _ShortcutDirectorySyncError:
                self._bindings = validated
                self._revision = next_revision
                raise
            self._bindings = validated
            self._revision = next_revision
            return self._serialize(self._revision, self._bindings)

    def _load(self) -> tuple[int, dict[str, ShortcutBinding]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("document must be an object")
            version = payload.get("version")
            if not isinstance(version, int) or isinstance(version, bool):
                raise ValueError("unsupported document version")
            revision = _validate_revision(payload.get("revision"))
            bindings = _validate_stored_bindings(version, payload.get("bindings"))
        except FileNotFoundError as error:
            if not self.path.is_symlink():
                return 0, validate_bindings(DEFAULT_SHORTCUT_BINDINGS)
            self._record_load_error(error)
            return 0, validate_bindings(DEFAULT_SHORTCUT_BINDINGS)
        except (OSError, ValueError, RecursionError) as error:
            self._record_load_error(error)
            return 0, validate_bindings(DEFAULT_SHORTCUT_BINDINGS)
        return revision, bindings

    def _record_load_error(self, error: BaseException) -> None:
        self._load_error = f"{type(error).__name__}: {error}"
        LOGGER.error(
            "Shortcut storage is unavailable because %s could not be loaded: %s. "
            "Refusing reads and writes until Muxdeck restarts with a valid file.",
            self.path,
            error,
        )

    def _ensure_available(self) -> None:
        if self._load_error is not None:
            raise ShortcutStoreUnavailable(SHORTCUT_STORE_UNAVAILABLE_MESSAGE)

    @staticmethod
    def _serialize(
        revision: int, bindings: dict[str, ShortcutBinding]
    ) -> dict[str, Any]:
        return {
            "revision": revision,
            "bindings": {
                action: binding.to_dict() for action, binding in bindings.items()
            },
        }

    def _persist(self, revision: int, bindings: dict[str, ShortcutBinding]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary: Path | None = None
        directory_fd: int | None = None
        try:
            directory_fd = os.open(
                self.path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                os.chmod(temporary, 0o600)
                json.dump(
                    {
                        "version": SHORTCUT_DOCUMENT_VERSION,
                        **self._serialize(revision, bindings),
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                os.fsync(directory_fd)
            except OSError as error:
                raise _ShortcutDirectorySyncError(
                    f"unable to sync shortcut state directory: {error}"
                ) from error
        finally:
            if directory_fd is not None:
                with contextlib.suppress(OSError):
                    os.close(directory_fd)
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
