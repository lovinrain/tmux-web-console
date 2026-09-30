"""Real tmux protocol checks using only disposable servers and fake agents."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import shlex
import shutil
import sys

import pytest
import pytest_asyncio

from tmux_console.tmux import (
    CreatedSession,
    TmuxClient,
    TmuxError,
    TmuxPaneInputUnavailableError,
    TmuxSessionIdentityChangedError,
)

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")


@pytest_asyncio.fixture
async def disposable_tmux():
    socket = f"muxdeck-orchestration-test-{os.getpid()}-{secrets.token_hex(8)}"
    client = TmuxClient(socket_name=socket)
    # Ignore the user's configuration and start a guaranteed shell, never an agent.
    await client.run(["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", "/bin/sh"])
    try:
        yield client
    finally:
        with contextlib.suppress(TmuxError):
            await client.run(["kill-server"])


def identity(created: CreatedSession):
    return {
        "session_id": created.id, "session_created": created.session_created,
        "server_started": created.server_started, "server_pid": created.server_pid,
        "pane_id": created.pane_id, "pane_pid": created.pane_pid,
    }


async def wait_until(predicate):
    for _ in range(100):
        result = await predicate()
        if result:
            return result
        await asyncio.sleep(0.02)
    raise AssertionError("fake agent did not reach expected state")


async def test_literal_command_environment_and_fast_exit_are_preserved(disposable_tmux, tmp_path):
    client = disposable_tmux
    output = tmp_path / "result.json"
    forbidden = tmp_path / "must-not-exist"
    arguments = [
        "", "hello world", "'quote'", ";", "line\nnext", "#{session_name}",
        f"$(touch {forbidden})", f"#(touch {forbidden})",
    ]
    environment = {"TASK_LITERAL": "#{session_name} $(false);", "EMPTY": ""}
    code = (
        "import json,os,sys,pathlib; "
        "pathlib.Path(sys.argv[1]).write_text(json.dumps([sys.argv[2:], os.environ['TASK_LITERAL'], os.environ['EMPTY']])); "
        "print('FAKE_AGENT_✅_DONE 尾',flush=True); sys.exit(17)"
    )
    created = await client.create_session(
        "literal", start_directory=str(tmp_path), launch_mode="command",
        command=[sys.executable, "-c", code, str(output), *arguments], environment=environment,
    )

    async def dead_pane():
        session = await client.get_session(created.name)
        pane = session.active_pane
        return pane if pane.dead and pane.exit_status is not None else None

    try:
        pane = await wait_until(dead_pane)
    except AssertionError:
        details = await client.run([
            "display-message", "-p", "-t", created.pane_id,
            "status=#{pane_dead_status} signal=#{pane_dead_signal} command=#{pane_start_command}",
        ])
        raise AssertionError(details + await client.capture_visible(created.pane_id)) from None
    assert pane.exit_status == 17
    assert json.loads(output.read_text()) == [arguments, environment["TASK_LITERAL"], ""]
    assert not forbidden.exists()
    assert (await client.run(["show-options", "-gwv", "remain-on-exit"])).strip() == "off"
    capture = await client.capture_pane(created.name, **identity(created), lines=40)
    assert capture["exitStatus"] == 17
    assert "FAKE_AGENT_✅_DONE 尾" in capture["text"]
    with pytest.raises(TmuxPaneInputUnavailableError, match="dead"):
        await client.send_pane_input(created.name, **identity(created), text="do not execute")


async def test_programmatic_shell_overrides_default_command(disposable_tmux, tmp_path):
    client = disposable_tmux
    forbidden = tmp_path / "default-agent-was-launched"
    await client.run(["set-option", "-g", "default-command", f"touch {forbidden}"])
    created = await client.create_session("shell", launch_mode="shell", start_directory=str(tmp_path))
    session = await client.get_session(created.name)
    assert not session.active_pane.dead
    assert session.active_pane.path == str(tmp_path)
    assert not forbidden.exists()


async def test_final_guard_rejects_respawn_between_lookup_and_dispatch(disposable_tmux, tmp_path):
    class ReplacingTmux(TmuxClient):
        replaced = False

        async def run(self, args):
            if args[0] == "if-shell" and not self.replaced:
                self.replaced = True
                await super().run(["respawn-pane", "-k", "-t", args[3], "/bin/sh"])
            return await super().run(args)

    client = ReplacingTmux(socket_name=disposable_tmux.socket_name)
    created = await client.create_session("replace-at-dispatch", launch_mode="shell", start_directory=str(tmp_path))
    with pytest.raises(TmuxSessionIdentityChangedError):
        await client.send_pane_input(created.name, **identity(created), text="never send to replacement", submit=True)
    session = await client.get_session(created.name)
    assert session.active_pane.process_pid != created.pane_pid
    assert not session.active_pane.dead
    assert "never send to replacement" not in await client.capture_visible(created.pane_id)
    assert (await client.run(["list-buffers", "-F", "#{buffer_name}"])).strip() == ""


async def test_paste_serialization_copy_mode_and_respawn_fences(disposable_tmux, tmp_path):
    client = disposable_tmux
    recorded = tmp_path / "input.bin"
    code = (
        "import os,sys,tty,pathlib; tty.setraw(0); "
        "sys.stdout.write('\\x1b[?2004hREADY\\n'); sys.stdout.flush(); "
        "f=open(sys.argv[1],'ab',buffering=0); "
        "exec('while True:\\n data=os.read(0,65536)\\n f.write(data)')"
    )
    created = await client.create_session(
        "recorder", launch_mode="command", start_directory=str(tmp_path),
        command=[sys.executable, "-c", code, str(recorded)],
    )

    async def ready():
        return "READY" in (await client.capture_pane(created.name, **identity(created)))["text"]

    await wait_until(ready)
    before = await client.get_session(created.name)
    assert before.active_pane.command.startswith("python")
    submissions = ["first\nsecond", "third ' $(literal);\nfourth"]
    with pytest.raises(ValueError, match="allowMultiline"):
        await client.send_pane_input(created.name, **identity(created), text=submissions[0])
    assert recorded.read_bytes() == b""
    await asyncio.gather(*(
        client.send_pane_input(created.name, **identity(created), text=text, submit=True, allow_multiline=True)
        for text in submissions
    ))
    expected = [b"\x1b[200~" + text.replace("\n", "\r").encode() + b"\x1b[201~\r" for text in submissions]

    async def received():
        return recorded.exists() and recorded.stat().st_size >= sum(map(len, expected))

    await wait_until(received)
    assert recorded.read_bytes() in (b"".join(expected), b"".join(reversed(expected)))
    after = await client.get_session(created.name)
    assert (before.active_pane.width, before.active_pane.height, before.attached) == (
        after.active_pane.width, after.active_pane.height, after.attached,
    )
    other_log = tmp_path / "other-input.bin"
    other_pane = (await client.run([
        "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", created.pane_id,
        shlex.join([sys.executable, "-c", code, str(other_log)]),
    ])).strip()

    async def other_ready():
        return "READY" in await client.capture_visible(other_pane)

    await wait_until(other_ready)
    await client.run(["set-option", "-w", "-t", created.pane_id, "synchronize-panes", "on"])
    await client.send_pane_input(created.name, **identity(created), keys=["C-c", "Enter"])

    async def keys_received():
        return recorded.read_bytes().endswith(b"\x03\r")

    await wait_until(keys_received)
    assert other_log.read_bytes() == b""
    sent = recorded.read_bytes()
    await client.run(["set-option", "-p", "-t", created.pane_id, "@muxdeck_input_owner", "stdio"])
    with pytest.raises(TmuxPaneInputUnavailableError, match="stdio"):
        await client.send_pane_input(created.name, **identity(created), text="reserved")
    await client.run(["set-option", "-pu", "-t", created.pane_id, "@muxdeck_input_owner"])
    await client.run(["select-pane", "-d", "-t", created.pane_id])
    with pytest.raises(TmuxPaneInputUnavailableError):
        await client.send_pane_input(created.name, **identity(created), keys=["Enter"])
    await client.run(["select-pane", "-e", "-t", created.pane_id])
    await client.run(["copy-mode", "-t", created.pane_id])
    with pytest.raises(TmuxPaneInputUnavailableError):
        await client.send_pane_input(created.name, **identity(created), text="blocked")
    assert recorded.read_bytes() == sent
    assert (await client.run(["display-message", "-p", "-t", created.pane_id, "#{pane_mode}"])).strip() == "copy-mode"
    await client.run(["send-keys", "-X", "-t", created.pane_id, "cancel"])
    await client.run(["respawn-pane", "-k", "-t", created.pane_id, "/bin/sh"])
    with pytest.raises(TmuxSessionIdentityChangedError):
        await client.send_pane_input(created.name, **identity(created), text="stale")
    with pytest.raises(TmuxSessionIdentityChangedError):
        await client.capture_pane(created.name, **identity(created))
    assert (await client.run(["list-buffers", "-F", "#{buffer_name}"])).strip() == ""
