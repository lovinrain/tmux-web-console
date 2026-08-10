from dataclasses import replace

from tmux_console.status import classify_agent_state
from tmux_console.tmux import OUTPUT_FIELD_SEPARATOR, PANE_FORMAT_FIELDS, Pane, parse_sessions


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
