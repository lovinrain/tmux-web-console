from __future__ import annotations

import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import create_app
from tmux_console.workspaces import (
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


def note_payload(note, *, pages=None):
    notebook = {
        "pages": pages
        or [{"id": "main", "name": "Page 1", "content": note}]
    }
    return {"note": notebook["pages"][0]["content"], "notebook": notebook}


@pytest.mark.asyncio
async def test_separator_api_validates_and_preserves_other_workspace_fields(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post("/api/workspaces", json={
            "name": "Lines", "tabs": ["a", "b"], "activeSession": "a",
            "separators": ["a"],
        })
        assert response.status == 201
        original = (await response.json())["workspace"]
        route = f"/api/workspaces/{original['id']}"
        for invalid in (None, "a", ["missing"], ["a", "a"]):
            response = await client.patch(route, json={
                "separators": invalid, "sessionRevision": 0,
            })
            assert response.status == 400
        response = await client.patch(route, json={"separators": []})
        assert response.status == 400
        response = await client.patch(route, json={
            "separators": ["b"], "sessionRevision": 0,
        })
        assert response.status == 200
        updated = (await response.json())["workspace"]
        assert updated["separators"] == ["b"]
        assert updated["tabs"] == original["tabs"]
        assert updated["groups"] == original["groups"]
        response = await client.patch(route, json={
            "separatorsBefore": ["a"], "sessionRevision": 0,
        })
        assert response.status == 200
        updated = (await response.json())["workspace"]
        assert updated["separatorsBefore"] == ["a"]
        assert updated["separators"] == ["b"]


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


def pane_layout(name="Pair"):
    return {
        "id": "pair-view",
        "name": name,
        "root": {
            "id": "root-split",
            "kind": "split",
            "direction": "horizontal",
            "ratio": 0.5,
            "first": {"id": "left", "kind": "pane", "session": "a"},
            "second": {"id": "right", "kind": "pane", "session": "b"},
        },
    }


@pytest.mark.asyncio
async def test_api_capabilities_are_machine_readable(tmp_path):
    store = WorkspaceStore(tmp_path / "workspaces.json")
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.get("/api/capabilities")
        assert response.status == 200
        payload = await response.json()
    assert payload["apiVersion"] == 1
    assert payload["basePath"] == ""
    assert payload["authentication"] == {"mode": "none"}
    assert payload["workspace"]["limits"]["tabsPerWorkspace"] == MAX_WORKSPACE_TABS
    assert "paneLayouts" in payload["resources"]["workspaces"]


@pytest.mark.asyncio
async def test_granular_workspace_session_api_is_ordered_and_idempotent(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        created = await client.post(
            "/api/workspaces",
            json={
                "name": "Automation",
                "tabs": ["a", "b"],
                "activeSession": "a",
            },
        )
        assert created.status == 201
        route = "/api/workspaces/workspace-id/sessions"

        response = await client.post(
            route,
            json={
                "sessions": ["c", "a"],
                "position": "before",
                "relativeTo": "b",
                "activeSession": "c",
                "sessionRevision": 0,
            },
        )
        assert response.status == 200
        added = await response.json()
        assert added["added"] == ["c"]
        assert added["workspace"]["tabs"] == ["a", "c", "b"]
        assert added["workspace"]["activeSession"] == "c"

        response = await client.post(
            route,
            json={"sessions": ["c"], "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["added"] == []

        response = await client.put(
            route,
            json={"sessions": ["c", "a"], "sessionRevision": 0},
        )
        assert response.status == 200
        replaced = (await response.json())["workspace"]
        assert replaced["tabs"] == ["c", "a"]
        assert replaced["activeSession"] == "c"

        response = await client.delete(
            route,
            json={"sessions": ["c", "missing"], "sessionRevision": 0},
        )
        assert response.status == 200
        removed = await response.json()
        assert removed["removed"] == ["c"]
        assert removed["workspace"]["tabs"] == ["a"]
        assert removed["workspace"]["activeSession"] == "a"

        response = await client.get(route)
        assert await response.json() == {
            "sessions": ["a"],
            "activeSession": "a",
            "sessionRevision": 0,
        }


@pytest.mark.asyncio
async def test_granular_workspace_sessions_enforce_revision_and_pins(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        await client.post(
            "/api/workspaces",
            json={"name": "Pinned", "tabs": ["a"], "activeSession": "a"},
        )
        assert store.set_session_workspace_pinned("pin", True)["sessionRevision"] == 1
        route = "/api/workspaces/workspace-id/sessions"

        stale = await client.post(
            route,
            json={"sessions": ["b"], "sessionRevision": 0},
        )
        assert stale.status == 409
        assert "reload the workspace" in (await stale.json())["error"]

        pinned = await client.delete(
            route,
            json={"sessions": ["pin"], "sessionRevision": 1},
        )
        assert pinned.status == 409
        assert "unpin it first" in (await pinned.json())["error"]


@pytest.mark.asyncio
async def test_granular_workspace_callback_group_and_separator_apis(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        await client.post(
            "/api/workspaces",
            json={
                "name": "Resources",
                "tabs": ["a", "b", "c"],
                "activeSession": "a",
            },
        )
        base = "/api/workspaces/workspace-id"

        response = await client.post(
            f"{base}/callback-sessions",
            json={"sessions": ["b", "ended"], "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["added"] == ["b", "ended"]
        response = await client.delete(
            f"{base}/callback-sessions",
            json={"sessions": ["b"], "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["removed"] == ["b"]
        response = await client.get(f"{base}/callback-sessions")
        assert (await response.json())["callbackSessions"] == ["ended"]

        group = workspace_group("middle", ["b", "c"])
        response = await client.post(
            f"{base}/groups",
            json={"group": group, "sessionRevision": 0},
        )
        assert response.status == 201
        assert (await response.json())["group"] == group
        response = await client.patch(
            f"{base}/groups/middle",
            json={"name": "Review", "collapsed": True, "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["group"]["name"] == "Review"
        response = await client.get(f"{base}/groups/middle")
        assert (await response.json())["group"]["collapsed"] is True

        response = await client.post(
            f"{base}/separators",
            json={"session": "b", "placement": "before", "sessionRevision": 0},
        )
        assert response.status == 200
        separators = (await response.json())["separators"]
        assert separators == {"before": ["b"], "after": []}
        response = await client.delete(
            f"{base}/separators",
            json={"session": "b", "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["separators"] == {
            "before": [],
            "after": [],
        }

        response = await client.delete(
            f"{base}/groups/middle",
            json={"sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["workspace"]["groups"] == []


@pytest.mark.asyncio
async def test_global_callback_api_includes_workspace_entries_and_deduplicates(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=iter(["one", "two"]).__next__,
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        first = await client.post(
            "/api/workspaces",
            json={
                "name": "One",
                "tabs": ["a"],
                "activeSession": "a",
                "callbackSessions": ["a"],
            },
        )
        assert first.status == 201
        second = await client.post(
            "/api/workspaces",
            json={
                "name": "Two",
                "tabs": ["b"],
                "activeSession": "b",
                "callbackSessions": ["a", "b"],
            },
        )
        assert second.status == 201

        response = await client.get("/api/callback-sessions")
        assert response.status == 200
        snapshot = await response.json()
        assert snapshot["callbackSessions"] == ["a", "b"]
        assert snapshot["globalCallbackSessions"] == []
        assert [source["workspaceName"] for source in snapshot["workspaceCallbacks"]] == [
            "One", "Two"
        ]

        response = await client.post(
            "/api/callback-sessions",
            json={"sessions": ["global", "a"], "sessionRevision": 0},
        )
        assert response.status == 200
        added = await response.json()
        assert added["added"] == ["global", "a"]
        assert added["callbackSessions"] == ["global", "a", "b"]

        response = await client.delete(
            "/api/callback-sessions",
            json={"sessions": ["a"], "sessionRevision": 0},
        )
        assert response.status == 200
        removed = await response.json()
        assert removed["removed"] == ["a"]
        assert removed["callbackSessions"] == ["global", "a", "b"]

        response = await client.put(
            "/api/callback-sessions",
            json={"sessions": ["global-two"], "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["globalCallbackSessions"] == ["global-two"]


@pytest.mark.asyncio
async def test_review_global_callback_session_removes_every_owned_marker(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=iter(["one", "two"]).__next__,
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        await client.post(
            "/api/workspaces",
            json={
                "name": "One",
                "tabs": ["shared"],
                "activeSession": "shared",
                "callbackSessions": ["shared"],
            },
        )
        await client.post(
            "/api/workspaces",
            json={
                "name": "Two",
                "tabs": ["shared", "other"],
                "activeSession": "shared",
                "callbackSessions": ["shared", "other"],
            },
        )
        response = await client.post(
            "/api/callback-sessions",
            json={"sessions": ["shared"], "sessionRevision": 0},
        )
        assert response.status == 200

        response = await client.post(
            "/api/callback-sessions/review",
            json={"session": "shared", "sessionRevision": 0},
        )
        assert response.status == 200
        reviewed = await response.json()
        assert reviewed["removed"] == ["shared"]
        assert reviewed["callbackSessions"] == ["other"]
        assert reviewed["globalCallbackSessions"] == []
        assert reviewed["workspaceCallbacks"] == [
            {"workspaceId": "two", "workspaceName": "Two", "sessions": ["other"]}
        ]

        assert store.get_workspace("one").get("callbackSessions", []) == []
        assert store.get_workspace("two")["callbackSessions"] == ["other"]


@pytest.mark.asyncio
async def test_granular_workspace_pane_layout_crud(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        await client.post(
            "/api/workspaces",
            json={
                "name": "Panes",
                "tabs": ["a", "b"],
                "activeSession": "a",
            },
        )
        base = "/api/workspaces/workspace-id/pane-layouts"
        layout = pane_layout()

        response = await client.post(
            base,
            json={"paneLayout": layout, "sessionRevision": 0},
        )
        assert response.status == 201
        assert (await response.json())["paneLayout"] == layout

        duplicate = await client.post(
            base,
            json={"paneLayout": layout, "sessionRevision": 0},
        )
        assert duplicate.status == 409

        response = await client.patch(
            f"{base}/pair-view",
            json={"name": "Three terminals later", "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["paneLayout"]["name"] == "Three terminals later"
        response = await client.get(f"{base}/pair-view")
        assert (await response.json())["paneLayout"]["name"] == "Three terminals later"

        response = await client.delete(
            f"{base}/pair-view",
            json={"sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["workspace"]["paneLayouts"] == []
        missing = await client.get(f"{base}/pair-view")
        assert missing.status == 404


@pytest.mark.asyncio
async def test_workspace_pane_layout_api_create_update_and_validation(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post(
            "/api/workspaces",
            json={
                "name": "Project",
                "tabs": ["a", "b"],
                "activeSession": "a",
                "paneLayouts": [pane_layout()],
            },
        )
        assert response.status == 201
        assert (await response.json())["workspace"]["paneLayouts"] == [pane_layout()]

        renamed_layout = pane_layout("Review wall")
        response = await client.patch(
            "/api/workspaces/workspace-id",
            json={"paneLayouts": [renamed_layout], "sessionRevision": 0},
        )
        assert response.status == 200
        assert (await response.json())["workspace"]["paneLayouts"] == [renamed_layout]

        response = await client.patch(
            "/api/workspaces/workspace-id",
            json={"paneLayouts": [pane_layout()]},
        )
        assert response.status == 400
        assert await response.json() == {"error": "sessionRevision is required"}

        invalid = pane_layout()
        invalid["root"]["second"]["session"] = "outside"
        response = await client.patch(
            "/api/workspaces/workspace-id",
            json={"paneLayouts": [invalid], "sessionRevision": 0},
        )
        assert response.status == 400
        assert "must be one of the workspace tabs" in (await response.json())["error"]


@pytest.mark.asyncio
async def test_workspace_callback_api_persists_and_requires_current_session_revision(
    tmp_path,
):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    async with TestClient(TestServer(create_app(workspaces=store, base_path=""))) as client:
        response = await client.post(
            "/api/workspaces",
            json={
                "name": "Follow ups",
                "tabs": ["agent"],
                "activeSession": "agent",
                "callbackSessions": ["agent", "ended-session"],
            },
        )
        assert response.status == 201
        created = (await response.json())["workspace"]
        assert created["callbackSessions"] == ["agent", "ended-session"]

        route = "/api/workspaces/workspace-id"
        response = await client.patch(route, json={"callbackSessions": ["agent"]})
        assert response.status == 400
        assert await response.json() == {"error": "sessionRevision is required"}

        assert store.rename_session("agent", "renamed-agent") == 1
        response = await client.patch(
            route,
            json={"callbackSessions": ["agent"], "sessionRevision": 0},
        )
        assert response.status == 409
        assert "reload the workspace" in (await response.json())["error"]

        response = await client.patch(
            route,
            json={
                "callbackSessions": ["renamed-agent"],
                "sessionRevision": 1,
            },
        )
        assert response.status == 200
        updated = (await response.json())["workspace"]
        assert updated["callbackSessions"] == ["renamed-agent"]
        assert updated["tabs"] == ["renamed-agent"]

        response = await client.patch(
            route,
            json={
                "callbackSessions": ["renamed-agent", "renamed-agent"],
                "sessionRevision": 1,
            },
        )
        assert response.status == 400
        assert "contains duplicate session" in (await response.json())["error"]


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
            "separators": [],
            "separatorsBefore": [],
            "paneLayouts": [],
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
        assert await (await client.get("/api/common-note")).json() == note_payload("")
        assert await (
            await client.get("/api/workspaces/workspace-id/note")
        ).json() == note_payload("")

        response = await client.put(
            "/api/common-note",
            json={"note": "Shared\r\nchecklist"},
        )
        assert response.status == 200
        assert await response.json() == note_payload("Shared\nchecklist")
        response = await client.put(
            "/api/workspaces/workspace-id/note",
            json={"note": "Workspace plan"},
        )
        assert response.status == 200
        assert await response.json() == note_payload("Workspace plan")
        assert await (await client.get("/api/common-note")).json() == {
            **note_payload("Shared\nchecklist")
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
            assert await missing_note.json() == {
                "error": "note or notebook is required"
            }
            unknown = await client.put(endpoint, json={"note": "", "extra": True})
            assert unknown.status == 400
            assert await unknown.json() == {"error": "unknown field: extra"}
            invalid = await client.put(endpoint, json={"note": 7})
            assert invalid.status == 400
            assert await invalid.json() == {"error": "note must be a string"}
            large_note = "large\n" * 3_000
            large = await client.put(
                endpoint,
                json={"note": large_note},
            )
            assert large.status == 200
            assert (await large.json())["note"] == large_note
        await client.put("/api/common-note", json={"note": "Shared\nchecklist"})
        await client.put(
            "/api/workspaces/workspace-id/note",
            json={"note": "Workspace plan"},
        )
    finally:
        await client.close()

    reloaded = WorkspaceStore(path)
    assert reloaded.get_common_note() == "Shared\nchecklist"
    assert reloaded.get_workspace_note("workspace-id") == "Workspace plan"


@pytest.mark.asyncio
async def test_workspace_note_api_saves_pages_and_legacy_writes_preserve_them(tmp_path):
    store = WorkspaceStore(
        tmp_path / "workspaces.json",
        id_factory=lambda: "workspace-id",
    )
    store.create_workspace(name="Project", tabs=["agent"], active_session="agent")
    client = TestClient(TestServer(create_app(workspaces=store, base_path="")))
    pages = [
        {"id": "main", "name": "Plan", "content": "First"},
        {"id": "runbook", "name": "Runbook", "content": "Second"},
    ]

    try:
        await client.start_server()
        endpoint = "/api/workspaces/workspace-id/note"
        response = await client.put(endpoint, json={"notebook": {"pages": pages}})
        assert response.status == 200
        assert await response.json() == note_payload("First", pages=pages)
        assert await (await client.get(endpoint)).json() == note_payload(
            "First",
            pages=pages,
        )

        response = await client.put(endpoint, json={"note": "Legacy update"})
        assert response.status == 200
        updated_pages = [{**pages[0], "content": "Legacy update"}, pages[1]]
        assert await response.json() == note_payload(
            "Legacy update",
            pages=updated_pages,
        )

        both = await client.put(
            endpoint,
            json={"note": "No", "notebook": {"pages": pages}},
        )
        assert both.status == 400
        assert await both.json() == {
            "error": "provide either note or notebook, not both"
        }
    finally:
        await client.close()


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
            ({}, "callbackSessions"),
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
            ({"callbackSessions": []}, "sessionRevision is required"),
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
