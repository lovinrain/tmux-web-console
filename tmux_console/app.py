from __future__ import annotations

import asyncio
import contextlib
import errno
import ipaddress
import json
import logging
import math
import os
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, quote, urlsplit

from aiohttp import WSMsgType, web

from .auth import (
    AuthConfigurationError,
    AuthMode,
    AuthPersistenceError,
    AuthStore,
    BasicAuthVerifier,
    RememberedDevice,
    default_auth_path,
    resolve_auth_mode,
)
from .auth_views import (
    describe_browser,
    render_account_page,
    render_auth_mode_page,
    render_login_page,
)
from .file_browser import (
    ENTRY_KINDS,
    MAX_FILE_UPLOAD_BYTES,
    MAX_TEXT_WRITE_BODY_BYTES,
    MAX_TEXT_WRITE_BYTES,
    FileBrowserConflictError,
    FileBrowserContentTooLargeError,
    FileBrowserDestinationExistsError,
    FileBrowserDirectoryNotEmptyError,
    FileBrowserDownload,
    FileBrowserImagePreview,
    FileBrowserImageTooLargeError,
    FileBrowserPartialDeleteError,
    FileBrowserPathOutsideRootError,
    FileBrowserUnsupportedFileError,
    FileBrowserUnsupportedImageError,
    copy_entry,
    create_entry,
    delete_entry,
    list_directory,
    move_entry,
    preview_file,
    resolve_browse_boundary,
    resolve_browse_root,
    resolve_browse_target,
    resolve_file_download,
    resolve_file_image_preview,
    upload_file,
    write_text_file,
)
from .history import SnapshotStore
from .host_metrics import (
    HOST_METRIC_RANGES,
    HostMetricsSampler,
    HostMetricsUnavailableError,
)
from .messages import (
    MessageNotFoundError,
    SessionMessageStore,
    validate_message_state,
    validate_message_text,
    validate_session_name,
)
from .metadata import SessionTitleStore, normalize_tags, normalize_title
from .pty_bridge import PtyBridge, clamp_size
from .shortcuts import (
    ShortcutRevisionConflict,
    ShortcutStore,
    ShortcutStoreUnavailable,
)
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
    TmuxSessionIdentityChangedError,
    TmuxSessionNotFoundError,
    validate_tmux_new_session_name,
    validate_tmux_pane_id,
    validate_tmux_session_id,
    validate_tmux_session_name,
    validate_tmux_start_directory,
)
from .uploads import (
    MAX_ATTACHMENT_UPLOAD_BYTES,
    AttachmentStorageFullError,
    AttachmentStore,
)
from .workspaces import (
    WorkspaceNotFoundError,
    WorkspacePinCapacityError,
    WorkspaceSessionRevisionConflict,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
    WorkspaceTransferConflictError,
    normalize_scoped_note,
    validate_workspace_quick_links,
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
SHORTCUTS_KEY = web.AppKey("shortcuts", ShortcutStore)
WORKSPACES_KEY = web.AppKey("workspaces", WorkspaceStore)
ATTACHMENTS_KEY = web.AppKey("attachments", AttachmentStore)
AGENT_STATES_KEY = web.AppKey("agent_states", AgentStateDetector)
BASE_PATH_KEY = web.AppKey("base_path", str)
TRUSTED_ORIGINS_KEY = web.AppKey("trusted_origins", frozenset)
AUTH_KEY = web.AppKey("auth", AuthStore)
AUTH_MODE_KEY = web.AppKey("auth_mode", AuthMode)
BASIC_AUTH_KEY = web.AppKey("basic_auth", BasicAuthVerifier)
AUTH_COOKIE_SECURE_KEY = web.AppKey("auth_cookie_secure", bool)
LOGIN_SEMAPHORE_KEY = web.AppKey("login_semaphore", asyncio.Semaphore)
AUTH_DEVICE_REQUEST_KEY = web.RequestKey("muxdeck_auth_device", RememberedDevice)
AUTH_COOKIE_VALUE_REQUEST_KEY = web.RequestKey("muxdeck_auth_cookie_value", str)
SESSION_RENAME_LOCK_KEY = web.AppKey("session_rename_lock", asyncio.Lock)
FILE_BROWSER_ROOT_KEY = web.AppKey("file_browser_root", Path)
HOST_METRICS_KEY = web.AppKey("host_metrics", HostMetricsSampler)
SESSION_STREAM_SAMPLE_SECONDS = 1.0
SESSION_STREAM_HEARTBEAT_SECONDS = 15.0
SAFE_HTTP_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEFAULT_ORIGIN_PORTS = {"http": 80, "https": 443}
AUTH_COOKIE_NAME = "muxdeck_device"
AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60
BASIC_AUTH_CHALLENGE = 'Basic realm="Muxdeck", charset="UTF-8"'
NormalizedOrigin = tuple[str, str, int | None]
NormalizedHost = tuple[str, int | None]


def _file_content_disposition(
    name: str,
    disposition: str,
    *,
    fallback: str,
) -> str:
    ascii_name = name.encode("ascii", "ignore").decode("ascii")
    fallback_name = "".join(
        character
        if character.isalnum() or character in {" ", ".", "_", "-"}
        else "_"
        for character in ascii_name
    ).strip() or fallback
    return (
        f'{disposition}; filename="{fallback_name}"; '
        f"filename*=UTF-8''{quote(name, safe='')}"
    )


class SessionSnapshotBuilder:
    def __init__(
        self,
        tmux: TmuxClient,
        titles: SessionTitleStore,
        agent_states: AgentStateDetector,
        clock: Callable[[], float] = time.time,
        messages: SessionMessageStore | None = None,
        mutation_lock: asyncio.Lock | None = None,
        workspaces: WorkspaceStore | None = None,
    ) -> None:
        self._tmux = tmux
        self._titles = titles
        self._agent_states = agent_states
        self._messages = messages
        self._mutation_lock = mutation_lock
        self._workspaces = workspaces
        self._clock = clock
        self._lock = asyncio.Lock()
        self._state_history: dict[str, tuple[str, str, int]] = {}

    async def build(self) -> dict[str, list[dict[str, Any]]]:
        async with self._lock:
            if self._mutation_lock is not None:
                async with self._mutation_lock:
                    return await self._build_unlocked()
            return await self._build_unlocked()

    async def _build_unlocked(self) -> dict[str, list[dict[str, Any]]]:
        items = await self._tmux.list_sessions()
        states = await self._agent_states.detect_sessions(self._tmux, items)
        observed_at = int(self._clock())
        next_state_history: dict[str, tuple[str, str, int]] = {}
        payload: list[dict[str, Any]] = []
        try:
            workspace_pins = (
                set(self._workspaces.list_pinned_sessions())
                if self._workspaces is not None
                else set()
            )
        except WorkspaceStoreUnavailable:
            workspace_pins = set()

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
                    "workspacePinned": item.name in workspace_pins,
                    "tags": self._titles.get_tags(item.name),
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


def _normalized_hostname(hostname: str | None) -> str | None:
    if hostname is None:
        return None
    normalized = hostname.casefold().rstrip(".")
    if not normalized or any(character.isspace() for character in normalized):
        return None
    return normalized


def _split_origin(value: str, *, allow_path: bool = False) -> SplitResult | None:
    if not value or value != value.strip():
        return None
    try:
        parsed = urlsplit(value)
        # Accessing these properties performs urllib's bracket and port validation.
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.casefold() not in DEFAULT_ORIGIN_PORTS
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (parsed.path not in {"", "/"} and not allow_path)
        or parsed.netloc.endswith(":")
    ):
        return None
    return parsed


def _normalize_origin(
    value: str, *, allow_path: bool = False
) -> NormalizedOrigin | None:
    parsed = _split_origin(value, allow_path=allow_path)
    if parsed is None:
        return None
    scheme = parsed.scheme.casefold()
    hostname = _normalized_hostname(parsed.hostname)
    if hostname is None:
        return None
    port = parsed.port
    if port == DEFAULT_ORIGIN_PORTS[scheme]:
        port = None
    return scheme, hostname, port


def _normalize_host(value: str | None) -> NormalizedHost | None:
    if value is None or not value or value != value.strip():
        return None
    try:
        parsed = urlsplit(f"//{value}")
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.netloc.endswith(":")
    ):
        return None
    normalized_hostname = _normalized_hostname(hostname)
    if normalized_hostname is None:
        return None
    return normalized_hostname, port


def _host_matches_origin(host: NormalizedHost, origin: NormalizedOrigin) -> bool:
    scheme, origin_hostname, origin_port = origin
    host_hostname, host_port = host
    if host_hostname != origin_hostname:
        return False
    if host_port is None:
        return origin_port is None
    effective_origin_port = (
        origin_port if origin_port is not None else DEFAULT_ORIGIN_PORTS[scheme]
    )
    return host_port == effective_origin_port


def _is_loopback_host(host: NormalizedHost) -> bool:
    hostname, _ = host
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError:
        return False
    if address.is_loopback:
        return True
    return bool(
        address.version == 6 and address.ipv4_mapped and address.ipv4_mapped.is_loopback
    )


def _parse_trusted_origins(values: Iterable[str]) -> frozenset[NormalizedOrigin]:
    origins: set[NormalizedOrigin] = set()
    for raw_value in values:
        value = raw_value.strip()
        if not value:
            continue
        origin = _normalize_origin(value)
        if origin is None:
            raise ValueError(
                "MUXDECK_TRUSTED_ORIGINS entries must be absolute http(s) origins"
            )
        origins.add(origin)
    return frozenset(origins)


def _is_trusted_host(
    host: NormalizedHost,
    trusted_origins: frozenset[NormalizedOrigin],
) -> bool:
    return _is_loopback_host(host) or any(
        _host_matches_origin(host, origin) for origin in trusted_origins
    )


def _browser_origin_is_trusted(
    request: web.Request,
    host: NormalizedHost,
    trusted_origins: frozenset[NormalizedOrigin],
) -> bool:
    origin_values = request.headers.getall("Origin", [])
    if origin_values:
        if len(origin_values) != 1:
            return False
        origin = _normalize_origin(origin_values[0])
        if origin is None or not _host_matches_origin(host, origin):
            return False
        return _is_loopback_host(host) or origin in trusted_origins

    # Non-browser clients may omit Origin. If a browser does so, Fetch Metadata
    # still distinguishes same-origin navigation from a cross-site request.
    referer_values = request.headers.getall("Referer", [])
    if referer_values:
        if len(referer_values) != 1:
            return False
        referer_origin = _normalize_origin(referer_values[0], allow_path=True)
        if referer_origin is None or not _host_matches_origin(host, referer_origin):
            return False
        if not _is_loopback_host(host) and referer_origin not in trusted_origins:
            return False

    fetch_site = request.headers.get("Sec-Fetch-Site", "").casefold()
    return not fetch_site or fetch_site in {"same-origin", "none"}


def _configured_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError("boolean configuration must be true/false, yes/no, on/off, or 1/0")


def _auth_cookie_path(prefix: str) -> str:
    return prefix or "/"


def _set_auth_cookie(
    response: web.StreamResponse,
    value: str,
    *,
    prefix: str,
    secure: bool,
) -> None:
    response.set_cookie(
        AUTH_COOKIE_NAME,
        value,
        max_age=AUTH_COOKIE_MAX_AGE_SECONDS,
        path=_auth_cookie_path(prefix),
        secure=secure,
        httponly=True,
        samesite="Strict",
    )


def _clear_auth_cookie(
    response: web.StreamResponse, *, prefix: str, secure: bool
) -> None:
    response.del_cookie(
        AUTH_COOKIE_NAME,
        path=_auth_cookie_path(prefix),
        secure=secure,
        httponly=True,
        samesite="Strict",
    )


def _see_other(location: str) -> web.Response:
    return web.Response(status=303, headers={"Location": location})


def _default_auth_destination(prefix: str) -> str:
    return f"{prefix}/" if prefix else "/"


def _safe_auth_destination(value: object, prefix: str) -> str:
    fallback = _default_auth_destination(prefix)
    if not isinstance(value, str) or not value or len(value) > 4096:
        return fallback
    try:
        parsed = urlsplit(value)
    except ValueError:
        return fallback
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        return fallback
    if prefix and parsed.path != prefix and not parsed.path.startswith(f"{prefix}/"):
        return fallback
    public_auth_paths = {
        f"{prefix}/login",
        f"{prefix}/api/auth/login",
        f"{prefix}/logout",
    }
    if parsed.path in public_auth_paths:
        return fallback
    return value


def _request_wants_html(request: web.Request) -> bool:
    return request.method in {"GET", "HEAD"} and (
        request.headers.get("Sec-Fetch-Mode", "").casefold() == "navigate"
        or "text/html" in request.headers.get("Accept", "").casefold()
    )


@web.middleware
async def request_security_middleware(
    request: web.Request,
    handler: Callable[[web.Request], Any],
) -> web.StreamResponse:
    host_values = request.headers.getall("Host", [])
    host = _normalize_host(host_values[0]) if len(host_values) == 1 else None
    trusted_origins = request.app[TRUSTED_ORIGINS_KEY]
    if host is None or not _is_trusted_host(host, trusted_origins):
        return json_error("request host is not trusted", 403)

    is_websocket = request.headers.get("Upgrade", "").casefold() == "websocket"
    if (is_websocket or request.method not in SAFE_HTTP_METHODS) and not (
        _browser_origin_is_trusted(request, host, trusted_origins)
    ):
        return json_error("request origin is not trusted", 403)
    return await handler(request)


@web.middleware
async def authentication_middleware(
    request: web.Request,
    handler: Callable[[web.Request], Any],
) -> web.StreamResponse:
    mode = request.app[AUTH_MODE_KEY]
    if mode is AuthMode.NONE:
        return await handler(request)
    if mode is AuthMode.BASIC:
        authorization_values = request.headers.getall("Authorization", [])
        authenticated = len(authorization_values) == 1 and await asyncio.to_thread(
            request.app[BASIC_AUTH_KEY].verify,
            authorization_values[0],
        )
        if authenticated:
            return await handler(request)
        if _request_wants_html(request):
            response = web.Response(
                text="Authentication required.",
                content_type="text/plain",
                status=401,
            )
        else:
            response = json_error("authentication required", 401)
        response.headers["WWW-Authenticate"] = BASIC_AUTH_CHALLENGE
        response.headers["Cache-Control"] = "no-store"
        return response

    store = request.app.get(AUTH_KEY)
    if store is None:  # Defensive: secure modes must always have a store.
        return json_error("authentication is unavailable", 503)

    prefix = request.app[BASE_PATH_KEY]
    secure = request.app[AUTH_COOKIE_SECURE_KEY]
    cookie_value = request.cookies.get(AUTH_COOKIE_NAME)
    device = await asyncio.to_thread(store.authenticate_cookie, cookie_value)
    if device is not None and cookie_value is not None:
        request[AUTH_DEVICE_REQUEST_KEY] = device
        request[AUTH_COOKIE_VALUE_REQUEST_KEY] = cookie_value
        response = await handler(request)
        if AUTH_COOKIE_NAME not in response.cookies and not response.prepared:
            _set_auth_cookie(
                response,
                cookie_value,
                prefix=prefix,
                secure=secure,
            )
        return response

    public_paths = {f"{prefix}/login", f"{prefix}/api/auth/login"}
    if request.path in public_paths:
        response = await handler(request)
        if (
            cookie_value
            and AUTH_COOKIE_NAME not in response.cookies
            and not response.prepared
        ):
            _clear_auth_cookie(response, prefix=prefix, secure=secure)
        return response

    if _request_wants_html(request):
        destination = _safe_auth_destination(str(request.rel_url), prefix)
        location = f"{prefix}/login?next={quote(destination, safe='')}"
        response = _see_other(location)
    else:
        response = web.json_response(
            {
                "error": "authentication required",
                "login": f"{prefix}/login",
            },
            status=401,
        )
    response.headers["Cache-Control"] = "no-store"
    if cookie_value:
        _clear_auth_cookie(response, prefix=prefix, secure=secure)
    return response


async def add_browser_security_headers(
    _: web.Request,
    response: web.StreamResponse,
) -> None:
    response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # GET is a safe method, so the request-origin guard does not run on reads.
    # This stops another origin embedding a response and using load/error as an
    # oracle for what exists on the host.
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    # Chromium otherwise serializes same-origin form POSTs as Origin: null,
    # which prevents the request-origin guard from authenticating the form.
    response.headers.setdefault("Referrer-Policy", "same-origin")


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
    shortcuts: ShortcutStore | None = None,
    workspaces: WorkspaceStore | None = None,
    attachments: AttachmentStore | None = None,
    uploads: AttachmentStore | None = None,
    trusted_origins: Iterable[str] | str | None = None,
    auth: AuthStore | None = None,
    auth_mode: str | AuthMode | None = None,
    auth_cookie_secure: bool | None = None,
    file_browser_root: str | None = None,
    host_metrics: HostMetricsSampler | None = None,
) -> web.Application:
    app = web.Application(
        client_max_size=MAX_INPUT_BYTES,
        middlewares=[request_security_middleware, authentication_middleware],
    )
    if trusted_origins is None:
        configured_origins: Iterable[str] = os.environ.get(
            "MUXDECK_TRUSTED_ORIGINS", ""
        ).split(",")
    elif isinstance(trusted_origins, str):
        configured_origins = trusted_origins.split(",")
    else:
        configured_origins = trusted_origins
    app[TRUSTED_ORIGINS_KEY] = _parse_trusted_origins(configured_origins)
    # Resolved here so a misconfigured boundary stops startup instead of
    # quietly changing how far the file browser reaches.
    app[FILE_BROWSER_ROOT_KEY] = resolve_browse_boundary(file_browser_root)
    configured_auth_path = default_auth_path()
    configured_auth_mode = (
        os.environ.get("MUXDECK_AUTH_MODE") if auth_mode is None else auth_mode
    )
    resolved_auth_mode = resolve_auth_mode(
        configured_auth_mode,
        credentials_configured=auth is not None or configured_auth_path is not None,
    )
    resolved_auth = auth if resolved_auth_mode is not AuthMode.NONE else None
    if (
        resolved_auth_mode is not AuthMode.NONE
        and resolved_auth is None
        and configured_auth_path is not None
    ):
        resolved_auth = AuthStore(configured_auth_path)
    app[AUTH_MODE_KEY] = resolved_auth_mode
    if resolved_auth is not None:
        app[AUTH_KEY] = resolved_auth
    if resolved_auth_mode is AuthMode.BASIC:
        if resolved_auth is None:  # resolve_auth_mode already guards this path.
            raise AuthConfigurationError("basic authentication credentials are missing")
        app[BASIC_AUTH_KEY] = BasicAuthVerifier(resolved_auth)
    app[AUTH_COOKIE_SECURE_KEY] = (
        _configured_bool(os.environ.get("MUXDECK_AUTH_COOKIE_SECURE"), default=True)
        if auth_cookie_secure is None
        else auth_cookie_secure
    )
    app[LOGIN_SEMAPHORE_KEY] = asyncio.Semaphore(1)
    app[TMUX_KEY] = tmux or TmuxClient()
    app[SNAPSHOTS_KEY] = snapshots or SnapshotStore()
    app[TITLES_KEY] = titles or SessionTitleStore()
    app[MESSAGES_KEY] = messages or SessionMessageStore()
    app[SNIPPETS_KEY] = snippets or SnippetStore()
    app[SHORTCUTS_KEY] = shortcuts or ShortcutStore()
    app[WORKSPACES_KEY] = workspaces or WorkspaceStore()
    if attachments is not None and uploads is not None:
        raise ValueError("provide attachments or uploads, not both")
    app[ATTACHMENTS_KEY] = attachments or uploads or AttachmentStore()
    app[AGENT_STATES_KEY] = agent_states or AgentStateDetector()
    app[HOST_METRICS_KEY] = host_metrics or HostMetricsSampler()
    app[SESSION_RENAME_LOCK_KEY] = asyncio.Lock()
    app[SESSION_SNAPSHOTS_KEY] = SessionSnapshotBuilder(
        app[TMUX_KEY],
        app[TITLES_KEY],
        app[AGENT_STATES_KEY],
        messages=app[MESSAGES_KEY],
        mutation_lock=app[SESSION_RENAME_LOCK_KEY],
        workspaces=app[WORKSPACES_KEY],
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
    app.on_response_prepare.append(add_browser_security_headers)

    def auth_html_response(document: str, *, status: int = 200) -> web.Response:
        response = web.Response(text=document, content_type="text/html", status=status)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
            "base-uri 'none'; frame-ancestors 'none'"
        )
        return response

    def auth_store() -> AuthStore | None:
        return app.get(AUTH_KEY)

    def authenticated_device(request: web.Request) -> RememberedDevice | None:
        device = request.get(AUTH_DEVICE_REQUEST_KEY)
        return device if isinstance(device, RememberedDevice) else None

    async def request_auth_still_valid(request: web.Request) -> bool:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            return True
        store = auth_store()
        if store is None:
            return True
        cookie_value = request.get(AUTH_COOKIE_VALUE_REQUEST_KEY)
        if not isinstance(cookie_value, str):
            return False
        return (
            await asyncio.to_thread(store.authenticate_cookie, cookie_value)
        ) is not None

    async def create_remembered_device(
        request: web.Request, username: object, password: object
    ) -> tuple[RememberedDevice, str] | None:
        store = auth_store()
        if store is None:
            return None
        async with app[LOGIN_SEMAPHORE_KEY]:
            valid = await asyncio.to_thread(
                store.verify_credentials, username, password
            )
            if not valid:
                await asyncio.sleep(0.45)
                return None
            label = describe_browser(request.headers.get("User-Agent"))
            return await asyncio.to_thread(store.issue_device, label)

    async def login_page(request: web.Request) -> web.StreamResponse:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            return _see_other(_default_auth_destination(prefix))
        store = auth_store()
        if store is None:
            return _see_other(_default_auth_destination(prefix))
        destination = _safe_auth_destination(request.query.get("next"), prefix)
        if authenticated_device(request) is not None:
            return _see_other(destination)
        return auth_html_response(
            render_login_page(prefix=prefix, next_path=destination)
        )

    async def login_form(request: web.Request) -> web.StreamResponse:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            raise web.HTTPNotFound()
        store = auth_store()
        if store is None:
            raise web.HTTPNotFound()
        username: object = None
        password: object = None
        next_value: object = None
        try:
            form = await request.post()
        except (ValueError, TypeError, OSError):
            pass
        else:
            username = form.get("username")
            password = form.get("password")
            next_value = form.get("next")
        destination = _safe_auth_destination(next_value, prefix)
        try:
            issued = await create_remembered_device(request, username, password)
        except AuthPersistenceError:
            return auth_html_response(
                render_login_page(
                    prefix=prefix,
                    next_path=destination,
                    username=username if isinstance(username, str) else "",
                    error="Authentication storage is unavailable. Try again after the server state is repaired.",
                ),
                status=503,
            )
        if issued is None:
            return auth_html_response(
                render_login_page(
                    prefix=prefix,
                    next_path=destination,
                    username=username if isinstance(username, str) else "",
                    error="The username or password is not correct.",
                ),
                status=401,
            )
        _, cookie_value = issued
        response = _see_other(destination)
        response.headers["Cache-Control"] = "no-store"
        _set_auth_cookie(
            response,
            cookie_value,
            prefix=prefix,
            secure=app[AUTH_COOKIE_SECURE_KEY],
        )
        return response

    async def api_login(request: web.Request) -> web.Response:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            return json_error("server authentication is not enabled", 404)
        store = auth_store()
        if store is None:
            return json_error("authentication is not configured", 404)
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict) or set(payload) != {"username", "password"}:
            return json_error("request must contain username and password", 400)
        try:
            issued = await create_remembered_device(
                request, payload["username"], payload["password"]
            )
        except AuthPersistenceError:
            return json_error("authentication storage is unavailable", 503)
        if issued is None:
            return json_error("invalid username or password", 401)
        device, cookie_value = issued
        response = web.json_response(
            {
                "authenticated": True,
                "username": store.username,
                "device": device.public_dict(current=True),
            }
        )
        response.headers["Cache-Control"] = "no-store"
        _set_auth_cookie(
            response,
            cookie_value,
            prefix=prefix,
            secure=app[AUTH_COOKIE_SECURE_KEY],
        )
        return response

    async def auth_session(request: web.Request) -> web.Response:
        mode = app[AUTH_MODE_KEY]
        store = auth_store()
        device = authenticated_device(request)
        if mode is AuthMode.NONE:
            return web.json_response(
                {"mode": mode.value, "enabled": False, "authenticated": False}
            )
        if mode is AuthMode.BASIC:
            if store is None:
                return json_error("authentication is unavailable", 503)
            return web.json_response(
                {
                    "mode": mode.value,
                    "enabled": True,
                    "authenticated": True,
                    "username": store.username,
                }
            )
        if store is None:
            return json_error("authentication is unavailable", 503)
        if device is None:
            return json_error("authentication required", 401)
        return web.json_response(
            {
                "mode": mode.value,
                "enabled": True,
                "authenticated": True,
                "username": store.username,
                "device": device.public_dict(current=True),
                "devices": [
                    item.public_dict(current=item.id == device.id)
                    for item in store.list_devices()
                ],
            }
        )

    async def account_page(request: web.Request) -> web.Response:
        mode = app[AUTH_MODE_KEY]
        store = auth_store()
        device = authenticated_device(request)
        if mode is AuthMode.BASIC:
            if store is None:
                raise web.HTTPServiceUnavailable()
            return auth_html_response(
                render_auth_mode_page(
                    prefix=prefix,
                    mode=mode.value,
                    username=store.username,
                )
            )
        if mode is AuthMode.NONE:
            return auth_html_response(
                render_auth_mode_page(prefix=prefix, mode=mode.value)
            )
        if store is None or device is None:
            raise web.HTTPNotFound()
        return auth_html_response(
            render_account_page(
                prefix=prefix,
                username=store.username,
                devices=store.list_devices(),
                current_id=device.id,
            )
        )

    async def revoke_auth_device(request: web.Request) -> web.StreamResponse:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            raise web.HTTPNotFound()
        store = auth_store()
        current = authenticated_device(request)
        if store is None or current is None:
            raise web.HTTPNotFound()
        device_id = request.match_info["device_id"]
        try:
            await asyncio.to_thread(store.revoke_device, device_id)
        except AuthPersistenceError:
            return web.Response(
                text="Unable to revoke the remembered browser because authentication storage is unavailable.",
                status=503,
            )
        if device_id == current.id:
            response = _see_other(f"{prefix}/login")
            _clear_auth_cookie(
                response,
                prefix=prefix,
                secure=app[AUTH_COOKIE_SECURE_KEY],
            )
            return response
        return _see_other(f"{prefix}/account")

    async def logout(request: web.Request) -> web.StreamResponse:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            raise web.HTTPNotFound()
        store = auth_store()
        current = authenticated_device(request)
        if store is None or current is None:
            raise web.HTTPNotFound()
        try:
            await asyncio.to_thread(store.revoke_device, current.id)
        except AuthPersistenceError:
            return json_error("authentication storage is unavailable", 503)
        response = _see_other(f"{prefix}/login")
        response.headers["Cache-Control"] = "no-store"
        _clear_auth_cookie(
            response,
            prefix=prefix,
            secure=app[AUTH_COOKIE_SECURE_KEY],
        )
        return response

    async def api_logout(request: web.Request) -> web.Response:
        if app[AUTH_MODE_KEY] is not AuthMode.SERVER:
            return json_error("server authentication is not enabled", 404)
        store = auth_store()
        current = authenticated_device(request)
        if store is None or current is None:
            return json_error("authentication required", 401)
        try:
            await asyncio.to_thread(store.revoke_device, current.id)
        except AuthPersistenceError:
            return json_error("authentication storage is unavailable", 503)
        response = web.json_response({"authenticated": False})
        response.headers["Cache-Control"] = "no-store"
        _clear_auth_cookie(
            response,
            prefix=prefix,
            secure=app[AUTH_COOKIE_SECURE_KEY],
        )
        return response

    async def health(_: web.Request) -> web.Response:
        try:
            sessions = await app[TMUX_KEY].list_sessions()
            return web.json_response({"ok": True, "sessions": len(sessions)})
        except TmuxError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=503)

    async def host_metrics_snapshot(request: web.Request) -> web.Response:
        unknown_fields = sorted(set(request.query) - {"range"})
        if unknown_fields:
            return json_error(f"unknown query field: {unknown_fields[0]}", 400)
        values = request.query.getall("range", [])
        if len(values) > 1:
            return json_error("range must appear at most once", 400)
        range_name = request.query.get("range", "15m")
        if range_name not in HOST_METRIC_RANGES:
            return json_error("range must be 15m, 1h, or 24h", 400)
        try:
            payload = await app[HOST_METRICS_KEY].collect_snapshot(range_name)
        except HostMetricsUnavailableError as error:
            return json_error(str(error), 503)
        return web.json_response(payload)

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
        unknown_fields = sorted(set(payload) - {"directory", "name", "theme"})
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

        requested_theme = payload.get("theme")
        if "theme" in payload:
            if not isinstance(requested_theme, str):
                return json_error("theme must be a string", 400)
            if requested_theme not in {"dark", "light"}:
                return json_error("theme must be dark or light", 400)

        requested_directory = payload.get("directory")
        if "directory" in payload:
            if not isinstance(requested_directory, str):
                return json_error("directory must be a string", 400)
            try:
                requested_directory = validate_tmux_start_directory(requested_directory)
            except ValueError as error:
                return json_error(str(error), 400)

        try:
            created_session = await app[TMUX_KEY].create_session(
                requested_name,
                theme=requested_theme,
                start_directory=requested_directory,
            )
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

    async def copy_session(request: web.Request) -> web.Response:
        source_name = request.match_info["session"]
        try:
            source_name = validate_tmux_session_name(source_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        unknown_fields = sorted(set(payload) - {"sessionId", "theme"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)
        if "sessionId" not in payload:
            return json_error("sessionId is required", 400)

        source_id = payload["sessionId"]
        if not isinstance(source_id, str):
            return json_error("sessionId must be a string", 400)
        try:
            source_id = validate_tmux_session_id(source_id)
        except ValueError as error:
            return json_error(str(error), 400)

        requested_theme = payload.get("theme")
        if "theme" in payload:
            if not isinstance(requested_theme, str):
                return json_error("theme must be a string", 400)
            if requested_theme not in {"dark", "light"}:
                return json_error("theme must be dark or light", 400)

        try:
            created_session = await app[TMUX_KEY].copy_session(
                source_name,
                source_id,
                theme=requested_theme,
            )
        except ValueError as error:
            return json_error(str(error), 400)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxSessionIdentityChangedError as error:
            return json_error(str(error), 409)
        except TmuxError as error:
            return json_error(str(error), 503)
        return web.json_response(
            {"session": created_session.name, "sessionId": created_session.id},
            status=201,
        )

    async def upload_session_attachment(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            session_name = validate_tmux_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        unknown_fields = sorted(set(request.query) - {"filename", "sessionId"})
        if unknown_fields:
            return json_error(f"unknown query field: {unknown_fields[0]}", 400)
        if "filename" not in request.query:
            return json_error("filename is required", 400)
        if "sessionId" not in request.query:
            return json_error("sessionId is required", 400)
        if (
            len(request.query.getall("filename")) != 1
            or len(request.query.getall("sessionId")) != 1
        ):
            return json_error("filename and sessionId must appear exactly once", 400)

        filename = request.query["filename"]
        session_id = request.query["sessionId"]
        try:
            session_id = validate_tmux_session_id(session_id)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            current_session = await app[TMUX_KEY].get_session(session_name)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        if current_session.id != session_id:
            return json_error(
                "tmux session identity changed; refresh before uploading a file",
                409,
            )

        if (
            request.content_length is not None
            and request.content_length > MAX_ATTACHMENT_UPLOAD_BYTES
        ):
            return json_error(
                f"attachment must be {MAX_ATTACHMENT_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller",
                413,
            )

        body = bytearray()
        async for chunk in request.content.iter_chunked(64 * 1024):
            if len(body) + len(chunk) > MAX_ATTACHMENT_UPLOAD_BYTES:
                return json_error(
                    f"attachment must be {MAX_ATTACHMENT_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller",
                    413,
                )
            body.extend(chunk)

        try:
            uploaded = await asyncio.to_thread(
                app[ATTACHMENTS_KEY].save,
                session_name,
                filename,
                bytes(body),
                request.headers.get("Content-Type"),
            )
        except ValueError as error:
            return json_error(str(error), 400)
        except AttachmentStorageFullError as error:
            return json_error(str(error), 507)
        except OSError:
            LOGGER.exception("Unable to store an uploaded attachment")
            return json_error("unable to store attachment", 503)
        return web.json_response(uploaded.to_dict(), status=201)

    async def session_file_context(
        request: web.Request,
        *,
        allowed_fields: frozenset[str] = frozenset(
            {"sessionId", "paneId", "path", "root"}
        ),
        required_fields: tuple[str, ...] = ("sessionId", "paneId"),
    ) -> tuple[str, str, str] | web.Response:
        session_name = request.match_info["session"]
        try:
            session_name = validate_tmux_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        unknown_fields = sorted(set(request.query) - allowed_fields)
        if unknown_fields:
            return json_error(f"unknown query field: {unknown_fields[0]}", 400)
        for required_field in required_fields:
            if required_field not in request.query:
                return json_error(f"{required_field} is required", 400)
        for field in allowed_fields:
            values = request.query.getall(field, [])
            if len(values) > 1:
                return json_error(f"{field} must appear at most once", 400)

        session_id = request.query["sessionId"]
        pane_id = request.query["paneId"]
        relative_path = request.query.get("path", "")
        try:
            session_id = validate_tmux_session_id(session_id)
            pane_id = validate_tmux_pane_id(pane_id)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            current_session = await app[TMUX_KEY].get_session(session_name)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        if current_session.id != session_id:
            return json_error(
                "tmux session identity changed; refresh before browsing files",
                409,
            )
        pane = next(
            (
                candidate
                for candidate in current_session.panes
                if candidate.id == pane_id
            ),
            None,
        )
        if pane is None:
            return json_error(
                "tmux pane identity changed; refresh before browsing files",
                409,
            )
        if not pane.path:
            return json_error("tmux pane has no working directory", 409)

        requested_root = request.query.get("root")
        if requested_root is None:
            return pane.path, relative_path, pane_id
        # An explicit root replaces the pane working directory, so the pane
        # identity above still proves the caller is looking at a live pane while
        # the configured boundary is what confines the request.
        try:
            resolved_root = await asyncio.to_thread(
                resolve_browse_root,
                requested_root,
                app[FILE_BROWSER_ROOT_KEY],
            )
        except FileBrowserPathOutsideRootError as error:
            return json_error(str(error), 403)
        except FileNotFoundError:
            return json_error("directory no longer exists", 404)
        except PermissionError:
            return json_error("directory is not accessible", 403)
        except (NotADirectoryError, TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError as error:
            if error.errno in {errno.ENAMETOOLONG, errno.ELOOP}:
                return json_error("path is too long or cannot be resolved", 400)
            LOGGER.exception("Unable to resolve a requested browse root")
            return json_error("unable to browse files", 500)
        return str(resolved_root), relative_path, pane_id

    async def execute_session_file_operation(
        root_path: str,
        relative_path: str,
        pane_id: str,
        operation: Callable[[str, str], object],
    ) -> object | web.Response:
        try:
            return await asyncio.to_thread(operation, root_path, relative_path)
        except FileBrowserDestinationExistsError as error:
            return json_error(str(error), 409)
        except FileBrowserDirectoryNotEmptyError as error:
            return json_error(str(error), 409)
        except FileBrowserPartialDeleteError as error:
            return json_error(str(error), 409)
        except FileBrowserConflictError as error:
            return json_error(str(error), 409)
        except FileBrowserUnsupportedFileError as error:
            return json_error(str(error), 415)
        except (
            FileBrowserImageTooLargeError,
            FileBrowserContentTooLargeError,
        ) as error:
            return json_error(str(error), 413)
        except FileBrowserUnsupportedImageError as error:
            return json_error(str(error), 415)
        except FileBrowserPathOutsideRootError as error:
            return json_error(str(error), 403)
        except FileNotFoundError:
            return json_error("file or directory no longer exists", 404)
        except PermissionError:
            return json_error("file or directory is not accessible", 403)
        except (IsADirectoryError, NotADirectoryError, TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError as error:
            # A relative path that fits our own limits can still push the
            # absolute path past PATH_MAX, or run into a symlink loop. Those are
            # bad requests, not server faults, and must not log a traceback
            # carrying the caller's multi-kilobyte path on every attempt.
            if error.errno in {errno.ENAMETOOLONG, errno.ELOOP}:
                return json_error("path is too long or cannot be resolved", 400)
            LOGGER.exception(
                "Unable to access pane-scoped files for pane %s",
                pane_id,
            )
            return json_error("unable to browse files", 500)

    async def session_file_request(
        request: web.Request,
        operation: Callable[[str, str], object],
        *,
        path_required: bool = False,
    ) -> web.Response:
        required_fields = (
            ("sessionId", "paneId", "path")
            if path_required
            else ("sessionId", "paneId")
        )
        context = await session_file_context(
            request,
            required_fields=required_fields,
        )
        if isinstance(context, web.Response):
            return context
        root_path, relative_path, pane_id = context
        payload = await execute_session_file_operation(
            root_path,
            relative_path,
            pane_id,
            operation,
        )
        if isinstance(payload, web.Response):
            return payload
        return web.json_response(payload)

    def within_boundary(
        operation: Callable[..., object],
    ) -> Callable[[str, str], object]:
        """Bind the configured boundary to a file-browser operation.

        Each operation re-checks the boundary against its own resolution of the
        root, so a directory swapped after validation cannot redirect the work.
        """
        boundary = app[FILE_BROWSER_ROOT_KEY]
        return lambda operation_root, operation_path: operation(
            operation_root,
            operation_path,
            boundary=boundary,
        )

    async def list_session_files(request: web.Request) -> web.Response:
        return await session_file_request(request, within_boundary(list_directory))

    async def resolve_session_file_target(request: web.Request) -> web.Response:
        context = await session_file_context(
            request,
            allowed_fields=frozenset({"sessionId", "paneId", "path"}),
            required_fields=("sessionId", "paneId", "path"),
        )
        if isinstance(context, web.Response):
            return context
        root_path, absolute_path, pane_id = context
        payload = await execute_session_file_operation(
            root_path,
            absolute_path,
            pane_id,
            lambda _operation_root, operation_path: resolve_browse_target(
                operation_path,
                app[FILE_BROWSER_ROOT_KEY],
            ),
        )
        if isinstance(payload, web.Response):
            return payload
        return web.json_response(payload)

    async def preview_session_file(request: web.Request) -> web.Response:
        return await session_file_request(
            request,
            within_boundary(preview_file),
            path_required=True,
        )

    async def download_session_file(request: web.Request) -> web.StreamResponse:
        context = await session_file_context(
            request,
            required_fields=("sessionId", "paneId", "path"),
        )
        if isinstance(context, web.Response):
            return context
        root_path, relative_path, pane_id = context
        result = await execute_session_file_operation(
            root_path,
            relative_path,
            pane_id,
            within_boundary(resolve_file_download),
        )
        if isinstance(result, web.Response):
            return result
        if not isinstance(result, FileBrowserDownload):
            raise TypeError("file download operation returned an invalid result")

        return web.FileResponse(
            result.path,
            headers={
                "Cache-Control": "private, no-store",
                "Content-Disposition": _file_content_disposition(
                    result.name,
                    "attachment",
                    fallback="download",
                ),
            },
        )

    async def preview_session_file_image(request: web.Request) -> web.StreamResponse:
        context = await session_file_context(
            request,
            required_fields=("sessionId", "paneId", "path"),
        )
        if isinstance(context, web.Response):
            return context
        root_path, relative_path, pane_id = context
        result = await execute_session_file_operation(
            root_path,
            relative_path,
            pane_id,
            within_boundary(resolve_file_image_preview),
        )
        if isinstance(result, web.Response):
            return result
        if not isinstance(result, FileBrowserImagePreview):
            raise TypeError("image preview operation returned an invalid result")

        return web.FileResponse(
            result.path,
            headers={
                "Cache-Control": "private, no-store",
                "Content-Disposition": _file_content_disposition(
                    result.name,
                    "inline",
                    fallback="image",
                ),
                "Content-Type": result.media_type,
                "Cross-Origin-Resource-Policy": "same-origin",
            },
        )

    async def upload_session_file(request: web.Request) -> web.Response:
        allowed_fields = frozenset(
            {"sessionId", "paneId", "path", "root", "filename"}
        )
        context = await session_file_context(
            request,
            allowed_fields=allowed_fields,
            required_fields=("sessionId", "paneId", "filename"),
        )
        if isinstance(context, web.Response):
            return context
        root_path, relative_path, pane_id = context
        if (
            request.content_length is not None
            and request.content_length > MAX_FILE_UPLOAD_BYTES
        ):
            return json_error(
                f"file must be {MAX_FILE_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller",
                413,
            )

        body = bytearray()
        async for chunk in request.content.iter_chunked(64 * 1024):
            if len(body) + len(chunk) > MAX_FILE_UPLOAD_BYTES:
                return json_error(
                    f"file must be {MAX_FILE_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller",
                    413,
                )
            body.extend(chunk)

        filename = request.query["filename"]
        result = await execute_session_file_operation(
            root_path,
            relative_path,
            pane_id,
            lambda operation_root, operation_path: upload_file(
                operation_root,
                operation_path,
                filename,
                bytes(body),
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
        )
        if isinstance(result, web.Response):
            return result
        return web.json_response(result, status=201)

    async def session_file_mutation_body(
        request: web.Request,
        allowed_fields: frozenset[str],
        required_fields: tuple[str, ...],
        *,
        max_body_bytes: int | None = None,
        oversize_error: str = "request body is too large",
    ) -> dict[str, object] | web.Response:
        try:
            if max_body_bytes is None:
                payload = await request.json()
            else:
                # aiohttp caps request.json() at the application-wide
                # client_max_size, which is smaller than a maximum-size edit
                # once JSON escaping is applied, so this body is read directly.
                body = bytearray()
                async for chunk in request.content.iter_chunked(64 * 1024):
                    if len(body) + len(chunk) > max_body_bytes:
                        return json_error(oversize_error, 413)
                    body.extend(chunk)
                payload = json.loads(bytes(body))
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        missing_fields = sorted(set(required_fields) - set(payload))
        if missing_fields:
            return json_error(f"{missing_fields[0]} is required", 400)
        unknown_fields = sorted(set(payload) - allowed_fields)
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)
        return payload

    async def run_session_file_mutation(
        request: web.Request,
        operation: Callable[[str, str], object],
        *,
        path_required: bool,
        status: int = 200,
    ) -> web.Response:
        required_fields = (
            ("sessionId", "paneId", "path")
            if path_required
            else ("sessionId", "paneId")
        )
        context = await session_file_context(
            request,
            required_fields=required_fields,
        )
        if isinstance(context, web.Response):
            return context
        root_path, relative_path, pane_id = context
        result = await execute_session_file_operation(
            root_path,
            relative_path,
            pane_id,
            operation,
        )
        if isinstance(result, web.Response):
            return result
        return web.json_response(result, status=status)

    async def create_session_file_entry(request: web.Request) -> web.Response:
        payload = await session_file_mutation_body(
            request,
            frozenset({"name", "kind"}),
            ("name",),
        )
        if isinstance(payload, web.Response):
            return payload
        name = payload["name"]
        kind = payload.get("kind", "directory")
        if not isinstance(name, str):
            return json_error("name must be a string", 400)
        if not isinstance(kind, str) or kind not in ENTRY_KINDS:
            return json_error("kind must be directory or file", 400)
        return await run_session_file_mutation(
            request,
            lambda operation_root, operation_path: create_entry(
                operation_root,
                operation_path,
                name,
                kind,
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
            path_required=False,
            status=201,
        )

    async def move_session_file_entry(request: web.Request) -> web.Response:
        payload = await session_file_mutation_body(
            request,
            frozenset({"destination"}),
            ("destination",),
        )
        if isinstance(payload, web.Response):
            return payload
        destination = payload["destination"]
        if not isinstance(destination, str):
            return json_error("destination must be a string", 400)
        return await run_session_file_mutation(
            request,
            lambda operation_root, operation_path: move_entry(
                operation_root,
                operation_path,
                destination,
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
            path_required=True,
        )

    async def copy_session_file_entry(request: web.Request) -> web.Response:
        payload = await session_file_mutation_body(
            request,
            frozenset({"destination"}),
            ("destination",),
        )
        if isinstance(payload, web.Response):
            return payload
        destination = payload["destination"]
        if not isinstance(destination, str):
            return json_error("destination must be a string", 400)
        return await run_session_file_mutation(
            request,
            lambda operation_root, operation_path: copy_entry(
                operation_root,
                operation_path,
                destination,
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
            path_required=True,
            status=201,
        )

    async def delete_session_file_entry(request: web.Request) -> web.Response:
        payload = await session_file_mutation_body(
            request,
            frozenset({"recursive"}),
            (),
        )
        if isinstance(payload, web.Response):
            return payload
        recursive = payload.get("recursive", False)
        if not isinstance(recursive, bool):
            return json_error("recursive must be a boolean", 400)
        return await run_session_file_mutation(
            request,
            lambda operation_root, operation_path: delete_entry(
                operation_root,
                operation_path,
                recursive=recursive,
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
            path_required=True,
        )

    async def save_session_file_content(request: web.Request) -> web.Response:
        oversize_error = (
            f"file must be {MAX_TEXT_WRITE_BYTES // (1024 * 1024)} MiB or smaller to save"
        )
        if (
            request.content_length is not None
            and request.content_length > MAX_TEXT_WRITE_BODY_BYTES
        ):
            return json_error(oversize_error, 413)
        payload = await session_file_mutation_body(
            request,
            frozenset({"content", "expectedModified"}),
            ("content",),
            max_body_bytes=MAX_TEXT_WRITE_BODY_BYTES,
            oversize_error=oversize_error,
        )
        if isinstance(payload, web.Response):
            return payload
        content = payload["content"]
        expected_modified = payload.get("expectedModified")
        if not isinstance(content, str):
            return json_error("content must be a string", 400)
        if expected_modified is not None and (
            isinstance(expected_modified, bool)
            or not isinstance(expected_modified, (int, float))
        ):
            return json_error("expectedModified must be a number", 400)
        if isinstance(expected_modified, float) and not math.isfinite(
            expected_modified
        ):
            return json_error("expectedModified must be a number", 400)
        return await run_session_file_mutation(
            request,
            lambda operation_root, operation_path: write_text_file(
                operation_root,
                operation_path,
                content,
                expected_modified=expected_modified,
                boundary=app[FILE_BROWSER_ROOT_KEY],
            ),
            path_required=True,
        )

    async def terminate_session(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            session_name = validate_tmux_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "sessionId" not in payload:
            return json_error("sessionId is required", 400)
        if "sessionCreated" not in payload:
            return json_error("sessionCreated is required", 400)
        if "serverStarted" not in payload:
            return json_error("serverStarted is required", 400)
        if "serverPid" not in payload:
            return json_error("serverPid is required", 400)
        unknown_fields = sorted(
            set(payload) - {"sessionId", "sessionCreated", "serverStarted", "serverPid"}
        )
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        session_id = payload["sessionId"]
        if not isinstance(session_id, str):
            return json_error("sessionId must be a string", 400)
        try:
            session_id = validate_tmux_session_id(session_id)
        except ValueError as error:
            return json_error(str(error), 400)

        session_created = payload["sessionCreated"]
        if (
            isinstance(session_created, bool)
            or not isinstance(session_created, int)
            or session_created <= 0
        ):
            return json_error("sessionCreated must be a positive integer", 400)

        server_started = payload["serverStarted"]
        if (
            isinstance(server_started, bool)
            or not isinstance(server_started, int)
            or server_started <= 0
        ):
            return json_error("serverStarted must be a positive integer", 400)

        server_pid = payload["serverPid"]
        if (
            isinstance(server_pid, bool)
            or not isinstance(server_pid, int)
            or server_pid <= 0
        ):
            return json_error("serverPid must be a positive integer", 400)

        async with app[SESSION_RENAME_LOCK_KEY]:
            try:
                current_sessions = await app[TMUX_KEY].list_sessions()
            except TmuxError as error:
                return json_error(str(error), 503)
            target = next(
                (
                    session
                    for session in current_sessions
                    if session.name == session_name
                ),
                None,
            )
            if target is None:
                target_was_renamed = any(
                    session.id == session_id
                    and session.created == session_created
                    and session.server_started == server_started
                    and session.server_pid == server_pid
                    for session in current_sessions
                )
                if target_was_renamed:
                    return json_error(
                        "tmux session identity changed; refresh before terminating it",
                        409,
                    )
                # Retrying a committed termination should preserve the successful
                # postcondition without risking a same-name replacement.
                return web.Response(status=204)
            if (
                target.id != session_id
                or target.created != session_created
                or target.server_started != server_started
                or target.server_pid != server_pid
            ):
                return json_error(
                    "tmux session identity changed; refresh before terminating it", 409
                )

            try:
                await app[TMUX_KEY].terminate_session(
                    session_id,
                    session_created,
                    server_started,
                    server_pid,
                )
            except ValueError as error:
                return json_error(str(error), 400)
            except TmuxSessionIdentityChangedError as error:
                return json_error(str(error), 409)
            except TmuxError as error:
                return json_error(str(error), 503)

        return web.Response(status=204)

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
                    "Unable to migrate workspace, session-link, and note state after "
                    "renaming "
                    "tmux session "
                    "%s to %s",
                    current_name,
                    renamed_session,
                )
                warnings.append(
                    "unable to migrate workspace, session-link, and note state"
                )

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
                if not await request_auth_still_valid(request):
                    with contextlib.suppress(ConnectionError, RuntimeError):
                        await response.write(
                            b'event: auth\ndata: {"authenticated":false}\n\n'
                        )
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
                        f"event: sessions\ndata: {serialized}\n\n".encode()
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

    async def update_session_workspace_pin(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing_fields = sorted({"session", "pinned"} - set(payload))
        if missing_fields:
            return json_error(f"{missing_fields[0]} is required", 400)
        unknown_fields = sorted(set(payload) - {"session", "pinned"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        session_name = payload["session"]
        pinned = payload["pinned"]
        if not isinstance(session_name, str):
            return json_error("session must be a string", 400)
        if not isinstance(pinned, bool):
            return json_error("pinned must be a boolean", 400)
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                result = app[WORKSPACES_KEY].set_session_workspace_pinned(
                    session_name,
                    pinned,
                )
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspacePinCapacityError as error:
            return json_error(str(error), 409)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except OSError:
            LOGGER.exception(
                "Unable to save global workspace pin for tmux session %s",
                session_name,
            )
            return json_error("unable to save session workspace pin", 500)
        return web.json_response(result)

    async def transfer_session_workspace(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        required = {
            "session",
            "destinationWorkspaceId",
            "operation",
            "sessionRevision",
        }
        missing = sorted(required - set(payload))
        if missing:
            return json_error(f"{missing[0]} is required", 400)
        allowed = required | {"sourceWorkspaceId"}
        unknown = sorted(str(field) for field in set(payload) - allowed)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        session_name = payload["session"]
        if not isinstance(session_name, str):
            return json_error("session must be a string", 400)
        source_workspace_id = payload.get("sourceWorkspaceId")
        if source_workspace_id is not None and not isinstance(source_workspace_id, str):
            return json_error("sourceWorkspaceId must be a string or null", 400)
        destination_workspace_id = payload["destinationWorkspaceId"]
        if not isinstance(destination_workspace_id, str):
            return json_error("destinationWorkspaceId must be a string", 400)
        operation = payload["operation"]
        if not isinstance(operation, str):
            return json_error("operation must be a string", 400)
        try:
            session_name = validate_session_name(session_name)
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                result = app[WORKSPACES_KEY].transfer_session(
                    session_name,
                    source_workspace_id=source_workspace_id,
                    destination_workspace_id=destination_workspace_id,
                    operation=operation,
                    session_revision=payload["sessionRevision"],
                )
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except (
            WorkspaceSessionRevisionConflict,
            WorkspaceTransferConflictError,
        ) as error:
            return json_error(str(error), 409)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to %s tmux session %s to workspace %s",
                operation,
                session_name,
                destination_workspace_id,
            )
            return json_error("unable to transfer session between workspaces", 500)
        return web.json_response(result)

    async def update_session_tags(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing_fields = sorted({"session", "tags"} - set(payload))
        if missing_fields:
            return json_error(f"{missing_fields[0]} is required", 400)
        unknown_fields = sorted(set(payload) - {"session", "tags"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        session_name = payload["session"]
        if not isinstance(session_name, str):
            return json_error("session must be a string", 400)
        try:
            session_name = validate_session_name(session_name)
            tags = normalize_tags(payload["tags"])
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                saved_tags = app[TITLES_KEY].set_tags(session_name, tags)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except OSError:
            LOGGER.exception("Unable to save tags for tmux session %s", session_name)
            return json_error("unable to save session tags", 500)
        return web.json_response({"session": session_name, "tags": saved_tags})

    async def update_session_details(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing_fields = sorted({"session", "title", "tags"} - set(payload))
        if missing_fields:
            return json_error(f"{missing_fields[0]} is required", 400)
        unknown_fields = sorted(set(payload) - {"session", "title", "tags"})
        if unknown_fields:
            return json_error(f"unknown field: {unknown_fields[0]}", 400)

        session_name = payload["session"]
        title = payload["title"]
        if not isinstance(session_name, str):
            return json_error("session must be a string", 400)
        if not isinstance(title, str):
            return json_error("title must be a string", 400)
        try:
            session_name = validate_session_name(session_name)
            normalize_title(title)
            tags = normalize_tags(payload["tags"])
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                saved_title, saved_tags = app[TITLES_KEY].set_details(
                    session_name, title, tags
                )
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except OSError:
            LOGGER.exception("Unable to save details for tmux session %s", session_name)
            return json_error("unable to save session details", 500)
        return web.json_response(
            {
                "session": session_name,
                "customTitle": saved_title,
                "tags": saved_tags,
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

    async def list_shortcuts(_: web.Request) -> web.Response:
        try:
            snapshot = app[SHORTCUTS_KEY].get_snapshot()
        except ShortcutStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response(snapshot)

    async def replace_shortcuts(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)

        missing = sorted({"revision", "bindings"} - set(payload))
        if missing:
            return json_error(f"{missing[0]} is required", 400)
        unknown = sorted(
            str(field) for field in set(payload) - {"revision", "bindings"}
        )
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        revision = payload["revision"]
        if isinstance(revision, bool) or not isinstance(revision, int):
            return json_error("revision must be an integer", 400)
        try:
            snapshot = app[SHORTCUTS_KEY].replace_bindings(
                payload["bindings"], expected_revision=revision
            )
        except ShortcutRevisionConflict as error:
            return web.json_response(
                {"error": str(error), "revision": error.current_revision},
                status=409,
            )
        except ShortcutStoreUnavailable as error:
            return json_error(str(error), 503)
        except ValueError as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save shortcut settings")
            return json_error("unable to save shortcuts", 500)
        return web.json_response(snapshot)

    async def list_workspaces(_: web.Request) -> web.Response:
        try:
            workspaces = app[WORKSPACES_KEY].list_workspaces()
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"workspaces": workspaces})

    async def list_common_workspace_quick_links(_: web.Request) -> web.Response:
        try:
            links = app[WORKSPACES_KEY].list_common_quick_links()
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"links": links})

    async def replace_common_workspace_quick_links(
        request: web.Request,
    ) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "links" not in payload:
            return json_error("links is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"links"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            links = app[WORKSPACES_KEY].replace_common_quick_links(payload["links"])
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save common workspace quick links")
            return json_error("unable to save workspace quick links", 500)
        return web.json_response({"links": links})

    async def get_common_note(_: web.Request) -> web.Response:
        try:
            note = app[WORKSPACES_KEY].get_common_note()
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"note": note})

    async def replace_common_note(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "note" not in payload:
            return json_error("note is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"note"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        try:
            note = app[WORKSPACES_KEY].replace_common_note(payload["note"])
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save common note")
            return json_error("unable to save common note", 500)
        return web.json_response({"note": note})

    async def get_session_quick_links(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                links = app[WORKSPACES_KEY].get_session_quick_links(session_name)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"links": links})

    async def replace_session_quick_links(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "links" not in payload:
            return json_error("links is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"links"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        try:
            session_name = validate_session_name(session_name)
            validate_workspace_quick_links(payload["links"], "links")
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                links = app[WORKSPACES_KEY].replace_session_quick_links(
                    session_name,
                    payload["links"],
                )
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to save quick links for tmux session %s",
                session_name,
            )
            return json_error("unable to save session quick links", 500)
        return web.json_response({"links": links})

    async def get_session_note(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            session_name = validate_session_name(session_name)
        except ValueError as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                note = app[WORKSPACES_KEY].get_session_note(session_name)
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        return web.json_response({"note": note})

    async def replace_session_note(request: web.Request) -> web.Response:
        session_name = request.match_info["session"]
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "note" not in payload:
            return json_error("note is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"note"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        try:
            session_name = validate_session_name(session_name)
            normalize_scoped_note(payload["note"])
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)

        try:
            async with app[SESSION_RENAME_LOCK_KEY]:
                await app[TMUX_KEY].get_session(session_name)
                note = app[WORKSPACES_KEY].replace_session_note(
                    session_name,
                    payload["note"],
                )
        except TmuxSessionNotFoundError as error:
            return json_error(str(error), 404)
        except TmuxError as error:
            return json_error(str(error), 503)
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save note for tmux session %s", session_name)
            return json_error("unable to save session note", 500)
        return web.json_response({"note": note})

    async def get_workspace_note(request: web.Request) -> web.Response:
        try:
            note = app[WORKSPACES_KEY].get_workspace_note(
                request.match_info["workspace_id"]
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        return web.json_response({"note": note})

    async def replace_workspace_note(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "note" not in payload:
            return json_error("note is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"note"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        try:
            note = app[WORKSPACES_KEY].replace_workspace_note(
                request.match_info["workspace_id"],
                payload["note"],
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception("Unable to save workspace note")
            return json_error("unable to save workspace note", 500)
        return web.json_response({"note": note})

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

    async def get_workspace_quick_links(request: web.Request) -> web.Response:
        try:
            links = app[WORKSPACES_KEY].get_workspace_quick_links(
                request.match_info["workspace_id"]
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except ValueError as error:
            return json_error(str(error), 400)
        return web.json_response({"links": links})

    async def replace_workspace_quick_links(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (ValueError, TypeError, RecursionError):
            return json_error("request body must be JSON", 400)
        if not isinstance(payload, dict):
            return json_error("request body must be an object", 400)
        if "links" not in payload:
            return json_error("links is required", 400)
        unknown = sorted(str(field) for field in set(payload) - {"links"})
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            links = app[WORKSPACES_KEY].replace_workspace_quick_links(
                request.match_info["workspace_id"],
                payload["links"],
            )
        except WorkspaceStoreUnavailable as error:
            return json_error(str(error), 503)
        except WorkspaceNotFoundError as error:
            return json_error(str(error), 404)
        except (TypeError, ValueError) as error:
            return json_error(str(error), 400)
        except OSError:
            LOGGER.exception(
                "Unable to save quick links for workspace %s",
                request.match_info["workspace_id"],
            )
            return json_error("unable to save workspace quick links", 500)
        return web.json_response({"links": links})

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
        allowed = required | {"groups"}
        unknown = sorted(str(field) for field in set(payload) - allowed)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            workspace = app[WORKSPACES_KEY].create_workspace(
                name=payload["name"],
                tabs=payload["tabs"],
                active_session=payload["activeSession"],
                groups=payload.get("groups", []),
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

        allowed = {"name", "tabs", "groups", "activeSession", "sessionRevision"}
        unknown = sorted(str(field) for field in set(payload) - allowed)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)
        if not set(payload) & {"name", "tabs", "groups", "activeSession"}:
            return json_error("name, tabs, groups, or activeSession is required", 400)
        if (
            set(payload) & {"tabs", "groups", "activeSession"}
            and "sessionRevision" not in payload
        ):
            return json_error("sessionRevision is required", 400)

        try:
            workspace = app[WORKSPACES_KEY].update_workspace(
                request.match_info["workspace_id"],
                name=payload.get("name"),
                tabs=payload.get("tabs"),
                groups=payload.get("groups"),
                active_session=payload.get("activeSession"),
                update_name="name" in payload,
                update_tabs="tabs" in payload,
                update_groups="groups" in payload,
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
        allowed = required | {"groups"}
        unknown = sorted(str(field) for field in set(payload) - allowed)
        if unknown:
            return json_error(f"unknown field: {unknown[0]}", 400)

        try:
            workspace = app[WORKSPACES_KEY].record_activity(
                request.match_info["workspace_id"],
                tabs=payload["tabs"],
                active_session=payload["activeSession"],
                session_revision=payload["sessionRevision"],
                groups=payload.get("groups"),
                update_groups="groups" in payload,
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

        async def close_when_auth_is_revoked() -> None:
            while not websocket.closed:
                await asyncio.sleep(1)
                if not await request_auth_still_valid(request):
                    await websocket.close(
                        code=4003,
                        message=b"Remembered browser access was revoked",
                    )
                    return

        sender = asyncio.create_task(send_output())
        auth_monitor = (
            asyncio.create_task(close_when_auth_is_revoked())
            if auth_store() is not None
            else None
        )
        try:
            async for message in websocket:
                if not await request_auth_still_valid(request):
                    await websocket.close(
                        code=4003,
                        message=b"Remembered browser access was revoked",
                    )
                    break
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
            try:
                if auth_monitor is not None:
                    auth_monitor.cancel()
                    await asyncio.gather(auth_monitor, return_exceptions=True)
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

    app.router.add_get(f"{prefix}/login", login_page)
    app.router.add_post(f"{prefix}/login", login_form)
    app.router.add_post(f"{prefix}/api/auth/login", api_login)
    app.router.add_get(f"{prefix}/api/auth/session", auth_session)
    app.router.add_post(f"{prefix}/api/auth/logout", api_logout)
    app.router.add_get(f"{prefix}/account", account_page)
    app.router.add_post(
        f"{prefix}/account/devices/{{device_id}}/revoke",
        revoke_auth_device,
    )
    app.router.add_post(f"{prefix}/logout", logout)
    # aiohttp's default dynamic-segment pattern excludes literal braces, even
    # though they are valid tmux session-name characters. Keep the segment
    # slash-bounded while accepting every name allowed by our validators.
    session_segment = "{session:[^/]+}"

    app.router.add_get(f"{prefix}/api/health", health)
    app.router.add_get(f"{prefix}/api/host-metrics", host_metrics_snapshot)
    app.router.add_get(f"{prefix}/api/sessions", sessions)
    app.router.add_post(f"{prefix}/api/sessions", create_session)
    app.router.add_post(f"{prefix}/api/sessions/{session_segment}/copy", copy_session)
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/attachments",
        upload_session_attachment,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/images",
        upload_session_attachment,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/files",
        list_session_files,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/files/resolve",
        resolve_session_file_target,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/files/preview",
        preview_session_file,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/files/image",
        preview_session_file_image,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/files/download",
        download_session_file,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/files/upload",
        upload_session_file,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/files/create",
        create_session_file_entry,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/files/move",
        move_session_file_entry,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/files/copy",
        copy_session_file_entry,
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/files/delete",
        delete_session_file_entry,
    )
    app.router.add_put(
        f"{prefix}/api/sessions/{session_segment}/files/content",
        save_session_file_content,
    )
    app.router.add_delete(f"{prefix}/api/sessions/{session_segment}", terminate_session)
    app.router.add_put(f"{prefix}/api/session-name", rename_session)
    app.router.add_get(f"{prefix}/api/sessions/stream", sessions_stream)
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/messages", list_session_messages
    )
    app.router.add_post(
        f"{prefix}/api/sessions/{session_segment}/messages", add_session_message
    )
    app.router.add_patch(
        f"{prefix}/api/sessions/{session_segment}/messages/{{message_id}}",
        update_session_message,
    )
    app.router.add_delete(
        f"{prefix}/api/sessions/{session_segment}/messages/{{message_id}}",
        delete_session_message,
    )
    app.router.add_get(f"{prefix}/api/snippets", list_snippets)
    app.router.add_put(f"{prefix}/api/snippets", replace_snippets)
    app.router.add_get(f"{prefix}/api/shortcuts", list_shortcuts)
    app.router.add_put(f"{prefix}/api/shortcuts", replace_shortcuts)
    app.router.add_get(
        f"{prefix}/api/workspace-quick-links",
        list_common_workspace_quick_links,
    )
    app.router.add_put(
        f"{prefix}/api/workspace-quick-links",
        replace_common_workspace_quick_links,
    )
    app.router.add_get(f"{prefix}/api/common-note", get_common_note)
    app.router.add_put(f"{prefix}/api/common-note", replace_common_note)
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/quick-links",
        get_session_quick_links,
    )
    app.router.add_put(
        f"{prefix}/api/sessions/{session_segment}/quick-links",
        replace_session_quick_links,
    )
    app.router.add_get(
        f"{prefix}/api/sessions/{session_segment}/note",
        get_session_note,
    )
    app.router.add_put(
        f"{prefix}/api/sessions/{session_segment}/note",
        replace_session_note,
    )
    app.router.add_get(f"{prefix}/api/workspaces", list_workspaces)
    app.router.add_post(f"{prefix}/api/workspaces", create_workspace)
    app.router.add_get(
        f"{prefix}/api/workspaces/{{workspace_id}}/quick-links",
        get_workspace_quick_links,
    )
    app.router.add_put(
        f"{prefix}/api/workspaces/{{workspace_id}}/quick-links",
        replace_workspace_quick_links,
    )
    app.router.add_get(
        f"{prefix}/api/workspaces/{{workspace_id}}/note",
        get_workspace_note,
    )
    app.router.add_put(
        f"{prefix}/api/workspaces/{{workspace_id}}/note",
        replace_workspace_note,
    )
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
    app.router.add_put(
        f"{prefix}/api/session-workspace-pin",
        update_session_workspace_pin,
    )
    app.router.add_post(
        f"{prefix}/api/session-workspace-transfer",
        transfer_session_workspace,
    )
    app.router.add_put(f"{prefix}/api/session-tags", update_session_tags)
    app.router.add_put(f"{prefix}/api/session-details", update_session_details)
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
