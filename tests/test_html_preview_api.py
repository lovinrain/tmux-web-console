from __future__ import annotations

import base64
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import quote

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from tmux_console.app import AUTH_COOKIE_NAME, HTML_PREVIEW_GRANTS_KEY, create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.tmux import Pane, Session, TmuxClient

USERNAME = "preview-user"
PASSWORD = "preview-password"
HTML_BYTES = (
    b"<!doctype html><button id='action'>Run</button>"
    b"<script>document.querySelector('#action').onclick=()=>document.title='done'</script>"
)
SVG_BYTES = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


class PreviewTmux(TmuxClient):
    def __init__(self, root: Path) -> None:
        self.sessions = [Session(
            name="files-agent", id="$7", windows=1, attached=0,
            created=1_700_000_000, server_started=1_699_000_000, server_pid=12345,
            panes=[Pane(
                id="%3", index=0, window_index=0, window_name="main",
                window_active=True, active=True, command="bash", path=str(root),
                title="shell", width=100, height=30, history_size=0,
                history_limit=2_000, alternate_on=False, dead=False, activity=1,
            )],
        )]

    async def list_sessions(self) -> list[Session]:
        return list(self.sessions)


@dataclass
class PreviewApi:
    client: TestClient
    app: web.Application
    tmux: PreviewTmux
    root: Path


@pytest.fixture
async def preview_api(tmp_path: Path):
    root = tmp_path / "workspace"
    reports = root / "reports"
    (reports / "assets").mkdir(parents=True)
    (reports / "report page.html").write_bytes(HTML_BYTES)
    (reports / "assets" / "app.js").write_text("export const answer = 42;")
    (reports / "assets" / "style.css").write_text("button { color: red; }")
    (reports / "data.json").write_text('{"answer":42}')
    (reports / "image.svg").write_bytes(SVG_BYTES)
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, USERNAME, PASSWORD)
    tmux = PreviewTmux(root)
    app = create_app(
        tmux=tmux, base_path="/mux", trusted_origins=(),
        auth=AuthStore(auth_path), auth_cookie_secure=False,
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield PreviewApi(client, app, tmux, root)
    finally:
        await client.close()


async def login(api: PreviewApi) -> None:
    response = await api.client.post(
        "/mux/login", data={"username": USERNAME, "password": PASSWORD},
        allow_redirects=False,
    )
    assert response.status == 303


async def issue_preview(api: PreviewApi) -> str:
    await login(api)
    response = await api.client.get(
        "/mux/api/sessions/files-agent/files/html",
        params={"sessionId": "$7", "paneId": "%3", "path": "reports/report page.html"},
        allow_redirects=False,
    )
    assert response.status == 303
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "Access-Control-Allow-Origin" not in response.headers
    location = response.headers["Location"]
    assert location.startswith("/mux/preview/")
    assert location.endswith("/report%20page.html")
    return location


def preview_directory(location: str) -> str:
    return location.rsplit("/", 1)[0] + "/"


def preview_token(location: str) -> str:
    return location.split("/")[3]


async def test_preview_issuance_requires_console_authentication(preview_api):
    response = await preview_api.client.get(
        "/mux/api/sessions/files-agent/files/html",
        params={"sessionId": "$7", "paneId": "%3", "path": "reports/report page.html"},
        allow_redirects=False,
    )
    assert response.status == 401
    assert "Location" not in response.headers
    assert "Access-Control-Allow-Origin" not in response.headers


async def test_preview_and_sibling_assets_work_without_console_credentials(preview_api):
    location = await issue_preview(preview_api)
    preview_api.client.session.cookie_jar.clear()
    expected = {
        "report page.html": (HTML_BYTES, "text/html"),
        "assets/app.js": (b"export const answer = 42;", "text/javascript"),
        "assets/style.css": (b"button { color: red; }", "text/css"),
        "data.json": (b'{"answer":42}', "application/json"),
        "image.svg": (SVG_BYTES, "image/svg+xml"),
    }
    for path, (body, media_type) in expected.items():
        response = await preview_api.client.get(
            preview_directory(location) + quote(path), headers={"Origin": "null"},
            allow_redirects=False,
        )
        assert response.status == 200
        assert await response.read() == body
        assert response.content_type == media_type
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        assert "Access-Control-Allow-Credentials" not in response.headers
        assert response.headers["Cross-Origin-Resource-Policy"] == "cross-origin"
        assert response.headers["Cache-Control"] == "private, no-store"
        assert response.headers["Referrer-Policy"] == "no-referrer"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert "Set-Cookie" not in response.headers

    head = await preview_api.client.head(location, headers={"Origin": "null"})
    assert head.status == 200
    assert head.content_length == len(HTML_BYTES)
    assert await head.read() == b""
    assert "Set-Cookie" not in head.headers


async def test_preview_scripts_stay_in_an_opaque_origin_with_scoped_network_access(preview_api):
    location = await issue_preview(preview_api)
    response = await preview_api.client.get(location)
    policy = response.headers["Content-Security-Policy"]
    directives = {
        directive.strip().split(" ", 1)[0]: directive.strip().split(" ")[1:]
        for directive in policy.split(";") if directive.strip()
    }
    assert directives["sandbox"] == ["allow-scripts"]
    assert "'unsafe-inline'" in directives["script-src"]
    assert "https://cdn.jsdelivr.net" in directives["script-src"]
    assert len(directives["connect-src"]) == 1
    assert directives["connect-src"][0].endswith(preview_directory(location))
    assert "'self'" not in directives["connect-src"]
    for directive in ("default-src", "base-uri", "form-action", "frame-ancestors", "frame-src", "object-src", "worker-src"):
        assert directives[directive] == ["'none'"]
    assert response.headers["X-Frame-Options"] == "DENY"


async def test_preview_never_renews_console_cookie_even_for_logged_in_browser(preview_api):
    location = await issue_preview(preview_api)
    assert preview_api.client.session.cookie_jar.filter_cookies(
        preview_api.client.make_url("/mux/")
    )[AUTH_COOKIE_NAME]
    preview = await preview_api.client.get(location)
    asset = await preview_api.client.get(preview_directory(location) + "assets/app.js")
    assert preview.status == asset.status == 200
    assert "Set-Cookie" not in preview.headers
    assert "Set-Cookie" not in asset.headers
    health = await preview_api.client.get("/mux/api/health")
    assert health.status == 200
    assert "Set-Cookie" in health.headers
    assert "Access-Control-Allow-Origin" not in health.headers
    assert health.headers["Cross-Origin-Resource-Policy"] == "same-origin"


async def test_preview_token_cannot_authorize_console_apis_or_mutations(preview_api):
    location = await issue_preview(preview_api)
    token = preview_token(location)
    preview_api.client.session.cookie_jar.clear()
    for url, headers in (
        (f"/mux/api/health?token={token}", {}),
        ("/mux/api/health", {"Authorization": f"Bearer {token}"}),
        ("/mux/api/health", {"Cookie": f"{AUTH_COOKIE_NAME}={token}"}),
    ):
        response = await preview_api.client.get(url, headers=headers, allow_redirects=False)
        assert response.status == 401
        assert "Access-Control-Allow-Origin" not in response.headers
    mutation = await preview_api.client.post(location)
    assert mutation.status == 401
    opaque_mutation = await preview_api.client.post(location, headers={"Origin": "null"})
    assert opaque_mutation.status == 403
    socket = await preview_api.client.get(
        f"/mux/ws/terminal?token={token}",
        headers={"Origin": "null", "Upgrade": "websocket"},
    )
    assert socket.status == 403


async def test_preview_capability_does_not_bypass_host_validation(preview_api):
    location = await issue_preview(preview_api)
    response = await preview_api.client.get(
        location, headers={"Host": "attacker.example", "Origin": "http://attacker.example"},
    )
    assert response.status == 403
    assert await response.json() == {"error": "request host is not trusted"}
    assert "Access-Control-Allow-Origin" not in response.headers


@pytest.mark.parametrize("identity", ["id", "created", "server_started", "server_pid", "pane", "missing"])
async def test_preview_revokes_when_session_or_tmux_identity_changes(preview_api, identity):
    location = await issue_preview(preview_api)
    original = preview_api.tmux.sessions[0]
    if identity == "missing":
        preview_api.tmux.sessions = []
    elif identity == "pane":
        preview_api.tmux.sessions = [replace(original, panes=[])]
    else:
        value = "$8" if identity == "id" else getattr(original, identity) + 1
        preview_api.tmux.sessions = [replace(original, **{identity: value})]
    response = await preview_api.client.get(location, allow_redirects=False)
    assert response.status == 410
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert preview_api.app[HTML_PREVIEW_GRANTS_KEY].get(preview_token(location)) is None
    # Even a later session with the old metadata cannot resurrect a revoked grant.
    preview_api.tmux.sessions = [original]
    assert (await preview_api.client.get(location)).status == 410


async def test_expired_and_unknown_preview_grants_fail_without_login_redirect(preview_api, monkeypatch):
    store = preview_api.app[HTML_PREVIEW_GRANTS_KEY]
    now = [100.0]
    monkeypatch.setattr(store, "_clock", lambda: now[0])
    location = await issue_preview(preview_api)
    grant = store.get(preview_token(location))
    assert grant is not None
    now[0] = grant.expires_at
    preview_api.client.session.cookie_jar.clear()
    for path in (location, "/mux/preview/" + "x" * 43 + "/report.html"):
        response = await preview_api.client.get(path, allow_redirects=False)
        assert response.status == 410
        assert "expired" in await response.text()
        assert "Location" not in response.headers
        assert "Set-Cookie" not in response.headers
        assert response.headers["Cache-Control"] == "private, no-store"
        assert response.headers["Referrer-Policy"] == "no-referrer"


@pytest.mark.parametrize("path", [
    ".secret.json", ".private/secret.json", "outside.js", "hidden-alias.js",
    "source.py", "assets/", "%2e%2e%2foutside.js", "..%5coutside.js",
])
async def test_preview_cannot_read_outside_granted_web_assets(preview_api, path):
    reports = preview_api.root / "reports"
    (preview_api.root / "outside.js").write_text("outside secret")
    (reports / ".secret.json").write_text('{"secret":true}')
    (reports / ".private").mkdir()
    (reports / ".private" / "secret.json").write_text('{"secret":true}')
    (reports / "outside.js").symlink_to(preview_api.root / "outside.js")
    (reports / "hidden-alias.js").symlink_to(reports / ".secret.json")
    (reports / "source.py").write_text("secret = True")
    location = await issue_preview(preview_api)
    preview_api.client.session.cookie_jar.clear()
    # Preserve encoded traversal in the actual HTTP request instead of allowing
    # the client's URL normalizer to remove it before the server sees it.
    origin = str(preview_api.client.make_url("/")).rstrip("/")
    url = URL(origin + preview_directory(location) + path, encoded=True)
    response = await preview_api.client.session.get(url, allow_redirects=False)
    assert response.status in {400, 403, 415}
    assert "outside secret" not in await response.text()
    assert "Set-Cookie" not in response.headers
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"


async def test_original_svg_preview_remains_script_disabled(preview_api):
    await login(preview_api)
    response = await preview_api.client.get(
        "/mux/api/sessions/files-agent/files/svg",
        params={"sessionId": "$7", "paneId": "%3", "path": "reports/image.svg"},
    )
    assert response.status == 200
    assert await response.read() == SVG_BYTES
    policy = response.headers["Content-Security-Policy"]
    assert "sandbox;" in policy
    assert "script-src 'none'" in policy
    assert "connect-src 'none'" in policy
    assert "Access-Control-Allow-Origin" not in response.headers
    assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"


async def test_preview_scoping_also_applies_with_basic_auth(tmp_path):
    reports = tmp_path / "reports"
    reports.mkdir()
    (reports / "report page.html").write_bytes(HTML_BYTES)
    auth_path = tmp_path / "basic-auth.json"
    provision_auth_file(auth_path, USERNAME, PASSWORD)
    app = create_app(
        tmux=PreviewTmux(tmp_path), base_path="/mux", trusted_origins=(),
        auth=AuthStore(auth_path), auth_mode="basic", auth_cookie_secure=False,
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        auth = base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
        opened = await client.get(
            "/mux/api/sessions/files-agent/files/html",
            params={"sessionId": "$7", "paneId": "%3", "path": "reports/report page.html"},
            headers={"Authorization": f"Basic {auth}"}, allow_redirects=False,
        )
        assert opened.status == 303
        preview = await client.get(opened.headers["Location"], headers={"Origin": "null"})
        assert preview.status == 200
        assert await preview.read() == HTML_BYTES
        assert "Set-Cookie" not in preview.headers
        assert (await client.get("/mux/api/health")).status == 401
    finally:
        await client.close()
