from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import file_browser
from tmux_console.app import create_app
from tmux_console.tmux import Pane, Session, TmuxClient, TmuxError

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"preview payload"


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

    listing = file_browser.list_directory(str(tmp_path), boundary=None)
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
        boundary=None,
    )
    assert preview["kind"] == "text"
    assert preview["content"] == "first line\nsecond line\n"
    assert preview["terminalText"] == f"'{text_file}'"
    assert preview["truncated"] is False

    binary = file_browser.preview_file(str(tmp_path), "binary.dat", boundary=None)
    assert binary["kind"] == "binary"
    assert binary["content"] is None


def test_preview_is_capped_without_splitting_invalid_utf8(tmp_path, monkeypatch):
    monkeypatch.setattr(file_browser, "MAX_PREVIEW_BYTES", 5)
    (tmp_path / "large.txt").write_bytes("four\u00e9more".encode())

    preview = file_browser.preview_file(str(tmp_path), "large.txt", boundary=None)

    assert preview["content"] == "four"
    assert preview["previewBytes"] == 5
    assert preview["truncated"] is True
    assert preview["size"] == 10


@pytest.mark.parametrize(
    ("name", "content", "media_type"),
    [
        ("pixel.png", PNG_BYTES, "image/png"),
        ("photo.jpg", b"\xff\xd8\xff\xe0jpeg", "image/jpeg"),
        ("motion.gif", b"GIF89aimage", "image/gif"),
        ("tile.webp", b"RIFF\x08\x00\x00\x00WEBPimage", "image/webp"),
        ("frame.bmp", b"BMimage", "image/bmp"),
        ("favicon.ico", b"\x00\x00\x01\x00image", "image/x-icon"),
        (
            "still.avif",
            b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avif",
            "image/avif",
        ),
    ],
)
def test_raster_images_are_detected_by_signature(
    tmp_path,
    name,
    content,
    media_type,
):
    image = tmp_path / name
    image.write_bytes(content)

    preview = file_browser.preview_file(str(tmp_path), name, boundary=None)
    resolved = file_browser.resolve_file_image_preview(str(tmp_path), name, boundary=None)

    assert preview["kind"] == "image"
    assert preview["mediaType"] == media_type
    assert preview["content"] is None
    assert preview["previewBytes"] == len(content)
    assert preview["truncated"] is False
    assert resolved.path == image
    assert resolved.name == name
    assert resolved.media_type == media_type


def test_image_preview_rejects_unsupported_and_oversized_content(
    tmp_path,
    monkeypatch,
):
    (tmp_path / "disguised.png").write_text(
        "<html>not an image</html>",
        encoding="utf-8",
    )
    oversized = tmp_path / "oversized.png"
    oversized.write_bytes(PNG_BYTES)
    monkeypatch.setattr(file_browser, "MAX_IMAGE_PREVIEW_BYTES", 8)

    with pytest.raises(
        file_browser.FileBrowserUnsupportedImageError,
        match="supported raster image",
    ):
        file_browser.resolve_file_image_preview(str(tmp_path), "disguised.png", boundary=None)

    preview = file_browser.preview_file(str(tmp_path), "oversized.png", boundary=None)
    assert preview["kind"] == "image"
    assert preview["previewBytes"] == 8
    assert preview["truncated"] is True
    with pytest.raises(
        file_browser.FileBrowserImageTooLargeError,
        match="inline preview limit",
    ):
        file_browser.resolve_file_image_preview(str(tmp_path), "oversized.png", boundary=None)


def test_upload_writes_a_private_file_and_resolves_it_for_download(tmp_path):
    nested = tmp_path / "incoming"
    nested.mkdir()

    uploaded = file_browser.upload_file(
        str(tmp_path),
        "incoming",
        "build notes.txt",
        b"ready\n",
        boundary=None,
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
        boundary=None,
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
        file_browser.upload_file(str(root), "", "existing.txt", b"replace me", boundary=None)
    assert existing.read_text(encoding="utf-8") == "keep me"

    for unsafe_name in ("../secret", "nested/file", r"nested\file", ".", "bad\nname"):
        with pytest.raises(ValueError):
            file_browser.upload_file(str(root), "", unsafe_name, b"data", boundary=None)
    with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
        file_browser.upload_file(str(root), "outside-link", "escaped.txt", b"data", boundary=None)
    assert not (outside / "escaped.txt").exists()

    monkeypatch.setattr(file_browser, "MAX_FILE_UPLOAD_BYTES", 3)
    with pytest.raises(ValueError, match="smaller"):
        file_browser.upload_file(str(root), "", "large.bin", b"1234", boundary=None)


def test_paths_cannot_escape_the_pane_working_directory(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("not exposed", encoding="utf-8")
    (root / "outside-link").symlink_to(outside, target_is_directory=True)
    (root / "loop").symlink_to("loop")

    with pytest.raises(ValueError, match="cannot navigate outside"):
        file_browser.list_directory(str(root), "../outside", boundary=None)
    with pytest.raises(ValueError, match="must be relative"):
        file_browser.preview_file(str(root), str(outside / "secret.txt"), boundary=None)
    with pytest.raises(
        file_browser.FileBrowserPathOutsideRootError,
        match="resolves outside",
    ):
        file_browser.list_directory(str(root), "outside-link", boundary=None)
    with pytest.raises(
        file_browser.FileBrowserPathOutsideRootError,
        match="resolved safely",
    ):
        file_browser.preview_file(str(root), "loop", boundary=None)

    listing = file_browser.list_directory(str(root), boundary=None)
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
    image_name = "preview image.png"
    (nested / image_name).write_bytes(PNG_BYTES)
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

        image = await client.get(
            "/api/sessions/files-agent/files/image",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": f"incoming/{image_name}",
            },
        )
        assert image.status == 200
        assert await image.read() == PNG_BYTES
        assert image.headers["Content-Type"] == "image/png"
        assert image.headers["Cache-Control"] == "private, no-store"
        assert image.headers["Content-Disposition"].startswith("inline;")
        assert image.headers["Cross-Origin-Resource-Policy"] == "same-origin"
        assert image.headers["X-Content-Type-Options"] == "nosniff"
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
            params={"sessionId": "$7", "paneId": "%3", "depth": "2"},
        )
        assert unknown.status == 400
        assert await unknown.json() == {"error": "unknown query field: depth"}

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

        missing_image_path = await client.get(
            "/api/sessions/files-agent/files/image",
            params={"sessionId": "$7", "paneId": "%3"},
        )
        assert missing_image_path.status == 400
        assert await missing_image_path.json() == {"error": "path is required"}

        escaped_download = await client.get(
            "/api/sessions/files-agent/files/download",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "outside-link/secret.txt",
            },
        )
        assert escaped_download.status == 403

        escaped_image = await client.get(
            "/api/sessions/files-agent/files/image",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "outside-link/secret.txt",
            },
        )
        assert escaped_image.status == 403

        (tmp_path / "not-image.bin").write_bytes(b"plain binary")
        unsupported_image = await client.get(
            "/api/sessions/files-agent/files/image",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "not-image.bin",
            },
        )
        assert unsupported_image.status == 415

        (tmp_path / "large.png").write_bytes(PNG_BYTES)
        monkeypatch.setattr(file_browser, "MAX_IMAGE_PREVIEW_BYTES", 8)
        oversized_image = await client.get(
            "/api/sessions/files-agent/files/image",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "large.png",
            },
        )
        assert oversized_image.status == 413

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


def test_create_entry_makes_private_folders_and_files_without_overwriting(tmp_path):
    folder = file_browser.create_entry(str(tmp_path), "", "reports", "directory", boundary=None)
    assert folder["kind"] == "directory"
    assert folder["path"] == "reports"
    assert folder["size"] is None
    assert stat.S_IMODE((tmp_path / "reports").stat().st_mode) == 0o700

    created = file_browser.create_entry(
        str(tmp_path),
        "reports",
        "draft notes.md",
        "file",
        boundary=None,
    )
    assert created["kind"] == "file"
    assert created["size"] == 0
    assert created["path"] == "reports/draft notes.md"
    assert created["terminalText"] == f"'{tmp_path / 'reports' / 'draft notes.md'}'"
    assert stat.S_IMODE((tmp_path / "reports" / "draft notes.md").stat().st_mode) == 0o600

    with pytest.raises(file_browser.FileBrowserDestinationExistsError):
        file_browser.create_entry(str(tmp_path), "", "reports", "directory", boundary=None)
    with pytest.raises(file_browser.FileBrowserDestinationExistsError):
        file_browser.create_entry(str(tmp_path), "reports", "draft notes.md", "file", boundary=None)

    with pytest.raises(ValueError):
        file_browser.create_entry(str(tmp_path), "", "reports", "socket", boundary=None)


@pytest.mark.parametrize(
    "name",
    ["../escape", "nested/name", "..", ".", "", "bad\x00name", "tab\tname"],
)
def test_create_entry_rejects_names_that_leave_the_current_folder(tmp_path, name):
    with pytest.raises((ValueError, TypeError)):
        file_browser.create_entry(str(tmp_path), "", name, "directory", boundary=None)
    assert sorted(child.name for child in tmp_path.iterdir()) == []


def test_move_entry_renames_relocates_and_refuses_to_clobber(tmp_path):
    (tmp_path / "inbox").mkdir()
    (tmp_path / "archive").mkdir()
    (tmp_path / "inbox" / "note.txt").write_text("body\n", encoding="utf-8")
    (tmp_path / "archive" / "taken.txt").write_text("existing\n", encoding="utf-8")

    renamed = file_browser.move_entry(
        str(tmp_path),
        "inbox/note.txt",
        "inbox/renamed note.txt",
        boundary=None,
    )
    assert renamed["path"] == "inbox/renamed note.txt"
    assert renamed["kind"] == "file"
    assert not (tmp_path / "inbox" / "note.txt").exists()

    moved = file_browser.move_entry(
        str(tmp_path),
        "inbox/renamed note.txt",
        "archive/renamed note.txt",
        boundary=None,
    )
    assert moved["path"] == "archive/renamed note.txt"
    assert (tmp_path / "archive" / "renamed note.txt").read_text() == "body\n"

    with pytest.raises(file_browser.FileBrowserDestinationExistsError):
        file_browser.move_entry(
            str(tmp_path),
            "archive/renamed note.txt",
            "archive/taken.txt",
            boundary=None,
        )
    assert (tmp_path / "archive" / "taken.txt").read_text() == "existing\n"

    with pytest.raises(ValueError):
        file_browser.move_entry(str(tmp_path), "archive", "archive", boundary=None)


def test_move_entry_refuses_folder_cycles_and_escapes(tmp_path):
    outside = tmp_path.parent / "outside-root"
    outside.mkdir(exist_ok=True)
    root = tmp_path / "root"
    (root / "outer" / "inner").mkdir(parents=True)

    with pytest.raises(ValueError):
        file_browser.move_entry(str(root), "outer", "outer/inner/outer", boundary=None)
    assert (root / "outer" / "inner").is_dir()

    for destination in ("../outside-root/stolen", "/tmp/stolen"):
        with pytest.raises((ValueError, TypeError)):
            file_browser.move_entry(str(root), "outer", destination, boundary=None)
    assert (root / "outer").is_dir()


def test_move_entry_moves_the_symlink_itself(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("private\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    (root / "link.txt").symlink_to(secret)

    moved = file_browser.move_entry(str(root), "link.txt", "renamed-link.txt", boundary=None)

    assert moved["symlink"] is True
    assert (root / "renamed-link.txt").is_symlink()
    assert secret.read_text() == "private\n"


def test_copy_entry_duplicates_regular_files_only(tmp_path):
    (tmp_path / "source.txt").write_text("payload\n", encoding="utf-8")
    (tmp_path / "folder").mkdir()

    copied = file_browser.copy_entry(str(tmp_path), "source.txt", "copy of source.txt", boundary=None)

    assert copied["kind"] == "file"
    assert copied["size"] == 8
    assert (tmp_path / "copy of source.txt").read_text() == "payload\n"
    assert (tmp_path / "source.txt").read_text() == "payload\n"

    with pytest.raises(file_browser.FileBrowserDestinationExistsError):
        file_browser.copy_entry(str(tmp_path), "source.txt", "copy of source.txt", boundary=None)
    with pytest.raises(IsADirectoryError):
        file_browser.copy_entry(str(tmp_path), "folder", "folder copy", boundary=None)


def test_copy_entry_refuses_oversized_files(tmp_path, monkeypatch):
    monkeypatch.setattr(file_browser, "MAX_COPY_BYTES", 4)
    (tmp_path / "big.bin").write_bytes(b"12345")

    with pytest.raises(ValueError):
        file_browser.copy_entry(str(tmp_path), "big.bin", "big copy.bin", boundary=None)
    assert not (tmp_path / "big copy.bin").exists()


def test_delete_entry_removes_files_empty_folders_and_confirmed_trees(tmp_path):
    (tmp_path / "solo.txt").write_text("x", encoding="utf-8")
    (tmp_path / "empty").mkdir()
    tree = tmp_path / "tree"
    (tree / "nested").mkdir(parents=True)
    (tree / "nested" / "leaf.txt").write_text("y", encoding="utf-8")

    removed_file = file_browser.delete_entry(str(tmp_path), "solo.txt", boundary=None)
    assert removed_file["kind"] == "file"
    assert removed_file["removedEntries"] == 0
    assert not (tmp_path / "solo.txt").exists()

    removed_empty = file_browser.delete_entry(str(tmp_path), "empty", boundary=None)
    assert removed_empty["kind"] == "directory"
    assert not (tmp_path / "empty").exists()

    with pytest.raises(file_browser.FileBrowserDirectoryNotEmptyError) as blocked:
        file_browser.delete_entry(str(tmp_path), "tree", boundary=None)
    assert "2 entries" in str(blocked.value)
    assert (tree / "nested" / "leaf.txt").exists()

    removed_tree = file_browser.delete_entry(str(tmp_path), "tree", recursive=True, boundary=None)
    assert removed_tree["removedEntries"] == 2
    assert not tree.exists()

    with pytest.raises(ValueError):
        file_browser.delete_entry(str(tmp_path), "", boundary=None)


def test_delete_entry_unlinks_symlinks_without_touching_their_targets(tmp_path):
    secret = tmp_path / "keep.txt"
    secret.write_text("keep\n", encoding="utf-8")
    outside_tree = tmp_path / "keep-tree"
    outside_tree.mkdir()
    (outside_tree / "child.txt").write_text("child\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    (root / "file-link").symlink_to(secret)
    (root / "tree-link").symlink_to(outside_tree)

    file_link = file_browser.delete_entry(str(root), "file-link", boundary=None)
    tree_link = file_browser.delete_entry(str(root), "tree-link", boundary=None)

    assert file_link["symlink"] is True
    assert tree_link["symlink"] is True
    assert not (root / "file-link").exists()
    assert not (root / "tree-link").is_symlink()
    assert secret.read_text() == "keep\n"
    assert (outside_tree / "child.txt").read_text() == "child\n"


def test_delete_entry_refuses_trees_above_the_safety_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(file_browser, "MAX_RECURSIVE_DELETE_ENTRIES", 2)
    tree = tmp_path / "tree"
    tree.mkdir()
    for index in range(4):
        (tree / f"file-{index}.txt").write_text("x", encoding="utf-8")

    with pytest.raises(ValueError):
        file_browser.delete_entry(str(tmp_path), "tree", recursive=True, boundary=None)
    assert len(list(tree.iterdir())) == 4


def test_write_text_file_replaces_content_atomically_and_keeps_mode(tmp_path):
    target = tmp_path / "config.toml"
    target.write_text("old = true\n", encoding="utf-8")
    target.chmod(0o640)
    original = file_browser.preview_file(str(tmp_path), "config.toml", boundary=None)
    assert original["editable"] is True

    saved = file_browser.write_text_file(
        str(tmp_path),
        "config.toml",
        "new = true\n",
        expected_modified=original["modified"],
        boundary=None,
    )

    assert saved["size"] == 11
    assert saved["kind"] == "file"
    assert target.read_text() == "new = true\n"
    assert stat.S_IMODE(target.stat().st_mode) == 0o640
    assert [child.name for child in tmp_path.iterdir()] == ["config.toml"]


def test_write_text_file_reports_conflicts_and_refuses_unsupported_targets(tmp_path):
    target = tmp_path / "notes.txt"
    target.write_text("first\n", encoding="utf-8")
    (tmp_path / "folder").mkdir()
    outside = tmp_path.parent / "write-outside.txt"
    outside.write_text("untouched\n", encoding="utf-8")
    (tmp_path / "link.txt").symlink_to(outside)

    with pytest.raises(file_browser.FileBrowserConflictError):
        file_browser.write_text_file(
            str(tmp_path),
            "notes.txt",
            "second\n",
            expected_modified=1.0,
            boundary=None,
        )
    assert target.read_text() == "first\n"

    with pytest.raises(IsADirectoryError):
        file_browser.write_text_file(str(tmp_path), "folder", "text", boundary=None)
    with pytest.raises(file_browser.FileBrowserUnsupportedFileError):
        file_browser.write_text_file(str(tmp_path), "link.txt", "text", boundary=None)
    assert outside.read_text() == "untouched\n"

    with pytest.raises(FileNotFoundError):
        file_browser.write_text_file(str(tmp_path), "missing.txt", "text", boundary=None)


def test_write_text_file_caps_the_saved_size(tmp_path, monkeypatch):
    monkeypatch.setattr(file_browser, "MAX_TEXT_WRITE_BYTES", 4)
    target = tmp_path / "capped.txt"
    target.write_text("keep\n", encoding="utf-8")

    with pytest.raises(ValueError):
        file_browser.write_text_file(str(tmp_path), "capped.txt", "too long", boundary=None)
    assert target.read_text() == "keep\n"


def test_preview_marks_truncated_and_binary_files_as_not_editable(tmp_path, monkeypatch):
    (tmp_path / "binary.dat").write_bytes(b"a\x00b")
    monkeypatch.setattr(file_browser, "MAX_PREVIEW_BYTES", 2)
    (tmp_path / "long.txt").write_text("many bytes", encoding="utf-8")

    assert file_browser.preview_file(str(tmp_path), "binary.dat", boundary=None)["editable"] is False
    assert file_browser.preview_file(str(tmp_path), "long.txt", boundary=None)["editable"] is False


async def test_file_browser_api_creates_moves_copies_and_deletes_entries(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('x')\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        created = await client.post(
            "/api/sessions/files-agent/files/create",
            params={**identity, "path": ""},
            json={"name": "build output", "kind": "directory"},
        )
        assert created.status == 201
        assert (await created.json())["path"] == "build output"
        assert (tmp_path / "build output").is_dir()

        touched = await client.post(
            "/api/sessions/files-agent/files/create",
            params={**identity, "path": "build output"},
            json={"name": "log.txt", "kind": "file"},
        )
        assert touched.status == 201
        assert (await touched.json())["size"] == 0

        conflict = await client.post(
            "/api/sessions/files-agent/files/create",
            params={**identity, "path": ""},
            json={"name": "build output", "kind": "directory"},
        )
        assert conflict.status == 409

        copied = await client.post(
            "/api/sessions/files-agent/files/copy",
            params={**identity, "path": "src/main.py"},
            json={"destination": "src/main copy.py"},
        )
        assert copied.status == 201
        assert (tmp_path / "src" / "main copy.py").read_text() == "print('x')\n"

        moved = await client.post(
            "/api/sessions/files-agent/files/move",
            params={**identity, "path": "src/main copy.py"},
            json={"destination": "build output/moved.py"},
        )
        assert moved.status == 200
        assert (await moved.json())["path"] == "build output/moved.py"
        assert (tmp_path / "build output" / "moved.py").exists()

        blocked = await client.post(
            "/api/sessions/files-agent/files/delete",
            params={**identity, "path": "build output"},
            json={},
        )
        assert blocked.status == 409
        assert "not empty" in (await blocked.json())["error"]

        removed = await client.post(
            "/api/sessions/files-agent/files/delete",
            params={**identity, "path": "build output"},
            json={"recursive": True},
        )
        assert removed.status == 200
        assert (await removed.json())["removedEntries"] == 2
        assert not (tmp_path / "build output").exists()
        assert (tmp_path / "src" / "main.py").exists()
    finally:
        await client.close()


async def test_file_browser_api_saves_text_with_conflict_detection(tmp_path):
    target = tmp_path / "notes.md"
    target.write_text("first\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        preview = await client.get(
            "/api/sessions/files-agent/files/preview",
            params={**identity, "path": "notes.md"},
        )
        modified = (await preview.json())["modified"]

        saved = await client.put(
            "/api/sessions/files-agent/files/content",
            params={**identity, "path": "notes.md"},
            json={"content": "second\n", "expectedModified": modified},
        )
        assert saved.status == 200
        assert (await saved.json())["size"] == 7
        assert target.read_text() == "second\n"

        stale = await client.put(
            "/api/sessions/files-agent/files/content",
            params={**identity, "path": "notes.md"},
            json={"content": "third\n", "expectedModified": modified},
        )
        assert stale.status == 409
        assert target.read_text() == "second\n"

        unconditional = await client.put(
            "/api/sessions/files-agent/files/content",
            params={**identity, "path": "notes.md"},
            json={"content": "fourth\n"},
        )
        assert unconditional.status == 200
        assert target.read_text() == "fourth\n"
    finally:
        await client.close()


async def test_file_browser_mutation_apis_validate_bodies_and_identity(tmp_path):
    (tmp_path / "keep.txt").write_text("keep\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        cases = [
            ("post", "create", {"path": ""}, {"kind": "file"}, 400),
            ("post", "create", {"path": ""}, {"name": 5}, 400),
            ("post", "create", {"path": ""}, {"name": "x", "kind": "socket"}, 400),
            ("post", "create", {"path": ""}, {"name": "x", "extra": 1}, 400),
            ("post", "move", {"path": "keep.txt"}, {}, 400),
            ("post", "move", {"path": "keep.txt"}, {"destination": 7}, 400),
            ("post", "copy", {"path": "keep.txt"}, {"destination": ""}, 400),
            ("post", "delete", {"path": "keep.txt"}, {"recursive": "yes"}, 400),
            ("put", "content", {"path": "keep.txt"}, {"content": 12}, 400),
            (
                "put",
                "content",
                {"path": "keep.txt"},
                {"content": "x", "expectedModified": "now"},
                400,
            ),
            ("post", "move", {}, {"destination": "other.txt"}, 400),
            ("post", "delete", {"path": "../keep.txt"}, {}, 400),
            ("post", "move", {"path": "keep.txt"}, {"destination": "/tmp/x"}, 400),
        ]
        for method, route, extra_params, body, expected in cases:
            response = await getattr(client, method)(
                f"/api/sessions/files-agent/files/{route}",
                params={**identity, **extra_params},
                json=body,
            )
            assert response.status == expected, (route, body, response.status)

        stale = await client.post(
            "/api/sessions/files-agent/files/delete",
            params={"sessionId": "$9", "paneId": "%3", "path": "keep.txt"},
            json={},
        )
        assert stale.status == 409

        malformed = await client.post(
            "/api/sessions/files-agent/files/create",
            params={**identity, "path": ""},
            data=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status == 400
        assert (tmp_path / "keep.txt").read_text() == "keep\n"
    finally:
        await client.close()


async def test_file_browser_api_saves_heavily_escaped_text_up_to_the_content_cap(
    tmp_path,
):
    target = tmp_path / "escaped.txt"
    target.write_text("original\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3", "path": "escaped.txt"}
    try:
        # Control characters become six-byte \uXXXX escapes, so this body is far
        # larger than the aiohttp application-wide request cap.
        content = "\t" * file_browser.MAX_TEXT_WRITE_BYTES
        saved = await client.put(
            "/api/sessions/files-agent/files/content",
            params=identity,
            json={"content": content},
        )
        assert saved.status == 200
        assert (await saved.json())["size"] == file_browser.MAX_TEXT_WRITE_BYTES
        assert target.read_text() == content

        too_long = await client.put(
            "/api/sessions/files-agent/files/content",
            params=identity,
            json={"content": "x" * (file_browser.MAX_TEXT_WRITE_BYTES + 1)},
        )
        assert too_long.status == 413
        assert "or smaller to save" in (await too_long.json())["error"]
        assert target.read_text() == content
    finally:
        await client.close()


async def test_file_browser_api_rejects_oversized_edit_bodies_as_json(tmp_path):
    target = tmp_path / "capped.txt"
    target.write_text("keep\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    try:
        response = await client.put(
            "/api/sessions/files-agent/files/content",
            params={"sessionId": "$7", "paneId": "%3", "path": "capped.txt"},
            data=b"{" + b"a" * (file_browser.MAX_TEXT_WRITE_BODY_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )
        assert response.status == 413
        assert "or smaller to save" in (await response.json())["error"]
        assert target.read_text() == "keep\n"
    finally:
        await client.close()


def test_copy_entry_refuses_to_follow_a_symlink_out_of_the_root(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("private\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    (root / "link.txt").symlink_to(secret)

    with pytest.raises(file_browser.FileBrowserUnsupportedFileError):
        file_browser.copy_entry(str(root), "link.txt", "stolen.txt", boundary=None)
    assert not (root / "stolen.txt").exists()


def test_copy_entry_keeps_the_source_mode_without_widening_it(tmp_path):
    source = tmp_path / "private.txt"
    source.write_text("secret\n", encoding="utf-8")
    source.chmod(0o640)

    copied = file_browser.copy_entry(str(tmp_path), "private.txt", "private copy.txt", boundary=None)

    assert copied["size"] == 7
    assert stat.S_IMODE((tmp_path / "private copy.txt").stat().st_mode) == 0o640


def test_new_files_never_inherit_setuid_or_setgid_bits(tmp_path):
    source = tmp_path / "tool.sh"
    source.write_text("#!/bin/sh\n", encoding="utf-8")
    source.chmod(0o4755)
    sticky = tmp_path / "sticky.sh"
    sticky.write_text("#!/bin/sh\n", encoding="utf-8")
    sticky.chmod(0o2755)

    file_browser.copy_entry(str(tmp_path), "tool.sh", "copy.sh", boundary=None)
    file_browser.copy_entry(str(tmp_path), "sticky.sh", "sticky copy.sh", boundary=None)
    file_browser.write_text_file(str(tmp_path), "tool.sh", "replaced\n", boundary=None)

    assert stat.S_IMODE((tmp_path / "copy.sh").stat().st_mode) == 0o755
    assert stat.S_IMODE((tmp_path / "sticky copy.sh").stat().st_mode) == 0o755
    # Rewriting must not re-create a setuid inode owned by the server user.
    assert stat.S_IMODE((tmp_path / "tool.sh").stat().st_mode) == 0o755


def test_moving_a_symlink_never_reports_metadata_from_outside_the_root(tmp_path):
    secret = tmp_path / "secret.bin"
    secret.write_bytes(b"x" * 4_321)
    root = tmp_path / "root"
    root.mkdir()
    (root / "escaping").symlink_to(secret)
    (root / "real.txt").write_text("hello", encoding="utf-8")
    (root / "internal").symlink_to(root / "real.txt")

    escaping = file_browser.move_entry(str(root), "escaping", "renamed escaping", boundary=None)
    internal = file_browser.move_entry(str(root), "internal", "renamed internal", boundary=None)

    assert escaping["kind"] == "other"
    assert escaping["size"] is None
    assert escaping["modified"] is None
    assert escaping["accessible"] is False
    assert escaping["symlink"] is True
    # A link that resolves back inside the root is still described normally.
    assert internal["kind"] == "file"
    assert internal["size"] == 5
    assert internal["accessible"] is True
    assert internal["symlink"] is True


def test_preview_marks_symlinked_text_files_as_not_editable(tmp_path):
    target = tmp_path / "real.txt"
    target.write_text("body\n", encoding="utf-8")
    (tmp_path / "link.txt").symlink_to(target)

    assert file_browser.preview_file(str(tmp_path), "real.txt", boundary=None)["editable"] is True
    assert file_browser.preview_file(str(tmp_path), "link.txt", boundary=None)["editable"] is False


@pytest.mark.parametrize("operation", ["create", "delete", "preview"])
def test_over_long_path_components_are_rejected_before_the_kernel(tmp_path, operation):
    long_component = "y" * 4_090
    with pytest.raises(ValueError) as rejected:
        if operation == "create":
            file_browser.create_entry(str(tmp_path), long_component, "child", "file", boundary=None)
        elif operation == "delete":
            file_browser.delete_entry(str(tmp_path), long_component, boundary=None)
        else:
            file_browser.preview_file(str(tmp_path), long_component, boundary=None)
    assert "UTF-8 bytes or fewer" in str(rejected.value)


def test_recursive_delete_reports_a_partial_removal(tmp_path, monkeypatch):
    tree = tmp_path / "tree"
    (tree / "nested").mkdir(parents=True)
    (tree / "nested" / "child.txt").write_text("x", encoding="utf-8")
    (tree / "loose.txt").write_text("y", encoding="utf-8")

    def fail_after_partial_removal(*args, **kwargs):
        (tree / "loose.txt").unlink()
        raise PermissionError(13, "Permission denied")

    # The suite runs as root, where mode bits cannot stop a delete, so the
    # partial failure is injected to cover the reporting path itself.
    monkeypatch.setattr(file_browser.shutil, "rmtree", fail_after_partial_removal)

    with pytest.raises(file_browser.FileBrowserPartialDeleteError) as partial:
        file_browser.delete_entry(str(tmp_path), "tree", recursive=True, boundary=None)

    assert "only partly deleted" in str(partial.value)
    assert isinstance(partial.value.__cause__, PermissionError)
    assert tree.is_dir()


def test_unreadable_subtrees_make_the_entry_count_explicitly_approximate(
    tmp_path,
    monkeypatch,
):
    tree = tmp_path / "tree"
    (tree / "nested").mkdir(parents=True)
    (tree / "nested" / "child.txt").write_text("x", encoding="utf-8")
    (tree / "loose.txt").write_text("y", encoding="utf-8")

    real_scandir = os.scandir

    def refuse_nested(path, *args, **kwargs):
        if str(path).endswith("nested"):
            raise PermissionError(13, "Permission denied")
        return real_scandir(path, *args, **kwargs)

    # Running as root, an unreadable directory has to be simulated.
    monkeypatch.setattr(file_browser.os, "scandir", refuse_nested)

    with pytest.raises(file_browser.FileBrowserDirectoryNotEmptyError) as blocked:
        file_browser.delete_entry(str(tmp_path), "tree", boundary=None)

    assert "at least 2 entries" in str(blocked.value)


def test_a_failed_delete_that_removed_nothing_keeps_its_original_error(
    tmp_path,
    monkeypatch,
):
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "child.txt").write_text("x", encoding="utf-8")

    def refuse_without_removing(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(file_browser.shutil, "rmtree", refuse_without_removing)

    # Nothing was destroyed, so the caller must get the accurate error rather
    # than being sent to look for damage that never happened.
    with pytest.raises(PermissionError) as refused:
        file_browser.delete_entry(str(tmp_path), "tree", recursive=True, boundary=None)
    assert not isinstance(refused.value, file_browser.FileBrowserPartialDeleteError)
    assert (tree / "child.txt").exists()


async def test_absolute_paths_over_the_system_limit_are_client_errors(tmp_path):
    # Entries are created through the parent descriptor, which NAME_MAX bounds
    # rather than PATH_MAX, so a relative path inside our own cap can still
    # build an absolute path the kernel refuses.
    parts: list[str] = []
    while True:
        used = len("/".join(parts))
        room = file_browser.MAX_RELATIVE_PATH_LENGTH - used - (1 if parts else 0)
        size = min(room, file_browser.MAX_FILE_NAME_BYTES)
        if size <= 0:
            break
        component = "p" * size
        file_browser.create_entry(str(tmp_path), "/".join(parts), component, "directory", boundary=None)
        parts.append(component)
    relative = "/".join(parts)
    assert len(relative) <= file_browser.MAX_RELATIVE_PATH_LENGTH
    assert len(str(tmp_path)) + 1 + len(relative) > 4_096

    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3", "path": relative}
    try:
        listed = await client.get(
            "/api/sessions/files-agent/files",
            params=identity,
        )
        created = await client.post(
            "/api/sessions/files-agent/files/create",
            params=identity,
            json={"name": "child", "kind": "file"},
        )
        removed = await client.post(
            "/api/sessions/files-agent/files/delete",
            params=identity,
            json={},
        )
        for response in (listed, created, removed):
            assert response.status == 400, await response.text()
            assert "too long" in (await response.json())["error"]
    finally:
        await client.close()


def test_browse_boundary_rejects_unusable_configuration(tmp_path):
    assert file_browser.resolve_browse_boundary("/") == Path("/")
    assert file_browser.resolve_browse_boundary(str(tmp_path)) == tmp_path.resolve()

    (tmp_path / "plain.txt").write_text("x", encoding="utf-8")
    for value in ["", "   ", "relative/path"]:
        with pytest.raises(ValueError):
            file_browser.resolve_browse_boundary(value)
    with pytest.raises(NotADirectoryError):
        file_browser.resolve_browse_boundary(str(tmp_path / "plain.txt"))
    with pytest.raises(FileNotFoundError):
        file_browser.resolve_browse_boundary(str(tmp_path / "missing"))


def test_resolve_browse_root_confines_navigation_to_the_boundary(tmp_path):
    boundary = tmp_path / "allowed"
    (boundary / "inner").mkdir(parents=True)
    (tmp_path / "denied").mkdir()
    (boundary / "file.txt").write_text("x", encoding="utf-8")

    resolved = file_browser.resolve_browse_root(str(boundary / "inner"), boundary)
    assert resolved == (boundary / "inner").resolve()

    with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
        file_browser.resolve_browse_root(str(tmp_path / "denied"), boundary)
    with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
        file_browser.resolve_browse_root(str(boundary / "inner" / ".."  / ".."), boundary)
    with pytest.raises(NotADirectoryError):
        file_browser.resolve_browse_root(str(boundary / "file.txt"), boundary)
    with pytest.raises(FileNotFoundError):
        file_browser.resolve_browse_root(str(boundary / "missing"), boundary)
    for value in ["", "   ", "relative", "not/absolute"]:
        with pytest.raises(ValueError):
            file_browser.resolve_browse_root(value, boundary)


def test_browsable_parent_stops_at_the_boundary(tmp_path):
    boundary = tmp_path / "allowed"
    nested = boundary / "one" / "two"
    nested.mkdir(parents=True)

    assert file_browser.browsable_parent(str(nested), boundary) == str(nested.parent)
    assert file_browser.browsable_parent(str(boundary / "one"), boundary) == str(boundary)
    # The boundary itself has no navigable parent.
    assert file_browser.browsable_parent(str(boundary), boundary) is None
    assert file_browser.browsable_parent("/", Path("/")) is None


def test_listing_reports_the_parent_it_may_navigate_to(tmp_path):
    boundary = tmp_path / "allowed"
    nested = boundary / "project"
    nested.mkdir(parents=True)

    inside = file_browser.list_directory(str(nested), boundary=boundary)
    assert inside["rootParent"] == str(boundary)

    at_boundary = file_browser.list_directory(str(boundary), boundary=boundary)
    assert at_boundary["rootParent"] is None

    # Without a boundary the listing never advertises upward navigation.
    assert file_browser.list_directory(str(nested), boundary=None)["rootParent"] is None


async def test_file_browser_api_browses_above_the_pane_directory(tmp_path):
    workspace = tmp_path / "workspace"
    pane_directory = workspace / "project" / "src"
    pane_directory.mkdir(parents=True)
    (pane_directory / "main.py").write_text("print('x')\n", encoding="utf-8")
    (workspace / "notes.md").write_text("above the pane\n", encoding="utf-8")

    client = await make_client(FileBrowserFakeTmux([make_session(pane_directory)]))
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        default = await client.get(
            "/api/sessions/files-agent/files",
            params={**identity, "path": ""},
        )
        assert default.status == 200
        listing = await default.json()
        assert listing["root"] == str(pane_directory)
        assert listing["rootParent"] == str(pane_directory.parent)

        above = await client.get(
            "/api/sessions/files-agent/files",
            params={**identity, "path": "", "root": str(workspace)},
        )
        assert above.status == 200
        upper = await above.json()
        assert upper["root"] == str(workspace)
        assert sorted(entry["name"] for entry in upper["entries"]) == [
            "notes.md",
            "project",
        ]

        # Every other operation follows the same root.
        preview = await client.get(
            "/api/sessions/files-agent/files/preview",
            params={**identity, "path": "notes.md", "root": str(workspace)},
        )
        assert preview.status == 200
        assert (await preview.json())["content"] == "above the pane\n"

        created = await client.post(
            "/api/sessions/files-agent/files/create",
            params={**identity, "path": "", "root": str(workspace)},
            json={"name": "archive", "kind": "directory"},
        )
        assert created.status == 201
        assert (workspace / "archive").is_dir()
    finally:
        await client.close()


async def test_file_browser_api_confines_an_explicit_root_to_the_boundary(tmp_path):
    boundary = tmp_path / "allowed"
    pane_directory = boundary / "project"
    pane_directory.mkdir(parents=True)
    denied = tmp_path / "denied"
    denied.mkdir()
    (denied / "secret.txt").write_text("private\n", encoding="utf-8")

    tmux = FileBrowserFakeTmux([make_session(pane_directory)])
    client = TestClient(
        TestServer(
            create_app(tmux=tmux, base_path="", file_browser_root=str(boundary))
        )
    )
    await client.start_server()
    identity = {"sessionId": "$7", "paneId": "%3", "path": ""}
    try:
        allowed = await client.get(
            "/api/sessions/files-agent/files",
            params={**identity, "root": str(boundary)},
        )
        assert allowed.status == 200
        assert (await allowed.json())["rootParent"] is None

        for value in [str(denied), "/", str(tmp_path), str(boundary / ".." / "denied")]:
            refused = await client.get(
                "/api/sessions/files-agent/files",
                params={**identity, "root": value},
            )
            assert refused.status == 403, value
            assert "outside the browsable area" in (await refused.json())["error"]

        blocked = await client.get(
            "/api/sessions/files-agent/files/preview",
            params={
                "sessionId": "$7",
                "paneId": "%3",
                "path": "secret.txt",
                "root": str(denied),
            },
        )
        assert blocked.status == 403

        for value, expected in [("relative", 400), (str(boundary / "missing"), 404)]:
            response = await client.get(
                "/api/sessions/files-agent/files",
                params={**identity, "root": value},
            )
            assert response.status == expected, value
    finally:
        await client.close()


def test_operations_refuse_a_root_outside_the_boundary(tmp_path):
    boundary = tmp_path / "allowed"
    boundary.mkdir()
    outside = tmp_path / "denied"
    outside.mkdir()
    (outside / "secret.txt").write_text("private\n", encoding="utf-8")

    # The boundary is re-checked by each operation against its own resolution,
    # so a root that was never validated at the edge is still refused.
    for operation in [
        lambda: file_browser.list_directory(str(outside), boundary=boundary),
        lambda: file_browser.preview_file(
            str(outside), "secret.txt", boundary=boundary
        ),
        lambda: file_browser.resolve_file_download(
            str(outside), "secret.txt", boundary=boundary
        ),
        lambda: file_browser.create_entry(
            str(outside), "", "planted", "file", boundary=boundary
        ),
        lambda: file_browser.delete_entry(
            str(outside), "secret.txt", boundary=boundary
        ),
        lambda: file_browser.write_text_file(
            str(outside), "secret.txt", "overwritten", boundary=boundary
        ),
        lambda: file_browser.move_entry(
            str(outside), "secret.txt", "moved.txt", boundary=boundary
        ),
        lambda: file_browser.copy_entry(
            str(outside), "secret.txt", "copy.txt", boundary=boundary
        ),
        lambda: file_browser.upload_file(
            str(outside), "", "up.txt", b"x", boundary=boundary
        ),
    ]:
        with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
            operation()

    assert sorted(child.name for child in outside.iterdir()) == ["secret.txt"]
    assert (outside / "secret.txt").read_text() == "private\n"


def test_a_root_swapped_for_an_escaping_symlink_is_caught_at_use(tmp_path):
    boundary = tmp_path / "allowed"
    data = boundary / "data"
    data.mkdir(parents=True)
    (data / "inside.txt").write_text("ordinary\n", encoding="utf-8")
    outside = tmp_path / "denied"
    outside.mkdir()
    (outside / "secret.txt").write_text("private\n", encoding="utf-8")

    # Validated while it is a real directory inside the boundary...
    assert file_browser.resolve_browse_root(str(data), boundary) == data.resolve()

    # ...then swapped, the way a race would land between check and use.
    shutil.rmtree(data)
    data.symlink_to(outside, target_is_directory=True)

    for operation in [
        lambda: file_browser.list_directory(str(data), boundary=boundary),
        lambda: file_browser.preview_file(str(data), "secret.txt", boundary=boundary),
        lambda: file_browser.delete_entry(str(data), "secret.txt", boundary=boundary),
    ]:
        with pytest.raises(file_browser.FileBrowserPathOutsideRootError):
            operation()
    assert (outside / "secret.txt").read_text() == "private\n"


def test_out_of_boundary_roots_answer_identically_whatever_is_there(tmp_path):
    boundary = tmp_path / "allowed"
    boundary.mkdir()
    outside = tmp_path / "denied"
    outside.mkdir()
    (outside / "a-file").write_text("x", encoding="utf-8")
    (outside / "a-dir").mkdir()

    # A directory, a regular file, and a missing path outside the boundary must
    # be indistinguishable, or the error becomes a filesystem oracle.
    messages = set()
    for candidate in [
        outside,
        outside / "a-dir",
        outside / "a-file",
        outside / "a-file" / "deeper",
        outside / "missing",
        outside / "missing" / "deeper",
    ]:
        with pytest.raises(file_browser.FileBrowserPathOutsideRootError) as refused:
            file_browser.resolve_browse_root(str(candidate), boundary)
        messages.add(str(refused.value))
    assert messages == {"that directory is outside the browsable area"}


def test_paths_leaving_the_boundary_by_symlink_answer_identically_too(tmp_path):
    boundary = tmp_path / "allowed"
    boundary.mkdir()
    outside = tmp_path / "denied"
    (outside / "a-dir").mkdir(parents=True)
    (outside / "a-file").write_text("x", encoding="utf-8")
    (boundary / "escape").symlink_to(outside, target_is_directory=True)

    # Lexically these all sit inside the boundary, so containment has to follow
    # the link before answering or the error becomes an oracle again.
    messages = set()
    for candidate in [
        boundary / "escape",
        boundary / "escape" / "a-dir",
        boundary / "escape" / "a-file",
        boundary / "escape" / "a-file" / "deeper",
        boundary / "escape" / "missing",
    ]:
        with pytest.raises(file_browser.FileBrowserPathOutsideRootError) as refused:
            file_browser.resolve_browse_root(str(candidate), boundary)
        messages.add(str(refused.value))
    assert messages == {"that directory is outside the browsable area"}
    # And no resolved path from outside the boundary reaches the caller.
    assert not any(str(outside) in message for message in messages)


async def test_file_browser_api_refuses_a_pane_directory_outside_the_boundary(tmp_path):
    boundary = tmp_path / "allowed"
    boundary.mkdir()
    pane_directory = tmp_path / "denied"
    pane_directory.mkdir()
    (pane_directory / "secret.txt").write_text("private\n", encoding="utf-8")

    # The pane working directory is chosen by typing `cd`, so it cannot be
    # exempt from the boundary or a narrowed boundary means nothing.
    tmux = FileBrowserFakeTmux([make_session(pane_directory)])
    client = TestClient(
        TestServer(
            create_app(tmux=tmux, base_path="", file_browser_root=str(boundary))
        )
    )
    await client.start_server()
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        listed = await client.get(
            "/api/sessions/files-agent/files",
            params={**identity, "path": ""},
        )
        assert listed.status == 403
        assert "outside the browsable area" in (await listed.json())["error"]

        for method, route, body in [
            ("get", "/preview", None),
            ("get", "/download", None),
            ("post", "/create", {"name": "planted", "kind": "file"}),
            ("post", "/delete", {}),
            ("put", "/content", {"content": "overwritten"}),
        ]:
            response = await getattr(client, method)(
                f"/api/sessions/files-agent/files{route}",
                params={**identity, "path": "secret.txt"},
                **({"json": body} if body is not None else {}),
            )
            assert response.status == 403, route

        assert sorted(child.name for child in pane_directory.iterdir()) == ["secret.txt"]
        assert (pane_directory / "secret.txt").read_text() == "private\n"
    finally:
        await client.close()


async def test_file_browser_reads_are_not_embeddable_cross_origin(tmp_path):
    (tmp_path / "notes.txt").write_text("body\n", encoding="utf-8")
    client = await make_client(FileBrowserFakeTmux([make_session(tmp_path)]))
    identity = {"sessionId": "$7", "paneId": "%3"}
    try:
        # GET is a safe method, so the origin guard does not run on reads.
        for route, params in [
            ("", {"path": ""}),
            ("/preview", {"path": "notes.txt"}),
            ("/download", {"path": "notes.txt"}),
        ]:
            response = await client.get(
                f"/api/sessions/files-agent/files{route}",
                params={**identity, **params},
                headers={"Sec-Fetch-Site": "cross-site"},
            )
            assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin", route
    finally:
        await client.close()
