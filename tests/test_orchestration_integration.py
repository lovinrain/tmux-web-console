"""Exercise authenticated HTTP orchestration against a disposable real tmux server."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.control_auth import provision_control_token_file
from tmux_console.tmux import TmuxClient, TmuxError

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")

IDENTITY_FIELDS = (
    "sessionId", "sessionCreated", "serverStarted", "serverPid", "paneId", "panePid",
)


async def wait_for_capture(client, name, identity, headers, predicate):
    deadline = asyncio.get_running_loop().time() + 5
    latest = None
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(
            f"/mux/api/sessions/{name}/capture", params={**identity, "lines": 100}, headers=headers,
        )
        assert response.status == 200, await response.text()
        latest = await response.json()
        if predicate(latest):
            return latest
        await asyncio.sleep(0.025)
    raise AssertionError(f"fake agent did not reach expected state: {latest}")


async def test_private_http_launch_workspace_capture_and_input_use_real_tmux(tmp_path: Path):
    socket = f"muxdeck-orchestration-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    credentials = tmp_path / "auth.json"
    provision_auth_file(credentials, "integration-user", "integration-private-password")
    control_path = tmp_path / "control-token"
    callback_path = tmp_path / "callback-token"
    provision_control_token_file(control_path)
    provision_control_token_file(callback_path)
    headers = {"Authorization": "Bearer " + control_path.read_text().strip()}
    callback_headers = {"Authorization": "Bearer " + callback_path.read_text().strip()}

    fake = tmp_path / "fake_agent.py"
    fake.write_text(
        "import json, os, sys\n"
        "print('READY', flush=True)\n"
        "text = sys.stdin.readline().rstrip('\\n')\n"
        "print('RESULT ' + json.dumps({'cwd': os.getcwd(), "
        "'environment': os.environ['MUXDECK_FAKE_LITERAL'], "
        "'argument': sys.argv[1], 'text': text}, ensure_ascii=False), flush=True)\n"
        "sys.exit(7)\n",
        encoding="utf-8",
    )
    forbidden = tmp_path / "must-not-exist"
    literal = f"$(touch {forbidden}); #(touch {forbidden}) '#{{session_name}}'"
    command = [sys.executable, "-X", "utf8", str(fake), literal]
    launch_request = {
        "name": "epic-worker", "directory": str(tmp_path), "launchMode": "command",
        "command": command, "environment": {"MUXDECK_FAKE_LITERAL": literal},
        "requestId": "integration-worker-launch",
    }

    try:
        # This private bootstrap bypasses user tmux config; it has no agent or attached client.
        await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", "/bin/sh"])
        app = create_app(
            tmux=tmux, base_path="/mux", auth=AuthStore(credentials), auth_mode="server",
            auth_cookie_secure=False, control_token_file=control_path,
            callback_token_file=callback_path, trusted_origins=(),
        )
        async with TestClient(TestServer(app)) as client:
            unauthorized = await client.post("/mux/api/sessions", json=launch_request)
            assert unauthorized.status == 401
            forbidden_launch = await client.post(
                "/mux/api/sessions", json=launch_request, headers=callback_headers,
            )
            assert forbidden_launch.status == 403
            launched = await client.post("/mux/api/sessions", json=launch_request, headers=headers)
            assert launched.status == 201, await launched.text()
            receipt = await launched.json()
            identity = {field: receipt[field] for field in IDENTITY_FIELDS}
            assert receipt["session"] == "epic-worker"
            assert receipt["launchMode"] == "command"
            assert receipt["requestId"] == launch_request["requestId"]
            assert identity["sessionId"].startswith("$")
            assert identity["paneId"].startswith("%")
            assert all(isinstance(identity[field], int) and identity[field] > 0
                       for field in IDENTITY_FIELDS if field not in {"sessionId", "paneId"})
            assert receipt["identity"] == ":".join(str(identity[field]) for field in IDENTITY_FIELDS[:4])

            replay = await client.post("/mux/api/sessions", json=launch_request, headers=headers)
            assert replay.status == 200
            assert await replay.json() == {**receipt, "duplicate": True}
            assert sum(item.name == "epic-worker" for item in await tmux.list_sessions()) == 1
            before = await tmux.get_session("epic-worker")
            dimensions = (before.active_pane.width, before.active_pane.height)
            await wait_for_capture(client, "epic-worker", identity, headers,
                                   lambda capture: "READY" in capture["text"])

            # Organize two real launched agents under one project/epic hierarchy.
            leader_request = {**launch_request, "name": "epic-lead", "requestId": "integration-lead-launch"}
            leader = await client.post("/mux/api/sessions", json=leader_request, headers=headers)
            assert leader.status == 201, await leader.text()
            workspace_response = await client.post("/mux/api/workspaces", headers=headers, json={
                "name": "Integration project", "tabs": ["epic-lead"], "activeSession": "epic-lead",
            })
            assert workspace_response.status == 201, await workspace_response.text()
            workspace = (await workspace_response.json())["workspace"]
            added = await client.post(f'/mux/api/workspaces/{workspace["id"]}/sessions', headers=headers,
                                      json={"sessions": ["epic-worker"], "sessionRevision": workspace["sessionRevision"]})
            assert added.status == 200, await added.text()
            workspace = (await added.json())["workspace"]
            nested = await client.patch(f'/mux/api/workspaces/{workspace["id"]}', headers=headers, json={
                "parents": {"epic-worker": "epic-lead"}, "sessionRevision": workspace["sessionRevision"],
            })
            assert nested.status == 200, await nested.text()
            workspace = (await nested.json())["workspace"]
            assert workspace["tabs"] == ["epic-lead", "epic-worker"]
            assert workspace["parents"] == {"epic-worker": "epic-lead"}
            saved = await client.get(f'/mux/api/workspaces/{workspace["id"]}', headers=headers)
            assert (await saved.json())["workspace"]["parents"] == workspace["parents"]

            text = "literal task $() ; '#(command)' — ✓"
            input_payload = {**identity, "text": text, "submit": True}
            unauthorized_input = await client.post("/mux/api/sessions/epic-worker/input", json=input_payload)
            assert unauthorized_input.status == 401
            callback_input = await client.post(
                "/mux/api/sessions/epic-worker/input", json=input_payload, headers=callback_headers,
            )
            assert callback_input.status == 403
            stale = await client.post("/mux/api/sessions/epic-worker/input", headers=headers,
                                      json={**input_payload, "panePid": identity["panePid"] + 1})
            assert stale.status == 409
            delivered = await client.post("/mux/api/sessions/epic-worker/input", json=input_payload, headers=headers)
            assert delivered.status == 200, await delivered.text()
            delivery = await delivered.json()
            assert {field: delivery[field] for field in IDENTITY_FIELDS} == identity
            assert delivery["delivery"] == "delivered" and delivery["submitted"] is True
            completed = await wait_for_capture(client, "epic-worker", identity, headers,
                                                lambda capture: capture["exitStatus"] == 7)
            result_line = next(line for line in completed["lines"] if line.startswith("RESULT "))
            assert json.loads(result_line.removeprefix("RESULT ")) == {
                "cwd": str(tmp_path), "environment": literal, "argument": literal, "text": text,
            }
            assert not forbidden.exists()
            inventory = await client.get("/mux/api/sessions", headers=headers)
            assert inventory.status == 200
            worker = next(item for item in (await inventory.json())["sessions"] if item["name"] == "epic-worker")
            assert worker["attached"] == 0
            pane = next(item for item in worker["panes"] if item["id"] == identity["paneId"])
            assert pane["dead"] is True and pane["exitStatus"] == 7
            assert (pane["width"], pane["height"]) == dimensions
            assert (await client.get("/mux/ws/terminal", headers=headers)).status == 403
            old_fence = await client.get("/mux/api/sessions/epic-worker/capture", headers=headers,
                                         params={**identity, "serverPid": identity["serverPid"] + 1})
            assert old_fence.status == 409
            assert all(item.attached == 0 for item in await tmux.list_sessions())
    finally:
        # TmuxClient always prefixes this command with -L and this unique socket.
        with contextlib.suppress(TmuxError):
            await tmux.run(["kill-server"])


async def test_exec_cli_preserves_provider_stdio_context_and_owned_pane_input(tmp_path: Path):
    socket = f"muxdeck-orchestration-test-{os.getpid()}-{time.time_ns()}"
    tmux = TmuxClient(socket_name=socket)
    credentials = tmp_path / "stdio-auth.json"
    provision_auth_file(credentials, "stdio-integration-user", "stdio-integration-private-password")
    token_path = tmp_path / "stdio-control-token"
    provision_control_token_file(token_path)
    token = token_path.read_text().strip()
    headers = {"Authorization": f"Bearer {token}"}
    caller_cwd = tmp_path / "caller directory with spaces"
    caller_cwd.mkdir()
    inherited = "$(false); #{session_name}; 'quoted' 雪"
    environment = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        "MUXDECK_STDIO_INHERITED_TEST": inherited,
    }
    provider_stderr = b"provider diagnostic\x00\xff\r\n"
    provider = (
        "import json, os, sys\n"
        "request = json.loads(sys.stdin.buffer.readline())\n"
        "reply = {'jsonrpc': '2.0', 'id': request['id'], 'result': "
        "{'cwd': os.getcwd(), 'environment': os.environ['MUXDECK_STDIO_INHERITED_TEST'], "
        "'params': request['params']}}\n"
        "sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=False, "
        "separators=(',', ':')).encode('utf-8') + b'\\r\\n')\n"
        "sys.stdout.buffer.flush()\n"
        f"sys.stderr.buffer.write({provider_stderr!r})\n"
        "sys.stderr.buffer.flush()\n"
        "sys.stdout.buffer.write(sys.stdin.buffer.readline())\n"
        "sys.stdout.buffer.flush()\n"
        "sys.exit(7)\n"
    )
    first_request = {"jsonrpc": "2.0", "id": 1, "method": "context", "params": {"unicode": "雪 ☃"}}
    first_bytes = json.dumps(first_request, ensure_ascii=False).encode("utf-8") + b"\r\n"
    expected_first = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "result": {"cwd": str(caller_cwd), "environment": inherited, "params": first_request["params"]},
    }, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\r\n"
    second_bytes = b' { "jsonrpc" : "2.0", "id": 2, "result": "\\u2603" }\r\n'
    process = None

    try:
        await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", "/bin/sh"])
        app = create_app(
            tmux=tmux, base_path="/mux", auth=AuthStore(credentials), auth_mode="server",
            auth_cookie_secure=False, control_token_file=token_path, trusted_origins=(),
        )
        async with TestClient(TestServer(app)) as client:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "tmux_console.control_cli",
                "--url", str(client.server.make_url("/mux")), "--token-file", str(token_path),
                "exec", "--name", "stdio-provider", "--", sys.executable, "-u", "-c", provider,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                cwd=caller_cwd, env=environment,
            )
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(first_bytes)
            await process.stdin.drain()
            first_output = await asyncio.wait_for(process.stdout.readline(), timeout=10)
            assert first_output == expected_first
            assert process.returncode is None

            inventory = await client.get("/mux/api/sessions", headers=headers)
            assert inventory.status == 200, await inventory.text()
            session = next(item for item in (await inventory.json())["sessions"] if item["name"] == "stdio-provider")
            pane = next(item for item in session["panes"] if item["id"] == session["activePaneId"])
            identity = {
                "sessionId": session["id"], "sessionCreated": session["created"],
                "serverStarted": session["serverStarted"], "serverPid": session["serverPid"],
                "paneId": pane["id"], "panePid": pane["panePid"],
            }
            assert pane["dead"] is False and session["attached"] == 0
            dimensions = (pane["width"], pane["height"])
            reserved = await client.post("/mux/api/sessions/stdio-provider/input", headers=headers, json={
                **identity, "text": "must not enter provider protocol", "submit": True,
            })
            assert reserved.status == 409, await reserved.text()

            remaining_output, stderr = await asyncio.wait_for(process.communicate(second_bytes), timeout=10)
            assert process.returncode == 7
            assert first_output + remaining_output == expected_first + second_bytes
            assert stderr == provider_stderr
            assert token.encode() not in first_output + remaining_output + stderr
            completed = await wait_for_capture(client, "stdio-provider", identity, headers,
                                                lambda capture: capture["exitStatus"] == 7)
            assert completed["exitStatus"] == 7
            retained = await tmux.get_session("stdio-provider")
            assert retained.attached == 0
            assert retained.active_pane.dead and retained.active_pane.exit_status == 7
            assert (retained.active_pane.width, retained.active_pane.height) == dimensions
    finally:
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        with contextlib.suppress(TmuxError):
            await tmux.run(["kill-server"])
