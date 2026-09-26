from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import pwd
import re
import secrets
import shlex
import stat
import unicodedata
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

# tmux escapes this control byte as the literal text ``\037`` in format output.
FORMAT_FIELD_SEPARATOR = "\x1f"
OUTPUT_FIELD_SEPARATOR = r"\037"
PANE_FORMAT_FIELDS = (
    "pid",
    "start_time",
    "session_name",
    "session_id",
    "session_windows",
    "session_attached",
    "session_created",
    "window_index",
    "window_name",
    "window_active",
    "window_activity",
    "pane_index",
    "pane_id",
    "pane_active",
    "pane_current_command",
    "pane_current_path",
    "pane_title",
    "pane_width",
    "pane_height",
    "history_size",
    "history_limit",
    "alternate_on",
    "pane_dead",
    "pane_pid",
)
PANE_FORMAT = FORMAT_FIELD_SEPARATOR.join(f"#{{{name}}}" for name in PANE_FORMAT_FIELDS)
CREATED_SESSION_FORMAT = "#{session_name}\t#{session_id}"
CLIENT_IDENTITY_FORMAT = "#{client_pid}\t#{client_name}\t#{session_id}"
MAX_SESSION_NAME_LENGTH = 256
TMUX_SESSION_ID_PATTERN = re.compile(r"^\$\d+$")
TMUX_PANE_ID_PATTERN = re.compile(r"^%\d+$")
TERMINATE_IDENTITY_MISMATCH = "MUXDECK_SESSION_IDENTITY_CHANGED"
TERMINAL_HISTORY_ACTIONS = frozenset(
    {"page-up", "page-down", "line-up", "line-down", "exit"}
)
APPLICATION_SCROLL_DIRECTIONS = frozenset({"up", "down"})
APPLICATION_SCROLL_PROFILES = frozenset({"wheel", "alt-wheel", "claude"})
CLAUDE_SCROLL_SETTLE_SECONDS = 0.22
HISTORY_USER_KEY_PATTERN = re.compile(r"\bUser(\d{1,3})\b")
HISTORY_USER_OPTION_PATTERN = re.compile(r"^user-keys\[(\d{1,3})\]")
CLIENT_ATTACH_RETRY_ATTEMPTS = 20
CLIENT_ATTACH_RETRY_DELAY = 0.01
NEW_SESSION_USAGE_MARKER = "usage: new-session"
TMUX_CONNECTION_ERROR_MARKERS = (
    "no server running",
    "failed to connect",
    "error connecting",
)

LOGGER = logging.getLogger("muxdeck")


def _application_scroll_signature(screen: str) -> tuple[str, ...]:
    lines = screen.splitlines()
    # Ignore Claude's header and composer/status area. Narrow/short panes have
    # less chrome, so retain their body instead of discarding all visible rows.
    end = len(lines) - 8 if len(lines) > 10 else max(2, len(lines) - 1)
    return tuple(lines[1:end] or lines)


class TmuxError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


class TmuxSessionNotFoundError(TmuxError):
    pass


class TmuxRenameUnverifiedError(TmuxError):
    def __init__(self, requested_name: str, verification_error: TmuxError):
        super().__init__("tmux rename succeeded but its result could not be verified")
        self.requested_name = requested_name
        self.verification_error = verification_error


class TmuxSessionIdentityChangedError(TmuxError):
    pass


@dataclass(frozen=True)
class CreatedSession:
    name: str
    id: str
    directory: str | None = field(default=None, compare=False)


def validate_tmux_session_name(value: str) -> str:
    if not value.strip():
        raise ValueError("session name is required")
    if len(value) > MAX_SESSION_NAME_LENGTH:
        raise ValueError(
            f"session name must be {MAX_SESSION_NAME_LENGTH} characters or fewer"
        )
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise ValueError("session name cannot contain control characters")
    if "\u2028" in value or "\u2029" in value:
        raise ValueError("session name cannot contain Unicode line separators")
    if "\\" in value:
        # tmux doubles backslashes in format output, breaking exact inventory names.
        raise ValueError("session name cannot contain '\\'")
    if ":" in value or "." in value:
        raise ValueError("session name cannot contain ':' or '.'")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("session name contains invalid Unicode")
    return value


def validate_tmux_new_session_name(value: str) -> str:
    value = validate_tmux_session_name(value)
    if value.endswith(";"):
        # tmux parses a final semicolon as a command separator even with exec argv.
        raise ValueError("session name cannot end with ';'")
    return value


def validate_tmux_start_directory(value: str) -> str:
    if not value:
        raise ValueError("working directory is required")
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise ValueError("working directory cannot contain control characters")
    if "\u2028" in value or "\u2029" in value:
        raise ValueError("working directory cannot contain Unicode line separators")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("working directory contains invalid Unicode")

    directory = Path(value)
    if not directory.is_absolute():
        raise ValueError("working directory must be an absolute path")
    try:
        directory_mode = directory.stat().st_mode
    except FileNotFoundError as error:
        raise ValueError("working directory does not exist") from error
    except OSError as error:
        raise ValueError("working directory is not accessible") from error
    if not stat.S_ISDIR(directory_mode):
        raise ValueError("working directory is not a directory")
    return value


def validate_tmux_session_id(value: str) -> str:
    if not TMUX_SESSION_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid tmux session id")
    return value


def validate_tmux_pane_id(value: str) -> str:
    if not TMUX_PANE_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid tmux pane id")
    return value


def _escape_tmux_format(value: str) -> str:
    # tmux expands formats and shell substitutions in command arguments.
    return value.replace("#", "##")


@dataclass(frozen=True)
class Pane:
    id: str
    index: int
    window_index: int
    window_name: str
    window_active: bool
    active: bool
    command: str
    path: str
    title: str
    width: int
    height: int
    history_size: int
    history_limit: int
    alternate_on: bool
    dead: bool
    activity: int
    process_pid: int = 0

    def to_dict(self) -> dict:
        # The pane process is only used for bounded local agent-reference
        # discovery; it is not part of the browser-facing terminal inventory.
        record = asdict(self)
        record.pop("process_pid", None)
        return record


@dataclass
class Session:
    name: str
    id: str
    windows: int
    attached: int
    created: int
    server_started: int = 0
    server_pid: int = 0
    activity: int = 0
    panes: list[Pane] = field(default_factory=list)

    @property
    def active_pane(self) -> Pane | None:
        for pane in self.panes:
            if pane.window_active and pane.active:
                return pane
        for pane in self.panes:
            if pane.active:
                return pane
        return self.panes[0] if self.panes else None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "id": self.id,
            "windows": self.windows,
            "attached": self.attached,
            "created": self.created,
            "serverStarted": self.server_started,
            "serverPid": self.server_pid,
            "activity": self.activity,
            "activePaneId": self.active_pane.id if self.active_pane else None,
            "panes": [pane.to_dict() for pane in self.panes],
        }


@dataclass(frozen=True)
class HistoryCapture:
    pane: Pane
    lines: list[str]


def _as_int(value: str, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_sessions(output: str) -> list[Session]:
    sessions: dict[str, Session] = {}

    for raw_line in output.splitlines():
        if not raw_line:
            continue
        values = raw_line.split(OUTPUT_FIELD_SEPARATOR)
        if len(values) != len(PANE_FORMAT_FIELDS):
            continue
        row = dict(zip(PANE_FORMAT_FIELDS, values, strict=True))
        name = row["session_name"]
        session = sessions.get(name)
        if session is None:
            session = Session(
                name=name,
                id=row["session_id"],
                windows=_as_int(row["session_windows"]),
                attached=_as_int(row["session_attached"]),
                created=_as_int(row["session_created"]),
                server_started=_as_int(row["start_time"]),
                server_pid=_as_int(row["pid"]),
            )
            sessions[name] = session

        pane = Pane(
            id=row["pane_id"],
            index=_as_int(row["pane_index"]),
            window_index=_as_int(row["window_index"]),
            window_name=row["window_name"],
            window_active=row["window_active"] == "1",
            active=row["pane_active"] == "1",
            command=row["pane_current_command"],
            path=row["pane_current_path"],
            title=row["pane_title"],
            width=_as_int(row["pane_width"]),
            height=_as_int(row["pane_height"]),
            history_size=_as_int(row["history_size"]),
            history_limit=_as_int(row["history_limit"]),
            alternate_on=row["alternate_on"] == "1",
            dead=row["pane_dead"] == "1",
            activity=_as_int(row["window_activity"]),
            process_pid=_as_int(row["pane_pid"]),
        )
        session.panes.append(pane)
        session.activity = max(session.activity, pane.activity)

    return sorted(
        sessions.values(), key=lambda item: (-item.activity, item.name.lower())
    )


class TmuxClient:
    def __init__(
        self,
        binary: str | None = None,
        timeout: float = 5.0,
        socket_name: str | None = None,
    ):
        self.binary: str = binary or os.environ.get("TMUX_BIN") or "tmux"
        self.timeout = timeout
        self.socket_name = (
            socket_name
            if socket_name is not None
            else os.environ.get("MUXDECK_TMUX_SOCKET")
        )
        self._history_dispatch_lock = asyncio.Lock()
        self._capability_probe_lock = asyncio.Lock()
        self._session_creation_lock = asyncio.Lock()
        self._new_session_environment_supported: bool | None = None

    @property
    def command_prefix(self) -> list[str]:
        if self.socket_name:
            return [self.binary, "-L", self.socket_name]
        return [self.binary]

    async def run(self, args: Sequence[str]) -> str:
        return await self._run_command([*self.command_prefix, *args])

    async def _run_binary(self, args: Sequence[str]) -> str:
        return await self._run_command([self.binary, *args])

    async def _run_command(self, command: Sequence[str]) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise TmuxError(f"Unable to start tmux: {error}") from error

        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), self.timeout)
        except TimeoutError as error:
            process.kill()
            await process.wait()
            raise TmuxError("tmux command timed out") from error

        if process.returncode != 0:
            message = stderr.decode("utf-8", "replace").strip() or "tmux command failed"
            raise TmuxError(message, process.returncode)
        return stdout.decode("utf-8", "replace")

    async def list_sessions(self) -> list[Session]:
        try:
            output = await self.run(["list-panes", "-a", "-F", PANE_FORMAT])
        except TmuxError as error:
            message = str(error).lower()
            if any(
                marker in message
                for marker in (
                    "no server running",
                    "failed to connect",
                    "error connecting",
                )
            ):
                return []
            raise
        return parse_sessions(output)

    async def create_session(
        self,
        requested_name: str | None = None,
        theme: str | None = None,
        *,
        start_directory: str | None = None,
    ) -> CreatedSession:
        directory = (
            validate_tmux_start_directory(start_directory)
            if start_directory is not None
            else None
        )
        async with self._session_creation_lock:
            return await self._create_session(
                requested_name,
                theme=theme,
                start_directory=directory,
            )

    async def utility_session(
        self, workspace_key: str, source_name: str, source_id: str, *, create: bool
    ) -> Session | None:
        if not re.fullmatch(r"(?:workspace:[A-Za-z0-9_-]{1,80}|temporary:[a-f0-9-]{36}|session:\$[0-9]+:[0-9]+:[0-9]+:[0-9]+)", workspace_key):
            raise ValueError("invalid utility terminal workspace key")
        marker = hashlib.sha256(workspace_key.encode()).hexdigest()
        async with self._session_creation_lock:
            sessions = await self.list_sessions()
            source = next((session for session in sessions if session.name == source_name), None)
            if workspace_key.startswith("session:"):
                if source is None:
                    raise TmuxSessionNotFoundError("source session is no longer available")
                identity = f"session:{source.id}:{source.created}:{source.server_started}:{source.server_pid}"
                if source.id != source_id or identity != workspace_key:
                    raise TmuxSessionIdentityChangedError("source session identity changed")
            if sessions:
                output = await self.run([
                    "list-sessions", "-F", "#{session_id}\t#{@muxdeck-utility-workspace}",
                ])
                ids = {
                    row.split("\t", 1)[0]
                    for row in output.splitlines()
                    if row.endswith(f"\t{marker}")
                }
                existing = next((session for session in sessions if session.id in ids), None)
                if existing is not None:
                    return existing
            if not create:
                return None
            source = next((session for session in sessions if session.name == source_name), None)
            if source is None:
                raise TmuxSessionNotFoundError("source session is no longer available")
            if source.id != source_id:
                raise TmuxSessionIdentityChangedError("source session identity changed")
            if source.active_pane is None:
                raise TmuxError("source session has no active pane")
            directory = validate_tmux_start_directory(source.active_pane.path)
            # Explicitly launch a shell, even when tmux's default-command starts an agent.
            shell = (await self.run(["show-options", "-gv", "default-shell"])).strip()
            if not shell or not os.path.isabs(shell):
                raise TmuxError("tmux default-shell is not an absolute executable path")
            name = f"muxdeck-terminal-{secrets.token_hex(6)}"
            await self.run([
                "new-session", "-d", "-s", name, "-c", _escape_tmux_format(directory),
                shlex.quote(shell),
                ";", "set-option", "-t", name,
                "@muxdeck-utility-workspace", marker,
                ";", "set-option", "-t", name,
                "@muxdeck-utility-owner", workspace_key,
            ])
            return await self.get_session(name)

    async def release_utility_workspace(self, key: str, *, destination: str | None = None) -> None:
        if not re.fullmatch(r"temporary:[a-f0-9-]{36}", key):
            raise ValueError("only temporary workspace terminals can be released or transferred")
        if destination is not None and not re.fullmatch(r"workspace:[A-Za-z0-9_-]{1,80}", destination):
            raise ValueError("destination must be a saved workspace")
        async with self._session_creation_lock:
            owned = await self._owned_utility_sessions()
            if destination is not None and any(owner == destination for _, owner in owned) and any(owner == key for _, owner in owned):
                raise TmuxError("destination already has a utility shell; temporary shell was kept")
            for session, owner in owned:
                if owner != key:
                    continue
                if destination is not None:
                    await self.run([
                        "set-option", "-t", session.id, "@muxdeck-utility-owner", destination,
                        ";", "set-option", "-t", session.id, "@muxdeck-utility-workspace",
                        hashlib.sha256(destination.encode()).hexdigest(),
                    ])
                else:
                    await self.terminate_session(
                        session_id=session.id, session_created=session.created,
                        server_started=session.server_started, server_pid=session.server_pid,
                    )

    async def _owned_utility_sessions(self) -> list[tuple[Session, str]]:
        sessions = await self.list_sessions()
        if not sessions:
            return []
        output = await self.run(["list-sessions", "-F", "#{session_id}\t#{@muxdeck-utility-owner}"])
        owners = dict(row.split("\t", 1) for row in output.splitlines() if "\t" in row)
        return [(session, owners[session.id]) for session in sessions if owners.get(session.id)]

    async def cleanup_utility_sessions(self, workspace_ids: set[str]) -> None:
        # Only explicitly owned utility shells are eligible; never infer ownership by name.
        async with self._session_creation_lock:
            owned = await self._owned_utility_sessions()
            if not owned:
                return
            sessions = await self.list_sessions()
            identities = {
                f"session:{s.id}:{s.created}:{s.server_started}:{s.server_pid}"
                for s in sessions
            }
            for session, owner in owned:
                orphan = (owner.startswith("session:") and owner not in identities) or (
                    owner.startswith("workspace:") and owner.removeprefix("workspace:") not in workspace_ids
                )
                if orphan:
                    await self.terminate_session(
                        session_id=session.id, session_created=session.created,
                        server_started=session.server_started, server_pid=session.server_pid,
                    )

    async def copy_session(
        self,
        source_name: str,
        source_id: str,
        theme: str | None = None,
    ) -> CreatedSession:
        source_name = validate_tmux_session_name(source_name)
        source_id = validate_tmux_session_id(source_id)
        if theme is not None and theme not in {"dark", "light"}:
            raise ValueError("theme must be dark or light")

        async with self._session_creation_lock:
            sessions = await self.list_sessions()
            source = next(
                (session for session in sessions if session.name == source_name),
                None,
            )
            if source is None:
                raise TmuxSessionNotFoundError(
                    f"tmux session not found: {source_name}"
                )
            if source.id != source_id:
                raise TmuxSessionIdentityChangedError(
                    "tmux session identity changed; refresh before copying it"
                )
            if source.active_pane is None or not source.active_pane.path:
                raise TmuxError("tmux session has no active pane working directory")

            existing_names = {session.name for session in sessions}
            increment = 1
            while True:
                candidate = f"{source_name}_{increment}"
                if len(candidate) > MAX_SESSION_NAME_LENGTH:
                    raise ValueError(
                        "source session name is too long to create a numbered copy"
                    )
                if candidate in existing_names:
                    increment += 1
                    continue

                try:
                    return await self._create_session(
                        candidate,
                        theme=theme,
                        start_directory=source.active_pane.path,
                    )
                except TmuxError as error:
                    if "duplicate session" not in str(error).lower():
                        raise
                    # A session may be created outside Muxdeck after the inventory read.
                    existing_names.add(candidate)
                    increment += 1

    async def create_shell_session(self, name: str, directory: str) -> CreatedSession:
        directory = validate_tmux_start_directory(directory)
        async with self._session_creation_lock:
            return await self._create_session(name, start_directory=directory, shell_only=True)

    async def _create_session(
        self,
        requested_name: str | None = None,
        theme: str | None = None,
        *,
        start_directory: str | None = None,
        shell_only: bool = False,
    ) -> CreatedSession:
        requested_name = (
            f"muxdeck-{secrets.token_hex(6)}"
            if requested_name is None
            else validate_tmux_new_session_name(requested_name)
        )
        grok_appearance = None
        if theme is not None:
            if theme not in {"dark", "light"}:
                raise ValueError("theme must be dark or light")
            grok_appearance = theme

        args = [
            "new-session",
            "-d",
            "-P",
            "-F",
            CREATED_SESSION_FORMAT,
            "-s",
            _escape_tmux_format(requested_name),
        ]
        if (
            grok_appearance is not None
            and await self._supports_new_session_environment()
        ):
            args.extend(
                [
                    "-e",
                    "GROK_THEME=auto",
                    "-e",
                    f"GROK_APPEARANCE={grok_appearance}",
                ]
            )
        elif grok_appearance is not None:
            LOGGER.warning(
                "tmux new-session -e is unavailable or could not be detected; "
                "creating %r without a Grok appearance hint",
                requested_name,
            )
        directory = start_directory if start_directory is not None else str(Path.home())
        args.extend(["-c", _escape_tmux_format(directory)])
        if shell_only:
            try:
                shell = (await self.run(["show-options", "-gv", "default-shell"])).strip()
            except TmuxError as error:
                if not any(marker in str(error).lower() for marker in ("no server running", "error connecting", "failed to connect")):
                    raise
                shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
            if not shell or not os.path.isabs(shell):
                raise TmuxError("tmux default-shell is not an absolute executable path")
            args.append(shlex.quote(shell))
        output = await self.run(args)
        # Tabs and line separators are invalid in names, so this preserves spaces.
        rows = output.splitlines()
        fields = rows[0].split("\t") if len(rows) == 1 else []
        if len(fields) != 2 or not fields[0]:
            raise TmuxError("tmux did not return the created session name")
        actual_name, session_id = fields
        if actual_name != requested_name:
            raise TmuxError("tmux returned an unexpected created session name")
        if not session_id.startswith("$") or not session_id[1:].isdigit():
            raise TmuxError("tmux did not return the created session id")
        return CreatedSession(name=requested_name, id=session_id, directory=directory)

    async def _supports_new_session_environment(self) -> bool:
        if self._new_session_environment_supported is not None:
            return self._new_session_environment_supported

        async with self._capability_probe_lock:
            if self._new_session_environment_supported is not None:
                return self._new_session_environment_supported
            try:
                usage = await self._probe_command_usage(
                    "new-session", NEW_SESSION_USAGE_MARKER
                )
            except TmuxError:
                self._new_session_environment_supported = False
            else:
                self._new_session_environment_supported = bool(
                    re.search(r"\[-e\s+environment\]", usage)
                )
        return self._new_session_environment_supported

    async def _probe_command_usage(self, command: str, usage_marker: str) -> str:
        try:
            usage = await self.run([command, "-?"])
        except TmuxError as error:
            usage = str(error)
        if (
            usage_marker not in usage.lower()
            and self.socket_name is not None
            and any(
                marker in usage.lower()
                for marker in TMUX_CONNECTION_ERROR_MARKERS
            )
        ):
            # An explicit -L socket is consulted before tmux prints command usage.
            # Capabilities belong to the binary, so retry without selecting a server.
            try:
                usage = await self._run_binary([command, "-?"])
            except TmuxError as error:
                usage = str(error)
        if usage_marker not in usage.lower():
            raise TmuxError(f"tmux did not report {command} capabilities")
        return usage

    async def terminate_session(
        self,
        session_id: str,
        session_created: int,
        server_started: int,
        server_pid: int,
    ) -> None:
        session_id = validate_tmux_session_id(session_id)
        if (
            isinstance(session_created, bool)
            or not isinstance(session_created, int)
            or session_created <= 0
        ):
            raise ValueError("session_created must be a positive integer")
        if (
            isinstance(server_started, bool)
            or not isinstance(server_started, int)
            or server_started <= 0
        ):
            raise ValueError("server_started must be a positive integer")
        if (
            isinstance(server_pid, bool)
            or not isinstance(server_pid, int)
            or server_pid <= 0
        ):
            raise ValueError("server_pid must be a positive integer")

        identity_condition = (
            f"#{{&&:#{{==:#{{session_created}},{session_created}}},"
            f"#{{&&:#{{==:#{{start_time}},{server_started}}},"
            f"#{{==:#{{pid}},{server_pid}}}}}}}"
        )
        try:
            output = await self.run(
                [
                    "if-shell",
                    "-F",
                    "-t",
                    session_id,
                    identity_condition,
                    f"kill-session -t {session_id}",
                    f"display-message -p {TERMINATE_IDENTITY_MISMATCH}",
                ]
            )
            if output.strip() == TERMINATE_IDENTITY_MISMATCH:
                raise TmuxSessionIdentityChangedError(
                    "tmux session identity changed; refresh before terminating it"
                )
        except TmuxSessionIdentityChangedError:
            raise
        except TmuxError as error:
            kill_error = error
        else:
            return

        # A timed-out client may still have committed the kill server-side.
        try:
            sessions = await self.list_sessions()
        except TmuxError:
            sessions = None
        if sessions is None or any(
            session.id == session_id
            and session.created == session_created
            and session.server_started == server_started
            and session.server_pid == server_pid
            for session in sessions
        ):
            raise kill_error

    async def rename_session(
        self,
        current_name: str,
        new_name: str,
        *,
        session_id: str | None = None,
    ) -> str:
        current_name = validate_tmux_session_name(current_name)
        new_name = validate_tmux_new_session_name(new_name)
        if current_name == new_name:
            raise ValueError("new session name must differ from current session name")
        if session_id is None:
            session_id = (await self.get_session(current_name)).id
        session_id = validate_tmux_session_id(session_id)

        try:
            await self.run(
                [
                    "rename-session",
                    "-t",
                    session_id,
                    "--",
                    _escape_tmux_format(new_name),
                ]
            )
        except TmuxError:
            # A timed-out client can still leave the tmux server-side rename committed.
            try:
                actual_name = await self._session_name_by_id(session_id)
            except TmuxError:
                pass
            else:
                if actual_name != current_name:
                    return actual_name
            raise

        try:
            actual_name = await self._session_name_by_id(session_id)
        except TmuxError as error:
            raise TmuxRenameUnverifiedError(new_name, error) from error
        if actual_name == current_name:
            raise TmuxError("tmux did not apply the requested session rename")
        return actual_name

    async def _session_name_by_id(self, session_id: str) -> str:
        for session in await self.list_sessions():
            if session.id == session_id:
                return session.name
        raise TmuxError(f"tmux session not found after rename: {session_id}")

    async def get_session(self, name: str) -> Session:
        for session in await self.list_sessions():
            if session.name == name:
                return session
        raise TmuxSessionNotFoundError(f"tmux session not found: {name}")

    async def navigate_history(
        self,
        client_pid: int,
        session_id: str,
        action: str,
    ) -> str:
        if (
            isinstance(client_pid, bool)
            or not isinstance(client_pid, int)
            or client_pid <= 0
        ):
            raise ValueError("invalid tmux client pid")
        session_id = validate_tmux_session_id(session_id)
        if not isinstance(action, str) or action not in TERMINAL_HISTORY_ACTIONS:
            raise ValueError("invalid terminal history action")

        async with self._history_dispatch_lock:
            return await self._navigate_history(client_pid, session_id, action)

    async def _navigate_history(
        self,
        client_pid: int,
        session_id: str,
        action: str,
    ) -> str:
        commands = {
            "page-up": "copy-mode -u",
            "page-down": "send-keys -X page-down",
            # Entering without -u preserves the position when already in copy
            # mode and avoids an initial page jump. Mode commands bypass user
            # bindings and never send arrows to the running application.
            "line-up": "copy-mode ; send-keys -X scroll-up",
            "line-down": "send-keys -X scroll-down",
            "exit": "send-keys -X cancel",
        }
        if action in {"page-up", "line-up"}:
            mode_condition = "#{||:#{==:#{pane_mode},},#{==:#{pane_mode},copy-mode}}"
        else:
            mode_condition = "#{==:#{pane_mode},copy-mode}"
        return await self._dispatch_client_command(
            client_pid,
            session_id,
            commands[action],
            mode_condition,
            rejection_message="tmux client rejected the terminal history action",
        )

    async def navigate_application_scroll(
        self,
        client_pid: int,
        session_id: str,
        direction: str,
        profile: str = "wheel",
    ) -> str:
        if (
            isinstance(client_pid, bool)
            or not isinstance(client_pid, int)
            or client_pid <= 0
        ):
            raise ValueError("invalid tmux client pid")
        session_id = validate_tmux_session_id(session_id)
        if (
            not isinstance(direction, str)
            or direction not in APPLICATION_SCROLL_DIRECTIONS
        ):
            raise ValueError("invalid application scroll direction")
        if not isinstance(profile, str) or profile not in APPLICATION_SCROLL_PROFILES:
            raise ValueError("invalid application scroll profile")

        button = (64 if direction == "up" else 65) + (
            8 if profile == "alt-wheel" else 0
        )
        buffer_name = f"muxdeck-scroll-{secrets.token_hex(12)}"
        # Copilot reserves its left columns for a sidebar. Aim inside the main
        # body, using this client's actual pane geometry at dispatch time.
        column = "#{?#{>:#{pane_width},1},#{e|-:#{pane_width},1},1}"
        row = "#{?#{>:#{pane_height},1},#{e|/:#{pane_height},2},1}"
        set_buffer_command = (
            f'set-buffer -b {buffer_name} "\\033[<{button};{column};{row}M"'
        )
        cancel_copy_mode = (
            'if-shell -F "#{==:#{pane_mode},copy-mode}" "send-keys -X cancel"'
        )
        wheel_commands = (
            # -C runs tmux commands, without a shell. It expands the numeric
            # coordinates in the guarded client's command context.
            f"run-shell -C {shlex.quote(set_buffer_command)} ; "
            # Raw paste bypasses synchronize-panes and custom mouse bindings.
            # No -p: these are terminal input bytes, not bracketed-paste text.
            # Named buffers leave existing buffers and the clipboard intact.
            f"paste-buffer -r -d -b {buffer_name}"
        )
        allowed_mode = "#{||:#{==:#{pane_mode},},#{==:#{pane_mode},copy-mode}}"
        mouse_enabled = "#{&&:#{mouse_any_flag},#{mouse_sgr_flag}}"
        input_enabled = "#{&&:#{==:#{pane_dead},0},#{==:#{pane_input_off},0}}"
        condition = f"#{{&&:{allowed_mode},#{{&&:{mouse_enabled},{input_enabled}}}}}"
        rejection_message = (
            "Application scrolling is unavailable: the active pane must "
            "have SGR mouse reporting enabled and accept input."
        )
        capture_buffer = f"{buffer_name}-before" if profile == "claude" else None
        commands = f"{cancel_copy_mode} ; "
        if capture_buffer is not None:
            commands += f"capture-pane -b {capture_buffer} ; "
        commands += wheel_commands
        async with self._history_dispatch_lock:
            try:
                if profile == "claude":
                    # Let an immediately preceding PageUp/PageDown or resize
                    # finish painting before measuring this wheel event. Its
                    # delayed repaint must not hide a dropped direction change.
                    await asyncio.sleep(CLAUDE_SCROLL_SETTLE_SECONDS)
                pane_id = await self._dispatch_client_command(
                    client_pid,
                    session_id,
                    commands,
                    condition,
                    rejection_message=rejection_message,
                    cleanup_buffer=buffer_name,
                )
                if capture_buffer is None:
                    return pane_id

                # Claude ignores the first wheel packet after some direction
                # changes. Wait beyond its acceleration window, and retry once
                # only when the transcript body has not changed. Captures stay
                # in memory and this private buffer; they are never persisted.
                before = await self.run(["show-buffer", "-b", capture_buffer])
                await asyncio.sleep(CLAUDE_SCROLL_SETTLE_SECONDS)
                after = await self.run(["capture-pane", "-p", "-t", pane_id])
                if _application_scroll_signature(
                    before
                ) == _application_scroll_signature(after):
                    same_pane = f"#{{==:#{{pane_id}},{pane_id}}}"
                    await self._dispatch_client_command(
                        client_pid,
                        session_id,
                        f"{cancel_copy_mode} ; {wheel_commands}",
                        f"#{{&&:{condition},{same_pane}}}",
                        rejection_message=(
                            "Application scroll retry cancelled: the active pane "
                            "or its input mode changed."
                        ),
                        cleanup_buffer=buffer_name,
                    )
                    await asyncio.sleep(CLAUDE_SCROLL_SETTLE_SECONDS)
                return pane_id
            finally:
                if capture_buffer is not None:
                    with contextlib.suppress(TmuxError):
                        await self.run(["delete-buffer", "-b", capture_buffer])

    async def _dispatch_client_command(
        self,
        client_pid: int,
        session_id: str,
        command: str,
        mode_condition: str,
        *,
        rejection_message: str,
        cleanup_buffer: str | None = None,
    ) -> str:
        matching_rows: list[list[str]] = []
        for attempt in range(CLIENT_ATTACH_RETRY_ATTEMPTS):
            output = await self.run(["list-clients", "-F", CLIENT_IDENTITY_FORMAT])
            matching_rows = []
            for row in output.splitlines():
                fields = row.split("\t")
                if len(fields) == 3 and fields[0] == str(client_pid):
                    matching_rows.append(fields)
            if matching_rows:
                break
            if attempt + 1 < CLIENT_ATTACH_RETRY_ATTEMPTS:
                await asyncio.sleep(CLIENT_ATTACH_RETRY_DELAY)
        if len(matching_rows) != 1 or matching_rows[0][2] != session_id:
            raise TmuxError("tmux client is not attached to the expected session")

        client_name = matching_rows[0][1]
        key_bindings = await self.run(["list-keys", "-a"])
        user_keys = await self.run(["show-options", "-s", "user-keys"])
        guarded_tables = {"copy-mode", "copy-mode-vi", "prefix", "root"}
        for line in key_bindings.splitlines():
            try:
                fields = shlex.split(line)
            except ValueError:
                continue
            if "-T" in fields:
                table_index = fields.index("-T") + 1
                if table_index < len(fields):
                    guarded_tables.add(fields[table_index])
        reserved_user_keys = {
            int(match) for match in HISTORY_USER_KEY_PATTERN.findall(key_bindings)
        }
        for line in user_keys.splitlines():
            match = HISTORY_USER_OPTION_PATTERN.match(line)
            if match is not None:
                reserved_user_keys.add(int(match.group(1)))
        dispatch_key = next(
            (
                f"User{index}"
                for index in range(999, -1, -1)
                if index not in reserved_user_keys
            ),
            None,
        )
        if dispatch_key is None:
            raise TmuxError("tmux has no unused user key for terminal history")

        token = secrets.token_hex(12)
        table_name = f"muxdeck-history-{token}"
        result_option = f"@muxdeck-history-{token}"
        wait_channel = f"muxdeck-history-{token}"

        identity_condition = (
            "#{&&:"
            f"#{{==:#{{client_pid}},{client_pid}}},"
            f"#{{==:#{{session_id}},{session_id}}}"
            "}"
        )
        dispatch_condition = f"#{{&&:{identity_condition},{mode_condition}}}"
        success_commands = (
            f"{command} ; "
            f"set-option -gF {result_option} "
            "'ok:#{client_pid}:#{session_id}:#{pane_id}' ; "
            f"wait-for -S {wait_channel}"
        )
        rejected_commands = (
            f"set-option -gF {result_option} "
            "'rejected:#{client_pid}:#{session_id}:#{pane_id}' ; "
            f"wait-for -S {wait_channel}"
        )

        installed_guards: list[str] = []
        try:
            for guarded_table in sorted(guarded_tables):
                # A timed-out tmux client may have committed the binding server-side.
                installed_guards.append(guarded_table)
                await self.run(
                    [
                        "bind-key",
                        "-T",
                        guarded_table,
                        dispatch_key,
                        rejected_commands,
                    ]
                )
            await self.run(
                [
                    "bind-key",
                    "-T",
                    table_name,
                    dispatch_key,
                    "if-shell",
                    "-F",
                    dispatch_condition,
                    success_commands,
                    rejected_commands,
                ]
            )
            await self.run(
                [
                    "bind-key",
                    "-T",
                    table_name,
                    "Any",
                    f"send-keys ; switch-client -T {table_name}",
                ]
            )
            # -K makes tmux dispatch the private binding in this exact client's
            # command context, where active-pane resolves its independent pane.
            await self.run(
                [
                    "switch-client",
                    "-c",
                    client_name,
                    "-T",
                    table_name,
                    ";",
                    "send-keys",
                    "-K",
                    "-c",
                    client_name,
                    dispatch_key,
                    ";",
                    "wait-for",
                    wait_channel,
                ]
            )
            result = await self.run(["show-options", "-gv", result_option])
        finally:
            with contextlib.suppress(TmuxError):
                await self.run(["unbind-key", "-a", "-T", table_name])
            for guarded_table in reversed(installed_guards):
                with contextlib.suppress(TmuxError):
                    await self.run(["unbind-key", "-T", guarded_table, dispatch_key])
            with contextlib.suppress(TmuxError):
                await self.run(["set-option", "-gu", result_option])
            if cleanup_buffer is not None:
                with contextlib.suppress(TmuxError):
                    await self.run(["delete-buffer", "-b", cleanup_buffer])

        rows = result.splitlines()
        fields = rows[0].split(":") if len(rows) == 1 else []
        if (
            len(fields) != 4
            or fields[0] != "ok"
            or fields[1] != str(client_pid)
            or fields[2] != session_id
        ):
            raise TmuxError(rejection_message)
        pane_id = fields[3]
        if not pane_id.startswith("%") or not pane_id[1:].isdigit():
            raise TmuxError("tmux did not return the attached client pane")
        return pane_id

    async def get_pane(self, pane_id: str) -> Pane:
        if not pane_id.startswith("%") or not pane_id[1:].isdigit():
            raise TmuxError("invalid tmux pane id")
        for session in await self.list_sessions():
            for pane in session.panes:
                if pane.id == pane_id:
                    return pane
        raise TmuxError(f"tmux pane not found: {pane_id}")

    async def capture_visible(self, pane_id: str) -> str:
        if not pane_id.startswith("%") or not pane_id[1:].isdigit():
            raise TmuxError("invalid tmux pane id")
        return await self.run(["capture-pane", "-p", "-J", "-t", pane_id])

    async def capture_history(self, pane_id: str) -> HistoryCapture:
        pane = await self.get_pane(pane_id)
        start = f"-{max(0, pane.history_size)}"
        output = await self.run(
            ["capture-pane", "-p", "-J", "-t", pane.id, "-S", start]
        )
        lines = output.splitlines()
        while lines and not lines[-1].strip():
            lines.pop()
        return HistoryCapture(pane=pane, lines=lines)
