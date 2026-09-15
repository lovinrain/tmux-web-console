from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tmux_console.agent_reference import AgentReference
from tmux_console.session_registry import (
    RecoveryRecordNotFoundError,
    SessionRegistry,
    SessionRegistryUnavailable,
)
from tmux_console.tmux import CreatedSession, Pane, Session


def pane(path: str = "/work") -> Pane:
    return Pane(
        id="%1",
        index=0,
        window_index=0,
        window_name="main",
        window_active=True,
        active=True,
        command="codex",
        path=path,
        title="Codex",
        width=100,
        height=30,
        history_size=0,
        history_limit=2000,
        alternate_on=False,
        dead=False,
        activity=1,
    )


def session(name: str = "work", *, session_id: str = "$1", path: str = "/work") -> Session:
    return Session(
        name=name,
        id=session_id,
        windows=1,
        attached=0,
        created=100,
        server_started=90,
        server_pid=42,
        panes=[pane(path)],
    )


def test_reconciles_live_sessions_and_lists_only_missing_records(tmp_path: Path):
    ids = iter(["registry-one"])
    registry = SessionRegistry(
        tmp_path / "sessions.sqlite3",
        clock=lambda: 200,
        id_factory=lambda: next(ids),
    )
    live = session(path=str(tmp_path))

    assert registry.reconcile(
        [live],
        {"work": AgentReference("codex", "agent-reference")},
    ) == []
    missing = registry.reconcile([], observed_at=300)

    assert [record.to_dict() for record in missing] == [{
        "id": "registry-one",
        "name": "work",
        "directory": str(tmp_path),
        "agentType": "codex",
        "agentSessionId": "agent-reference",
        "firstSeenAt": 200,
        "lastSeenAt": 200,
        "directoryAvailable": True,
    }]


def test_reuses_stable_record_across_rename_and_new_tmux_identity(tmp_path: Path):
    registry = SessionRegistry(
        tmp_path / "sessions.sqlite3",
        id_factory=lambda: "stable-id",
    )
    original = session(path=str(tmp_path))
    registry.reconcile([original], observed_at=100)
    renamed = session("renamed", path=str(tmp_path))
    registry.reconcile([renamed], observed_at=110)
    replacement = session("renamed", session_id="$9", path=str(tmp_path))
    registry.reconcile([replacement], observed_at=120)

    missing = registry.reconcile([], observed_at=130)
    assert len(missing) == 1
    assert missing[0].id == "stable-id"
    assert missing[0].name == "renamed"
    assert missing[0].tmux_session_id == "$9"


def test_record_created_preserves_recovery_id_and_reference_metadata(tmp_path: Path):
    registry = SessionRegistry(
        tmp_path / "sessions.sqlite3",
        id_factory=lambda: "stable-id",
    )
    registry.reconcile(
        [session(path=str(tmp_path))],
        {"work": AgentReference("codex", "reference-id")},
        observed_at=100,
    )
    recovered = registry.reconcile([], observed_at=110)[0]

    saved = registry.record_created(
        CreatedSession("work", "$8"),
        str(tmp_path),
        registry_id=recovered.id,
    )

    assert saved.id == "stable-id"
    assert saved.tmux_session_id == "$8"
    assert saved.agent_type == "codex"
    assert saved.agent_session_id == "reference-id"
    assert registry.reconcile([], observed_at=120)[0].id == "stable-id"


def test_intentional_end_disables_recovery_but_new_identity_reenables_it(tmp_path: Path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3")
    live = session(path=str(tmp_path))
    registry.reconcile([live], observed_at=100)

    assert registry.set_recovery_for_identity(
        live.name,
        live.id,
        live.created,
        live.server_started,
        live.server_pid,
        False,
    )
    assert registry.reconcile([], observed_at=110) == []

    replacement = session(session_id="$2", path=str(tmp_path))
    registry.reconcile([replacement], observed_at=120)
    assert registry.reconcile([], observed_at=130)[0].tmux_session_id == "$2"


def test_forget_is_idempotent_and_removes_only_the_registry_row(tmp_path: Path):
    registry = SessionRegistry(
        tmp_path / "sessions.sqlite3",
        id_factory=lambda: "forget-me",
    )
    registry.reconcile([session(path=str(tmp_path))])

    assert registry.forget("forget-me") is True
    assert registry.forget("forget-me") is False
    with pytest.raises(RecoveryRecordNotFoundError):
        registry.get_recoverable("forget-me")


def test_rejects_an_unknown_database_schema_without_overwriting_it(tmp_path: Path):
    path = tmp_path / "future.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA user_version=99")
    connection.close()

    with pytest.raises(SessionRegistryUnavailable):
        SessionRegistry(path)

    connection = sqlite3.connect(path)
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 99
    connection.close()


def test_rejects_a_malformed_unversioned_sessions_table(tmp_path: Path):
    path = tmp_path / "malformed.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE sessions (registry_id TEXT PRIMARY KEY)")
    connection.commit()
    connection.close()

    with pytest.raises(SessionRegistryUnavailable):
        SessionRegistry(path)

    connection = sqlite3.connect(path)
    assert [
        row[1] for row in connection.execute("PRAGMA table_info(sessions)")
    ] == ["registry_id"]
    connection.close()


def _agents(registry: SessionRegistry, history_id: str):
    return [
        (item["agentType"], item["agentSessionId"])
        for item in registry.list_session_agents(history_id)
    ]


def test_records_every_agent_a_session_runs_not_only_the_latest(tmp_path: Path):
    """session_history keeps a single agent and overwrites it, so running one
    agent after another used to erase the earlier one."""
    clock = {"now": 100}
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock["now"])
    live = session()

    history_id = registry.observe_history(live, AgentReference("claude", "aaaa-1"))
    clock["now"] += 600
    registry.observe_history(live, AgentReference("codex", "bbbb-2"))
    clock["now"] += 600
    registry.observe_history(live, AgentReference("cursor", "cccc-3"))

    assert _agents(registry, history_id) == [
        ("claude", "aaaa-1"), ("codex", "bbbb-2"), ("cursor", "cccc-3"),
    ]


def test_repeated_observation_of_one_agent_stays_a_single_entry(tmp_path: Path):
    clock = {"now": 100}
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock["now"])
    live = session()

    history_id = registry.observe_history(live, AgentReference("claude", "aaaa-1"))
    for _ in range(5):
        clock["now"] += 300
        registry.observe_history(live, AgentReference("claude", "aaaa-1"))

    assert _agents(registry, history_id) == [("claude", "aaaa-1")]


def test_an_agent_without_a_session_id_is_recorded_once_and_reads_back_as_none(tmp_path: Path):
    """An unknown id is stored as an empty string because SQLite treats NULLs as
    distinct in a primary key, which would let duplicates accumulate."""
    clock = {"now": 100}
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: clock["now"])
    live = session()

    history_id = registry.observe_history(live, AgentReference("claude", None))
    clock["now"] += 600
    registry.observe_history(live, AgentReference("claude", None))

    assert _agents(registry, history_id) == [("claude", None)]

    # Once the id is discovered it is a distinct run of that agent.
    clock["now"] += 600
    registry.observe_history(live, AgentReference("claude", "aaaa-1"))
    assert _agents(registry, history_id) == [("claude", None), ("claude", "aaaa-1")]


def test_a_session_with_no_agent_records_nothing(tmp_path: Path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 100)
    history_id = registry.observe_history(session(), None)
    assert _agents(registry, history_id) == []


def test_migration_seeds_agents_from_history_recorded_before_the_table_existed(tmp_path: Path):
    database = tmp_path / "sessions.sqlite3"
    registry = SessionRegistry(database, clock=lambda: 100)
    history_id = registry.observe_history(session(), AgentReference("claude", "aaaa-1"))
    registry.close()

    # Drop the new table and rewind the schema, as an older database would be.
    connection = sqlite3.connect(database)
    with connection:
        connection.execute("DROP TABLE session_agents")
        connection.execute("PRAGMA user_version=2")
    connection.close()

    reopened = SessionRegistry(database, clock=lambda: 200)
    assert _agents(reopened, history_id) == [("claude", "aaaa-1")]
