"""Explicit, durable fold-and-close and recovery operations.

The workspace snapshot is committed before tmux is touched. Recovery launches
only the exact recorded conversation; it never types into an existing pane.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
from collections.abc import Callable
from typing import Any

from aiohttp import web

from .agent_reference import UUID_PATTERN, AgentReferenceDetector
from .agent_reference_recovery import AgentReferenceRecovery
from .agent_transcripts import AgentTranscriptReader
from .metadata import SessionTitleStore
from .scrollback import ScrollbackRecorder, ScrollbackStoreUnavailable
from .session_registry import (
    RecoveryRecordNotFoundError,
    SessionRegistry,
    SessionRegistryUnavailable,
)
from .tmux import (
    Session,
    TmuxClient,
    TmuxError,
    TmuxSessionIdentityChangedError,
    validate_tmux_start_directory,
)
from .workspace_folds import FoldSessionSnapshot, _members, validate_workspace_folds
from .workspaces import (
    WorkspaceNotFoundError,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    WorkspaceUpdateConflict,
)

LOGGER = logging.getLogger("muxdeck.folds")
IDENTITY_FIELDS = ("sessionId", "sessionCreated", "serverStarted", "serverPid")


def session_fence(session: Session) -> dict[str, Any]:
    return {"name": session.name, "sessionId": session.id, "sessionCreated": session.created,
            "serverStarted": session.server_started, "serverPid": session.server_pid}


def agent_resume_argv(agent: str | None, identifier: str | None) -> list[str] | None:
    if not identifier or not UUID_PATTERN.fullmatch(identifier):
        return None
    commands = {"claude": ["claude", "-r"], "codex": ["codex", "resume"],
                "cursor": ["cursor-agent", "--resume"], "grok": ["grok", "-r"]}
    return [*commands[agent], identifier] if agent in commands else None


def register_fold_recovery_routes(
    app: web.Application, prefix: str, *, tmux: TmuxClient, registry: SessionRegistry,
    workspaces: WorkspaceStore, references: AgentReferenceDetector,
    reference_recovery: AgentReferenceRecovery, transcripts: AgentTranscriptReader,
    titles: SessionTitleStore, scrollback: ScrollbackRecorder, session_lock: asyncio.Lock,
    record_created: Callable[..., list[str]], notify_sessions: Callable[[], None],
) -> None:
    def error_response(error: Exception) -> web.Response:
        if isinstance(error, (WorkspaceNotFoundError, RecoveryRecordNotFoundError)):
            status = 404
        elif isinstance(error, (WorkspaceUpdateConflict, WorkspaceSessionRevisionConflict, TmuxSessionIdentityChangedError)):
            status = 409
        elif isinstance(error, (WorkspaceStoreUnavailable, SessionRegistryUnavailable, TmuxError)):
            status = 503
        else:
            status = 400
        return web.json_response({"error": str(error)}, status=status)

    async def close_fold(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
            required = {"tabs", "sessions", "sessionRevision", "expectedUpdatedAt"}
            if not isinstance(payload, dict) or set(payload) != required:
                raise ValueError("tabs, sessions, sessionRevision and expectedUpdatedAt are required")
            if not isinstance(payload["sessions"], list) or not payload["sessions"]:
                raise ValueError("sessions must contain the confirmed native identities")
            confirmed: dict[str, dict[str, Any]] = {}
            for item in payload["sessions"]:
                if not isinstance(item, dict) or set(item) != {"name", *IDENTITY_FIELDS} or not isinstance(item["name"], str):
                    raise ValueError("sessions must contain complete native identities")
                if item["name"] in confirmed:
                    raise ValueError("sessions contains duplicate names")
                if not isinstance(item["sessionId"], str) or not item["sessionId"].startswith("$") or not item["sessionId"][1:].isdigit():
                    raise ValueError("invalid native session ID")
                if any(type(item[field]) is not int or item[field] <= 0 for field in IDENTITY_FIELDS[1:]):
                    raise ValueError("invalid native session identity")
                confirmed[item["name"]] = item
            async with session_lock:
                workspace = workspaces.get_workspace(request.match_info["workspace_id"])
                if payload["expectedUpdatedAt"] != workspace["updatedAt"]:
                    raise WorkspaceUpdateConflict(workspace["updatedAt"], payload["expectedUpdatedAt"])
                if payload["sessionRevision"] != workspace["sessionRevision"]:
                    raise WorkspaceSessionRevisionConflict(workspace["sessionRevision"], payload["sessionRevision"])
                fold_id = request.match_info["fold_id"]
                old = next((fold for fold in workspace.get("folds", []) if fold["id"] == fold_id), None)
                candidate = {"id": fold_id, "tabs": payload["tabs"]}
                if old and old.get("closedSessions"):
                    candidate["closedSessions"] = old["closedSessions"]
                all_folds = [fold for fold in workspace.get("folds", []) if fold["id"] != fold_id] + [candidate]
                all_folds.sort(key=lambda fold: workspace["tabs"].index(fold["tabs"][0]) if isinstance(fold.get("tabs"), list)
                               and fold["tabs"] and fold["tabs"][0] in workspace["tabs"] else -1)
                validate_workspace_folds(all_folds, tuple(workspace["tabs"]), tuple(workspace.get("parents", {}).items()),
                                         {tab: group["id"] for group in workspace.get("groups", []) for tab in group["tabs"]})
                members = [name for name in workspace["tabs"] if name in _members(
                    tuple(candidate["tabs"]), tuple(workspace["tabs"]), workspace.get("parents", {}),
                )]
                if set(confirmed) != set(members):
                    raise ValueError("confirmed sessions must include every folded branch and descendant")
                live = await tmux.list_sessions()
                by_name = {session.name: session for session in live}
                previous = {item["name"]: item for item in candidate.get("closedSessions", [])}
                # Validate every member before doing any storage or destructive work.
                for name in members:
                    current = by_name.get(name)
                    if current and session_fence(current) != confirmed[name]:
                        raise TmuxSessionIdentityChangedError(f"Session {name} changed; refresh before closing it")
                    if not current and (name not in previous or any(previous[name][field] != confirmed[name][field] for field in IDENTITY_FIELDS)):
                        raise TmuxSessionIdentityChangedError(f"Session {name} is no longer live; no sessions were closed")
                targets = [by_name[name] for name in members if name in by_name]
                detected = await references.detect_sessions(targets)
                recovered = await reference_recovery.recover_sessions(targets, prune_cache=False)
                registry.reconcile(live, detected, recovered_references=recovered)
                snapshots: list[dict[str, Any]] = []
                for name in members:
                    target = by_name.get(name)
                    if target is None:
                        snapshots.append(previous[name])
                        continue
                    history_id = registry.observe_history(target, detected.get(name), recovered_references=recovered)
                    history = registry.get_history(history_id)
                    agent = registry.latest_recorded_agent(history_id)
                    snapshots.append(FoldSessionSnapshot(
                        name=name, historyId=history_id, directory=history["directory"], title=titles.get_title(name),
                        agentType=agent["agentType"] if agent else history["agent_type"],
                        agentSessionId=agent["agentSessionId"] if agent else None,
                        sessionId=target.id, sessionCreated=target.created, serverStarted=target.server_started,
                        serverPid=target.server_pid, savedAt=int(time.time()),
                    ).to_dict())
                candidate["closedSessions"] = snapshots
                # A failed atomic write ends here, with every tmux session untouched.
                saved = workspaces.update_workspace(workspace["id"], folds=all_folds, update_folds=True,
                                                     session_revision=payload["sessionRevision"],
                                                     expected_updated_at=payload["expectedUpdatedAt"])
                registry.record_history_titles({name: titles.get_title(name) for name in members})
                registry.sync_history_workspaces(workspaces.list_workspaces())
                closed: list[str] = [name for name in members if name not in by_name]
                failures: dict[str, str] = {}
                for target in targets:
                    try:
                        try:
                            await asyncio.wait_for(scrollback.sample([target], force=True), 3)
                        except (TimeoutError, TmuxError, SessionRegistryUnavailable, ScrollbackStoreUnavailable):
                            LOGGER.warning("Unable to save final pane output before fold-and-close")
                        await tmux.terminate_session(target.id, target.created, target.server_started, target.server_pid)
                        snapshot = next(item for item in snapshots if item["name"] == target.name)
                        registry.mark_history(snapshot["historyId"], ended=True)
                        # Recovery remains enabled, including after an explicit unfold.
                        closed.append(target.name)
                    except (TmuxError, ValueError, SessionRegistryUnavailable) as error:
                        failures[target.name] = str(error)
                notify_sessions()
                return web.json_response({"workspace": saved, "closed": closed, "failures": failures})
        except (ValueError, TypeError, RecursionError, WorkspaceNotFoundError, WorkspaceStoreUnavailable,
                WorkspaceUpdateConflict, WorkspaceSessionRevisionConflict, SessionRegistryUnavailable,
                RecoveryRecordNotFoundError, TmuxError) as error:
            return error_response(error)

    async def recover_fold_session(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
            if not isinstance(payload, dict) or set(payload) != {"session", "mode"} or payload["mode"] not in {"shell", "agent"}:
                raise ValueError("session and an explicit shell or agent recovery mode are required")
            async with session_lock:
                workspace = workspaces.get_workspace(request.match_info["workspace_id"])
                fold = next((item for item in workspace.get("folds", []) if item["id"] == request.match_info["fold_id"]), None)
                snapshot = next((item for item in (fold or {}).get("closedSessions", []) if item["name"] == payload["session"]), None)
                if snapshot is None:
                    raise RecoveryRecordNotFoundError("saved fold session not found")
                history = registry.get_history(snapshot["historyId"])
                if (history["tmux_id"], history["created"], history["server_started"], history["server_pid"]) != tuple(snapshot[field] for field in IDENTITY_FIELDS):
                    raise ValueError("saved fold does not match its recorded session history")
                live = await tmux.list_sessions()
                current = next((session for session in live if session.name == snapshot["name"]), None)
                if current:
                    if registry.is_history_recovery(current, snapshot["historyId"]):
                        return web.json_response({"session": current.name, "sessionId": current.id, "created": False})
                    raise TmuxSessionIdentityChangedError("A live session already uses this name; it will not be replaced")
                directory = validate_tmux_start_directory(snapshot["directory"])
                command = None
                if payload["mode"] == "agent":
                    command = agent_resume_argv(snapshot["agentType"], snapshot["agentSessionId"])
                    if command is None:
                        raise TmuxSessionIdentityChangedError("No supported coding conversation was recorded; recover the shell only")
                    if not any((agent["agentType"], agent["agentSessionId"]) == (snapshot["agentType"], snapshot["agentSessionId"])
                               for agent in registry.list_session_agents(snapshot["historyId"])):
                        raise ValueError("coding conversation does not belong to the recorded session")
                    executable = shutil.which(command[0])
                    if executable is None:
                        raise TmuxSessionIdentityChangedError(f"{command[0]} is unavailable on this host; recover the shell only")
                    command[0] = executable
                    source = await asyncio.to_thread(transcripts.read, [snapshot], limit=1, view="conversation")
                    if source["status"] != "available":
                        raise TmuxSessionIdentityChangedError(source.get("notice") or "The saved coding conversation is unavailable; recover the shell only")
                # A workspace can change while the transcript is being checked.
                latest = workspaces.get_workspace(workspace["id"])
                latest_fold = next((item for item in latest.get("folds", [])
                                    if item["id"] == request.match_info["fold_id"]), None)
                if latest_fold is None or snapshot not in latest_fold.get("closedSessions", []):
                    raise TmuxSessionIdentityChangedError("The saved fold changed; refresh before recovering")
                created = await tmux.create_session(snapshot["name"], start_directory=directory,
                                                    launch_mode="command" if command else "shell", command=command,
                                                    remain_on_exit=True if command else None)
                warnings = record_created(created, directory, origin="recreate", source_history_id=snapshot["historyId"], source_name=snapshot["name"])
                # Complete the creation's initially partial history identity now,
                # so a lost HTTP response can be retried before the next sampler.
                try:
                    registry.observe_history(Session(
                        name=created.name, id=created.id, windows=1, attached=0,
                        created=created.session_created, server_started=created.server_started,
                        server_pid=created.server_pid,
                    ))
                except SessionRegistryUnavailable:
                    warnings.append("session was recovered but its complete history identity could not be saved")
                return web.json_response({"session": created.name, "sessionId": created.id, "created": True,
                                          "warnings": warnings}, status=201)
        except (ValueError, TypeError, RecursionError, WorkspaceNotFoundError, WorkspaceStoreUnavailable,
                SessionRegistryUnavailable, RecoveryRecordNotFoundError, TmuxError) as error:
            return error_response(error)

    route = f"{prefix}/api/workspaces/{{workspace_id}}/folds/{{fold_id}}"
    app.router.add_post(f"{route}/close", close_fold)
    app.router.add_post(f"{route}/recover", recover_fold_session)
