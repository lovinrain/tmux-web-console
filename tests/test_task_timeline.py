import importlib.util
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts" / "task_timeline.py"
SPEC = importlib.util.spec_from_file_location("task_timeline", SCRIPT)
assert SPEC and SPEC.loader
timeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(timeline)


def event(kind, elapsed, **fields):
    at = (datetime(2026, 9, 27, tzinfo=UTC) + timedelta(seconds=elapsed)).isoformat()
    return dict(event=kind, elapsed=elapsed, at=at, **fields)


def test_report_separates_parallel_runtime_and_gaps_across_phases():
    data = timeline.summarize(
        [
            event("start", 0, task="A task"),
            event("phase", 0, phase="implementation", label="Prepare"),
            event("command_start", 10, id="a", phase="validation", label="Tests"),
            event("phase", 15, phase="validation", label="Verify"),
            event("command_start", 20, id="b", phase="validation", label="Build"),
            event("command_end", 30, id="a", exitCode=0),
            event("command_end", 40, id="b", exitCode=7),
            event("finish", 50, status="failed"),
        ]
    )
    assert data["seconds"] == 50
    assert data["commandSeconds"] == 40
    assert data["commandWallSeconds"] == 30
    assert data["overlapSeconds"] == 10
    assert data["betweenCommandsSeconds"] == 20
    assert [phase["commandWallSeconds"] for phase in data["phases"]] == [5, 25]
    assert [phase["betweenCommandsSeconds"] for phase in data["phases"]] == [10, 10]
    assert [gap["seconds"] for gap in data["gaps"]] == [10, 10]
    assert [command["status"] for command in data["commands"]] == ["passed", "failed"]
    assert data["commands"][1]["exitCode"] == 7
    assert "not automatically idle" in timeline.markdown(data)


def test_runs_keep_failures_and_output_but_do_not_record_commands_or_environment(
    tmp_path, monkeypatch, capfd
):
    path = tmp_path / "private" / "events.jsonl"
    timeline.start(path, "Failures")
    timeline.append_event(path, "phase", phase="validation", label="Test")
    monkeypatch.setenv("PRIVATE_TOKEN", "keep-out-of-timeline")
    assert (
        timeline.run(
            path,
            "Exit failure",
            [sys.executable, "-c", "import sys; print('private-output'); sys.exit(7)"],
        )
        == 7
    )
    assert timeline.run(path, "Missing executable", [str(tmp_path / "missing")]) == 127
    assert "private-output" in capfd.readouterr().out
    text = path.read_text()
    assert "private-output" not in text and "keep-out-of-timeline" not in text
    assert sys.executable not in text
    timeline.append_event(path, "finish", status="failed")
    report = timeline.summarize(timeline.read_events(path))
    assert [command["exitCode"] for command in report["commands"]] == [7, 127]
    assert all(command["phase"] == "validation" for command in report["commands"])
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    with pytest.raises(FileExistsError):
        timeline.start(path, "Cannot replace evidence")
    with pytest.raises(ValueError, match="finished"):
        timeline.append_event(path, "phase", phase="reporting")


def test_parallel_processes_append_complete_command_pairs(tmp_path):
    path = tmp_path / "events.jsonl"
    timeline.start(path, "Concurrent")

    def run(number):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(path),
                "run",
                "--label",
                f"Job {number}",
                "--",
                sys.executable,
                "-c",
                "pass",
            ],
            capture_output=True,
            check=True,
        )

    with ThreadPoolExecutor(max_workers=4) as workers:
        list(workers.map(run, range(8)))
    timeline.append_event(path, "finish", status="success")
    data = timeline.summarize(timeline.read_events(path))
    assert len(data["commands"]) == 8
    assert len({command["label"] for command in data["commands"]}) == 8
    assert all(command["status"] == "passed" for command in data["commands"])
    assert data["commandWallSeconds"] <= data["commandSeconds"]


def test_unfinished_commands_are_visible_and_cannot_be_finished_as_success(tmp_path):
    path = tmp_path / "events.jsonl"
    timeline.start(path, "Interrupted")
    timeline.append_event(
        path, "command_start", id="a", phase="validation", label="Pending"
    )
    data = timeline.summarize(timeline.read_events(path))
    assert data["commands"][0]["status"] == "running"
    assert data["commands"][0]["exitCode"] is None
    with pytest.raises(ValueError, match="still running"):
        timeline.append_event(path, "finish", status="success")
    timeline.append_event(path, "finish", status="incomplete")
    data = timeline.summarize(timeline.read_events(path))
    assert data["commands"][0]["status"] == "unfinished"


def test_reboot_cannot_mix_monotonic_clocks_and_finished_reports_remain_readable(
    tmp_path, monkeypatch
):
    path = tmp_path / "events.jsonl"
    timeline.start(path, "Reboot")
    timeline.append_event(path, "finish", status="success")
    monkeypatch.setattr(timeline, "boot_id", lambda: "different-boot")
    with pytest.raises(ValueError, match="rebooted"):
        timeline.stamp(timeline.read_events(path)[0])
    assert timeline.summarize(timeline.read_events(path))["status"] == "success"


def test_github_report_keeps_provider_job_times_without_logs_or_double_counting(
    tmp_path, monkeypatch
):
    path = tmp_path / "events.jsonl"
    timeline.start(path, "CI")
    job = {
        "name": "Frontend",
        "startedAt": "2026-09-27T00:00:10Z",
        "completedAt": "2026-09-27T00:00:25Z",
        "status": "completed",
        "conclusion": "success",
        "steps": ["private command"],
    }
    raw = {
        "databaseId": 42,
        "workflowName": "CI",
        "url": "https://github.com/example/repo/actions/runs/42",
        "status": "completed",
        "conclusion": "success",
        "jobs": [job],
    }
    monkeypatch.setattr(
        timeline.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps(raw)),
    )
    timeline.capture_github(path, 42)
    timeline.append_event(path, "finish", status="success")
    data = timeline.summarize(timeline.read_events(path))
    assert data["commandWallSeconds"] == 0
    assert "steps" not in data["ciRuns"][0]["jobs"][0]
    assert "private command" not in path.read_text()
    assert "15.000 | success" in timeline.markdown(data)
