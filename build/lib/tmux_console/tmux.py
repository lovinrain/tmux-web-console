from __future__ import annotations

import asyncio
import os
from dataclasses import asdict, dataclass, field
from typing import Sequence


# tmux escapes this control byte as the literal text ``\037`` in format output.
FORMAT_FIELD_SEPARATOR = "\x1f"
OUTPUT_FIELD_SEPARATOR = r"\037"
PANE_FORMAT_FIELDS = (
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


class TmuxError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


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

    return sorted(sessions.values(), key=lambda item: (-item.activity, item.name.lower()))


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
            socket_name if socket_name is not None else os.environ.get("MUXDECK_TMUX_SOCKET")
        )

    @property
    def command_prefix(self) -> list[str]:
        if self.socket_name:
            return [self.binary, "-L", self.socket_name]
        return [self.binary]

    async def run(self, args: Sequence[str]) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command_prefix,
                *args,
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
                for marker in ("no server running", "failed to connect", "error connecting")
            ):
                return []
            raise
        return parse_sessions(output)

    async def get_session(self, name: str) -> Session:
        for session in await self.list_sessions():
            if session.name == name:
                return session
        raise TmuxError(f"tmux session not found: {name}")

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
