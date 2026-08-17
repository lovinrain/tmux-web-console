from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from aiohttp import WSMsgType, web

from .history import SnapshotStore
from .messages import (
    MessageNotFoundError,
    SessionMessageStore,
    validate_message_state,
    validate_message_text,
    validate_session_name,
)
from .metadata import SessionTitleStore, normalize_title
from .pty_bridge import PtyBridge, clamp_size
from .snippets import (
    SnippetRevisionConflict,
    SnippetStore,
    SnippetStoreUnavailable,
)
from .status import AgentStateDetector
from .tmux import (
    TERMINAL_HISTORY_ACTIONS,
    TmuxClient,
    TmuxError,
    TmuxRenameUnverifiedError,
    validate_tmux_new_session_name,
    validate_tmux_session_name,
)
from .workspaces import (
    WorkspaceNotFoundError,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
)

LOGGER = logging.getLogger("muxdeck")
ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
MAX_INPUT_BYTES = 1024 * 1024
TMUX_KEY = web.AppKey("tmux", TmuxClient)
SNAPSHOTS_KEY = web.AppKey("snapshots", SnapshotStore)
TITLES_KEY = web.AppKey("titles", SessionTitleStore)
MESSAGES_KEY = web.AppKey("messages", SessionMessageStore)
SNIPPETS_KEY = web.AppKey("snippets", SnippetStore)
WORKSPACES_KEY = web.AppKey("workspaces", WorkspaceStore)
AGENT_STATES_KEY = web.AppKey("agent_states", AgentStateDetector)
BASE_PATH_KEY = web.AppKey("base_path", str)
SESSION_RENAME_LOCK_KEY = web.AppKey("session_rename_lock", asyncio.Lock)
SESSION_STREAM_SAMPLE_SECONDS = 1.0
SESSION_STREAM_HEARTBEAT_SECONDS = 15.0


class SessionSnapshotBuilder:
    def __init__(
        self,
        tmux: TmuxClient,
        titles: SessionTitleStore,
        agent_states: AgentStateDetector,
        clock: Callable[[], float] = time.time,
        messages: SessionMessageStore | None = None,
    ) -> None:
        self._tmux = tmux
        self._titles = titles
        self._agent_states = agent_states
        self._messages = messages
        self._clock = clock
        self._lock = asyncio.Lock()
        self._state_history: dict[str, tuple[str, str, int]] = {}

    async def build(self) -> dict[str, list[dict[str, Any]]]:
        async with self._lock:
            items = await self._tmux.list_sessions()
            states = await self._agent_states.detect_sessions(self._tmux, items)
            observed_at = int(self._clock())
            next_state_history: dict[str, tuple[str, str, int]] = {}
            payload: list[dict[str, Any]] = []

            for item in items:
                state = states[item.name]
                previous = self._state_history.get(item.name)
                changed_at = (
                    previous[2]
                    if previous is not None
                    and previous[0] == item.id
                    and previous[1] == state.name
                    else observed_at
                )
                next_state_history[item.name] = (item.id, state.name, changed_at)

                record = item.to_dict()
                record.update(
                    {
                        "agentState": state.name,
                        "agentStateReason": state.reason,
                        "agentStateChangedAt": changed_at,
                        "customTitle": self._titles.get_title(item.name),
                        "starred": self._titles.is_starred(item.name),
                        "ignored": self._titles.is_ignored(item.name),
                        "memorandumCount": (
                            self._messages.count_messages(item.name)
                            if self._messages is not None
                            else 0
                        ),
                        "queuedMessageCount": (
                            self._messages.count_queued_messages(item.name)
                            if self._messages is not None
                            else 0
                        ),
                    }
                )
                payload.append(record)

            # Dropping absent names makes a later reappearance a fresh observation.
            self._state_history = next_state_history
            return {"sessions": payload}


SESSION_SNAPSHOTS_KEY = web.AppKey("session_snapshots", SessionSnapshotBuilder)
SessionStreamQueue = asyncio.Queue[str | None]


class SessionStreamBroker:
    def __init__(
        self,
        snapshots: SessionSnapshotBuilder,
        sample_seconds: float = SESSION_STREAM_SAMPLE_SECONDS,
    ) -> None:
        self._snapshots = snapshots
        self._sample_seconds = sample_seconds
        self._subscribers: set[SessionStreamQueue] = set()
        self._latest: str | None = None
        self._sampler: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def sampler_task(self) -> asyncio.Task[None] | None:
        return self._sampler

    @property
    def closed(self) -> bool:
        return self._closed

    async def subscribe(self) -> SessionStreamQueue:
        queue: SessionStreamQueue = asyncio.Queue(maxsize=1)
        async with self._lock:
            if self._closed:
                raise RuntimeError("session stream broker is closed")
            self._subscribers.add(queue)
            if self._latest is not None:
                queue.put_nowait(self._latest)
            if self._sampler is None:
                self._sampler = asyncio.create_task(
                    self._sample_loop(), name="muxdeck-session-sampler"
                )
        return queue

    async def unsubscribe(self, queue: SessionStreamQueue) -> None:
        sampler: asyncio.Task[None] | None = None
        async with self._lock:
            self._subscribers.discard(queue)
            if not self._subscribers and self._sampler is not None:
                sampler = self._sampler
                self._sampler = None
                self._latest = None
        if sampler is not None:
            sampler.cancel()
            await asyncio.gather(sampler, return_exceptions=True)

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()
            sampler = self._sampler
            self._sampler = None
            self._latest = None
            for queue in subscribers:
                self._offer_latest(queue, None)
        if sampler is not None:
            sampler.cancel()
            await asyncio.gather(sampler, return_exceptions=True)

    async def _sample_loop(self) -> None:
        current_task = asyncio.current_task()
        while True:
            try:
                payload = await self._snapshots.build()
            except TmuxError as error:
                LOGGER.debug("Unable to refresh session stream: %s", error)
            except Exception:
                LOGGER.exception("Unexpected session stream sampling failure")
            else:
                serialized = json.dumps(
                    payload, ensure_ascii=False, separators=(",", ":")
                )
                async with self._lock:
                    if self._sampler is not current_task or self._closed:
                        return
                    if serialized != self._latest:
                        self._latest = serialized
                        for queue in self._subscribers:
                            self._offer_latest(queue, serialized)
            await asyncio.sleep(self._sample_seconds)

    @staticmethod
    def _offer_latest(queue: SessionStreamQueue, snapshot: str | None) -> None:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(snapshot)


SESSION_STREAM_BROKER_KEY = web.AppKey("session_stream_broker", SessionStreamBroker)


def normalize_base_path(value: str) -> str:
    value = "/" + value.strip("/")
    return "" if value == "/" else value


def json_error(message: str, status: int) -> web.Response:
    return web.json_response({"error": message}, status=status)


def parse_int(value: str | None, default: int) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


async def _close_terminal_bridge(sender: asyncio.Task[None], bridge: PtyBridge) -> None:
    sender.cancel()
    try:
        (outcome,) = await asyncio.gather(sender, return_exceptions=True)
        if isinstance(outcome, ConnectionError):
            LOGGER.debug("Terminal output connection closed", exc_info=outcome)
        elif isinstance(outcome, BaseException) and not isinstance(
            outcome, asyncio.CancelledError
        ):
            raise outcome
    finally:
        await bridge.close()


def create_app(
    tmux: TmuxClient | None = None,
    snapshots: SnapshotStore | None = None,
    titles: SessionTitleStore | None = None,
    agent_states: AgentStateDetector | None = None,
    base_path: str | None = None,
    messages: SessionMessageStore | None = None,
    snippets: SnippetStore | None = None,
    workspaces: WorkspaceStore | None = None,
) -> web.Application:
    app = web.Application(client_max_size=MAX_INPUT_BYTES)
    app[TMUX_KEY] = tmux or TmuxClient()
    app[SNAPSHOTS_KEY] = snapshots or SnapshotStore()
    app[TITLES_KEY] = titles or SessionTitleStore()
    app[MESSAGES_KEY] = messages or SessionMessageStore()
    app[SNIPPETS_KEY] = snippets or SnippetStore()
    app[WORKSPACES_KEY] = workspaces or WorkspaceStore()
    app[AGENT_STATES_KEY] = agent_states or AgentStateDetector()
    app[SESSION_RENAME_LOCK_KEY] = asyncio.Lock()
    app[SESSION_SNAPSHOTS_KEY] = SessionSnapshotBuilder(
        app[TMUX_KEY],
        app[TITLES_KEY],
        app[AGENT_STATES_KEY],
        messages=app[MESSAGES_KEY],
    )
    app[SESSION_STREAM_BROKER_KEY] = SessionStreamBroker(
        app[SESSION_SNAPSHOTS_KEY],
        sample_seconds=SESSION_STREAM_SAMPLE_SECONDS,
    )
    app[BASE_PATH_KEY] = normalize_base_path(
        base_path
        if base_path is not None
        else os.environ.get("MUXDECK_BASE_PATH", "/mux")
    )
    prefix = app[BASE_PATH_KEY]

    async def close_session_stream_broker(application: web.Application) -> None:
        await application[SESSION_STREAM_BROKER_KEY].close()

    app.on_cleanup.append(close_session_stream_broker)

    async def health(_: web.Request) -> web.Response:
        try:
            sessions = await app[TMUX_KEY].list_sessions()
            return web.json_response({"ok": True, "sessions": len(sessions)})
        except TmuxError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=503)

    async def sessions(_: web.Request) -> web.Response:
        try:
            payload = await app[SESSION_SNAPSHOTS_KEY].build()
        except TmuxError as error:
            return json_error(str(error), 503)
        return web.json_response(payload)

    async def create_session(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        unknown_fields = sorted(set(payload) - {"name"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        requested_name = payload.get("name")
        if "name" in payload:
            if not isinstance(requested_name, str):
                return json_error("name must be a string", 400)
            try:
                requested_name = validate_tmux_new_session_name(requested_name)
            except ValueError as error:
                return json_error(str(error), 400)

        try:
            created_session = await app[TMUX_KEY].create_session(requested_name)
        except ValueError as error:
            return json_error(str(error), 400)
        except TmuxError as error:
            message = str(error)
            status = 409 if "duplicate session" in message.lower() else 503
            return json_error(message, status)
        return web.json_response(
            {"session": created_session.name, "sessionId": created_session.id},
            status=201,
        )

    async def rename_session(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing_fields = sorted({"session", "name"} - set(payload))
        if missing_fields:
            return json_error(f"{missing_fields[0]} is required", 400)
        unknown_fields = sorted(set(payload) - {"session", "name"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        current_name = payload["session"]
        new_name = payload["name"]
        if not isinstance(current_name, str):
            return json_error("session must be a string", 400)
        if not isinstance(new_name, str):
            return json_error("name must be a string", 400)
        try:
            current_name = validate_tmux_session_name(current_name)
            new_name = validate_tmux_new_session_name(new_name)
        except ValueError as error:
            return json_error(str(error), 400)
        if current_name == new_name:
            return json_error(
                "new session name must differ from current session name", 400
            )

        async with app[SESSION_RENAME_LOCK_KEY]:
            try:
                sessions_before_rename = await app[TMUX_KEY].list_sessions()
            except TmuxError as error:
                return json_error(str(error), 503)
            source_session = next(
                (
                    session
                    for session in sessions_before_rename
                    if session.name == current_name
                ),
                None,
            )
            if source_session is None:
                return json_error(f"tmux session not found: {current_name}", 404)
            if any(session.name == new_name for session in sessions_before_rename):
                return json_error(f"tmux session already exists: {new_name}", 409)

            warnings: list[str] = []
            try:
                renamed_session = await app[TMUX_KEY].rename_session(
                    current_name,
                    new_name,
                    session_id=source_session.id,
                )
            except TmuxRenameUnverifiedError as error:
                renamed_session = error.requested_name
                LOGGER.warning(
                    "Tmux renamed session %s to %s, but verification failed: %s",
                    current_name,
                    renamed_session,
                    error.verification_error,
                )
                warnings.append(
                    "tmux rename succeeded but its final session name could not be verified"
                )
            except ValueError as error:
                return json_error(str(error), 400)
            except TmuxError as error:
                message = str(error)
                lowered_message = message.lower()
                if "duplicate session" in lowered_message:
                    return json_error(message, 409)
                if any(
                    marker in lowered_message
                    for marker in (
                        "can't find session",
                        "no such session",
                        "session not found",
                    )
                ):
                    return json_error(message, 404)
                return json_error(message, 503)

            if renamed_session != new_name:
                LOGGER.warning(
                    "Tmux renamed session %s to unexpected native name %s (requested %s)",
                    current_name,
                    renamed_session,
                    new_name,
                )
                warnings.append("tmux returned a different session name than requested")
            try:
                app[TITLES_KEY].rename_session(current_name, renamed_session)
            except Exception:
                # The tmux rename is already committed, so storage errors cannot undo it.
                LOGGER.exception(
                    "Unable to migrate metadata after renaming tmux session %s to %s",
                    current_name,
                    renamed_session,
                )
                warnings.append("unable to migrate session metadata")
            try:
                app[MESSAGES_KEY].rename_session(current_name, renamed_session)
            except Exception:
                LOGGER.exception(
                    "Unable to migrate memo entries after renaming tmux session %s to %s",
                    current_name,
                    renamed_session,
                )
                warnings.append("unable to migrate memo entries")
            try:
                app[WORKSPACES_KEY].rename_session(current_name, renamed_session)
            except Exception:
                LOGGER.exception(
                    "Unable to migrate saved workspaces after renaming tmux session "
                    "%s to %s",
                    current_name,
                    renamed_session,
                )
                warnings.append("unable to migrate saved workspaces")

            response: dict[str, Any] = {
                "previousSession": current_name,
                "session": renamed_session,
            }
            if warnings:
                response["warnings"] = warnings
            return web.json_response(response)

    async def sessions_stream(request: web.Request) -> web.StreamResponse:
        queue = await app[SESSION_STREAM_BROKER_KEY].subscribe()
        response = web.StreamResponse(
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
            }
        )
        loop = asyncio.get_running_loop()

        try:
            await response.prepare(request)
            next_heartbeat = loop.time() + SESSION_STREAM_HEARTBEAT_SECONDS
            while True:
                transport = request.transport
                if transport is None or transport.is_closing():
                    break

                try:
                    timeout = min(
                        SESSION_STREAM_SAMPLE_SECONDS,
                        max(0.0, next_heartbeat - loop.time()),
                    )
                    serialized = await asyncio.wait_for(
                        queue.get(), timeout=max(0.001, timeout)
                    )
                except TimeoutError:
                    serialized = ""

                if serialized is None:
                    break
                if serialized:
                    await response.write(
                        f"event: sessions\ndata: {serialized}\n\n".encode("utf-8")
                    )

                now = loop.time()
                if now >= next_heartbeat:
                    await response.write(b": heartbeat\n\n")
                    next_heartbeat = now + SESSION_STREAM_HEARTBEAT_SECONDS
        except asyncio.CancelledError:
            raise
        except ConnectionError:
            LOGGER.debug("Session stream client disconnected")
        finally:
            await app[SESSION_STREAM_BROKER_KEY].unsubscribe(queue)
            with contextlib.suppress(ConnectionError, RuntimeError):
                await response.write_eof()
        return response

    async def update_session_title(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        session_name = payload.get("session")
        title = payload.get("title")
        if not isinstance(session_name, str) or not session_name:
            return json_error("session is required", 400)
        if not isinstance(title, str):
            return json_error("title must be a string", 400)
        try:
            session_name = validate_session_name(session_name)
            normalize_title(title)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                saved_title = app[TITLES_KEY].set_title(session_name, title)
        except TmuxError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save title for tmux session %s", session_name)
            return json_error("unable to save session title", 500)
        return web.json_response({"session": session_name, "customTitle": saved_title})

    async def update_session_star(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        session_name = payload.get("session")
        starred = payload.get("starred")
        if not isinstance(session_name, str) or not session_name:
            return json_error("session is required", 400)
        if not isinstance(starred, bool):
            return json_error("starred must be a boolean", 400)
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                saved_starred = app[TITLES_KEY].set_starred(session_name, starred)
                saved_ignored = app[TITLES_KEY].is_ignored(session_name)
        except TmuxError as error:
            return json_error(str(error), 404)
        except OSError:
            LOGGER.exception("Unable to save star for tmux session %s", session_name)
            return json_error("unable to save session star", 500)
        return web.json_response(
            {
                "session": session_name,
                "starred": saved_starred,
                "ignored": saved_ignored,
            }
        )

    async def update_session_ignored(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        session_name = payload.get("session")
        ignored = payload.get("ignored")
        if not isinstance(session_name, str) or not session_name:
            return json_error("session is required", 400)
        if not isinstance(ignored, bool):
            return json_error("ignored must be a boolean", 400)
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                saved_ignored = app[TITLES_KEY].set_ignored(session_name, ignored)
                saved_starred = app[TITLES_KEY].is_starred(session_name)
        except TmuxError as error:
            return json_error(str(error), 404)
        except OSError:
            LOGGER.exception(
                "Unable to save ignored status for tmux session %s", session_name
            )
            return json_error("unable to save session ignored status", 500)
        return web.json_response(
            {
                "session": session_name,
                "starred": saved_starred,
                "ignored": saved_ignored,
            }
        )

    async def list_session_messages(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            messages = app[MESSAGES_KEY].list_messages(session_name)
        except ValueError as error:
            return json_error(str(error), 400)
        return web.json_response({"session": session_name, "messages": messages})

    async def add_session_message(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        text = payload.get("text")
        if not isinstance(text, str):
            return json_error("text must be a string", 400)
        state = payload.get("state", "queued")
        if not isinstance(state, str):
            return json_error("state must be a string", 400)
        try:
            session_name = validate_session_name(session_name)
            text = validate_message_text(text)
            state = validate_message_state(state)
        except ValueError as error:
            return json_error(str(error), 400)
        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                message = app[MESSAGES_KEY].add_message(session_name, text, state=state)
        except TmuxError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to add memo entry for tmux session %s", session_name
            )
            return json_error("unable to save memo", 500)
        return web.json_response(
            {"session": session_name, "message": message}, status=201
        )

    async def update_session_message(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        message_id = request.match_info["message_id"]
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        has_text = "text" in payload
        has_position = "position" in payload
        has_state = "state" in payload
        if not has_text and not has_position and not has_state:
            return json_error("text, position, or state is required", 400)
        text: str | None = None
        if has_text:
            candidate_text = payload.get("text")
            if not isinstance(candidate_text, str):
                return json_error("text must be a string", 400)
            text = candidate_text
        position = payload.get("position")
        if has_position and (
            isinstance(position, bool) or not isinstance(position, int)
        ):
            return json_error("position must be an integer", 400)
        state: str | None = None
        if has_state:
            candidate_state = payload.get("state")
            if not isinstance(candidate_state, str):
                return json_error("state must be a string", 400)
            state = candidate_state

        try:
            session_name = validate_session_name(session_name)
            if text is not None:
                text = validate_message_text(text)
            if state is not None:
                state = validate_message_state(state)
        except ValueError as error:
            return json_error(str(error), 400)
        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                message = app[MESSAGES_KEY].update_message(
                    session_name,
                    message_id,
                    text=text,
                    position=position if has_position else None,
                    state=state,
                )
        except TmuxError as error:
            return json_error(str(error), 404)
        except MessageNotFoundError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to update memo entry for tmux session %s", session_name
            )
            return json_error("unable to save memo", 500)
        return web.json_response({"session": session_name, "message": message})

    async def delete_session_message(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        message_id = request.match_info["message_id"]
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)
        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                app[MESSAGES_KEY].delete_message(session_name, message_id)
        except TmuxError as error:
            return json_error(str(error), 404)
        except MessageNotFoundError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to delete memo entry for tmux session %s", session_name
            )
            return json_error("unable to save memo", 500)
        return web.Response(status=204)

    async def list_snippets(_: web.Request) -> web.Response:
        try:
            snapshot = app[SNIPPETS_KEY].get_snapshot()
        except SnippetStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response(snapshot)

    async def replace_snippets(request: web.Request) -> web.Response:
        # ValueError includes malformed JSON and text decoding failures.
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing = sorted({"revision", "tree"} - set(payload))
        if missing:
            return json_error(f"{missing[0]} is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"revision", "tree"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        revision = payload["revision"]
        if isinstance(revision, bool) or not isinstance(revision, int):
            return json_error("revision must be an integer", 400)
        try:
            snapshot = app[SNIPPETS_KEY].replace_tree(
                payload["tree"], expected_revision=revision
            )
        except SnippetRevisionConflict as error:
            return web.json_response(
                {"error": str(error), "revision": error.current_revision},
                status=409,
            )
        except SnippetStoreUnavailable as error:
            return json_error(str(error), 503)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save snippet tree")
            return json_error("unable to save snippets", 500)
        return web.json_response(snapshot)

    async def list_workspaces(_: web.Request) -> web.Response:
        try:
            workspaces = app[WORKSPACES_KEY].list_workspaces()
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"workspaces": workspaces})

    async def get_workspace(request: web.Request) -> web.Response:
        try:
            workspace = app[WORKSPACES_KEY].get_workspace(
                request.match_info["workspace_id"]
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        return web.json_response({"workspace": workspace})

    async def create_workspace(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        required = {"name", "tabs", "activeSession"}
        missing = sorted(required - set(payload))
        if missing:
            return json_error(f"{missing[0]} is required", 400)
        unknown = sorted(str(field) for field in set(payload) - required)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            workspace = app[WORKSPACES_KEY].create_workspace(
                name=payload["name"],
                tabs=payload["tabs"],
                active_session=payload["activeSession"],
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to create saved workspace")
            return json_error("unable to save workspace", 500)
        except RuntimeError:
            LOGGER.exception("Unable to generate a saved workspace id")
            return json_error("unable to create workspace", 500)
        return web.json_response({"workspace": workspace}, status=201)

    async def update_workspace(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        allowed = {"name", "tabs", "activeSession", "sessionRevision"}
        unknown = sorted(str(field) for field in set(payload) - allowed)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        if not set(payload) & {"name", "tabs", "activeSession"}:
            return json_error("name, tabs, or activeSession is required", 400)
        if (
            set(payload) & {"tabs", "activeSession"}
            and "sessionRevision" not in payload
        ):
            return json_error("sessionRevision is required", 400)

        try:
            workspace = app[WORKSPACES_KEY].update_workspace(
                request.match_info["workspace_id"],
                name=payload.get("name"),
                tabs=payload.get("tabs"),
                active_session=payload.get("activeSession"),
                update_name="name" in payload,
                update_tabs="tabs" in payload,
                update_active_session="activeSession" in payload,
                session_revision=payload.get("sessionRevision"),
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except WorkspaceSessionRevisionConflict as error:
            return json_error(str(error), 409)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to update saved workspace %s",
                request.match_info["workspace_id"],
            )
            return json_error("unable to save workspace", 500)
        return web.json_response({"workspace": workspace})

    async def record_workspace_activity(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        required = {"tabs", "activeSession", "sessionRevision"}
        missing = sorted(required - set(payload))
        if missing:
            return json_error(f"{missing[0]} is required", 400)
        unknown = sorted(str(field) for field in set(payload) - required)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            workspace = app[WORKSPACES_KEY].record_activity(
                request.match_info["workspace_id"],
                tabs=payload["tabs"],
                active_session=payload["activeSession"],
                session_revision=payload["sessionRevision"],
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except WorkspaceSessionRevisionConflict as error:
            return json_error(str(error), 409)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to record saved workspace activity for %s",
                request.match_info["workspace_id"],
            )
            return json_error("unable to save workspace", 500)
        return web.json_response({"workspace": workspace})

    async def delete_workspace(request: web.Request) -> web.Response:
        try:
            app[WORKSPACES_KEY].delete_workspace(request.match_info["workspace_id"])
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to delete saved workspace %s",
                request.match_info["workspace_id"],
            )
            return json_error("unable to save workspace", 500)
        return web.Response(status=204)

    async def create_history(request: web.Request) -> web.Response:
        pane_id = request.match_info["pane_id"]
        limit = max(20, min(parse_int(request.query.get("limit"), 250), 1000))
        try:
            capture = await app[TMUX_KEY].capture_history(pane_id)
        except TmuxError as error:
            return json_error(str(error), 404)
        snapshot = app[SNAPSHOTS_KEY].create(capture)
        return web.json_response(snapshot.page(before=None, limit=limit))

    async def history_page(request: web.Request) -> web.Response:
        snapshot = app[SNAPSHOTS_KEY].get(request.match_info["snapshot_id"])
        if snapshot is None:
            return json_error("history snapshot expired", 404)
        before = parse_int(request.query.get("before"), len(snapshot.lines))
        limit = max(20, min(parse_int(request.query.get("limit"), 250), 1000))
        return web.json_response(snapshot.page(before=before, limit=limit))

    async def terminal(request: web.Request) -> web.StreamResponse:
        session_name = request.query.get("session", "")
        try:
            session = await app[TMUX_KEY].get_session(session_name)
        except TmuxError as error:
            return json_error(str(error), 404)

        cols, rows = clamp_size(
            parse_int(request.query.get("cols"), 100),
            parse_int(request.query.get("rows"), 30),
        )
        ignore_size = request.query.get("ignoreSize", "0") == "1"
        websocket = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_INPUT_BYTES)
        await websocket.prepare(request)

        try:
            bridge = await PtyBridge.attach(
                app[TMUX_KEY].command_prefix,
                session.id,
                cols,
                rows,
                ignore_size=ignore_size,
            )
        except Exception as error:
            LOGGER.exception("Failed to attach to tmux session %s", session.name)
            await websocket.send_str(
                json.dumps({"type": "error", "message": str(error)})
            )
            await websocket.close(code=1011)
            return websocket

        await websocket.send_str(
            json.dumps(
                {
                    "type": "ready",
                    "session": session.name,
                    "paneId": session.active_pane.id if session.active_pane else None,
                    "ignoreSize": ignore_size,
                }
            )
        )

        async def send_output() -> None:
            while True:
                data = await bridge.read()
                if data is None:
                    break
                await websocket.send_bytes(data)
            if not websocket.closed:
                await websocket.send_str(
                    json.dumps({"type": "exit", "code": bridge.process.poll()})
                )
                await websocket.close()

        sender = asyncio.create_task(send_output())
        try:
            async for message in websocket:
                if message.type == WSMsgType.BINARY:
                    if len(message.data) <= MAX_INPUT_BYTES:
                        await bridge.write(message.data)
                elif message.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(message.data)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if not isinstance(payload, dict):
                        continue
                    if payload.get("type") == "resize":
                        bridge.resize(
                            parse_int(str(payload.get("cols", "")), cols),
                            parse_int(str(payload.get("rows", "")), rows),
                        )
                    elif payload.get("type") == "input":
                        input_id = payload.get("id")
                        input_data = payload.get("data")
                        if (
                            not isinstance(input_id, str)
                            or not input_id
                            or len(input_id) > 128
                        ):
                            continue

                        accepted = False
                        if isinstance(input_data, str):
                            try:
                                encoded = input_data.encode("utf-8")
                            except UnicodeEncodeError:
                                pass
                            else:
                                if len(encoded) <= MAX_INPUT_BYTES:
                                    accepted = await bridge.write(encoded)
                        if not websocket.closed:
                            try:
                                await websocket.send_str(
                                    json.dumps(
                                        {
                                            "type": (
                                                "inputAck" if accepted else "inputNack"
                                            ),
                                            "id": input_id,
                                        }
                                    )
                                )
                            except (ConnectionError, RuntimeError):
                                break
                    elif payload.get("type") == "history":
                        action = payload.get("action")
                        accepted = False
                        if (
                            isinstance(action, str)
                            and action in TERMINAL_HISTORY_ACTIONS
                        ):
                            try:
                                await app[TMUX_KEY].navigate_history(
                                    bridge.client_pid,
                                    session.id,
                                    action,
                                )
                            except (TmuxError, ValueError) as error:
                                LOGGER.debug(
                                    "Terminal history action %r failed for client %s: %s",
                                    action,
                                    bridge.client_pid,
                                    error,
                                )
                            else:
                                accepted = True
                        if not websocket.closed:
                            try:
                                await websocket.send_str(
                                    json.dumps(
                                        {
                                            "type": (
                                                "historyAck"
                                                if accepted
                                                else "historyNack"
                                            ),
                                            "action": action,
                                        }
                                    )
                                )
                            except (ConnectionError, RuntimeError):
                                break
                elif message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            await _close_terminal_bridge(sender, bridge)
        return websocket

    async def spa(_: web.Request) -> web.StreamResponse:
        index = DIST / "index.html"
        if not index.exists():
            return web.Response(
                text="Muxdeck frontend is not built. Run `npm install && npm run build`.",
                status=503,
            )
        return web.FileResponse(index)

    app.router.add_get(f"{prefix}/api/health", health)
    app.router.add_get(f"{prefix}/api/sessions", sessions)
    app.router.add_post(f"{prefix}/api/sessions", create_session)
    app.router.add_put(f"{prefix}/api/session-name", rename_session)
    app.router.add_get(f"{prefix}/api/sessions/stream", sessions_stream)
    app.router.add_get(
        f"{prefix}/api/sessions/{{session}}/messages", list_session_messages
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{{session}}/messages", add_session_message
    )
    app.router.add_patch(
        f"{prefix}/api/sessions/{{session}}/messages/{{message_id}}",
        update_session_message,
    )
    app.router.add_delete(
        f"{prefix}/api/sessions/{{session}}/messages/{{message_id}}",
        delete_session_message,
    )
    app.router.add_get(f"{prefix}/api/snippets", list_snippets)
    app.router.add_put(f"{prefix}/api/snippets", replace_snippets)
    app.router.add_get(f"{prefix}/api/workspaces", list_workspaces)
    app.router.add_post(f"{prefix}/api/workspaces", create_workspace)
    app.router.add_get(f"{prefix}/api/workspaces/{{workspace_id}}", get_workspace)
    app.router.add_patch(f"{prefix}/api/workspaces/{{workspace_id}}", update_workspace)
    app.router.add_post(
        f"{prefix}/api/workspaces/{{workspace_id}}/activity",
        record_workspace_activity,
    )
    app.router.add_delete(f"{prefix}/api/workspaces/{{workspace_id}}", delete_workspace)
    app.router.add_put(f"{prefix}/api/session-title", update_session_title)
    app.router.add_put(f"{prefix}/api/session-star", update_session_star)
    app.router.add_put(f"{prefix}/api/session-ignored", update_session_ignored)
    app.router.add_post(f"{prefix}/api/panes/{{pane_id}}/history", create_history)
    app.router.add_get(f"{prefix}/api/history/{{snapshot_id}}", history_page)
    app.router.add_get(f"{prefix}/ws/terminal", terminal)
    if DIST.exists():
        app.router.add_static(f"{prefix}/assets/", DIST / "assets", name="assets")
    app.router.add_get(prefix or "/", spa)
    app.router.add_get(f"{prefix}/{{tail:.*}}", spa)
    return app


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    host = os.environ.get("MUXDECK_HOST", "127.0.0.1")
    port = parse_int(os.environ.get("MUXDECK_PORT"), 7683)
    web.run_app(create_app(), host=host, port=port, print=LOGGER.info)


if __name__ == "__main__":
    main()
