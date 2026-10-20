"""Lightweight, non-destructive placeholders for sibling session branches."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, replace
from typing import Any

MAX_WORKSPACE_FOLDS = 128


@dataclass(frozen=True)
class FoldSessionSnapshot:
    name: str
    historyId: str
    directory: str
    title: str | None
    agentType: str | None
    agentSessionId: str | None
    sessionId: str
    sessionCreated: int
    serverStarted: int
    serverPid: int
    savedAt: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate_fold_snapshot(value: object) -> FoldSessionSnapshot:
    if not isinstance(value, dict) or set(value) != set(FoldSessionSnapshot.__dataclass_fields__):
        raise ValueError("closedSessions entries must contain complete recovery metadata")
    for field, limit in (("name", 256), ("directory", 4096), ("historyId", 36), ("sessionId", 32)):
        text = value[field]
        if not isinstance(text, str) or not 0 < len(text) <= limit or any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError(f"closedSessions.{field} is invalid")
        text.encode("utf-8")
    if not value["directory"].startswith("/") or not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value["historyId"]):
        raise ValueError("closedSessions must contain a saved directory and history ID")
    if not re.fullmatch(r"\$\d+", value["sessionId"]):
        raise ValueError("closedSessions.sessionId is invalid")
    if value["title"] is not None and (not isinstance(value["title"], str) or len(value["title"]) > 4096):
        raise ValueError("closedSessions.title is invalid")
    if value["agentType"] not in {None, "claude", "codex", "copilot", "cursor", "grok", "dsh-tui"}:
        raise ValueError("closedSessions.agentType is invalid")
    agent_id = value["agentSessionId"]
    if agent_id is not None and (not isinstance(agent_id, str) or not 0 < len(agent_id) <= 256
                                or value["agentType"] is None or any(ord(c) < 32 for c in agent_id)):
        raise ValueError("closedSessions.agentSessionId is invalid")
    for field in ("sessionCreated", "serverStarted", "serverPid", "savedAt"):
        if type(value[field]) is not int or not 0 < value[field] <= (1 << 53) - 1:
            raise ValueError(f"closedSessions.{field} must be a positive integer")
    return FoldSessionSnapshot(**value)


@dataclass(frozen=True)
class WorkspaceFold:
    id: str
    tabs: tuple[str, ...]
    closed_sessions: tuple[FoldSessionSnapshot, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"id": self.id, "tabs": list(self.tabs)}
        if self.closed_sessions:
            result["closedSessions"] = [item.to_dict() for item in self.closed_sessions]
        return result


def _members(
    roots: tuple[str, ...], tabs: tuple[str, ...], parents: dict[str, str],
) -> set[str]:
    selected = set(roots)
    members: set[str] = set()
    for name in tabs:
        cursor: str | None = name
        visited: set[str] = set()
        while cursor is not None and cursor not in visited:
            if cursor in selected:
                members.add(name)
                break
            visited.add(cursor)
            cursor = parents.get(cursor)
    return members


def _same_level(
    roots: tuple[str, ...], parents: dict[str, str], groups: dict[str, str],
) -> bool:
    return bool(roots) and all(
        parents.get(name) == parents.get(roots[0])
        and groups.get(name) == groups.get(roots[0])
        for name in roots
    )


def validate_workspace_folds(
    value: object,
    tabs: tuple[str, ...],
    parents: tuple[tuple[str, str], ...],
    groups: dict[str, str],
    previous: tuple[WorkspaceFold, ...] = (),
) -> tuple[WorkspaceFold, ...]:
    if not isinstance(value, list):
        raise TypeError("folds must be an array")
    if len(value) > MAX_WORKSPACE_FOLDS:
        raise ValueError(f"folds cannot contain more than {MAX_WORKSPACE_FOLDS} placeholders")
    positions = {name: index for index, name in enumerate(tabs)}
    parent_map = dict(parents)
    ids: set[str] = set()
    hidden: set[str] = set()
    folds: list[WorkspaceFold] = []
    previous_start = -1
    retained = {fold.id: fold.closed_sessions for fold in previous}
    for index, candidate in enumerate(value):
        path = f"folds[{index}]"
        if not isinstance(candidate, dict) or not {"id", "tabs"} <= set(candidate) or set(candidate) - {"id", "tabs", "closedSessions"}:
            raise ValueError(f"{path} must contain id, tabs and optional closedSessions")
        fold_id = candidate["id"]
        if not isinstance(fold_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", fold_id):
            raise ValueError(f"{path}.id must be a valid placeholder id")
        if fold_id in ids:
            raise ValueError("folds contains duplicate id")
        names = candidate["tabs"]
        if not isinstance(names, list) or not names:
            raise ValueError(f"{path}.tabs must be a nonempty array")
        if any(not isinstance(name, str) or name not in positions for name in names):
            raise ValueError(f"{path}.tabs must be workspace tabs")
        roots = tuple(names)
        if len(set(roots)) != len(roots):
            raise ValueError(f"{path}.tabs contains duplicate tabs")
        if tuple(sorted(roots, key=positions.__getitem__)) != roots or positions[roots[0]] <= previous_start:
            raise ValueError("folds must follow workspace tab order")
        if not _same_level(roots, parent_map, groups):
            raise ValueError("folds must contain branches at the same level, parent and group")
        members = _members(roots, tabs, parent_map)
        snapshots: tuple[FoldSessionSnapshot, ...] = ()
        if "closedSessions" not in candidate and retained.get(fold_id):
            snapshots = tuple(item for name in tabs for item in retained[fold_id] if item.name == name and name in members)
        if "closedSessions" in candidate:
            saved = candidate["closedSessions"]
            if not isinstance(saved, list) or not 0 < len(saved) <= len(tabs):
                raise ValueError("closedSessions must be a nonempty array of folded sessions")
            snapshots = tuple(validate_fold_snapshot(item) for item in saved)
            saved_names = [item.name for item in snapshots]
            if len(set(saved_names)) != len(saved_names) or any(name not in members for name in saved_names):
                raise ValueError("closedSessions must be unique members of this fold")
            if saved_names != sorted(saved_names, key=positions.__getitem__):
                raise ValueError("closedSessions must follow workspace tab order")
        if len(members) < (1 if snapshots else 2):
            raise ValueError("folds must contain at least two sessions")
        if hidden & members:
            raise ValueError("folds cannot overlap")
        ids.add(fold_id)
        hidden.update(members)
        previous_start = positions[roots[0]]
        folds.append(WorkspaceFold(fold_id, roots, snapshots))
    return tuple(folds)


def reconcile_workspace_folds(
    folds: tuple[WorkspaceFold, ...],
    tabs: tuple[str, ...],
    parents: tuple[tuple[str, str], ...],
    groups: dict[str, str],
) -> tuple[WorkspaceFold, ...]:
    """Dissolve invalid folds after removal/reparenting without changing tabs."""
    parent_map = dict(parents)
    hidden: set[str] = set()
    reconciled: list[WorkspaceFold] = []
    for fold in folds:
        roots = tuple(name for name in tabs if name in fold.tabs)
        if not _same_level(roots, parent_map, groups):
            continue
        members = _members(roots, tabs, parent_map)
        snapshots = tuple(item for name in tabs for item in fold.closed_sessions if item.name == name and name in members)
        if len(members) < (1 if snapshots else 2) or hidden & members:
            continue
        hidden.update(members)
        reconciled.append(replace(fold, tabs=roots, closed_sessions=snapshots))
    return tuple(sorted(reconciled, key=lambda fold: tabs.index(fold.tabs[0])))
