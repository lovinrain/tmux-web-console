import time
from dataclasses import replace
from typing import cast

from tmux_console.status import AgentStateDetector, classify_agent_state
from tmux_console.tmux import (
    OUTPUT_FIELD_SEPARATOR,
    PANE_FORMAT_FIELDS,
    Pane,
    Session,
    TmuxClient,
    parse_sessions,
)


def pane_row(**overrides: str) -> str:
    values = {
        "session_name": "agent-one",
        "session_id": "$7",
        "session_windows": "1",
        "session_attached": "2",
        "session_created": "1700000000",
        "window_index": "0",
        "window_name": "claude",
        "window_active": "1",
        "window_activity": "1700000100",
        "pane_index": "0",
        "pane_id": "%12",
        "pane_active": "1",
        "pane_current_command": "claude",
        "pane_current_path": "/work/project",
        "pane_title": "Review changes",
        "pane_width": "120",
        "pane_height": "40",
        "history_size": "0",
        "history_limit": "2000",
        "alternate_on": "1",
        "pane_dead": "0",
    }
    values.update(overrides)
    return OUTPUT_FIELD_SEPARATOR.join(values[field] for field in PANE_FORMAT_FIELDS)


def test_parse_sessions_groups_panes_and_selects_active_pane():
    output = "\n".join(
        [
            pane_row(pane_id="%11", pane_active="0", pane_index="0"),
            pane_row(pane_id="%12", pane_active="1", pane_index="1"),
            pane_row(
                session_name="agent-two",
                session_id="$8",
                pane_id="%13",
                pane_current_command="codex",
                alternate_on="0",
                history_size="800",
                window_activity="1700000200",
            ),
        ]
    )

    sessions = parse_sessions(output)

    assert [session.name for session in sessions] == ["agent-two", "agent-one"]
    agent_one = sessions[1]
    assert len(agent_one.panes) == 2
    assert agent_one.active_pane is not None
    assert agent_one.active_pane.id == "%12"
    assert agent_one.to_dict()["activePaneId"] == "%12"


def test_parse_sessions_ignores_malformed_records():
    sessions = parse_sessions(
        f"broken\n{pane_row()}\nmissing{OUTPUT_FIELD_SEPARATOR}fields"
    )
    assert len(sessions) == 1
    assert sessions[0].panes[0].alternate_on is True


def test_parse_sessions_preserves_tabs_inside_pane_titles():
    sessions = parse_sessions(pane_row(pane_title="Codex\tworking"))

    assert sessions[0].panes[0].title == "Codex\tworking"


def agent_pane(**overrides: object) -> Pane:
    pane = Pane(
        id="%42",
        index=0,
        window_index=0,
        window_name="agent",
        window_active=True,
        active=True,
        command="codex",
        path="/work",
        title="workspace",
        width=100,
        height=30,
        history_size=0,
        history_limit=2000,
        alternate_on=False,
        dead=False,
        activity=990,
    )
    return replace(pane, **overrides)


def test_agent_state_distinguishes_work_input_and_command_waits():
    working = agent_pane(title="\u2838 repo")

    assert classify_agent_state(working, now=1000).name == "working"
    assert (
        classify_agent_state(
            working,
            visible_screen="Waiting for background terminal (2m; esc to interrupt)",
            now=1000,
        ).name
        == "waiting_command"
    )
    assert (
        classify_agent_state(
            agent_pane(command="claude", title="\u2733 Task"), now=1000
        ).name
        == "waiting_human"
    )
    assert classify_agent_state(agent_pane(title="repo"), now=1000).name == "waiting_human"


def test_agent_state_is_conservative_for_stale_or_unknown_signals():
    assert (
        classify_agent_state(agent_pane(title="\u2838 repo", activity=900), now=1000).name
        == "unknown"
    )
    assert (
        classify_agent_state(agent_pane(command="claude", title=""), now=1000).name
        == "unknown"
    )
    assert classify_agent_state(agent_pane(dead=True), now=1000).name == "unknown"
    assert classify_agent_state(agent_pane(command="bash"), now=1000).name == "other"


CURSOR_RUNNING_SCREEN = "\n".join(
    [
        "    Grepped \"sample_module\" in .",
        " \u2818\u2823 Running  30.77k tokens",
        "",
        "  \u2192 Add a follow-up                                 ctrl+c to stop",
        "",
        "  Opus 5 1M Max Fast \u00b7 MAX \u00b7 13.5%                  Run Everything",
        "  ~/work \u00b7 main",
    ]
)
CURSOR_IDLE_SCREEN = "\n".join(
    [
        "    reply with only the word pong",
        "    pong",
        "",
        "  \u2192 Add a follow-up",
        "  Opus 5 1M Max Fast \u00b7 MAX \u00b7 6.5%",
        "  ~/work \u00b7 main",
    ]
)


def cursor_pane(**overrides: object) -> Pane:
    defaults: dict[str, object] = {"command": "agent", "title": "Example conversation"}
    return agent_pane(**{**defaults, **overrides})


class RecordingTmux:
    def __init__(self, screens: dict[str, str]) -> None:
        self.screens = screens
        self.captured: list[str] = []

    async def capture_visible(self, pane_id: str) -> str:
        self.captured.append(pane_id)
        return self.screens[pane_id]


def test_cursor_agent_state_comes_from_the_footer_interrupt_hint():
    # Cursor names the pane after the conversation, so the title carries no state.
    for command in ("agent", "cursor-agent"):
        pane = cursor_pane(command=command)
        assert (
            classify_agent_state(pane, visible_screen=CURSOR_RUNNING_SCREEN, now=1000).name
            == "working"
        )
        assert (
            classify_agent_state(pane, visible_screen=CURSOR_IDLE_SCREEN, now=1000).name
            == "waiting_human"
        )

    waiting_screen = CURSOR_RUNNING_SCREEN.replace(
        "Grepped \"sample_module\" in .", "Waiting for background terminal"
    )
    assert (
        classify_agent_state(cursor_pane(), visible_screen=waiting_screen, now=1000).name
        == "waiting_command"
    )


def test_cursor_agent_state_requires_a_fresh_screen_capture():
    assert classify_agent_state(cursor_pane(), now=1000).name == "unknown"
    assert (
        classify_agent_state(
            cursor_pane(activity=900), visible_screen=CURSOR_RUNNING_SCREEN, now=1000
        ).name
        == "unknown"
    )

    # A hint scrolled up into the transcript must not read as a live turn.
    scrolled_away = "\n".join(["  ctrl+c to stop", *([""] * 12), CURSOR_IDLE_SCREEN])
    assert (
        classify_agent_state(cursor_pane(), visible_screen=scrolled_away, now=1000).name
        == "waiting_human"
    )


async def test_detect_sessions_captures_the_screen_for_cursor_panes():
    cursor = cursor_pane(activity=int(time.time()))
    idle_codex = agent_pane(id="%43", title="repo")
    tmux = RecordingTmux({cursor.id: CURSOR_RUNNING_SCREEN})
    sessions = [
        Session(name="cursor-one", id="$1", windows=1, attached=0, created=1, panes=[cursor]),
        Session(name="codex-one", id="$2", windows=1, attached=0, created=1, panes=[idle_codex]),
    ]

    states = await AgentStateDetector().detect_sessions(cast(TmuxClient, tmux), sessions)

    assert states["cursor-one"].name == "working"
    assert states["codex-one"].name == "waiting_human"
    assert tmux.captured == [cursor.id]
