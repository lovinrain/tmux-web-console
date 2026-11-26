import time
from dataclasses import replace
from typing import cast

import pytest

from tmux_console.status import AgentStateDetector, classify_agent_state, classify_agent_type
from tmux_console.tmux import Pane, Session, TmuxClient


RULE = "────────────────────────────────────"
PI_FOOTER = "/work (main)\n0.0%/128k (auto)                probe-model"
PI_IDLE = f"{RULE}\n\n{RULE}\n{PI_FOOTER}"
OMP_IDLE = " π > ⬢ Probe Model > work ▶────19%────────16K─\n╰─"
OPENCODE_IDLE = "┃ Ask anything\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\nshift+tab agents  ctrl+p commands"
AGY_IDLE = f"{RULE}\n>\n{RULE}\n? for shortcuts                Gemini"


def pane(command: str, title: str = "", *, now: int = 1000) -> Pane:
    return Pane(
        id="%1", index=0, window_index=0, window_name="work", window_active=True,
        active=True, command=command, path="/work", title=title, width=100, height=30,
        history_size=0, history_limit=2000, alternate_on=False, dead=False, activity=now,
    )


@pytest.mark.parametrize(
    ("command", "title", "expected"),
    [
        ("pi", "π - work", "pi"),
        ("omp", "π > work", "omp"),
        ("opencode", "OpenCode", "opencode"),
        ("opencode.v1.2.20", "OC | Conversation", "opencode"),
        ("opencode.v1.2.2", "OC | Conversation", "opencode"),
        ("agy", "inherited", "agy"),
        ("bash", "π > work", None),
        ("node", "π - work", None),
        ("opencode-helper", "OpenCode", None),
    ],
)
def test_agent_process_identification(command, title, expected):
    observed = pane(command, title)
    assert classify_agent_type(observed) == expected
    assert classify_agent_type(replace(observed, dead=True)) is None


@pytest.mark.parametrize(
    ("screen", "expected"),
    [
        (PI_IDLE, "waiting_human"),
        (f"── ⠸ Working ─────────────\n\n{RULE}\n{PI_FOOTER}", "working"),
        (f"───⠸───────────\n\n{RULE}\n{PI_FOOTER}", "working"),
        (f"── ↑ 3 more ───\nDraft\n── ↓ 2 more ───\n{PI_FOOTER}", "waiting_human"),
        (f"$ sleep 3\n⠼ Running... (escape/ctrl+c to cancel)\n{PI_IDLE}", "running_command"),
        (f"── ⠸ Working ─────────────\nPrior output\n{PI_IDLE}", "waiting_human"),
        (f"{RULE}\n0.0%/128k (auto) probe-model", "unknown"),
    ],
)
def test_pi_detects_state_from_its_composer(screen, expected):
    assert classify_agent_state(pane("pi", "π - work"), screen, now=1000).name == expected


def test_pi_model_selector_is_a_user_decision():
    state = classify_agent_state(
        pane("pi", "π - work"),
        "Only showing models from configured providers.\n"
        "→ ✓ probe-model [probe]\n"
        "Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel",
        now=1000,
    )
    assert state.name == "waiting_human"
    assert state.reason == "Pi is waiting on a selection"


@pytest.mark.parametrize(
    ("title", "screen", "expected"),
    [
        ("π > work", OMP_IDLE, "waiting_human"),
        ("π: work", OMP_IDLE, "waiting_human"),
        ("π : work", OMP_IDLE, "working"),
        ("π ⠋ work", OMP_IDLE, "working"),
        ("π > work", f"  ⎋ Working…\n{OMP_IDLE}", "working"),
        ("π ! work", None, "waiting_human"),
        ("π > work", f"─── ⣾ Running… (⎋ to cancel) ──\n\n{OMP_IDLE}", "running_command"),
        ("π > work", "Press ⏎ to skip", "unknown"),
    ],
)
def test_omp_detects_state_from_title_and_current_controls(title, screen, expected):
    assert classify_agent_state(pane("omp", title), screen, now=1000).name == expected


@pytest.mark.parametrize(
    ("screen", "expected"),
    [
        (OPENCODE_IDLE, "waiting_human"),
        (OPENCODE_IDLE.replace("shift+tab", "tab"), "waiting_human"),
        ("┃ Ask anything…\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", "waiting_human"),
        ("▪ oc mini v2.4.2 · /work\n┃ Ask anything\nDefault · probe-model · probe · ctrl+p menu",
         "waiting_human"),
        (OPENCODE_IDLE.replace(
            "shift+tab agents", "■■■■⬝⬝ esc interrupt    shift+tab agents"
        ), "working"),
        (f" ⠙ New session                  +\n{OPENCODE_IDLE}", "working"),
        (f"■■⬝⬝ esc interrupt\nOld output\n{OPENCODE_IDLE}", "waiting_human"),
        ("The docs say esc interrupt during an active turn.", "unknown"),
    ],
)
def test_opencode_detects_legacy_current_and_mini_views(screen, expected):
    assert classify_agent_state(pane("opencode", "OpenCode"), screen, now=1000).name == expected


def test_opencode_approval_takes_priority_over_tool_activity():
    state = classify_agent_state(
        pane("opencode.v1.2.20", "OC | Conversation"),
        " ! Conversation                   +\n"
        "┃  ⠹ pwd\n"
        "┃  △ Permission required\n"
        "┃  Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm",
        now=1000,
    )
    assert state.name == "waiting_human"
    assert state.reason == "OpenCode is waiting on an approval decision"


@pytest.mark.parametrize("heading", ["Select model", "Search models", "Search commands"])
def test_opencode_selectors_can_keep_the_idle_footer(heading):
    state = classify_agent_state(
        pane("opencode", "OpenCode"),
        f"    {heading}                  esc\n    Search\n{OPENCODE_IDLE}",
        now=1000,
    )
    assert state.name == "waiting_human"
    assert state.reason == "OpenCode is waiting on a selection"


@pytest.mark.parametrize(
    ("screen", "expected"),
    [
        (AGY_IDLE, "waiting_human"),
        (AGY_IDLE.replace("\n>\n", "\n> A draft\nsecond line\n"), "waiting_human"),
        (f"Thinking... 12s\n{AGY_IDLE}", "working"),
        (f"Thinking... 12s\n1/2 steps\n{AGY_IDLE}", "working"),
        (f"Thinking... 12s\nA previous reply.\n{AGY_IDLE}", "waiting_human"),
        (f"Running command... 18s\n{AGY_IDLE}", "running_command"),
        ("Welcome to the Antigravity CLI. You are currently not signed in.\n"
         "Select login method:\n↑/↓ Navigate · enter Select", "waiting_human"),
        ("Yes, and always allow 'pwd' in this conversation\nNo, deny access", "waiting_human"),
        ("Thinking... 12s\nA partial terminal capture.", "unknown"),
        ("? for shortcuts", "unknown"),
    ],
)
def test_agy_requires_current_native_controls(screen, expected):
    assert classify_agent_state(pane("agy"), screen, now=1000).name == expected


def test_stale_agent_indicator_cannot_keep_a_pane_working():
    state = classify_agent_state(pane("omp", "π : work", now=900), OMP_IDLE, now=1000)
    assert state.name == "unknown"
    assert state.reason == "Agent activity indicator is stale"


@pytest.mark.asyncio
async def test_detector_captures_current_agent_controls():
    captures = {
        "%1": PI_IDLE,
        "%2": f"─── ⣾ Running… (⎋ to cancel) ──\n\n{OMP_IDLE}",
        "%3": OPENCODE_IDLE,
        "%4": AGY_IDLE,
    }

    class CaptureTmux:
        async def capture_visible(self, pane_id):
            return captures[pane_id]

    observed_at = int(time.time())
    sessions = [
        Session(name=command, id=f"${index}", windows=1, attached=0, created=1,
                panes=[replace(pane(command, title, now=observed_at), id=f"%{index}")])
        for index, (command, title) in enumerate(
            [("pi", "π - work"), ("omp", "π > work"), ("opencode", "OpenCode"), ("agy", "")],
            start=1,
        )
    ]
    results = await AgentStateDetector().detect_sessions(cast(TmuxClient, CaptureTmux()), sessions)
    assert {name: state.name for name, state in results.items()} == {
        "pi": "waiting_human", "omp": "running_command",
        "opencode": "waiting_human", "agy": "waiting_human",
    }
