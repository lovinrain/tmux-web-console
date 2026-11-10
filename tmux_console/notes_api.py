"""Scoped notebooks: versioned page management and compatible append/read routes."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import Callable
from typing import Any

from aiohttp import web

from .messages import validate_session_name
from .tmux import TmuxClient, TmuxError, TmuxSessionNotFoundError
from .workspaces import (
    MAX_SCOPED_NOTE_PAGES,
    WorkspaceNotFoundError,
    WorkspaceResourceConflictError,
    WorkspaceResourceNotFoundError,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    normalize_scoped_note,
    validate_scoped_note_notebook,
)

LOGGER = logging.getLogger("muxdeck.notes")


def note_api_capabilities() -> dict[str, Any]:
    return {
        "scopes": ["global", "workspace", "session"],
        "agentMethods": ["GET", "POST", "PUT", "PATCH", "DELETE"],
        "operations": [
            "read",
            "listPages",
            "readPage",
            "append",
            "replace",
            "clear",
            "createPage",
            "updatePage",
            "deletePage",
            "reorderPages",
        ],
        "postOperation": "append",
        "defaultPage": "first",
        "pageIdSupported": True,
        "revisionField": "revision",
        "writePrecondition": "expectedRevision or If-Match",
        "agentRevisionRequiredExceptAppend": True,
        "pageListing": {"defaultLimit": 50, "maximumLimit": MAX_SCOPED_NOTE_PAGES},
        "automaticRetry": False,
    }


def register_note_routes(
    app: web.Application,
    prefix: str,
    *,
    store: WorkspaceStore,
    tmux: TmuxClient,
    rename_lock: asyncio.Lock,
    is_control: Callable[[web.Request], bool],
) -> None:
    async def handle(request: web.Request) -> web.Response:
        scope = (
            "workspace"
            if "workspace_id" in request.match_info
            else ("session" if "session" in request.match_info else "common")
        )
        identity = request.match_info.get("workspace_id") or request.match_info.get(
            "session"
        )
        page_id = request.match_info.get("page_id")
        collection = page_id is None and request.path.endswith("/pages")
        operation = "read"
        try:
            payload: dict[str, Any] = {}
            if request.method not in {"GET", "HEAD"}:
                try:
                    raw = await request.json()
                except (ValueError, TypeError, RecursionError):
                    return web.json_response(
                        {"error": "request body must be JSON"}, status=400
                    )
                if not isinstance(raw, dict):
                    return web.json_response(
                        {"error": "request body must be an object"}, status=400
                    )
                payload = raw
                if page_id is not None:
                    operation = (
                        "update-page" if request.method == "PATCH" else "delete-page"
                    )
                    allowed = (
                        {"name", "content"} if operation == "update-page" else set()
                    )
                    required: set[str] = set()
                elif collection:
                    operation, allowed, required = (
                        "create-page",
                        {"id", "name", "content", "afterPageId"},
                        {"name"},
                    )
                else:
                    operation = {
                        "POST": "append",
                        "PUT": "replace",
                        "PATCH": "reorder",
                        "DELETE": "clear",
                    }[request.method]
                    allowed, required = {
                        "append": ({"text", "pageId"}, {"text"}),
                        "replace": ({"note", "notebook"}, set()),
                        "reorder": ({"pageIds"}, {"pageIds"}),
                        "clear": (set(), set()),
                    }[operation]
                unknown = sorted(set(payload) - allowed - {"expectedRevision"})
                if unknown:
                    raise ValueError(f"unknown field: {unknown[0]}")
                missing = sorted(required - set(payload))
                if missing:
                    raise ValueError(f"{missing[0]} is required")
                if operation == "replace":
                    if "note" not in payload and "notebook" not in payload:
                        raise ValueError("note or notebook is required")
                    if "note" in payload and "notebook" in payload:
                        raise ValueError("provide either note or notebook, not both")
                    # Preserve the legacy contract: malformed replacement data
                    # is rejected even when tmux is temporarily unavailable.
                    if "notebook" in payload:
                        validate_scoped_note_notebook(payload["notebook"])
                    else:
                        normalize_scoped_note(payload["note"])
                if operation == "update-page" and not (
                    {"name", "content"} & set(payload)
                ):
                    raise ValueError("name or content is required")
                if "If-Match" in request.headers:
                    if len(request.headers.getall("If-Match")) != 1:
                        raise ValueError(
                            "If-Match must contain one quoted notebook revision"
                        )
                    match = re.fullmatch(
                        r'"([0-9a-f]{64})"', request.headers["If-Match"]
                    )
                    if match is None:
                        raise ValueError(
                            "If-Match must contain one quoted notebook revision"
                        )
                    if (
                        "expectedRevision" in payload
                        and payload["expectedRevision"] != match[1]
                    ):
                        raise ValueError("If-Match and expectedRevision disagree")
                    payload["expectedRevision"] = match[1]
                # Legacy browser PUTs remain compatible. The current editor always
                # sends its snapshot revision; every agent replacement is fenced.
                required_revision = operation != "append" and (
                    operation != "replace" or is_control(request)
                )
                if required_revision and "expectedRevision" not in payload:
                    return web.json_response(
                        {
                            "error": "expectedRevision is required; read the notebook first"
                        },
                        status=428,
                    )

            async with rename_lock if scope == "session" else contextlib.nullcontext():
                if scope == "session":
                    assert identity is not None
                    identity = validate_session_name(identity)
                    await tmux.get_session(identity)
                if request.method in {"GET", "HEAD"}:
                    result = store.read_notebook(scope, identity=identity)
                    if (
                        "revision" in request.query
                        and request.query["revision"] != result["revision"]
                    ):
                        raise WorkspaceResourceConflictError(
                            "These notes changed elsewhere. Read the latest notebook before continuing."
                        )
                    if page_id is not None:
                        page = next(
                            (
                                item
                                for item in result["notebook"]["pages"]
                                if item["id"] == page_id
                            ),
                            None,
                        )
                        if page is None:
                            raise WorkspaceResourceNotFoundError(
                                "pageId does not name a notebook page"
                            )
                        result = {"page": page, "revision": result["revision"]}
                    elif collection:
                        unknown_query = set(request.query) - {
                            "offset",
                            "limit",
                            "revision",
                        }
                        if unknown_query:
                            raise ValueError(
                                f"unknown query parameter: {min(unknown_query)}"
                            )
                        offset, limit = (
                            int(request.query.get("offset", "0")),
                            int(request.query.get("limit", "50")),
                        )
                        if offset < 0 or not 1 <= limit <= MAX_SCOPED_NOTE_PAGES:
                            raise ValueError(
                                f"offset must be nonnegative and limit must be 1..{MAX_SCOPED_NOTE_PAGES}"
                            )
                        pages = result["notebook"]["pages"]
                        subset = pages[offset : offset + limit]
                        result = {
                            "pages": [
                                {
                                    "id": item["id"],
                                    "name": item["name"],
                                    "characters": len(item["content"]),
                                }
                                for item in subset
                            ],
                            "revision": result["revision"],
                            "offset": offset,
                            "limit": limit,
                            "total": len(pages),
                            "nextOffset": offset + len(subset)
                            if offset + len(subset) < len(pages)
                            else None,
                        }
                else:
                    options = (
                        {"expected_revision": payload["expectedRevision"]}
                        if "expectedRevision" in payload
                        else {}
                    )
                    changes = {
                        key: value
                        for key, value in payload.items()
                        if key != "expectedRevision"
                    }
                    if page_id is not None:
                        changes["pageId"] = page_id
                    result = store.edit_notebook(
                        scope, operation, changes, identity=identity, **options
                    )
                    if operation != "replace":
                        result["scope"] = "global" if scope == "common" else scope
            return web.json_response(
                result,
                status=201 if operation == "create-page" else 200,
                headers={"ETag": '"' + result["revision"] + '"'},
            )
        except (TmuxSessionNotFoundError, WorkspaceNotFoundError) as error:
            return web.json_response({"error": str(error)}, status=404)
        except WorkspaceResourceNotFoundError as error:
            return web.json_response(
                {"error": str(error)}, status=400 if operation == "append" else 404
            )
        except (TmuxError, WorkspaceStoreUnavailable) as error:
            return web.json_response({"error": str(error)}, status=503)
        except WorkspaceResourceConflictError as error:
            return web.json_response({"error": str(error)}, status=409)
        except (TypeError, ValueError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except OSError:
            LOGGER.exception("Unable to save scoped notebook")
            message = (
                f"unable to save {scope} note"
                if operation == "replace"
                else "unable to save notebook"
            )
            return web.json_response({"error": message}, status=500)

    for path in (
        f"{prefix}/api/common-note",
        f"{prefix}/api/workspaces/{{workspace_id}}/note",
        f"{prefix}/api/sessions/{{session:[^/]+}}/note",
    ):
        app.router.add_get(path, handle)
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            app.router.add_route(method, path, handle)
        app.router.add_get(path + "/pages", handle)
        app.router.add_post(path + "/pages", handle)
        page_path = path + "/pages/{page_id:[A-Za-z0-9_-]{1,64}}"
        app.router.add_get(page_path, handle)
        app.router.add_patch(page_path, handle)
        app.router.add_delete(page_path, handle)
