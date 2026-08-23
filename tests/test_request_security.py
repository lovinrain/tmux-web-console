from __future__ import annotations

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.tmux import CreatedSession, Session, TmuxClient


class SecurityFakeTmux(TmuxClient):
    def __init__(self) -> None:
        super().__init__(binary="unused-tmux")
        self.create_calls: list[tuple[str | None, str | None, str | None]] = []

    async def list_sessions(self) -> list[Session]:
        return []

    async def create_session(
        self,
        requested_name: str | None = None,
        theme: str | None = None,
        *,
        start_directory: str | None = None,
    ) -> CreatedSession:
        self.create_calls.append((requested_name, theme, start_directory))
        return CreatedSession(requested_name or "assigned", "$1")


@pytest.mark.asyncio
async def test_untrusted_host_is_rejected_even_when_origin_matches_it():
    client = TestClient(
        TestServer(
            create_app(
                tmux=SecurityFakeTmux(),
                base_path="",
                trusted_origins=(),
            )
        )
    )

    try:
        await client.start_server()
        response = await client.get(
            "/api/health",
            headers={
                "Host": "attacker.example",
                "Origin": "http://attacker.example",
            },
        )
        assert response.status == 403
        assert await response.json() == {"error": "request host is not trusted"}
        assert response.headers["Content-Security-Policy"] == "frame-ancestors 'none'"
        assert response.headers["X-Frame-Options"] == "DENY"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_cross_site_simple_post_is_rejected_before_mutation():
    tmux = SecurityFakeTmux()
    client = TestClient(
        TestServer(create_app(tmux=tmux, base_path="", trusted_origins=()))
    )

    try:
        await client.start_server()
        response = await client.post(
            "/api/sessions",
            data='{"name":"blocked"}',
            headers={
                "Content-Type": "text/plain",
                "Origin": "https://attacker.example",
            },
        )
        assert response.status == 403
        assert await response.json() == {"error": "request origin is not trusted"}
        assert tmux.create_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_configured_reverse_proxy_origin_allows_reads_and_mutations():
    tmux = SecurityFakeTmux()
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                base_path="",
                trusted_origins=("https://console.example.test",),
            )
        )
    )
    proxy_headers = {"Host": "console.example.test"}

    try:
        await client.start_server()
        health = await client.get("/api/health", headers=proxy_headers)
        assert health.status == 200
        assert await health.json() == {"ok": True, "sessions": 0}

        created = await client.post(
            "/api/sessions",
            json={"name": "allowed"},
            headers={
                **proxy_headers,
                "Origin": "https://console.example.test",
            },
        )
        assert created.status == 201
        assert await created.json() == {"session": "allowed", "sessionId": "$1"}
        assert tmux.create_calls == [("allowed", None, None)]
    finally:
        await client.close()


def test_invalid_trusted_origin_configuration_fails_closed():
    with pytest.raises(ValueError, match="absolute http\\(s\\) origins"):
        create_app(trusted_origins=("*",))
