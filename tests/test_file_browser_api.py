from __future__ import annotations

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


async def test_file_browser_api_validates_queries_and_containment(tmp_path):
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
    finally:
        await client.close()
