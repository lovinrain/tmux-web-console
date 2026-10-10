from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from tmux_console.agent_reference import AgentReference
from tmux_console.session_history_pages import HistoryPageStore
from tmux_console.session_registry import (
    REGISTRY_COLUMN_NAMES,
    SESSION_REGISTRY_SCHEMA_VERSION,
    SessionRegistry,
)
from tmux_console.tmux import CreatedSession, Session


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
        assert check.execute("PRAGMA user_version").fetchone()[0] == (
            SESSION_REGISTRY_SCHEMA_VERSION
        )


def test_history_can_be_scoped_to_one_session_without_matching_similar_names(tmp_path: Path):
    """names is a JSON array, so the filter matches the quoted element: asking
    for "work" must not drag in "work_2"."""
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 100)
    registry.observe_history(session(name="work"), AgentReference("claude", "aaaa-1"))
    registry.observe_history(
        replace(session(name="work_2"), id="$2"), AgentReference("codex", "bbbb-2"),
    )

    scoped = registry.list_history(recycled=False, session_name="work")["entries"]
    assert [entry["name"] for entry in scoped] == ["work"]
    assert [a["agentType"] for a in scoped[0]["agents"]] == ["claude"]

    everything = registry.list_history(recycled=False)["entries"]
    assert sorted(entry["name"] for entry in everything) == ["work", "work_2"]


def test_session_scope_follows_a_renamed_session_through_its_old_names(tmp_path: Path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 100)
    live = session(name="before")
    registry.observe_history(live, AgentReference("claude", "aaaa-1"))
    registry.observe_history(replace(live, name="after"), AgentReference("codex", "bbbb-2"))

    for name in ("before", "after"):
        scoped = registry.list_history(recycled=False, session_name=name)["entries"]
        assert [entry["name"] for entry in scoped] == ["after"], name
        assert [a["agentType"] for a in scoped[0]["agents"]] == ["claude", "codex"]


def test_creation_lineage_and_view_history_survive_rename_reuse_and_restart(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    registry = SessionRegistry(path, clock=lambda: 300)
    parent = session("parent", "$1", 100)
    parent_id = registry.observe_history(parent)
    registry.record_created(CreatedSession("copy", "$2"), str(tmp_path),
                            origin="copy", source=parent, placement="child")
    child = session("copy", "$2", 250)
    registry.observe_history(child, AgentReference("codex", "child-agent"))
    registry.record_view_event(child, "split-tab")
    registry.record_view_event(child, "fork")
    registry.rename_identity("$1", 100, 90, 42, "renamed-parent")
    registry.rename_identity("$2", 250, 90, 42, "renamed-copy")
    replacement = session("copy", "$3", 280)
    registry.observe_history(replacement)
    registry.close()
    registry = SessionRegistry(path)
    entries = registry.list_history()["entries"]
    copied = next(entry for entry in entries if entry["name"] == "renamed-copy")
    assert copied["createdAt"] == 250
    assert copied["firstSeenAt"] == 300
    assert copied["origin"] == {"kind": "copy", "recordedAt": 300,
                                "sourceHistoryId": parent_id, "sourceName": "parent", "placement": "child"}
    assert [event["kind"] for event in copied["viewEvents"]] == ["fork", "split-tab"]
    assert copied["agents"][0]["agentSessionId"] == "child-agent"
    reused = next(entry for entry in entries if entry["name"] == "copy")
    assert reused["createdAt"] == 280
    assert reused["origin"] is None
    assert reused["viewEvents"] == []
    registry.close()


def test_recreation_links_previous_identity_and_waits_for_actual_start_time(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    previous = session()
    records = registry.reconcile([previous])
    assert records == []
    old_id = registry.list_history()["entries"][0]["id"]
    recovery = registry.reconcile([])[0]
    registry.record_created(CreatedSession(previous.name, "$2"), str(tmp_path),
                            registry_id=recovery.id, origin="recreate")
    created = next(entry for entry in registry.list_history()["entries"] if entry["id"] != old_id)
    assert created["createdAt"] is None
    assert created["origin"]["sourceHistoryId"] == old_id
    registry.observe_history(session(session_id="$2", created=290))
    assert next(entry for entry in registry.list_history()["entries"] if entry["id"] == created["id"])["createdAt"] == 290
    registry.close()


def test_version_three_metadata_migration_preserves_history_and_unknown_origins(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    registry = SessionRegistry(path, clock=lambda: 300)
    history_id = registry.observe_history(session(), AgentReference("codex", "known-agent"))
    registry.close()
    with sqlite3.connect(path) as connection:
        before = connection.execute("SELECT * FROM session_history").fetchall()
        connection.execute("DROP TABLE session_origins")
        connection.execute("DROP TABLE session_view_events")
        connection.execute("PRAGMA user_version=3")
    registry = SessionRegistry(path)
    entry = registry.list_history()["entries"][0]
    assert entry["id"] == history_id
    assert entry["createdAt"] == 100
    assert entry["origin"] is None
    assert entry["viewEvents"] == []
    assert entry["agents"][0]["agentSessionId"] == "known-agent"
    registry.close()
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT * FROM session_history").fetchall() == before
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SESSION_REGISTRY_SCHEMA_VERSION
    assert path.stat().st_mode & 0o777 == 0o600


def test_browser_events_are_bounded_and_do_not_replace_creation_origin(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    registry.record_created(CreatedSession("new", "$1"), str(tmp_path))
    live = session("new", "$1", 200)
    for _ in range(105):
        registry.record_view_event(live, "split-workspace")
    entry = registry.list_history()["entries"][0]
    assert entry["origin"]["kind"] == "new"
    assert len(entry["viewEvents"]) == 100
    assert entry["viewEvents"][0]["id"] > entry["viewEvents"][-1]["id"]
    registry.close()


def test_reopened_workspace_membership_clears_closure_and_repairs_legacy_rows(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    registry = SessionRegistry(path, clock=lambda: 300)
    registry.observe_history(session())
    registry.sync_history_workspaces([workspace()])
    registry.sync_history_workspaces([workspace(tabs=[])])
    assert registry.list_history(workspace_id="project", recycled=True)["totalCount"] == 1
    registry.sync_history_workspaces([workspace()])
    entry = registry.list_history(workspace_id="project")["entries"][0]
    assert entry["workspaces"][0]["present"] is True
    assert entry["workspaces"][0]["closedAt"] is None
    assert registry.list_history(workspace_id="project", recycled=True)["entries"] == []
    # Existing installations can already contain present-but-closed rows.
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE history_workspaces SET closed_at = 299")
    registry.sync_history_workspaces([workspace()])
    assert registry.list_history()["entries"][0]["workspaces"][0]["closedAt"] is None
    registry.close()


def test_workspace_recycle_filter_uses_only_that_workspaces_closure(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    history_id = registry.observe_history(session())
    second = {**workspace("Second"), "id": "second"}
    registry.sync_history_workspaces([workspace(), second])
    registry.mark_history(history_id)
    registry.sync_history_workspaces([workspace(), {**second, "tabs": []}])
    assert registry.list_history(workspace_id="project", recycled=True)["entries"] == []
    assert registry.list_history(workspace_id="second", recycled=True)["totalCount"] == 1
    assert registry.list_history(recycled=True)["totalCount"] == 1
    registry.mark_history(history_id, ended=True)
    assert registry.list_history(workspace_id="project", recycled=True)["totalCount"] == 1
    registry.close()


def test_search_finds_previous_agents_and_decoded_unicode_aliases(tmp_path):
    clock = [300]
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock[0])
    original = session(name='研究 "old"')
    registry.observe_history(original, AgentReference("claude", "earlier-agent-id"))
    clock[0] += 60
    registry.observe_history(replace(original, name="renamed"), AgentReference("codex", "newer-agent-id"))
    for query in ("earlier-agent-id", "claude", '研究 "old"'):
        assert [e["name"] for e in registry.list_history(query=query)["entries"]] == ["renamed"]
    assert registry.list_history(session_name=original.name)["totalCount"] == 1
    assert registry.list_history(session_name="研究")["entries"] == []
    registry.close()


def test_membership_prefers_new_native_start_over_late_observation_of_reused_name(tmp_path):
    clock = [300]
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock[0])
    old = session()
    old_id = registry.observe_history(old)
    registry.sync_history_workspaces([workspace()])
    current = session(session_id="$2", created=250)
    current_id = registry.observe_history(current)
    clock[0] += 60
    registry.observe_history(old)
    registry.sync_history_workspaces([workspace()])
    entries = {entry["id"]: entry for entry in registry.list_history(workspace_id="project")["entries"]}
    assert entries[current_id]["workspaces"][0]["present"] is True
    assert entries[old_id]["workspaces"][0]["present"] is False
    registry.close()


def test_history_cursor_keeps_order_when_observations_and_memberships_change(tmp_path):
    clock = [300]
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock[0])
    sessions = [session(f"work-{i}", f"${i}", 100 + i) for i in range(105)]
    registry.reconcile(sessions)
    expected = [e["id"] for offset in (0, 50, 100)
                for e in registry.list_history(offset=offset)["entries"]]
    first = registry.list_history()
    cursor = first["nextCursor"]
    assert first["totalCount"] == 105 and cursor
    clock[0] += 60
    reordered = sessions[next(i for i, s in enumerate(sessions)
                              if registry.history_for_identity(s.id, s.created, 90, 42)["id"] == expected[75])]
    registry.observe_history(reordered, AgentReference("codex", "new-observation"))
    registry.observe_history(session("new-arrival", "$new", 290))
    entries = first["entries"][:]
    while cursor:
        page = registry.list_history(cursor=cursor)
        assert page["totalCount"] == 105
        entries.extend(page["entries"])
        cursor = page["nextCursor"]
    assert [e["id"] for e in entries] == expected
    assert next(e for e in entries if e["id"] == expected[75])["agentSessionId"] == "new-observation"
    assert registry.list_history()["totalCount"] == 106
    with pytest.raises(ValueError, match="cursor"):
        registry.list_history(cursor=first["nextCursor"], query="different-filter")
    # Legacy arbitrary offsets remain valid, but do not emit unusable cursors.
    assert registry.list_history(offset=1)["nextCursor"] is None
    registry.close()


def test_history_page_store_expires_and_bounds_ordering_snapshots():
    clock = [0.0]
    store = HistoryPageStore(clock=lambda: clock[0])
    filters = (None, "", False, None)
    ids = tuple(str(i) for i in range(100))
    key = store.create(ids, filters)
    assert store.get(f"{key}.50", filters)[1].ids == ids
    for cursor in (f"{key}.0", f"{key}.1", f"{key}.100", f"{key}.５０", "x" * 129, ""):
        with pytest.raises(ValueError, match="cursor"):
            store.get(cursor, filters)
    clock[0] = 601
    with pytest.raises(ValueError, match="expired"):
        store.get(f"{key}.50", filters)
    key = store.create(ids, filters)
    for _ in range(32):
        store.create(ids, filters)
    with pytest.raises(ValueError, match="expired"):
        store.get(f"{key}.50", filters)
    large = tuple(str(i) for i in range(100_000))
    key = store.create(large, filters)
    store.create(large, filters)
    store.create(large, filters)
    with pytest.raises(ValueError, match="expired"):
        store.get(f"{key}.50", filters)


def test_other_pane_agents_are_retained_without_replacing_primary_agent(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    primary = AgentReference("claude", "primary-id")
    other = AgentReference("codex", "other-pane-id")
    registry.observe_history(session(), primary, pane_references=[other])
    registry.observe_history(session(), None, pane_references=[other])
    entry = registry.list_history()["entries"][0]
    assert entry["agentType"] == "claude"
    assert entry["agentSessionId"] == "primary-id"
    assert {a["agentSessionId"] for a in entry["agents"]} == {"primary-id", "other-pane-id"}
    assert registry.list_history(query="other-pane-id")["totalCount"] == 1
    registry.close()
