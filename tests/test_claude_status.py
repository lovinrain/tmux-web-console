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
