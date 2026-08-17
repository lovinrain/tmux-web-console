from __future__ import annotations

import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.workspaces import (
    MAX_SESSION_RENAME_REVISION,
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_TABS,
    WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    WorkspaceStore,
)


def sequence(values):
    iterator = iter(values)
    return lambda: next(iterator)


@pytest.mark.asyncio
async def test_workspaces_api_crud_activity_and_persistence(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=sequence([10, 20, 30]),
        id_factory=lambda: "workspace-id",
    )
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        response = await client.get("/api/workspaces")
        assert response.status == 200
        assert await response.json() == {"workspaces": []}

        response = await client.post(
            "/api/workspaces",
            json={
                "name": "  Main project  ",
                "tabs": ["agent-a", "agent-b"],
                "activeSession": "agent-a",
            },
        )
        assert response.status == 201
        created = (await response.json())["workspace"]
        assert created == {
            "id": "workspace-id",
            "name": "Main project",
            "tabs": ["agent-a", "agent-b"],
            "activeSession": "agent-a",
            "createdAt": 10_000,
            "updatedAt": 10_000,
            "lastActiveAt": 10_000,
            "sessionRevision": 0,
        }

        response = await client.get("/api/workspaces/workspace-id")
        assert response.status == 200
        assert await response.json() == {"workspace": created}

        response = await client.patch(
            "/api/workspaces/workspace-id",
            json={"name": "Renamed project"},
        )
        assert response.status == 200
        renamed = (await response.json())["workspace"]
        assert renamed["name"] == "Renamed project"
        assert renamed["updatedAt"] == 20_000
        assert renamed["lastActiveAt"] == 10_000

        response = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": ["agent-b", "offline"],
                "activeSession": "offline",
                "sessionRevision": 0,
            },
        )
        assert response.status == 200
        active = (await response.json())["workspace"]
        assert active["tabs"] == ["agent-b", "offline"]
        assert active["activeSession"] == "offline"
        assert active["updatedAt"] == 30_000
        assert active["lastActiveAt"] == 30_000
        assert await (await client.get("/api/workspaces")).json() == {
            "workspaces": [active]
        }

        response = await client.delete("/api/workspaces/workspace-id")
        assert response.status == 204
        assert await response.read() == b""
        response = await client.get("/api/workspaces/workspace-id")
        assert response.status == 404
        assert await response.json() == {"error": "workspace not found: workspace-id"}
    finally:
        await client.close()

    assert WorkspaceStore(path).list_workspaces() == []


@pytest.mark.asyncio
async def test_workspaces_api_strict_request_validation(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        for method, path in (
            (client.post, "/api/workspaces"),
            (client.patch, "/api/workspaces/workspace-id"),
            (client.post, "/api/workspaces/workspace-id/activity"),
        ):
            response = await method(path, data="{")
            assert response.status == 400
            assert await response.json() == {"error": "request body must be JSON"}

            response = await method(path, json=[])
            assert response.status == 400
            assert await response.json() == {"error": "request body must be an object"}

        create_cases = [
            (
                {"tabs": [], "activeSession": None},
                "name is required",
            ),
            (
                {"name": "Project", "tabs": []},
                "activeSession is required",
            ),
            (
                {
                    "name": "Project",
                    "tabs": [],
                    "activeSession": None,
                    "extra": True,
                },
                "unknown field: extra",
            ),
            (
                {"name": " ", "tabs": [], "activeSession": None},
                "name cannot be blank",
            ),
            (
                {
                    "name": "x" * (MAX_WORKSPACE_NAME_LENGTH + 1),
                    "tabs": [],
                    "activeSession": None,
                },
                f"name must be {MAX_WORKSPACE_NAME_LENGTH} characters or fewer",
            ),
            (
                {"name": "Project", "tabs": ["a", "a"], "activeSession": "a"},
                "tabs contains duplicate session: a",
            ),
            (
                {
                    "name": "Project",
                    "tabs": [f"s-{index}" for index in range(MAX_WORKSPACE_TABS + 1)],
                    "activeSession": None,
                },
                f"tabs cannot contain more than {MAX_WORKSPACE_TABS} sessions",
            ),
            (
                {"name": "Project", "tabs": [], "activeSession": "missing"},
                "activeSession must be one of the workspace tabs",
            ),
        ]
        for payload, error in create_cases:
            response = await client.post("/api/workspaces", json=payload)
            assert response.status == 400
            assert await response.json() == {"error": error}

        created = await client.post(
            "/api/workspaces",
            json={"name": "Project", "tabs": ["active"], "activeSession": "active"},
        )
        assert created.status == 201

        update_cases = [
            ({}, "name, tabs, or activeSession is required"),
            ({"extra": True}, "unknown field: extra"),
            ({"name": None}, "name must be a string"),
            (
                {"tabs": [], "sessionRevision": 0},
                "activeSession must be one of the workspace tabs",
            ),
            (
                {"activeSession": "missing", "sessionRevision": 0},
                "activeSession must be one",
            ),
            ({"tabs": []}, "sessionRevision is required"),
        ]
        for payload, error in update_cases:
            response = await client.patch("/api/workspaces/workspace-id", json=payload)
            assert response.status == 400
            assert error in (await response.json())["error"]

        activity_cases = [
            ({"tabs": []}, "activeSession is required"),
            ({"activeSession": None}, "sessionRevision is required"),
            (
                {
                    "tabs": [],
                    "activeSession": None,
                    "sessionRevision": 0,
                    "name": "No",
                },
                "unknown field: name",
            ),
            (
                {
                    "tabs": ["active"],
                    "activeSession": "active",
                    "sessionRevision": MAX_SESSION_RENAME_REVISION + 1,
                },
                "sessionRevision cannot exceed JavaScript's maximum safe integer",
            ),
        ]
        for payload, error in activity_cases:
            response = await client.post(
                "/api/workspaces/workspace-id/activity", json=payload
            )
            assert response.status == 400
            assert await response.json() == {"error": error}

        for method in (client.get, client.patch, client.delete):
            kwargs = {"json": {"name": "No"}} if method == client.patch else {}
            response = await method("/api/workspaces/missing", **kwargs)
            assert response.status == 404
            assert await response.json() == {"error": "workspace not found: missing"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_workspaces_api_fails_closed_for_invalid_persisted_state(tmp_path):
    path = tmp_path / "workspaces.json"
    original = b"not valid JSON"
    path.write_bytes(original)
    client = TestClient(
        TestServer(create_app(workspaces=WorkspaceStore(path), base_path=""))
    )

    try:
        await client.start_server()
        response = await client.get("/api/workspaces")
        assert response.status == 503
        assert await response.json() == {"error": WORKSPACE_STORE_UNAVAILABLE_MESSAGE}

        response = await client.post(
            "/api/workspaces",
            json={"name": "Lost", "tabs": [], "activeSession": None},
        )
        assert response.status == 503
        assert await response.json() == {"error": WORKSPACE_STORE_UNAVAILABLE_MESSAGE}
        assert path.read_bytes() == original
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_workspaces_api_reports_persistence_failure_without_mutating_store(
    tmp_path, monkeypatch
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )

    def fail_persist(_workspaces, _session_rename_revision):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(store, "_persist", fail_persist)
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        response = await client.post(
            "/api/workspaces",
            data=json.dumps({"name": "Lost", "tabs": [], "activeSession": None}),
            headers={"Content-Type": "application/json"},
        )
        assert response.status == 500
        assert await response.json() == {"error": "unable to save workspace"}
        assert await (await client.get("/api/workspaces")).json() == {"workspaces": []}
    finally:
        await client.close()
