from __future__ import annotations

import copy

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.shortcuts import (
    DEFAULT_SHORTCUT_BINDINGS,
    SHORTCUT_STORE_UNAVAILABLE_MESSAGE,
    ShortcutStore,
)


def bindings() -> dict[str, dict[str, str | None]]:
    return copy.deepcopy(DEFAULT_SHORTCUT_BINDINGS)


@pytest.mark.asyncio
async def test_shortcuts_api_loads_saves_persists_and_rejects_stale_writes(tmp_path):
    path = tmp_path / "shortcuts.json"
    client = TestClient(TestServer(create_app(
        shortcuts=ShortcutStore(path),
        base_path="",
    )))
    updated = bindings()
    updated["command-palette"]["direct"] = "KeyY"
    updated["terminal-copy-mode"]["direct"] = "KeyH"

    try:
        await client.start_server()
        response = await client.get("/api/shortcuts")
        assert response.status == 200
        assert await response.json() == {"revision": 0, "bindings": bindings()}

        response = await client.put(
            "/api/shortcuts",
            json={"revision": 0, "bindings": updated},
        )
        assert response.status == 200
        saved = await response.json()
        assert saved == {"revision": 1, "bindings": updated}

        response = await client.put(
            "/api/shortcuts",
            json={"revision": 0, "bindings": bindings()},
        )
        assert response.status == 409
        assert (await response.json())["revision"] == 1
        assert await (await client.get("/api/shortcuts")).json() == saved
    finally:
        await client.close()

    assert ShortcutStore(path).get_snapshot() == saved


@pytest.mark.asyncio
async def test_shortcuts_api_rejects_malformed_and_conflicting_requests(tmp_path):
    client = TestClient(TestServer(create_app(
        shortcuts=ShortcutStore(tmp_path / "shortcuts.json"),
        base_path="",
    )))

    try:
        await client.start_server()
        response = await client.put("/api/shortcuts", data="{")
        assert response.status == 400
        assert await response.json() == {"error": "request body must be JSON"}

        cases = [
            ([], "request body must be an object"),
            ({"bindings": bindings()}, "revision is required"),
            ({"revision": 0}, "bindings is required"),
            (
                {"revision": False, "bindings": bindings()},
                "revision must be an integer",
            ),
            (
                {"revision": 0, "bindings": bindings(), "extra": True},
                "unknown field: extra",
            ),
        ]
        for payload, message in cases:
            response = await client.put("/api/shortcuts", json=payload)
            assert response.status == 400
            assert await response.json() == {"error": message}

        duplicate = bindings()
        duplicate["session-end"]["launcher"] = "KeyR"
        response = await client.put(
            "/api/shortcuts",
            json={"revision": 0, "bindings": duplicate},
        )
        assert response.status == 400
        assert "launcher key KeyR is assigned to both" in (
            await response.json()
        )["error"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_shortcuts_api_fails_closed_for_invalid_existing_state(tmp_path):
    path = tmp_path / "shortcuts.json"
    original = b"not valid JSON"
    path.write_bytes(original)
    client = TestClient(TestServer(create_app(
        shortcuts=ShortcutStore(path),
        base_path="",
    )))

    try:
        await client.start_server()
        response = await client.get("/api/shortcuts")
        assert response.status == 503
        assert await response.json() == {"error": SHORTCUT_STORE_UNAVAILABLE_MESSAGE}

        response = await client.put(
            "/api/shortcuts",
            json={"revision": 0, "bindings": bindings()},
        )
        assert response.status == 503
        assert path.read_bytes() == original
    finally:
        await client.close()
