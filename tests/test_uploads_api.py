from __future__ import annotations

from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.tmux import Session, TmuxClient, TmuxError
from tmux_console.uploads import MAX_ATTACHMENT_UPLOAD_BYTES, AttachmentStore

FILE_BYTES = b"arbitrary file uploaded through the attachment API\x00"


def make_session(name: str = "attachment-agent", session_id: str = "$7") -> Session:
    return Session(
        name=name,
        id=session_id,
        windows=1,
        attached=0,
        created=1_700_000_000,
    )


class UploadFakeTmux(TmuxClient):
    def __init__(self, sessions: list[Session] | TmuxError) -> None:
        self.sessions = sessions

    async def list_sessions(self) -> list[Session]:
        if isinstance(self.sessions, TmuxError):
            raise self.sessions
        return list(self.sessions)


async def test_upload_attachment_api_validates_identity_and_returns_server_path(tmp_path):
    attachments = AttachmentStore(
        tmp_path / "uploads",
        clock=lambda: 1_700_000_000,
        token_factory=lambda: "api123",
    )
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        attachments=attachments,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "Build notes.md", "sessionId": "$7"},
            data=FILE_BYTES,
            headers={"Content-Type": "text/markdown; charset=utf-8"},
        )

        assert response.status == 201
        payload = await response.json()
        assert payload["name"] == "Build notes.md"
        assert payload["contentType"] == "text/markdown"
        assert payload["size"] == len(FILE_BYTES)
        assert payload["path"].endswith("-Build-notes.md")
        assert payload["terminalText"] == payload["path"]
        assert Path(payload["path"]).read_bytes() == FILE_BYTES
    finally:
        await client.close()


async def test_legacy_image_route_uses_the_generic_attachment_store(tmp_path):
    attachments = AttachmentStore(tmp_path / "uploads")
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        attachments=attachments,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/api/sessions/attachment-agent/images",
            params={"filename": "legacy.svg", "sessionId": "$7"},
            data=b"<svg></svg>",
            headers={"Content-Type": "image/svg+xml"},
        )

        assert response.status == 201
        payload = await response.json()
        assert payload["contentType"] == "image/svg+xml"
        assert payload["path"].endswith("-legacy.svg")
    finally:
        await client.close()


async def test_upload_attachment_api_rejects_stale_missing_and_unavailable_sessions(tmp_path):
    scenarios = [
        (UploadFakeTmux([make_session()]), "$8", 409, "identity changed"),
        (UploadFakeTmux([]), "$7", 404, "session not found"),
        (
            UploadFakeTmux(TmuxError("tmux inventory unavailable")),
            "$7",
            503,
            "tmux inventory unavailable",
        ),
    ]
    for tmux, session_id, status, message in scenarios:
        app = create_app(
            tmux=tmux,
            attachments=AttachmentStore(tmp_path / f"uploads-{status}"),
            base_path="",
        )
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            response = await client.post(
                "/api/sessions/attachment-agent/attachments",
                params={"filename": "context.txt", "sessionId": session_id},
                data=FILE_BYTES,
            )
            assert response.status == status
            assert message in (await response.json())["error"]
        finally:
            await client.close()


async def test_upload_attachment_api_rejects_bad_queries_files_and_capacity(tmp_path):
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        attachments=AttachmentStore(tmp_path / "uploads", max_total_bytes=0),
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        missing_name = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"sessionId": "$7"},
            data=FILE_BYTES,
        )
        assert missing_name.status == 400
        assert await missing_name.json() == {"error": "filename is required"}

        unknown_query = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "x.txt", "sessionId": "$7", "path": "/tmp/x"},
            data=FILE_BYTES,
        )
        assert unknown_query.status == 400
        assert await unknown_query.json() == {"error": "unknown query field: path"}

        empty = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "empty.txt", "sessionId": "$7"},
            data=b"",
        )
        assert empty.status == 400
        assert "cannot be empty" in (await empty.json())["error"]

        full = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "context.txt", "sessionId": "$7"},
            data=FILE_BYTES,
        )
        assert full.status == 507
        assert "storage is full" in (await full.json())["error"]
    finally:
        await client.close()


async def test_upload_attachment_api_rejects_oversized_request_before_storage(tmp_path):
    attachments = AttachmentStore(tmp_path / "uploads")
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        attachments=attachments,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "huge.bin", "sessionId": "$7"},
            data=b"x" * (MAX_ATTACHMENT_UPLOAD_BYTES + 1),
        )

        assert response.status == 413
        assert "12 MiB or smaller" in (await response.json())["error"]
        assert not attachments.path.exists()
    finally:
        await client.close()


async def test_upload_attachment_api_streams_files_larger_than_json_limit(tmp_path):
    attachments = AttachmentStore(tmp_path / "uploads")
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        attachments=attachments,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        file_bytes = b"x" * (2 * 1024 * 1024)
        response = await client.post(
            "/api/sessions/attachment-agent/attachments",
            params={"filename": "large.tar", "sessionId": "$7"},
            data=file_bytes,
            headers={"Content-Type": "application/x-tar"},
        )

        assert response.status == 201
        payload = await response.json()
        assert payload["size"] == len(file_bytes)
        assert payload["contentType"] == "application/x-tar"
        assert Path(payload["path"]).stat().st_size == len(file_bytes)
    finally:
        await client.close()
