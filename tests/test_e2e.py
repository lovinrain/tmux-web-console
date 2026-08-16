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
        [*tmux, "send-keys", "-t", pane_id, "printf 'HISTORY_MARKER\\n'", "Enter"],
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
        await asyncio.sleep(0.25)
        size = subprocess.check_output(
            [
                *tmux,
                "display-message",
                "-p",
                "-t",
                pane_id,
                "#{pane_width}x#{pane_height}",
            ],
            text=True,
        ).strip()
        assert size == "74x22"
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
        assert [session["name"] for session in listed["sessions"]] == [
            renamed_session
        ]
        assert listed["sessions"][0]["customTitle"] == "Browser agent"
        assert listed["sessions"][0]["starred"] is False
        assert listed["sessions"][0]["ignored"] is True
        old_messages = await (
            await client.get(
                f"/api/sessions/{quote(session_name, safe='')}/messages"
            )
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
async def test_real_tmux_create_session_api_is_immediately_attachable():
    socket_name = f"muxdeck-create-pytest-{os.getpid()}-{time.time_ns()}"
    tmux_command = ["tmux", "-L", socket_name]
    client = TestClient(
        TestServer(
            create_app(
                tmux=TmuxClient(socket_name=socket_name),
                base_path="/mux",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.post("/mux/api/sessions", json={})
        assert response.status == 201
        session_name = (await response.json())["session"]
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
    finally:
        await client.close()
        subprocess.run([*tmux_command, "kill-server"], check=False)
