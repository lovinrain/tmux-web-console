from __future__ import annotations

import contextlib
import json
import logging
import math
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
MAX_WORKSPACE_TABS = 256
MAX_WORKSPACE_GROUPS = 16
MAX_WORKSPACE_GROUP_ID_LENGTH = 64
MAX_WORKSPACE_GROUP_NAME_LENGTH = 40
MAX_WORKSPACE_QUICK_LINKS = 16
MAX_WORKSPACE_QUICK_LINK_ID_LENGTH = 64
MAX_WORKSPACE_QUICK_LINK_LABEL_LENGTH = 48
MAX_WORKSPACE_QUICK_LINK_URL_LENGTH = 2048
MAX_WORKSPACE_CALLBACK_SESSIONS = 64
MAX_SCOPED_NOTE_PAGES = 128
MAX_SCOPED_NOTE_PAGE_ID_LENGTH = 64
MAX_SCOPED_NOTE_PAGE_NAME_LENGTH = 80
MAX_WORKSPACE_PANE_LAYOUTS = 16
MAX_WORKSPACE_PANE_LAYOUT_ID_LENGTH = 64
MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH = 64
MAX_WORKSPACE_PANES_PER_LAYOUT = 12
MAX_WORKSPACE_PANE_DEPTH = 6
MIN_WORKSPACE_PANE_RATIO = 0.15
MAX_WORKSPACE_PANE_RATIO = 0.85
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
_SEPARATORS_OMITTED = object()
_PANE_LAYOUTS_OMITTED = object()
_CALLBACK_SESSIONS_OMITTED = object()
_ACTIVE_SESSION_OMITTED = object()
MAX_SESSION_RENAME_REVISION = (1 << 53) - 1
WORKSPACE_SCHEMA_VERSION = 12
WORKSPACE_STORE_UNAVAILABLE_MESSAGE = (
    "workspace storage is unavailable; inspect and repair the configured workspaces "
    "file, then restart Muxdeck"
)


def workspace_api_capabilities() -> dict[str, Any]:
    """Return stable machine-readable limits for workspace automation clients."""
    return {
        "schemaVersion": WORKSPACE_SCHEMA_VERSION,
        "limits": {
            "tabsPerWorkspace": MAX_WORKSPACE_TABS,
            "groupsPerWorkspace": MAX_WORKSPACE_GROUPS,
            "quickLinksPerScope": MAX_WORKSPACE_QUICK_LINKS,
            "callbackSessionsPerWorkspace": MAX_WORKSPACE_CALLBACK_SESSIONS,
            "notePagesPerScope": MAX_SCOPED_NOTE_PAGES,
            "paneLayoutsPerWorkspace": MAX_WORKSPACE_PANE_LAYOUTS,
            "panesPerLayout": MAX_WORKSPACE_PANES_PER_LAYOUT,
            "paneSplitDepth": MAX_WORKSPACE_PANE_DEPTH,
            "paneRatio": {
                "minimum": MIN_WORKSPACE_PANE_RATIO,
                "maximum": MAX_WORKSPACE_PANE_RATIO,
            },
        },
        "groupColors": list(WORKSPACE_GROUP_COLORS),
        "sessionInsertPositions": ["start", "end", "before", "after"],
        "separatorPlacements": ["before", "after"],
        "paneSplitDirections": ["horizontal", "vertical"],
    }


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


def validate_workspace_callback_sessions(
    value: object,
    field: str = "callbackSessions",
) -> tuple[str, ...]:
    """Validate the ordered, workspace-scoped sessions a user wants to revisit."""
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if len(value) > MAX_WORKSPACE_CALLBACK_SESSIONS:
        raise ValueError(
            f"{field} cannot contain more than {MAX_WORKSPACE_CALLBACK_SESSIONS} sessions"
        )

    sessions: list[str] = []
    seen: set[str] = set()
    for index, candidate in enumerate(value):
        item_field = f"{field}[{index}]"
        if not isinstance(candidate, str):
            raise TypeError(f"{item_field} must be a string")
        try:
            session_name = validate_session_name(candidate)
            _validate_unicode(session_name, item_field)
        except ValueError as error:
            raise ValueError(f"{item_field}: {error}") from error
        if session_name in seen:
            raise ValueError(f"{field} contains duplicate session: {session_name}")
        seen.add(session_name)
        sessions.append(session_name)
    return tuple(sessions)


def _validate_pinned_session_names(value: object, field: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if len(value) > MAX_WORKSPACE_TABS:
        raise ValueError(
            f"{field} cannot contain more than {MAX_WORKSPACE_TABS} sessions"
        )

    sessions: list[str] = []
    seen: set[str] = set()
    for index, candidate in enumerate(value):
        item_field = f"{field}[{index}]"
        if not isinstance(candidate, str):
            raise TypeError(f"{item_field} must be a string")
        try:
            session_name = validate_session_name(candidate)
            _validate_unicode(session_name, item_field)
        except ValueError as error:
            raise ValueError(f"{item_field}: {error}") from error
        if session_name in seen:
            raise ValueError(f"{field} contains duplicate session: {session_name}")
        seen.add(session_name)
        sessions.append(session_name)
    return tuple(sessions)


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
    if any(
        (ord(character) < 32 and character not in "\n\t")
        or ord(character) == 127
        for character in note
    ):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(note, field)
    return note if note.strip() else ""


def _validate_scoped_note_page_id(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} cannot be blank")
    if len(value) > MAX_SCOPED_NOTE_PAGE_ID_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_SCOPED_NOTE_PAGE_ID_LENGTH} characters or fewer"
        )
    if not all(
        character.isascii() and (character.isalnum() or character in "_-")
        for character in value
    ):
        raise ValueError(
            f"{field} can contain only ASCII letters, numbers, hyphens, and underscores"
        )
    return value


def _normalize_scoped_note_page_name(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    name = value.strip()
    if not name:
        raise ValueError(f"{field} cannot be blank")
    if len(name) > MAX_SCOPED_NOTE_PAGE_NAME_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_SCOPED_NOTE_PAGE_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(name, field)
    return name


@dataclass(frozen=True)
class ScopedNotePage:
    id: str
    name: str
    content: str

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "content": self.content}


@dataclass(frozen=True)
class ScopedNoteNotebook:
    pages: tuple[ScopedNotePage, ...]

    @property
    def first_content(self) -> str:
        return self.pages[0].content

    def to_dict(self) -> dict[str, list[dict[str, str]]]:
        return {"pages": [page.to_dict() for page in self.pages]}


def default_scoped_note_notebook(note: str = "") -> ScopedNoteNotebook:
    return ScopedNoteNotebook(
        pages=(ScopedNotePage(id="main", name="Page 1", content=note),)
    )


def validate_scoped_note_notebook(
    value: object,
    field: str = "notebook",
) -> ScopedNoteNotebook:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")
    unknown = sorted(str(item) for item in set(value) - {"pages"})
    if unknown:
        raise ValueError(f"{field} has unknown field: {unknown[0]}")
    if "pages" not in value:
        raise ValueError(f"{field} is missing field: pages")
    raw_pages = value["pages"]
    if not isinstance(raw_pages, list):
        raise TypeError(f"{field}.pages must be an array")
    if not raw_pages:
        raise ValueError(f"{field}.pages cannot be empty")
    if len(raw_pages) > MAX_SCOPED_NOTE_PAGES:
        raise ValueError(
            f"{field}.pages cannot contain more than {MAX_SCOPED_NOTE_PAGES} pages"
        )

    pages: list[ScopedNotePage] = []
    seen_ids: set[str] = set()
    expected_fields = {"id", "name", "content"}
    for index, candidate in enumerate(raw_pages):
        path = f"{field}.pages[{index}]"
        if not isinstance(candidate, dict):
            raise TypeError(f"{path} must be an object")
        missing = sorted(expected_fields - set(candidate))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(item) for item in set(candidate) - expected_fields)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")
        page_id = _validate_scoped_note_page_id(candidate["id"], f"{path}.id")
        if page_id in seen_ids:
            raise ValueError(f"{field}.pages contains duplicate id: {page_id}")
        seen_ids.add(page_id)
        pages.append(
            ScopedNotePage(
                id=page_id,
                name=_normalize_scoped_note_page_name(
                    candidate["name"], f"{path}.name"
                ),
                content=normalize_scoped_note(candidate["content"], f"{path}.content"),
            )
        )
    return ScopedNoteNotebook(pages=tuple(pages))


def _scoped_note_notebook_from_legacy(value: object, field: str) -> ScopedNoteNotebook:
    return default_scoped_note_notebook(normalize_scoped_note(value, field))


def _is_default_scoped_note_notebook(notebook: ScopedNoteNotebook) -> bool:
    return notebook == default_scoped_note_notebook()


def _replace_notebook_first_content(
    notebook: ScopedNoteNotebook,
    note: str,
) -> ScopedNoteNotebook:
    first, *remaining = notebook.pages
    return ScopedNoteNotebook(
        pages=(replace(first, content=note), *remaining),
    )


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


def validate_workspace_notebooks(
    value: object,
    field: str = "workspaceNotebooks",
) -> dict[str, ScopedNoteNotebook]:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")

    notebooks: dict[str, ScopedNoteNotebook] = {}
    for raw_workspace_id, raw_notebook in value.items():
        if not isinstance(raw_workspace_id, str):
            raise TypeError(f"{field} workspace ids must be strings")
        workspace_id = _validate_workspace_id(raw_workspace_id)
        notebook = validate_scoped_note_notebook(
            raw_notebook,
            f"{field}[{workspace_id!r}]",
        )
        if not _is_default_scoped_note_notebook(notebook):
            notebooks[workspace_id] = notebook
    return notebooks


def validate_session_notebooks(
    value: object,
    field: str = "sessionNotebooks",
) -> dict[str, ScopedNoteNotebook]:
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")

    notebooks: dict[str, ScopedNoteNotebook] = {}
    for raw_session_name, raw_notebook in value.items():
        if not isinstance(raw_session_name, str):
            raise TypeError(f"{field} session names must be strings")
        try:
            session_name = validate_session_name(raw_session_name)
            _validate_unicode(session_name, f"{field} session name")
        except ValueError as error:
            raise ValueError(f"{field} session name: {error}") from error
        notebook = validate_scoped_note_notebook(
            raw_notebook,
            f"{field}[{session_name!r}]",
        )
        if not _is_default_scoped_note_notebook(notebook):
            notebooks[session_name] = notebook
    return notebooks


@dataclass(frozen=True)
class ScopedNotes:
    common: ScopedNoteNotebook
    workspaces: dict[str, ScopedNoteNotebook]
    sessions: dict[str, ScopedNoteNotebook]


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


def validate_workspace_separators(value: object, tabs: tuple[str, ...]) -> tuple[str, ...]:
    separators = validate_workspace_tabs(value)
    if any(tab not in tabs for tab in separators):
        raise ValueError("separators must refer to workspace tabs")
    return tuple(tab for tab in tabs if tab in separators)


def _normalize_workspace_pane_layout_name(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    name = value.strip()
    if not name:
        raise ValueError(f"{field} cannot be blank")
    if len(name) > MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH:
        raise ValueError(
            f"{field} must be {MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError(f"{field} cannot contain control characters")
    _validate_unicode(name, field)
    return name


@dataclass(frozen=True)
class WorkspacePaneNode:
    id: str
    kind: str
    session: str | None = None
    direction: str | None = None
    ratio: float | None = None
    first: WorkspacePaneNode | None = None
    second: WorkspacePaneNode | None = None

    def to_dict(self) -> dict[str, Any]:
        if self.kind == "pane":
            return {"id": self.id, "kind": "pane", "session": self.session}
        if self.first is None or self.second is None:
            raise ValueError("split pane node is missing a child")
        return {
            "id": self.id,
            "kind": "split",
            "direction": self.direction,
            "ratio": self.ratio,
            "first": self.first.to_dict(),
            "second": self.second.to_dict(),
        }


@dataclass(frozen=True)
class WorkspacePaneLayout:
    id: str
    name: str
    root: WorkspacePaneNode

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "root": self.root.to_dict()}


def _validate_workspace_pane_node(
    raw_node: object,
    *,
    node_path: str,
    layout_path: str,
    depth: int,
    workspace_tabs: set[str],
    seen_node_ids: set[str],
    assigned_sessions: set[str],
    pane_count: list[int],
) -> WorkspacePaneNode:
    if depth > MAX_WORKSPACE_PANE_DEPTH:
        raise ValueError(
            f"{node_path} exceeds maximum split depth {MAX_WORKSPACE_PANE_DEPTH}"
        )
    if not isinstance(raw_node, dict):
        raise TypeError(f"{node_path} must be an object")
    kind = raw_node.get("kind")
    if kind not in {"pane", "split"}:
        raise ValueError(f"{node_path}.kind must be pane or split")
    expected_node_fields = (
        {"id", "kind", "session"}
        if kind == "pane"
        else {"id", "kind", "direction", "ratio", "first", "second"}
    )
    missing_node_fields = sorted(expected_node_fields - set(raw_node))
    if missing_node_fields:
        raise ValueError(f"{node_path} is missing field: {missing_node_fields[0]}")
    unknown_node_fields = sorted(
        str(item) for item in set(raw_node) - expected_node_fields
    )
    if unknown_node_fields:
        raise ValueError(f"{node_path} has unknown field: {unknown_node_fields[0]}")
    node_id = _validate_workspace_group_id(raw_node["id"], f"{node_path}.id")
    if len(node_id) > MAX_WORKSPACE_PANE_LAYOUT_ID_LENGTH:
        raise ValueError(
            f"{node_path}.id must be "
            f"{MAX_WORKSPACE_PANE_LAYOUT_ID_LENGTH} characters or fewer"
        )
    if node_id in seen_node_ids:
        raise ValueError(f"{layout_path} contains duplicate pane node id: {node_id}")
    seen_node_ids.add(node_id)

    if kind == "pane":
        pane_count[0] += 1
        if pane_count[0] > MAX_WORKSPACE_PANES_PER_LAYOUT:
            raise ValueError(
                f"{layout_path} cannot contain more than "
                f"{MAX_WORKSPACE_PANES_PER_LAYOUT} panes"
            )
        session_value = raw_node["session"]
        if session_value is None:
            return WorkspacePaneNode(id=node_id, kind="pane")
        if not isinstance(session_value, str):
            raise TypeError(f"{node_path}.session must be a string or null")
        try:
            session_name = validate_session_name(session_value)
            _validate_unicode(session_name, f"{node_path}.session")
        except ValueError as error:
            raise ValueError(f"{node_path}.session: {error}") from error
        if session_name not in workspace_tabs:
            raise ValueError(f"{node_path}.session must be one of the workspace tabs")
        if session_name in assigned_sessions:
            raise ValueError(
                f"{layout_path} assigns session more than once: {session_name}"
            )
        assigned_sessions.add(session_name)
        return WorkspacePaneNode(id=node_id, kind="pane", session=session_name)

    direction = raw_node["direction"]
    if direction not in {"horizontal", "vertical"}:
        raise ValueError(f"{node_path}.direction must be horizontal or vertical")
    ratio = raw_node["ratio"]
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)):
        raise TypeError(f"{node_path}.ratio must be a number")
    numeric_ratio = float(ratio)
    if (
        not math.isfinite(numeric_ratio)
        or numeric_ratio < MIN_WORKSPACE_PANE_RATIO
        or numeric_ratio > MAX_WORKSPACE_PANE_RATIO
    ):
        raise ValueError(
            f"{node_path}.ratio must be between "
            f"{MIN_WORKSPACE_PANE_RATIO} and {MAX_WORKSPACE_PANE_RATIO}"
        )
    return WorkspacePaneNode(
        id=node_id,
        kind="split",
        direction=direction,
        ratio=round(numeric_ratio, 4),
        first=_validate_workspace_pane_node(
            raw_node["first"],
            node_path=f"{node_path}.first",
            layout_path=layout_path,
            depth=depth + 1,
            workspace_tabs=workspace_tabs,
            seen_node_ids=seen_node_ids,
            assigned_sessions=assigned_sessions,
            pane_count=pane_count,
        ),
        second=_validate_workspace_pane_node(
            raw_node["second"],
            node_path=f"{node_path}.second",
            layout_path=layout_path,
            depth=depth + 1,
            workspace_tabs=workspace_tabs,
            seen_node_ids=seen_node_ids,
            assigned_sessions=assigned_sessions,
            pane_count=pane_count,
        ),
    )


def validate_workspace_pane_layouts(
    value: object,
    workspace_tabs: tuple[str, ...],
    field: str = "paneLayouts",
) -> tuple[WorkspacePaneLayout, ...]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if len(value) > MAX_WORKSPACE_PANE_LAYOUTS:
        raise ValueError(
            f"{field} cannot contain more than {MAX_WORKSPACE_PANE_LAYOUTS} layouts"
        )

    workspace_tab_set = set(workspace_tabs)
    seen_layout_ids: set[str] = set()
    layouts: list[WorkspacePaneLayout] = []
    for layout_index, candidate in enumerate(value):
        path = f"{field}[{layout_index}]"
        if not isinstance(candidate, dict):
            raise TypeError(f"{path} must be an object")
        expected = {"id", "name", "root"}
        missing = sorted(expected - set(candidate))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(item) for item in set(candidate) - expected)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")

        layout_id = _validate_workspace_group_id(candidate["id"], f"{path}.id")
        if len(layout_id) > MAX_WORKSPACE_PANE_LAYOUT_ID_LENGTH:
            raise ValueError(
                f"{path}.id must be {MAX_WORKSPACE_PANE_LAYOUT_ID_LENGTH} characters or fewer"
            )
        if layout_id in seen_layout_ids:
            raise ValueError(f"{field} contains duplicate id: {layout_id}")
        seen_layout_ids.add(layout_id)

        seen_node_ids: set[str] = set()
        assigned_sessions: set[str] = set()
        pane_count = [0]

        layouts.append(
            WorkspacePaneLayout(
                id=layout_id,
                name=_normalize_workspace_pane_layout_name(
                    candidate["name"], f"{path}.name"
                ),
                root=_validate_workspace_pane_node(
                    candidate["root"],
                    node_path=f"{path}.root",
                    layout_path=path,
                    depth=1,
                    workspace_tabs=workspace_tab_set,
                    seen_node_ids=seen_node_ids,
                    assigned_sessions=assigned_sessions,
                    pane_count=pane_count,
                ),
            )
        )
    return tuple(layouts)


def _map_workspace_pane_sessions(
    node: WorkspacePaneNode,
    mapper: Callable[[str], str | None],
) -> WorkspacePaneNode:
    if node.kind == "pane":
        return replace(
            node,
            session=mapper(node.session) if node.session is not None else None,
        )
    if node.first is None or node.second is None:
        return node
    return replace(
        node,
        first=_map_workspace_pane_sessions(node.first, mapper),
        second=_map_workspace_pane_sessions(node.second, mapper),
    )


def _reconcile_workspace_pane_layouts(
    layouts: tuple[WorkspacePaneLayout, ...],
    workspace_tabs: tuple[str, ...],
) -> tuple[WorkspacePaneLayout, ...]:
    tab_set = set(workspace_tabs)
    return tuple(
        replace(
            layout,
            root=_map_workspace_pane_sessions(
                layout.root,
                lambda session_name: session_name if session_name in tab_set else None,
            ),
        )
        for layout in layouts
    )


def _rename_workspace_pane_layouts(
    layouts: tuple[WorkspacePaneLayout, ...],
    current_name: str,
    new_name: str,
) -> tuple[WorkspacePaneLayout, ...]:
    def renamed_layout(layout: WorkspacePaneLayout) -> WorkspacePaneLayout:
        source_present = False

        def find_source(node: WorkspacePaneNode) -> None:
            nonlocal source_present
            if node.kind == "pane":
                source_present = source_present or node.session == current_name
                return
            if node.first is not None:
                find_source(node.first)
            if node.second is not None:
                find_source(node.second)

        find_source(layout.root)

        def rename_session(session_name: str) -> str | None:
            if session_name == current_name:
                return new_name
            if source_present and session_name == new_name:
                return None
            return session_name

        return replace(
            layout,
            root=_map_workspace_pane_sessions(layout.root, rename_session),
        )

    return tuple(renamed_layout(layout) for layout in layouts)


@dataclass(frozen=True)
class SavedWorkspace:
    id: str
    name: str
    tabs: tuple[str, ...]
    groups: tuple[WorkspaceGroup, ...]
    quick_links: tuple[WorkspaceQuickLink, ...]
    inherited_pins: tuple[str, ...]
    active_session: str | None
    created_at: int
    updated_at: int
    last_active_at: int
    separators: tuple[str, ...] = ()
    separators_before: tuple[str, ...] = ()
    pane_layouts: tuple[WorkspacePaneLayout, ...] = ()
    callback_sessions: tuple[str, ...] = ()

    def to_dict(self, *, include_internal: bool = False) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "name": self.name,
            "tabs": list(self.tabs),
            "groups": [group.to_dict() for group in self.groups],
            "quickLinks": [link.to_dict() for link in self.quick_links],
            "separators": list(self.separators),
            "separatorsBefore": list(self.separators_before),
            "paneLayouts": [layout.to_dict() for layout in self.pane_layouts],
            "activeSession": self.active_session,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastActiveAt": self.last_active_at,
        }
        # Empty lists remain optional in schema 12 and are represented as empty
        # by both the API client and loader.
        if self.callback_sessions:
            payload["callbackSessions"] = list(self.callback_sessions)
        if include_internal:
            payload["inheritedPins"] = list(self.inherited_pins)
        return payload


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


class WorkspacePinCapacityError(ValueError):
    pass


class WorkspaceTransferConflictError(ValueError):
    pass


class WorkspaceResourceNotFoundError(LookupError):
    pass


class WorkspaceResourceConflictError(ValueError):
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
            self._pinned_sessions,
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

    def list_pinned_sessions(self) -> tuple[str, ...]:
        with self._lock:
            self._ensure_available()
            return self._pinned_sessions

    def set_session_workspace_pinned(
        self,
        session_name: str,
        pinned: bool,
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        if not isinstance(pinned, bool):
            raise TypeError("pinned must be a boolean")

        with self._lock:
            self._ensure_writable()
            currently_pinned = session_name in self._pinned_sessions
            if currently_pinned == pinned:
                return {
                    "session": session_name,
                    "workspacePinned": pinned,
                    "sessionRevision": self._session_rename_revision,
                }
            if self._session_rename_revision == MAX_SESSION_RENAME_REVISION:
                self._fence_writes("the session rename revision is exhausted")
                raise WorkspaceStoreUnavailable(WORKSPACE_STORE_UNAVAILABLE_MESSAGE)

            timestamp = self._timestamp()
            next_workspaces = self._workspaces.copy()
            if pinned:
                for workspace in self._workspaces.values():
                    if (
                        session_name not in workspace.tabs
                        and len(workspace.tabs) >= MAX_WORKSPACE_TABS
                    ):
                        raise WorkspacePinCapacityError(
                            f'cannot pin session "{session_name}": workspace '
                            f'"{workspace.name}" already has {MAX_WORKSPACE_TABS} sessions'
                        )
                next_pinned_sessions = (*self._pinned_sessions, session_name)
                for workspace_id, current in self._workspaces.items():
                    if session_name in current.tabs:
                        continue
                    next_workspaces[workspace_id] = replace(
                        current,
                        tabs=(*current.tabs, session_name),
                        inherited_pins=(*current.inherited_pins, session_name),
                        updated_at=max(timestamp, current.updated_at + 1),
                    )
            else:
                next_pinned_sessions = tuple(
                    item for item in self._pinned_sessions if item != session_name
                )
                for workspace_id, current in self._workspaces.items():
                    if session_name not in current.inherited_pins:
                        continue
                    tabs = tuple(tab for tab in current.tabs if tab != session_name)
                    active_session = current.active_session
                    if active_session == session_name:
                        active_session = tabs[0] if tabs else None
                    next_workspaces[workspace_id] = replace(
                        current,
                        tabs=tabs,
                        groups=_reconcile_workspace_groups(current.groups, tabs),
                        pane_layouts=_reconcile_workspace_pane_layouts(
                            current.pane_layouts, tabs
                        ),
                        separators=tuple(tab for tab in current.separators if tab in tabs),
                        separators_before=tuple(tab for tab in current.separators_before if tab in tabs),
                        inherited_pins=tuple(
                            item
                            for item in current.inherited_pins
                            if item != session_name
                        ),
                        active_session=active_session,
                        updated_at=max(timestamp, current.updated_at + 1),
                    )

            next_revision = self._session_rename_revision + 1
            self._commit(
                next_workspaces,
                next_revision,
                pinned_sessions=next_pinned_sessions,
            )
            return {
                "session": session_name,
                "workspacePinned": pinned,
                "sessionRevision": next_revision,
            }

    def transfer_session(
        self,
        session_name: str,
        *,
        destination_workspace_id: str,
        operation: str,
        session_revision: object,
        source_workspace_id: str | None = None,
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        destination_workspace_id = _validate_workspace_id(destination_workspace_id)
        if source_workspace_id is not None:
            source_workspace_id = _validate_workspace_id(source_workspace_id)
        if operation not in {"copy", "move"}:
            raise ValueError("operation must be copy or move")
        if source_workspace_id == destination_workspace_id:
            raise ValueError("destination workspace must differ from source workspace")
        validated_session_revision = _validate_session_revision(session_revision)

        with self._lock:
            self._ensure_writable()
            if validated_session_revision != self._session_rename_revision:
                raise WorkspaceSessionRevisionConflict(
                    self._session_rename_revision,
                    validated_session_revision,
                )

            destination = self._find(destination_workspace_id)
            source = (
                self._find(source_workspace_id)
                if source_workspace_id is not None
                else None
            )
            destination_already_contained = session_name in destination.tabs
            source_removed = bool(
                operation == "move"
                and source is not None
                and session_name in source.tabs
            )
            transfer_callback_marker = bool(
                source_removed
                and source is not None
                and session_name in source.callback_sessions
                and session_name not in destination.callback_sessions
            )
            if operation == "move" and session_name in self._pinned_sessions:
                raise WorkspaceTransferConflictError(
                    f'cannot move globally pinned session "{session_name}"; unpin it first'
                )
            if (
                not destination_already_contained
                and len(destination.tabs) >= MAX_WORKSPACE_TABS
            ):
                raise WorkspaceTransferConflictError(
                    f'cannot {operation} session "{session_name}": workspace '
                    f'"{destination.name}" already has {MAX_WORKSPACE_TABS} sessions'
                )
            if (
                transfer_callback_marker
                and len(destination.callback_sessions)
                >= MAX_WORKSPACE_CALLBACK_SESSIONS
            ):
                raise WorkspaceTransferConflictError(
                    f'cannot move session "{session_name}": workspace '
                    f'"{destination.name}" already has '
                    f'{MAX_WORKSPACE_CALLBACK_SESSIONS} callback sessions'
                )

            destination_added = not destination_already_contained
            if not source_removed and not destination_added:
                return {
                    "session": session_name,
                    "operation": operation,
                    "destinationAlreadyContained": destination_already_contained,
                    "destinationAdded": False,
                    "sourceRemoved": False,
                    "sourceWorkspace": self._workspace_dict(source) if source else None,
                    "destinationWorkspace": self._workspace_dict(destination),
                    "sessionRevision": self._session_rename_revision,
                }
            if self._session_rename_revision == MAX_SESSION_RENAME_REVISION:
                self._fence_writes("the session rename revision is exhausted")
                raise WorkspaceStoreUnavailable(WORKSPACE_STORE_UNAVAILABLE_MESSAGE)

            timestamp = self._timestamp()
            next_workspaces = self._workspaces.copy()
            if source_removed and source is not None:
                source_tabs = tuple(tab for tab in source.tabs if tab != session_name)
                source_active_session = source.active_session
                if source_active_session == session_name:
                    source_active_session = source_tabs[0] if source_tabs else None
                source_callback_sessions = tuple(
                    item for item in source.callback_sessions if item != session_name
                )
                next_workspaces[source.id] = replace(
                    source,
                    tabs=source_tabs,
                    groups=_reconcile_workspace_groups(source.groups, source_tabs),
                    pane_layouts=_reconcile_workspace_pane_layouts(
                        source.pane_layouts, source_tabs
                    ),
                    separators=tuple(tab for tab in source.separators if tab in source_tabs),
                    separators_before=tuple(tab for tab in source.separators_before if tab in source_tabs),
                    inherited_pins=tuple(
                        tab for tab in source.inherited_pins if tab != session_name
                    ),
                    callback_sessions=source_callback_sessions,
                    active_session=source_active_session,
                    updated_at=max(timestamp, source.updated_at + 1),
                )
            if destination_added or transfer_callback_marker:
                destination_callback_sessions = (
                    (*destination.callback_sessions, session_name)
                    if transfer_callback_marker
                    else destination.callback_sessions
                )
                next_workspaces[destination.id] = replace(
                    destination,
                    tabs=(
                        (*destination.tabs, session_name)
                        if destination_added
                        else destination.tabs
                    ),
                    callback_sessions=destination_callback_sessions,
                    updated_at=max(timestamp, destination.updated_at + 1),
                )

            next_revision = self._session_rename_revision + 1
            self._commit(next_workspaces, next_revision)
            return {
                "session": session_name,
                "operation": operation,
                "destinationAlreadyContained": destination_already_contained,
                "destinationAdded": destination_added,
                "sourceRemoved": source_removed,
                "sourceWorkspace": (
                    self._workspace_dict(next_workspaces[source.id]) if source else None
                ),
                "destinationWorkspace": self._workspace_dict(
                    next_workspaces[destination.id]
                ),
                "sessionRevision": next_revision,
            }

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
            return self._notes.common.first_content

    def get_common_notebook(self) -> dict[str, list[dict[str, str]]]:
        with self._lock:
            self._ensure_available()
            return self._notes.common.to_dict()

    def replace_common_note(self, note: object) -> str:
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            notebook = _replace_notebook_first_content(
                self._notes.common,
                validated_note,
            )
            self._commit(
                self._workspaces,
                notes=replace(self._notes, common=notebook),
            )
            return self._notes.common.first_content

    def replace_common_notebook(
        self,
        notebook: object,
    ) -> dict[str, list[dict[str, str]]]:
        validated_notebook = validate_scoped_note_notebook(notebook)
        with self._lock:
            self._ensure_writable()
            self._commit(
                self._workspaces,
                notes=replace(self._notes, common=validated_notebook),
            )
            return self._notes.common.to_dict()

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
            return self._notes.sessions.get(
                session_name,
                default_scoped_note_notebook(),
            ).first_content

    def get_session_notebook(
        self,
        session_name: str,
    ) -> dict[str, list[dict[str, str]]]:
        session_name = validate_session_name(session_name)
        with self._lock:
            self._ensure_available()
            return self._notes.sessions.get(
                session_name,
                default_scoped_note_notebook(),
            ).to_dict()

    def replace_session_note(self, session_name: str, note: object) -> str:
        session_name = validate_session_name(session_name)
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            next_session_notes = self._notes.sessions.copy()
            notebook = _replace_notebook_first_content(
                next_session_notes.get(session_name, default_scoped_note_notebook()),
                validated_note,
            )
            if not _is_default_scoped_note_notebook(notebook):
                next_session_notes[session_name] = notebook
            else:
                next_session_notes.pop(session_name, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, sessions=next_session_notes),
            )
            return self.get_session_note(session_name)

    def replace_session_notebook(
        self,
        session_name: str,
        notebook: object,
    ) -> dict[str, list[dict[str, str]]]:
        session_name = validate_session_name(session_name)
        validated_notebook = validate_scoped_note_notebook(notebook)
        with self._lock:
            self._ensure_writable()
            next_session_notebooks = self._notes.sessions.copy()
            if not _is_default_scoped_note_notebook(validated_notebook):
                next_session_notebooks[session_name] = validated_notebook
            else:
                next_session_notebooks.pop(session_name, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, sessions=next_session_notebooks),
            )
            return self.get_session_notebook(session_name)

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
            return self._notes.workspaces.get(
                workspace_id,
                default_scoped_note_notebook(),
            ).first_content

    def get_workspace_notebook(
        self,
        workspace_id: str,
    ) -> dict[str, list[dict[str, str]]]:
        workspace_id = _validate_workspace_id(workspace_id)
        with self._lock:
            self._ensure_available()
            self._find(workspace_id)
            return self._notes.workspaces.get(
                workspace_id,
                default_scoped_note_notebook(),
            ).to_dict()

    def replace_workspace_note(self, workspace_id: str, note: object) -> str:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_note = normalize_scoped_note(note)
        with self._lock:
            self._ensure_writable()
            self._find(workspace_id)
            next_workspace_notes = self._notes.workspaces.copy()
            notebook = _replace_notebook_first_content(
                next_workspace_notes.get(workspace_id, default_scoped_note_notebook()),
                validated_note,
            )
            if not _is_default_scoped_note_notebook(notebook):
                next_workspace_notes[workspace_id] = notebook
            else:
                next_workspace_notes.pop(workspace_id, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, workspaces=next_workspace_notes),
            )
            return self.get_workspace_note(workspace_id)

    def replace_workspace_notebook(
        self,
        workspace_id: str,
        notebook: object,
    ) -> dict[str, list[dict[str, str]]]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_notebook = validate_scoped_note_notebook(notebook)
        with self._lock:
            self._ensure_writable()
            self._find(workspace_id)
            next_workspace_notebooks = self._notes.workspaces.copy()
            if not _is_default_scoped_note_notebook(validated_notebook):
                next_workspace_notebooks[workspace_id] = validated_notebook
            else:
                next_workspace_notebooks.pop(workspace_id, None)
            self._commit(
                self._workspaces,
                notes=replace(self._notes, workspaces=next_workspace_notebooks),
            )
            return self.get_workspace_notebook(workspace_id)

    def create_workspace(
        self,
        *,
        name: object,
        tabs: object,
        active_session: object,
        groups: object = _GROUPS_OMITTED,
        quick_links: object = _QUICK_LINKS_OMITTED,
        separators: object = _SEPARATORS_OMITTED,
        separators_before: object = _SEPARATORS_OMITTED,
        pane_layouts: object = _PANE_LAYOUTS_OMITTED,
        callback_sessions: object = _CALLBACK_SESSIONS_OMITTED,
    ) -> dict[str, Any]:
        normalized_name = normalize_workspace_name(name)
        validated_tabs = validate_workspace_tabs(tabs)
        validated_separators = validate_workspace_separators(
            [] if separators is _SEPARATORS_OMITTED else separators, validated_tabs
        )
        validated_separators_before = validate_workspace_separators(
            [] if separators_before is _SEPARATORS_OMITTED else separators_before,
            validated_tabs,
        )
        validated_groups = validate_workspace_groups(
            [] if groups is _GROUPS_OMITTED else groups,
            validated_tabs,
        )
        validated_quick_links = validate_workspace_quick_links(
            [] if quick_links is _QUICK_LINKS_OMITTED else quick_links,
        )
        validated_pane_layouts = validate_workspace_pane_layouts(
            [] if pane_layouts is _PANE_LAYOUTS_OMITTED else pane_layouts,
            validated_tabs,
        )
        validated_callback_sessions = validate_workspace_callback_sessions(
            [] if callback_sessions is _CALLBACK_SESSIONS_OMITTED else callback_sessions,
        )
        with self._lock:
            self._ensure_writable()
            merged_tabs, inherited_pins = self._merge_pinned_sessions(validated_tabs)
            validated_active_session = validate_active_session(
                active_session, merged_tabs
            )
            workspace_id = self._new_id()
            timestamp = self._timestamp()
            workspace = SavedWorkspace(
                id=workspace_id,
                name=normalized_name,
                tabs=merged_tabs,
                groups=validated_groups,
                quick_links=validated_quick_links,
                separators=validated_separators,
                separators_before=validated_separators_before,
                pane_layouts=validated_pane_layouts,
                callback_sessions=validated_callback_sessions,
                inherited_pins=inherited_pins,
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
        separators: object = None,
        update_separators: bool = False,
        separators_before: object = None,
        update_separators_before: bool = False,
        pane_layouts: object = None,
        update_pane_layouts: bool = False,
        callback_sessions: object = None,
        update_callback_sessions: bool = False,
        session_revision: object = None,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        normalized_name = normalize_workspace_name(name) if update_name else None
        validated_tabs = validate_workspace_tabs(tabs) if update_tabs else None
        validated_callback_sessions = (
            validate_workspace_callback_sessions(callback_sessions)
            if update_callback_sessions else None
        )
        validated_session_revision = (
            _validate_session_revision(session_revision)
            if (
                update_tabs
                or update_groups
                or update_active_session
                or update_separators
                or update_separators_before
                or update_pane_layouts
                or update_callback_sessions
            )
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
            if validated_tabs is not None:
                next_tabs, next_inherited_pins = self._merge_pinned_sessions(
                    validated_tabs,
                    current.inherited_pins,
                )
            else:
                next_tabs = current.tabs
                next_inherited_pins = current.inherited_pins
            next_groups = (
                validate_workspace_groups(groups, next_tabs)
                if update_groups
                else _reconcile_workspace_groups(current.groups, next_tabs)
                if update_tabs
                else current.groups
            )
            next_pane_layouts = (
                validate_workspace_pane_layouts(pane_layouts, next_tabs)
                if update_pane_layouts
                else _reconcile_workspace_pane_layouts(
                    current.pane_layouts, next_tabs
                )
                if update_tabs
                else current.pane_layouts
            )
            if update_callback_sessions:
                assert validated_callback_sessions is not None
                next_callback_sessions = validated_callback_sessions
            else:
                next_callback_sessions = current.callback_sessions
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
                pane_layouts=next_pane_layouts,
                callback_sessions=next_callback_sessions,
                separators=(
                    validate_workspace_separators(separators, next_tabs)
                    if update_separators
                    else tuple(tab for tab in current.separators if tab in next_tabs)
                ),
                separators_before=(
                    validate_workspace_separators(separators_before, next_tabs)
                    if update_separators_before
                    else tuple(tab for tab in current.separators_before if tab in next_tabs)
                ),
                inherited_pins=next_inherited_pins,
                active_session=next_active_session,
                updated_at=timestamp,
            )
            next_workspaces = {**self._workspaces, workspace_id: workspace}
            self._commit(next_workspaces)
            return self._workspace_dict(workspace)

    def add_workspace_sessions(
        self,
        workspace_id: str,
        *,
        sessions: object,
        session_revision: object,
        position: object = "end",
        relative_to: object = None,
        active_session: object = _ACTIVE_SESSION_OMITTED,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_sessions = validate_workspace_tabs(sessions)
        validated_revision = _validate_session_revision(session_revision)
        if position not in {"start", "end", "before", "after"}:
            raise ValueError("position must be start, end, before, or after")
        if position in {"before", "after"}:
            if not isinstance(relative_to, str):
                raise TypeError("relativeTo must be a string for before or after")
            relative_to = validate_session_name(relative_to)
        elif relative_to is not None:
            raise ValueError("relativeTo is only valid with before or after")

        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            if relative_to is not None and relative_to not in current.tabs:
                raise WorkspaceResourceNotFoundError(
                    f"workspace session not found: {relative_to}"
                )

            existing = set(current.tabs)
            added = tuple(item for item in validated_sessions if item not in existing)
            if len(current.tabs) + len(added) > MAX_WORKSPACE_TABS:
                raise WorkspaceResourceConflictError(
                    f"workspace tabs cannot contain more than {MAX_WORKSPACE_TABS} sessions"
                )
            if position == "start":
                insertion_index = 0
            elif position == "end":
                insertion_index = len(current.tabs)
            else:
                assert isinstance(relative_to, str)
                insertion_index = current.tabs.index(relative_to)
                if position == "after":
                    insertion_index += 1
            next_tabs = (
                current.tabs[:insertion_index]
                + added
                + current.tabs[insertion_index:]
            )
            update_active = active_session is not _ACTIVE_SESSION_OMITTED
            if not added and not update_active:
                workspace = self._workspace_dict(current)
            else:
                workspace = self.update_workspace(
                    workspace_id,
                    tabs=list(next_tabs),
                    update_tabs=True,
                    active_session=(
                        active_session if update_active else current.active_session
                    ),
                    update_active_session=True,
                    session_revision=validated_revision,
                )
            return {"added": list(added), "workspace": workspace}

    def replace_workspace_sessions(
        self,
        workspace_id: str,
        *,
        sessions: object,
        session_revision: object,
        active_session: object = _ACTIVE_SESSION_OMITTED,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_sessions = validate_workspace_tabs(sessions)
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            missing_pins = [
                item for item in self._pinned_sessions if item not in validated_sessions
            ]
            if missing_pins:
                raise WorkspaceResourceConflictError(
                    f'cannot remove globally pinned session "{missing_pins[0]}"; '
                    "unpin it first"
                )
            next_active: object
            if active_session is _ACTIVE_SESSION_OMITTED:
                next_active = (
                    current.active_session
                    if current.active_session in validated_sessions
                    else validated_sessions[0]
                    if validated_sessions
                    else None
                )
            else:
                next_active = active_session
            workspace = self.update_workspace(
                workspace_id,
                tabs=list(validated_sessions),
                update_tabs=True,
                active_session=next_active,
                update_active_session=True,
                session_revision=validated_revision,
            )
            return {"workspace": workspace}

    def remove_workspace_sessions(
        self,
        workspace_id: str,
        *,
        sessions: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_sessions = validate_workspace_tabs(sessions)
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            current_set = set(current.tabs)
            removed = tuple(item for item in validated_sessions if item in current_set)
            pinned_removed = [
                item for item in removed if item in self._pinned_sessions
            ]
            if pinned_removed:
                raise WorkspaceResourceConflictError(
                    f'cannot remove globally pinned session "{pinned_removed[0]}"; '
                    "unpin it first"
                )
            if not removed:
                return {"removed": [], "workspace": self._workspace_dict(current)}
            removed_set = set(removed)
            next_tabs = tuple(item for item in current.tabs if item not in removed_set)
            next_active = (
                current.active_session
                if current.active_session in next_tabs
                else next_tabs[0]
                if next_tabs
                else None
            )
            workspace = self.update_workspace(
                workspace_id,
                tabs=list(next_tabs),
                update_tabs=True,
                active_session=next_active,
                update_active_session=True,
                session_revision=validated_revision,
            )
            return {"removed": list(removed), "workspace": workspace}

    def add_workspace_callback_sessions(
        self,
        workspace_id: str,
        *,
        sessions: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_sessions = validate_workspace_callback_sessions(sessions, "sessions")
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            existing = set(current.callback_sessions)
            added = tuple(item for item in validated_sessions if item not in existing)
            next_sessions = (*current.callback_sessions, *added)
            if len(next_sessions) > MAX_WORKSPACE_CALLBACK_SESSIONS:
                raise WorkspaceResourceConflictError(
                    "callback sessions cannot contain more than "
                    f"{MAX_WORKSPACE_CALLBACK_SESSIONS} sessions"
                )
            if not added:
                workspace = self._workspace_dict(current)
            else:
                workspace = self.update_workspace(
                    workspace_id,
                    callback_sessions=list(next_sessions),
                    update_callback_sessions=True,
                    session_revision=validated_revision,
                )
            return {"added": list(added), "workspace": workspace}

    def remove_workspace_callback_sessions(
        self,
        workspace_id: str,
        *,
        sessions: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_sessions = validate_workspace_callback_sessions(sessions, "sessions")
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            requested = set(validated_sessions)
            removed = tuple(
                item for item in current.callback_sessions if item in requested
            )
            if not removed:
                return {"removed": [], "workspace": self._workspace_dict(current)}
            next_sessions = tuple(
                item for item in current.callback_sessions if item not in requested
            )
            workspace = self.update_workspace(
                workspace_id,
                callback_sessions=list(next_sessions),
                update_callback_sessions=True,
                session_revision=validated_revision,
            )
            return {"removed": list(removed), "workspace": workspace}

    def create_workspace_group(
        self,
        workspace_id: str,
        *,
        group: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            candidate = validate_workspace_groups([group], current.tabs)[0]
            if any(item.id == candidate.id for item in current.groups):
                raise WorkspaceResourceConflictError(
                    f"workspace group already exists: {candidate.id}"
                )
            positions = {tab: index for index, tab in enumerate(current.tabs)}
            next_groups = sorted(
                (*current.groups, candidate),
                key=lambda item: positions[item.tabs[0]],
            )
            workspace = self.update_workspace(
                workspace_id,
                groups=[item.to_dict() for item in next_groups],
                update_groups=True,
                session_revision=validated_revision,
            )
            created = next(
                item for item in workspace["groups"] if item["id"] == candidate.id
            )
            return {"group": created, "workspace": workspace}

    def update_workspace_group(
        self,
        workspace_id: str,
        group_id: str,
        *,
        changes: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        group_id = _validate_workspace_group_id(group_id, "group id")
        validated_revision = _validate_session_revision(session_revision)
        if not isinstance(changes, dict):
            raise TypeError("group changes must be an object")
        unknown = sorted(str(item) for item in set(changes) - {"name", "color", "collapsed", "tabs"})
        if unknown:
            raise ValueError(f"group changes has unknown field: {unknown[0]}")
        if not changes:
            raise ValueError("at least one group field is required")
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            matched = next((item for item in current.groups if item.id == group_id), None)
            if matched is None:
                raise WorkspaceResourceNotFoundError(
                    f"workspace group not found: {group_id}"
                )
            candidate_payload = {**matched.to_dict(), **changes}
            candidate = validate_workspace_groups([candidate_payload], current.tabs)[0]
            positions = {tab: index for index, tab in enumerate(current.tabs)}
            next_groups = [
                candidate if item.id == group_id else item for item in current.groups
            ]
            next_groups.sort(key=lambda item: positions[item.tabs[0]])
            workspace = self.update_workspace(
                workspace_id,
                groups=[item.to_dict() for item in next_groups],
                update_groups=True,
                session_revision=validated_revision,
            )
            updated = next(
                item for item in workspace["groups"] if item["id"] == group_id
            )
            return {"group": updated, "workspace": workspace}

    def delete_workspace_group(
        self,
        workspace_id: str,
        group_id: str,
        *,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        group_id = _validate_workspace_group_id(group_id, "group id")
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            if not any(item.id == group_id for item in current.groups):
                raise WorkspaceResourceNotFoundError(
                    f"workspace group not found: {group_id}"
                )
            next_groups = [
                item.to_dict() for item in current.groups if item.id != group_id
            ]
            workspace = self.update_workspace(
                workspace_id,
                groups=next_groups,
                update_groups=True,
                session_revision=validated_revision,
            )
            return {"workspace": workspace}

    def create_workspace_pane_layout(
        self,
        workspace_id: str,
        *,
        layout: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            candidate = validate_workspace_pane_layouts([layout], current.tabs)[0]
            if any(item.id == candidate.id for item in current.pane_layouts):
                raise WorkspaceResourceConflictError(
                    f"workspace pane layout already exists: {candidate.id}"
                )
            next_layouts = (*current.pane_layouts, candidate)
            workspace = self.update_workspace(
                workspace_id,
                pane_layouts=[item.to_dict() for item in next_layouts],
                update_pane_layouts=True,
                session_revision=validated_revision,
            )
            return {
                "paneLayout": candidate.to_dict(),
                "workspace": workspace,
            }

    def update_workspace_pane_layout(
        self,
        workspace_id: str,
        layout_id: str,
        *,
        changes: object,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        layout_id = _validate_workspace_group_id(layout_id, "pane layout id")
        validated_revision = _validate_session_revision(session_revision)
        if not isinstance(changes, dict):
            raise TypeError("pane layout changes must be an object")
        unknown = sorted(str(item) for item in set(changes) - {"name", "root"})
        if unknown:
            raise ValueError(f"pane layout changes has unknown field: {unknown[0]}")
        if not changes:
            raise ValueError("name or root is required")
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            matched = next(
                (item for item in current.pane_layouts if item.id == layout_id), None
            )
            if matched is None:
                raise WorkspaceResourceNotFoundError(
                    f"workspace pane layout not found: {layout_id}"
                )
            candidate = validate_workspace_pane_layouts(
                [{**matched.to_dict(), **changes}], current.tabs
            )[0]
            next_layouts = [
                candidate if item.id == layout_id else item
                for item in current.pane_layouts
            ]
            workspace = self.update_workspace(
                workspace_id,
                pane_layouts=[item.to_dict() for item in next_layouts],
                update_pane_layouts=True,
                session_revision=validated_revision,
            )
            return {
                "paneLayout": candidate.to_dict(),
                "workspace": workspace,
            }

    def delete_workspace_pane_layout(
        self,
        workspace_id: str,
        layout_id: str,
        *,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        layout_id = _validate_workspace_group_id(layout_id, "pane layout id")
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            if not any(item.id == layout_id for item in current.pane_layouts):
                raise WorkspaceResourceNotFoundError(
                    f"workspace pane layout not found: {layout_id}"
                )
            next_layouts = [
                item.to_dict()
                for item in current.pane_layouts
                if item.id != layout_id
            ]
            workspace = self.update_workspace(
                workspace_id,
                pane_layouts=next_layouts,
                update_pane_layouts=True,
                session_revision=validated_revision,
            )
            return {"workspace": workspace}

    def set_workspace_separator(
        self,
        workspace_id: str,
        *,
        session: object,
        placement: object,
        present: bool,
        session_revision: object,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        if not isinstance(session, str):
            raise TypeError("session must be a string")
        session = validate_session_name(session)
        if placement not in {"before", "after", "both"}:
            raise ValueError("placement must be before, after, or both")
        if present and placement == "both":
            raise ValueError("placement cannot be both when adding a separator")
        validated_revision = _validate_session_revision(session_revision)
        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            self._check_session_revision(validated_revision)
            if session not in current.tabs:
                raise WorkspaceResourceNotFoundError(
                    f"workspace session not found: {session}"
                )
            after = list(current.separators)
            before = list(current.separators_before)
            if present:
                target = before if placement == "before" else after
                other = after if placement == "before" else before
                if session not in target:
                    target.append(session)
                if session in other:
                    other.remove(session)
            else:
                if placement in {"after", "both"} and session in after:
                    after.remove(session)
                if placement in {"before", "both"} and session in before:
                    before.remove(session)
            workspace = self.update_workspace(
                workspace_id,
                separators=after,
                update_separators=True,
                separators_before=before,
                update_separators_before=True,
                session_revision=validated_revision,
            )
            return {
                "separators": {
                    "before": workspace["separatorsBefore"],
                    "after": workspace["separators"],
                },
                "workspace": workspace,
            }

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
        validated_session_revision = _validate_session_revision(session_revision)

        with self._lock:
            self._ensure_writable()
            current = self._find(workspace_id)
            if validated_session_revision != self._session_rename_revision:
                raise WorkspaceSessionRevisionConflict(
                    self._session_rename_revision, validated_session_revision
                )
            merged_tabs, inherited_pins = self._merge_pinned_sessions(
                validated_tabs,
                current.inherited_pins,
            )
            validated_active_session = validate_active_session(
                active_session, merged_tabs
            )
            validated_groups = (
                validate_workspace_groups(groups, merged_tabs)
                if update_groups
                else _reconcile_workspace_groups(current.groups, merged_tabs)
            )
            timestamp = max(
                self._timestamp(),
                current.updated_at + 1,
                current.last_active_at + 1,
            )
            workspace = replace(
                current,
                tabs=merged_tabs,
                groups=validated_groups,
                pane_layouts=_reconcile_workspace_pane_layouts(
                    current.pane_layouts, merged_tabs
                ),
                inherited_pins=inherited_pins,
                separators=tuple(tab for tab in current.separators if tab in merged_tabs),
                separators_before=tuple(tab for tab in current.separators_before if tab in merged_tabs),
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
                if (
                    current_name not in current.tabs
                    and current_name not in current.callback_sessions
                ):
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
                inherited_pins = tuple(
                    dict.fromkeys(
                        new_name if item == current_name else item
                        for item in current.inherited_pins
                        if item == current_name
                        or item != new_name
                        or current_name not in current.tabs
                    )
                )
                callback_sessions = tuple(
                    dict.fromkeys(
                        new_name if item == current_name else item
                        for item in current.callback_sessions
                        if item == current_name or item != new_name
                    )
                )
                workspace = replace(
                    current,
                    tabs=renamed_tabs,
                    groups=groups,
                    pane_layouts=_rename_workspace_pane_layouts(
                        current.pane_layouts, current_name, new_name
                    ),
                    separators=tuple(dict.fromkeys(
                        new_name if tab == current_name else tab
                        for tab in current.separators
                        if tab == current_name or tab != new_name
                    )),
                    separators_before=tuple(dict.fromkeys(
                        new_name if tab == current_name else tab
                        for tab in current.separators_before
                        if tab == current_name or tab != new_name
                    )),
                    inherited_pins=tuple(
                        item for item in inherited_pins if item in renamed_tabs
                    ),
                    callback_sessions=callback_sessions,
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
            renamed_note = next_session_notes.pop(current_name, None)
            next_session_notes.pop(new_name, None)
            if renamed_note is not None:
                next_session_notes[new_name] = renamed_note

            next_pinned_sessions = tuple(
                dict.fromkeys(
                    new_name if item == current_name else item
                    for item in self._pinned_sessions
                    if item == current_name or item != new_name
                )
            )

            try:
                self._commit(
                    next_workspaces,
                    self._session_rename_revision + 1,
                    session_quick_links=next_session_quick_links,
                    notes=replace(self._notes, sessions=next_session_notes),
                    pinned_sessions=next_pinned_sessions,
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

    def _check_session_revision(self, received: int) -> None:
        if received != self._session_rename_revision:
            raise WorkspaceSessionRevisionConflict(
                self._session_rename_revision,
                received,
            )

    def _merge_pinned_sessions(
        self,
        tabs: tuple[str, ...],
        inherited_pins: tuple[str, ...] = (),
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        merged = list(tabs)
        merged_set = set(merged)
        inherited = [
            session_name
            for session_name in inherited_pins
            if session_name in self._pinned_sessions
        ]
        inherited_set = set(inherited)
        for session_name in self._pinned_sessions:
            if session_name in merged_set:
                continue
            if len(merged) >= MAX_WORKSPACE_TABS:
                raise WorkspacePinCapacityError(
                    "workspace tabs plus globally pinned sessions cannot contain "
                    f"more than {MAX_WORKSPACE_TABS} sessions"
                )
            merged.append(session_name)
            merged_set.add(session_name)
            if session_name not in inherited_set:
                inherited.append(session_name)
                inherited_set.add(session_name)
        return tuple(merged), tuple(inherited)

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
        tuple[str, ...],
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
            if version >= 12:
                legacy_workspace_notes = validate_workspace_notes(
                    payload.get("workspaceNotes", {})
                )
                legacy_session_notes = validate_session_notes(
                    payload.get("sessionNotes", {})
                )
                notes = ScopedNotes(
                    common=(
                        validate_scoped_note_notebook(
                            payload["commonNotebook"],
                            "commonNotebook",
                        )
                        if "commonNotebook" in payload
                        else _scoped_note_notebook_from_legacy(
                            payload.get("commonNote", ""),
                            "commonNote",
                        )
                    ),
                    workspaces=(
                        validate_workspace_notebooks(
                            payload["workspaceNotebooks"]
                        )
                        if "workspaceNotebooks" in payload
                        else {
                            workspace_id: default_scoped_note_notebook(note)
                            for workspace_id, note in legacy_workspace_notes.items()
                        }
                    ),
                    sessions=(
                        validate_session_notebooks(payload["sessionNotebooks"])
                        if "sessionNotebooks" in payload
                        else {
                            session_name: default_scoped_note_notebook(note)
                            for session_name, note in legacy_session_notes.items()
                        }
                    ),
                )
            elif version >= 6:
                notes = ScopedNotes(
                    common=_scoped_note_notebook_from_legacy(
                        payload.get("commonNote"),
                        "commonNote",
                    ),
                    workspaces={
                        workspace_id: default_scoped_note_notebook(note)
                        for workspace_id, note in validate_workspace_notes(
                            payload.get("workspaceNotes")
                        ).items()
                    },
                    sessions={
                        session_name: default_scoped_note_notebook(note)
                        for session_name, note in validate_session_notes(
                            payload.get("sessionNotes")
                        ).items()
                    },
                )
            else:
                notes = ScopedNotes(
                    common=default_scoped_note_notebook(),
                    workspaces={},
                    sessions={},
                )
            pinned_sessions = (
                _validate_pinned_session_names(
                    payload.get("pinnedSessions"),
                    "pinnedSessions",
                )
                if version >= 7
                else ()
            )
            records = payload.get("workspaces")
            if not isinstance(records, list):
                raise TypeError("workspaces must be an array")

            workspaces: dict[str, SavedWorkspace] = {}
            for index, record in enumerate(records):
                workspace = self._load_workspace(
                    record,
                    index,
                    version,
                    pinned_sessions,
                )
                if workspace.id in workspaces:
                    raise ValueError(f"duplicate workspace id: {workspace.id}")
                workspaces[workspace.id] = workspace
            return (
                workspaces,
                session_rename_revision,
                common_quick_links,
                session_quick_links,
                notes,
                pinned_sessions,
            )
        except FileNotFoundError as error:
            if not self.path.is_symlink():
                return (
                    {},
                    0,
                    (),
                    {},
                    ScopedNotes(
                        common=default_scoped_note_notebook(),
                        workspaces={},
                        sessions={},
                    ),
                    (),
                )
            self._record_load_error(error)
        except (OSError, TypeError, ValueError, RecursionError) as error:
            self._record_load_error(error)
        return (
            {},
            0,
            (),
            {},
            ScopedNotes(
                common=default_scoped_note_notebook(),
                workspaces={},
                sessions={},
            ),
            (),
        )

    @staticmethod
    def _load_workspace(
        record: object,
        index: int,
        version: int,
        pinned_sessions: tuple[str, ...],
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
        if version >= 7:
            expected.add("inheritedPins")
        if version >= 8:
            expected.add("separators")
        if version >= 9:
            expected.add("separatorsBefore")
        if version >= 10:
            expected.add("paneLayouts")
        if version >= 11:
            expected.add("callbackSessions")
        optional = {"callbackSessions"} if version >= 11 else set()
        missing = sorted((expected - optional) - set(record))
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
        inherited_pins = (
            _validate_pinned_session_names(
                record["inheritedPins"],
                f"{path}.inheritedPins",
            )
            if version >= 7
            else ()
        )
        if any(session_name not in tabs for session_name in inherited_pins):
            raise ValueError(f"{path}.inheritedPins must be workspace tabs")
        if any(session_name not in pinned_sessions for session_name in inherited_pins):
            raise ValueError(
                f"{path}.inheritedPins must be globally pinned sessions"
            )
        if any(session_name not in tabs for session_name in pinned_sessions):
            raise ValueError(f"{path}.tabs must include every globally pinned session")
        active_session = validate_active_session(record["activeSession"], tabs)
        callback_sessions = (
            validate_workspace_callback_sessions(record.get("callbackSessions", []))
            if version >= 11 else ()
        )
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
            inherited_pins=inherited_pins,
            active_session=active_session,
            created_at=created_at,
            updated_at=updated_at,
            last_active_at=last_active_at,
            separators=(
                validate_workspace_separators(record["separators"], tabs)
                if version >= 8 else ()
            ),
            separators_before=(
                validate_workspace_separators(record["separatorsBefore"], tabs)
                if version >= 9 else ()
            ),
            pane_layouts=(
                validate_workspace_pane_layouts(record["paneLayouts"], tabs)
                if version >= 10 else ()
            ),
            callback_sessions=callback_sessions,
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
        pinned_sessions: tuple[str, ...] | None = None,
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
        next_pinned_sessions = (
            self._pinned_sessions if pinned_sessions is None else pinned_sessions
        )
        try:
            self._persist(
                workspaces,
                next_revision,
                next_common_quick_links,
                next_session_quick_links,
                next_notes,
                next_pinned_sessions,
            )
        except _WorkspaceDirectorySyncError:
            # The atomic rename committed; keep memory consistent with disk even
            # though the caller must be told durability could not be confirmed.
            self._workspaces = workspaces
            self._session_rename_revision = next_revision
            self._common_quick_links = next_common_quick_links
            self._session_quick_links = next_session_quick_links
            self._notes = next_notes
            self._pinned_sessions = next_pinned_sessions
            if next_revision == MAX_SESSION_RENAME_REVISION:
                self._fence_writes("the session rename revision is exhausted")
            raise
        self._workspaces = workspaces
        self._session_rename_revision = next_revision
        self._common_quick_links = next_common_quick_links
        self._session_quick_links = next_session_quick_links
        self._notes = next_notes
        self._pinned_sessions = next_pinned_sessions
        if next_revision == MAX_SESSION_RENAME_REVISION:
            self._fence_writes("the session rename revision is exhausted")

    def _persist(
        self,
        workspaces: dict[str, SavedWorkspace],
        session_rename_revision: int,
        common_quick_links: tuple[WorkspaceQuickLink, ...],
        session_quick_links: dict[str, tuple[WorkspaceQuickLink, ...]],
        notes: ScopedNotes,
        pinned_sessions: tuple[str, ...],
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
                        # Scalar fields keep pre-notebook clients and operational
                        # inspection tools useful during a rolling deployment.
                        "commonNote": notes.common.first_content,
                        "workspaceNotes": {
                            workspace_id: notebook.first_content
                            for workspace_id, notebook in notes.workspaces.items()
                            if notebook.first_content
                        },
                        "sessionNotes": {
                            session_name: notebook.first_content
                            for session_name, notebook in notes.sessions.items()
                            if notebook.first_content
                        },
                        "commonNotebook": notes.common.to_dict(),
                        "workspaceNotebooks": {
                            workspace_id: notebook.to_dict()
                            for workspace_id, notebook in notes.workspaces.items()
                        },
                        "sessionNotebooks": {
                            session_name: notebook.to_dict()
                            for session_name, notebook in notes.sessions.items()
                        },
                        "pinnedSessions": list(pinned_sessions),
                        "workspaces": [
                            workspace.to_dict(include_internal=True)
                            for workspace in workspaces.values()
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
