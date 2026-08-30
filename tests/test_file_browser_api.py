from __future__ import annotations

import stat
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import file_browser
from tmux_console.app import create_app
from tmux_console.tmux import Pane, Session, TmuxClient, TmuxError


def make_pane(path: Path, pane_id: str = "%3") -> Pane:
    return Pane(
        id=pane_id,
        index=0,
        window_index=0,
        window_name="main",
        window_active=True,
        active=True,
        command="bash",
        path=str(path),
        title="shell",
        width=100,
        height=30,
        history_size=0,
        history_limit=2_000,
        alternate_on=False,
        dead=False,
        activity=1,
    )


def make_session(path: Path, *, pane_id: str = "%3") -> Session:
    return Session(
        name="files-agent",
        id="$7",
        windows=1,
        attached=0,
        created=1_700_000_000,
        panes=[make_pane(path, pane_id)],
    )


class FileBrowserFakeTmux(TmuxClient):
    def __init__(self, sessions: list[Session] | TmuxError) -> None:
        self.sessions = sessions

    async def list_sessions(self) -> list[Session]:
        if isinstance(self.sessions, TmuxError):
            raise self.sessions
        return list(self.sessions)


async def make_client(tmux: TmuxClient) -> TestClient:
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))
    await client.start_server()
    return client


def test_directory_listing_and_file_previews_are_scoped_and_shell_safe(tmp_path):
    nested = tmp_path / "A folder"
    nested.mkdir()
    text_file = nested / "notes with space.txt"
    text_file.write_text("first line\nsecond line\n", encoding="utf-8")
    (tmp_path / "zeta.txt").write_text("z", encoding="utf-8")
    (tmp_path / ".hidden").write_text("secret", encoding="utf-8")
    (tmp_path / "binary.dat").write_bytes(b"abc\x00def")

    listing = file_browser.list_directory(str(tmp_path))
    assert [entry["name"] for entry in listing["entries"]] == [
        "A folder",
        ".hidden",
        "binary.dat",
        "zeta.txt",
    ]
    folder = listing["entries"][0]
    assert folder["kind"] == "directory"
    assert folder["path"] == "A folder"
    assert folder["terminalText"] == f"'{nested}'"
    assert listing["path"] == ""
    assert listing["truncated"] is False

    preview = file_browser.preview_file(
        str(tmp_path),
        "A folder/notes with space.txt",
    )
    assert preview["kind"] == "text"
    assert preview["content"] == "first line\nsecond line\n"
    assert preview["terminalText"] == f"'{text_file}'"
    assert preview["truncated"] is False

    binary = file_browser.preview_file(str(tmp_path), "binary.dat")
    assert binary["kind"] == "binary"
    assert binary["content"] is None


def test_preview_is_capped_without_splitting_invalid_utf8(tmp_path, monkeypatch):
    monkeypatch.setattr(file_browser, "MAX_PREVIEW_BYTES", 5)
    (tmp_path / "large.txt").write_bytes("four\u00e9more".encode())

    preview = file_browser.preview_file(str(tmp_path), "large.txt")

    assert preview["content"] == "four"
    assert preview["previewBytes"] == 5
    assert preview["truncated"] is True
    assert preview["size"] == 10


def test_upload_writes_a_private_file_and_resolves_it_for_download(tmp_path):
    nested = tmp_path / "incoming"
    nested.mkdir()

    uploaded = file_browser.upload_file(
        str(tmp_path),
        "incoming",
        "build notes.txt",
        b"ready\n",
    )

    destination = nested / "build notes.txt"
    assert destination.read_bytes() == b"ready\n"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert uploaded == {
        "name": "build notes.txt",
        "kind": "file",
        "size": 6,
        "modified": destination.stat().st_mtime,
        "hidden": False,
        "symlink": False,
        "accessible": True,
        "path": "incoming/build notes.txt",
        "absolutePath": str(destination),
        "terminalText": f"'{destination}'",
    }
    download = file_browser.resolve_file_download(
        str(tmp_path),
        "incoming/build notes.txt",
    )
    assert download.path == destination
    assert download.name == "build notes.txt"


def test_upload_refuses_overwrites_unsafe_names_and_escaped_directories(
    tmp_path,
    monkeypatch,
):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    existing = root / "existing.txt"
    existing.write_text("keep me", encoding="utf-8")
    (root / "outside-link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(
        file_browser.FileBrowserDestinationExistsError,
        match="already exists",
    ):
        file_browser.upload_file(str(root), "", "existing.txt", b"replace me")
    assert existing.read_text(encoding="utf-8") == "keep me"

    for unsafe_name in ("../secret", "nested/file", r"nested\file", ".", "bad\nname"):
        with pytest.raises(ValueError):
            file_browser.upload_file(str(root), "", unsafe_name, b"data")
    with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
        file_browser.upload_file(str(root), "outside-link", "escaped.txt", b"data")
    assert not (outside / "escaped.txt").exists()

    monkeypatch.setattr(file_browser, "MAX_FILE_UPLOAD_BYTES", 3)
    with pytest.raises(ValueError, match="smaller"):
        file_browser.upload_file(str(root), "", "large.bin", b"1234")


def test_paths_cannot_escape_the_pane_working_directory(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("not exposed", encoding="utf-8")
    (root / "outside-link").symlink_to(outside, target_is_directory=True)
    (root / "loop").symlink_to("loop")

    with pytest.raises(ValueError, match="cannot navigate outside"):
        file_browser.list_directory(str(root), "../outside")
    with pytest.raises(ValueError, match="must be relative"):
        file_browser.preview_file(str(root), str(outside / "secret.txt"))
    with pytest.raises(
        file_browser.FileBrowserPathOutsideRootError,
        match="resolves outside",
    ):
        file_browser.list_directory(str(root), "outside-link")
    with pytest.raises(
        file_browser.FileBrowserPathOutsideRootError,
        match="resolved safely",
    ):
        file_browser.preview_file(str(root), "loop")

    listing = file_browser.list_directory(str(root))
    link = next(entry for entry in listing["entries"] if entry["name"] == "outside-link")
    assert link["name"] == "outside-link"
    assert link["symlink"] is True
    assert link["accessible"] is False
    loop = next(entry for entry in listing["entries"] if entry["name"] == "loop")
    assert loop["symlink"] is True
    assert loop["accessible"] is False


async def test_file_browser_api_uses_live_session_and_pane_identity(tmp_path):
    nested = tmp_path / "src"
    nested.mkdir()
    (nested / "main.py").write_text("print('hello')\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    try:
        response = await client.get(
            "/api/sessions/files-agent/files",
            params={"sessionId": "$7", "paneId": "%3", "path": "src"},
        )
        assert response.status == 200
        listing = await response.json()
        assert listing["root"] == str(tmp_path)
        assert listing["path"] == "src"
        assert [entry["name"] for entry in listing["entries"]] == ["main.py"]

        preview_response = await client.get(
            "/api/sessions/files-agent/files/preview",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "src/main.py",
            },
        )
        assert preview_response.status == 200
        preview = await preview_response.json()
        assert preview["content"] == "print('hello')\n"
        assert preview["absolutePath"] == str(nested / "main.py")
    finally:
        await client.close()


async def test_file_browser_api_uploads_without_overwrite_and_streams_downloads(
    tmp_path,
):
    nested = tmp_path / "incoming"
    nested.mkdir()
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    try:
        filename = 'r\u00e9sum\u00e9 "draft".txt'
        upload = await client.post(
            "/api/sessions/files-agent/files/upload",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "incoming",
                "filename": filename,
            },
            data=b"candidate\n",
        )
        assert upload.status == 201
        uploaded = await upload.json()
        assert uploaded["path"] == f"incoming/{filename}"
        assert uploaded["absolutePath"] == str(nested / filename)
        assert uploaded["size"] == 10
        assert stat.S_IMODE((nested / filename).stat().st_mode) == 0o600

        conflict = await client.post(
            "/api/sessions/files-agent/files/upload",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "incoming",
                "filename": filename,
            },
            data=b"replacement",
        )
        assert conflict.status == 409
        assert "already exists" in (await conflict.json())["error"]
        assert (nested / filename).read_bytes() == b"candidate\n"

        download = await client.get(
            "/api/sessions/files-agent/files/download",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": f"incoming/{filename}",
            },
        )
        assert download.status == 200
        assert await download.read() == b"candidate\n"
        assert download.headers["Cache-Control"] == "private, no-store"
        assert download.headers["Content-Disposition"].startswith("attachment;")
        assert (
            "filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22.txt"
            in download.headers["Content-Disposition"]
        )
    finally:
        await client.close()


async def test_file_browser_api_rejects_stale_or_invalid_identity(tmp_path):
    scenarios = [
        ({"sessionId": "$8", "paneId": "%3"}, 409, "session identity changed"),
        ({"sessionId": "$7", "paneId": "%4"}, 409, "pane identity changed"),
        ({"sessionId": "7", "paneId": "%3"}, 400, "invalid tmux session id"),
        ({"sessionId": "$7", "paneId": "3"}, 400, "invalid tmux pane id"),
    ]
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    try:
        for query, expected_status, expected_error in scenarios:
            response = await client.get(
                "/api/sessions/files-agent/files",
                params=query,
            )
            assert response.status == expected_status
            assert expected_error in (await response.json())["error"]
    finally:
        await client.close()


async def test_file_browser_api_validates_queries_and_containment(tmp_path, monkeypatch):
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("private", encoding="utf-8")
    (tmp_path / "outside-link").symlink_to(outside, target_is_directory=True)
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    try:
        missing = await client.get(
            "/api/sessions/files-agent/files",
            params={"sessionId": "$7"},
        )
        assert missing.status == 400
        assert await missing.json() == {"error": "paneId is required"}

        unknown = await client.get(
            "/api/sessions/files-agent/files",
            params={"sessionId": "$7", "paneId": "%3", "root": "/"},
        )
        assert unknown.status == 400
        assert await unknown.json() == {"error": "unknown query field: root"}

        escape = await client.get(
            "/api/sessions/files-agent/files",
            params={"sessionId": "$7", "paneId": "%3", "path": ".."},
        )
        assert escape.status == 400
        assert "cannot navigate outside" in (await escape.json())["error"]

        missing_preview_path = await client.get(
            "/api/sessions/files-agent/files/preview",
            params={"sessionId": "$7", "paneId": "%3"},
        )
        assert missing_preview_path.status == 400
        assert await missing_preview_path.json() == {"error": "path is required"}

        missing_download_path = await client.get(
            "/api/sessions/files-agent/files/download",
            params={"sessionId": "$7", "paneId": "%3"},
        )
        assert missing_download_path.status == 400
        assert await missing_download_path.json() == {"error": "path is required"}

        escaped_download = await client.get(
            "/api/sessions/files-agent/files/download",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "outside-link/secret.txt",
            },
        )
        assert escaped_download.status == 403

        missing_upload_name = await client.post(
            "/api/sessions/files-agent/files/upload",
            params={"sessionId": "$7", "paneId": "%3"},
            data=b"data",
        )
        assert missing_upload_name.status == 400
        assert await missing_upload_name.json() == {"error": "filename is required"}

        stale_upload = await client.post(
            "/api/sessions/files-agent/files/upload",
            params={
                "sessionId": "$8",
                "paneId": "%3",
                "filename": "stale.txt",
            },
            data=b"data",
        )
        assert stale_upload.status == 409
        assert not (tmp_path / "stale.txt").exists()

        monkeypatch.setattr("tmux_console.app.MAX_FILE_UPLOAD_BYTES", 3)
        oversized_upload = await client.post(
            "/api/sessions/files-agent/files/upload",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "filename": "large.bin",
            },
            data=b"1234",
        )
        assert oversized_upload.status == 413
        assert not (tmp_path / "large.bin").exists()
    finally:
        await client.close()
