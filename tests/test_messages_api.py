from __future__ import annotations

from urllib.parse import quote

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.messages import MAX_MESSAGE_LENGTH, SessionMessageStore
from tmux_console.tmux import Session, TmuxClient


class StaticTmux(TmuxClient):
    def __init__(self, sessions: list[Session] | None = None) -> None:
        self.sessions = sessions or []

    async def list_sessions(self) -> list[Session]:
        return list(self.sessions)


def session_messages_path(session_name: str) -> str:
    return f"/api/sessions/{quote(session_name, safe='')}/messages"


def make_session(name: str, session_id: str = "$1") -> Session:
    return Session(
        name=name,
        id=session_id,
        windows=1,
        attached=0,
        created=1_700_000_000,
    )


@pytest.mark.asyncio
async def test_messages_api_crud_order_persistence_and_absent_session(tmp_path):
    path = tmp_path / "messages.json"
    store = SessionMessageStore(path)
    session_name = "agent active/for now"
    client = TestClient(
        TestServer(
            create_app(
                tmux=StaticTmux([make_session(session_name)]),
                messages=store,
                base_path="",
            )
        )
    )
    collection = session_messages_path(session_name)

    try:
        await client.start_server()
        absent_session = "agent absent/for now"
        response = await client.get(session_messages_path(absent_session))
        assert response.status == 200
        assert await response.json() == {"session": absent_session, "messages": []}

        response = await client.post(collection, json={"text": "  first\n"})
        assert response.status == 201
        first = (await response.json())["message"]
        assert first["text"] == "  first\n"
        assert first["position"] == 0
        assert first["createdAt"] == first["updatedAt"]

        response = await client.post(collection, json={"text": "second"})
        assert response.status == 201
        second = (await response.json())["message"]
        assert second["position"] == 1

        response = await client.patch(
            f"{collection}/{first['id']}",
            json={"text": "edited first", "position": 1},
        )
        assert response.status == 200
        edited = (await response.json())["message"]
        assert edited["id"] == first["id"]
        assert edited["createdAt"] == first["createdAt"]
        assert edited["updatedAt"] > first["updatedAt"]
        assert edited["position"] == 1

        listed = await (await client.get(collection)).json()
        assert [item["id"] for item in listed["messages"]] == [
            second["id"],
            first["id"],
        ]
        assert [item["position"] for item in listed["messages"]] == [0, 1]

        response = await client.delete(f"{collection}/{second['id']}")
        assert response.status == 204
        assert await response.read() == b""
    finally:
        await client.close()

    # Queue data survives application restarts after writes to a live session.
    persisted = SessionMessageStore(path).list_messages(session_name)
    assert [item["id"] for item in persisted] == [first["id"]]
    assert persisted[0]["position"] == 0
    assert persisted[0]["text"] == "edited first"


@pytest.mark.asyncio
async def test_messages_api_validation_and_not_found_responses(tmp_path):
    client = TestClient(
        TestServer(
            create_app(
                tmux=StaticTmux([make_session("cx20")]),
                messages=SessionMessageStore(tmp_path / "messages.json"),
                base_path="",
            )
        )
    )
    collection = session_messages_path("cx20")

    try:
        await client.start_server()
        response = await client.post(collection, data="{")
        assert response.status == 400
        assert (await response.json())["error"] == "request body must be JSON"

        for payload, error in (
            ([], "request body must be an object"),
            ({}, "text must be a string"),
            ({"text": None}, "text must be a string"),
            ({"text": " \n\t"}, "message text cannot be blank"),
            (
                {"text": "x" * (MAX_MESSAGE_LENGTH + 1)},
                "message text must be 65536 characters or fewer",
            ),
        ):
            response = await client.post(collection, json=payload)
            assert response.status == 400
            assert (await response.json())["error"] == error

        created = await (await client.post(collection, json={"text": "valid"})).json()
        message_id = created["message"]["id"]
        for payload, error in (
            ({}, "text or position is required"),
            ({"text": None}, "text must be a string"),
            ({"position": True}, "position must be an integer"),
            ({"position": 1}, "position must be between 0 and 0"),
        ):
            response = await client.patch(f"{collection}/{message_id}", json=payload)
            assert response.status == 400
            assert (await response.json())["error"] == error

        response = await client.patch(
            f"{collection}/missing", json={"text": "still missing"}
        )
        assert response.status == 404
        assert (await response.json())["error"] == "queued message not found: missing"
        response = await client.delete(f"{collection}/missing")
        assert response.status == 404

        response = await client.get(session_messages_path("   "))
        assert response.status == 400
        assert (await response.json())["error"] == "session name is required"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_messages_api_has_no_cross_session_leakage_and_reports_count(tmp_path):
    active_session = make_session("alpha")
    second_session = make_session("beta", "$2")
    client = TestClient(
        TestServer(
            create_app(
                tmux=StaticTmux([active_session, second_session]),
                messages=SessionMessageStore(tmp_path / "messages.json"),
                base_path="",
            )
        )
    )
    alpha = session_messages_path("alpha")
    beta = session_messages_path("beta")

    try:
        await client.start_server()
        alpha_message = (
            await (await client.post(alpha, json={"text": "alpha only"})).json()
        )["message"]
        beta_message = (
            await (await client.post(beta, json={"text": "beta only"})).json()
        )["message"]

        assert (await (await client.get(alpha)).json())["messages"] == [alpha_message]
        assert (await (await client.get(beta)).json())["messages"] == [beta_message]
        response = await client.patch(
            f"{beta}/{alpha_message['id']}", json={"text": "leak"}
        )
        assert response.status == 404

        sessions = (await (await client.get("/api/sessions")).json())["sessions"]
        assert sessions[0]["name"] == "alpha"
        assert sessions[0]["queuedMessageCount"] == 1
    finally:
        await client.close()
