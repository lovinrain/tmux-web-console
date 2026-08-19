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
    tmux.failing_history_actions.add("page-down")

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
            {"type": "historyAck", "action": "exit"},
        ]
        assert tmux.history_calls == [
            (4321, "$1", "page-up"),
            (4321, "$1", "page-down"),
            (4321, "$1", "exit"),
        ]

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
