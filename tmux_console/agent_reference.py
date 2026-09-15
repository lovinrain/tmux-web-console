from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime
from dataclasses import dataclass
from itertools import islice
from pathlib import Path

from .status import AgentType, classify_agent_type
from .tmux import Pane, Session

UUID_PATTERN = re.compile(
    r"(?<![0-9a-f])"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(?![0-9a-f])",
    re.IGNORECASE,
)
MAX_DESCENDANT_PROCESSES = 48
MAX_PROCESS_DEPTH = 8
MAX_AGENT_PROCESSES = 6
MAX_FDS_PER_PROCESS = 256
MAX_TRANSCRIPT_HEADER_LINES = 12
MAX_TRANSCRIPT_CANDIDATES = 64
# Tolerate a little skew between the recorded start time and the first entry.
TRANSCRIPT_START_TOLERANCE_SECONDS = 60.0


def default_claude_projects_root() -> Path:
    return Path.home() / ".claude" / "projects"


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


def _process_start_time(proc_root: Path, process_id: int) -> float | None:
    raw = _read_bytes(proc_root / str(process_id) / "stat", 8 * 1024)
    if not raw:
        return None
    text = raw.decode("utf-8", "replace")
    try:
        # comm can contain spaces and parentheses; fields follow the last ')'.
        start_ticks = int(text[text.rindex(")") + 2:].split()[19])
    except (ValueError, IndexError):
        return None
    boot = _boot_time(proc_root)
    if boot is None:
        return None
    ticks_per_second = os.sysconf("SC_CLK_TCK") or 100
    return boot + start_ticks / ticks_per_second


def _parse_transcript_timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
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
        if argument in {"--resume", "--session-id", "--conversation-id"}:
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


def _open_reference_paths(
    proc_root: Path,
    process_id: int,
    agent_type: AgentType,
) -> list[tuple[int, str, str]]:
    fd_root = proc_root / str(process_id) / "fd"
    try:
        with os.scandir(fd_root) as entries:
            descriptors = list(islice(entries, MAX_FDS_PER_PROCESS))
    except OSError:
        return []

    matches: list[tuple[int, str, str]] = []
    for descriptor in descriptors:
        try:
            target = os.readlink(descriptor.path)
        except OSError:
            continue
        if not _path_matches_agent(target, agent_type):
            continue
        identifiers = UUID_PATTERN.findall(target)
        if not identifiers:
            continue
        try:
            modified_ns = os.stat(descriptor.path).st_mtime_ns
        except OSError:
            modified_ns = 0
        matches.append((modified_ns, target, identifiers[-1].lower()))
    return matches


def discover_agent_session_id(
    pane: Pane,
    agent_type: AgentType,
    *,
    proc_root: Path = Path("/proc"),
    claude_projects_root: Path | None = None,
) -> str | None:
    agent_processes = 0
    foreground_process: int | None = None
    for process_id in _bounded_process_tree(proc_root, pane.process_pid):
        arguments = _process_arguments(proc_root, process_id)
        if not _looks_like_agent_process(arguments, agent_type):
            continue
        agent_processes += 1
        if foreground_process is None:
            foreground_process = process_id
        explicit = _uuid_from_explicit_arguments(arguments)
        if explicit is not None:
            return explicit
        candidates = _open_reference_paths(proc_root, process_id, agent_type)
        if candidates:
            # Breadth-first traversal encounters the foreground agent before
            # any nested workers. Do not let a newer subagent file replace the
            # foreground conversation reference.
            return max(candidates)[2]
        if agent_processes >= MAX_AGENT_PROCESSES:
            break
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
        missing_cache_seconds: float = 30.0,
        concurrency: int = 3,
        proc_root: Path = Path("/proc"),
        claude_projects_root: Path | None = None,
    ) -> None:
        self._claude_projects_root = claude_projects_root
        self._cache_seconds = cache_seconds
        self._missing_cache_seconds = missing_cache_seconds
        self._limit = asyncio.Semaphore(concurrency)
        self._proc_root = proc_root
        self._cache: dict[str, _CachedReference] = {}

    async def detect_sessions(
        self,
        sessions: list[Session],
    ) -> dict[str, AgentReference]:
        now = time.monotonic()
        results: dict[str, AgentReference] = {}

        async def inspect(session: Session) -> None:
            pane = session.active_pane
            agent_type = classify_agent_type(pane)
            if pane is None or agent_type is None or pane.process_pid <= 0:
                results[session.name] = AgentReference(agent_type, None)
                return
            signature = (pane.process_pid, pane.command, pane.title, agent_type)
            cached = self._cache.get(pane.id)
            if cached is not None and cached.signature == signature and cached.expires_at > now:
                results[session.name] = cached.reference
                return
            async with self._limit:
                session_id = await asyncio.to_thread(
                    discover_agent_session_id,
                    pane,
                    agent_type,
                    proc_root=self._proc_root,
                    claude_projects_root=self._claude_projects_root,
                )
            reference = AgentReference(agent_type, session_id)
            ttl = self._cache_seconds if session_id is not None else self._missing_cache_seconds
            self._cache[pane.id] = _CachedReference(signature, now + ttl, reference)
            results[session.name] = reference

        await asyncio.gather(*(inspect(session) for session in sessions))
        live_panes = {
            pane.id
            for session in sessions
            if (pane := session.active_pane) is not None
        }
        self._cache = {
            pane_id: cached
            for pane_id, cached in self._cache.items()
            if pane_id in live_panes and cached.expires_at > now
        }
        return results
