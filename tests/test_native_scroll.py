from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import subprocess
import textwrap
import time

import pytest

from tmux_console.pty_bridge import PtyBridge
from tmux_console.tmux import TmuxClient, TmuxError


class RecordingScrollTmux(TmuxClient):
    def __init__(self, *, reject: bool = False) -> None:
        super().__init__()
        self.calls: list[list[str]] = []
        self.reject = reject

    async def run(self, args) -> str:
        self.calls.append(list(args))
        if args[0] == "list-clients":
            return "4321\t/dev/pts/7\t$7\n"
        if list(args[:2]) == ["show-options", "-gv"]:
            status = "rejected" if self.reject else "ok"
            return f"{status}:4321:$7:%12\n"
        return ""


@pytest.mark.parametrize(
    ("direction", "profile", "button"),
    [
        ("up", "wheel", 64),
        ("down", "wheel", 65),
        ("up", "alt-wheel", 72),
        ("down", "alt-wheel", 73),
    ],
)
async def test_application_scroll_encodes_only_allowed_wheel_profiles(
    monkeypatch, direction, profile, button
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    tmux = RecordingScrollTmux()

    assert (
        await tmux.navigate_application_scroll(4321, "$7", direction, profile) == "%12"
    )

    dispatch = next(call for call in tmux.calls if "if-shell" in call)
    condition, command = dispatch[6:8]
    assert "#{mouse_any_flag}" in condition
    assert "#{mouse_sgr_flag}" in condition
    assert "#{pane_input_off}" in condition
    assert "#{pane_dead}" in condition
    assert "copy-mode" in condition
    assert f"\\033[<{button};" in command
    assert "#{pane_width}" in command
    assert "#{pane_height}" in command
    assert "run-shell -C" in command
    assert "paste-buffer -r -d -b muxdeck-scroll-abc123" in command
    assert " -p " not in command
    assert "send-keys -H" not in command
    assert tmux.calls[-1] == ["delete-buffer", "-b", "muxdeck-scroll-abc123"]


@pytest.mark.parametrize(
    ("client_pid", "session_id", "direction", "profile"),
    [
        (False, "$7", "up", "wheel"),
        (0, "$7", "up", "wheel"),
        (4321, "name", "up", "wheel"),
        (4321, "$7", "UP", "wheel"),
        (4321, "$7", ["up"], "wheel"),
        (4321, "$7", "up", "raw"),
        (4321, "$7", "up", ["wheel"]),
    ],
)
async def test_application_scroll_rejects_invalid_requests_before_tmux(
    client_pid, session_id, direction, profile
):
    tmux = RecordingScrollTmux()
    with pytest.raises(ValueError):
        await tmux.navigate_application_scroll(
            client_pid, session_id, direction, profile
        )
    assert tmux.calls == []


async def test_application_scroll_rejection_cleans_private_resources(monkeypatch):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    tmux = RecordingScrollTmux(reject=True)
    with pytest.raises(TmuxError, match="SGR mouse reporting"):
        await tmux.navigate_application_scroll(4321, "$7", "up")
    assert tmux.calls[-2:] == [
        ["set-option", "-gu", "@muxdeck-history-abc123"],
        ["delete-buffer", "-b", "muxdeck-scroll-abc123"],
    ]


@pytest.mark.parametrize("changed", [False, True])
async def test_claude_retries_only_when_transcript_body_does_not_move(
    monkeypatch, changed
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    monkeypatch.setattr("tmux_console.tmux.CLAUDE_SCROLL_SETTLE_SECONDS", 0)
    before_lines = [f"row {index}" for index in range(35)]
    after_lines = before_lines.copy()
    # Header/composer/status changes do not count as transcript movement.
    after_lines[0] = "new header"
    after_lines[-1] = "new status"
    if changed:
        after_lines[10] = "new transcript row"

    class ClaudeTmux(RecordingScrollTmux):
        async def run(self, args):
            if args[0] == "show-buffer":
                self.calls.append(list(args))
                return "\n".join(before_lines) + "\n"
            if args[0] == "capture-pane":
                self.calls.append(list(args))
                return "\n".join(after_lines) + "\n"
            return await super().run(args)

    tmux = ClaudeTmux()
    assert await tmux.navigate_application_scroll(4321, "$7", "up", "claude") == "%12"
    dispatches = [call for call in tmux.calls if "if-shell" in call]
    assert len(dispatches) == (1 if changed else 2)
    assert "capture-pane -b muxdeck-scroll-abc123-before" in dispatches[0][7]
    if not changed:
        assert "#{==:#{pane_id},%12}" in dispatches[1][6]
        assert "capture-pane" not in dispatches[1][7]
    assert tmux.calls[-1] == ["delete-buffer", "-b", "muxdeck-scroll-abc123-before"]


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
@pytest.mark.parametrize("profile", ["wheel", "alt-wheel", "claude"])
async def test_real_application_scroll_uses_client_pane_without_leaking_input(
    tmp_path, profile
):
    socket_name = f"muxdeck-native-test-{os.getpid()}-{time.time_ns()}"
    command = ["tmux", "-L", socket_name, "-f", "/dev/null"]
    fixture = tmp_path / "record_input.py"
    fixture.write_text(
        "import os, signal, sys, tty\n"
        "tty.setraw(0)\n"
        "def legacy(*_): os.write(1, b'\\x1b[?1006l')\n"
        "def disabled(*_): os.write(1, b'\\x1b[?1000l')\n"
        "signal.signal(signal.SIGUSR1, legacy)\n"
        "signal.signal(signal.SIGUSR2, disabled)\n"
        "os.write(1, b'\\x1b[?1000h\\x1b[?1006h\\x1b[?2004h')\n"
        "os.write(1, b'\\r\\n'.join(b'HISTORY '+str(i).encode() "
        "for i in range(100)) + b'\\r\\nREADY\\r\\n')\n"
        "with open(sys.argv[1], 'ab', buffering=0) as log:\n"
        " while True:\n"
        "  data = os.read(0, 4096)\n"
        "  if not data: break\n"
        "  log.write(data)\n"
    )
    global_log = tmp_path / "global.bin"
    target_log = tmp_path / "target.bin"

    def tmux_run(*args):
        return subprocess.check_output([*command, *args], text=True).strip()

    async def wait_for(predicate):
        deadline = asyncio.get_running_loop().time() + 3
        while not predicate():
            if asyncio.get_running_loop().time() >= deadline:
                raise AssertionError("timed out waiting for isolated tmux fixture")
            await asyncio.sleep(0.01)

    bridge = None
    drain = None
    try:
        global_pane = tmux_run(
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            "native",
            "-x",
            "100",
            "-y",
            "40",
            "python3",
            str(fixture),
            str(global_log),
        )
        target_pane = tmux_run(
            "split-window",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            global_pane,
            "python3",
            str(fixture),
            str(target_log),
        )
        tmux_run("set-option", "-g", "prefix", "C-a")
        tmux_run("bind-key", "-T", "prefix", "o", "select-pane", "-t", target_pane)
        tmux_run("bind-key", "-T", "prefix", "p", "select-pane", "-t", global_pane)
        tmux_run(
            "bind-key",
            "-T",
            "prefix",
            "x",
            "set-option",
            "-gF",
            "@selected",
            "#{pane_id}",
        )
        tmux_run("bind-key", "-T", "root", "WheelUpPane", "send-keys", "WRONG_ROUTE")
        tmux_run("set-buffer", "-b", "user-buffer", "saved user text")
        bridge = await PtyBridge.attach(command, "=native", 100, 40)

        async def drain_output():
            while await bridge.read() is not None:
                pass

        drain = asyncio.create_task(drain_output())
        await wait_for(lambda: global_log.exists() and target_log.exists())
        await wait_for(
            lambda: (
                str(bridge.client_pid)
                in tmux_run("list-clients", "-F", "#{client_pid}")
            )
        )
        await bridge.write(b"\x01o")
        await asyncio.sleep(0.05)
        await bridge.write(b"\x01x")
        await wait_for(
            lambda: tmux_run("show-options", "-gqv", "@selected") == target_pane
        )
        assert (
            tmux_run(
                "list-panes",
                "-t",
                "=native",
                "-f",
                "#{pane_active}",
                "-F",
                "#{pane_id}",
            )
            == global_pane
        )
        session_id = tmux_run(
            "display-message", "-p", "-t", target_pane, "#{session_id}"
        )
        tmux = TmuxClient(socket_name=socket_name)
        width, height = map(
            int,
            tmux_run(
                "display-message",
                "-p",
                "-t",
                target_pane,
                "#{pane_width},#{pane_height}",
            ).split(","),
        )

        async def expect_wheel(direction):
            before = target_log.read_bytes()
            button = (64 if direction == "up" else 65) + (
                8 if profile == "alt-wheel" else 0
            )
            expected = (
                f"\x1b[<{button};{max(1, width - 1)};{max(1, height // 2)}M".encode()
            )
            if profile == "claude":
                # This recording app keeps the viewport unchanged, so the
                # production Claude path must perform its one allowed retry.
                expected *= 2
            assert (
                await tmux.navigate_application_scroll(
                    bridge.client_pid, session_id, direction, profile
                )
                == target_pane
            )
            await wait_for(
                lambda: len(target_log.read_bytes()) >= len(before) + len(expected)
            )
            assert target_log.read_bytes() == before + expected
            assert global_log.read_bytes() == b""

        for mouse in ("off", "on"):
            tmux_run("set-option", "-g", "mouse", mouse)
            await expect_wheel("up")
            await expect_wheel("down")

        for mode_keys in ("vi", "emacs"):
            tmux_run("set-option", "-w", "-t", target_pane, "mode-keys", mode_keys)
            tmux_run("copy-mode", "-u", "-t", target_pane)
            assert (
                tmux_run("display-message", "-p", "-t", target_pane, "#{pane_in_mode}")
                == "1"
            )
            await expect_wheel("up")
            assert (
                tmux_run("display-message", "-p", "-t", target_pane, "#{pane_in_mode}")
                == "0"
            )

        # Raw mouse input must not become bracketed-paste text or be broadcast
        # into the other pane when users have synchronized typing enabled.
        tmux_run("set-option", "-w", "-t", target_pane, "synchronize-panes", "on")
        await expect_wheel("down")
        assert tmux_run("show-buffer", "-b", "user-buffer") == "saved user text"
        assert tmux_run("list-buffers", "-F", "#{buffer_name}") == "user-buffer"
        assert "muxdeck-history-" not in tmux_run("list-keys", "-a")

        if profile == "claude":
            before_switch = target_log.read_bytes()
            in_flight = asyncio.create_task(
                tmux.navigate_application_scroll(
                    bridge.client_pid, session_id, "up", "claude"
                )
            )
            await wait_for(lambda: len(target_log.read_bytes()) > len(before_switch))
            await bridge.write(b"\x01p")
            await asyncio.sleep(0.03)
            with pytest.raises(TmuxError, match="retry cancelled"):
                await in_flight
            one_packet = f"\x1b[<64;{max(1, width - 1)};{max(1, height // 2)}M".encode()
            assert target_log.read_bytes() == before_switch + one_packet
            assert global_log.read_bytes() == b""
            await bridge.write(b"\x01o")
            await asyncio.sleep(0.03)

        before = target_log.read_bytes()
        tmux_run("select-pane", "-d", "-t", target_pane)
        with pytest.raises(TmuxError, match="SGR mouse reporting"):
            await tmux.navigate_application_scroll(
                bridge.client_pid, session_id, "up", profile
            )
        tmux_run("select-pane", "-e", "-t", target_pane)
        pid = int(tmux_run("display-message", "-p", "-t", target_pane, "#{pane_pid}"))
        os.kill(pid, signal.SIGUSR1)
        await wait_for(
            lambda: (
                tmux_run(
                    "display-message", "-p", "-t", target_pane, "#{mouse_sgr_flag}"
                )
                == "0"
            )
        )
        with pytest.raises(TmuxError, match="SGR mouse reporting"):
            await tmux.navigate_application_scroll(
                bridge.client_pid, session_id, "up", profile
            )
        os.kill(pid, signal.SIGUSR2)
        await wait_for(
            lambda: (
                tmux_run(
                    "display-message", "-p", "-t", target_pane, "#{mouse_any_flag}"
                )
                == "0"
            )
        )
        with pytest.raises(TmuxError, match="SGR mouse reporting"):
            await tmux.navigate_application_scroll(
                bridge.client_pid, session_id, "up", profile
            )
        assert target_log.read_bytes() == before
        assert global_log.read_bytes() == b""
        assert tmux_run("list-buffers", "-F", "#{buffer_name}") == "user-buffer"
    finally:
        if bridge is not None:
            await bridge.close()
        if drain is not None:
            await drain
        with contextlib.suppress(subprocess.CalledProcessError):
            tmux_run("kill-server")


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
async def test_claude_waits_for_pending_page_redraw_before_measuring_scroll(tmp_path):
    socket_name = f"muxdeck-page-redraw-test-{os.getpid()}-{time.time_ns()}"
    command = ["tmux", "-L", socket_name, "-f", "/dev/null"]
    state = tmp_path / "position.txt"
    events = tmp_path / "events.txt"
    fixture = tmp_path / "delayed_page.py"
    fixture.write_text(
        textwrap.dedent(r"""
        import os, pathlib, select, sys, time, tty
        tty.setraw(0)
        state, events = map(pathlib.Path, sys.argv[1:])
        position, pending, wheel_count = 100, None, 0
        def record(event):
            with events.open('a') as log:
                log.write(event + '\n')
        def render():
            os.write(1, f'\x1b[6;1HPOSITION {position:03d}\x1b[K'.encode())
            state.write_text(str(position))
        os.write(1, b'\x1b[?1000h\x1b[?1006h\x1b[2J')
        render()
        while True:
            ready, _, _ = select.select([0], [], [], .005)
            if ready:
                data = os.read(0, 4096)
                if b'\x1b[5~' in data:
                    pending = time.monotonic() + .10
                    record('page-received')
                for _ in range(data.count(b'\x1b[<64;')):
                    wheel_count += 1
                    record('wheel')
                    # Like Claude, discard the first direction-change packet.
                    if wheel_count > 1:
                        position -= 1
                        render()
            if pending is not None and time.monotonic() >= pending:
                position, pending = 76, None
                render()
                record('page-painted')
    """)
    )

    def tmux_run(*args):
        return subprocess.check_output([*command, *args], text=True).strip()

    async def wait_for(predicate):
        deadline = asyncio.get_running_loop().time() + 3
        while not predicate():
            assert asyncio.get_running_loop().time() < deadline
            await asyncio.sleep(0.005)

    bridge = None
    drain = None
    try:
        pane_id, session_id = tmux_run(
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}\t#{session_id}",
            "-s",
            "redraw",
            "-x",
            "100",
            "-y",
            "35",
            "python3",
            str(fixture),
            str(state),
            str(events),
        ).split("\t")
        bridge = await PtyBridge.attach(command, "=redraw", 100, 36)

        async def drain_output():
            while await bridge.read() is not None:
                pass

        drain = asyncio.create_task(drain_output())
        await wait_for(lambda: state.exists())
        await wait_for(
            lambda: (
                str(bridge.client_pid)
                in tmux_run("list-clients", "-F", "#{client_pid}")
            )
        )
        await bridge.write(b"\x1b[5~")
        await wait_for(
            lambda: events.exists() and "page-received" in events.read_text()
        )
        assert state.read_text() == "100"
        assert (
            await TmuxClient(socket_name=socket_name).navigate_application_scroll(
                bridge.client_pid, session_id, "up", "claude"
            )
            == pane_id
        )
        assert state.read_text() == "75"
        assert events.read_text().splitlines() == [
            "page-received",
            "page-painted",
            "wheel",
            "wheel",
        ]
        assert tmux_run("list-buffers", "-F", "#{buffer_name}") == ""
    finally:
        if bridge is not None:
            await bridge.close()
        if drain is not None:
            await drain
        with contextlib.suppress(subprocess.CalledProcessError):
            tmux_run("kill-server")
