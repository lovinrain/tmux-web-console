from __future__ import annotations

import errno
from unittest.mock import Mock

import pytest

from tmux_console import pty_bridge as pty_bridge_module
from tmux_console.pty_bridge import PtyBridge, build_attach_args, clamp_size


def make_bare_bridge(*, closed: bool = False) -> tuple[PtyBridge, Mock]:
    bridge = PtyBridge.__new__(PtyBridge)
    bridge.master_fd = 123
    bridge.closed = closed

    def finish() -> None:
        bridge.closed = True

    finish_mock = Mock(side_effect=finish)
    bridge._finish = finish_mock
    return bridge, finish_mock


def test_attach_uses_stable_target_and_no_shell():
    args = build_attach_args(["/usr/bin/tmux"], "$42")
    assert args == [
        "/usr/bin/tmux",
        "attach-session",
        "-E",
        "-f",
        "active-pane",
        "-t",
        "$42",
    ]


def test_ignore_size_is_an_explicit_client_flag():
    args = build_attach_args(["tmux", "-L", "isolated-test"], "$9", ignore_size=True)
    assert args[6] == "active-pane,ignore-size"


def test_terminal_size_is_clamped():
    assert clamp_size(1, 1) == (20, 5)
    assert clamp_size(1000, 1000) == (500, 200)
    assert clamp_size(120, 40) == (120, 40)


def test_resize_updates_the_pty_and_notifies_the_tmux_client(monkeypatch):
    bridge, _finish = make_bare_bridge()
    bridge.process = Mock(pid=456)
    set_window_size = Mock()
    killpg = Mock()
    monkeypatch.setattr(pty_bridge_module, "set_window_size", set_window_size)
    monkeypatch.setattr(pty_bridge_module.os, "killpg", killpg)

    bridge.resize(120, 48)

    set_window_size.assert_called_once_with(123, 120, 48)
    killpg.assert_called_once_with(456, pty_bridge_module.signal.SIGWINCH)


@pytest.mark.asyncio
async def test_write_retries_interrupts_and_backpressure_until_complete(monkeypatch):
    bridge, finish = make_bare_bridge()
    outcomes: list[BaseException | int] = [
        BlockingIOError(),
        InterruptedError(),
        2,
        3,
    ]
    attempted: list[bytes] = []

    def fake_write(fd: int, data: memoryview) -> int:
        assert fd == 123
        attempted.append(bytes(data))
        outcome = outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(pty_bridge_module.os, "write", fake_write)

    assert await bridge.write(b"hello") is True
    assert attempted == [b"hello", b"hello", b"hello", b"llo"]
    assert outcomes == []
    finish.assert_not_called()


@pytest.mark.asyncio
async def test_write_returns_false_if_bridge_closes_after_partial_write(monkeypatch):
    bridge, finish = make_bare_bridge()

    def partial_then_close(_fd: int, _data: memoryview) -> int:
        bridge.closed = True
        return 2

    monkeypatch.setattr(pty_bridge_module.os, "write", partial_then_close)

    assert await bridge.write(b"hello") is False
    finish.assert_not_called()


@pytest.mark.asyncio
async def test_write_returns_false_and_finishes_after_partial_os_error(monkeypatch):
    bridge, finish = make_bare_bridge()
    outcomes: list[BaseException | int] = [2, OSError(errno.EIO, "pty closed")]

    def fake_write(_fd: int, _data: memoryview) -> int:
        outcome = outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(pty_bridge_module.os, "write", fake_write)

    assert await bridge.write(b"hello") is False
    finish.assert_called_once_with()
    assert bridge.closed is True


@pytest.mark.asyncio
async def test_write_treats_zero_byte_write_as_closed_instead_of_spinning(monkeypatch):
    bridge, finish = make_bare_bridge()
    write = Mock(return_value=0)
    monkeypatch.setattr(pty_bridge_module.os, "write", write)

    assert await bridge.write(b"hello") is False
    write.assert_called_once()
    finish.assert_called_once_with()
    assert bridge.closed is True


@pytest.mark.asyncio
async def test_write_rejects_data_when_already_closed(monkeypatch):
    bridge, finish = make_bare_bridge(closed=True)
    write = Mock()
    monkeypatch.setattr(pty_bridge_module.os, "write", write)

    assert await bridge.write(b"hello") is False
    write.assert_not_called()
    finish.assert_not_called()
