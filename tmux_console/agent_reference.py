from __future__ import annotations

import asyncio
import os
import re
import time
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
) -> str | None:
    agent_processes = 0
    for process_id in _bounded_process_tree(proc_root, pane.process_pid):
        arguments = _process_arguments(proc_root, process_id)
        if not _looks_like_agent_process(arguments, agent_type):
            continue
        agent_processes += 1
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
    return None


class AgentReferenceDetector:
    def __init__(
        self,
        *,
        cache_seconds: float = 30.0,
        missing_cache_seconds: float = 30.0,
        concurrency: int = 3,
        proc_root: Path = Path("/proc"),
    ) -> None:
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
