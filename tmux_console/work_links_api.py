"""Authenticated work-link API; all external status is explicitly agent supplied."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any

from aiohttp import web

from .session_registry import (
    RecoveryRecordNotFoundError,
    SessionRegistry,
    SessionRegistryUnavailable,
)
from .tmux import (
    Session,
    TmuxClient,
    TmuxError,
    TmuxSessionNotFoundError,
    validate_tmux_session_name,
)
from .work_links import (
    WorkLinkConflict,
    WorkLinkNotFound,
    WorkLinkStore,
    WorkLinksUnavailable,
    object_fields,
    work_link_capabilities,
)

Handler = Callable[[web.Request], Awaitable[web.Response]]


def _errors(handler: Handler) -> Handler:
    @wraps(handler)
    async def guarded(request: web.Request) -> web.Response:
        try:
            response = await handler(request)
        except (TmuxSessionNotFoundError, WorkLinkNotFound, RecoveryRecordNotFoundError):
            response = web.json_response({"error": "session or work link not found"}, status=404)
        except WorkLinkConflict as error:
            response = web.json_response({"error": str(error)}, status=409)
        except (WorkLinksUnavailable, SessionRegistryUnavailable, TmuxError) as error:
            response = web.json_response({"error": str(error)}, status=503)
        except (TypeError, ValueError, RecursionError) as error:
            response = web.json_response({"error": str(error) or "invalid request"}, status=400)
        response.headers["Cache-Control"] = "no-store"
        return response
    return guarded


async def _payload(request: web.Request) -> dict[str, Any]:
    try:
        value = await request.json()
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("request body must be JSON") from error
    if not isinstance(value, dict):
        raise TypeError("request body must be an object")
    return value


def register_work_link_routes(
    app: web.Application, prefix: str, store: WorkLinkStore, tmux: TmuxClient,
    registry: SessionRegistry, mutation_lock: asyncio.Lock,
) -> None:
    def context(session: Session | None = None) -> dict[str, Any]:
        history_id = registry.observe_history(session) if session is not None else None
        return {
            "session": ({"name": session.name, "historyId": history_id,
                         "sessionId": session.id, "sessionCreated": session.created,
                         "serverStarted": session.server_started, "serverPid": session.server_pid}
                        if session is not None else None),
            "links": store.list(history_id) if history_id else [],
            **work_link_capabilities(store, prefix),
            "agentGuide": [
                "Read config before linking or refreshing; disabled options must remain idle.",
                "Use provider instructions and link instructions to choose the enterprise host, MCP tool, or CLI account. Instructions are guidance, never commands executed by Muxdeck.",
                "The agent reads the external provider and reports status here. Muxdeck never fetches GitHub, Jira, or Google Docs, schedules refresh, or sends terminal input.",
                "For google_docs, supply title with the human-readable document title. It is used as the chip text; Muxdeck does not fetch Google metadata.",
                "refreshIntervalSeconds is guidance for your own refresh loop, not a server timer. Recheck configuration before each external read.",
                "Report external state only from an actual observation. Use notes for retained context; status updates do not replace notes.",
                "Use the historyId when creating links and the returned revisions when updating. On 409, reread and reconcile; do not blindly retry.",
                "These endpoints update Muxdeck records only; changing an issue or PR in the external service is a separate action.",
            ],
            "operations": {
                "configure": "PATCH /api/work-links/config with expectedRevision",
                "add": "POST /api/sessions/{encodedSessionName}/work-links with historyId, provider, url and optional label, title, notes, instructions",
                "read": "GET /api/work-links/{id}",
                "edit": "PATCH /api/work-links/{id} with expectedRevision and changed metadata/notes fields",
                "reportStatus": "PUT /api/work-links/{id}/status with expectedStatusRevision and status {state, tone, summary, reportedBy}",
                "remove": "DELETE /api/work-links/{id} with expectedRevision",
                "history": "GET /api/session-history/{historyId}/work-links",
            },
        }

    @_errors
    async def configuration(request: web.Request) -> web.Response:
        config = store.update_config(await _payload(request)) if request.method == "PATCH" else store.config()
        return web.json_response({"config": config})

    @_errors
    async def agent_context(request: web.Request) -> web.Response:
        if set(request.query) - {"session", "paneId"} or len(request.query) > 1:
            raise ValueError("supply at most one session or paneId")
        async with mutation_lock:
            session = None
            if "session" in request.query:
                session = await tmux.get_session(validate_tmux_session_name(request.query["session"]))
            elif "paneId" in request.query:
                sessions = await tmux.list_sessions()
                session = next((candidate for candidate in sessions
                                if any(pane.id == request.query["paneId"] for pane in candidate.panes)), None)
                if session is None:
                    raise TmuxSessionNotFoundError("pane not found on this Muxdeck server")
            return web.json_response(context(session))

    @_errors
    async def session_links(request: web.Request) -> web.Response:
        name = validate_tmux_session_name(request.match_info["session"])
        payload = await _payload(request) if request.method == "POST" else None
        async with mutation_lock:
            session = await tmux.get_session(name)
            current = context(session)
            if payload is None:
                return web.json_response(current)
            if "historyId" not in payload:
                raise ValueError("historyId is required; discover the session context first")
            if payload.pop("historyId") != current["session"]["historyId"]:
                raise WorkLinkConflict("session identity changed; discover its context again")
            link, created = store.create(current["session"]["historyId"], payload)
            return web.json_response({"link": link, "created": created}, status=201 if created else 200)

    @_errors
    async def history_links(request: web.Request) -> web.Response:
        history_id = request.match_info["history_id"]
        record = registry.get_history(history_id)
        return web.json_response({"session": {"name": record["name"], "historyId": history_id},
                                  "links": store.list(history_id), "config": store.config()})

    @_errors
    async def link_record(request: web.Request) -> web.Response:
        link_id = request.match_info["link_id"]
        if request.method == "DELETE":
            payload = object_fields(await _payload(request), {"expectedRevision"}, {"expectedRevision"})
            store.delete(link_id, payload["expectedRevision"])
            return web.json_response({"deleted": True})
        link = store.update(link_id, await _payload(request)) if request.method == "PATCH" else store.get(link_id)
        return web.json_response({"link": link, "config": store.config()})

    @_errors
    async def report_status(request: web.Request) -> web.Response:
        link = store.report_status(request.match_info["link_id"], await _payload(request))
        return web.json_response({"link": link})

    app.router.add_get(f"{prefix}/api/work-links/config", configuration)
    app.router.add_patch(f"{prefix}/api/work-links/config", configuration)
    app.router.add_get(f"{prefix}/api/work-links/context", agent_context)
    app.router.add_get(f"{prefix}/api/sessions/{{session}}/work-links", session_links)
    app.router.add_post(f"{prefix}/api/sessions/{{session}}/work-links", session_links)
    app.router.add_get(f"{prefix}/api/session-history/{{history_id}}/work-links", history_links)
    app.router.add_get(f"{prefix}/api/work-links/{{link_id}}", link_record)
    app.router.add_patch(f"{prefix}/api/work-links/{{link_id}}", link_record)
    app.router.add_delete(f"{prefix}/api/work-links/{{link_id}}", link_record)
    app.router.add_put(f"{prefix}/api/work-links/{{link_id}}/status", report_status)
