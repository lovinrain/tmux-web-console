from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import app as app_module
from tmux_console.app import SESSION_COMPLETION_KEY, SESSION_REGISTRY_KEY, create_app
from tmux_console.session_completion import SessionCompletionMonitor
from tmux_console.status import AgentState, AgentStateDetector
from tmux_console.tmux import HistoryCapture, Pane, Session, TmuxClient, TmuxError


def make_session() -> Session:
    pane = Pane(
        id="%1", index=0, window_index=0, window_name="agent",
        window_active=True, active=True, command="codex", path="/tmp", title="Task",
        width=100, height=30, history_size=0, history_limit=2000,
        alternate_on=False, dead=False, activity=int(time.time()),
    )
    return Session("task", "$1", 1, 0, 100, server_started=90, server_pid=123, panes=[pane])


class CompletionTmux(TmuxClient):
    def __init__(self, session: Session) -> None:
        self.live = [session]
        self.option_calls: list[str] = []
        self.terminate_calls: list[tuple[str, int, int, int]] = []
        self.screen = "❯ \nReady"

    async def list_sessions(self) -> list[Session]:
        return list(self.live)

    async def set_end_when_finished(self, session: Session, mode: str) -> None:
        self.option_calls.append(mode)
        session.end_when_finished = mode

    async def capture_history_slice(self, pane: Pane, start: int, end: int) -> HistoryCapture:
        return HistoryCapture(pane, [])

    async def capture_visible(self, pane_id: str) -> str:
        return self.screen

    async def terminate_session(self, *identity: object) -> None:
        session = self.live[0]
        assert identity == (session.id, session.created, session.server_started, session.server_pid)
        self.terminate_calls.append(identity)
        self.live.clear()


class CompletionDetector(AgentStateDetector):
    def __init__(self) -> None:
        self.states = {"%1": AgentState("waiting_human", "Agent is idle at its input prompt")}

    async def detect_sessions(self, tmux: TmuxClient, sessions: list[Session]) -> dict[str, AgentState]:
        return {session.name: self.states[session.active_pane.id] for session in sessions}


@pytest.mark.asyncio
async def test_waits_for_work_then_stable_ready_and_retries_do_not_rearm_idle():
    session = make_session()
    tmux = CompletionTmux(session)
    detector = CompletionDetector()
    terminate = AsyncMock()
    clock = [0.0]
    monitor = SessionCompletionMonitor(tmux, terminate, detector=detector, clock=lambda: clock[0])
    await monitor.set_enabled(session, True)
    assert session.end_when_finished == "waiting"
    await monitor.check([session])
    clock[0] = 10
    await monitor.check([session])
    terminate.assert_not_awaited()

    detector.states["%1"] = AgentState("working", "Working")
    await monitor.check([session])
    assert session.end_when_finished == "working"
    detector.states["%1"] = AgentState("waiting_human", "Ready")
    await monitor.set_enabled(session, True)  # A retried PUT preserves the work episode.
    await monitor.check([session])
    clock[0] = 12
    await monitor.check([session])
    terminate.assert_not_awaited()
    clock[0] = 13
    await monitor.check([session])
    terminate.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_cancellation_prevents_pending_completion():
    session = make_session()
    tmux = CompletionTmux(session)
    detector = CompletionDetector()
    detector.states["%1"] = AgentState("running_command", "Command running")
    terminate = AsyncMock()
    clock = [0.0]
    monitor = SessionCompletionMonitor(tmux, terminate, detector=detector, clock=lambda: clock[0])
    await monitor.set_enabled(session, True)
    assert session.end_when_finished == "working"
    detector.states["%1"] = AgentState("waiting_human", "Ready")
    await monitor.check([session])
    await monitor.set_enabled(session, False)
    clock[0] = 10
    await monitor.check([session])
    terminate.assert_not_awaited()
    assert tmux.option_calls == ["working", ""]


@pytest.mark.asyncio
@pytest.mark.parametrize("screen", [
    "Do you want to proceed?\n❯ 1. Yes\n  2. No",
    "Would you like to run this command?\nPress enter to confirm or esc to cancel",
    "Choose an answer\nEnter to select · Esc to cancel",
])
async def test_ready_titles_do_not_end_sessions_paused_on_decision_prompts(screen):
    session = make_session()
    session.end_when_finished = "working"
    tmux = CompletionTmux(session)
    tmux.screen = screen
    terminate = AsyncMock()
    clock = [0.0]
    monitor = SessionCompletionMonitor(tmux, terminate, detector=CompletionDetector(), clock=lambda: clock[0])
    await monitor.check([session])
    clock[0] = 10
    await monitor.check([session])
    terminate.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("exited", [True, False])
async def test_observed_work_can_finish_with_an_exited_agent_or_idle_shell(exited):
    session = make_session()
    session.end_when_finished = "working"
    session.panes = [replace(session.panes[0], dead=exited, command="bash")]
    detector = CompletionDetector()
    detector.states["%1"] = AgentState("other", "Shell")
    terminate = AsyncMock()
    clock = [0.0]
    monitor = SessionCompletionMonitor(CompletionTmux(session), terminate, detector=detector, clock=lambda: clock[0])
    await monitor.check([session])
    clock[0] = 3
    await monitor.check([session])
    terminate.assert_awaited_once_with(session)


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [
    AgentState("working", "Working"),
    AgentState("running_command", "Command running"),
    AgentState("waiting_command", "Waiting for background work"),
    AgentState("unknown", "No reliable signal"),
    AgentState("other", "Unrecognized process"),
    AgentState("waiting_human", "Cursor is waiting on an approval decision"),
    AgentState("waiting_human", "Copilot is waiting on a selection"),
])
async def test_all_panes_must_be_ready_and_transient_signals_reset_settling(state):
    session = make_session()
    session.end_when_finished = "working"
    session.panes.append(replace(session.panes[0], id="%2", active=False, window_active=False))
    detector = CompletionDetector()
    detector.states["%2"] = AgentState("waiting_human", "Ready")
    clock = [0.0]
    terminate = AsyncMock()
    monitor = SessionCompletionMonitor(CompletionTmux(session), terminate, detector=detector, clock=lambda: clock[0])
    await monitor.check([session])
    clock[0] = 2
    detector.states["%2"] = state
    await monitor.check([session])
    clock[0] = 6
    await monitor.check([session])
    terminate.assert_not_awaited()
    detector.states["%2"] = AgentState("waiting_human", "Ready")
    await monitor.check([session])
    clock[0] = 9
    await monitor.check([session])
    terminate.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_saved_request_survives_monitor_restart_and_rename_but_not_replacement():
    session = make_session()
    session.end_when_finished = "working"
    clock = [0.0]
    terminate = AsyncMock()
    monitor = SessionCompletionMonitor(CompletionTmux(session), terminate, detector=CompletionDetector(), clock=lambda: clock[0])
    await monitor.check([session])
    session.name = "renamed"
    clock[0] = 3
    await monitor.check([session])
    terminate.assert_awaited_once_with(session)
    replacement = replace(session, id="$2", end_when_finished="")
    clock[0] = 20
    await monitor.check([replacement])
    assert terminate.await_count == 1


@pytest.mark.asyncio
async def test_failed_end_keeps_request_and_does_not_block_another_session():
    first = make_session()
    first.end_when_finished = "working"
    second = replace(first, name="second", id="$2")
    terminate = AsyncMock(side_effect=[TmuxError("unavailable"), None])
    clock = [0.0]
    monitor = SessionCompletionMonitor(CompletionTmux(first), terminate, detector=CompletionDetector(), clock=lambda: clock[0])
    await monitor.check([first, second])
    clock[0] = 3
    await monitor.check([first, second])
    assert [call.args[0] for call in terminate.await_args_list] == [first, second]
    assert first.end_when_finished == "working"


def payload(session: Session, enabled: bool = True) -> dict:
    return {
        "sessionId": session.id, "sessionCreated": session.created,
        "serverStarted": session.server_started, "serverPid": session.server_pid, "enabled": enabled,
    }


@pytest.mark.asyncio
async def test_api_and_background_monitor_end_without_browser_and_preserve_history(monkeypatch):
    session = make_session()
    tmux = CompletionTmux(session)
    detector = CompletionDetector()
    detector.states["%1"] = AgentState("working", "Working")
    monkeypatch.setattr(app_module, "SUBMITTED_MESSAGE_POLL_SECONDS", 0.01)
    monkeypatch.setattr("tmux_console.session_completion.COMPLETION_SETTLE_SECONDS", 0.01)
    app = create_app(tmux=tmux, base_path="")
    app[SESSION_COMPLETION_KEY]._detector = detector
    async with TestClient(TestServer(app)) as client:
        response = await client.put("/api/sessions/task/end-when-finished", json=payload(session))
        assert response.status == 200
        assert await response.json() == {"endWhenFinished": True}
        assert session.end_when_finished == "working"
        assert tmux.terminate_calls == []
        detector.states["%1"] = AgentState("waiting_human", "Ready")
        async with asyncio.timeout(2):
            while not tmux.terminate_calls:
                await asyncio.sleep(0.01)
        assert tmux.terminate_calls == [("$1", 100, 90, 123)]
        history = app[SESSION_REGISTRY_KEY].history_for_identity("$1", 100, 90, 123)
        assert history["state"] == "ended"
        assert app[SESSION_REGISTRY_KEY].reconcile([], observed_at=200) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("change,status", [
    ({"enabled": "true"}, 400), ({"enabled": None}, 400),
    ({"sessionId": "$2"}, 409), ({"sessionCreated": 101}, 409),
    ({"serverStarted": 91}, 409), ({"serverPid": 124}, 409),
    ({"sessionCreated": True}, 400), ({"serverPid": 0}, 400),
    ({"sessionId": "$1; kill-server"}, 400), ({"unexpected": True}, 400),
])
async def test_api_rejects_invalid_or_stale_requests_without_arming(change, status):
    session = make_session()
    tmux = CompletionTmux(session)
    async with TestClient(TestServer(create_app(tmux=tmux, base_path=""))) as client:
        response = await client.put("/api/sessions/task/end-when-finished", json={**payload(session), **change})
        assert response.status == status
        assert session.end_when_finished == ""
        assert tmux.option_calls == tmux.terminate_calls == []
