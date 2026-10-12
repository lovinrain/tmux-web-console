from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from tmux_console.agent_reference import AgentReference
from tmux_console.agent_reference_recovery import (
    MAX_RECOVERED_REFERENCES,
    AgentReferenceRecovery,
    codex_reconnect_references,
)
from tmux_console.agent_transcripts import AgentTranscriptReader
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import HistoryCapture, Pane, Session, TmuxClient, TmuxError

ID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


def banner(identifier=ID):
    return f"To reconnect, run:\ncodex resume {identifier}\n"


def session():
    pane = Pane(id="%1", index=0, window_index=0, window_name="main", window_active=True,
                active=True, command="bash", path="/work", title="", width=80, height=24,
                history_size=10000, history_limit=20000, alternate_on=False, dead=False,
                activity=100, process_pid=123)
    return Session(name="work", id="$1", created=100, windows=1, attached=0,
                   server_started=90, server_pid=321, panes=[pane])


class RecoveryTmux(TmuxClient):
    def __init__(self, text=None):
        super().__init__(binary="must-not-run-tmux")
        self.session = session()
        self.text = banner() if text is None else text
        self.captures = []
        self.replace_after_capture = False

    async def list_sessions(self):
        return [self.session]

    async def capture_history_slice(self, pane, start, end):
        self.captures.append((pane.id, start, end))
        if self.replace_after_capture:
            self.session = replace(self.session, created=200, server_pid=999)
        return HistoryCapture(pane, self.text.splitlines())


@pytest.mark.parametrize("text,expected", [
    (banner(), [ID]),
    (f"\x1b[32mTo reconnect, run:\x1b[0m\n  codex resume {ID.upper()}\n", [ID]),
    (f"To continue this session, run codex resume {ID}\n", [ID]),
    (f"codex resume {ID}\n", []),
    (f"> To reconnect, run:\n> codex resume {ID}\n", []),
    (f"To reconnect, run:\ncodex resume '{ID}'\n", []),
    (f"To reconnect, run:\ncodex resume {ID} --extra\n", []),
    ("To reconnect, run:\ncodex resume 1234\n", []),
])
def test_only_explicit_codex_reconnect_instructions_are_recovered(text, expected):
    assert [reference.session_id for reference in codex_reconnect_references(text)] == expected


def test_recovery_retains_recent_distinct_conversations_in_banner_order():
    identifiers = [f"{i:08x}-0000-4000-8000-000000000000" for i in range(20)]
    text = "".join(banner(identifier) for identifier in identifiers) + banner(identifiers[-3])
    recovered = [reference.session_id for reference in codex_reconnect_references(text)]
    expected = identifiers[-MAX_RECOVERED_REFERENCES:]
    expected.remove(identifiers[-3])
    assert recovered == [*expected, identifiers[-3]]


def test_recovery_tail_budget_counts_bytes_for_unicode_output(monkeypatch):
    monkeypatch.setattr("tmux_console.agent_reference_recovery.MAX_PANE_CAPTURE_BYTES", 256)
    text = banner(ID) + "🚀" * 60 + "\n" + banner(OTHER)
    assert [reference.session_id for reference in codex_reconnect_references(text)] == [OTHER]


@pytest.mark.parametrize("header,accepted", [
    (None, True),  # The explicit ID survives even if the native file is gone.
    ({"type": "session_meta", "payload": {"id": ID, "source": "vscode"}}, True),
    ({"type": "session_meta", "payload": {"id": OTHER}}, False),
    ({"type": "session_meta", "payload": {"id": ID, "source": {"subagent": {"thread_spawn": {}}}}}, False),
    ({"type": "response_item", "payload": {"id": ID}}, False),
    ("not json", False),
    ("x" * 65_537, False),
])
def test_recovery_validates_available_native_headers(tmp_path, header, accepted):
    if header is not None:
        path = tmp_path / "sessions/2026/10/03" / f"rollout-2026-10-03T00-00-00-{ID}.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text((header if isinstance(header, str) else json.dumps(header)) + "\n")
    reader = AgentTranscriptReader(roots={"codex": tmp_path})
    assert reader.accepts_codex_reference(ID) is accepted
    assert not reader.accepts_codex_reference("../../other-file")


async def test_bounded_capture_cache_and_incarnation_scoping(tmp_path):
    tmux = RecoveryTmux()
    recovery = AgentReferenceRecovery(tmux, AgentTranscriptReader(roots={"codex": tmp_path}))
    assert await recovery.recover_sessions([tmux.session]) == {"%1": [AgentReference("codex", ID)]}
    assert tmux.captures == [("%1", -1976, 23)]
    assert await recovery.recover_sessions([tmux.session])
    assert len(tmux.captures) == 1
    tmux.session = replace(tmux.session, name="renamed")
    assert await recovery.recover_sessions([tmux.session])
    assert len(tmux.captures) == 1  # Rename preserves native identity.
    tmux.session = replace(tmux.session, created=200)
    tmux.text = banner(OTHER)
    assert await recovery.recover_sessions([tmux.session]) == {"%1": [AgentReference("codex", OTHER)]}
    assert len(tmux.captures) == 2
    assert len(recovery._cache) == 1


async def test_a_new_exit_is_detected_after_a_negative_cache_expires(tmp_path, monkeypatch):
    now = [100.0]
    monkeypatch.setattr("tmux_console.agent_reference_recovery.time", SimpleNamespace(monotonic=lambda: now[0]))
    tmux = RecoveryTmux("")
    recovery = AgentReferenceRecovery(tmux, AgentTranscriptReader(roots={"codex": tmp_path}))
    assert await recovery.recover_sessions([tmux.session]) == {}
    tmux.text = banner()
    now[0] += 4
    assert await recovery.recover_sessions([tmux.session]) == {}
    now[0] += 2
    assert await recovery.recover_sessions([tmux.session]) == {"%1": [AgentReference("codex", ID)]}


async def test_reading_one_pane_does_not_evict_other_cached_references(tmp_path):
    tmux = RecoveryTmux()
    other = replace(tmux.session, id="$2", panes=[replace(tmux.session.panes[0], id="%2")])

    async def inventory():
        return [tmux.session, other]
    tmux.list_sessions = inventory
    recovery = AgentReferenceRecovery(tmux, AgentTranscriptReader(roots={"codex": tmp_path}))
    assert len(await recovery.recover_sessions(await inventory())) == 2
    await recovery.recover_sessions([tmux.session], prune_cache=False)
    await recovery.recover_sessions(await inventory())
    assert len(tmux.captures) == 2


async def test_recovery_rejects_a_replaced_pane_and_tolerates_disappearance(tmp_path):
    tmux = RecoveryTmux()
    tmux.replace_after_capture = True
    recovery = AgentReferenceRecovery(tmux, AgentTranscriptReader(roots={"codex": tmp_path}))
    assert await recovery.recover_sessions([tmux.session]) == {}

    async def gone(*args):
        raise TmuxError("pane disappeared")
    tmux.capture_history_slice = gone
    assert await recovery.recover_sessions([tmux.session]) == {}


def test_exited_agent_recovery_repairs_history_and_recovery_record_without_losing_ids(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    native = session()
    registry.reconcile([native], {native.name: AgentReference("codex", None)})
    recovered = {"%1": [AgentReference("codex", ID), AgentReference("codex", OTHER)]}
    history_id = registry.observe_history(native, AgentReference(None, None), recovered_references=recovered)
    history = registry.get_history(history_id)
    assert history["agent_id"] == OTHER
    assert {item["agentSessionId"] for item in registry.list_session_agents(history_id)} == {None, ID, OTHER}
    # The current conversation sorts last even though all IDs were seen at once.
    assert registry.list_session_agents(history_id)[-1]["agentSessionId"] == OTHER
    record = registry.reconcile([])[0]
    assert record.agent_session_id == OTHER
    registry.close()


@pytest.mark.parametrize("current", [AgentReference("codex", OTHER), AgentReference("codex", None)])
def test_old_exit_banner_never_identifies_or_replaces_a_running_agent(tmp_path, current):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    native = session()
    registry.reconcile([native], {native.name: current}, recovered_references={"%1": [AgentReference("codex", ID)]})
    history = registry.list_history()["entries"][0]
    assert history["agentSessionId"] == current.session_id
    assert ID in {item["agentSessionId"] for item in history["agents"]}
    registry.close()


def test_recovered_ids_do_not_overwrite_a_known_past_conversation_or_cross_panes(tmp_path):
    registry = SessionRegistry(tmp_path / "sessions.sqlite3", clock=lambda: 300)
    native = session()
    history_id = registry.observe_history(native, AgentReference("codex", OTHER))
    recovered = {"%1": [AgentReference("codex", ID)]}
    registry.reconcile([native], recovered_references=recovered)
    assert registry.get_history(history_id)["agent_id"] == OTHER
    other_pane = replace(native.panes[0], id="%2", active=False, process_pid=456)
    replacement = replace(native, created=400, panes=[native.panes[0], other_pane])
    registry.reconcile([replacement], recovered_references={"%2": recovered["%1"]})
    current = registry.history_for_identity(replacement.id, replacement.created, replacement.server_started, replacement.server_pid)
    assert current["agent_id"] is None
    assert [item["agentSessionId"] for item in registry.list_session_agents(current["id"])] == [ID]
    registry.close()
