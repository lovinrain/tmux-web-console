from __future__ import annotations

import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.control_cli import main as control_main
from tmux_console.tmux import (
    HistoryCapture,
    Pane,
    Session,
    TmuxClient,
    TmuxSessionNotFoundError,
)
from tmux_console.workspaces import WorkspaceStore

CONTROL = "note-control-test-" + "a" * 40
CALLBACK = "note-callback-test-" + "b" * 40


class NoteTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="unused-tmux")
        self.session = Session(
            name="agent", id="$1", windows=1, attached=0, created=100,
            server_started=90, server_pid=4242,
            panes=[Pane(
                id="%1", index=0, window_index=0, window_name="main", window_active=True,
                active=True, command="bash", path="/tmp", title="Test", width=80, height=24,
                history_size=0, history_limit=2000, alternate_on=False, dead=False,
                activity=100, process_pid=4243,
            )],
        )

    async def list_sessions(self):
        return [self.session]

    async def get_session(self, name):
        if name != self.session.name:
            raise TmuxSessionNotFoundError("session not found")
        return self.session

    async def capture_history_slice(self, pane, start, end):
        return HistoryCapture(pane, [])


@pytest.fixture
def note_app(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json", id_factory=lambda: "project")
    store.create_workspace(name="Project", tabs=["agent"], active_session="agent")
    control_path = tmp_path / "control.token"
    callback_path = tmp_path / "callback.token"
    for path, token in ((control_path, CONTROL), (callback_path, CALLBACK)):
        path.write_text(token + "\n", encoding="ascii")
        path.chmod(0o600)
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "user", "password-for-test")
    app = create_app(
        tmux=NoteTmux(), workspaces=store, base_path="/mux",
        auth=AuthStore(auth_path), auth_mode="server", auth_cookie_secure=False,
        control_token_file=control_path, callback_token_file=callback_path,
    )
    return app, store, control_path


@pytest.mark.asyncio
async def test_agent_note_posts_preserve_pages_isolate_scopes_and_persist(note_app, tmp_path):
    app, store, _ = note_app
    scopes = (("global", "/mux/api/common-note"),
              ("workspace", "/mux/api/workspaces/project/note"),
              ("session", "/mux/api/sessions/agent/note"))
    notebook = {"pages": [
        {"id": "main", "name": "Plan", "content": "Keep the first page"},
        {"id": "results", "name": "Results", "content": "Existing"},
    ]}
    store.replace_common_notebook(notebook)
    store.replace_workspace_notebook("project", notebook)
    store.replace_session_notebook("agent", notebook)
    headers = {"Authorization": f"Bearer {CONTROL}"}
    async with TestClient(TestServer(app)) as client:
        for scope, endpoint in scopes:
            response = await client.post(endpoint, json={"text": f"{scope}\r\n雪", "pageId": "results"}, headers=headers)
            assert response.status == 200
            result = await response.json()
            assert result["scope"] == scope
            assert result["pageId"] == "results"
            assert result["note"] == "Keep the first page"
            assert result["notebook"]["pages"] == [
                notebook["pages"][0],
                {**notebook["pages"][1], "content": f"Existing\n\n{scope}\n雪"},
            ]
            saved = await client.get(endpoint, headers=headers)
            assert saved.status == 200
            assert (await saved.json())["notebook"] == result["notebook"]
        capabilities = await (await client.get("/mux/api/capabilities", headers=headers)).json()
        assert capabilities["notes"]["postOperation"] == "append"
    reloaded = WorkspaceStore(tmp_path / "workspaces.json")
    assert reloaded.get_common_notebook()["pages"][1]["content"] == "Existing\n\nglobal\n雪"
    assert reloaded.get_workspace_notebook("project")["pages"][1]["content"] == "Existing\n\nworkspace\n雪"
    assert reloaded.get_session_notebook("agent")["pages"][1]["content"] == "Existing\n\nsession\n雪"


@pytest.mark.asyncio
async def test_agent_note_access_keeps_replacement_callback_and_public_access_denied(note_app):
    app, store, _ = note_app
    store.replace_common_note("Existing")
    endpoint = "/mux/api/common-note"
    async with TestClient(TestServer(app)) as client:
        for method in ("GET", "POST"):
            response = await client.request(method, endpoint, json={"text": "No"} if method == "POST" else None)
            assert response.status == 401
            response = await client.request(method, endpoint, json={"text": "No"} if method == "POST" else None,
                                            headers={"Authorization": f"Bearer {CALLBACK}"})
            assert response.status == 403
        control = {"Authorization": f"Bearer {CONTROL}"}
        response = await client.put(endpoint, json={"note": "Replace"}, headers=control)
        assert response.status == 403
        response = await client.post(endpoint, json={"text": "No"}, headers={**control, "Origin": "https://evil.invalid"})
        assert response.status == 403
        response = await client.post(endpoint, json={"text": "No"}, headers={**control, "Host": "evil.invalid"})
        assert response.status == 403
    assert store.get_common_note() == "Existing"


@pytest.mark.asyncio
async def test_note_post_validation_missing_targets_and_write_failure_leave_data_intact(note_app, monkeypatch):
    app, store, _ = note_app
    store.replace_common_note("Existing")
    headers = {"Authorization": f"Bearer {CONTROL}"}
    async with TestClient(TestServer(app)) as client:
        for payload in (None, [], {}, {"text": None}, {"text": " "}, {"text": "bad\x00text"},
                        {"text": "New", "pageId": "missing"}, {"text": "New", "unknown": True}):
            response = await client.post("/mux/api/common-note", json=payload, headers=headers)
            assert response.status == 400
        for endpoint in ("/mux/api/workspaces/missing/note", "/mux/api/sessions/missing/note"):
            response = await client.post(endpoint, json={"text": "New"}, headers=headers)
            assert response.status == 404
        assert store.get_common_note() == "Existing"

        def fail(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(store, "_persist", fail)
        response = await client.post("/mux/api/common-note", json={"text": "New"}, headers=headers)
        assert response.status == 500
    assert store.get_common_note() == "Existing"


@pytest.mark.asyncio
async def test_cli_posts_to_all_scopes_using_the_current_agent_context(note_app, monkeypatch):
    app, store, control_path = note_app
    monkeypatch.setenv("TMUX_PANE", "%1")
    monkeypatch.setenv("TMUX", "/tmp/note-test,4242,1")
    async with TestClient(TestServer(app)) as client:
        prefix = ["--url", str(client.server.make_url("/mux")), "--token-file", str(control_path)]
        for scope in ("global", "workspace", "session"):
            status = await asyncio.to_thread(control_main, [*prefix, "notes", "post", "--scope", scope,
                                                           "--text", f"Posted to {scope}"])
            assert status == 0
    assert store.get_common_note() == "Posted to global"
    assert store.get_workspace_note("project") == "Posted to workspace"
    assert store.get_session_note("agent") == "Posted to session"
