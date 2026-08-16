import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest

from tmux_console.status import AgentStateDetector, classify_agent_state
from tmux_console.tmux import (
    MAX_SESSION_NAME_LENGTH,
    OUTPUT_FIELD_SEPARATOR,
    PANE_FORMAT,
    PANE_FORMAT_FIELDS,
    Pane,
    Session,
    TmuxClient,
    TmuxError,
    TmuxRenameUnverifiedError,
    parse_sessions,
    validate_tmux_new_session_name,
    validate_tmux_session_name,
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


class RecordingRunTmux(TmuxClient):
    def __init__(self, output: str | TmuxError | list[str | TmuxError]) -> None:
        super().__init__(binary="unused-tmux", socket_name="isolated-test")
        self.output = output
        self.calls: list[list[str]] = []

    async def run(self, args: Sequence[str]) -> str:
        self.calls.append(list(args))
        result = self.output.pop(0) if isinstance(self.output, list) else self.output
        if isinstance(result, TmuxError):
            raise result
        return result


async def test_create_session_uses_collision_resistant_name_default_shell_and_home(
    monkeypatch,
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123def456")
    tmux = RecordingRunTmux("  muxdeck-abc123def456\n")

    session_name = await tmux.create_session()

    assert session_name == "muxdeck-abc123def456"
    assert tmux.calls == [
        [
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{session_name}",
            "-s",
            "muxdeck-abc123def456",
            "-c",
            str(Path.home()),
        ]
    ]


@pytest.mark.parametrize("output", ["", "\n", "0\n1\n"])
async def test_create_session_rejects_missing_or_ambiguous_name(output: str):
    tmux = RecordingRunTmux(output)

    with pytest.raises(TmuxError, match="tmux did not return the created session name"):
        await tmux.create_session()


async def test_create_session_rejects_an_unexpected_returned_name(monkeypatch):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123def456")
    tmux = RecordingRunTmux("some-other-session\n")

    with pytest.raises(TmuxError, match="unexpected created session name"):
        await tmux.create_session()


async def test_rename_session_uses_exact_target_and_safe_argv_separator():
    tmux = RecordingRunTmux(
        ["", pane_row(session_name="-renamed;work", session_id="$7")]
    )

    renamed = await tmux.rename_session(
        "work/name #1", "-renamed;work", session_id="$7"
    )

    assert renamed == "-renamed;work"
    assert tmux.calls == [
        [
            "rename-session",
            "-t",
            "$7",
            "--",
            "-renamed;work",
        ],
        ["list-panes", "-a", "-F", PANE_FORMAT],
    ]


async def test_rename_session_returns_verified_native_name():
    tmux = RecordingRunTmux(
        ["", pane_row(session_name="tmux-result", session_id="$7")]
    )

    renamed = await tmux.rename_session("work", "requested", session_id="$7")

    assert renamed == "tmux-result"


async def test_rename_session_reports_success_when_result_verification_fails():
    verification_error = TmuxError("verification timed out")
    tmux = RecordingRunTmux(["", verification_error])

    with pytest.raises(TmuxRenameUnverifiedError) as raised:
        await tmux.rename_session("work", "renamed", session_id="$7")

    assert raised.value.requested_name == "renamed"
    assert raised.value.verification_error is verification_error
    assert raised.value.__cause__ is verification_error


async def test_rename_session_recovers_a_committed_timeout():
    timeout = TmuxError("tmux command timed out")
    tmux = RecordingRunTmux(
        [timeout, pane_row(session_name="renamed", session_id="$7")]
    )

    renamed = await tmux.rename_session("work", "renamed", session_id="$7")

    assert renamed == "renamed"


async def test_rename_session_preserves_a_definite_command_failure():
    failure = TmuxError("rename denied", returncode=1)
    tmux = RecordingRunTmux(
        [failure, pane_row(session_name="work", session_id="$7")]
    )

    with pytest.raises(TmuxError, match="rename denied") as raised:
        await tmux.rename_session("work", "renamed", session_id="$7")

    assert raised.value is failure


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("", "required"),
        ("   ", "required"),
        ("line\nbreak", "control"),
        ("has:colon", "cannot contain"),
        ("has.period", "cannot contain"),
        ("\ud800", "invalid Unicode"),
        ("x" * (MAX_SESSION_NAME_LENGTH + 1), "256 characters"),
    ],
)
def test_tmux_session_name_validation_rejects_invalid_names(name: str, message: str):
    with pytest.raises(ValueError, match=message):
        validate_tmux_session_name(name)


def test_new_tmux_session_name_rejects_a_trailing_command_separator():
    with pytest.raises(ValueError, match="cannot end"):
        validate_tmux_new_session_name("trailing;")

    assert validate_tmux_new_session_name("embedded;semicolon") == "embedded;semicolon"


async def test_rename_session_rejects_an_unchanged_name_without_running_tmux():
    tmux = RecordingRunTmux("")

    with pytest.raises(ValueError, match="must differ"):
        await tmux.rename_session("work", "work", session_id="$7")

    assert tmux.calls == []


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
    assert (
        classify_agent_state(agent_pane(title="repo"), now=1000).name == "waiting_human"
    )


def test_agent_state_is_conservative_for_stale_or_unknown_signals():
    assert (
        classify_agent_state(
            agent_pane(title="\u2838 repo", activity=900), now=1000
        ).name
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
        '    Grepped "sample_module" in .',
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
            classify_agent_state(
                pane, visible_screen=CURSOR_RUNNING_SCREEN, now=1000
            ).name
            == "working"
        )
        assert (
            classify_agent_state(pane, visible_screen=CURSOR_IDLE_SCREEN, now=1000).name
            == "waiting_human"
        )

    waiting_screen = CURSOR_RUNNING_SCREEN.replace(
        'Grepped "sample_module" in .', "Waiting for background terminal"
    )
    assert (
        classify_agent_state(
            cursor_pane(), visible_screen=waiting_screen, now=1000
        ).name
        == "waiting_command"
    )


def test_cursor_turn_survives_a_pane_taller_than_its_transcript():
    # Cursor draws inline, so its footer sits far above the pane floor until the
    # transcript is long enough to fill the pane.
    padded = "\n".join([CURSOR_RUNNING_SCREEN, *([""] * 40)])

    assert (
        classify_agent_state(cursor_pane(), visible_screen=padded, now=1000).name
        == "working"
    )


def test_cursor_turn_survives_a_follow_up_typed_mid_turn():
    # The interrupt hint is a placeholder, so typing hides it while the turn runs.
    typed = CURSOR_RUNNING_SCREEN.replace(
        "Add a follow-up                                 ctrl+c to stop",
        "also check the retry path",
    )

    assert "ctrl+c to stop" not in typed
    assert (
        classify_agent_state(cursor_pane(), visible_screen=typed, now=1000).name
        == "working"
    )


def test_cursor_approval_prompt_outranks_the_running_spinner():
    # Cursor keeps spinning while a tool approval blocks the turn on an answer.
    pending = CURSOR_RUNNING_SCREEN.replace(
        "Add a follow-up                                 ctrl+c to stop",
        "Waiting for decision (y/n/p)...",
    )

    assert (
        classify_agent_state(cursor_pane(), visible_screen=pending, now=1000).name
        == "waiting_human"
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

    # Neither must a spinner that is no longer sitting above the input prompt.
    stale_spinner = "\n".join(
        [" \u2818\u2823 Running", *([""] * 4), CURSOR_IDLE_SCREEN]
    )
    assert (
        classify_agent_state(cursor_pane(), visible_screen=stale_spinner, now=1000).name
        == "waiting_human"
    )


async def test_detect_sessions_captures_the_screen_for_cursor_panes():
    cursor = cursor_pane(activity=int(time.time()))
    idle_codex = agent_pane(id="%43", title="repo")
    tmux = RecordingTmux({cursor.id: CURSOR_RUNNING_SCREEN})
    sessions = [
        Session(
            name="cursor-one", id="$1", windows=1, attached=0, created=1, panes=[cursor]
        ),
        Session(
            name="codex-one",
            id="$2",
            windows=1,
            attached=0,
            created=1,
            panes=[idle_codex],
        ),
    ]

    states = await AgentStateDetector().detect_sessions(
        cast(TmuxClient, tmux), sessions
    )

    assert states["cursor-one"].name == "working"
    assert states["codex-one"].name == "waiting_human"
    assert tmux.captured == [cursor.id]
