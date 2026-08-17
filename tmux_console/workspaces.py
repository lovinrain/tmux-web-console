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

from .messages import validate_session_name

LOGGER = logging.getLogger("muxdeck.workspaces")
MAX_WORKSPACE_ID_LENGTH = 128
MAX_WORKSPACE_NAME_LENGTH = 80
MAX_WORKSPACE_TABS = 32
MAX_SESSION_RENAME_REVISION = (1 << 53) - 1
WORKSPACE_SCHEMA_VERSION = 2
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
class SavedWorkspace:
    id: str
    name: str
    tabs: tuple[str, ...]
    active_session: str | None
    created_at: int
    updated_at: int
    last_active_at: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "tabs": list(self.tabs),
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
        self._workspaces, self._session_rename_revision = self._load()
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

    def create_workspace(
        self,
        *,
        name: object,
        tabs: object,
        active_session: object,
    ) -> dict[str, Any]:
        normalized_name = normalize_workspace_name(name)
        validated_tabs = validate_workspace_tabs(tabs)
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
        active_session: object = None,
        update_name: bool = False,
        update_tabs: bool = False,
        update_active_session: bool = False,
        session_revision: object = None,
    ) -> dict[str, Any]:
        workspace_id = _validate_workspace_id(workspace_id)
        normalized_name = normalize_workspace_name(name) if update_name else None
        validated_tabs = validate_workspace_tabs(tabs) if update_tabs else None
        validated_session_revision = (
            _validate_session_revision(session_revision)
            if update_tabs or update_active_session
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
            timestamp = max(
                self._timestamp(),
                current.updated_at + 1,
                current.last_active_at + 1,
            )
            workspace = replace(
                current,
                tabs=validated_tabs,
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
            self._commit(next_workspaces)

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
                        new_name if tab == current_name else tab for tab in current.tabs
                    )
                )
                active_session = (
                    new_name
                    if current.active_session == current_name
                    else current.active_session
                )
                workspace = replace(
                    current,
                    tabs=renamed_tabs,
                    active_session=active_session,
                    updated_at=max(timestamp, current.updated_at + 1),
                )
                next_workspaces[workspace_id] = workspace
                changed += 1

            try:
                self._commit(next_workspaces, self._session_rename_revision + 1)
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

    def _load(self) -> tuple[dict[str, SavedWorkspace], int]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("document must be an object")
            version = payload.get("version")
            if (
                isinstance(version, bool)
                or version not in (1, WORKSPACE_SCHEMA_VERSION)
            ):
                raise ValueError("unsupported document version")
            session_rename_revision = (
                _validate_session_revision(payload.get("sessionRenameRevision"))
                if version >= 2
                else 0
            )
            records = payload.get("workspaces")
            if not isinstance(records, list):
                raise TypeError("workspaces must be an array")

            workspaces: dict[str, SavedWorkspace] = {}
            for index, record in enumerate(records):
                workspace = self._load_workspace(record, index)
                if workspace.id in workspaces:
                    raise ValueError(f"duplicate workspace id: {workspace.id}")
                workspaces[workspace.id] = workspace
            return workspaces, session_rename_revision
        except FileNotFoundError as error:
            if not self.path.is_symlink():
                return {}, 0
            self._record_load_error(error)
        except (OSError, TypeError, ValueError, RecursionError) as error:
            self._record_load_error(error)
        return {}, 0

    @staticmethod
    def _load_workspace(record: object, index: int) -> SavedWorkspace:
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
        missing = sorted(expected - set(record))
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(field) for field in set(record) - expected)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")

        workspace_id = _validate_workspace_id(record["id"])
        name = normalize_workspace_name(record["name"])
        tabs = validate_workspace_tabs(record["tabs"])
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
    ) -> None:
        next_revision = (
            self._session_rename_revision
            if session_rename_revision is None
            else session_rename_revision
        )
        try:
            self._persist(workspaces, next_revision)
        except _WorkspaceDirectorySyncError:
            # The atomic rename committed; keep memory consistent with disk even
            # though the caller must be told durability could not be confirmed.
            self._workspaces = workspaces
            self._session_rename_revision = next_revision
            if next_revision == MAX_SESSION_RENAME_REVISION:
                self._fence_writes("the session rename revision is exhausted")
            raise
        self._workspaces = workspaces
        self._session_rename_revision = next_revision
        if next_revision == MAX_SESSION_RENAME_REVISION:
            self._fence_writes("the session rename revision is exhausted")

    def _persist(
        self,
        workspaces: dict[str, SavedWorkspace],
        session_rename_revision: int,
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
