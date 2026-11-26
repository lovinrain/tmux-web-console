from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import stat
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime
from itertools import islice
from pathlib import Path
from typing import BinaryIO

from .agent_sources import (
    EXTENDED_TRANSCRIPT_AGENTS,
    UUID_PATTERN as UUID_PATTERN,
    default_extended_transcript_roots,
    normalize_agent_session_id,
)
from .opencode_sessions import opencode_session_for_pane
from .pi_sessions import locate_pi_session, read_pi_session_header
from .status import AgentType, classify_agent_type
from .tmux import Pane, Session, TmuxClient, TmuxError

MAX_DESCENDANT_PROCESSES = 48
MAX_PROCESS_DEPTH = 8
MAX_AGENT_PROCESSES = 6
MAX_FDS_PER_PROCESS = 256
MAX_TRANSCRIPT_HEADER_LINES = 12
MAX_TRANSCRIPT_CANDIDATES = 64
# Tolerate a little skew between the recorded start time and the first entry.
TRANSCRIPT_START_TOLERANCE_SECONDS = 60.0
_NATIVE_SESSION_FLAGS = {
    "pi": {"--session", "--session-id"},
    "omp": {"--resume", "--session", "-r"},
    "opencode": {"--session", "-s"},
    "agy": {"--conversation", "--resume", "-r"},
}
_OPENCODE_EXECUTABLE = re.compile(r"opencode(?:2|\.v[0-9]+(?:\.[0-9]+)*)?")


def default_claude_projects_root() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects"


def _claude_project_slug(directory: str) -> str:
    """Claude names each project directory after the cwd, with every separator
    and underscore replaced by a dash."""
    return re.sub(r"[/_]", "-", directory)


def _boot_time(proc_root: Path) -> int | None:
    for line in _read_bytes(proc_root / "stat", 64 * 1024).split(b"\n"):
        if line.startswith(b"btime"):
            try:
                return int(line.split()[1])
            except (ValueError, IndexError):
                return None
    return None


def _process_start_ticks(proc_root: Path, process_id: int) -> int | None:
    raw = _read_bytes(proc_root / str(process_id) / "stat", 8 * 1024)
    if not raw:
        return None
    text = raw.decode("utf-8", "replace")
    try:
        # comm can contain spaces and parentheses; fields follow the last ')'.
        return int(text[text.rindex(")") + 2:].split()[19])
    except (ValueError, IndexError):
        return None


def _process_start_time(proc_root: Path, process_id: int) -> float | None:
    start_ticks = _process_start_ticks(proc_root, process_id)
    if start_ticks is None:
        return None
    boot = _boot_time(proc_root)
    if boot is None:
        return None
    ticks_per_second = os.sysconf("SC_CLK_TCK") or 100
    return boot + start_ticks / ticks_per_second


def _claude_registered_session(process_id: int, proc_root: Path, projects_root: Path) -> str | None:
    """Recent Claude versions publish the exact current conversation per PID.

    Validate the process start ticks so a stale registration cannot attach a
    reused PID to another conversation. This also follows in-app /resume.
    """
    try:
        record = json.loads(_read_bytes(projects_root.parent / "sessions" / f"{process_id}.json"))
    except (ValueError, RecursionError):
        return None
    if not isinstance(record, dict) or record.get("pid") != process_id:
        return None
    ticks = _process_start_ticks(proc_root, process_id)
    if ticks is None or record.get("procStart") != str(ticks):
        return None
    identifier = record.get("sessionId")
    return identifier.lower() if isinstance(identifier, str) and UUID_PATTERN.fullmatch(identifier) else None


def _parse_transcript_timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


def _claude_transcript_header(path: Path) -> tuple[str, str, float | None] | None:
    """Read (session id, cwd, first timestamp) from a transcript's opening lines."""
    session_id: str | None = None
    directory = ""
    timestamp: float | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as source:
            for _ in range(MAX_TRANSCRIPT_HEADER_LINES):
                line = source.readline()
                if not line:
                    break
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                if session_id is None and isinstance(record.get("sessionId"), str):
                    session_id = record["sessionId"]
                if not directory and isinstance(record.get("cwd"), str):
                    directory = record["cwd"]
                if timestamp is None:
                    timestamp = _parse_transcript_timestamp(record.get("timestamp"))
                if session_id and directory and timestamp is not None:
                    break
    except OSError:
        return None
    if session_id is None or not UUID_PATTERN.fullmatch(session_id):
        return None
    return session_id, directory, timestamp


def _claude_session_from_transcripts(
    pane: Pane,
    process_id: int,
    proc_root: Path,
    projects_root: Path,
) -> str | None:
    """Claude appends to its transcript and closes it, so the open-descriptor
    scan almost never sees one. Identify the conversation from the transcript
    itself instead: the file records its own cwd, and the entry that starts it
    lands just after the agent process does. Directories are routinely shared by
    many conversations, so the start time is what disambiguates them."""
    directory = projects_root / _claude_project_slug(pane.path)
    try:
        transcripts = sorted(
            directory.glob("*.jsonl"),
            key=lambda candidate: candidate.stat().st_mtime,
            reverse=True,
        )[:MAX_TRANSCRIPT_CANDIDATES]
    except OSError:
        return None
    if not transcripts:
        return None

    started = _process_start_time(proc_root, process_id)
    newest: tuple[float, str] | None = None
    started_with_process: tuple[float, str] | None = None
    still_being_written: tuple[float, str] | None = None
    for candidate in transcripts:
        header = _claude_transcript_header(candidate)
        if header is None:
            continue
        session_id, recorded_directory, timestamp = header
        if recorded_directory and pane.path and recorded_directory != pane.path:
            continue
        try:
            modified = candidate.stat().st_mtime
        except OSError:
            continue
        if newest is None or modified > newest[0]:
            newest = (modified, session_id)
        if started is None:
            continue
        # A conversation opened just after the process began is that process's
        # own, which is what separates concurrent agents sharing a directory.
        if timestamp is not None:
            delta = timestamp - started
            if delta >= -TRANSCRIPT_START_TOLERANCE_SECONDS and (
                started_with_process is None or delta < started_with_process[0]
            ):
                started_with_process = (delta, session_id)
        # A continued conversation predates its process - resuming does not
        # always put an id in argv - but a live agent keeps appending to it,
        # while abandoned conversations go stale.
        if modified >= started - TRANSCRIPT_START_TOLERANCE_SECONDS and (
            still_being_written is None or modified > still_being_written[0]
        ):
            still_being_written = (modified, session_id)

    if started_with_process is not None:
        return started_with_process[1]
    if still_being_written is not None:
        return still_being_written[1]
    # Without a start time there is nothing to disambiguate with; the most
    # recently written conversation for this directory is the best available.
    return newest[1] if started is None and newest is not None else None


@dataclass(frozen=True)
class AgentReference:
    agent_type: AgentType | None
    session_id: str | None


@dataclass(frozen=True)
class _CachedReference:
    signature: tuple[int, str, str, AgentType | None]
    expires_at: float
    reference: AgentReference


def _read_bytes(path: Path, limit: int = 64 * 1024) -> bytes:
    try:
        with path.open("rb") as source:
            return source.read(limit)
    except OSError:
        return b""


def _process_children(proc_root: Path, process_id: int) -> list[int]:
    raw = _read_bytes(
        proc_root / str(process_id) / "task" / str(process_id) / "children",
        16 * 1024,
    )
    children: list[int] = []
    for value in raw.split():
        try:
            child = int(value)
        except ValueError:
            continue
        if child > 0:
            children.append(child)
    return children[:MAX_DESCENDANT_PROCESSES]


def _bounded_process_tree(proc_root: Path, root_pid: int) -> list[int]:
    if root_pid <= 0:
        return []
    found: list[int] = []
    queued: list[tuple[int, int]] = [(root_pid, 0)]
    seen: set[int] = set()
    while queued and len(found) < MAX_DESCENDANT_PROCESSES:
        process_id, depth = queued.pop(0)
        if process_id in seen:
            continue
        seen.add(process_id)
        found.append(process_id)
        if depth >= MAX_PROCESS_DEPTH:
            continue
        queued.extend(
            (child, depth + 1)
            for child in _process_children(proc_root, process_id)
            if child not in seen
        )
    return found


def _process_arguments(proc_root: Path, process_id: int) -> list[str]:
    raw = _read_bytes(proc_root / str(process_id) / "cmdline")
    return [
        value.decode("utf-8", "replace")
        for value in raw.split(b"\0")
        if value
    ]


def _looks_like_agent_process(arguments: list[str], agent_type: AgentType) -> bool:
    if not arguments:
        return False
    if agent_type in EXTENDED_TRANSCRIPT_AGENTS:
        executable = Path(arguments[0]).name
        if agent_type == "opencode":
            return _OPENCODE_EXECUTABLE.fullmatch(executable) is not None
        if executable == agent_type:
            return True
        return (
            agent_type in {"pi", "omp"} and executable in {"node", "nodejs", "bun"}
            and len(arguments) > 1 and (
                Path(arguments[1]).name == agent_type
                or agent_type == "pi" and "pi-coding-agent" in arguments[1]
            )
        )
    normalized = " ".join(arguments).casefold()
    executable = Path(arguments[0]).name.casefold()
    if agent_type == "cursor":
        return executable in {"agent", "cursor-agent"} or "cursor-agent" in normalized
    if agent_type == "copilot":
        return executable == "copilot" or any(
            marker in normalized
            for marker in (
                "github copilot",
                "@github/copilot",
                "/copilot",
                "copilot-cli",
            )
        )
    return executable == agent_type or f"/{agent_type}" in normalized


def _uuid_from_explicit_arguments(arguments: list[str]) -> str | None:
    for index, argument in enumerate(arguments):
        candidate: str | None = None
        if argument in {"resume", "--resume", "--session-id", "--conversation-id"}:
            if index + 1 < len(arguments):
                candidate = arguments[index + 1]
        elif any(
            argument.startswith(f"{option}=")
            for option in ("--resume", "--session-id", "--conversation-id")
        ):
            candidate = argument.split("=", 1)[1]
        if candidate is not None:
            match = UUID_PATTERN.fullmatch(candidate)
            if match:
                return match.group(1).lower()
    return None


def _is_process_launcher(proc_root: Path, process_id: int) -> bool:
    """argv[0] can say 'codex' while Volta is still launching Node and the CLI."""
    try:
        executable = Path(os.readlink(proc_root / str(process_id) / "exe")).name.removesuffix(" (deleted)")
    except OSError:
        return False
    return executable in {"volta-shim", "node", "nodejs", "bash", "sh", "zsh", "env", "python", "python3"} or executable.startswith("python3.")


def _path_matches_agent(path: str, agent_type: AgentType) -> bool:
    normalized = path.casefold()
    basename = Path(path).name.casefold()
    if agent_type == "codex":
        return basename.startswith("rollout-") and basename.endswith(".jsonl")
    if agent_type == "cursor":
        return basename == "store.db" and "cursor" in normalized
    if agent_type == "grok":
        return basename == "events.jsonl" and "grok" in normalized
    if agent_type == "claude":
        return basename.endswith(".jsonl") and "/.claude/projects/" in normalized
    if agent_type == "copilot":
        return (
            UUID_PATTERN.search(path) is not None
            and "copilot" in normalized
            and basename.endswith((".json", ".jsonl", ".db"))
        )
    return False


def _open_descriptor_paths(proc_root: Path, process_id: int) -> Iterator[tuple[Path, str]]:
    try:
        with os.scandir(proc_root / str(process_id) / "fd") as entries:
            for descriptor in islice(entries, MAX_FDS_PER_PROCESS):
                try:
                    yield Path(descriptor.path), os.readlink(descriptor.path)
                except OSError:
                    continue
    except OSError:
        return


def _open_reference_paths(
    proc_root: Path,
    process_id: int,
    agent_type: AgentType,
) -> list[tuple[int, str, str]]:
    matches: list[tuple[int, str, str]] = []
    held_matches: list[tuple[int, str, str]] = []
    for descriptor, target in _open_descriptor_paths(proc_root, process_id):
        if agent_type == "copilot":
            path = Path(target)
            identifier = path.parent.name
            # Copilot closes events.jsonl between writes but holds this file open.
            if (
                path.name == f"inuse.{process_id}.hold"
                and path.parent.parent.name == "session-state"
                and UUID_PATTERN.fullmatch(identifier)
            ):
                held_matches.append((0, target, identifier.lower()))
                continue
        if not _path_matches_agent(target, agent_type):
            continue
        if agent_type == "codex":
            # In-process Codex workers can keep newer rollouts open in the same
            # process. Their explicit source marker must not replace the CLI chat.
            try:
                header = json.loads(_read_bytes(descriptor).split(b"\n", 1)[0])
                payload = header.get("payload", {}) if isinstance(header, dict) else {}
                source = payload.get("source") if isinstance(payload, dict) else None
                if (isinstance(source, dict) and "subagent" in source
                        or isinstance(source, str) and source.startswith("subagent")):
                    continue
            except (ValueError, RecursionError):
                pass
        identifiers = UUID_PATTERN.findall(target)
        if not identifiers:
            continue
        try:
            modified_ns = descriptor.stat().st_mtime_ns
        except OSError:
            modified_ns = 0
        matches.append((modified_ns, target, identifiers[-1].lower()))
    return held_matches or matches


def _option_values(arguments: list[str], options: set[str]) -> Iterator[tuple[str, str]]:
    for index, value in enumerate(arguments):
        if value == "--":
            break
        option, assigned, argument = value.partition("=")
        if option in options:
            if assigned:
                yield option, argument
            elif index + 1 < len(arguments) and not arguments[index + 1].startswith("-"):
                yield option, arguments[index + 1]


def _confined_native_file(root: Path, target: Path) -> Path | None:
    if not target.is_absolute():
        return None
    resolved = root.resolve()
    for base in (resolved, root.absolute()):
        if target.is_relative_to(base):
            path = resolved / target.relative_to(base)
            if path.resolve(strict=True) == path and path.is_file():
                return path
            break
    return None


def _open_regular_file(path: Path) -> BinaryIO:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("native session data must be a regular file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _journal_reference(
    agent: str, root: Path, target: Path, *, directory: str | None = None,
) -> str | None:
    if target.suffix != ".jsonl":
        return None
    try:
        path = _confined_native_file(root, target)
        if path is None or len(path.relative_to(root.resolve()).parts) > 2:
            return None
        with _open_regular_file(path) as source:
            record = read_pi_session_header(source, allow_title=agent == "omp")
    except (OSError, RuntimeError):
        return None
    if record is None:
        return None
    if directory is not None and record.get("cwd") != directory:
        return None
    return normalize_agent_session_id(agent, record.get("id"))


def _explicit_native_session(
    arguments: list[str], agent: str, directory: str, root: Path | None,
) -> str | None:
    identifiers: set[str] = set()
    for option, value in _option_values(arguments[1:], _NATIVE_SESSION_FLAGS[agent]):
        identifier = normalize_agent_session_id(agent, value)
        if agent in {"pi", "omp"} and root is not None and option != "--session-id":
            if "/" in value or value.endswith(".jsonl"):
                path = Path(directory) / value
                identifier = _journal_reference(agent, root, path)
            elif identifier is not None and not UUID_PATTERN.fullmatch(identifier):
                # --session accepts ID prefixes. Require an exact native header
                # for a custom ID, while --session-id itself is always exact.
                try:
                    candidate_path = locate_pi_session(root, identifier)
                except OSError:
                    candidate_path = None
                if candidate_path is None or _journal_reference(agent, root, candidate_path.absolute()) != identifier:
                    identifier = None
        if identifier is not None:
            identifiers.add(identifier)
    return next(iter(identifiers)) if len(identifiers) == 1 else None


def _omp_tty_session(proc_root: Path, process_id: int, root: Path, directory: str) -> str | None:
    terminal = proc_root / str(process_id) / "fd" / "0"
    try:
        tty = re.fullmatch(r"/dev/pts/([0-9]+)", os.readlink(terminal))
        started = _process_start_time(proc_root, process_id)
        if tty is None or started is None:
            return None
        marker = _confined_native_file(root.parent, root.absolute().parent / "terminal-sessions" / f"pts-{tty[1]}")
        if marker is None:
            return None
        with _open_regular_file(marker) as source:
            written = os.fstat(source.fileno()).st_mtime
            if written < started:
                return None
            # The devpts inode is recreated on allocation of a reused TTY.
            try:
                terminal_info = terminal.stat()
            except FileNotFoundError:
                terminal_info = None
            if terminal_info is not None and stat.S_ISCHR(terminal_info.st_mode) and written < terminal_info.st_ctime:
                return None
            data = source.read(8193)
            if len(data) > 8192:
                return None
        contents = data.decode("utf-8").splitlines()
        if len(contents) < 2 or not contents[0] or contents[0] != directory:
            return None
        return _journal_reference("omp", root, Path(contents[0]) / contents[1], directory=directory)
    except (OSError, RuntimeError, UnicodeError):
        return None


def _omp_open_sessions(proc_root: Path, process_id: int, root: Path) -> set[str]:
    resolved = root.resolve()
    owner_roots = {
        resolved.parent.parent / "run" / "session-owners",
        Path.home() / ".omp" / "run" / "session-owners",
    }
    identifiers = set()
    for _, target in _open_descriptor_paths(proc_root, process_id):
        path = Path(target)
        if path.parent in owner_roots and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", path.name):
            # OMP hashes lease names for IDs containing other characters.
            identifier = (
                None if re.fullmatch(r"h-[0-9a-f]{16}", path.name)
                else normalize_agent_session_id("omp", path.name)
            )
        else:
            identifier = _journal_reference("omp", resolved, path)
        if identifier is not None:
            identifiers.add(identifier)
    return identifiers


def _agy_open_sessions(proc_root: Path, process_id: int, root: Path) -> set[str]:
    identifiers = set()
    resolved = root.resolve()
    for _, target in _open_descriptor_paths(proc_root, process_id):
        path = Path(target)
        value: str | None
        if path.parent == resolved / "presence" and path.suffix == ".lock":
            value = path.stem
        elif path.parent == resolved / "conversations":
            match = re.fullmatch(r"(.+)\.db(?:-wal|-shm)?", path.name)
            value = match[1] if match else None
        else:
            continue
        identifier = normalize_agent_session_id("agy", value)
        if identifier is not None:
            identifiers.add(identifier)
    return identifiers


def _is_foreground_process(proc_root: Path, process_id: int) -> bool:
    data = _read_bytes(proc_root / str(process_id) / "stat", 8192).decode("utf-8", "replace")
    try:
        fields = data[data.rindex(")") + 2:].split()
        group, foreground = int(fields[2]), int(fields[5])
        return foreground <= 0 or group == foreground
    except (ValueError, IndexError):
        return True


def _discover_native_session(
    pane: Pane, agent: AgentType, proc_root: Path, root: Path | None,
) -> str | None:
    for process_id in _bounded_process_tree(proc_root, pane.process_pid):
        arguments = _process_arguments(proc_root, process_id)
        if not _looks_like_agent_process(arguments, agent) or not _is_foreground_process(proc_root, process_id):
            continue
        if root is not None:
            try:
                if agent == "omp":
                    held = _omp_open_sessions(proc_root, process_id, root)
                    if held:
                        return next(iter(held)) if len(held) == 1 else None
                    breadcrumb = _omp_tty_session(proc_root, process_id, root, pane.path)
                    if breadcrumb is not None:
                        return breadcrumb
                elif agent == "agy":
                    held = _agy_open_sessions(proc_root, process_id, root)
                    if held:
                        return next(iter(held)) if len(held) == 1 else None
                elif agent == "opencode" and arguments[1:2] != ["attach"] and not any(
                    arg.partition("=")[0] == "--server" for arg in arguments[1:]
                ):
                    identifier = opencode_session_for_pane(root, pane.path, pane.title)
                    if identifier is not None:
                        return identifier
            except (OSError, RuntimeError, sqlite3.Error):
                pass
        # The foreground CLI can run other agent subprocesses. Only its own
        # identifiers are relevant to the pane.
        return _explicit_native_session(arguments, agent, pane.path, root)
    return None


def _pi_displayed_session(screen: str, root: Path, directory: str) -> str | None:
    matches = set()
    lines = screen[-65_536:].splitlines()
    for index, line in enumerate(lines):
        if line.strip() != "Session Info":
            continue
        block = [row.strip() for row in lines[index + 1:index + 13]]
        fields = [offset for offset, row in enumerate(block) if row.startswith(("File:", "ID:"))]
        if len(fields) != 2 or block[0] or block[fields[1] + 1:fields[1] + 3] != ["", "Messages"]:
            continue
        file_index, id_index = fields
        if not block[file_index].startswith("File:") or not block[id_index].startswith("ID:"):
            continue
        identifier = block[id_index].removeprefix("ID:").strip()
        if normalize_agent_session_id("pi", identifier) is None:
            continue
        path = "".join([block[file_index].removeprefix("File:").strip(), *block[file_index + 1:id_index]])
        if _journal_reference("pi", root, Path(path), directory=directory) == identifier:
            matches.add(identifier)
    return next(iter(matches)) if len(matches) == 1 else None


def discover_agent_session_id(
    pane: Pane,
    agent_type: AgentType,
    *,
    proc_root: Path = Path("/proc"),
    claude_projects_root: Path | None = None,
    native_roots: Mapping[str, Path] | None = None,
) -> str | None:
    if agent_type in EXTENDED_TRANSCRIPT_AGENTS:
        roots = default_extended_transcript_roots() if native_roots is None else native_roots
        return _discover_native_session(pane, agent_type, proc_root, roots.get(agent_type))
    agent_processes = 0
    foreground_process: int | None = None
    launcher_reference: str | None = None
    for process_id in _bounded_process_tree(proc_root, pane.process_pid):
        arguments = _process_arguments(proc_root, process_id)
        if not _looks_like_agent_process(arguments, agent_type):
            continue
        agent_processes += 1
        if foreground_process is None:
            foreground_process = process_id
        # Codex's Node entry point launches a native CLI. Other agents can be
        # implemented in Node itself, so their explicit ID must keep priority.
        launcher = agent_type == "codex" and _is_process_launcher(proc_root, process_id)
        if agent_type == "claude":
            registered = _claude_registered_session(
                process_id, proc_root,
                claude_projects_root if claude_projects_root is not None else default_claude_projects_root(),
            )
            if registered is not None:
                return registered
        candidates = _open_reference_paths(proc_root, process_id, agent_type)
        if candidates:
            if agent_type == "copilot" and Path(candidates[0][1]).name == f"inuse.{process_id}.hold":
                held_ids = {identifier for _, _, identifier in candidates}
                return next(iter(held_ids)) if len(held_ids) == 1 else None
            # Breadth-first traversal encounters the foreground agent before
            # any nested workers. Do not let a newer subagent file replace the
            # foreground conversation reference.
            return max(candidates)[2]
        explicit = _uuid_from_explicit_arguments(arguments)
        if explicit is not None:
            if not launcher:
                return explicit
            launcher_reference = launcher_reference or explicit
        # A native foreground agent with no current ID must not borrow its
        # nested worker's ID. Continue through interpreter/launcher wrappers.
        if agent_type in {"codex", "claude"} and Path(arguments[0]).name == agent_type and not launcher:
            break
        if agent_processes >= MAX_AGENT_PROCESSES:
            break
    if launcher_reference is not None:
        return launcher_reference
    if agent_type == "claude" and foreground_process is not None:
        return _claude_session_from_transcripts(
            pane,
            foreground_process,
            proc_root,
            claude_projects_root
            if claude_projects_root is not None
            else default_claude_projects_root(),
        )
    return None


class AgentReferenceDetector:
    def __init__(
        self,
        *,
        cache_seconds: float = 30.0,
        missing_cache_seconds: float = 5.0,
        concurrency: int = 3,
        proc_root: Path = Path("/proc"),
        claude_projects_root: Path | None = None,
        native_roots: Mapping[str, Path] | None = None,
        tmux: TmuxClient | None = None,
    ) -> None:
        self._claude_projects_root = claude_projects_root
        self._native_roots = default_extended_transcript_roots() if native_roots is None else native_roots
        self._tmux = tmux
        self._cache_seconds = cache_seconds
        self._missing_cache_seconds = missing_cache_seconds
        self._limit = asyncio.Semaphore(concurrency)
        self._proc_root = proc_root
        self._cache: dict[str, _CachedReference] = {}

    async def detect_pane(self, pane: Pane | None, *, refresh: bool = False) -> AgentReference:
        agent_type = classify_agent_type(pane)
        if pane is None or agent_type is None or pane.process_pid <= 0:
            return AgentReference(agent_type, None)
        now = time.monotonic()
        signature = (pane.process_pid, pane.command, pane.title, agent_type)
        cached = self._cache.get(pane.id)
        if not refresh and cached is not None and cached.signature == signature and cached.expires_at > now:
            return cached.reference
        async with self._limit:
            session_id = await asyncio.to_thread(
                discover_agent_session_id, pane, agent_type, proc_root=self._proc_root,
                claude_projects_root=self._claude_projects_root,
                native_roots=self._native_roots,
            )
            pi_root = self._native_roots.get("pi")
            if session_id is None and agent_type == "pi" and pi_root is not None and self._tmux is not None:
                try:
                    screen = await self._tmux.capture_visible(pane.id)
                except TmuxError:
                    pass
                else:
                    session_id = await asyncio.to_thread(_pi_displayed_session, screen, pi_root, pane.path)
        reference = AgentReference(agent_type, session_id)
        ttl = self._cache_seconds if session_id is not None else self._missing_cache_seconds
        self._cache[pane.id] = _CachedReference(signature, now + ttl, reference)
        return reference

    async def detect_sessions(
        self,
        sessions: list[Session],
    ) -> dict[str, AgentReference]:
        now = time.monotonic()
        results: dict[str, AgentReference] = {}

        async def inspect(session: Session) -> None:
            results[session.name] = await self.detect_pane(session.active_pane)

        await asyncio.gather(*(inspect(session) for session in sessions))
        live_panes = {
            pane.id
            for session in sessions
            for pane in session.panes
        }
        self._cache = {
            pane_id: cached
            for pane_id, cached in self._cache.items()
            if pane_id in live_panes and cached.expires_at > now
        }
        return results

    async def detect_panes(self, panes: list[Pane]) -> dict[str, AgentReference]:
        """Record other panes using the same bounded discovery/cache as status."""
        references = await asyncio.gather(*(self.detect_pane(pane) for pane in panes))
        return {pane.id: reference for pane, reference in zip(panes, references, strict=True)}
