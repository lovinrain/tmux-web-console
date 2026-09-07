from __future__ import annotations

import sqlite3
from dataclasses import replace

from tmux_console.agent_reference import AgentReference
from tmux_console.session_registry import REGISTRY_COLUMN_NAMES, SessionRegistry
from tmux_console.tmux import Session


def session(name="named-work", session_id="$1", created=100):
    return Session(name=name, id=session_id, created=created, windows=1, attached=0, server_started=90, server_pid=42)


def workspace(name="Project", tabs=None):
    return {"id": "project", "name": name, "tabs": ["named-work"] if tabs is None else tabs}


def test_history_survives_name_reuse_rename_and_registry_forget(tmp_path):
    clock = [200]
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock[0])
    original = session()
    registry.reconcile([original], {original.name: AgentReference("codex", "original-agent-id")})
    registry.record_history_titles({original.name: "Named display title"})
    registry.sync_history_workspaces([workspace()])
    history = registry.list_history()["entries"][0]
    registry.mark_history(history["id"], ended=True)
    clock[0] = 300
    replacement = session(session_id="$2", created=250)
    registry.reconcile([replacement], {replacement.name: AgentReference("claude", "replacement-agent-id")})
    registry.sync_history_workspaces([workspace()])
    entries = registry.list_history(workspace_id="project")["entries"]
    assert len(entries) == 2
    old = next(entry for entry in entries if entry["id"] == history["id"])
    assert old["state"] == "ended"
    assert old["agentSessionId"] == "original-agent-id"
    assert old["title"] == "Named display title"
    assert old["workspaces"][0]["present"] is False
    registry.rename_identity("$2", 250, 90, 42, "renamed-work")
    registry.sync_history_workspaces([workspace(tabs=["renamed-work"])])
    renamed = next(entry for entry in registry.list_history(query="named-work")["entries"]
                   if entry["id"] != history["id"])
    assert renamed["names"] == ["named-work", "renamed-work"]
    assert renamed["workspaces"][0]["closedAt"] is None
    missing = registry.reconcile([])
    for record in missing:
        registry.forget(record.id)
    registry.close()
    registry = SessionRegistry(tmp_path / "sessions.sqlite3")
    assert len(registry.list_history()["entries"]) == 2
    assert registry.list_history(query="original-agent-id")["entries"][0]["id"] == old["id"]
    assert registry.list_history(query="Named display title")["entries"][0]["id"] == old["id"]
    registry.close()


def test_closed_membership_remains_after_workspace_deletion_and_is_read_only(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 200)
    registry.reconcile([session()])
    registry.sync_history_workspaces([workspace()])
    registry.sync_history_workspaces([workspace(name="Renamed project", tabs=[])])
    registry.sync_history_workspaces([])
    records = registry.list_history(workspace_id="project", recycled=True)["entries"]
    assert len(records) == 1
    assert records[0]["state"] == "live"
    assert records[0]["workspaces"][0]["closedAt"] == 200
    assert records[0]["workspaces"][0]["name"] == "Project"
    assert registry.list_history(workspace_id="other")["entries"] == []
    before = (tmp_path / "sessions.sqlite3").read_bytes()
    assert registry.list_history(query="' OR 1=1 --")["entries"] == []
    registry.list_history()
    assert (tmp_path / "sessions.sqlite3").read_bytes() == before
    registry.close()


def test_distinct_server_identities_and_history_pagination(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    originals = [session(f"named-{i}", f"${i}") for i in range(53)]
    registry.reconcile(originals)
    registry.reconcile([replace(originals[0], server_started=200, server_pid=99)])
    page = registry.list_history()
    assert len(page["entries"]) == 50
    assert page["nextOffset"] == 50
    rest = registry.list_history(offset=50)
    assert len(rest["entries"]) == 4
    assert rest["nextOffset"] is None
    assert len({row["id"] for row in page["entries"] + rest["entries"]}) == 54
    registry.close()


def test_migrates_legacy_registry_without_changing_recovery_records(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    connection = sqlite3.connect(path)
    types = ["TEXT", "TEXT", "TEXT", "TEXT", "INTEGER", "INTEGER", "INTEGER", "TEXT", "TEXT", "INTEGER", "INTEGER", "INTEGER"]
    connection.execute("CREATE TABLE sessions (" + ", ".join(f"{name} {kind}" for name, kind in zip(REGISTRY_COLUMN_NAMES, types, strict=True)) + ")")
    original = ("legacy-id", "ended-name", str(tmp_path), "$1", 10, 9, 8, "copilot", "known-id", 20, 30, 0)
    connection.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", original)
    connection.execute("PRAGMA user_version=1")
    connection.commit()
    connection.close()
    registry = SessionRegistry(path)
    entry = registry.list_history(recycled=True)["entries"][0]
    assert entry["name"] == "ended-name"
    assert entry["agentSessionId"] == "known-id"
    assert entry["endedAt"] is None
    assert entry["state"] == "ended"
    registry.close()
    with sqlite3.connect(path) as check:
        assert check.execute("SELECT * FROM sessions").fetchone() == original
        assert check.execute("PRAGMA user_version").fetchone()[0] == 2
