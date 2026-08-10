from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

import pytest
from aiohttp import ClientResponse
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import app as app_module
from tmux_console.app import (
    SESSION_SNAPSHOTS_KEY,
    SESSION_STREAM_BROKER_KEY,
    SessionSnapshotBuilder,
    create_app,
)
from tmux_console.metadata import SessionTitleStore
from tmux_console.status import AgentState, AgentStateDetector
from tmux_console.tmux import Session, TmuxClient, TmuxError


def make_session(name: str = "agent-one") -> Session:
    return Session(
        name=name,
        id="$1",
        windows=1,
        attached=0,
        created=1_700_000_000,
        activity=1_700_000_100,
    )


def make_recreated_session(name: str = "agent-one") -> Session:
    session = make_session(name)
    session.id = "$2"
    return session


class FakeTmux(TmuxClient):
    def __init__(
        self, snapshots: list[list[Session] | TmuxError], delay: float = 0
    ) -> None:
        self._snapshots = iter(snapshots)
        self._last_snapshot: list[Session] = []
        self._delay = delay
        self.list_calls = 0
        self.active_calls = 0
        self.max_active_calls = 0

    async def list_sessions(self) -> list[Session]:
        self.list_calls += 1
        self.active_calls += 1
        self.max_active_calls = max(self.max_active_calls, self.active_calls)
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
            try:
                snapshot = next(self._snapshots)
            except StopIteration:
                pass
            else:
                if isinstance(snapshot, TmuxError):
                    raise snapshot
                self._last_snapshot = snapshot
            return list(self._last_snapshot)
        finally:
            self.active_calls -= 1


class FakeAgentStateDetector(AgentStateDetector):
    def __init__(self, snapshots: list[dict[str, AgentState]]) -> None:
        self._snapshots = iter(snapshots)
        self._last_snapshot: dict[str, AgentState] = {}

    async def detect_sessions(
        self, tmux: TmuxClient, sessions: list[Session]
    ) -> dict[str, AgentState]:
        del tmux
        try:
            self._last_snapshot = next(self._snapshots)
        except StopIteration:
            pass
        return {session.name: self._last_snapshot[session.name] for session in sessions}


def sequence_clock(*values: float) -> Callable[[], float]:
    iterator = iter(values)
    return lambda: next(iterator)


async def read_sse_record(response: ClientResponse) -> str:
    record = await asyncio.wait_for(response.content.readuntil(b"\n\n"), timeout=1)
    return record.decode("utf-8")


async def wait_until(predicate: Callable[[], bool], timeout: float = 1) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition was not met before timeout")
        await asyncio.sleep(0.005)


def event_payload(record: str) -> dict:
    lines = record.rstrip().splitlines()
    assert lines[0] == "event: sessions"
    assert lines[1].startswith("data: ")
    return json.loads(lines[1].removeprefix("data: "))


@pytest.mark.asyncio
async def test_sessions_api_tracks_state_changes_and_prunes_absent_sessions(tmp_path):
    session = make_session()
    tmux = FakeTmux([[session], [session], [session], [], [session]])
    detector = FakeAgentStateDetector(
        [
            {session.name: AgentState("working", "first observation")},
            {session.name: AgentState("working", "same state, new reason")},
            {session.name: AgentState("waiting_human", "needs input")},
            {},
            {session.name: AgentState("waiting_human", "seen again")},
        ]
    )
    titles = SessionTitleStore(tmp_path / "titles.json")
    application = create_app(
        tmux=tmux,
        titles=titles,
        agent_states=detector,
        base_path="",
    )
    application[SESSION_SNAPSHOTS_KEY] = SessionSnapshotBuilder(
        tmux,
        titles,
        detector,
        clock=sequence_clock(100.9, 200.1, 300.8, 400.2, 500.7),
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        first = (await (await client.get("/api/sessions")).json())["sessions"][0]
        unchanged = (await (await client.get("/api/sessions")).json())["sessions"][0]
        changed = (await (await client.get("/api/sessions")).json())["sessions"][0]
        absent = await (await client.get("/api/sessions")).json()
        reappeared = (await (await client.get("/api/sessions")).json())["sessions"][0]

        assert first["agentStateChangedAt"] == 100
        assert isinstance(first["agentStateChangedAt"], int)
        assert unchanged["agentState"] == "working"
        assert unchanged["agentStateReason"] == "same state, new reason"
        assert unchanged["agentStateChangedAt"] == 100
        assert changed["agentState"] == "waiting_human"
        assert changed["agentStateChangedAt"] == 300
        assert absent == {"sessions": []}
        assert reappeared["agentStateChangedAt"] == 500
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_snapshot_builder_serializes_concurrent_samples(tmp_path):
    session = make_session()
    tmux = FakeTmux([[session]], delay=0.02)
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("working", "active")}]
    )
    builder = SessionSnapshotBuilder(
        tmux,
        SessionTitleStore(tmp_path / "titles.json"),
        detector,
        clock=lambda: 100,
    )

    await asyncio.gather(builder.build(), builder.build())

    assert tmux.list_calls == 2
    assert tmux.max_active_calls == 1


@pytest.mark.asyncio
async def test_session_snapshot_builder_resets_timestamp_for_recreated_session(tmp_path):
    original = make_session()
    recreated = make_recreated_session()
    tmux = FakeTmux([[original], [recreated]])
    detector = FakeAgentStateDetector(
        [
            {original.name: AgentState("working", "active")},
            {recreated.name: AgentState("working", "still active")},
        ]
    )
    builder = SessionSnapshotBuilder(
        tmux,
        SessionTitleStore(tmp_path / "titles.json"),
        detector,
        clock=sequence_clock(100, 200),
    )

    first = (await builder.build())["sessions"][0]
    second = (await builder.build())["sessions"][0]

    assert first["agentStateChangedAt"] == 100
    assert second["agentStateChangedAt"] == 200


@pytest.mark.asyncio
async def test_sessions_stream_shares_one_sampler_across_clients_and_stops_last(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.2)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 0.01)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("working", "active")}]
    )
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    broker = application[SESSION_STREAM_BROKER_KEY]
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        first_response, second_response = await asyncio.gather(
            client.get("/api/sessions/stream"),
            client.get("/api/sessions/stream"),
        )
        first, second = await asyncio.gather(
            read_sse_record(first_response),
            read_sse_record(second_response),
        )

        assert event_payload(first) == event_payload(second)
        assert tmux.list_calls == 1
        assert broker.subscriber_count == 2
        sampler = broker.sampler_task
        assert sampler is not None
        assert not sampler.done()

        first_response.close()
        await wait_until(lambda: broker.subscriber_count == 1)
        assert broker.sampler_task is sampler
        assert not sampler.done()

        second_response.close()
        await wait_until(lambda: broker.subscriber_count == 0)
        assert broker.sampler_task is None
        assert sampler.done()
        calls_after_disconnect = tmux.list_calls
        await asyncio.sleep(0.03)
        assert tmux.list_calls == calls_after_disconnect
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_stream_recovers_after_tmux_error(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 1)
    session = make_session()
    tmux = FakeTmux([TmuxError("temporary tmux failure"), [session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("waiting_human", "needs input")}]
    )
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        payload = event_payload(await read_sse_record(response))
        assert response.status == 200
        assert payload["sessions"][0]["agentState"] == "waiting_human"
        assert tmux.list_calls >= 2
        response.close()
        await wait_until(
            lambda: application[SESSION_STREAM_BROKER_KEY].sampler_task is None
        )
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_application_cleanup_cancels_active_session_sampler(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 10)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 10)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("working", "active")}]
    )
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    broker = application[SESSION_STREAM_BROKER_KEY]
    client = TestClient(TestServer(application))
    await client.start_server()
    response = await client.get("/api/sessions/stream")
    event_payload(await read_sse_record(response))
    sampler = broker.sampler_task
    assert sampler is not None

    await client.close()

    assert broker.closed
    assert broker.subscriber_count == 0
    assert broker.sampler_task is None
    assert sampler.done()
    assert not any(
        task.get_name() == "muxdeck-session-sampler" and not task.done()
        for task in asyncio.all_tasks()
    )


@pytest.mark.asyncio
async def test_sessions_stream_sends_initial_and_changed_snapshots(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 1)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [
            {session.name: AgentState("working", "active")},
            {session.name: AgentState("waiting_human", "needs input")},
        ]
    )
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=SessionTitleStore(tmp_path / "titles.json"),
                agent_states=detector,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        assert response.status == 200
        assert response.headers["Content-Type"].startswith("text/event-stream")
        assert response.headers["Cache-Control"] == "no-cache, no-transform"
        assert response.headers["X-Accel-Buffering"] == "no"

        initial = event_payload(await read_sse_record(response))
        changed = event_payload(await read_sse_record(response))
        assert initial["sessions"][0]["agentState"] == "working"
        assert changed["sessions"][0]["agentState"] == "waiting_human"
        assert changed["sessions"][0]["agentStateChangedAt"] >= initial["sessions"][0][
            "agentStateChangedAt"
        ]
        response.close()
        await asyncio.sleep(0.03)
        calls_after_disconnect = tmux.list_calls
        await asyncio.sleep(0.03)
        assert tmux.list_calls == calls_after_disconnect
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_stream_suppresses_unchanged_events_and_heartbeats(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 0.04)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("working", "active")}]
    )
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=SessionTitleStore(tmp_path / "titles.json"),
                agent_states=detector,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        event_payload(await read_sse_record(response))
        heartbeat = await read_sse_record(response)
        assert heartbeat == ": heartbeat\n\n"
        assert tmux.list_calls >= 2
        response.close()
    finally:
        await client.close()
