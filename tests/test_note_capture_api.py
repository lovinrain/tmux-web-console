from __future__ import annotations

import io
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from tmux_console.app import NOTE_CAPTURES_KEY, WORKSPACES_KEY, create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.tmux import Session, TmuxClient, TmuxError


@pytest.fixture
async def capture_api():
    tmux = AsyncMock(spec=TmuxClient)
    source = Session("alpha", "$1", 1, 0, 100, server_started=90, server_pid=42)
    tmux.get_session.return_value = source
    tmux.list_sessions.return_value = [source]
    app = create_app(tmux=tmux, base_path="/mux")
    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(client=client, source=source, tmux=tmux,
                              store=app[NOTE_CAPTURES_KEY].store, workspaces=app[WORKSPACES_KEY])


async def upload(api, identifier="a" * 32, *, image=True, **changes):
    metadata = {"id": identifier, "scope": "common", "target": "common", "pageId": "main",
                "sourceSession": api.source.name, "sourceIdentity": api.source.identity, "text": "original text"}
    metadata.update(changes)
    form = FormData()
    form.add_field("metadata", json.dumps(metadata), content_type="application/json")
    if image:
        output = io.BytesIO()
        Image.new("RGB", (100, 30), "white").save(output, "PNG")
        form.add_field("image", output.getvalue(), filename="image.png", content_type="image/png")
    return await api.client.post("/mux/api/note-captures", data=form)


async def test_upload_preview_text_and_existing_notebook_remain_independent(capture_api):
    api = capture_api
    api.workspaces.replace_common_note("existing notebook content")
    response = await upload(api)
    assert response.status == 201, await response.text()
    capture = (await response.json())["capture"]
    api.workspaces.replace_common_note("an editor saved concurrently")
    response = await api.client.get("/mux/api/note-captures", params={"scope": "common", "target": "common", "pageId": "main"})
    assert (await response.json())["captures"][0]["id"] == capture["id"]
    assert api.workspaces.get_common_note() == "an editor saved concurrently"
    image = await api.client.get(f'/mux/api/note-captures/{capture["id"]}/image')
    assert image.status == 200
    assert image.headers["Content-Type"] == "image/png"
    assert image.headers["X-Content-Type-Options"] == "nosniff"
    preview = await api.client.get(f'/mux/api/note-captures/{capture["id"]}/image?thumbnail=true')
    assert preview.status == 200
    duplicate = await upload(api)
    assert duplicate.status == 201
    assert len(api.store.list()) == 1


async def test_bad_source_page_and_conflicting_revision_are_rejected(capture_api):
    api = capture_api
    assert (await upload(api, sourceIdentity="another session")).status == 409
    assert (await upload(api, pageId="removed")).status == 409
    assert (await upload(api, image=False)).status == 201
    path = "/mux/api/note-captures/" + "a" * 32
    assert (await api.client.patch(path, json={"expectedRevision": 0, "text": "new"})).status == 200
    assert (await api.client.patch(path, json={"expectedRevision": 0, "text": "stale"})).status == 409
    assert api.store.get("a" * 32)["text"] == "new"


async def test_ended_storage_warning_keep_and_image_only_cleanup(capture_api):
    api = capture_api
    await upload(api)
    api.tmux.list_sessions.return_value = []
    storage = await (await api.client.get("/mux/api/note-captures/storage")).json()
    assert storage["summary"]["endedImageCount"] == 1
    assert storage["summary"]["warning"] == "warning"
    assert storage["captures"][0]["expiresAt"] is not None
    response = await api.client.post("/mux/api/note-captures/cleanup", json={"ids": ["a" * 32]})
    assert response.status == 200
    assert (await response.json())["freedBytes"] > 0
    assert api.store.get("a" * 32)["text"] == "original text"
    assert api.store.summary()["usedBytes"] == 0


async def test_failed_inventory_never_infers_source_end(capture_api):
    await upload(capture_api)
    capture_api.tmux.list_sessions.side_effect = TmuxError("temporary inventory failure")
    assert (await capture_api.client.get("/mux/api/note-captures/storage")).status == 503
    assert capture_api.store.get("a" * 32)["sourceEndedAt"] is None


async def test_invalid_upload_and_quota_are_explained(capture_api):
    api = capture_api
    response = await api.client.post("/mux/api/note-captures", json={"text": "wrong encoding"})
    assert response.status == 400
    assert "multipart" in (await response.json())["error"]
    api.store.max_bytes = 1
    assert (await upload(api)).status == 507
    assert api.store.list() == []
    assert not list(api.store.image_directory.iterdir())


async def test_ocr_is_on_demand_and_does_not_overwrite_saved_text(capture_api, monkeypatch):
    api = capture_api
    await upload(api)
    path = "/mux/api/note-captures/" + "a" * 32 + "/ocr"
    monkeypatch.setattr("tmux_console.note_capture_api.shutil.which", lambda _name: "/usr/bin/tesseract")
    calls = []

    def recognize(command, **options):
        calls.append((command, options))
        return SimpleNamespace(returncode=0, stdout=b"recognized words\n")

    monkeypatch.setattr("tmux_console.note_capture_api.subprocess.run", recognize)
    response = await api.client.post(path)
    assert response.status == 200
    assert (await response.json())["text"] == "recognized words"
    assert api.store.get("a" * 32)["text"] == "original text"
    assert len(calls) == 1
    assert calls[0][1]["timeout"] == 20
    assert calls[0][1]["env"]["OMP_THREAD_LIMIT"] == "1"

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("tesseract", 20)

    monkeypatch.setattr("tmux_console.note_capture_api.subprocess.run", timeout)
    response = await api.client.post(path)
    assert response.status == 503
    assert "timed out" in (await response.json())["error"]
    monkeypatch.setattr("tmux_console.note_capture_api.shutil.which", lambda _name: None)
    assert (await api.client.post(path)).status == 503


async def test_capture_routes_require_browser_authentication(tmp_path):
    auth_path = tmp_path / "private-auth.json"
    provision_auth_file(auth_path, "note-user", "notes-fixture-password")
    paths = []
    for name, token in (("control", "control-" + "a" * 40), ("callback", "callback-" + "b" * 40)):
        path = tmp_path / name
        path.write_text(token)
        path.chmod(0o600)
        paths.append(path)
    tmux = AsyncMock(spec=TmuxClient)
    tmux.list_sessions.return_value = []
    app = create_app(tmux=tmux, auth=AuthStore(auth_path), auth_mode="server",
                     control_token_file=paths[0], callback_token_file=paths[1], base_path="/mux")
    base = "/mux/api/note-captures"
    async with TestClient(TestServer(app)) as client:
        for method, path in (("GET", base + "/storage"), ("POST", base),
                             ("GET", base + "/" + "a" * 32 + "/image"),
                             ("POST", base + "/" + "a" * 32 + "/ocr")):
            assert (await client.request(method, path)).status == 401
            for credential in paths:
                response = await client.request(method, path, headers={"Authorization": f"Bearer {credential.read_text()}"})
                assert response.status == 403


async def test_unavailable_capture_database_does_not_take_console_offline(capture_api):
    api = capture_api
    api.store.close()
    assert (await api.client.get("/mux/api/note-captures/storage")).status == 503
    assert (await api.client.get("/mux/api/sessions")).status == 200
