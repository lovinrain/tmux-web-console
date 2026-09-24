"""Claude status regressions for the expandable panel below its input footer."""

from dataclasses import replace

import pytest

from tmux_console.status import classify_agent_state
from tmux_console.tmux import Pane

CLAUDE_MODE_FOOTER = "⏵⏵ bypass permissions on (shift+tab to cycle)"
CLAUDE_RUNNING_STATUS = (
    "· Cerebrating… (27m 57s · ↓ 110.4k tokens · still thinking with max effort)"
)


def claude_pane(title: str = "✳ Review changes") -> Pane:
    return Pane(
        id="%42",
        index=0,
        window_index=0,
        window_name="agent",
        window_active=True,
        active=True,
        command="claude",
        path="/work/project",
        title=title,
        width=100,
        height=70,
        history_size=0,
        history_limit=2000,
        alternate_on=False,
        dead=False,
        activity=990,
    )


def agent_panel(rows: int = 6, *, wrapped: bool = False) -> str:
    lines = ["", "  ● main"]
    for index in range(rows):
        lines.append(f"  ◯ general-purpose › Review component {index + 1}")
        if wrapped:
            lines.append("      Check its behavior and summarize the result")
    lines.append("  ↓ 6 more")
    return "\n".join(lines)


def input_screen(
    *,
    transcript: str = "● Reviewing the requested changes.",
    status: str = "",
    prompt: str = "❯ ",
    footer: str = CLAUDE_MODE_FOOTER,
    panel: str = "",
) -> str:
    return f"{transcript}\n\n{status}\n\n{prompt}\n{footer}\n{panel}"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
@pytest.mark.parametrize(
    ("rows", "wrapped"), [(6, False), (24, False), (6, True)]
)
def test_running_turn_remains_visible_above_an_expanded_agent_panel(
    title: str, rows: int, wrapped: bool
):
    # Sanitized from a live Claude screen: the agents panel follows the mode
    # footer, pushing both the status and interrupt hint above the screen tail.
    screen = input_screen(
        status=CLAUDE_RUNNING_STATUS,
        footer=f"{CLAUDE_MODE_FOOTER} · esc to interrupt · ← 4 agents · ↓ to manage",
        panel=agent_panel(rows, wrapped=wrapped),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "working"
    assert state.reason == "Claude is running a turn"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_interrupt_footer_identifies_running_turn_even_without_a_status_row(
    title: str,
):
    screen = input_screen(
        footer=f"{CLAUDE_MODE_FOOTER} · esc to interrupt · ← 4 agents",
        panel=agent_panel(24, wrapped=True),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "working"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_typing_a_follow_up_does_not_hide_running_turn_above_agent_panel(title: str):
    screen = input_screen(
        status=CLAUDE_RUNNING_STATUS,
        prompt="❯ also update the sample\n  and keep the same behavior",
        panel=agent_panel(24, wrapped=True),
    )
    assert "esc to interrupt" not in screen

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "working"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_wrapped_mode_footer_is_read_above_the_agent_panel(title: str):
    screen = input_screen(
        footer=(
            f"{CLAUDE_MODE_FOOTER} ·\n"
            "  esc to interrupt · ← 4 agents · ↓ to manage"
        ),
        panel=agent_panel(6, wrapped=True),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "working"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
@pytest.mark.parametrize("wrapped", [False, True])
def test_idle_prompt_remains_ready_with_an_expanded_agent_panel(
    title: str, wrapped: bool
):
    screen = input_screen(
        transcript="● Finished the requested update.",
        panel=agent_panel(24, wrapped=wrapped),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"
    assert state.reason == "Claude is paused at its input prompt"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_expanded_panel_does_not_make_a_stale_running_indicator_fresh(title: str):
    screen = input_screen(
        status=CLAUDE_RUNNING_STATUS,
        footer=f"{CLAUDE_MODE_FOOTER} · esc to interrupt",
        panel=agent_panel(24),
    )

    state = classify_agent_state(
        replace(claude_pane(title), activity=900), visible_screen=screen, now=1000
    )

    assert state.name == "unknown"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_old_running_prompt_in_transcript_does_not_override_current_idle_prompt(
    title: str,
):
    old_turn = input_screen(
        status=CLAUDE_RUNNING_STATUS,
        footer=f"{CLAUDE_MODE_FOOTER} · esc to interrupt",
    )
    screen = input_screen(
        transcript=f"{old_turn}\n● Finished the requested update.",
        panel=agent_panel(24),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
@pytest.mark.parametrize(
    "quoted_text",
    [
        'Document the "esc to interrupt" shortcut',
        f'Example: "{CLAUDE_MODE_FOOTER} · esc to interrupt"',
    ],
)
def test_interrupt_words_in_agent_description_do_not_report_running(
    title: str, quoted_text: str
):
    screen = input_screen(
        transcript="● Finished the requested update.",
        panel=f"\n● main\n  ◯ general-purpose › {quoted_text}",
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host"])
def test_quoted_interrupt_in_transcript_does_not_override_idle_panel(title: str):
    screen = input_screen(
        transcript=(
            'The docs mention "esc to interrupt" during a turn.\n'
            f'  Example footer: "{CLAUDE_MODE_FOOTER} · esc to interrupt"\n'
            "● Finished the requested update."
        ),
        panel=agent_panel(24, wrapped=True),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"


def test_old_agent_roster_does_not_hide_a_newer_finished_transcript():
    old_turn = input_screen(
        status=CLAUDE_RUNNING_STATUS,
        footer=f"{CLAUDE_MODE_FOOTER} · esc to interrupt",
        panel=agent_panel(24),
    )
    # The next prompt may not have been drawn yet when the pane is captured.
    # A transcript headline is not another row in the older agent roster.
    screen = (
        f"{old_turn}\n\n"
        "● Finished the requested update.\n"
        "  The changes are ready for review."
    )

    state = classify_agent_state(claude_pane(), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"


def background_screen(headline: str) -> str:
    # Claude can draw its update notice and named input separator directly below
    # a background-wait headline, without a blank row between them.
    return (
        f"{headline}\n"
        f"{' ' * 80}✔ Update installed · Restart to update\n"
        f"{'─' * 70} sample-session ─\n"
        "❯ \n"
        f"{'─' * 88}\n"
        "⏸ plan mode on (shift+tab to cycle) · ← 4 agents · ↓ to manage\n"
        "\n"
        "  ● main\n"
        "  ◯ Plan Reviewing sample sources          11m 8s · 12.5k tokens"
    )


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host", "◐ Claude Code"])
@pytest.mark.parametrize(
    "headline",
    [
        "✻ Waiting for 1 background agent to finish",
        "✻ Waiting for 2 background agents and 3 dynamic\n  workflows to finish",
    ],
)
def test_idle_main_with_running_agents_survives_adjacent_footer_notices(
    title: str, headline: str
):
    state = classify_agent_state(
        replace(claude_pane(title), activity=900),
        visible_screen=background_screen(headline),
        now=1000,
    )

    assert state.name == "working"
    assert state.reason == "Claude has active background work"


def test_legacy_background_wait_survives_adjacent_footer_notices():
    state = classify_agent_state(
        claude_pane(),
        visible_screen=background_screen("✻ Waiting for agents"),
        now=1000,
    )

    assert state.name == "waiting_command"
    assert state.reason == "Agent is waiting for background work"


def test_finished_agents_override_an_older_wait_above_footer_notices():
    screen = background_screen(
        "✻ Waiting for 1 background agent to finish\n"
        "● All agents finished. The changes are ready."
    )

    state = classify_agent_state(claude_pane(), visible_screen=screen, now=1000)

    assert state.name == "waiting_human"


@pytest.mark.parametrize(
    "headline",
    [
        "✻ Waiting for 0 background agents to finish",
        "✻ Waiting for 1 background agent",
        "  ✻ Waiting for 1 background agent to finish",
        "✻ Waiting for 1 background agent to finish is an example",
        'The docs quote "✻ Waiting for 1 background agent to finish"',
    ],
)
def test_footer_notices_do_not_turn_noncurrent_wait_text_into_activity(headline: str):
    state = classify_agent_state(
        claude_pane(), visible_screen=background_screen(headline), now=1000
    )

    assert state.name == "waiting_human"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host", "◐ Claude Code"])
@pytest.mark.parametrize("activity", [900, 990])
@pytest.mark.parametrize("count", ["1 shell", "12 shells", "2 shells, 1 monitor"])
def test_running_background_shell_uses_current_footer(
    title: str, activity: int, count: str
):
    # Claude 2.1.273–281 renders this count from pending/running background
    # shell tasks, even after the foreground agent has returned to its prompt.
    screen = input_screen(
        transcript="● The command is running in the background.",
        footer=f"{CLAUDE_MODE_FOOTER} · {count}",
        panel=agent_panel(24, wrapped=True),
    )

    state = classify_agent_state(
        replace(claude_pane(title), activity=activity), visible_screen=screen, now=1000
    )

    assert state.name == "running_command"
    assert state.reason == "Claude has a running background shell"


def test_background_shell_count_can_wrap_with_the_mode_footer():
    screen = input_screen(
        footer=f"{CLAUDE_MODE_FOOTER} ·\n  2\n  shells · ↓ to manage",
        panel=agent_panel(6),
    )

    assert classify_agent_state(
        replace(claude_pane(), activity=900), visible_screen=screen, now=1000
    ).name == "running_command"


@pytest.mark.parametrize(
    "extra",
    ["0 shells", "1 shell command", "1 shell completed", "2 background tasks",
     "1 monitor", "2 local agents", "example: 1 shell", '"1 shell"'],
)
def test_other_footer_counts_are_not_running_shells(extra: str):
    screen = input_screen(footer=f"{CLAUDE_MODE_FOOTER} · {extra}")

    assert classify_agent_state(
        claude_pane(), visible_screen=screen, now=1000
    ).name == "waiting_human"


@pytest.mark.parametrize(
    "screen",
    [
        input_screen(transcript="● Bash(sleep 1)\n  ⎿ Running in the background (↓ to manage)"),
        input_screen(prompt="❯ document 1 shell\n  · 2 shells"),
        input_screen(panel="\n  ● main\n  ◯ helper › Explain · 1 shell"),
        input_screen(transcript=input_screen(footer=f"{CLAUDE_MODE_FOOTER} · 1 shell")),
    ],
)
def test_historical_or_quoted_shell_counts_do_not_override_idle_prompt(screen: str):
    assert classify_agent_state(
        claude_pane(), visible_screen=screen, now=1000
    ).name == "waiting_human"


@pytest.mark.parametrize("title", ["✳ Review changes", "build-host", "◐ Claude Code"])
@pytest.mark.parametrize(
    "transcript",
    [
        "● Running 1 shell command…",
        "● Running 3 shell commands...",
        "● Bash(sleep 10)\n  ⎿ Running… (5s)",
        "● PowerShell(Start-Sleep 10)\n  ⎿ Running...",
        "● Bash(make test)\n  ⎿ Test output\n  (ctrl+b ctrl+b (twice) to run in background)",
    ],
)
def test_current_foreground_shell_is_distinct_from_agent_work(
    title: str, transcript: str
):
    screen = input_screen(
        transcript=transcript,
        status=CLAUDE_RUNNING_STATUS,
        prompt="❯ and summarize the test results",
        panel=agent_panel(24),
    )

    state = classify_agent_state(claude_pane(title), visible_screen=screen, now=1000)

    assert state.name == "running_command"
    assert state.reason == "Claude is running a terminal command"


@pytest.mark.parametrize(
    "transcript",
    [
        "● Ran 1 shell command",
        "● Running 0 shell commands…",
        "● Explain Running 1 shell command…",
        "● Example\n  ● Running 1 shell command…",
        "● Bash(sleep 1)\n  ⎿ Running in the background (↓ to manage)",
        "● Bash(echo done)\n  ⎿ Done",
        "● Read(document.txt)\n  ⎿ Running…",
        "● Running 1 shell command…\n● The command finished.",
        "● Bash(sleep 1)\n  ⎿ Running…\n● Read(document.txt)",
        "● Bash(sleep 1)\n  ⎿ Running…\n✻ Cooked for 1m",
        "● Running 1 shell command…\n❯ previous turn",
    ],
)
def test_foreground_command_requires_latest_active_tool_block(transcript: str):
    screen = input_screen(transcript=transcript, status=CLAUDE_RUNNING_STATUS)

    assert classify_agent_state(
        claude_pane(), visible_screen=screen, now=1000
    ).name == "working"


@pytest.mark.parametrize(
    "transcript", ["● Running 1 shell command…", "● Bash(sleep 1)\n  ⎿ Running…"]
)
def test_old_foreground_tool_is_not_running_at_an_idle_prompt(transcript: str):
    screen = input_screen(transcript=transcript)

    assert classify_agent_state(
        claude_pane(), visible_screen=screen, now=1000
    ).name == "waiting_human"


def test_foreground_command_requires_fresh_turn_activity():
    screen = input_screen(
        transcript="● Running 1 shell command…", status=CLAUDE_RUNNING_STATUS
    )

    assert classify_agent_state(
        replace(claude_pane(), activity=900), visible_screen=screen, now=1000
    ).name == "unknown"
