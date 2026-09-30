"""Custom callback organization, stored alongside reports in callbacks.sqlite3.

Callers provide a transaction; moving members and advancing the revision must
commit together. These operations never modify a callback queue or review state.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from .messages import validate_session_name

MAX_CALLBACK_GROUPS_PER_SCOPE = 32
MAX_CALLBACK_GROUP_NAME_LENGTH = 40
MAX_CALLBACK_GROUP_MEMBERS = 1024


class CallbackGroupConflict(ValueError):
    pass


class CallbackGroupNotFound(LookupError):
    pass


def initialize(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS callback_groups (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL,
            name TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS callback_group_members (
            scope TEXT NOT NULL,
            sessionName TEXT NOT NULL,
            groupId TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (scope, sessionName)
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS callback_group_members_group_idx
        ON callback_group_members (groupId, position)
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS callback_group_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL
        )
    """)
    connection.execute("INSERT OR IGNORE INTO callback_group_metadata VALUES (1, 0)")


def _revision(connection: sqlite3.Connection) -> int:
    return int(connection.execute(
        "SELECT revision FROM callback_group_metadata WHERE id = 1"
    ).fetchone()[0])


def _changed(connection: sqlite3.Connection) -> None:
    connection.execute(
        "UPDATE callback_group_metadata SET revision = revision + 1 WHERE id = 1"
    )


def _check_revision(connection: sqlite3.Connection, expected: object) -> None:
    if isinstance(expected, bool) or not isinstance(expected, int) or not 0 <= expected < 2**53:
        raise ValueError("expectedRevision must be a non-negative safe integer")
    if expected != _revision(connection):
        raise CallbackGroupConflict("Callback groups changed in another window. Reopen the group editor and try again.")


def _text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value.strip() or len(value) > maximum:
        raise ValueError(f"{field} must contain 1 to {maximum} characters")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"{field} cannot contain control characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must contain valid Unicode") from error
    return value


def _scope(workspace_id: object) -> str:
    return "global" if workspace_id is None else f"workspace:{_text(workspace_id, 'workspaceId', 128)}"


def _find(connection: sqlite3.Connection, group_id: str, scope: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM callback_groups WHERE id = ? AND scope = ?", (group_id, scope)
    ).fetchone()
    if row is None:
        raise CallbackGroupNotFound("Callback group was not found.")
    return row


def snapshot(connection: sqlite3.Connection) -> dict[str, Any]:
    members: dict[str, list[str]] = {}
    for row in connection.execute("SELECT * FROM callback_group_members ORDER BY position"):
        members.setdefault(row["groupId"], []).append(row["sessionName"])
    return {
        "callbackGroups": [
            {
                "id": row["id"], "name": row["name"],
                "workspaceId": None if row["scope"] == "global" else row["scope"][10:],
                "sessions": members.get(row["id"], []),
            }
            for row in connection.execute("SELECT * FROM callback_groups ORDER BY sequence")
        ],
        "callbackGroupRevision": _revision(connection),
    }


def save(
    connection: sqlite3.Connection, *, group_id: str | None, workspace_id: object,
    name: object, sessions: object, expected_revision: object,
) -> str:
    scope = _scope(workspace_id)
    label = _text(name, "name", MAX_CALLBACK_GROUP_NAME_LENGTH).strip()
    if label.casefold() == "ungrouped":
        raise ValueError("Choose a name other than Ungrouped.")
    if not isinstance(sessions, list):
        raise TypeError("sessions must be an array")
    if len(sessions) > MAX_CALLBACK_GROUP_MEMBERS:
        raise ValueError(f"A group can contain at most {MAX_CALLBACK_GROUP_MEMBERS} callbacks.")
    members = list(dict.fromkeys(
        validate_session_name(_text(value, "session name", 256)) for value in sessions
    ))
    _check_revision(connection, expected_revision)
    if group_id is not None:
        _find(connection, group_id, scope)
    groups = connection.execute("SELECT id, name FROM callback_groups WHERE scope = ?", (scope,)).fetchall()
    if any(row["id"] != group_id and row["name"].casefold() == label.casefold() for row in groups):
        raise CallbackGroupConflict("A callback group with that name already exists in this scope.")
    if group_id is None:
        if len(groups) >= MAX_CALLBACK_GROUPS_PER_SCOPE:
            raise CallbackGroupConflict(f"A scope can contain at most {MAX_CALLBACK_GROUPS_PER_SCOPE} custom groups.")
        group_id = uuid.uuid4().hex
        connection.execute("INSERT INTO callback_groups (id, scope, name) VALUES (?, ?, ?)", (group_id, scope, label))
    else:
        previous = [row[0] for row in connection.execute(
            "SELECT sessionName FROM callback_group_members WHERE groupId = ? ORDER BY position", (group_id,)
        )]
        if _find(connection, group_id, scope)["name"] == label and previous == members:
            return group_id
        connection.execute("UPDATE callback_groups SET name = ? WHERE id = ?", (label, group_id))
        connection.execute("DELETE FROM callback_group_members WHERE groupId = ?", (group_id,))
    # The (scope, sessionName) key transfers chosen callbacks from other groups.
    connection.executemany(
        "INSERT INTO callback_group_members (scope, sessionName, groupId, position) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (scope, sessionName) DO UPDATE SET groupId = excluded.groupId, position = excluded.position",
        [(scope, member, group_id, index) for index, member in enumerate(members)],
    )
    _changed(connection)
    return group_id


def delete(connection: sqlite3.Connection, *, group_id: str, workspace_id: object, expected_revision: object) -> None:
    _check_revision(connection, expected_revision)
    _find(connection, group_id, _scope(workspace_id))
    connection.execute("DELETE FROM callback_group_members WHERE groupId = ?", (group_id,))
    connection.execute("DELETE FROM callback_groups WHERE id = ?", (group_id,))
    _changed(connection)


def delete_workspace(connection: sqlite3.Connection, workspace_id: str) -> None:
    scope = _scope(workspace_id)
    connection.execute("DELETE FROM callback_group_members WHERE scope = ?", (scope,))
    if connection.execute("DELETE FROM callback_groups WHERE scope = ?", (scope,)).rowcount:
        _changed(connection)


def rename_session(connection: sqlite3.Connection, old: str, new: str) -> None:
    if old == new:
        return
    scopes = [row[0] for row in connection.execute(
        "SELECT scope FROM callback_group_members WHERE sessionName = ?", (old,)
    )]
    for scope in scopes:
        connection.execute("DELETE FROM callback_group_members WHERE scope = ? AND sessionName = ?", (scope, new))
        connection.execute(
            "UPDATE callback_group_members SET sessionName = ? WHERE scope = ? AND sessionName = ?", (new, scope, old)
        )
    if scopes:
        _changed(connection)
