"""Lightweight, non-destructive placeholders for sibling session branches."""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

MAX_WORKSPACE_FOLDS = 128


@dataclass(frozen=True)
class WorkspaceFold:
    id: str
    tabs: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "tabs": list(self.tabs)}


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
    for index, candidate in enumerate(value):
        path = f"folds[{index}]"
        if not isinstance(candidate, dict) or set(candidate) != {"id", "tabs"}:
            raise ValueError(f"{path} must contain exactly id and tabs")
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
        if len(members) < 2:
            raise ValueError("folds must contain at least two sessions")
        if hidden & members:
            raise ValueError("folds cannot overlap")
        ids.add(fold_id)
        hidden.update(members)
        previous_start = positions[roots[0]]
        folds.append(WorkspaceFold(fold_id, roots))
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
        if len(members) < 2 or hidden & members:
            continue
        hidden.update(members)
        reconciled.append(replace(fold, tabs=roots))
    return tuple(sorted(reconciled, key=lambda fold: tabs.index(fold.tabs[0])))
