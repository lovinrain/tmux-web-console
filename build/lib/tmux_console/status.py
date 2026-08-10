from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Literal

from .tmux import Pane, Session, TmuxClient, TmuxError


AgentStateName = Literal[
    "working", "waiting_human", "waiting_command", "unknown", "other"
]
COMMAND_WAIT_PATTERN = re.compile(
    r"\bwaiting for (?:background terminals?|agents?)\b", re.IGNORECASE
)


@dataclass(frozen=True)
class AgentState:
    name: AgentStateName
    reason: str


@dataclass(frozen=True)
class CachedState:
    expires_at: float
    state: AgentState


def classify_agent_state(
    pane: Pane | None,
    visible_screen: str | None = None,
    now: float | None = None,
) -> AgentState:
    if pane is None:
        return AgentState("other", "Session has no panes")
    if pane.dead:
        return AgentState("unknown", "The active pane has exited")

    command = pane.command.lower()
    if command not in {"claude", "codex"}:
        return AgentState("other", "No Claude or Codex activity signal")

    title = pane.title.strip()
    first = title[:1]
    if first and "\u2801" <= first <= "\u28ff":
        activity_age = max(0.0, (now if now is not None else time.time()) - pane.activity)
        if activity_age > 15:
            return AgentState("unknown", "Agent activity indicator is stale")
        if visible_screen:
            tail = "\n".join(visible_screen.splitlines()[-20:])
            if COMMAND_WAIT_PATTERN.search(tail):
                return AgentState("waiting_command", "Agent is waiting for a command result")
        return AgentState("working", "Live agent activity indicator")

    if command == "claude" and title.startswith("\u2733"):
        return AgentState("waiting_human", "Claude is paused at its input prompt")
    if command == "codex" and title:
        return AgentState("waiting_human", "Codex is paused at its input prompt")
    return AgentState("unknown", "Agent state signal is not recognized")


class AgentStateDetector:
    def __init__(self, cache_seconds: float = 1.0, capture_concurrency: int = 6):
        self.cache_seconds = cache_seconds
        self._capture_limit = asyncio.Semaphore(capture_concurrency)
        self._cache: dict[str, CachedState] = {}

    async def detect_sessions(
        self, tmux: TmuxClient, sessions: list[Session]
    ) -> dict[str, AgentState]:
        now = time.time()
        monotonic_now = time.monotonic()
        results: dict[str, AgentState] = {}
        captures: list[tuple[str, Pane]] = []

        for session in sessions:
            pane = session.active_pane
            initial = classify_agent_state(pane, now=now)
            if pane is None or initial.name != "working":
                results[session.name] = initial
                continue
            cached = self._cache.get(pane.id)
            if cached and cached.expires_at > monotonic_now:
                results[session.name] = cached.state
            else:
                captures.append((session.name, pane))

        async def inspect(session_name: str, pane: Pane) -> None:
            try:
                async with self._capture_limit:
                    screen = await tmux.capture_visible(pane.id)
            except TmuxError:
                state = classify_agent_state(pane, now=now)
            else:
                state = classify_agent_state(pane, visible_screen=screen, now=now)
            results[session_name] = state
            self._cache[pane.id] = CachedState(
                expires_at=time.monotonic() + self.cache_seconds,
                state=state,
            )

        await asyncio.gather(*(inspect(name, pane) for name, pane in captures))
        live_panes = {pane.id for session in sessions if (pane := session.active_pane)}
        self._cache = {
            pane_id: cached
            for pane_id, cached in self._cache.items()
            if pane_id in live_panes and cached.expires_at > monotonic_now
        }
        return results
