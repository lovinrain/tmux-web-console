from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import secrets
import shlex
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
)
PANE_FORMAT = FORMAT_FIELD_SEPARATOR.join(f"#{{{name}}}" for name in PANE_FORMAT_FIELDS)
CREATED_SESSION_FORMAT = "#{session_name}\t#{session_id}"
CLIENT_IDENTITY_FORMAT = "#{client_pid}\t#{client_name}\t#{session_id}"
MAX_SESSION_NAME_LENGTH = 256
TMUX_SESSION_ID_PATTERN = re.compile(r"^\$\d+$")
TERMINATE_IDENTITY_MISMATCH = "MUXDECK_SESSION_IDENTITY_CHANGED"
TERMINAL_HISTORY_ACTIONS = frozenset({"page-up", "page-down", "exit"})
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


class TmuxError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


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


def validate_tmux_session_id(value: str) -> str:
    if not TMUX_SESSION_ID_PATTERN.fullmatch(value):
        raise ValueError("invalid tmux session id")
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

    def to_dict(self) -> dict:
        return asdict(self)


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
        self, requested_name: str | None = None, theme: str | None = None
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
        args.extend(["-c", str(Path.home())])
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
        return CreatedSession(name=requested_name, id=session_id)

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
        raise TmuxError(f"tmux session not found: {name}")

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
        commands = {
            "page-up": "copy-mode -u",
            "page-down": "send-keys -X page-down",
            "exit": "send-keys -X cancel",
        }
        if action == "page-up":
            mode_condition = "#{||:#{==:#{pane_mode},},#{==:#{pane_mode},copy-mode}}"
        else:
            mode_condition = "#{==:#{pane_mode},copy-mode}"
        dispatch_condition = f"#{{&&:{identity_condition},{mode_condition}}}"
        success_commands = (
            f"{commands[action]} ; "
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

        rows = result.splitlines()
        fields = rows[0].split(":") if len(rows) == 1 else []
        if (
            len(fields) != 4
            or fields[0] != "ok"
            or fields[1] != str(client_pid)
            or fields[2] != session_id
        ):
            raise TmuxError("tmux client rejected the terminal history action")
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
