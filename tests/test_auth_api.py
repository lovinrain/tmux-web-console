from __future__ import annotations

import asyncio
import base64
from pathlib import Path

import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import (
    AUTH_COOKIE_MAX_AGE_SECONDS,
    BASIC_AUTH_CHALLENGE,
    create_app,
)
from tmux_console.auth import AuthConfigurationError, AuthStore, provision_auth_file
from tmux_console.pty_bridge import PtyBridge
from tmux_console.tmux import Session, TmuxClient

TEST_USERNAME = "console-user"
TEST_PASSWORD = "correct-horse-console"


class AuthFakeTmux(TmuxClient):
    def __init__(self) -> None:
        super().__init__(binary="unused-tmux")
        self.session = Session(
            name="agent",
            id="$1",
            windows=1,
            attached=0,
            created=1_700_000_000,
        )

    async def list_sessions(self) -> list[Session]:
        return [self.session]

    async def get_session(self, name: str) -> Session:
        assert name == self.session.name
        return self.session


class AuthFakeBridge:
    client_pid = 4321

    def __init__(self) -> None:
        self.output_ready = asyncio.Event()
        self.close_calls = 0

    async def read(self) -> bytes | None:
        await self.output_ready.wait()
        return None

    async def write(self, _data: bytes) -> bool:
        return True

    def resize(self, _cols: int, _rows: int) -> None:
        pass

    async def close(self) -> None:
        self.close_calls += 1


def auth_store(tmp_path: Path) -> AuthStore:
    path = tmp_path / "auth.json"
    provision_auth_file(path, TEST_USERNAME, TEST_PASSWORD)
    return AuthStore(path)


def authenticated_app(tmp_path: Path):
    return create_app(
        tmux=AuthFakeTmux(),
        base_path="/mux",
        trusted_origins=(),
        auth=auth_store(tmp_path),
        auth_cookie_secure=False,
    )


def basic_authorization(username: str, password: str) -> str:
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return f"Basic {encoded}"


def basic_authenticated_app(tmp_path: Path):
    return create_app(
        tmux=AuthFakeTmux(),
        base_path="/mux",
        trusted_origins=(),
        auth=auth_store(tmp_path),
        auth_mode="basic",
        auth_cookie_secure=False,
    )


@pytest.mark.asyncio
async def test_auth_protects_html_api_sse_and_websocket_routes(tmp_path: Path):
    client = TestClient(TestServer(authenticated_app(tmp_path)))
    try:
        await client.start_server()

        html = await client.get(
            "/mux/session/valuable?workspace=one",
            headers={"Accept": "text/html", "Sec-Fetch-Mode": "navigate"},
            allow_redirects=False,
        )
        assert html.status == 303
        assert html.headers["Location"].startswith("/mux/login?next=")

        for path in (
            "/mux/api/health",
            "/mux/api/sessions/stream",
            "/mux/ws/terminal",
        ):
            response = await client.get(path, allow_redirects=False)
            assert response.status == 401
            assert await response.json() == {
                "error": "authentication required",
                "login": "/mux/login",
            }
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_form_login_remembers_browser_and_logout_revokes_it(tmp_path: Path):
    store = auth_store(tmp_path)
    app = create_app(
        tmux=AuthFakeTmux(),
        base_path="/mux",
        trusted_origins=(),
        auth=store,
        auth_cookie_secure=False,
    )
    client = TestClient(TestServer(app))
    try:
        await client.start_server()
        login_page = await client.get("/mux/login")
        assert login_page.status == 200
        assert "shared across tabs" in await login_page.text()
        assert login_page.headers["Cache-Control"] == "no-store"
        assert "form-action 'self'" in login_page.headers["Content-Security-Policy"]

        failed = await client.post(
            "/mux/login",
            data={
                "username": TEST_USERNAME,
                "password": "incorrect-password",
                "next": "/mux/session/test",
            },
            allow_redirects=False,
        )
        assert failed.status == 401
        assert "not correct" in await failed.text()
        assert not store.list_devices()

        logged_in = await client.post(
            "/mux/login",
            data={
                "username": TEST_USERNAME,
                "password": TEST_PASSWORD,
                "next": "/mux/session/test?workspace=one",
            },
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux) Chrome/123.0"},
            allow_redirects=False,
        )
        assert logged_in.status == 303
        assert logged_in.headers["Location"] == "/mux/session/test?workspace=one"
        cookie = logged_in.cookies["muxdeck_device"]
        assert cookie["httponly"]
        assert cookie["samesite"] == "Strict"
        assert cookie["path"] == "/mux"
        assert int(cookie["max-age"]) == AUTH_COOKIE_MAX_AGE_SECONDS

        health = await client.get("/mux/api/health")
        assert health.status == 200
        assert await health.json() == {"ok": True, "sessions": 1}

        account = await client.get("/mux/account")
        assert account.status == 200
        account_text = await account.text()
        assert "Chrome on Linux" in account_text
        assert "this browser" in account_text

        session = await client.get("/mux/api/auth/session")
        session_payload = await session.json()
        assert session_payload["mode"] == "server"
        assert session_payload["authenticated"] is True
        assert session_payload["username"] == TEST_USERNAME
        assert len(session_payload["devices"]) == 1

        logged_out = await client.post("/mux/logout", allow_redirects=False)
        assert logged_out.status == 303
        assert logged_out.headers["Location"] == "/mux/login"
        assert logged_out.cookies["muxdeck_device"]["max-age"] == "0"
        assert not store.list_devices()

        protected = await client.get("/mux/api/health")
        assert protected.status == 401
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_json_login_and_api_logout(tmp_path: Path):
    client = TestClient(TestServer(authenticated_app(tmp_path)))
    try:
        await client.start_server()
        response = await client.post(
            "/mux/api/auth/login",
            json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
            headers={"User-Agent": "Mozilla/5.0 Firefox/125.0"},
        )
        assert response.status == 200
        assert (await response.json())["authenticated"] is True

        session = await client.get("/mux/api/auth/session")
        assert (await session.json())["device"]["label"] == "Firefox on this device"

        logout = await client.post("/mux/api/auth/logout")
        assert logout.status == 200
        assert await logout.json() == {"authenticated": False}
        assert (await client.get("/mux/api/health")).status == 401
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_login_rejects_external_redirect_and_cross_site_post(tmp_path: Path):
    client = TestClient(TestServer(authenticated_app(tmp_path)))
    try:
        await client.start_server()
        blocked = await client.post(
            "/mux/api/auth/login",
            json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
            headers={"Origin": "https://attacker.example"},
        )
        assert blocked.status == 403

        response = await client.post(
            "/mux/login",
            data={
                "username": TEST_USERNAME,
                "password": TEST_PASSWORD,
                "next": "https://attacker.example/steal",
            },
            allow_redirects=False,
        )
        assert response.status == 303
        assert response.headers["Location"] == "/mux/"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_logout_closes_live_sse_stream(tmp_path: Path):
    client = TestClient(TestServer(authenticated_app(tmp_path)))
    try:
        await client.start_server()
        assert (
            await client.post(
                "/mux/api/auth/login",
                json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
            )
        ).status == 200

        stream = await client.get("/mux/api/sessions/stream")
        first_event = await asyncio.wait_for(
            stream.content.readuntil(b"\n\n"), timeout=3
        )
        assert first_event.startswith(b"event: sessions\n")

        assert (await client.post("/mux/api/auth/logout")).status == 200
        revoked_event = await asyncio.wait_for(
            stream.content.readuntil(b"\n\n"), timeout=3
        )
        assert revoked_event == b'event: auth\ndata: {"authenticated":false}\n\n'
        assert await asyncio.wait_for(stream.content.read(), timeout=1) == b""
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_logout_closes_live_terminal_websocket(monkeypatch, tmp_path: Path):
    bridge = AuthFakeBridge()

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(authenticated_app(tmp_path)))
    try:
        await client.start_server()
        assert (
            await client.post(
                "/mux/api/auth/login",
                json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
            )
        ).status == 200
        websocket = await client.ws_connect("/mux/ws/terminal?session=agent")
        assert (await websocket.receive_json())["type"] == "ready"

        assert (await client.post("/mux/api/auth/logout")).status == 200
        message = await asyncio.wait_for(websocket.receive(), timeout=3)
        assert message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED}
        assert websocket.close_code == 4003
    finally:
        await client.close()

    assert bridge.close_calls == 1


def test_configured_missing_auth_file_fails_closed(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("MUXDECK_AUTH_FILE", str(tmp_path / "missing.json"))

    with pytest.raises(AuthConfigurationError):
        create_app(tmux=AuthFakeTmux(), base_path="/mux")


@pytest.mark.parametrize("mode", ["server", "basic"])
def test_explicit_secure_mode_without_auth_file_fails_closed(monkeypatch, mode: str):
    monkeypatch.setenv("MUXDECK_AUTH_MODE", mode)

    with pytest.raises(AuthConfigurationError, match="requires MUXDECK_AUTH_FILE"):
        create_app(tmux=AuthFakeTmux(), base_path="/mux")


def test_invalid_auth_mode_fails_startup(monkeypatch):
    monkeypatch.setenv("MUXDECK_AUTH_MODE", "proxy-ish")

    with pytest.raises(AuthConfigurationError, match="server, basic, none"):
        create_app(tmux=AuthFakeTmux(), base_path="/mux")


@pytest.mark.asyncio
async def test_none_mode_intentionally_ignores_configured_auth_file(
    monkeypatch,
    tmp_path: Path,
):
    missing = tmp_path / "must-not-be-loaded.json"
    monkeypatch.setenv("MUXDECK_AUTH_MODE", "none")
    monkeypatch.setenv("MUXDECK_AUTH_FILE", str(missing))
    client = TestClient(
        TestServer(
            create_app(
                tmux=AuthFakeTmux(),
                base_path="/mux",
                trusted_origins=(),
            )
        )
    )
    try:
        await client.start_server()
        health = await client.get("/mux/api/health")
        assert health.status == 200
        session = await client.get("/mux/api/auth/session")
        assert await session.json() == {
            "mode": "none",
            "enabled": False,
            "authenticated": False,
        }
        account = await client.get("/mux/account")
        assert account.status == 200
        assert "No application" in await account.text()
        assert not missing.exists()
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Bearer abc",
        "Basic !!!",
        "Basic Y29uc29sZS11c2Vy",
        "Basic //46eA==",
        basic_authorization(TEST_USERNAME, "incorrect-password"),
        basic_authorization("somebody-else", TEST_PASSWORD),
    ],
)
async def test_basic_mode_challenges_missing_or_invalid_credentials(
    tmp_path: Path,
    authorization: str | None,
):
    client = TestClient(TestServer(basic_authenticated_app(tmp_path)))
    try:
        await client.start_server()
        headers = {} if authorization is None else {"Authorization": authorization}
        response = await client.get("/mux/api/health", headers=headers)
        assert response.status == 401
        assert response.headers["WWW-Authenticate"] == BASIC_AUTH_CHALLENGE
        assert response.headers["Cache-Control"] == "no-store"
        assert await response.json() == {"error": "authentication required"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_basic_mode_authenticates_api_html_and_stream_without_cookie(
    tmp_path: Path,
):
    store = auth_store(tmp_path)
    app = create_app(
        tmux=AuthFakeTmux(),
        base_path="/mux",
        trusted_origins=(),
        auth=store,
        auth_mode="basic",
        auth_cookie_secure=False,
    )
    client = TestClient(TestServer(app))
    authorization = basic_authorization(TEST_USERNAME, TEST_PASSWORD)
    headers = {"Authorization": authorization}
    try:
        await client.start_server()
        health = await client.get("/mux/api/health", headers=headers)
        assert health.status == 200
        assert "muxdeck_device" not in health.cookies

        session = await client.get("/mux/api/auth/session", headers=headers)
        assert await session.json() == {
            "mode": "basic",
            "enabled": True,
            "authenticated": True,
            "username": TEST_USERNAME,
        }

        account = await client.get("/mux/account", headers=headers)
        assert account.status == 200
        assert "HTTP Basic" in await account.text()
        assert "muxdeck_device" not in account.cookies

        login = await client.get(
            "/mux/login",
            headers=headers,
            allow_redirects=False,
        )
        assert login.status == 303
        assert login.headers["Location"] == "/mux/"

        server_login = await client.post(
            "/mux/api/auth/login",
            headers=headers,
            json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
        )
        assert server_login.status == 404
        assert "muxdeck_device" not in server_login.cookies

        stream = await client.get("/mux/api/sessions/stream", headers=headers)
        first_event = await asyncio.wait_for(
            stream.content.readuntil(b"\n\n"),
            timeout=3,
        )
        assert first_event.startswith(b"event: sessions\n")
        stream.close()

        assert store.list_devices() == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_basic_mode_authenticates_websocket_handshake(monkeypatch, tmp_path: Path):
    bridge = AuthFakeBridge()

    async def fake_attach(cls, *_args, **_kwargs):
        del cls
        return bridge

    monkeypatch.setattr(PtyBridge, "attach", classmethod(fake_attach))
    client = TestClient(TestServer(basic_authenticated_app(tmp_path)))
    try:
        await client.start_server()
        websocket = await client.ws_connect(
            "/mux/ws/terminal?session=agent",
            headers={
                "Authorization": basic_authorization(TEST_USERNAME, TEST_PASSWORD)
            },
        )
        assert (await websocket.receive_json())["type"] == "ready"
        await websocket.close()
    finally:
        await client.close()

    assert bridge.close_calls == 1
