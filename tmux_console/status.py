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
# Claude prints settled/active transcript headlines with these symbols. Looking
# only at the latest headline avoids treating an older wait banner as current.
CLAUDE_HEADLINE_SYMBOLS = "\u273b\u273d\u2736\u2733"
CLAUDE_ACTIVITY_HEADLINE_PATTERN = re.compile(
    rf"^[\u25cf{CLAUDE_HEADLINE_SYMBOLS}](?:\s|$)"
)
CLAUDE_BACKGROUND_WAIT_PATTERN = re.compile(
    rf"^[{CLAUDE_HEADLINE_SYMBOLS}]\s+waiting for\s+"
    r"[1-9]\d*\s+(?:background agents?|dynamic workflows?)"
    r"(?:\s+and\s+[1-9]\d*\s+(?:background agents?|dynamic workflows?))?"
    r"\s+to finish$",
    re.IGNORECASE,
)
CLAUDE_LEGACY_WAIT_PATTERN = re.compile(
    rf"^[{CLAUDE_HEADLINE_SYMBOLS}]\s+waiting for\s+"
    r"(?:background terminals?|agents?)(?:\s+\([^\n]*\))?$",
    re.IGNORECASE,
)
CLAUDE_HEADLINE_WRAP_LINES = 4
# The Cursor CLI installs as ``cursor-agent`` plus a bare ``agent`` symlink.
CURSOR_COMMANDS = frozenset({"agent", "cursor-agent"})
AGENT_COMMANDS = frozenset({"claude", "codex", "grok"}) | CURSOR_COMMANDS
# Claude Code 2.1.233 uses the circle-halves spinner in tmux titles. Older
# Claude, Codex, and Grok versions use braille frames instead.
CLAUDE_WORKING_TITLE_FRAMES = frozenset({"\u25d0", "\u25d3", "\u25d1", "\u25d2"})
# Cursor's interrupt hint sits in the footer during a live turn, but it is drawn
# as a placeholder, so typing a follow-up mid-turn hides it again.
CURSOR_RUNNING_PATTERN = re.compile(
    r"\b(?:ctrl\+c|esc) to (?:stop|interrupt)\b", re.IGNORECASE
)
# Cursor marks its input line with an arrow and keeps the turn indicators on and
# just above it, under any queued messages.
CURSOR_PROMPT_MARKER = "\u2192"
# A running turn spins two braille frames ahead of the current verb.
CURSOR_SPINNER_PATTERN = re.compile(r"^\s*[\u2800-\u28ff]{2}\s+\S")
CURSOR_STATUS_LOOKBACK = 5
# Tool and mode approvals replace the input placeholder with their own prompt.
CURSOR_DECISION_PATTERN = re.compile(
    r"waiting for decision|approve mode switch", re.IGNORECASE
)
CURSOR_FOOTER_LINES = 12
SCREEN_TAIL_LINES = 20
ACTIVITY_STALE_SECONDS = 15


@dataclass(frozen=True)
class AgentState:
    name: AgentStateName
    reason: str


@dataclass(frozen=True)
class CachedState:
    expires_at: float
    state: AgentState


def _rendered_lines(screen: str) -> list[str]:
    # Agent CLIs draw inline, so their footer ends where the output ends. Anchoring
    # to the pane floor instead would miss it whenever the pane is taller than the
    # transcript, which is every session until it has scrolled once.
    lines = screen.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _tail(screen: str, lines: int) -> str:
    return "\n".join(_rendered_lines(screen)[-lines:])


def _activity_is_stale(pane: Pane, now: float | None) -> bool:
    age = max(0.0, (now if now is not None else time.time()) - pane.activity)
    return age > ACTIVITY_STALE_SECONDS


def _claude_is_waiting_for_background_work(screen: str) -> bool:
    # capture_visible already excludes scrollback. Scan the whole pane so a
    # dense task panel cannot push the current headline past an arbitrary tail.
    visible_lines = _rendered_lines(screen)
    for index in reversed(range(len(visible_lines))):
        if not CLAUDE_ACTIVITY_HEADLINE_PATTERN.match(visible_lines[index]):
            continue

        parts = [visible_lines[index].strip()]
        for continuation in visible_lines[
            index + 1 : index + CLAUDE_HEADLINE_WRAP_LINES
        ]:
            if not continuation.strip() or CLAUDE_ACTIVITY_HEADLINE_PATTERN.match(
                continuation
            ):
                break
            parts.append(continuation.strip())
        headline = " ".join(parts)
        return bool(
            CLAUDE_BACKGROUND_WAIT_PATTERN.fullmatch(headline)
            or CLAUDE_LEGACY_WAIT_PATTERN.fullmatch(headline)
        )
    return False


def _title_has_live_activity(command: str, title: str) -> bool:
    first = title.strip()[:1]
    return bool(
        first
        and (
            "\u2801" <= first <= "\u28ff"
            or (command == "claude" and first in CLAUDE_WORKING_TITLE_FRAMES)
        )
    )


def _cursor_prompt_index(footer: list[str]) -> int:
    for index in reversed(range(len(footer))):
        if CURSOR_PROMPT_MARKER in footer[index]:
            return index
    return len(footer) - 1


def _cursor_turn_is_live(footer: list[str], prompt: int) -> bool:
    if CURSOR_RUNNING_PATTERN.search("\n".join(footer)):
        return True
    spinner = footer[max(0, prompt - CURSOR_STATUS_LOOKBACK) : prompt]
    return any(CURSOR_SPINNER_PATTERN.match(line) for line in spinner)


def _classify_cursor_state(
    pane: Pane, visible_screen: str | None, now: float | None
) -> AgentState:
    # Cursor titles its pane after the conversation, so only the screen tells a
    # live turn apart from an idle prompt.
    if visible_screen is None:
        return AgentState("unknown", "Cursor screen capture is unavailable")
    footer = _rendered_lines(visible_screen)[-CURSOR_FOOTER_LINES:]
    prompt = _cursor_prompt_index(footer)
    if prompt >= 0 and CURSOR_DECISION_PATTERN.search(footer[prompt]):
        return AgentState("waiting_human", "Cursor is waiting on an approval decision")
    if not _cursor_turn_is_live(footer, prompt):
        return AgentState("waiting_human", "Cursor is idle at its input prompt")
    if _activity_is_stale(pane, now):
        return AgentState("unknown", "Agent activity indicator is stale")
    if COMMAND_WAIT_PATTERN.search(_tail(visible_screen, SCREEN_TAIL_LINES)):
        return AgentState("waiting_command", "Agent is waiting for background work")
    return AgentState("working", "Cursor is running a turn")


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
    if command not in AGENT_COMMANDS:
        return AgentState("other", "No Claude, Codex, Cursor, or Grok activity signal")
    if command in CURSOR_COMMANDS:
        return _classify_cursor_state(pane, visible_screen, now)

    title = pane.title.strip()
    if _title_has_live_activity(command, title):
        if (
            command == "claude"
            and visible_screen
            and _claude_is_waiting_for_background_work(visible_screen)
        ):
            # Long background waits can stop updating tmux's activity timestamp.
            return AgentState("waiting_command", "Agent is waiting for background work")
        if _activity_is_stale(pane, now):
            return AgentState("unknown", "Agent activity indicator is stale")
        if visible_screen:
            waiting_for_background_work = command != "claude" and bool(
                COMMAND_WAIT_PATTERN.search(_tail(visible_screen, SCREEN_TAIL_LINES))
            )
            if waiting_for_background_work:
                return AgentState(
                    "waiting_command", "Agent is waiting for background work"
                )
        return AgentState("working", "Live agent activity indicator")

    if command == "claude" and title.startswith("\u2733"):
        return AgentState("waiting_human", "Claude is paused at its input prompt")
    if command == "codex" and title:
        return AgentState("waiting_human", "Codex is paused at its input prompt")
    normalized_title = title.casefold()
    if command == "grok" and (
        normalized_title == "grok" or normalized_title.endswith(" - grok")
    ):
        return AgentState("waiting_human", "Grok is paused at its input prompt")
    return AgentState("unknown", "Agent state signal is not recognized")


def _needs_screen_capture(pane: Pane, state: AgentState) -> bool:
    if pane.dead:
        return False
    command = pane.command.lower()
    return (
        state.name == "working"
        or command in CURSOR_COMMANDS
        or (command == "claude" and _title_has_live_activity(command, pane.title))
    )


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
            if pane is None or not _needs_screen_capture(pane, initial):
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
