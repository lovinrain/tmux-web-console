from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.pty_bridge import PtyBridge
from tmux_console.tmux import Session, TmuxClient


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

    async def get_session(self, name: str) -> Session:
        assert name == self.session.name
        return self.session


class FakePtyBridge:
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

        await websocket.send_json(
            {"type": "input", "id": "wrong-data", "data": 123}
        )
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
