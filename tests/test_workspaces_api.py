from __future__ import annotations

import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.workspaces import (
    MAX_SCOPED_NOTE_LENGTH,
    MAX_SESSION_RENAME_REVISION,
    MAX_WORKSPACE_GROUPS,
    MAX_WORKSPACE_NAME_LENGTH,
    MAX_WORKSPACE_TABS,
    WORKSPACE_STORE_UNAVAILABLE_MESSAGE,
    WorkspaceStore,
)


def sequence(values):
    iterator = iter(values)
    return lambda: next(iterator)


def workspace_group(
    group_id,
    tabs,
    *,
    name="Focus",
    color="blue",
    collapsed=False,
):
    return {
        "id": group_id,
        "name": name,
        "color": color,
        "collapsed": collapsed,
        "tabs": tabs,
    }


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
                "groups": [workspace_group("agents", ["agent-a", "agent-b"])],
                "activeSession": "agent-a",
            },
        )
        assert response.status == 201
        created = (await response.json())["workspace"]
        assert created == {
            "id": "workspace-id",
            "name": "Main project",
            "tabs": ["agent-a", "agent-b"],
            "groups": [workspace_group("agents", ["agent-a", "agent-b"])],
            "quickLinks": [],
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
        assert active["groups"] == [workspace_group("agents", ["agent-b"])]
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
async def test_workspaces_api_updates_groups_and_accepts_legacy_omission(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        clock=sequence([10, 20, 30, 40]),
        id_factory=lambda: "workspace-id",
    )
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        response = await client.post(
            "/api/workspaces",
            json={
                "name": "Project",
                "tabs": ["a", "b", "c"],
                "activeSession": "a",
            },
        )
        assert response.status == 201
        assert (await response.json())["workspace"]["groups"] == []

        response = await client.patch(
            "/api/workspaces/workspace-id",
            json={
                "groups": [workspace_group("pair", ["a", "b"])],
                "sessionRevision": 0,
            },
        )
        assert response.status == 200
        grouped = (await response.json())["workspace"]
        assert grouped["groups"] == [workspace_group("pair", ["a", "b"])]

        response = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": ["c", "a", "b"],
                "groups": [
                    workspace_group(
                        "pair",
                        ["a", "b"],
                        color="cyan",
                        collapsed=True,
                    )
                ],
                "activeSession": "b",
                "sessionRevision": 0,
            },
        )
        assert response.status == 200
        active = (await response.json())["workspace"]
        assert active["groups"] == [
            workspace_group(
                "pair",
                ["a", "b"],
                color="cyan",
                collapsed=True,
            )
        ]

        response = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": ["a", "c", "b"],
                "activeSession": "c",
                "sessionRevision": 0,
            },
        )
        assert response.status == 200
        assert (await response.json())["workspace"]["groups"] == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_workspace_quick_links_api_separates_common_and_saved_workspace_links(
    tmp_path,
):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(
        path,
        clock=sequence([10, 20]),
        id_factory=lambda: "workspace-id",
    )
    store.create_workspace(
        name="Project",
        tabs=["agent"],
        active_session="agent",
    )
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))
    common = [{"id": "docs", "label": "Docs", "url": "https://docs.test/"}]
    workspace = [
        {"id": "ticket", "label": "Ticket 42", "url": "https://issues.test/42"}
    ]

    try:
        await client.start_server()
        assert await (await client.get("/api/workspace-quick-links")).json() == {
            "links": []
        }
        response = await client.put(
            "/api/workspace-quick-links",
            json={"links": common},
        )
        assert response.status == 200
        assert await response.json() == {"links": common}

        assert await (
            await client.get("/api/workspaces/workspace-id/quick-links")
        ).json() == {"links": []}
        response = await client.put(
            "/api/workspaces/workspace-id/quick-links",
            json={"links": workspace},
        )
        assert response.status == 200
        assert await response.json() == {"links": workspace}
        assert await (
            await client.get("/api/workspaces/workspace-id/quick-links")
        ).json() == {"links": workspace}
        assert await (await client.get("/api/workspace-quick-links")).json() == {
            "links": common
        }

        missing = await client.get("/api/workspaces/missing/quick-links")
        assert missing.status == 404
        assert await missing.json() == {"error": "workspace not found: missing"}

        invalid = await client.put(
            "/api/workspace-quick-links",
            json={
                "links": [
                    {"id": "bad", "label": "Bad", "url": "javascript:alert(1)"}
                ]
            },
        )
        assert invalid.status == 400
        assert "valid HTTP or HTTPS URL" in (await invalid.json())["error"]

        for path_name in (
            "/api/workspace-quick-links",
            "/api/workspaces/workspace-id/quick-links",
        ):
            malformed = await client.put(path_name, data="{")
            assert malformed.status == 400
            assert await malformed.json() == {"error": "request body must be JSON"}
            missing_links = await client.put(path_name, json={})
            assert missing_links.status == 400
            assert await missing_links.json() == {"error": "links is required"}
            unknown = await client.put(path_name, json={"links": [], "extra": True})
            assert unknown.status == 400
            assert await unknown.json() == {"error": "unknown field: extra"}
    finally:
        await client.close()

    reloaded = WorkspaceStore(path)
    assert reloaded.list_common_quick_links() == common
    assert reloaded.get_workspace_quick_links("workspace-id") == workspace


@pytest.mark.asyncio
async def test_common_and_workspace_note_apis_are_scoped_and_persistent(tmp_path):
    path = tmp_path / "workspaces.json"
    store = WorkspaceStore(path, id_factory=lambda: "workspace-id")
    store.create_workspace(
        name="Project",
        tabs=["agent"],
        active_session="agent",
    )
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        assert await (await client.get("/api/common-note")).json() == {"note": ""}
        assert await (
            await client.get("/api/workspaces/workspace-id/note")
        ).json() == {"note": ""}

        response = await client.put(
            "/api/common-note",
            json={"note": "Shared\r\nchecklist"},
        )
        assert response.status == 200
        assert await response.json() == {"note": "Shared\nchecklist"}
        response = await client.put(
            "/api/workspaces/workspace-id/note",
            json={"note": "Workspace plan"},
        )
        assert response.status == 200
        assert await response.json() == {"note": "Workspace plan"}
        assert await (await client.get("/api/common-note")).json() == {
            "note": "Shared\nchecklist"
        }

        missing = await client.get("/api/workspaces/missing/note")
        assert missing.status == 404
        assert await missing.json() == {"error": "workspace not found: missing"}
        missing = await client.put(
            "/api/workspaces/missing/note",
            json={"note": "No workspace"},
        )
        assert missing.status == 404
        assert await missing.json() == {"error": "workspace not found: missing"}

        for endpoint in (
            "/api/common-note",
            "/api/workspaces/workspace-id/note",
        ):
            malformed = await client.put(endpoint, data="{")
            assert malformed.status == 400
            assert await malformed.json() == {"error": "request body must be JSON"}
            wrong_shape = await client.put(endpoint, json=[])
            assert wrong_shape.status == 400
            assert await wrong_shape.json() == {
                "error": "request body must be an object"
            }
            missing_note = await client.put(endpoint, json={})
            assert missing_note.status == 400
            assert await missing_note.json() == {"error": "note is required"}
            unknown = await client.put(endpoint, json={"note": "", "extra": True})
            assert unknown.status == 400
            assert await unknown.json() == {"error": "unknown field: extra"}
            invalid = await client.put(endpoint, json={"note": 7})
            assert invalid.status == 400
            assert await invalid.json() == {"error": "note must be a string"}
            too_long = await client.put(
                endpoint,
                json={"note": "x" * (MAX_SCOPED_NOTE_LENGTH + 1)},
            )
            assert too_long.status == 400
            assert "8000 characters or fewer" in (await too_long.json())["error"]
    finally:
        await client.close()

    reloaded = WorkspaceStore(path)
    assert reloaded.get_common_note() == "Shared\nchecklist"
    assert reloaded.get_workspace_note("workspace-id") == "Workspace plan"


@pytest.mark.asyncio
async def test_common_and_workspace_note_apis_report_persistence_failure(
    tmp_path,
    monkeypatch,
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    store.create_workspace(name="Project", tabs=[], active_session=None)

    def fail_persist(
        _workspaces,
        _session_rename_revision,
        _common_quick_links,
        _session_quick_links,
        _notes,
        _pinned_sessions,
    ):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(store, "_persist", fail_persist)
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))

    try:
        await client.start_server()
        common = await client.put("/api/common-note", json={"note": "Shared"})
        assert common.status == 500
        assert await common.json() == {"error": "unable to save common note"}
        workspace = await client.put(
            "/api/workspaces/workspace-id/note",
            json={"note": "Plan"},
        )
        assert workspace.status == 500
        assert await workspace.json() == {"error": "unable to save workspace note"}
        assert store.get_common_note() == ""
        assert store.get_workspace_note("workspace-id") == ""
    finally:
        await client.close()


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
            (
                {
                    "name": "Project",
                    "tabs": [],
                    "groups": None,
                    "activeSession": None,
                },
                "groups must be an array",
            ),
            (
                {
                    "name": "Project",
                    "tabs": ["a"],
                    "groups": [
                        workspace_group("group", ["a"], collapsed="yes")
                    ],
                    "activeSession": "a",
                },
                "groups[0].collapsed must be a boolean",
            ),
            (
                {
                    "name": "Project",
                    "tabs": [f"s-{index}" for index in range(MAX_WORKSPACE_GROUPS + 1)],
                    "groups": [
                        workspace_group(f"group-{index}", [f"s-{index}"])
                        for index in range(MAX_WORKSPACE_GROUPS + 1)
                    ],
                    "activeSession": None,
                },
                f"groups cannot contain more than {MAX_WORKSPACE_GROUPS} groups",
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
            ({}, "name, tabs, groups, or activeSession is required"),
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
            ({"groups": []}, "sessionRevision is required"),
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

        response = await client.get("/api/common-note")
        assert response.status == 503
        assert await response.json() == {"error": WORKSPACE_STORE_UNAVAILABLE_MESSAGE}

        response = await client.get("/api/workspaces/any/note")
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

    def fail_persist(
        _workspaces,
        _session_rename_revision,
        _common_quick_links,
        _session_quick_links,
        _notes,
        _pinned_sessions,
    ):
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
