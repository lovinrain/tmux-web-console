from __future__ import annotations

import os
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


def test_prefers_an_explicit_resume_id_without_scanning_the_filesystem(tmp_path: Path):
    proc_root = tmp_path / "proc"
    agent_id = "12345678-1234-1234-1234-1234567890ab"
    process(proc_root, 100, ["claude", "--resume", agent_id])

    assert discover_agent_session_id(
        pane(command="claude"),
        "claude",
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


@pytest.mark.asyncio
async def test_detector_keeps_agent_type_when_no_reference_id_is_visible(tmp_path: Path):
    proc_root = tmp_path / "proc"
    process(proc_root, 100, ["cursor-agent"])
    detector = AgentReferenceDetector(proc_root=proc_root)

    assert await detector.detect_sessions([session(pane(command="cursor-agent"))]) == {
        "agent": AgentReference("cursor", None)
    }


@pytest.mark.asyncio
async def test_detector_does_not_walk_proc_for_a_plain_shell(tmp_path: Path):
    detector = AgentReferenceDetector(proc_root=tmp_path / "missing-proc")

    assert await detector.detect_sessions([session(pane(command="bash"))]) == {
        "agent": AgentReference(None, None)
    }
