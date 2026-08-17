import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest

from tmux_console.status import AgentStateDetector, classify_agent_state
from tmux_console.tmux import (
    CLIENT_IDENTITY_FORMAT,
    CREATED_SESSION_FORMAT,
    MAX_SESSION_NAME_LENGTH,
    OUTPUT_FIELD_SEPARATOR,
    PANE_FORMAT,
    PANE_FORMAT_FIELDS,
    CreatedSession,
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
    tmux = RecordingRunTmux("muxdeck-abc123def456\t$9\n")

    created = await tmux.create_session()

    assert created == CreatedSession(name="muxdeck-abc123def456", id="$9")
    assert tmux.calls == [
        [
            "new-session",
            "-d",
            "-P",
            "-F",
            CREATED_SESSION_FORMAT,
            "-s",
            "muxdeck-abc123def456",
            "-c",
            str(Path.home()),
        ]
    ]


async def test_create_session_preserves_a_requested_name_exactly():
    requested_name = "  work/name #1  "
    tmux = RecordingRunTmux(f"{requested_name}\t$12\n")

    created = await tmux.create_session(requested_name)

    assert created == CreatedSession(name=requested_name, id="$12")
    assert tmux.calls == [
        [
            "new-session",
            "-d",
            "-P",
            "-F",
            CREATED_SESSION_FORMAT,
            "-s",
            "  work/name ##1  ",
            "-c",
            str(Path.home()),
        ]
    ]


async def test_create_session_validates_a_requested_name_before_running_tmux():
    tmux = RecordingRunTmux("")

    with pytest.raises(ValueError, match="cannot contain"):
        await tmux.create_session("invalid.name")

    assert tmux.calls == []


@pytest.mark.parametrize("output", ["", "\n", "0\n1\n"])
async def test_create_session_rejects_missing_or_ambiguous_name(output: str):
    tmux = RecordingRunTmux(output)

    with pytest.raises(TmuxError, match="tmux did not return the created session name"):
        await tmux.create_session()


async def test_create_session_rejects_an_unexpected_returned_name(monkeypatch):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123def456")
    tmux = RecordingRunTmux("some-other-session\t$1\n")

    with pytest.raises(TmuxError, match="unexpected created session name"):
        await tmux.create_session()


async def test_create_session_rejects_an_invalid_returned_id(monkeypatch):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123def456")
    tmux = RecordingRunTmux("muxdeck-abc123def456\tnot-an-id\n")

    with pytest.raises(TmuxError, match="created session id"):
        await tmux.create_session()


@pytest.mark.parametrize(
    ("action", "command", "mode_condition"),
    [
        (
            "page-up",
            "copy-mode -u",
            "#{||:#{==:#{pane_mode},},#{==:#{pane_mode},copy-mode}}",
        ),
        ("page-down", "send-keys -X page-down", "#{==:#{pane_mode},copy-mode}"),
        ("exit", "send-keys -X cancel", "#{==:#{pane_mode},copy-mode}"),
    ],
)
async def test_navigate_history_dispatches_in_the_exact_client_context(
    monkeypatch,
    action: str,
    command: str,
    mode_condition: str,
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    tmux = RecordingRunTmux(
        [
            "12\t/dev/pts/2\t$2\n4321\t/dev/pts/7\t$7\n",
            *([""] * 9),
            "ok:4321:$7:%12\n",
            *([""] * 6),
        ]
    )

    pane_id = await tmux.navigate_history(4321, "$7", action)

    assert pane_id == "%12"
    table_name = "muxdeck-history-abc123"
    result_option = "@muxdeck-history-abc123"
    identity_condition = "#{&&:#{==:#{client_pid},4321},#{==:#{session_id},$7}}"
    rejected_commands = (
        f"set-option -gF {result_option} "
        "'rejected:#{client_pid}:#{session_id}:#{pane_id}' ; "
        f"wait-for -S {table_name}"
    )
    assert tmux.calls == [
        ["list-clients", "-F", CLIENT_IDENTITY_FORMAT],
        ["list-keys", "-a"],
        ["show-options", "-s", "user-keys"],
        *[
            ["bind-key", "-T", guarded_table, "User999", rejected_commands]
            for guarded_table in ("copy-mode", "copy-mode-vi", "prefix", "root")
        ],
        [
            "bind-key",
            "-T",
            table_name,
            "User999",
            "if-shell",
            "-F",
            f"#{{&&:{identity_condition},{mode_condition}}}",
            (
                f"{command} ; set-option -gF {result_option} "
                "'ok:#{client_pid}:#{session_id}:#{pane_id}' ; "
                f"wait-for -S {table_name}"
            ),
            rejected_commands,
        ],
        [
            "bind-key",
            "-T",
            table_name,
            "Any",
            f"send-keys ; switch-client -T {table_name}",
        ],
        [
            "switch-client",
            "-c",
            "/dev/pts/7",
            "-T",
            table_name,
            ";",
            "send-keys",
            "-K",
            "-c",
            "/dev/pts/7",
            "User999",
            ";",
            "wait-for",
            table_name,
        ],
        ["show-options", "-gv", result_option],
        ["unbind-key", "-a", "-T", table_name],
        *[
            ["unbind-key", "-T", guarded_table, "User999"]
            for guarded_table in ("root", "prefix", "copy-mode-vi", "copy-mode")
        ],
        ["set-option", "-gu", result_option],
    ]


async def test_navigate_history_rejects_a_client_context_mismatch_and_cleans_up(
    monkeypatch,
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    tmux = RecordingRunTmux(
        [
            "4321\t/dev/pts/7\t$7\n",
            *([""] * 9),
            "rejected:4321:$7:%12\n",
            *([""] * 6),
        ]
    )

    with pytest.raises(TmuxError, match="rejected"):
        await tmux.navigate_history(4321, "$7", "exit")

    assert tmux.calls[-6:] == [
        ["unbind-key", "-a", "-T", "muxdeck-history-abc123"],
        ["unbind-key", "-T", "root", "User999"],
        ["unbind-key", "-T", "prefix", "User999"],
        ["unbind-key", "-T", "copy-mode-vi", "User999"],
        ["unbind-key", "-T", "copy-mode", "User999"],
        ["set-option", "-gu", "@muxdeck-history-abc123"],
    ]


async def test_navigate_history_cleans_a_guard_after_bind_reports_failure(
    monkeypatch,
):
    monkeypatch.setattr("tmux_console.tmux.secrets.token_hex", lambda _: "abc123")
    bind_failure = TmuxError("tmux command timed out")
    tmux = RecordingRunTmux(
        [
            "4321\t/dev/pts/7\t$7\n",
            "",
            "",
            bind_failure,
            "",
            "",
            "",
        ]
    )

    with pytest.raises(TmuxError, match="timed out") as raised:
        await tmux.navigate_history(4321, "$7", "page-up")

    assert raised.value is bind_failure
    assert tmux.calls[-3:] == [
        ["unbind-key", "-a", "-T", "muxdeck-history-abc123"],
        ["unbind-key", "-T", "copy-mode", "User999"],
        ["set-option", "-gu", "@muxdeck-history-abc123"],
    ]


@pytest.mark.parametrize(
    "output",
    ["4321\t/dev/pts/7\t$8\n", "12\t/dev/pts/7\t$7\n", ""],
)
async def test_navigate_history_rejects_wrong_or_missing_client(output: str):
    tmux = RecordingRunTmux(output)

    with pytest.raises(TmuxError):
        await tmux.navigate_history(4321, "$7", "page-up")


@pytest.mark.parametrize(
    ("client_pid", "session_id", "action", "message"),
    [
        (0, "$7", "page-up", "invalid tmux client pid"),
        (True, "$7", "page-up", "invalid tmux client pid"),
        (4321, "agent", "page-up", "invalid tmux session id"),
        (4321, "$7", "PAGE-UP", "invalid terminal history action"),
        (4321, "$7", " page-up", "invalid terminal history action"),
    ],
)
async def test_navigate_history_rejects_invalid_targets_and_actions_without_tmux(
    client_pid: int,
    session_id: str,
    action: str,
    message: str,
):
    tmux = RecordingRunTmux("")

    with pytest.raises(ValueError, match=message):
        await tmux.navigate_history(client_pid, session_id, action)

    assert tmux.calls == []


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
    tmux = RecordingRunTmux(["", pane_row(session_name="tmux-result", session_id="$7")])

    renamed = await tmux.rename_session("work", "requested", session_id="$7")

    assert renamed == "tmux-result"


async def test_rename_session_escapes_tmux_format_expansion_in_the_name():
    requested_name = "literal-#{pid}-#(not-a-command)"
    tmux = RecordingRunTmux(
        ["", pane_row(session_name=requested_name, session_id="$7")]
    )

    renamed = await tmux.rename_session("work", requested_name, session_id="$7")

    assert renamed == requested_name
    assert tmux.calls[0] == [
        "rename-session",
        "-t",
        "$7",
        "--",
        "literal-##{pid}-##(not-a-command)",
    ]


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
    tmux = RecordingRunTmux([failure, pane_row(session_name="work", session_id="$7")])

    with pytest.raises(TmuxError, match="rename denied") as raised:
        await tmux.rename_session("work", "renamed", session_id="$7")

    assert raised.value is failure


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("", "required"),
        ("   ", "required"),
        ("line\nbreak", "control"),
        ("next\x85line", "control"),
        ("left\u2028right", "line separators"),
        ("left\u2029right", "line separators"),
        (r"path\name", "cannot contain"),
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


def test_claude_circle_spinner_titles_are_working_signals():
    for title in (
        "\u25d0 Implement the sample dashboard",
        "\u25d3 Claude Code",
        "\u25d1 Claude Code",
        "\u25d2 Claude Code",
    ):
        assert (
            classify_agent_state(
                agent_pane(command="claude", title=title), now=1000
            ).name
            == "working"
        )

    working = agent_pane(command="claude", title="\u25d0 Claude Code")
    assert (
        classify_agent_state(
            working,
            visible_screen="\u273b Waiting for background terminal",
            now=1000,
        ).name
        == "waiting_command"
    )
    assert (
        classify_agent_state(replace(working, activity=900), now=1000).name == "unknown"
    )
    assert (
        classify_agent_state(
            agent_pane(command="bash", title="\u25d0 Claude Code"), now=1000
        ).name
        == "other"
    )


@pytest.mark.parametrize(
    "headline",
    [
        "\u273b Waiting for 1 background agent to finish",
        "\u273d Waiting for 4 background agents to finish",
        "\u2736 Waiting for 1 dynamic workflow to finish",
        "\u2733 Waiting for 3 dynamic workflows to finish",
        "\u273b Waiting for 2 background agents and 1 dynamic workflow to finish",
    ],
)
def test_claude_background_work_banners_are_distinct_from_active_work(
    headline: str,
):
    working = agent_pane(command="claude", title="\u25d0 Claude Code")
    screen = (
        "\u25cf Phase 2 agents started\n\n"
        f"{headline}\n\n"
        "  5 tasks (0 done, 1 in progress, 4 open)\n"
        "  \u25fc Foundation build"
    )

    state = classify_agent_state(working, visible_screen=screen, now=1000)

    assert state.name == "waiting_command"
    assert state.reason == "Agent is waiting for background work"
    assert (
        classify_agent_state(
            replace(working, activity=900), visible_screen=screen, now=1000
        ).name
        == "waiting_command"
    )


def test_claude_background_work_banner_can_wrap_across_terminal_lines():
    screen = (
        "\u273b Waiting for 2 background agents and 3 dynamic\n"
        "  workflows to finish\n\n"
        "  5 tasks (0 done, 1 in progress, 4 open)"
    )

    assert (
        classify_agent_state(
            agent_pane(command="claude", title="\u25d1 Claude Code"),
            visible_screen=screen,
            now=1000,
        ).name
        == "waiting_command"
    )


def test_claude_background_work_banner_survives_a_dense_visible_task_panel():
    working = agent_pane(command="claude", title="\u25d1 Claude Code")
    screen = "\u273b Waiting for 1 dynamic workflow to finish\n\n" + "\n".join(
        f"  task or agent row {index}" for index in range(24)
    )

    for pane in (working, replace(working, activity=900)):
        assert (
            classify_agent_state(pane, visible_screen=screen, now=1000).name
            == "waiting_command"
        )


def test_claude_uses_only_the_latest_activity_headline_for_background_work():
    working = agent_pane(command="claude", title="\u25d1 Claude Code")
    resumed = (
        "\u273b Waiting for 1 dynamic workflow to finish\n\n"
        "\u25cf Workflow returned successfully\n\n"
        "\u273d Writing integration tests"
    )
    waiting_again = (
        f"{resumed}\n\n"
        "\u273b Waiting for 2 dynamic workflows to finish\n\n"
        "  3 tasks (1 done, 2 in progress)"
    )

    assert (
        classify_agent_state(working, visible_screen=resumed, now=1000).name
        == "working"
    )
    assert (
        classify_agent_state(working, visible_screen=waiting_again, now=1000).name
        == "waiting_command"
    )


def test_claude_ignores_indented_headline_glyphs_in_nested_output():
    working = agent_pane(command="claude", title="\u25d1 Claude Code")

    assert (
        classify_agent_state(
            working,
            visible_screen=(
                "\u25cf Implementing parser\n\n"
                "  \u273b Waiting for 1 dynamic workflow to finish"
            ),
            now=1000,
        ).name
        == "working"
    )
    assert (
        classify_agent_state(
            working,
            visible_screen=(
                "\u273b Waiting for 1 dynamic workflow to finish\n\n"
                "  \u25cf fixture output"
            ),
            now=1000,
        ).name
        == "waiting_command"
    )


@pytest.mark.parametrize(
    "screen",
    [
        "The docs quote: Waiting for 1 dynamic workflow to finish",
        "\u273b Waiting for 0 dynamic workflows to finish",
        "\u273b Waiting for 1 dynamic workflow",
    ],
)
def test_claude_does_not_guess_background_work_from_non_current_prose(screen: str):
    assert (
        classify_agent_state(
            agent_pane(command="claude", title="\u25d0 Claude Code"),
            visible_screen=screen,
            now=1000,
        ).name
        == "working"
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


def test_grok_agent_state_follows_its_tmux_title_signals():
    working = agent_pane(
        command="grok", title="\u2839 - Waiting for response\u2026 - grok"
    )

    assert classify_agent_state(working, now=1000).name == "working"
    assert (
        classify_agent_state(
            working,
            visible_screen="Waiting for background terminal",
            now=1000,
        ).name
        == "waiting_command"
    )
    assert (
        classify_agent_state(replace(working, activity=900), now=1000).name == "unknown"
    )
    for idle_title in ("grok", "Review Grok support - grok"):
        assert (
            classify_agent_state(
                agent_pane(command="grok", title=idle_title), now=1000
            ).name
            == "waiting_human"
        )
    assert (
        classify_agent_state(
            agent_pane(command="grok", title="root@host: ~/repo"), now=1000
        ).name
        == "unknown"
    )
    assert (
        classify_agent_state(agent_pane(command="grok", title=""), now=1000).name
        == "unknown"
    )


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


async def test_detect_sessions_captures_claude_background_waits_after_activity_stales():
    claude = agent_pane(
        id="%44",
        command="claude",
        title="\u25d1 Claude Code",
        activity=int(time.time()) - 120,
    )
    tmux = RecordingTmux(
        {
            claude.id: (
                "\u25cf Phase 2 agents started\n\n"
                "\u273b Waiting for 1 dynamic workflow to finish\n\n"
                "  5 tasks (0 done, 1 in progress, 4 open)"
            )
        }
    )
    sessions = [
        Session(
            name="claude-working",
            id="$3",
            windows=1,
            attached=0,
            created=1,
            panes=[claude],
        )
    ]

    states = await AgentStateDetector().detect_sessions(
        cast(TmuxClient, tmux), sessions
    )

    assert states["claude-working"].name == "waiting_command"
    assert tmux.captured == [claude.id]


async def test_detect_sessions_captures_only_working_grok_panes():
    working = agent_pane(
        id="%45",
        command="grok",
        title="\u2839 - Waiting for response\u2026 - grok",
        activity=int(time.time()),
    )
    idle = agent_pane(id="%46", command="grok", title="Grok task - grok")
    tmux = RecordingTmux({working.id: "Waiting for background terminal"})
    sessions = [
        Session(
            name="grok-working",
            id="$3",
            windows=1,
            attached=0,
            created=1,
            panes=[working],
        ),
        Session(
            name="grok-idle",
            id="$4",
            windows=1,
            attached=0,
            created=1,
            panes=[idle],
        ),
    ]

    states = await AgentStateDetector().detect_sessions(
        cast(TmuxClient, tmux), sessions
    )

    assert states["grok-working"].name == "waiting_command"
    assert states["grok-idle"].name == "waiting_human"
    assert tmux.captured == [working.id]
