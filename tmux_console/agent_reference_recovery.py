"""Recover explicit conversation references retained after a CLI exits."""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass

from .agent_reference import AgentReference, UUID_PATTERN
from .agent_transcripts import AgentTranscriptReader
from .tmux import MAX_PANE_CAPTURE_BYTES, MAX_PANE_CAPTURE_LINES, Pane, Session, TmuxClient, TmuxError

MAX_RECOVERED_REFERENCES = 16
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_RESUME = re.compile(rf"codex resume (?P<id>{UUID_PATTERN.pattern})", re.I)
_INLINE = re.compile(r"To continue this session, run\s+(.+)", re.I)


def codex_reconnect_references(text: str) -> list[AgentReference]:
    """Accept CLI exit instructions, not UUIDs or arbitrary shell commands."""
    tail = text.encode("utf-8", "replace")[-MAX_PANE_CAPTURE_BYTES:].decode("utf-8", "ignore")
    lines = _ANSI.sub("", tail).splitlines()
    references: dict[str, AgentReference] = {}
    for index, raw in enumerate(lines):
        line = raw.strip()
        inline = _INLINE.fullmatch(line)
        command = inline.group(1) if inline else (
            line if index and lines[index - 1].strip() == "To reconnect, run:" else ""
        )
        match = _RESUME.fullmatch(command)
        if match is not None:
            identifier = match.group("id").lower()
            # A repeated instruction belongs at its latest position.
            references.pop(identifier, None)
            references[identifier] = AgentReference("codex", identifier)
            if len(references) > MAX_RECOVERED_REFERENCES:
                references.pop(next(iter(references)))
    return list(references.values())


@dataclass(frozen=True)
class _CachedRecovery:
    signature: tuple[str, str, bool, bool]
    expires_at: float
    references: list[AgentReference]


class AgentReferenceRecovery:
    def __init__(
        self, tmux: TmuxClient, transcripts: AgentTranscriptReader,
        *, cache_seconds: float = 60.0, missing_cache_seconds: float = 5.0, concurrency: int = 3,
    ) -> None:
        self._tmux = tmux
        self._transcripts = transcripts
        self._cache_seconds = cache_seconds
        self._missing_cache_seconds = missing_cache_seconds
        self._limit = asyncio.Semaphore(concurrency)
        self._cache: dict[tuple[str, str, int], _CachedRecovery] = {}

    async def recover_sessions(
        self, sessions: list[Session], *, prune_cache: bool = True,
    ) -> dict[str, list[AgentReference]]:
        """Capture a bounded tail, then recheck tmux incarnation before use."""
        results: dict[str, list[AgentReference]] = {}
        live_keys = {(session.identity, pane.id, pane.process_pid)
                     for session in sessions for pane in session.panes}
        if prune_cache:
            self._cache = {key: cached for key, cached in self._cache.items() if key in live_keys}

        async def inspect(session: Session, pane: Pane) -> None:
            if pane.process_pid <= 0:
                return
            key = (session.identity, pane.id, pane.process_pid)
            signature = (pane.command, pane.path, pane.dead, pane.alternate_on)
            cached = self._cache.get(key)
            if cached and cached.signature == signature and cached.expires_at > time.monotonic():
                if cached.references:
                    results[pane.id] = cached.references
                return
            async with self._limit:
                try:
                    # Bound physical rows as well as retained parsing bytes.
                    end = max(0, pane.height - 1)
                    rows = min(MAX_PANE_CAPTURE_LINES, max(1, MAX_PANE_CAPTURE_BYTES // max(1, pane.width * 4)))
                    start = max(-pane.history_size, end - rows + 1)
                    capture = await self._tmux.capture_history_slice(pane, start, end)
                    candidates = codex_reconnect_references("\n".join(capture.lines))
                    accepted = await asyncio.to_thread(self._validate, candidates) if candidates else []
                except TmuxError:
                    # A vanished pane is routine and must not break inventory.
                    return
            ttl = self._cache_seconds if accepted else self._missing_cache_seconds
            self._cache[key] = _CachedRecovery(signature, time.monotonic() + ttl, accepted)
            if accepted:
                results[pane.id] = accepted

        await asyncio.gather(*(inspect(session, pane) for session in sessions for pane in session.panes))
        if results:
            latest = await self._tmux.list_sessions()
            confirmed = {(session.identity, pane.id, pane.process_pid, pane.command, pane.path, pane.dead, pane.alternate_on)
                         for session in latest for pane in session.panes}
            results = {pane.id: results[pane.id] for session in sessions for pane in session.panes
                       if pane.id in results and (session.identity, pane.id, pane.process_pid, pane.command,
                                                  pane.path, pane.dead, pane.alternate_on) in confirmed}
        return results

    def _validate(self, candidates: list[AgentReference]) -> list[AgentReference]:
        return [reference for reference in candidates if reference.session_id is not None
                and self._transcripts.accepts_codex_reference(reference.session_id)]
