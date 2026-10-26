"""Explicit, native-session-scoped requests to end after the next work episode."""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace

from .session_registry import SessionRegistryUnavailable
from .status import AgentState, AgentStateDetector
from .tmux import Session, TmuxClient, TmuxError
from .workspaces import WorkspaceStoreUnavailable

BUSY_STATES = frozenset({"working", "running_command", "waiting_command"})
SHELL_COMMANDS = frozenset({"bash", "zsh", "sh", "dash", "fish", "ksh", "nu"})
COMPLETION_SETTLE_SECONDS = 3.0
LOGGER = logging.getLogger("muxdeck")
DECISION_PROMPT = re.compile(
    r"(?:enter|return) to (?:confirm|select)|(?:esc|escape) to cancel|"
    r"^\s*[❯›→]?\s*[1-9]\.\s+(?:yes|no)\b",
    re.IGNORECASE | re.MULTILINE,
)


class SessionCompletionMonitor:
    def __init__(
        self, tmux: TmuxClient, terminate: Callable[[Session], Awaitable[None]],
        *, detector: AgentStateDetector | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._tmux = tmux
        self._terminate = terminate
        self._detector = detector or AgentStateDetector()
        self._clock = clock
        self._ready_since: dict[str, float] = {}

    async def _states(self, session: Session) -> dict[str, AgentState]:
        # Every pane must have finished, including panes outside the active window.
        panes = [replace(session, name=pane.id, panes=[pane])
                 for pane in session.panes if not pane.dead]
        states = await self._detector.detect_sessions(self._tmux, panes)
        for item in panes:
            if states[item.name].name == "waiting_human":
                try:
                    screen = await self._tmux.capture_visible(item.name)
                except TmuxError:
                    states[item.name] = AgentState("unknown", "Completion prompt could not be verified")
                else:
                    if DECISION_PROMPT.search("\n".join(screen.splitlines()[-12:])):
                        states[item.name] = AgentState("unknown", "Agent is waiting for a decision")
        return states

    async def set_enabled(self, session: Session, enabled: bool) -> None:
        if enabled == bool(session.end_when_finished):
            return
        mode = ""
        if enabled:
            states = await self._states(session)
            mode = "working" if any(s.name in BUSY_STATES for s in states.values()) else "waiting"
        await self._tmux.set_end_when_finished(session, mode)
        self._ready_since.pop(session.identity, None)

    async def check(self, sessions: Sequence[Session]) -> None:
        armed = [session for session in sessions if session.end_when_finished]
        identities = {session.identity for session in armed}
        self._ready_since = {key: value for key, value in self._ready_since.items() if key in identities}
        for session in armed:
            try:
                await self._check_session(session)
            except (TmuxError, SessionRegistryUnavailable, WorkspaceStoreUnavailable):
                self._ready_since.pop(session.identity, None)
                LOGGER.warning("Unable to end a scheduled session; keeping its request for retry")

    async def _check_session(self, session: Session) -> None:
        states = await self._states(session)
        if any(state.name in BUSY_STATES for state in states.values()):
            self._ready_since.pop(session.identity, None)
            if session.end_when_finished != "working":
                await self._tmux.set_end_when_finished(session, "working")
            return
        if session.end_when_finished != "working":
            return
        ready = bool(session.panes) and all(
            pane.dead or (
                states[pane.id].name == "waiting_human"
                and not any(word in states[pane.id].reason.lower() for word in ("approval", "selection"))
            ) or (states[pane.id].name == "other" and pane.command in SHELL_COMMANDS)
            for pane in session.panes
        )
        if not ready:
            self._ready_since.pop(session.identity, None)
            return
        now = self._clock()
        since = self._ready_since.setdefault(session.identity, now)
        if now - since >= COMPLETION_SETTLE_SECONDS:
            await self._terminate(session)
            self._ready_since.pop(session.identity, None)
