from __future__ import annotations

from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.tmux import Session, TmuxClient, TmuxError
from tmux_console.uploads import MAX_IMAGE_UPLOAD_BYTES, ImageUploadStore

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"uploaded-through-api"


def make_session(name: str = "image-agent", session_id: str = "$7") -> Session:
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


async def test_upload_image_api_validates_identity_and_returns_server_path(tmp_path):
    uploads = ImageUploadStore(
        tmp_path / "uploads",
        clock=lambda: 1_700_000_000,
        token_factory=lambda: "api123",
    )
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        uploads=uploads,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "Screen shot.svg", "sessionId": "$7"},
            data=PNG_BYTES,
            headers={"Content-Type": "image/svg+xml"},
        )

        assert response.status == 201
        payload = await response.json()
        assert payload["name"] == "Screen shot.svg"
        assert payload["contentType"] == "image/png"
        assert payload["size"] == len(PNG_BYTES)
        assert payload["path"].endswith("-Screen-shot.png")
        assert payload["terminalText"] == payload["path"]
        assert Path(payload["path"]).read_bytes() == PNG_BYTES
    finally:
        await client.close()


async def test_upload_image_api_rejects_stale_missing_and_unavailable_sessions(tmp_path):
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
            uploads=ImageUploadStore(tmp_path / f"uploads-{status}"),
            base_path="",
        )
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            response = await client.post(
                "/api/sessions/image-agent/images",
                params={"filename": "image.png", "sessionId": session_id},
                data=PNG_BYTES,
            )
            assert response.status == status
            assert message in (await response.json())["error"]
        finally:
            await client.close()


async def test_upload_image_api_rejects_bad_queries_files_and_capacity(tmp_path):
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        uploads=ImageUploadStore(tmp_path / "uploads", max_total_bytes=0),
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        missing_name = await client.post(
            "/api/sessions/image-agent/images",
            params={"sessionId": "$7"},
            data=PNG_BYTES,
        )
        assert missing_name.status == 400
        assert await missing_name.json() == {"error": "filename is required"}

        unknown_query = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "x.png", "sessionId": "$7", "path": "/tmp/x"},
            data=PNG_BYTES,
        )
        assert unknown_query.status == 400
        assert await unknown_query.json() == {"error": "unknown query field: path"}

        unsupported = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "vector.svg", "sessionId": "$7"},
            data=b"<svg></svg>",
        )
        assert unsupported.status == 400
        assert "PNG, JPEG, GIF, or WebP" in (await unsupported.json())["error"]

        full = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "image.png", "sessionId": "$7"},
            data=PNG_BYTES,
        )
        assert full.status == 507
        assert "storage is full" in (await full.json())["error"]
    finally:
        await client.close()


async def test_upload_image_api_rejects_oversized_request_before_storage(tmp_path):
    uploads = ImageUploadStore(tmp_path / "uploads")
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        uploads=uploads,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "huge.png", "sessionId": "$7"},
            data=b"\x89PNG\r\n\x1a\n" + b"x" * MAX_IMAGE_UPLOAD_BYTES,
        )

        assert response.status == 413
        assert "12 MiB or smaller" in (await response.json())["error"]
        assert not uploads.path.exists()
    finally:
        await client.close()


async def test_upload_image_api_streams_files_larger_than_the_json_body_limit(tmp_path):
    uploads = ImageUploadStore(tmp_path / "uploads")
    app = create_app(
        tmux=UploadFakeTmux([make_session()]),
        uploads=uploads,
        base_path="",
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        image = b"\x89PNG\r\n\x1a\n" + b"x" * (2 * 1024 * 1024)
        response = await client.post(
            "/api/sessions/image-agent/images",
            params={"filename": "large.png", "sessionId": "$7"},
            data=image,
        )

        assert response.status == 201
        payload = await response.json()
        assert payload["size"] == len(image)
        assert Path(payload["path"]).stat().st_size == len(image)
    finally:
        await client.close()
