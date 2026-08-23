from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from urllib.parse import quote

import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.messages import SessionMessageStore
from tmux_console.metadata import SessionTitleStore
from tmux_console.tmux import TmuxClient


@pytest.mark.asyncio
async def test_real_tmux_websocket_input_output_resize_history_and_titles(tmp_path):
    session_name = f"muxdeck-pytest-{os.getpid()}-{time.time_ns()}"
    socket_name = f"muxdeck-pytest-{os.getpid()}"
    tmux = ["tmux", "-L", socket_name]
    subprocess.run(
        [
            *tmux,
            "new-session",
            "-d",
            "-s",
            session_name,
            "bash",
            "--noprofile",
            "--norc",
        ],
        check=True,
    )
    pane_id = subprocess.check_output(
        [*tmux, "list-panes", "-t", f"={session_name}", "-F", "#{pane_id}"],
        text=True,
    ).strip()
    subprocess.run(
        [
            *tmux,
            "send-keys",
            "-t",
            pane_id,
            (
                "printf 'HISTORY_MARKER\\n'; "
                "for i in $(seq 1 80); do printf 'HISTORY_LINE_%03d\\n' \"$i\"; done"
            ),
            "Enter",
        ],
        check=True,
    )

    client = TestClient(
        TestServer(
            create_app(
                tmux=TmuxClient(socket_name=socket_name),
                titles=SessionTitleStore(tmp_path / "titles.json"),
                messages=SessionMessageStore(tmp_path / "messages.json"),
                base_path="",
            )
        )
    )
    try:
        await client.start_server()
        websocket = await client.ws_connect(
            f"/ws/terminal?session={quote(session_name)}&cols=70&rows=20"
        )
        output = bytearray()
        ready = None
        deadline = asyncio.get_running_loop().time() + 5
        while ready is None and asyncio.get_running_loop().time() < deadline:
            message = await asyncio.wait_for(websocket.receive(), 2)
            if message.type == WSMsgType.TEXT:
                payload = json.loads(message.data)
                if payload.get("type") == "ready":
                    ready = payload
            elif message.type == WSMsgType.BINARY:
                output.extend(message.data)
        assert ready is not None
        assert ready["paneId"] == pane_id

        await websocket.send_bytes(b"printf 'LIVE_MARKER unicode-ok\\n'\r")
        deadline = asyncio.get_running_loop().time() + 5
        while (
            b"LIVE_MARKER unicode-ok" not in output
            and asyncio.get_running_loop().time() < deadline
        ):
            message = await asyncio.wait_for(websocket.receive(), 2)
            if message.type == WSMsgType.BINARY:
                output.extend(message.data)
        assert b"LIVE_MARKER unicode-ok" in output

        await websocket.send_str(
            json.dumps(
                {
                    "type": "input",
                    "id": "acknowledged-input",
                    "data": "printf 'ACK_MARKER staged-input-ok\\n'\r",
                }
            )
        )
        acknowledgment = None
        deadline = asyncio.get_running_loop().time() + 5
        while (
            acknowledgment is None or b"ACK_MARKER staged-input-ok" not in output
        ) and asyncio.get_running_loop().time() < deadline:
            message = await asyncio.wait_for(websocket.receive(), 2)
            if message.type == WSMsgType.BINARY:
                output.extend(message.data)
            elif message.type == WSMsgType.TEXT:
                payload = json.loads(message.data)
                if payload.get("id") == "acknowledged-input":
                    acknowledgment = payload
        assert acknowledgment == {"type": "inputAck", "id": "acknowledged-input"}
        assert b"ACK_MARKER staged-input-ok" in output

        await websocket.send_str(json.dumps({"type": "resize", "cols": 74, "rows": 23}))
        size = ""
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            size = await asyncio.to_thread(
                subprocess.check_output,
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-t",
                    pane_id,
                    "#{pane_width}x#{pane_height}",
                ],
                text=True,
            )
            size = size.strip()
            if size == "74x22":
                break
            await asyncio.sleep(0.05)
        assert size == "74x22"

        async def request_history(action: str) -> dict:
            await websocket.send_json({"type": "history", "action": action})
            deadline = asyncio.get_running_loop().time() + 5
            while asyncio.get_running_loop().time() < deadline:
                message = await asyncio.wait_for(websocket.receive(), 2)
                if message.type == WSMsgType.BINARY:
                    output.extend(message.data)
                elif message.type == WSMsgType.TEXT:
                    payload = json.loads(message.data)
                    if payload.get("action") == action and payload.get("type") in {
                        "historyAck",
                        "historyNack",
                    }:
                        return payload
            raise AssertionError(f"missing history response for {action}")

        def pane_format(format_string: str) -> str:
            return subprocess.check_output(
                [*tmux, "display-message", "-p", "-t", pane_id, format_string],
                text=True,
            ).strip()

        assert await request_history("page-up") == {
            "type": "historyAck",
            "action": "page-up",
        }
        assert pane_format("#{pane_in_mode}") == "1"
        first_scroll_position = int(pane_format("#{scroll_position}"))
        assert first_scroll_position > 0

        assert await request_history("page-up") == {
            "type": "historyAck",
            "action": "page-up",
        }
        second_scroll_position = int(pane_format("#{scroll_position}"))
        assert second_scroll_position > first_scroll_position

        assert await request_history("page-down") == {
            "type": "historyAck",
            "action": "page-down",
        }
        assert int(pane_format("#{scroll_position}")) < second_scroll_position

        assert await request_history("exit") == {
            "type": "historyAck",
            "action": "exit",
        }
        assert pane_format("#{pane_in_mode}") == "0"
        assert await request_history("exit") == {
            "type": "historyNack",
            "action": "exit",
        }

        second_pane_id = subprocess.check_output(
            [
                *tmux,
                "split-window",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                pane_id,
                "bash",
                "--noprofile",
                "--norc",
            ],
            text=True,
        ).strip()
        subprocess.run(
            [
                *tmux,
                "send-keys",
                "-t",
                second_pane_id,
                "for i in $(seq 1 80); do echo SECOND_PANE_HISTORY_$i; done",
                "Enter",
            ],
            check=True,
        )
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            history_size = subprocess.check_output(
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-t",
                    second_pane_id,
                    "#{history_size}",
                ],
                text=True,
            ).strip()
            if int(history_size) > 0:
                break
            await asyncio.sleep(0.05)
        assert int(history_size) > 0

        client_row = subprocess.check_output(
            [
                *tmux,
                "list-clients",
                "-t",
                f"={session_name}",
                "-F",
                "#{client_name}\t#{pane_id}",
            ],
            text=True,
        ).strip()
        client_name, initial_client_pane = client_row.split("\t")
        assert initial_client_pane == pane_id
        subprocess.run([*tmux, "set-option", "-g", "prefix", "C-b"], check=True)
        subprocess.run(
            [
                *tmux,
                "bind-key",
                "-T",
                "prefix",
                "o",
                "select-pane",
                "-t",
                ":.+",
            ],
            check=True,
        )
        subprocess.run(
            [
                *tmux,
                "bind-key",
                "-T",
                "prefix",
                "x",
                "set-option",
                "-gF",
                "@muxdeck-test-client-pane",
                "#{pane_id}",
            ],
            check=True,
        )
        for input_id, data in (
            ("select-second-pane", "\x02o"),
            ("record-second-pane", "\x02x"),
        ):
            await websocket.send_json({"type": "input", "id": input_id, "data": data})
            while True:
                selection_message = await asyncio.wait_for(websocket.receive(), 2)
                if selection_message.type != WSMsgType.TEXT:
                    continue
                selection_payload = json.loads(selection_message.data)
                if selection_payload.get("id") == input_id:
                    assert selection_payload == {"type": "inputAck", "id": input_id}
                    break
            await asyncio.sleep(0.1)
        recorded_client_pane = subprocess.check_output(
            [*tmux, "show-options", "-gv", "@muxdeck-test-client-pane"],
            text=True,
        ).strip()
        assert recorded_client_pane == second_pane_id
        globally_active_pane = subprocess.check_output(
            [
                *tmux,
                "list-panes",
                "-t",
                f"={session_name}",
                "-f",
                "#{pane_active}",
                "-F",
                "#{pane_id}",
            ],
            text=True,
        ).strip()
        assert globally_active_pane == pane_id

        block_channel = f"muxdeck-test-block-{os.getpid()}"
        block_ready_channel = f"{block_channel}-ready"
        await asyncio.to_thread(
            subprocess.run,
            [
                *tmux,
                "bind-key",
                "-T",
                "prefix",
                "b",
                f"wait-for -S {block_ready_channel} ; wait-for {block_channel}",
            ],
            check=True,
        )
        for input_id, data in (
            ("block-client-queue", "\x02b"),
            ("queue-prefix-race", "\x02x"),
        ):
            await websocket.send_json({"type": "input", "id": input_id, "data": data})
            while True:
                race_message = await asyncio.wait_for(websocket.receive(), 2)
                if race_message.type != WSMsgType.TEXT:
                    continue
                race_payload = json.loads(race_message.data)
                if race_payload.get("id") == input_id:
                    assert race_payload == {"type": "inputAck", "id": input_id}
                    break
            if input_id == "block-client-queue":
                await asyncio.to_thread(
                    subprocess.run,
                    [*tmux, "wait-for", block_ready_channel],
                    check=True,
                    timeout=5,
                )

        raced_history = asyncio.create_task(request_history("page-up"))
        client_key_table = ""
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            client_key_table = await asyncio.to_thread(
                subprocess.check_output,
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-c",
                    client_name,
                    "#{client_key_table}",
                ],
                text=True,
            )
            client_key_table = client_key_table.strip()
            if client_key_table.startswith("muxdeck-history-"):
                break
            await asyncio.sleep(0.05)
        assert client_key_table.startswith("muxdeck-history-")
        await asyncio.to_thread(
            subprocess.run,
            [*tmux, "wait-for", "-S", block_channel],
            check=True,
        )
        assert await raced_history == {
            "type": "historyNack",
            "action": "page-up",
        }
        assert pane_format("#{pane_in_mode}") == "0"
        assert (
            subprocess.check_output(
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-t",
                    second_pane_id,
                    "#{pane_in_mode}",
                ],
                text=True,
            ).strip()
            == "0"
        )
        remaining_bindings = await asyncio.to_thread(
            subprocess.check_output,
            [*tmux, "list-keys", "-a"],
            text=True,
        )
        assert "muxdeck-history-" not in remaining_bindings
        assert "User999" not in remaining_bindings
        remaining_options = await asyncio.to_thread(
            subprocess.check_output,
            [*tmux, "show-options", "-g"],
            text=True,
        )
        assert "@muxdeck-history-" not in remaining_options

        assert await request_history("page-up") == {
            "type": "historyAck",
            "action": "page-up",
        }
        assert pane_format("#{pane_in_mode}") == "0"
        assert (
            subprocess.check_output(
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-t",
                    second_pane_id,
                    "#{pane_in_mode}",
                ],
                text=True,
            ).strip()
            == "1"
        )
        assert await request_history("exit") == {
            "type": "historyAck",
            "action": "exit",
        }
        assert (
            subprocess.check_output(
                [
                    *tmux,
                    "display-message",
                    "-p",
                    "-t",
                    second_pane_id,
                    "#{pane_in_mode}",
                ],
                text=True,
            ).strip()
            == "0"
        )
        assert not websocket.closed
        await websocket.close()
        await asyncio.sleep(0.1)

        response = await client.post(
            f"/api/panes/{quote(pane_id, safe='')}/history?limit=100"
        )
        assert response.status == 200
        history = await response.json()
        captured = "\n".join(history["lines"])
        assert "HISTORY_MARKER" in captured
        assert "LIVE_MARKER" in captured

        response = await client.put(
            "/api/session-title",
            json={"session": session_name, "title": "  Browser agent  "},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session_name,
            "customTitle": "Browser agent",
        }
        response = await client.get("/api/sessions")
        listed = await response.json()
        assert listed["sessions"][0]["customTitle"] == "Browser agent"
        assert listed["sessions"][0]["agentState"] == "other"
        assert listed["sessions"][0]["starred"] is False
        assert listed["sessions"][0]["ignored"] is False

        response = await client.put(
            "/api/session-star",
            json={"session": session_name, "starred": True},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session_name,
            "starred": True,
            "ignored": False,
        }
        response = await client.get("/api/sessions")
        listed = await response.json()
        assert listed["sessions"][0]["starred"] is True

        response = await client.put(
            "/api/session-ignored",
            json={"session": session_name, "ignored": True},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session_name,
            "starred": False,
            "ignored": True,
        }
        response = await client.get("/api/sessions")
        listed = await response.json()
        assert listed["sessions"][0]["starred"] is False
        assert listed["sessions"][0]["ignored"] is True

        message_response = await client.post(
            f"/api/sessions/{quote(session_name, safe='')}/messages",
            json={"text": "Continue after rename"},
        )
        assert message_response.status == 201
        queued_message = (await message_response.json())["message"]

        renamed_session = f"{session_name}-renamed"
        response = await client.put(
            "/api/session-name",
            json={"session": session_name, "name": renamed_session},
        )
        assert response.status == 200
        assert await response.json() == {
            "previousSession": session_name,
            "session": renamed_session,
        }

        listed = await (await client.get("/api/sessions")).json()
        assert [session["name"] for session in listed["sessions"]] == [renamed_session]
        assert listed["sessions"][0]["customTitle"] == "Browser agent"
        assert listed["sessions"][0]["starred"] is False
        assert listed["sessions"][0]["ignored"] is True
        old_messages = await (
            await client.get(f"/api/sessions/{quote(session_name, safe='')}/messages")
        ).json()
        new_messages = await (
            await client.get(
                f"/api/sessions/{quote(renamed_session, safe='')}/messages"
            )
        ).json()
        assert old_messages["messages"] == []
        assert new_messages["messages"] == [queued_message]

        renamed_websocket = await client.ws_connect(
            f"/ws/terminal?session={quote(renamed_session)}&cols=70&rows=20"
        )
        renamed_ready = None
        deadline = asyncio.get_running_loop().time() + 5
        while renamed_ready is None and asyncio.get_running_loop().time() < deadline:
            message = await asyncio.wait_for(renamed_websocket.receive(), 2)
            if message.type == WSMsgType.TEXT:
                payload = json.loads(message.data)
                if payload.get("type") == "ready":
                    renamed_ready = payload
        assert renamed_ready is not None
        assert renamed_ready["session"] == renamed_session
        assert renamed_ready["paneId"] == pane_id
        await renamed_websocket.close()
    finally:
        await client.close()
        subprocess.run([*tmux, "kill-server"], check=False)


@pytest.mark.asyncio
async def test_real_tmux_create_session_api_is_immediately_attachable(tmp_path):
    socket_name = f"muxdeck-create-pytest-{os.getpid()}-{time.time_ns()}"
    tmux_command = ["tmux", "-L", socket_name]
    tmux_client = TmuxClient(socket_name=socket_name)
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux_client,
                base_path="/mux",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.post("/mux/api/sessions", json={})
        assert response.status == 201
        created_payload = await response.json()
        session_name = created_payload["session"]
        assert created_payload["sessionId"].startswith("$")
        suffix = session_name.removeprefix("muxdeck-")
        assert session_name.startswith("muxdeck-")
        assert len(suffix) == 12
        assert all(character in "0123456789abcdef" for character in suffix)

        listed = await (await client.get("/mux/api/sessions")).json()
        assert [session["name"] for session in listed["sessions"]] == [session_name]

        websocket = await client.ws_connect(
            f"/mux/ws/terminal?session={quote(session_name)}&cols=70&rows=20"
        )
        ready = None
        deadline = asyncio.get_running_loop().time() + 5
        while ready is None and asyncio.get_running_loop().time() < deadline:
            message = await asyncio.wait_for(websocket.receive(), 2)
            if message.type == WSMsgType.TEXT:
                payload = json.loads(message.data)
                if payload.get("type") == "ready":
                    ready = payload
        assert ready is not None
        assert ready["session"] == session_name
        assert ready["paneId"].startswith("%")
        await websocket.close()

        requested_name = "named-#{pid}"
        named_response = await client.post(
            "/mux/api/sessions", json={"name": requested_name}
        )
        assert named_response.status == 201
        named_payload = await named_response.json()
        assert named_payload["session"] == requested_name
        assert named_payload["sessionId"].startswith("$")

        working_directory = tmp_path / "working #directory"
        working_directory.mkdir()
        directory_name = "directory-work"
        directory_response = await client.post(
            "/mux/api/sessions",
            json={
                "name": directory_name,
                "directory": str(working_directory),
            },
        )
        assert directory_response.status == 201
        assert (
            await tmux_client.run(
                [
                    "list-panes",
                    "-t",
                    f"={directory_name}",
                    "-F",
                    "#{pane_current_path}",
                ]
            )
        ).strip() == str(working_directory)

        themed_name = "grok-light"
        themed_response = await client.post(
            "/mux/api/sessions", json={"name": themed_name, "theme": "light"}
        )
        assert themed_response.status == 201
        if await tmux_client._supports_new_session_environment():
            assert (
                await tmux_client.run(
                    [
                        "show-environment",
                        "-t",
                        f"={themed_name}",
                        "GROK_THEME",
                    ]
                )
            ).strip() == "GROK_THEME=auto"
            assert (
                await tmux_client.run(
                    [
                        "show-environment",
                        "-t",
                        f"={themed_name}",
                        "GROK_APPEARANCE",
                    ]
                )
            ).strip() == "GROK_APPEARANCE=light"

        conflict = await client.post("/mux/api/sessions", json={"name": requested_name})
        assert conflict.status == 409
        assert "duplicate session" in (await conflict.json())["error"].lower()

        listed = await (await client.get("/mux/api/sessions")).json()
        assert {session["name"] for session in listed["sessions"]} == {
            session_name,
            requested_name,
            directory_name,
            themed_name,
        }
    finally:
        await client.close()
        subprocess.run([*tmux_command, "kill-server"], check=False)
