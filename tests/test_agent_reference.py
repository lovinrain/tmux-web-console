from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tmux_console.agent_reference import (
    AgentReference,
    AgentReferenceDetector,
    discover_agent_session_id,
)
from tmux_console.tmux import Pane, Session


def pane(*, command: str, title: str = "", process_pid: int = 100) -> Pane:
    return Pane(
        id="%1",
        index=0,
        window_index=0,
        window_name="main",
        window_active=True,
        active=True,
        command=command,
        path="/work",
        title=title,
        width=100,
        height=30,
        history_size=0,
        history_limit=2000,
        alternate_on=False,
        dead=False,
        activity=1,
        process_pid=process_pid,
    )


def session(active_pane: Pane) -> Session:
    return Session(
        name="agent",
        id="$1",
        windows=1,
        attached=0,
        created=1,
        panes=[active_pane],
    )


def process(proc_root: Path, process_id: int, arguments: list[str]) -> Path:
    root = proc_root / str(process_id)
    (root / "task" / str(process_id)).mkdir(parents=True)
    (root / "task" / str(process_id) / "children").write_text("", encoding="ascii")
    (root / "cmdline").write_bytes(b"\0".join(value.encode() for value in arguments))
    (root / "fd").mkdir()
    return root


def test_discovers_codex_rollout_from_a_bounded_child_process(tmp_path: Path):
    proc_root = tmp_path / "proc"
    parent = process(proc_root, 100, ["/bin/bash"])
    child = process(proc_root, 101, ["/opt/codex/bin/codex"])
    (parent / "task" / "100" / "children").write_text("101", encoding="ascii")
    agent_id = "019cdef0-1234-7abc-8def-1234567890ab"
    rollout = tmp_path / f"rollout-2026-09-02T12-00-00-{agent_id}.jsonl"
    rollout.write_text("{}\n", encoding="utf-8")
    os.symlink(rollout, child / "fd" / "9")

    assert discover_agent_session_id(
        pane(command="codex"),
        "codex",
        proc_root=proc_root,
    ) == agent_id


@pytest.mark.parametrize(("agent", "option"), [("claude", "--resume"), ("codex", "resume")])
def test_discovers_an_explicit_resume_id_when_no_file_is_open(tmp_path: Path, agent: str, option: str):
    proc_root = tmp_path / "proc"
    agent_id = "12345678-1234-1234-1234-1234567890ab"
    process(proc_root, 100, [agent, option, agent_id])

    assert discover_agent_session_id(
        pane(command=agent),
        agent,
        proc_root=proc_root,
    ) == agent_id


def test_foreground_reference_wins_over_a_newer_nested_agent(tmp_path: Path):
    proc_root = tmp_path / "proc"
    shell = process(proc_root, 100, ["/bin/bash"])
    foreground = process(proc_root, 101, ["/opt/codex/bin/codex"])
    nested = process(proc_root, 102, ["/opt/codex/bin/codex", "worker"])
    (shell / "task" / "100" / "children").write_text("101", encoding="ascii")
    (foreground / "task" / "101" / "children").write_text("102", encoding="ascii")
    foreground_id = "11111111-1111-1111-1111-111111111111"
    nested_id = "22222222-2222-2222-2222-222222222222"
    foreground_rollout = tmp_path / f"rollout-{foreground_id}.jsonl"
    nested_rollout = tmp_path / f"rollout-{nested_id}.jsonl"
    foreground_rollout.write_text("{}\n", encoding="utf-8")
    nested_rollout.write_text("{}\n", encoding="utf-8")
    os.utime(foreground_rollout, ns=(1, 1))
    os.utime(nested_rollout, ns=(2, 2))
    os.symlink(foreground_rollout, foreground / "fd" / "9")
    os.symlink(nested_rollout, nested / "fd" / "9")

    assert discover_agent_session_id(
        pane(command="codex"),
        "codex",
        proc_root=proc_root,
    ) == foreground_id

    (foreground / "fd" / "9").unlink()
    assert discover_agent_session_id(pane(command="codex"), "codex", proc_root=proc_root) is None


async def test_current_codex_rollout_beats_stale_resume_and_in_process_workers(tmp_path: Path):
    proc_root = tmp_path / "proc"
    old = "11111111-1111-4111-8111-111111111111"
    current = "22222222-2222-4222-8222-222222222222"
    worker = "33333333-3333-4333-8333-333333333333"
    root = process(proc_root, 100, ["codex", "resume", old])
    detector = AgentReferenceDetector(proc_root=proc_root)
    active = pane(command="codex")
    assert (await detector.detect_pane(active)).session_id == old
    for number, identifier, source in [(9, current, "cli"), (10, worker, {"subagent": {"thread_spawn": {}}})]:
        rollout = tmp_path / f"rollout-{identifier}.jsonl"
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": identifier, "source": source}}) + "\n")
        os.utime(rollout, ns=(number, number))
        os.symlink(rollout, root / "fd" / str(number))
    assert (await detector.detect_pane(active)).session_id == old  # Ordinary inventory uses its cache.
    assert (await detector.detect_pane(active, refresh=True)).session_id == current


@pytest.mark.parametrize("resumed", [False, True])
def test_codex_discovery_follows_volta_and_node_to_the_native_process(tmp_path: Path, resumed: bool):
    proc_root = tmp_path / "proc"
    old = "11111111-1111-4111-8111-111111111111"
    current = "22222222-2222-4222-8222-222222222222"
    arguments = ["resume", old] if resumed else []
    shim = process(proc_root, 100, ["codex", *arguments])
    node = process(proc_root, 101, ["node", "/opt/codex/bin/codex.js", *arguments])
    native = process(proc_root, 102, ["codex", *arguments])
    nested = process(proc_root, 103, ["codex", "worker"])
    for root, child, executable in [(shim, 101, "volta-shim"), (node, 102, "node"), (native, 103, "codex (deleted)")]:
        (root / "task" / root.name / "children").write_text(str(child))
        (root / "exe").symlink_to(f"/opt/bin/{executable}")
    rollout = tmp_path / f"rollout-{current}.jsonl"
    rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": current, "source": "cli"}}) + "\n")
    (native / "fd" / "9").symlink_to(rollout)
    assert discover_agent_session_id(pane(command="codex"), "codex", proc_root=proc_root) == current
    (native / "fd" / "9").unlink()
    (nested / "fd" / "9").symlink_to(rollout)
    # Still stop at the real foreground process; never substitute a worker.
    assert discover_agent_session_id(pane(command="codex"), "codex", proc_root=proc_root) == (old if resumed else None)


@pytest.mark.asyncio
async def test_detector_keeps_agent_type_when_no_reference_id_is_visible(tmp_path: Path):
    proc_root = tmp_path / "proc"
    process(proc_root, 100, ["cursor-agent"])
    detector = AgentReferenceDetector(proc_root=proc_root)

    assert await detector.detect_sessions([session(pane(command="cursor-agent"))]) == {
        "agent": AgentReference("cursor", None)
    }


@pytest.mark.parametrize("agent", ["claude", "copilot", "cursor", "grok"])
def test_javascript_agents_keep_their_explicit_id_before_nested_workers(tmp_path: Path, agent: str):
    proc_root = tmp_path / "proc"
    current = "11111111-1111-4111-8111-111111111111"
    worker = "22222222-2222-4222-8222-222222222222"
    command = "cursor-agent" if agent == "cursor" else agent
    parent = process(proc_root, 100, ["node", f"/opt/{command}/cli.js", "--resume", current])
    (parent / "exe").symlink_to("/usr/bin/node")
    (parent / "task/100/children").write_text("101")
    process(proc_root, 101, [command, "--resume", worker])
    assert discover_agent_session_id(pane(command=command), agent, proc_root=proc_root) == current


@pytest.mark.asyncio
async def test_detector_does_not_walk_proc_for_a_plain_shell(tmp_path: Path):
    detector = AgentReferenceDetector(proc_root=tmp_path / "missing-proc")

    assert await detector.detect_sessions([session(pane(command="bash"))]) == {
        "agent": AgentReference(None, None)
    }


def claude_process(
    proc_root: Path,
    process_id: int,
    *,
    started_ticks: int,
    parent: Path | None = None,
) -> Path:
    """An agent process whose /proc/<pid>/stat carries a start time."""
    root = process(proc_root, process_id, ["/root/.local/bin/claude"])
    (root / "stat").write_text(
        f"{process_id} (claude) S 1 " + " ".join(["0"] * 17) + f" {started_ticks} 0 0\n",
        encoding="ascii",
    )
    if parent is not None:
        (parent / "task" / parent.name / "children").write_text(
            str(process_id), encoding="ascii",
        )
    return root


def transcript(
    projects_root: Path,
    slug: str,
    session_id: str,
    *,
    directory: str,
    timestamp: str,
    modified: float,
) -> Path:
    folder = projects_root / slug
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{session_id}.jsonl"
    path.write_text(
        json.dumps({"type": "mode", "mode": "normal", "sessionId": session_id}) + "\n"
        + json.dumps({
            "sessionId": session_id,
            "cwd": directory,
            "timestamp": timestamp,
            "type": "user",
        }) + "\n",
        encoding="utf-8",
    )
    os.utime(path, (modified, modified))
    return path


def boot(proc_root: Path, btime: int) -> None:
    proc_root.mkdir(parents=True, exist_ok=True)
    (proc_root / "stat").write_text(f"cpu 0 0\nbtime {btime}\n", encoding="ascii")


BOOT = 1_700_000_000
HZ = os.sysconf("SC_CLK_TCK")


def test_recovers_a_claude_session_id_from_its_transcript(tmp_path: Path):
    """Claude closes its transcript after each append, so the descriptor scan
    finds nothing and the id has to come from the transcript itself."""
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    transcript(
        projects, "-work", "5b2759bc-e27c-4843-bc50-6a194ae416eb",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT + 605, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 900,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) == "5b2759bc-e27c-4843-bc50-6a194ae416eb"


def test_picks_the_conversation_that_started_with_this_process(tmp_path: Path):
    """Directories are routinely shared by many conversations - 62 of this
    host's Claude sessions live in such a directory - so the newest transcript
    is not necessarily this pane's."""
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    # An older conversation in the same directory, written more recently.
    transcript(
        projects, "-work", "11111111-1111-4111-8111-111111111111",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT + 100, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 5000,
    )
    transcript(
        projects, "-work", "22222222-2222-4222-8222-222222222222",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT + 604, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 900,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) == "22222222-2222-4222-8222-222222222222"


def test_ignores_a_transcript_recorded_for_another_directory(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    transcript(
        projects, "-work", "33333333-3333-4333-8333-333333333333",
        directory="/somewhere/else",
        timestamp=datetime.fromtimestamp(BOOT + 605, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 900,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) is None


def test_explicit_resume_argument_still_wins_over_the_transcript_scan(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    resumed = process(proc_root, 101, [
        "/root/.local/bin/claude", "--resume", "44444444-4444-4444-8444-444444444444",
    ])
    (resumed / "stat").write_text(
        "101 (claude) S 1 " + " ".join(["0"] * 17) + f" {600 * HZ} 0 0\n", encoding="ascii",
    )
    (parent / "task" / "100" / "children").write_text("101", encoding="ascii")

    projects = tmp_path / "projects"
    transcript(
        projects, "-work", "55555555-5555-4555-8555-555555555555",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT + 605, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 900,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) == "44444444-4444-4444-8444-444444444444"


def test_claude_transcript_scan_tolerates_a_missing_projects_directory(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=tmp_path / "absent",
    ) is None


def test_recovers_a_continued_conversation_that_predates_its_process(tmp_path: Path):
    """Resuming does not always put an id in argv: a restarted process can carry
    on a conversation opened hours earlier. The live one is the transcript still
    being appended to, not the one that merely started most recently."""
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    # Opened long before this process, but still being written to right now.
    transcript(
        projects, "-work", "66666666-6666-4666-8666-666666666666",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT - 7000, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 3000,
    )
    # Same directory, also old, but abandoned before this process started.
    transcript(
        projects, "-work", "77777777-7777-4777-8777-777777777777",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT - 6000, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 100,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) == "66666666-6666-4666-8666-666666666666"


def test_a_conversation_started_with_this_process_wins_over_a_continued_one(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    # Older conversation, most recently written of the two.
    transcript(
        projects, "-work", "88888888-8888-4888-8888-888888888888",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT - 7000, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 9000,
    )
    # Opened moments after this process started: unambiguously its own.
    transcript(
        projects, "-work", "99999999-9999-4999-8999-999999999999",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT + 603, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT + 800,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) == "99999999-9999-4999-8999-999999999999"


def test_ignores_conversations_abandoned_before_the_process_started(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    parent = process(proc_root, 100, ["/bin/bash"])
    claude_process(proc_root, 101, started_ticks=600 * HZ, parent=parent)

    projects = tmp_path / "projects"
    transcript(
        projects, "-work", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        directory="/work",
        timestamp=datetime.fromtimestamp(BOOT - 7000, UTC).isoformat().replace("+00:00", "Z"),
        modified=BOOT - 100,
    )

    assert discover_agent_session_id(
        pane(command="claude"), "claude",
        proc_root=proc_root, claude_projects_root=projects,
    ) is None


def test_claude_process_registration_follows_the_current_conversation(tmp_path: Path):
    proc_root = tmp_path / "proc"
    boot(proc_root, BOOT)
    root = claude_process(proc_root, 100, started_ticks=600 * HZ)
    previous = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    current = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    (root / "cmdline").write_bytes(f"claude\0--resume\0{previous}".encode())
    sessions = tmp_path / "claude" / "sessions"
    sessions.mkdir(parents=True)
    registration = sessions / "100.json"
    registration.write_text(json.dumps({"pid": 100, "procStart": str(600 * HZ), "sessionId": current}))
    options = {"proc_root": proc_root, "claude_projects_root": sessions.parent / "projects"}
    assert discover_agent_session_id(pane(command="claude"), "claude", **options) == current
    # A stale PID registration must not override a live process's reference.
    registration.write_text(json.dumps({"pid": 100, "procStart": "1", "sessionId": current}))
    assert discover_agent_session_id(pane(command="claude"), "claude", **options) == previous
