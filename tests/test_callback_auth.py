from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.auth import AuthConfigurationError, AuthStore, provision_auth_file
from tmux_console.callback_auth import CallbackTokenVerifier, callback_token_allows

TOKEN = "callback-test-token-" + "a" * 32


def token_file(tmp_path: Path) -> Path:
    path = tmp_path / "callback-token"
    path.write_text(TOKEN + "\n")
    path.chmod(0o600)
    return path


def test_token_rotation_removal_and_file_permissions(tmp_path: Path) -> None:
    path = token_file(tmp_path)
    verifier = CallbackTokenVerifier(path)
    assert verifier.verify(f"Bearer {TOKEN}")
    assert not verifier.verify(f"Basic {TOKEN}")
    assert not verifier.verify(f"Bearer {TOKEN} ")
    replacement = "b" * 48
    path.write_text(replacement)
    assert not verifier.verify(f"Bearer {TOKEN}")
    assert verifier.verify(f"Bearer {replacement}")
    path.chmod(0o644)
    assert not verifier.verify(f"Bearer {replacement}")
    with pytest.raises(AuthConfigurationError):
        CallbackTokenVerifier(path)
    path.unlink()
    assert not verifier.verify(f"Bearer {replacement}")


def test_unsafe_or_malformed_token_files_fail_closed(tmp_path: Path) -> None:
    path = token_file(tmp_path)
    linked = tmp_path / "linked-token"
    linked.symlink_to(path)
    with pytest.raises(AuthConfigurationError):
        CallbackTokenVerifier(linked)
    for text in ("short", "a" * 131, TOKEN + "\n" + " " * 200, "☃" * 40):
        path.write_text(text)
        with pytest.raises(AuthConfigurationError):
            CallbackTokenVerifier(path)


@pytest.mark.parametrize("prefix", ("", "/mux", "/other"))
def test_callback_scope_is_an_exact_method_and_path_allowlist(prefix: str) -> None:
    for method in ("GET", "HEAD", "POST"):
        assert callback_token_allows(f"{prefix}/api/callback-messages", prefix, method)
    assert callback_token_allows(f"{prefix}/api/callback-messages/msg-1/review", prefix, "POST")
    assert callback_token_allows(f"{prefix}/api/callback-sessions", prefix, "GET")
    for path, method in (
        ("/api/callback-sessions", "POST"),
        ("/api/callback-sessions/review", "POST"),
        ("/api/callback-messages/../sessions", "GET"),
        ("/api/callback-messages/msg-1/review", "GET"),
        ("/api/callback-messages", "DELETE"),
        ("/api/callback-messages-extra", "POST"),
        ("/api/sessions", "GET"),
        ("/ws/terminal", "GET"),
    ):
        assert not callback_token_allows(prefix + path, prefix, method)


@pytest.mark.asyncio
async def test_bearer_is_scoped_and_keeps_host_origin_and_cookie_boundaries(tmp_path: Path) -> None:
    credentials = tmp_path / "auth.json"
    provision_auth_file(credentials, "test-user", "test-password-callbacks")
    app = create_app(
        auth=AuthStore(credentials),
        auth_mode="server",
        auth_cookie_secure=False,
        callback_token_file=token_file(tmp_path),
        base_path="/mux",
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/mux/api/callback-sessions")
        assert response.status == 401
        headers = {"Authorization": f"Bearer {TOKEN}"}
        response = await client.get("/mux/api/callback-sessions", headers=headers)
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert not response.cookies
        posted = await client.post("/mux/api/callback-messages", headers=headers, json={
            "message": "Callback auth integration completed",
            "sessionName": "test-agent", "agentType": "codex", "cwd": "/tmp",
            "requestId": "callback-auth-test",
        })
        assert posted.status == 201
        record = (await posted.json())["callback"]
        listed = await client.get("/mux/api/callback-messages", headers=headers)
        assert listed.status == 200
        assert (await listed.json())["messages"] == [record]
        reviewed = await client.post(
            f'/mux/api/callback-messages/{record["id"]}/review', headers=headers,
        )
        assert reviewed.status == 200
        history = await client.get("/mux/api/callback-messages?status=reviewed", headers=headers)
        assert (await history.json())["messages"][0]["id"] == record["id"]
        for path, method in (
            ("/mux/api/sessions", "GET"),
            ("/mux/ws/terminal", "GET"),
            ("/mux/api/callback-sessions", "POST"),
            ("/mux/api/callback-sessions/review", "POST"),
        ):
            response = await client.request(method, path, headers=headers)
            assert response.status == 403
        response = await client.get(
            "/mux/api/callback-sessions", headers={**headers, "Host": "untrusted.invalid"}
        )
        assert response.status == 403
        response = await client.post(
            "/mux/api/callback-messages", headers={**headers, "Origin": "https://untrusted.invalid"}
        )
        assert response.status == 403
        response = await client.get(
            "/mux/api/callback-sessions",
            headers=[("Authorization", f"Bearer {TOKEN}"), ("Authorization", f"Bearer {TOKEN}")],
        )
        assert response.status == 401
        login = await client.post("/mux/api/auth/login", json={
            "username": "test-user", "password": "test-password-callbacks",
        })
        assert login.status == 200
        response = await client.get("/mux/api/callback-sessions")
        assert response.status == 200
        response = await client.get(
            "/mux/api/callback-sessions", headers={"Authorization": "Bearer " + "x" * 40}
        )
        assert response.status == 401  # Invalid explicit token cannot fall back to a browser cookie.


@pytest.mark.asyncio
async def test_unconfigured_callback_bearer_cannot_bypass_auth(tmp_path: Path) -> None:
    credentials = tmp_path / "auth.json"
    provision_auth_file(credentials, "test-user", "test-password-callbacks")
    app = create_app(auth=AuthStore(credentials), auth_mode="basic", base_path="/mux")
    async with TestClient(TestServer(app)) as client:
        response = await client.get(
            "/mux/api/callback-sessions", headers={"Authorization": f"Bearer {TOKEN}"}
        )
        assert response.status == 401


@pytest.mark.asyncio
async def test_configured_bearer_also_works_with_basic_mode(tmp_path: Path) -> None:
    credentials = tmp_path / "auth.json"
    provision_auth_file(credentials, "test-user", "test-password-callbacks")
    app = create_app(
        auth=AuthStore(credentials), auth_mode="basic", base_path="/mux",
        callback_token_file=token_file(tmp_path),
    )
    async with TestClient(TestServer(app)) as client:
        response = await client.get(
            "/mux/api/callback-messages", headers={"Authorization": f"Bearer {TOKEN}"}
        )
        assert response.status == 200
        assert (await response.json())["messages"] == []
