import asyncio

import pytest

from tmux_console.app import _close_terminal_bridge
from tmux_console.pty_bridge import PtyBridge


class FakeBridge(PtyBridge):
    def __init__(self) -> None:
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


@pytest.mark.asyncio
async def test_terminal_cleanup_closes_bridge_after_connection_reset():
    async def failed_sender() -> None:
        raise ConnectionResetError("client disconnected")

    sender = asyncio.create_task(failed_sender())
    await asyncio.sleep(0)
    bridge = FakeBridge()

    await _close_terminal_bridge(sender, bridge)

    assert sender.done()
    assert bridge.close_calls == 1


@pytest.mark.asyncio
async def test_terminal_cleanup_cancels_pending_sender_and_closes_bridge():
    sender_started = asyncio.Event()

    async def pending_sender() -> None:
        sender_started.set()
        await asyncio.Event().wait()

    sender = asyncio.create_task(pending_sender())
    await sender_started.wait()
    bridge = FakeBridge()

    await _close_terminal_bridge(sender, bridge)

    assert sender.cancelled()
    assert bridge.close_calls == 1


@pytest.mark.asyncio
async def test_terminal_cleanup_closes_bridge_without_hiding_unexpected_failure():
    async def failed_sender() -> None:
        raise RuntimeError("unexpected sender failure")

    sender = asyncio.create_task(failed_sender())
    await asyncio.sleep(0)
    bridge = FakeBridge()

    with pytest.raises(RuntimeError, match="unexpected sender failure"):
        await _close_terminal_bridge(sender, bridge)

    assert bridge.close_calls == 1
