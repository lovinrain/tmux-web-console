from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import quote

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import Pane, Session, TmuxClient
from tmux_console.work_links import WorkLinkStore

CONTROL = "work-link-control-" + "a" * 40
CALLBACK = "work-link-callback-" + "b" * 40


@pytest.fixture
async def api(tmp_path):
    tmux = AsyncMock(spec=TmuxClient)
    pane = Pane(id="%9", index=0, window_index=0, window_name="shell", window_active=True,
                active=True, command="bash", path=str(tmp_path), title="shell", width=80,
                height=24, history_size=0, history_limit=1000, alternate_on=False, dead=False, activity=0)
    session = Session(name="agent/one #2", id="$7", windows=1, attached=0, created=100,
                      server_started=90, server_pid=42, panes=[pane])
    tmux.get_session.return_value = session
    tmux.list_sessions.return_value = [session]
    registry = SessionRegistry(tmp_path / "registry.sqlite3")
    store = WorkLinkStore(tmp_path / "work-links.sqlite3")
    token_files = []
    for name, token in (("control", CONTROL), ("callback", CALLBACK)):
        path = tmp_path / name
        path.write_text(token)
        path.chmod(0o600)
        token_files.append(path)
    app = create_app(tmux=tmux, base_path="/mux", session_registry=registry, work_links=store,
                     control_token_file=token_files[0], callback_token_file=token_files[1])
    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(client=client, tmux=tmux, session=session, registry=registry, store=store,
                              path=f"/mux/api/sessions/{quote(session.name, safe='')}/work-links")


async def create_link(api, provider="github", **extra):
    context = await (await api.client.get(api.path)).json()
    url = {"github": "https://git.company.example/prefix/o/r/pull/17", "jira": "https://jira.company.example/browse/ENG-123",
           "google_docs": "https://docs.google.com/document/d/a-long-document-id/edit?tab=t.0"}[provider]
    response = await api.client.post(api.path, json={"historyId": context["session"]["historyId"], "provider": provider, "url": url, **extra})
    assert response.status == 201, await response.text()
    return (await response.json())["link"]


async def test_current_pane_context_and_capabilities_explain_agent_refresh(api):
    response = await api.client.get("/mux/api/work-links/context?paneId=%259", headers={"Authorization": f"Bearer {CONTROL}"})
    assert response.status == 200
    context = await response.json()
    assert context["session"]["name"] == api.session.name
    assert context["refreshOwner"] == "agent"
    assert context["serverFetchesProviders"] is False
    assert "google_docs" in context["providers"]
    assert context["config"]["providers"]["github"]["refreshEnabled"] is False
    assert context["contextEndpoint"] == "/mux/api/work-links/context"
    capabilities = await (await api.client.get("/mux/api/capabilities")).json()
    assert capabilities["workLinks"]["persistent"] is True
    assert capabilities["workLinks"]["config"] == context["config"]
    assert (await api.client.get("/mux/api/work-links/context?paneId=%25000")).status == 404
    assert (await api.client.get("/mux/api/work-links/context?paneId=%259&paneId=%259")).status == 400


async def test_control_auth_allows_programmatic_config_links_notes_and_status_but_callback_does_not(api):
    config_path = "/mux/api/work-links/config"
    for path in (config_path, "/mux/api/work-links/context", api.path):
        response = await api.client.get(path, headers={"Authorization": f"Bearer {CALLBACK}"})
        assert response.status == 403
    assert (await api.client.get(config_path, headers={"Authorization": "Bearer wrong"})).status == 401
    headers = {"Authorization": f"Bearer {CONTROL}"}
    response = await api.client.patch(config_path, headers=headers, json={"expectedRevision": 0, "providers": {
        "github": {"refreshEnabled": True, "instructions": "Use the work gh account on git.company.example."},
        "google_docs": {"instructions": "Use Google Docs MCP and provide the title."},
    }})
    assert response.status == 200
    record = await create_link(api, notes="Keep this decision")
    record_path = f"/mux/api/work-links/{record['id']}"
    response = await api.client.put(record_path + "/status", headers=headers, json={
        "expectedStatusRevision": 0, "status": {"state": "Approved", "tone": "success", "summary": "Checks passed", "reportedBy": "coding agent"},
    })
    assert response.status == 200
    response = await api.client.patch(record_path, headers=headers, json={"expectedRevision": 1, "notes": "Retained after approval"})
    assert response.status == 200
    assert (await response.json())["link"]["status"]["state"] == "Approved"
    snapshot = await (await api.client.get("/mux/api/sessions")).json()
    badge = snapshot["sessions"][0]["workLinks"][0]
    assert badge["status"]["state"] == "Approved"
    assert "notes" not in badge and "instructions" not in badge
    assert api.tmux.mock_calls and all(call[0] in {"list_sessions", "get_session"} for call in api.tmux.mock_calls)


async def test_rename_keeps_links_and_name_reuse_cannot_claim_old_links(api):
    record = await create_link(api)
    renamed = replace(api.session, name="renamed")
    api.tmux.get_session.return_value = renamed
    api.tmux.list_sessions.return_value = [renamed]
    current = await (await api.client.get("/mux/api/sessions/renamed/work-links")).json()
    assert current["links"][0]["id"] == record["id"]
    assert current["session"]["historyId"] == record["historyId"]
    replacement = replace(renamed, id="$8", created=101)
    api.tmux.get_session.return_value = replacement
    api.tmux.list_sessions.return_value = [replacement]
    current = await (await api.client.get("/mux/api/sessions/renamed/work-links")).json()
    assert current["links"] == []
    stale = await api.client.post("/mux/api/sessions/renamed/work-links", json={"historyId": record["historyId"], "provider": "jira", "url": "https://jira.example/browse/OPS-2"})
    assert stale.status == 409
    retained = await (await api.client.get(f"/mux/api/session-history/{record['historyId']}/work-links")).json()
    assert retained["links"][0]["id"] == record["id"]


async def test_google_document_title_round_trips_without_fetching_metadata(api):
    record = await create_link(api, "google_docs", title="Release planning and decisions", notes="Keep the launch checklist here")
    result = await (await api.client.get(f"/mux/api/work-links/{record['id']}")).json()
    assert result["link"]["title"] == "Release planning and decisions"
    assert result["link"]["label"] == "Google Doc"
    snapshot = await (await api.client.get("/mux/api/sessions")).json()
    assert snapshot["sessions"][0]["workLinks"][0]["title"] == "Release planning and decisions"
    disabled = await api.client.put(f"/mux/api/work-links/{record['id']}/status", json={"expectedStatusRevision": 0, "status": {"state": "Reviewed"}})
    assert disabled.status == 409


async def test_invalid_inputs_and_missing_identity_do_not_create_records(api):
    for payload in ([], None, {"provider": "jira", "url": "https://jira.example/browse/OPS-2"}):
        response = await api.client.post(api.path, json=payload)
        assert response.status == 400
    assert (await api.client.get("/mux/api/work-links/missing")).status == 404
    context = await (await api.client.get(api.path)).json()
    assert context["links"] == []
    payload = {"historyId": context["session"]["historyId"], "provider": "jira", "url": "javascript:alert(1)"}
    assert (await api.client.post(api.path, json=payload)).status == 400


async def test_auxiliary_database_failure_does_not_take_session_inventory_offline(api):
    api.store.close()
    assert (await api.client.get(api.path)).status == 503
    capabilities = await (await api.client.get("/mux/api/capabilities")).json()
    assert capabilities["workLinks"]["available"] is False
    response = await api.client.get("/mux/api/sessions")
    assert response.status == 200
    assert (await response.json())["sessions"][0]["workLinksAvailable"] is False
