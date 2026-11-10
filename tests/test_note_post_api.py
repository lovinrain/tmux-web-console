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
async def test_agent_note_access_requires_revision_and_keeps_callback_and_public_access_denied(note_app):
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
        assert response.status == 428
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


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["/mux/api/common-note", "/mux/api/workspaces/project/note", "/mux/api/sessions/agent/note"])
async def test_agent_notebook_page_lifecycle_and_paginated_discovery(note_app, endpoint):
    app, _, _ = note_app
    headers = {"Authorization": f"Bearer {CONTROL}"}
    async with TestClient(TestServer(app)) as client:
        response = await client.get(endpoint, headers=headers)
        current = await response.json()
        assert response.headers["ETag"] == '"' + current["revision"] + '"'

        async def edit(method, suffix, body, status=200):
            nonlocal current
            response = await client.request(method, endpoint + suffix,
                                            json={**body, "expectedRevision": current["revision"]}, headers=headers)
            assert response.status == status, await response.text()
            current = await response.json()
            return current

        await edit("POST", "/pages", {"id": "results", "name": "Results", "content": "Existing\n雪", "afterPageId": "main"}, 201)
        assert current["page"] == {"id": "results", "name": "Results", "content": "Existing\n雪"}
        first = await (await client.get(endpoint + "/pages?limit=1", headers=headers)).json()
        assert first["pages"] == [{"id": "main", "name": "Page 1", "characters": 0}]
        assert first["total"] == 2 and first["nextOffset"] == 1
        second = await (await client.get(endpoint + "/pages?offset=1&limit=1&revision=" + first["revision"], headers=headers)).json()
        assert second["pages"][0]["id"] == "results" and second["nextOffset"] is None
        page = await (await client.get(endpoint + "/pages/results", headers=headers)).json()
        assert page["page"]["content"] == "Existing\n雪" and page["revision"] == current["revision"]

        old_revision = current["revision"]
        await edit("PATCH", "/pages/results", {"name": "Reviewed", "content": "Updated"})
        stale_listing = await client.get(endpoint + "/pages?offset=1&revision=" + old_revision, headers=headers)
        assert stale_listing.status == 409
        assert current["notebook"]["pages"][0]["content"] == ""
        await edit("POST", "", {"pageId": "results", "text": "More"})
        await edit("PATCH", "", {"pageIds": ["results", "main"]})
        assert current["note"] == "Updated\n\nMore"
        await edit("DELETE", "/pages/main", {})
        assert len(current["notebook"]["pages"]) == 1
        last_page = await client.delete(endpoint + "/pages/results", json={"expectedRevision": current["revision"]}, headers=headers)
        assert last_page.status == 409
        await edit("POST", "/pages", {"id": "empty", "name": "Empty"}, 201)
        await edit("DELETE", "", {})
        assert current["notebook"]["pages"] == [{"id": "results", "name": "Reviewed", "content": ""},
                                                 {"id": "empty", "name": "Empty", "content": ""}]
        await edit("PUT", "", {"notebook": {"pages": [{"id": "replacement", "name": "Whole notebook", "content": "Replaced"}]}})
        saved = await (await client.get(endpoint, headers=headers)).json()
        assert saved == current and saved["note"] == "Replaced"


@pytest.mark.asyncio
async def test_note_writes_require_valid_revisions_and_reject_stale_snapshots_without_mutation(note_app):
    app, store, _ = note_app
    headers = {"Authorization": f"Bearer {CONTROL}"}
    endpoint = "/mux/api/common-note"
    async with TestClient(TestServer(app)) as client:
        before = await (await client.get(endpoint, headers=headers)).json()
        await client.post(endpoint, json={"text": "Agent update"}, headers=headers)
        saved = await (await client.get(endpoint, headers=headers)).json()
        for revision, expected in ((None, 400), ("bad", 400), (before["revision"], 409)):
            response = await client.put(endpoint, json={"note": "Overwrite", "expectedRevision": revision}, headers=headers)
            assert response.status == expected
        response = await client.put(endpoint, json={"note": "Overwrite"}, headers=headers)
        assert response.status == 428
        for match in ("*", 'W/"' + saved["revision"] + '"', '"bad"'):
            response = await client.put(endpoint, json={"note": "Overwrite"}, headers={**headers, "If-Match": match})
            assert response.status == 400
        response = await client.put(endpoint, json={"note": "Overwrite", "expectedRevision": before["revision"]},
                                    headers={**headers, "If-Match": '"' + saved["revision"] + '"'})
        assert response.status == 400
        response = await client.put(endpoint, json={"note": "Overwrite"},
                                    headers=[*headers.items(), ("If-Match", '"' + saved["revision"] + '"'),
                                             ("If-Match", '"' + saved["revision"] + '"')])
        assert response.status == 400
        response = await client.patch(endpoint + "/pages/main", json={"content": "Overwrite"},
                                      headers={**headers, "If-Match": '"' + before["revision"] + '"'})
        assert response.status == 409
        response = await client.patch(endpoint + "/pages/main", json={"name": "Renamed"},
                                      headers={**headers, "If-Match": '"' + saved["revision"] + '"'})
        assert response.status == 200
        assert store.get_common_note() == "Agent update"
        assert (await response.json())["notebook"]["pages"][0]["name"] == "Renamed"
        for suffix in ("/pages/missing", "/pages/main"):
            response = await client.get(endpoint + suffix, headers={"Authorization": f"Bearer {CALLBACK}"})
            assert response.status == 403
        for query in ("offset=-1", "offset=no", "limit=0", "limit=129", "unknown=true"):
            response = await client.get(endpoint + "/pages?" + query, headers=headers)
            assert response.status == 400
        assert (await client.get(endpoint + "/pages/missing", headers=headers)).status == 404


@pytest.mark.asyncio
async def test_cli_manages_pages_and_whole_notebooks_over_authenticated_http(note_app, monkeypatch, capsys, tmp_path):
    import json

    app, _, control_path = note_app
    async with TestClient(TestServer(app)) as client:
        prefix = ["--url", str(client.server.make_url("/mux")), "--token-file", str(control_path), "notes"]

        async def command(action, *arguments):
            code = await asyncio.to_thread(control_main, [*prefix, action, "--scope", "workspace", "--workspace", "project", *arguments])
            output = capsys.readouterr()
            assert code == 0, output.err
            return json.loads(output.out)

        saved = await command("get")
        saved = await command("add-page", "--page-id", "results", "--name", "Results", "--text", "Start", "--revision", saved["revision"])
        report = tmp_path / "report.txt"
        report.write_text("Updated\n雪", encoding="utf-8")
        saved = await command("update", "--page-id", "results", "--file", str(report), "--revision", saved["revision"])
        snapshot = tmp_path / "snapshot.json"
        snapshot.write_text(json.dumps(saved))
        saved = await command("rename-page", "--page-id", "results", "--name", "Final results", "--revision", "@" + str(snapshot))
        listing = await command("pages", "--limit", "1")
        assert listing["total"] == 2 and listing["nextOffset"] == 1
        page = await command("get", "--page-id", "results", "--revision", saved["revision"])
        assert page["page"]["content"] == "Updated\n雪"
        saved = await command("reorder", "--page-ids", "results", "main", "--revision", saved["revision"])
        saved = await command("clear", "--page-id", "results", "--revision", saved["revision"])
        assert saved["notebook"]["pages"][0] == {"id": "results", "name": "Final results", "content": ""}
        saved = await command("delete-page", "--page-id", "main", "--revision", saved["revision"])
        replacement = {"pages": [{"id": "only", "name": "Replacement", "content": "Whole notebook"}]}
        saved = await command("replace", "--json", json.dumps(replacement), "--revision", saved["revision"])
        saved = await command("clear", "--all-pages", "--revision", saved["revision"])
        assert saved["notebook"]["pages"] == [{"id": "only", "name": "Replacement", "content": ""}]
