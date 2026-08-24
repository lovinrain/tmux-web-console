from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .messages import validate_session_name

LOGGER = logging.getLogger("muxdeck.workspaces")
MAX_WORKSPACE_ID_LENGTH = 128
MAX_WORKSPACE_NAME_LENGTH = 80
MAX_WORKSPACE_TABS = 32
MAX_WORKSPACE_GROUPS = 16
MAX_WORKSPACE_GROUP_ID_LENGTH = 64
MAX_WORKSPACE_GROUP_NAME_LENGTH = 40
MAX_WORKSPACE_QUICK_LINKS = 16
MAX_WORKSPACE_QUICK_LINK_ID_LENGTH = 64
MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH = 48
MAX_WORKSPACE_QUICK_LINK_URL_LENGTH = 2048
MAX_SCOPED_NOTE_LENGTH = 8_000
WORKSPACE_GROUP_COLORS = (
    "gray",
    "blue",
    "cyan",
    "green",
    "yellow",
    "orange",
    "red",
    "pink",
    "purple",
)
WORKSPACE_GROUP_COLOR_SET = frozenset(WORKSPACE_GROUP_COLORS)
_GROUPS_OMITTED = object()
_QUICK_LINKS_OMITTED = object()
MAX_SESSION_RENAME_REVISION = (1 << 53) - 1
WORKSPACE_SCHEMA_VERSION = 6
WORKSPACE_STORE_UNAVAILABLE_MESSAGE = (
    "workspace storage is unavailable; inspect and repair the configured workspaces "
    "file, then restart Muxdeck"
)


def default_workspaces_path() -> Path:
    configured = os.environ.get("MUXDECK_WORKSPACES_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "workspaces.json"


def _validate_unicode(value: str, field: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must contain valid Unicode") from error


def normalize_workspace_name(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("name must be a string")
    name = value.strip()
    if not name:
        raise ValueError("name cannot be blank")
    if len(name) > MAX_WORKSPACE_NAME_LENGTH:
        raise ValueError(
            f"name must be {MAX_WORKSPACE_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError("name cannot contain control characters")
    _validate_unicode(name, "name")
    return name


def validate_workspace_tabs(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise TypeError("tabs must be an array")
    if len(value) > MAX_WORKSPACE_TABS:
        raise ValueError(f"tabs cannot contain more than {MAX_WORKSPACE_TABS} sessions")

    tabs: list[str] = []
    seen: set[str] = set()
    for index, candidate in enumerate(value):
        if not isinstance(candidate, str):
            raise TypeError(f"tabs[{index}] must be a string")
        try:
            tab = validate_session_name(candidate)
            _validate_unicode(tab, f"tabs[{index}]")
        except ValueError as error:
            raise ValueError(f"tabs[{index}]: {error}") from error
        if tab in seen:
            raise ValueError(f"tabs contains duplicate session: {tab}")
        seen.add(tab)
        tabs.append(tab)
    return tuple(tabs)


def _validate_workspace_group_id(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} cannot be blank")
    if len(value) > MAX_WORKSPACE_GROUP_ID_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_WORKSPACE_GROUP_ID_LENGTH} characters or fewer"
        )
    if not all(
        character.isascii() and (character.isalnum() or character in "_-")
        for character in value
    ):
        raise ValueError(
            f"{field} can contain only ASCII letters, numbers, hyphens, and underscores"
        )
    return value


def _normalize_workspace_group_name(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    name = value.strip()
    if not name:
        raise ValueError(f"{field} cannot be blank")
    if len(name) > MAX_WORKSPACE_GROUP_NAME_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_WORKSPACE_GROUP_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(name, field)
    return name


def _validate_workspace_group_tabs(
    value: object,
    field: str,
) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if not value:
        raise ValueError(f"{field} cannot be empty")
    if len(value) > MAX_WORKSPACE_TABS:
        raise ValueError(
            f"{field} cannot contain more than {MAX_WORKSPACE_TABS} sessions"
        )

    tabs: list[str] = []
    seen: set[str] = set()
    for index, candidate in enumerate(value):
        item_field = f"{field}[{index}]"
        if not isinstance(candidate, str):
            raise TypeError(f"{item_field} must be a string")
        try:
            tab = validate_session_name(candidate)
            _validate_unicode(tab, item_field)
        except ValueError as error:
            raise ValueError(f"{item_field}: {error}") from error
        if tab in seen:
            raise ValueError(f"{field} contains duplicate session: {tab}")
        seen.add(tab)
        tabs.append(tab)
    return tuple(tabs)


def validate_active_session(value: object, tabs: tuple[str, ...]) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("activeSession must be a string or null")
    try:
        active_session = validate_session_name(value)
        _validate_unicode(active_session, "activeSession")
    except ValueError as error:
        raise ValueError(f"activeSession: {error}") from error
    if active_session not in tabs:
        raise ValueError("activeSession must be one of the workspace tabs")
    return active_session


def _validate_workspace_id(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("workspace id must be a string")
    if not value:
        raise ValueError("workspace id cannot be blank")
    if len(value) > MAX_WORKSPACE_ID_LENGTH:
        raise ValueError(
            f"workspace id must be {MAX_WORKSPACE_ID_LENGTH} characters or fewer"
        )
    if not all(
        character.isascii() and (character.isalnum() or character in "_-")
        for character in value
    ):
        raise ValueError(
            "workspace id can contain only ASCII letters, numbers, hyphens, and underscores"
        )
    return value


def _validate_timestamp(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value < 0:
        raise ValueError(f"{field} cannot be negative")
    return value


def _normalize_quick_link_label(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    label = value.strip()
    if not label:
        raise ValueError(f"{field} cannot be blank")
    if len(label) > MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in label):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(label, field)
    return label


def _normalize_quick_link_url(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    url = value.strip()
    if not url:
        raise ValueError(f"{field} cannot be blank")
    if len(url) > MAX_WORKSPACE_QUICK_LINK_URL_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_WORKSPACE_QUICK_LINK_URL_LENGTH} characters or fewer"
        )
    if any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in url
    ):
        raise ValueError(f"{field} cannot contain whitespace or control characters")
    _validate_unicode(url, field)
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as error:
        raise ValueError(f"{field} must be a valid HTTP or HTTPS URL") from error
    if parsed.scheme not in {"http", "https"} or not hostname:
        raise ValueError(f"{field} must be a valid HTTP or HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{field} cannot contain credentials")
    return url


@dataclass(frozen=True)
class WorkspaceQuickLink:
    id: str
    label: str
    url: str

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "label": self.label, "url": self.url}


def validate_workspace_quick_links(
    value: object,
    field: str = "quickLinks",
) -> tuple[WorkspaceQuickLink, ...]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if len(value) > MAX_WORKSPACE_QUICK_LINKS:
        raise ValueError(
            f"{field} cannot contain more than {MAX_WORKSPACE_QUICK_LINKS} links"
        )

    links: list[WorkspaceQuickLink] = []
    seen_ids: set[str] = set()
    expected_fields = {"id", "label", "url"}
    for index, candidate in enumerate(value):
        path = f"{field}[{index}]"
        if not isinstance(candidate, dict):
            raise TypeError(f"{path} must be an object")
        missing = sorted(expected_fields - set(candidate))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(item) for item in set(candidate) - expected_fields)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")

        link_id = _validate_workspace_group_id(candidate["id"], f"{path}.id")
        if len(link_id) > MAX_WORKSPACE_QUICK_LINK_ID_LENGTH:
            raise ValueError(
                f"{path}.id must be {MAX_WORKSPACE_QUICK_LINK_ID_LENGTH} characters or fewer"
            )
        if link_id in seen_ids:
            raise ValueError(f"{field} contains duplicate id: {link_id}")
        seen_ids.add(link_id)
        links.append(
            WorkspaceQuickLink(
                id=link_id,
                label=_normalize_quick_link_label(candidate["label"], f"{path}.label"),
                url=_normalize_quick_link_url(candidate["url"], f"{path}.url"),
            )
        )
    return tuple(links)


def validate_session_quick_links(
    value: object,
    field: str = "sessionQuickLinks",
) -> dict[str, tuple[WorkspaceQuickLink, ...]]:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")

    session_links: dict[str, tuple[WorkspaceQuickLink, ...]] = {}
    for raw_session_name, raw_links in value.items():
        if not isinstance(raw_session_name, str):
            raise TypeError(f"{field} session names must be strings")
        try:
            session_name = validate_session_name(raw_session_name)
            _validate_unicode(session_name, f"{field} session name")
        except ValueError as error:
            raise ValueError(f"{field} session name: {error}") from error
        links = validate_workspace_quick_links(
            raw_links,
            f"{field}[{session_name!r}]",
        )
        if links:
            session_links[session_name] = links
    return session_links


def normalize_scoped_note(value: object, field: str = "note") -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    note = value.replace("\r\n", "\n").replace("\r", "\n")
    if len(note) > MAX_SCOPED_NOTE_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_SCOPED_NOTE_LENGTH} characters or fewer"
        )
    if any(
        (ord(character) < 32 and character not in "\n\t")
        or ord(character) == 127
        for character in note
    ):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(note, field)
    return note if note.strip() else ""


def validate_workspace_notes(
    value: object,
    field: str = "workspaceNotes",
) -> dict[str, str]:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")

    notes: dict[str, str] = {}
    for raw_workspace_id, raw_note in value.items():
        if not isinstance(raw_workspace_id, str):
            raise TypeError(f"{field} workspace ids must be strings")
        workspace_id = _validate_workspace_id(raw_workspace_id)
        note = normalize_scoped_note(raw_note, f"{field}[{workspace_id!r}]")
        if note:
            notes[workspace_id] = note
    return notes


def validate_session_notes(
    value: object,
    field: str = "sessionNotes",
) -> dict[str, str]:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")

    notes: dict[str, str] = {}
    for raw_session_name, raw_note in value.items():
        if not isinstance(raw_session_name, str):
            raise TypeError(f"{field} session names must be strings")
        try:
            session_name = validate_session_name(raw_session_name)
            _validate_unicode(session_name, f"{field} session name")
        except ValueError as error:
            raise ValueError(f"{field} session name: {error}") from error
        note = normalize_scoped_note(raw_note, f"{field}[{session_name!r}]")
        if note:
            notes[session_name] = note
    return notes


@dataclass(frozen=True)
class ScopedNotes:
    common: str
    workspaces: dict[str, str]
    sessions: dict[str, str]


def _validate_session_revision(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("sessionRevision must be an integer")
    if value < 0:
        raise ValueError("sessionRevision cannot be negative")
    if value > MAX_SESSION_RENAME_REVISION:
        raise ValueError(
            "sessionRevision cannot exceed JavaScript's maximum safe integer"
        )
    return value


@dataclass(frozen=True)
class WorkspaceGroup:
    id: str
    name: str
    color: str
    collapsed: bool
    tabs: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "collapsed": self.collapsed,
            "tabs": list(self.tabs),
        }


def validate_workspace_groups(
    value: object,
    workspace_tabs: tuple[str, ...],
) -> tuple[WorkspaceGroup, ...]:
    if not isinstance(value, list):
        raise TypeError("groups must be an array")
    if len(value) > MAX_WORKSPACE_GROUPS:
        raise ValueError(
            f"groups cannot contain more than {MAX_WORKSPACE_GROUPS} groups"
        )

    workspace_positions = {
        session_name: index for index, session_name in enumerate(workspace_tabs)
    }
    groups: list[WorkspaceGroup] = []
    seen_ids: set[str] = set()
    seen_tabs: set[str] = set()
    previous_start = -1
    expected_fields = {"id", "name", "color", "collapsed", "tabs"}
    for index, candidate in enumerate(value):
        path = f"groups[{index}]"
        if not isinstance(candidate, dict):
            raise TypeError(f"{path} must be an object")
        missing = sorted(expected_fields - set(candidate))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(field) for field in set(candidate) - expected_fields)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")

        group_id = _validate_workspace_group_id(candidate["id"], f"{path}.id")
        if group_id in seen_ids:
            raise ValueError(f"groups contains duplicate id: {group_id}")
        seen_ids.add(group_id)
        name = _normalize_workspace_group_name(candidate["name"], f"{path}.name")
        color = candidate["color"]
        if not isinstance(color, str):
            raise TypeError(f"{path}.color must be a string")
        if color not in WORKSPACE_GROUP_COLOR_SET:
            raise ValueError(
                f"{path}.color must be one of: {', '.join(WORKSPACE_GROUP_COLORS)}"
            )
        collapsed = candidate["collapsed"]
        if not isinstance(collapsed, bool):
            raise TypeError(f"{path}.collapsed must be a boolean")
        tabs = _validate_workspace_group_tabs(candidate["tabs"], f"{path}.tabs")

        unknown_tabs = [tab for tab in tabs if tab not in workspace_positions]
        if unknown_tabs:
            raise ValueError(
                f"{path}.tabs contains session outside workspace tabs: {unknown_tabs[0]}"
            )
        duplicate_tabs = [tab for tab in tabs if tab in seen_tabs]
        if duplicate_tabs:
            raise ValueError(
                f"groups contains session in more than one group: {duplicate_tabs[0]}"
            )
        start = workspace_positions[tabs[0]]
        if tuple(workspace_tabs[start : start + len(tabs)]) != tabs:
            raise ValueError(
                f"{path}.tabs must be contiguous and follow workspace tab order"
            )
        if start <= previous_start:
            raise ValueError("groups must follow workspace tab order")
        previous_start = start
        seen_tabs.update(tabs)
        groups.append(
            WorkspaceGroup(
                id=group_id,
                name=name,
                color=color,
                collapsed=collapsed,
                tabs=tabs,
            )
        )
    return tuple(groups)


def _reconcile_workspace_groups(
    groups: tuple[WorkspaceGroup, ...],
    workspace_tabs: tuple[str, ...],
) -> tuple[WorkspaceGroup, ...]:
    positions = {tab: index for index, tab in enumerate(workspace_tabs)}
    reconciled: list[tuple[int, WorkspaceGroup]] = []
    for group in groups:
        member_set = set(group.tabs)
        tabs = tuple(tab for tab in workspace_tabs if tab in member_set)
        if not tabs:
            continue
        start = positions[tabs[0]]
        if tuple(workspace_tabs[start : start + len(tabs)]) != tabs:
            continue
        reconciled.append((start, replace(group, tabs=tabs)))
    reconciled.sort(key=lambda item: item[0])
    return tuple(group for _, group in reconciled)


def _rename_workspace_groups(
    groups: tuple[WorkspaceGroup, ...],
    workspace_tabs: tuple[str, ...],
    renamed_tabs: tuple[str, ...],
    current_name: str,
    new_name: str,
) -> tuple[WorkspaceGroup, ...]:
    group_by_tab = {
        tab: group.id for group in groups for tab in group.tabs
    }
    source_by_renamed_tab: dict[str, str] = {}
    for tab in workspace_tabs:
        renamed_tab = new_name if tab == current_name else tab
        if tab == current_name:
            # The live renamed session wins over a stale saved tab that already
            # used the target name, regardless of their workspace order.
            source_by_renamed_tab[renamed_tab] = tab
        else:
            source_by_renamed_tab.setdefault(renamed_tab, tab)

    renamed_groups: list[WorkspaceGroup] = []
    for group in groups:
        tabs = tuple(
            tab
            for tab in renamed_tabs
            if group_by_tab.get(source_by_renamed_tab[tab]) == group.id
        )
        if tabs:
            renamed_groups.append(replace(group, tabs=tabs))
    return _reconcile_workspace_groups(tuple(renamed_groups), renamed_tabs)


@dataclass(frozen=True)
class SavedWorkspace:
    id: str
    name: str
    tabs: tuple[str, ...]
    groups: tuple[WorkspaceGroup, ...]
    quick_links: tuple[WorkspaceQuickLink, ...]
    active_session: str | None
    created_at: int
    updated_at: int
    last_active_at: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "tabs": list(self.tabs),
            "groups": [group.to_dict() for group in self.groups],
            "quickLinks": [link.to_dict() for link in self.quick_links],
            "activeSession": self.active_session,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastActiveAt": self.last_active_at,
        }


class WorkspaceNotFoundError(LookupError):
    pass


class WorkspaceSessionRevisionConflict(RuntimeError):
    def __init__(self, current: int, received: int) -> None:
        super().__init__(
            "workspace session revision conflict: "
            f"current revision is {current}, received {received}; reload the workspace"
        )
        self.current = current
        self.received = received


class WorkspaceStoreUnavailable(RuntimeError):
    pass


class _WorkspaceDirectorySyncError(OSError):
    pass


class WorkspaceStore:
    def __init__(
        self,
        path: Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.path = path or default_workspaces_path()
        self._clock = clock
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._lock = threading.RLock()
        self._load_error: str | None = None
        self._write_error: str | None = None
        (
            self._workspaces,
            self._session_rename_revision,
            self._common_quick_links,
            self._session_quick_links,
            self._notes,
        ) = self._load()
        if (
            self._load_error is None
            and self._session_rename_revision == MAX_SESSION_RENAME_REVISION
        ):
            self._fence_writes("the session rename revision is exhausted")

    def list_workspaces(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_available()
            ordered = sorted(
                self._workspaces.values(),
                key=lambda workspace: (
                    -workspace.last_active_at,
                    -workspace.updated_at,
                    workspace.name.casefold(),
                    workspace.id,
                ),
            )
            return [self._workspace_dict(workspace) for workspace in ordered]

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        with self._lock:
            self._ensure_available()
            return self._workspace_dict(self._find(workspace_id))

    def list_common_quick_links(self) -> list[dict[str, str]]:
        with self._lock:
            self._ensure_available()
            return [link.to_dict() for link in self._common_quick_links]

    def replace_common_quick_links(self, links: object) -> list[dict[str, str]]:
        validated_links = validate_workspace_quick_links(links, "links")
        with self._lock:
            self._ensure_writable()
            self._commit(self._workspaces, common_quick_links=validated_links)
            return [link.to_dict() for link in self._common_quick_links]

    def get_common_note(self) -> str:
        with self._lock:
            self._ensure_available()
            return self._notes.common

    def replace_common_note(self, note: object) -> str:
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            self._commit(
                self._workspaces,
                notes=replace(self._notes, common=validated_note),
            )
            return self._notes.common

    def get_session_quick_links(self, session_name: str) -> list[dict[str, str]]:
        session_name = validate_session_name(session_name)
        with self._lock:
            self._ensure_available()
            return [
                link.to_dict()
                for link in self._session_quick_links.get(session_name, ())
            ]

    def replace_session_quick_links(
        self,
        session_name: str,
        links: object,
    ) -> list[dict[str, str]]:
        session_name = validate_session_name(session_name)
        validated_links = validate_workspace_quick_links(links, "links")
        with self._lock:
            self._ensure_writable()
            next_session_quick_links = self._session_quick_links.copy()
            if validated_links:
                next_session_quick_links[session_name] = validated_links
            else:
                next_session_quick_links.pop(session_name, None)
            self._commit(
                self._workspaces,
                session_quick_links=next_session_quick_links,
            )
            return self.get_session_quick_links(session_name)

    def get_session_note(self, session_name: str) -> str:
        session_name = validate_session_name(session_name)
        with self._lock:
            self._ensure_available()
            return self._notes.sessions.get(session_name, "")

    def replace_session_note(self, session_name: str, note: object) -> str:
        session_name = validate_session_name(session_name)
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            next_session_notes = self._notes.sessions.copy()
            if validated_note:
                next_session_notes[session_name] = validated_note
            else:
                next_session_notes.pop(session_name, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, sessions=next_session_notes),
            )
            return self._notes.sessions.get(session_name, "")

    def get_workspace_quick_links(self, workspace_id: str) -> list[dict[str, str]]:
        workspace_id = _validate_workspace_id(workspace_id)
        with self._lock:
            self._ensure_available()
            return [link.to_dict() for link in self._find(workspace_id).quick_links]

    def replace_workspace_quick_links(
        self,
        workspace_id: str,
        links: object,
    ) -> list[dict[str, str]]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_links = validate_workspace_quick_links(links, "links")
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            timestamp = max(self._timestamp(), current.updated_at + 1)
            workspace = replace(
                current,
                quick_links=validated_links,
                updated_at=timestamp,
            )
            self._commit({**self._workspaces, workspace_id: workspace})
            return [link.to_dict() for link in workspace.quick_links]

    def get_workspace_note(self, workspace_id: str) -> str:
        workspace_id = _validate_workspace_id(workspace_id)
        with self._lock:
            self._ensure_available()
            self._find(workspace_id)
            return self._notes.workspaces.get(workspace_id, "")

    def replace_workspace_note(self, workspace_id: str, note: object) -> str:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            self._find(workspace_id)
            next_workspace_notes = self._notes.workspaces.copy()
            if validated_note:
                next_workspace_notes[workspace_id] = validated_note
            else:
                next_workspace_notes.pop(workspace_id, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, workspaces=next_workspace_notes),
            )
            return self._notes.workspaces.get(workspace_id, "")

    def create_workspace(
        self,
        *,
        name: object,
        tabs: object,
        active_session: object,
        groups: object = _GROUPS_OMITTED,
        quick_links: object = _QUICK_LINKS_OMITTED,
    ) -> dict[str, Any]:
        normalized_name = normalize_workspace_name(name)
        validated_tabs = validate_workspace_tabs(tabs)
        validated_groups = validate_workspace_groups(
            [] if groups is _GROUPS_OMITTED else groups,
            validated_tabs,
        )
        validated_quick_links = validate_workspace_quick_links(
            [] if quick_links is _QUICK_LINKS_OMITTED else quick_links,
        )
        validated_active_session = validate_active_session(
            active_session, validated_tabs
        )

        with self._lock:
            self._ensure_writable()
            workspace_id = self._new_id()
            timestamp = self._timestamp()
            workspace = SavedWorkspace(
                id=workspace_id,
                name=normalized_name,
                tabs=validated_tabs,
                groups=validated_groups,
                quick_links=validated_quick_links,
                active_session=validated_active_session,
                created_at=timestamp,
                updated_at=timestamp,
                last_active_at=timestamp,
            )
            next_workspaces = {**self._workspaces, workspace_id: workspace}
            self._commit(next_workspaces)
            return self._workspace_dict(workspace)

    def update_workspace(
        self,
        workspace_id: str,
        *,
        name: object = None,
        tabs: object = None,
        groups: object = None,
        active_session: object = None,
        update_name: bool = False,
        update_tabs: bool = False,
        update_groups: bool = False,
        update_active_session: bool = False,
        session_revision: object = None,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        normalized_name = normalize_workspace_name(name) if update_name else None
        validated_tabs = validate_workspace_tabs(tabs) if update_tabs else None
        validated_session_revision = (
            _validate_session_revision(session_revision)
            if update_tabs or update_groups or update_active_session
            else None
        )

        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            if (
                validated_session_revision is not None
                and validated_session_revision != self._session_rename_revision
            ):
                raise WorkspaceSessionRevisionConflict(
                    self._session_rename_revision, validated_session_revision
                )
            next_tabs = validated_tabs if validated_tabs is not None else current.tabs
            next_groups = (
                validate_workspace_groups(groups, next_tabs)
                if update_groups
                else _reconcile_workspace_groups(current.groups, next_tabs)
                if update_tabs
                else current.groups
            )
            next_active_session = (
                validate_active_session(active_session, next_tabs)
                if update_active_session
                else current.active_session
            )
            if next_active_session is not None and next_active_session not in next_tabs:
                raise ValueError("activeSession must be one of the workspace tabs")
            timestamp = max(self._timestamp(), current.updated_at + 1)
            workspace = replace(
                current,
                name=normalized_name if normalized_name is not None else current.name,
                tabs=next_tabs,
                groups=next_groups,
                active_session=next_active_session,
                updated_at=timestamp,
            )
            next_workspaces = {**self._workspaces, workspace_id: workspace}
            self._commit(next_workspaces)
            return self._workspace_dict(workspace)

    def record_activity(
        self,
        workspace_id: str,
        *,
        tabs: object,
        active_session: object,
        session_revision: object,
        groups: object = None,
        update_groups: bool = False,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_tabs = validate_workspace_tabs(tabs)
        validated_active_session = validate_active_session(
            active_session, validated_tabs
        )
        validated_session_revision = _validate_session_revision(session_revision)

        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            if validated_session_revision != self._session_rename_revision:
                raise WorkspaceSessionRevisionConflict(
                    self._session_rename_revision, validated_session_revision
                )
            validated_groups = (
                validate_workspace_groups(groups, validated_tabs)
                if update_groups
                else _reconcile_workspace_groups(current.groups, validated_tabs)
            )
            timestamp = max(
                self._timestamp(),
                current.updated_at + 1,
                current.last_active_at + 1,
            )
            workspace = replace(
                current,
                tabs=validated_tabs,
                groups=validated_groups,
                active_session=validated_active_session,
                updated_at=timestamp,
                last_active_at=timestamp,
            )
            next_workspaces = {**self._workspaces, workspace_id: workspace}
            self._commit(next_workspaces)
            return self._workspace_dict(workspace)

    def delete_workspace(self, workspace_id: str) -> None:
        workspace_id = _validate_workspace_id(workspace_id)
        with self._lock:
            self._ensure_writable()
            self._find(workspace_id)
            next_workspaces = self._workspaces.copy()
            del next_workspaces[workspace_id]
            next_workspace_notes = self._notes.workspaces.copy()
            next_workspace_notes.pop(workspace_id, None)
            self._commit(
                next_workspaces,
                notes=replace(self._notes, workspaces=next_workspace_notes),
            )

    def rename_session(self, current_name: str, new_name: str) -> int:
        current_name = validate_session_name(current_name)
        new_name = validate_session_name(new_name)
        if current_name == new_name:
            raise ValueError("new session name must differ from current session name")

        with self._lock:
            self._ensure_writable()
            timestamp = self._timestamp()
            changed = 0
            next_workspaces = self._workspaces.copy()
            for workspace_id, current in self._workspaces.items():
                if current_name not in current.tabs:
                    continue
                renamed_tabs = tuple(
                    dict.fromkeys(
                        new_name if tab == current_name else tab
                        for tab in current.tabs
                        if tab == current_name or tab != new_name
                    )
                )
                active_session = (
                    new_name
                    if current.active_session == current_name
                    else current.active_session
                )
                groups = _rename_workspace_groups(
                    current.groups,
                    current.tabs,
                    renamed_tabs,
                    current_name,
                    new_name,
                )
                workspace = replace(
                    current,
                    tabs=renamed_tabs,
                    groups=groups,
                    active_session=active_session,
                    updated_at=max(timestamp, current.updated_at + 1),
                )
                next_workspaces[workspace_id] = workspace
                changed += 1

            next_session_quick_links = self._session_quick_links.copy()
            renamed_links = next_session_quick_links.pop(current_name, ())
            next_session_quick_links.pop(new_name, None)
            if renamed_links:
                next_session_quick_links[new_name] = renamed_links

            next_session_notes = self._notes.sessions.copy()
            renamed_note = next_session_notes.pop(current_name, "")
            next_session_notes.pop(new_name, None)
            if renamed_note:
                next_session_notes[new_name] = renamed_note

            try:
                self._commit(
                    next_workspaces,
                    self._session_rename_revision + 1,
                    session_quick_links=next_session_quick_links,
                    notes=replace(self._notes, sessions=next_session_notes),
                )
            except _WorkspaceDirectorySyncError:
                raise
            except OSError as error:
                # tmux has already committed its rename. Until an operator repairs
                # the persisted workspace state, another write could accept a
                # pre-rename browser snapshot and restore the obsolete name.
                self._fence_writes(f"session rename persistence failed: {error}")
                raise
            return changed

    def _workspace_dict(self, workspace: SavedWorkspace) -> dict[str, Any]:
        return {
            **workspace.to_dict(),
            "sessionRevision": self._session_rename_revision,
        }

    def _new_id(self) -> str:
        for _ in range(100):
            workspace_id = _validate_workspace_id(self._id_factory())
            if workspace_id not in self._workspaces:
                return workspace_id
        raise RuntimeError("unable to generate a unique workspace id")

    def _find(self, workspace_id: str) -> SavedWorkspace:
        try:
            return self._workspaces[workspace_id]
        except KeyError as error:
            raise WorkspaceNotFoundError(
                f"workspace not found: {workspace_id}"
            ) from error

    def _timestamp(self) -> int:
        return max(0, int(self._clock() * 1000))

    def _load(
        self,
    ) -> tuple[
        dict[str, SavedWorkspace],
        int,
        tuple[WorkspaceQuickLink, ...],
        dict[str, tuple[WorkspaceQuickLink, ...]],
        ScopedNotes,
    ]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("document must be an object")
            version = payload.get("version")
            if (
                isinstance(version, bool)
                or not isinstance(version, int)
                or version < 1
                or version > WORKSPACE_SCHEMA_VERSION
            ):
                raise ValueError("unsupported document version")
            session_rename_revision = (
                _validate_session_revision(payload.get("sessionRenameRevision"))
                if version >= 2
                else 0
            )
            common_quick_links = (
                validate_workspace_quick_links(
                    payload.get("commonQuickLinks"),
                    "commonQuickLinks",
                )
                if version >= 4
                else ()
            )
            session_quick_links = (
                validate_session_quick_links(payload.get("sessionQuickLinks"))
                if version >= 5
                else {}
            )
            notes = (
                ScopedNotes(
                    common=normalize_scoped_note(
                        payload.get("commonNote"),
                        "commonNote",
                    ),
                    workspaces=validate_workspace_notes(
                        payload.get("workspaceNotes")
                    ),
                    sessions=validate_session_notes(payload.get("sessionNotes")),
                )
                if version >= 6
                else ScopedNotes(common="", workspaces={}, sessions={})
            )
            records = payload.get("workspaces")
            if not isinstance(records, list):
                raise TypeError("workspaces must be an array")

            workspaces: dict[str, SavedWorkspace] = {}
            for index, record in enumerate(records):
                workspace = self._load_workspace(record, index, version)
                if workspace.id in workspaces:
                    raise ValueError(f"duplicate workspace id: {workspace.id}")
                workspaces[workspace.id] = workspace
            return (
                workspaces,
                session_rename_revision,
                common_quick_links,
                session_quick_links,
                notes,
            )
        except FileNotFoundError as error:
            if not self.path.is_symlink():
                return {}, 0, (), {}, ScopedNotes(common="", workspaces={}, sessions={})
            self._record_load_error(error)
        except (OSError, TypeError, ValueError, RecursionError) as error:
            self._record_load_error(error)
        return {}, 0, (), {}, ScopedNotes(common="", workspaces={}, sessions={})

    @staticmethod
    def _load_workspace(
        record: object,
        index: int,
        version: int,
    ) -> SavedWorkspace:
        path = f"workspaces[{index}]"
        if not isinstance(record, dict):
            raise TypeError(f"{path} must be an object")
        expected = {
            "id",
            "name",
            "tabs",
            "activeSession",
            "createdAt",
            "updatedAt",
            "lastActiveAt",
        }
        if version >= 3:
            expected.add("groups")
        if version >= 4:
            expected.add("quickLinks")
        missing = sorted(expected - set(record))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(field) for field in set(record) - expected)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")

        workspace_id = _validate_workspace_id(record["id"])
        name = normalize_workspace_name(record["name"])
        tabs = validate_workspace_tabs(record["tabs"])
        groups = (
            validate_workspace_groups(record["groups"], tabs)
            if version >= 3
            else ()
        )
        quick_links = (
            validate_workspace_quick_links(record["quickLinks"])
            if version >= 4
            else ()
        )
        active_session = validate_active_session(record["activeSession"], tabs)
        created_at = _validate_timestamp(record["createdAt"], "createdAt")
        updated_at = _validate_timestamp(record["updatedAt"], "updatedAt")
        last_active_at = _validate_timestamp(record["lastActiveAt"], "lastActiveAt")
        if updated_at < created_at:
            raise ValueError(f"{path}.updatedAt cannot precede createdAt")
        if last_active_at < created_at:
            raise ValueError(f"{path}.lastActiveAt cannot precede createdAt")
        if last_active_at > updated_at:
            raise ValueError(f"{path}.lastActiveAt cannot exceed updatedAt")
        return SavedWorkspace(
            id=workspace_id,
            name=name,
            tabs=tabs,
            groups=groups,
            quick_links=quick_links,
            active_session=active_session,
            created_at=created_at,
            updated_at=updated_at,
            last_active_at=last_active_at,
        )

    def _record_load_error(self, error: BaseException) -> None:
        self._load_error = f"{type(error).__name__}: {error}"
        LOGGER.error(
            "Workspace storage is unavailable because %s could not be loaded: %s. "
            "Refusing reads and writes until Muxdeck restarts with a valid file.",
            self.path,
            error,
        )

    def _ensure_available(self) -> None:
        if self._load_error is not None:
            raise WorkspaceStoreUnavailable(WORKSPACE_STORE_UNAVAILABLE_MESSAGE)

    def _ensure_writable(self) -> None:
        self._ensure_available()
        if self._write_error is not None:
            raise WorkspaceStoreUnavailable(WORKSPACE_STORE_UNAVAILABLE_MESSAGE)

    def _fence_writes(self, reason: str) -> None:
        self._write_error = reason
        LOGGER.error(
            "Workspace writes are disabled because %s. Repair the configured "
            "workspace state and restart Muxdeck before accepting more writes.",
            reason,
        )

    def _commit(
        self,
        workspaces: dict[str, SavedWorkspace],
        session_rename_revision: int | None = None,
        common_quick_links: tuple[WorkspaceQuickLink, ...] | None = None,
        session_quick_links: (
            dict[str, tuple[WorkspaceQuickLink, ...]] | None
        ) = None,
        notes: ScopedNotes | None = None,
    ) -> None:
        next_revision = (
            self._session_rename_revision
            if session_rename_revision is None
            else session_rename_revision
        )
        next_common_quick_links = (
            self._common_quick_links
            if common_quick_links is None
            else common_quick_links
        )
        next_session_quick_links = (
            self._session_quick_links
            if session_quick_links is None
            else session_quick_links
        )
        next_notes = self._notes if notes is None else notes
        try:
            self._persist(
                workspaces,
                next_revision,
                next_common_quick_links,
                next_session_quick_links,
                next_notes,
            )
        except _WorkspaceDirectorySyncError:
            # The atomic rename committed; keep memory consistent with disk even
            # though the caller must be told durability could not be confirmed.
            self._workspaces = workspaces
            self._session_rename_revision = next_revision
            self._common_quick_links = next_common_quick_links
            self._session_quick_links = next_session_quick_links
            self._notes = next_notes
            if next_revision == MAX_SESSION_RENAME_REVISION:
                self._fence_writes("the session rename revision is exhausted")
            raise
        self._workspaces = workspaces
        self._session_rename_revision = next_revision
        self._common_quick_links = next_common_quick_links
        self._session_quick_links = next_session_quick_links
        self._notes = next_notes
        if next_revision == MAX_SESSION_RENAME_REVISION:
            self._fence_writes("the session rename revision is exhausted")

    def _persist(
        self,
        workspaces: dict[str, SavedWorkspace],
        session_rename_revision: int,
        common_quick_links: tuple[WorkspaceQuickLink, ...],
        session_quick_links: dict[str, tuple[WorkspaceQuickLink, ...]],
        notes: ScopedNotes,
    ) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
                json.dump(
                    {
                        "version": WORKSPACE_SCHEMA_VERSION,
                        "sessionRenameRevision": session_rename_revision,
                        "commonQuickLinks": [
                            link.to_dict() for link in common_quick_links
                        ],
                        "sessionQuickLinks": {
                            session_name: [link.to_dict() for link in links]
                            for session_name, links in session_quick_links.items()
                        },
                        "commonNote": notes.common,
                        "workspaceNotes": notes.workspaces,
                        "sessionNotes": notes.sessions,
                        "workspaces": [
                            workspace.to_dict() for workspace in workspaces.values()
                        ],
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
                raise _WorkspaceDirectorySyncError(
                    f"unable to sync workspace state directory: {error}"
                ) from error
        finally:
            if directory_fd is not None:
                with contextlib.suppress(OSError):
                    os.close(directory_fd)
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
