from __future__ import annotations

import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.snippets import (
    MAX_SNIPPET_REVISION,
    SNIPPET_STORE_UNAVAILABLE_MESSAGE,
    SnippetStore,
)


def snippet(node_id: str, text: str = "run tests") -> dict[str, str]:
    return {
        "id": node_id,
        "type": "snippet",
        "name": node_id,
        "text": text,
    }


@pytest.mark.asyncio
async def test_snippets_api_load_replace_persist_and_detect_stale_writes(tmp_path):
    path = tmp_path / "snippets.json"
    client = TestClient(
        TestServer(
            create_app(
                snippets=SnippetStore(path),
                base_path="",
            )
        )
    )
    tree = [
        {
            "id": "folder",
            "type": "folder",
            "name": " Commands ",
            "children": [snippet("test", "pytest\n")],
        }
    ]

    try:
        await client.start_server()
        response = await client.get("/api/snippets")
        assert response.status == 200
        assert await response.json() == {"revision": 0, "tree": []}

        response = await client.put(
            "/api/snippets", json={"revision": 0, "tree": tree}
        )
        assert response.status == 200
        saved = await response.json()
        assert saved["revision"] == 1
        assert saved["tree"][0]["name"] == "Commands"
        assert saved["tree"][0]["children"][0]["text"] == "pytest\n"
        assert await (await client.get("/api/snippets")).json() == saved

        response = await client.put(
            "/api/snippets",
            json={"revision": 0, "tree": [snippet("overwrite")]},
        )
        assert response.status == 409
        conflict = await response.json()
        assert conflict["revision"] == 1
        assert "current revision is 1" in conflict["error"]
        assert await (await client.get("/api/snippets")).json() == saved
    finally:
        await client.close()

    assert SnippetStore(path).get_snapshot() == saved


@pytest.mark.asyncio
async def test_snippets_api_rejects_malformed_requests(tmp_path):
    client = TestClient(
        TestServer(
            create_app(
                snippets=SnippetStore(tmp_path / "snippets.json"),
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put("/api/snippets", data="{")
        assert response.status == 400
        assert (await response.json())["error"] == "request body must be JSON"

        malformed_documents = [
            b"\xff",
            b'{"revision":' + (b"9" * 5_000) + b',"tree":[]}',
            b'{"revision":0,"tree":'
            + (b"[" * 10_000)
            + b"0"
            + (b"]" * 10_000)
            + b"}",
        ]
        for document in malformed_documents:
            response = await client.put(
                "/api/snippets",
                data=document,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            assert response.status == 400
            assert await response.json() == {"error": "request body must be JSON"}

        cases = [
            ([], "request body must be an object"),
            ({"tree": []}, "revision is required"),
            ({"revision": 0}, "tree is required"),
            ({"revision": False, "tree": []}, "revision must be an integer"),
            ({"revision": -1, "tree": []}, "revision cannot be negative"),
            (
                {"revision": MAX_SNIPPET_REVISION + 1, "tree": []},
                f"revision cannot exceed {MAX_SNIPPET_REVISION}",
            ),
            (
                {"revision": 0, "tree": [], "unexpected": True},
                "unknown field: unexpected",
            ),
            ({"revision": 0, "tree": {}}, "tree must be an array"),
            (
                {
                    "revision": 0,
                    "tree": [snippet("duplicate"), snippet("duplicate")],
                },
                "duplicate snippet node id: duplicate",
            ),
            (
                {
                    "revision": 0,
                    "tree": [snippet("leaf") | {"children": []}],
                },
                "tree[0] has unknown field: children",
            ),
        ]
        for payload, error in cases:
            response = await client.put("/api/snippets", json=payload)
            assert response.status == 400
            assert (await response.json())["error"] == error
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_snippets_api_fails_closed_when_existing_state_is_invalid(tmp_path):
    path = tmp_path / "snippets.json"
    original = b"not valid JSON"
    path.write_bytes(original)
    store = SnippetStore(path)
    client = TestClient(TestServer(create_app(snippets=store, base_path="")))

    try:
        await client.start_server()
        response = await client.get("/api/snippets")
        assert response.status == 503
        assert await response.json() == {
            "error": SNIPPET_STORE_UNAVAILABLE_MESSAGE
        }

        response = await client.put(
            "/api/snippets",
            json={"revision": 0, "tree": [snippet("must-not-overwrite")]},
        )
        assert response.status == 503
        assert await response.json() == {
            "error": SNIPPET_STORE_UNAVAILABLE_MESSAGE
        }
        assert path.read_bytes() == original
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_snippets_api_reports_persistence_failure_without_mutating_store(
    tmp_path, monkeypatch
):
    store = SnippetStore(tmp_path / "snippets.json")

    def fail_persist(_revision, _tree):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(store, "_persist", fail_persist)
    client = TestClient(
        TestServer(create_app(snippets=store, base_path=""))
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/snippets",
            data=json.dumps({"revision": 0, "tree": [snippet("lost")]}),
            headers={"Content-Type": "application/json"},
        )
        assert response.status == 500
        assert await response.json() == {"error": "unable to save snippets"}
        assert await (await client.get("/api/snippets")).json() == {
            "revision": 0,
            "tree": [],
        }
    finally:
        await client.close()
