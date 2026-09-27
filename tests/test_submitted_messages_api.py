from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.app import SESSION_REGISTRY_KEY, create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.submitted_messages import SubmittedMessageStore
from tmux_console.tmux import Session, TmuxClient, TmuxSessionNotFoundError

AGENT_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"


class References(AgentReferenceDetector):
    identifier = AGENT_ID

    async def detect_sessions(self, sessions):
        return {session.name: AgentReference("codex", self.identifier) for session in sessions}


class FakeTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="must-not-run-tmux")
        self.session = Session(name="agent", id="$1", created=100, windows=1, attached=0, server_started=90, server_pid=321)

    async def list_sessions(self):
        return [self.session] if self.session else []

    async def get_session(self, name):
        if self.session and self.session.name == name:
            return self.session
        raise TmuxSessionNotFoundError("session not found")


@pytest.fixture
def setup_archive(tmp_path):
    source = tmp_path / "codex-history.jsonl"
    source.write_text(json.dumps({"session_id": AGENT_ID, "ts": 1000, "text": "Final edited message\nwith two lines"}) + "\n")
    store = SubmittedMessageStore(tmp_path / "submitted.sqlite3", history_paths={"codex": source})
    yield source, store, FakeTmux(), References()
    store.close()


@pytest.mark.asyncio
async def test_messages_follow_identity_across_rename_end_and_name_reuse(setup_archive):
    source, store, tmux, references = setup_archive
    app = create_app(tmux=tmux, agent_references=references, submitted_messages=store, base_path="/mux")
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/mux/api/sessions/agent/submitted-messages?identity=$1:100:90:321")
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        messages = (await response.json())["messages"]
        assert [item["text"] for item in messages] == ["Final edited message\nwith two lines"]
        history_id = app[SESSION_REGISTRY_KEY].list_history()["entries"][0]["id"]
        tmux.session = replace(tmux.session, name="renamed")
        response = await client.get("/mux/api/sessions/renamed/submitted-messages")
        assert (await response.json())["messages"] == messages
        assert app[SESSION_REGISTRY_KEY].list_history()["entries"][0]["id"] == history_id
        source.unlink()
        original = tmux.session
        tmux.session = None
        app[SESSION_REGISTRY_KEY].mark_history(history_id, ended=True)
        response = await client.get(f"/mux/api/session-history/{history_id}/submitted-messages")
        assert response.status == 200
        assert (await response.json())["messages"] == messages
        tmux.session = replace(original, id="$2", created=101)
        references.identifier = OTHER_ID
        response = await client.get("/mux/api/sessions/renamed/submitted-messages")
        assert (await response.json())["messages"] == []
        response = await client.get("/mux/api/sessions/renamed/submitted-messages?identity=$1:100:90:321")
        assert response.status == 409


@pytest.mark.asyncio
async def test_background_archive_runs_without_a_browser_or_history_request(setup_archive, monkeypatch):
    source, store, tmux, references = setup_archive
    monkeypatch.setattr("tmux_console.app.SUBMITTED_MESSAGE_POLL_SECONDS", 0.01)
    app = create_app(tmux=tmux, agent_references=references, submitted_messages=store, base_path="")
    async with TestClient(TestServer(app)):
        async def archived():
            while not store.list_messages([{"agentType": "codex", "agentSessionId": AGENT_ID}])["messages"]:
                await asyncio.sleep(0.01)
        await asyncio.wait_for(archived(), 2)
    # Cleanup waits for the worker before closing SQLite; the copy survives restart.
    source.unlink()
    restarted = SubmittedMessageStore(store.path, history_paths={})
    try:
        assert len(restarted.list_messages([{"agentType": "codex", "agentSessionId": AGENT_ID}])["messages"]) == 1
    finally:
        restarted.close()


@pytest.mark.asyncio
async def test_query_validation_and_missing_records_are_explicit(setup_archive):
    _, store, tmux, references = setup_archive
    app = create_app(tmux=tmux, agent_references=references, submitted_messages=store, base_path="")
    async with TestClient(TestServer(app)) as client:
        for params in ({"limit": "201"}, {"limit": "no"}, {"before": "-1"}, {"q": "x" * 257}, {"path": "/etc/passwd"}):
            response = await client.get("/api/sessions/agent/submitted-messages", params=params)
            assert response.status == 400
        for path in ("/api/sessions/missing/submitted-messages", "/api/session-history/missing/submitted-messages"):
            response = await client.get(path)
            assert response.status == 404
        response = await client.get("/api/sessions/agent/submitted-messages?q=EDITED&limit=1")
        assert len((await response.json())["messages"]) == 1
        store.close()
        response = await client.get("/api/sessions/agent/submitted-messages")
        assert response.status == 503


@pytest.mark.asyncio
async def test_history_requires_browser_auth_and_rejects_callback_only_access(setup_archive, tmp_path):
    _, store, tmux, references = setup_archive
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "test-user", "test-password-for-history")
    token = "submitted-history-test-" + "a" * 40
    token_path = tmp_path / "callback-token"
    token_path.write_text(token)
    token_path.chmod(0o600)
    app = create_app(
        tmux=tmux, agent_references=references, submitted_messages=store, base_path="/mux",
        auth=AuthStore(auth_path), auth_mode="server", auth_cookie_secure=False, callback_token_file=token_path,
    )
    async with TestClient(TestServer(app)) as client:
        for path in ("/mux/api/sessions/agent/submitted-messages", "/mux/api/session-history/id/submitted-messages"):
            assert (await client.get(path)).status == 401
            assert (await client.get(path, headers={"Authorization": f"Bearer {token}"})).status == 403
        login = await client.post("/mux/api/auth/login", json={"username": "test-user", "password": "test-password-for-history"})
        assert login.status == 200
        assert (await client.get("/mux/api/sessions/agent/submitted-messages")).status == 200
