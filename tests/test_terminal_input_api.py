from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import WSMsgType, WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.pty_bridge import PtyBridge
from tmux_console.tmux import Session, TmuxClient, TmuxError


class FakeTerminalTmux(TmuxClient):
    def __init__(self) -> None:
        super().__init__(binary="unused-tmux")
        self.session = Session(
            name="agent",
            id="$1",
            windows=1,
            attached=0,
            created=1_700_000_000,
        )
        self.history_calls: list[tuple[int, str, str]] = []
        self.failing_history_actions: set[str] = set()
        self.get_session_calls = 0
        self.application_scroll_calls: list[tuple[int, str, str, str]] = []
        self.scroll_verifications: list[tuple[str | None, bool]] = []

    async def get_session(self, name: str) -> Session:
        self.get_session_calls += 1
        assert name == self.session.name
        return self.session

    async def navigate_history(
        self, client_pid: int, session_id: str, action: str
    ) -> str:
        self.history_calls.append((client_pid, session_id, action))
        if action in self.failing_history_actions:
            raise TmuxError("history navigation failed")
        return "%9"

    async def navigate_application_scroll(
        self, client_pid: int, session_id: str, direction: str, profile: str = "wheel",
        *, expected_pane: str | None = None, verify_movement: bool = True,
    ) -> str:
        self.application_scroll_calls.append((client_pid, session_id, direction, profile))
        self.scroll_verifications.append((expected_pane, verify_movement))
        if direction == "down":
            raise TmuxError("mouse reporting disabled")
        return "%9"


class FakePtyBridge:
    client_pid = 4321

    def __init__(self, write_results: list[bool]) -> None:
        self._write_results = iter(write_results)
        self._output_ready = asyncio.Event()
        self.writes: list[bytes] = []
        self.close_calls = 0

    async def read(self) -> bytes | None:
        await self._output_ready.wait()
        return None

    async def write(self, data: bytes) -> bool:
        self.writes.append(data)
        return next(self._write_results)

    def resize(self, _cols: int, _rows: int) -> None:
        pass

    async def close(self) -> None:
        self.close_calls += 1


@pytest.mark.asyncio
async def test_terminal_input_nacks_invalid_or_incomplete_writes_without_disconnect(
    monkeypatch,
):
    bridge = FakePtyBridge([False, True])

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(create_app(tmux=FakeTerminalTmux(), base_path="")))

    try:
        await client.start_server()
        websocket = await client.ws_connect("/ws/terminal?session=agent")
        ready = await websocket.receive_json()
        assert ready["type"] == "ready"

        # Frames without a usable correlation ID are intentionally ignored.
        await websocket.send_str("{")
        await websocket.send_str("[]")
        await websocket.send_json({"type": "input", "id": "", "data": "ignored"})

        await websocket.send_json({"type": "input", "id": "wrong-data", "data": 123})
        await websocket.send_str(
            json.dumps({"type": "input", "id": "bad-unicode", "data": "\ud800"})
        )
        await websocket.send_json(
            {"type": "input", "id": "closed-write", "data": "rejected"}
        )
        await websocket.send_json(
            {"type": "input", "id": "complete-write", "data": "accepted"}
        )

        responses = []
        for _ in range(4):
            message = await asyncio.wait_for(websocket.receive(), timeout=1)
            assert message.type == WSMsgType.TEXT
            responses.append(json.loads(message.data))

        assert responses == [
            {"type": "inputNack", "id": "wrong-data"},
            {"type": "inputNack", "id": "bad-unicode"},
            {"type": "inputNack", "id": "closed-write"},
            {"type": "inputAck", "id": "complete-write"},
        ]
        assert bridge.writes == [b"rejected", b"accepted"]
        assert not websocket.closed
        await websocket.close()
    finally:
        await client.close()

    assert bridge.close_calls == 1


@pytest.mark.asyncio
async def test_terminal_history_validates_actions_uses_stable_id_and_nacks_without_disconnect(
    monkeypatch,
):
    bridge = FakePtyBridge([True])
    tmux = FakeTerminalTmux()
    tmux.failing_history_actions.update({"page-down", "line-down"})

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        websocket = await client.ws_connect("/ws/terminal?session=agent")
        ready = await websocket.receive_json()
        assert ready["type"] == "ready"

        requests = [
            {"type": "history", "action": "page-up"},
            {"type": "history", "action": "PAGE-UP"},
            {"type": "history"},
            {"type": "history", "action": 1},
            {"type": "history", "action": ["page-up"]},
            {"type": "history", "action": "page-down"},
            {"type": "history", "action": "line-up"},
            {"type": "history", "action": "line-down"},
            {"type": "history", "action": "exit"},
        ]
        for request in requests:
            await websocket.send_json(request)

        responses = []
        for _ in requests:
            message = await asyncio.wait_for(websocket.receive(), timeout=1)
            assert message.type == WSMsgType.TEXT
            responses.append(json.loads(message.data))

        assert responses == [
            {"type": "historyAck", "action": "page-up"},
            {"type": "historyNack", "action": "PAGE-UP"},
            {"type": "historyNack", "action": None},
            {"type": "historyNack", "action": 1},
            {"type": "historyNack", "action": ["page-up"]},
            {"type": "historyNack", "action": "page-down"},
            {"type": "historyAck", "action": "line-up"},
            {"type": "historyNack", "action": "line-down"},
            {"type": "historyAck", "action": "exit"},
        ]
        assert tmux.history_calls == [
            (4321, "$1", "page-up"),
            (4321, "$1", "page-down"),
            (4321, "$1", "line-up"),
            (4321, "$1", "line-down"),
            (4321, "$1", "exit"),
        ]
        assert bridge.writes == []

        await websocket.send_json(
            {"type": "input", "id": "still-connected", "data": "accepted"}
        )
        assert await websocket.receive_json() == {
            "type": "inputAck",
            "id": "still-connected",
        }
        assert bridge.writes == [b"accepted"]
        assert not websocket.closed
        await websocket.close()
    finally:
        await client.close()

    assert bridge.close_calls == 1


@pytest.mark.asyncio
async def test_application_scroll_validates_profiles_and_reports_guard_rejection(monkeypatch):
    bridge = FakePtyBridge([True])
    tmux = FakeTerminalTmux()

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    try:
        await client.start_server()
        ws = await client.ws_connect("/ws/terminal?session=agent")
        assert (await ws.receive_json())["type"] == "ready"
        cases = [
            ("copilot", "up", "applicationScrollAck"),
            ("claude", "up", "applicationScrollAck"),
            ("codex", "up", "applicationScrollAck"),
            ("codex", "down", "applicationScrollNack"),
            ("grok", "up", "applicationScrollAck"),
            ("grok", "down", "applicationScrollNack"),
            ("wheel", "up", "applicationScrollAck"),
            ("wheel", "down", "applicationScrollNack"),
            ("shell", "up", "applicationScrollNack"),
            (["claude"], "up", "applicationScrollNack"),
            ("claude", ["up"], "applicationScrollNack"),
        ]
        for index, (profile, direction, expected) in enumerate(cases):
            await ws.send_json({
                "type": "applicationScroll", "id": str(index),
                "profile": profile, "direction": direction,
            })
            response = await asyncio.wait_for(ws.receive_json(), 1)
            assert response["type"] == expected
            assert response["id"] == str(index)
            if expected == "applicationScrollAck":
                assert response["paneId"] == "%9"
            else:
                assert response["message"]
                if profile == "codex":
                    assert "Ctrl+T" in response["message"]
                    assert "tmux controls" in response["message"]
        assert tmux.application_scroll_calls == [
            (4321, "$1", "up", "alt-wheel"),
            (4321, "$1", "up", "claude"),
            (4321, "$1", "up", "codex"),
            (4321, "$1", "down", "codex"),
            (4321, "$1", "up", "wheel"),
            (4321, "$1", "down", "wheel"),
            (4321, "$1", "up", "wheel"),
            (4321, "$1", "down", "wheel"),
        ]
        assert bridge.writes == []
        await ws.send_json({"type": "input", "id": "still-live", "data": "kept"})
        assert await ws.receive_json() == {"type": "inputAck", "id": "still-live"}
        await ws.close()
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("interrupt", [
    "binary", "input", "resize", "history", "profile", "expired", "direction", "malformed", "reconnect",
])
async def test_claude_continuations_reset_after_intervening_activity(monkeypatch, interrupt):
    bridge = FakePtyBridge([True])
    tmux = FakeTerminalTmux()

    async def fake_attach(cls, *_args, **_kwargs):
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    try:
        await client.start_server()
        ws = await client.ws_connect("/ws/terminal?session=agent")
        assert (await ws.receive_json())["type"] == "ready"

        async def scroll(profile="claude", direction="up"):
            await ws.send_json({"type": "applicationScroll", "id": "step", "profile": profile, "direction": direction})
            return await ws.receive_json()

        assert (await scroll())["type"] == "applicationScrollAck"
        assert (await scroll())["type"] == "applicationScrollAck"
        assert tmux.scroll_verifications == [(None, True), ("%9", False)]

        if interrupt == "binary":
            await ws.send_bytes(b"draft")
        elif interrupt == "input":
            await ws.send_json({"type": "input", "id": "input", "data": "draft"})
            assert (await ws.receive_json())["type"] == "inputAck"
        elif interrupt == "resize":
            await ws.send_json({"type": "resize", "cols": 100, "rows": 35})
        elif interrupt == "history":
            await ws.send_json({"type": "history", "action": "exit"})
            assert (await ws.receive_json())["type"] == "historyAck"
        elif interrupt == "profile":
            assert (await scroll("wheel"))["type"] == "applicationScrollAck"
        elif interrupt == "expired":
            monkeypatch.setattr("tmux_console.app.CLAUDE_SCROLL_CONTINUATION_SECONDS", 0)
        elif interrupt == "direction":
            assert (await scroll(direction="down"))["type"] == "applicationScrollNack"
            assert tmux.scroll_verifications[-1] == (None, True)
        elif interrupt == "malformed":
            await ws.send_str("{")
        elif interrupt == "reconnect":
            await ws.close()
            ws = await client.ws_connect("/ws/terminal?session=agent")
            assert (await ws.receive_json())["type"] == "ready"

        assert (await scroll())["type"] == "applicationScrollAck"
        assert tmux.scroll_verifications[-1] == (None, True)
        await ws.close()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_failed_claude_continuation_does_not_warm_another_request(monkeypatch):
    class RejectingContinuationTmux(FakeTerminalTmux):
        async def navigate_application_scroll(self, *args, **kwargs):
            result = await super().navigate_application_scroll(*args, **kwargs)
            if kwargs.get("verify_movement") is False:
                raise TmuxError("active pane changed")
            return result

    bridge = FakePtyBridge([])
    tmux = RejectingContinuationTmux()

    async def fake_attach(cls, *_args, **_kwargs):
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    try:
        await client.start_server()
        ws = await client.ws_connect("/ws/terminal?session=agent")
        await ws.receive_json()
        for expected in ["applicationScrollAck", "applicationScrollNack", "applicationScrollAck"]:
            await ws.send_json({"type": "applicationScroll", "id": "step", "profile": "claude", "direction": "up"})
            assert (await ws.receive_json())["type"] == expected
        assert tmux.scroll_verifications == [(None, True), ("%9", False), (None, True)]
        assert bridge.writes == []
        await ws.close()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminal_websocket_rejects_cross_site_origin_before_tmux_lookup():
    tmux = FakeTerminalTmux()
    client = TestClient(
        TestServer(create_app(tmux=tmux, base_path="", trusted_origins=()))
    )

    try:
        await client.start_server()
        with pytest.raises(WSServerHandshakeError) as error:
            await client.ws_connect(
                "/ws/terminal?session=agent",
                headers={"Origin": "https://attacker.example"},
            )
        assert error.value.status == 403
        assert tmux.get_session_calls == 0
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminal_websocket_accepts_configured_reverse_proxy_origin(monkeypatch):
    bridge = FakePtyBridge([])

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    monkeypatch.setenv(
        "MUXDECK_TRUSTED_ORIGINS", "https://console.example.test"
    )
    client = TestClient(TestServer(create_app(tmux=FakeTerminalTmux(), base_path="")))

    try:
        await client.start_server()
        websocket = await client.ws_connect(
            "/ws/terminal?session=agent",
            headers={
                "Host": "console.example.test",
                "Origin": "https://console.example.test",
            },
        )
        assert (await websocket.receive_json())["type"] == "ready"
        await websocket.close()
    finally:
        await client.close()

    assert bridge.close_calls == 1
