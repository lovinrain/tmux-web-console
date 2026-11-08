from __future__ import annotations

from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.clipboard_upload import ClipboardUploader
from tmux_console.tmux import Pane, Session, TmuxClient


class ClipboardTmux(TmuxClient):
    def __init__(self, root: Path):
        super().__init__(binary="must-not-run-tmux")
        self.session = Session(name="files", id="$7", created=100, server_started=90, server_pid=321,
            windows=1, attached=0, panes=[Pane(id="%3", index=0, window_index=0, window_name="main",
                window_active=True, active=True, command="bash", path=str(root), title="shell", width=80,
                height=24, history_size=0, history_limit=2000, alternate_on=False, dead=False, activity=1)])

    async def list_sessions(self):
        return [self.session]


@pytest.fixture
async def clipboard(tmp_path):
    state = {"limit": 2 * 1024 * 1024, "mode": "open", "status": 201,
             "url": "https://la.99818888.xyz/c/123", "statsCalls": 0, "uploads": []}

    async def stats(_request):
        state["statsCalls"] += 1
        return web.json_response({"max_file": state["limit"], "mode": state["mode"]})

    async def upload(request):
        assert request.headers.get("Accept") == "application/json"
        assert "Authorization" not in request.headers and "Cookie" not in request.headers
        multipart = await request.multipart()
        part = await multipart.next()
        assert part and part.name == "file"
        content = await part.read(decode=False)
        state["uploads"].append({"filename": part.filename, "content": bytes(content)})
        if state["status"] != 201:
            return web.json_response({"error": "Clipboard is full"}, status=state["status"])
        return web.json_response({"entries": [{"kind": "file", "url": state["url"], "size": len(content)}]}, status=201)

    service = web.Application(client_max_size=3 * 1024 * 1024)
    service.router.add_get("/api/stats", stats)
    service.router.add_post("/api/paste", upload)
    async with TestServer(service) as target:
        app = create_app(tmux=ClipboardTmux(tmp_path), file_browser_root=str(tmp_path), base_path="",
                         clipboard=ClipboardUploader(str(target.make_url(""))))
        async with TestClient(TestServer(app)) as client:
            yield client, state


def query(path: str, **changes):
    return {"sessionId": "$7", "paneId": "%3", "path": path, **changes}


async def test_selected_file_streams_bytes_and_preserves_unicode_filename(clipboard, tmp_path):
    client, state = clipboard
    name = 'Résumé report "final".bin'
    content = bytes(range(256)) * 600
    source = tmp_path / name
    source.write_bytes(content)
    response = await client.post("/api/sessions/files/files/clipboard", params=query(name))
    assert response.status == 201
    assert await response.json() == {"url": state["url"], "name": name, "size": len(content)}
    assert state["uploads"] == [{"filename": name, "content": content}]
    assert source.read_bytes() == content


@pytest.mark.parametrize("path,changes,status", [
    ("notes.txt", {"sessionId": "$8"}, 409),
    ("notes.txt", {"paneId": "%999"}, 409),
    ("../outside.txt", {}, 400),
    ("/etc/passwd", {}, 400),
    ("notes.txt", {"destination": "http://outside.test"}, 400),
])
async def test_clipboard_transfer_rejects_invalid_scope_before_contacting_clip(clipboard, tmp_path, path, changes, status):
    client, state = clipboard
    (tmp_path / "notes.txt").write_text("private file")
    response = await client.post("/api/sessions/files/files/clipboard", params=query(path, **changes))
    assert response.status == status
    assert state["statsCalls"] == 0 and not state["uploads"]


async def test_directory_empty_file_and_outside_symlink_are_never_uploaded(clipboard, tmp_path):
    client, state = clipboard
    (tmp_path / "folder").mkdir()
    (tmp_path / "empty.txt").touch()
    outside = tmp_path.parent / f"{tmp_path.name}-outside.txt"
    outside.write_text("outside")
    (tmp_path / "link.txt").symlink_to(outside)
    for path, status in [("folder", 400), ("empty.txt", 400), ("link.txt", 403)]:
        response = await client.post("/api/sessions/files/files/clipboard", params=query(path))
        assert response.status == status
    assert not state["uploads"] and state["statsCalls"] == 0


@pytest.mark.parametrize("mode,limit,status", [("readonly", 100, 503), ("token", 100, 503), ("open", 2, 413)])
async def test_clipboard_panic_modes_and_limits_stop_before_file_transfer(clipboard, tmp_path, mode, limit, status):
    client, state = clipboard
    state.update(mode=mode, limit=limit)
    (tmp_path / "notes.txt").write_bytes(b"notes")
    response = await client.post("/api/sessions/files/files/clipboard", params=query("notes.txt"))
    assert response.status == status
    assert not state["uploads"]


async def test_clipboard_rejection_is_reported_without_automatic_retry(clipboard, tmp_path):
    client, state = clipboard
    state["status"] = 507
    (tmp_path / "notes.txt").write_text("notes")
    response = await client.post("/api/sessions/files/files/clipboard", params=query("notes.txt"))
    assert response.status == 507
    assert (await response.json())["error"] == "Clipboard is full"
    assert len(state["uploads"]) == 1


@pytest.mark.parametrize("url", ["javascript:alert(1)", "https://[invalid", "https://user:password@example.test/file"])
async def test_clipboard_does_not_return_unsafe_uploaded_links(clipboard, tmp_path, url):
    client, state = clipboard
    state["url"] = url
    (tmp_path / "notes.txt").write_text("notes")
    response = await client.post("/api/sessions/files/files/clipboard", params=query("notes.txt"))
    assert response.status == 502
    assert "link was invalid" in (await response.json())["error"]
