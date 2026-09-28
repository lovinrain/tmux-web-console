import importlib.util
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Thread
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


def native_record(at, record_type, **payload):
    return {
        "timestamp": event("unused", at)["at"],
        "type": record_type,
        "payload": payload,
    }


def native_fixture(path, complete=True):
    base_ms = int(datetime(2026, 9, 27, tzinfo=UTC).timestamp() * 1000)

    def item(at, start, kind, identifier, **fields):
        return native_record(
            at,
            "event_msg",
            type="item_completed",
            turn_id="turn-one",
            started_at_ms=base_ms + start * 1000,
            completed_at_ms=base_ms + at * 1000,
            item={
                "type": kind,
                "id": identifier,
                "content": "PRIVATE_CONTENT",
                **fields,
            },
        )

    def response(at, identifier):
        return native_record(
            at,
            "token_usage_record",
            turn_id="turn-one",
            thread_id="session-one",
            response_id=identifier,
            usage={"output_tokens": 100, "reasoning_output_tokens": 20},
        )

    records = [
        native_record(
            0, "session_meta", id="session-one", base_instructions="PRIVATE_CONTENT"
        ),
        native_record(0, "event_msg", type="task_started", turn_id="turn-one"),
        item(6, 2, "Reasoning", "reasoning"),
        native_record(
            6,
            "response_item",
            type="function_call",
            call_id="tool-one",
            arguments="PRIVATE_CONTENT",
        ),
        response(6.1, "PRIVATE_RESPONSE_ID"),
        native_record(
            7,
            "response_item",
            type="function_call_output",
            call_id="tool-one",
            output="PRIVATE_CONTENT",
        ),
        item(18, 9, "Reasoning", "reasoning-two"),
        native_record(
            20,
            "response_item",
            type="custom_tool_call",
            call_id="tool-two",
            input="PRIVATE_CONTENT",
        ),
        response(21, "response-two"),
        native_record(
            25,
            "response_item",
            type="custom_tool_call_output",
            call_id="tool-two",
            output="PRIVATE_CONTENT",
        ),
        item(35, 25, "ContextCompaction", "compaction"),
        response(35, "response-three"),
        native_record(
            35,
            "compacted",
            compaction_response_id="response-three",
            message="PRIVATE_CONTENT",
        ),
        item(38, 37, "AgentMessage", "reply", phase="final_answer"),
        response(38.1, "response-four"),
    ]
    if complete:
        records.append(
            native_record(
                39,
                "event_msg",
                type="task_complete",
                turn_id="turn-one",
                duration_ms=39000,
                time_to_first_token_ms=2000,
                last_agent_message="PRIVATE_CONTENT",
            )
        )
    path.write_text("".join(json.dumps(record) + "\n" for record in records))
    return records


def native_task_events(path=None):
    source = (
        {"codex": {"sessionId": "session-one", "rolloutPath": str(path)}}
        if path
        else {}
    )
    return [
        event("start", 0, version=1, task="Native timing", **source),
        event("command_start", 20, id="check", phase="validation", label="Check"),
        event("command_end", 25, id="check", exitCode=0),
        event("finish", 40, status="success"),
    ]


def test_native_turn_and_response_windows_distinguish_latency_and_preserve_privacy(
    tmp_path,
):
    path = tmp_path / "native.jsonl"
    native_fixture(path)
    native = timeline.read_codex_rollout(path, "session-one")
    data = timeline.build_report(native_task_events(path))
    codex = data["codex"]
    assert codex["turns"][0]["seconds"] == 39
    assert codex["turns"][0]["firstTokenSeconds"] == 2
    assert codex["turns"][0]["finalResponseEndedAt"] == timeline.iso_at(
        timeline.epoch(event("", 38)["at"])
    )
    assert codex["providerRequestLatencySeconds"] is None
    assert len(codex["responseWindows"]) == 4
    assert [r["boundarySource"] for r in codex["responseWindows"]] == [
        "turn_started",
        "tool_output",
        "tool_output",
        "previous_response",
    ]
    assert codex["responseWindows"][2]["compaction"] is True
    assert codex["breakdownSeconds"] == pytest.approx(
        {
            "command": 5,
            "compaction": 10,
            "tool": 1,
            "response": 22.1,
            "unobserved": 1.9,
        }
    )
    assert sum(s["seconds"] for s in codex["segments"]) == 40
    exported = json.dumps(native) + json.dumps(data) + timeline.markdown(data)
    assert "PRIVATE_CONTENT" not in exported and "PRIVATE_RESPONSE_ID" not in exported
    assert "NOT measured HTTP request latency" in timeline.markdown(data)


def test_native_intervals_clip_to_task_without_truncating_full_turn(tmp_path):
    path = tmp_path / "native.jsonl"
    native_fixture(path)
    native = timeline.read_codex_rollout(path)
    task = timeline.summarize(
        [
            {**event("start", 10, task="Part of a turn"), "elapsed": 0},
            {**event("finish", 30, status="success"), "elapsed": 20},
        ]
    )
    data = timeline.codex_summary(native, task)
    assert data["turns"][0]["seconds"] == 39
    assert data["turns"][0]["overlapSeconds"] == 20
    assert sum(data["breakdownSeconds"].values()) == pytest.approx(20)
    assert all(0 <= s["start"] < s["end"] <= 20 for s in data["segments"])


def test_native_missing_identity_incomplete_records_and_replayed_events(tmp_path):
    path = tmp_path / "native.jsonl"
    records = native_fixture(path, complete=False)
    with path.open("a") as stream:
        stream.write(json.dumps(records[2]) + "\n" + json.dumps(records[4]) + "\n")
        stream.write('{"partial":')
    native = timeline.read_codex_rollout(path, "session-one")
    assert native["malformedLines"] == 1
    assert len(native["responses"]) == 4
    assert len([i for i in native["items"] if i["kind"] == "model_item"]) == 3
    assert native["turns"][0]["endedAt"] is None
    assert native["turns"][0]["seconds"] is None
    with pytest.raises(ValueError, match="does not match"):
        timeline.read_codex_rollout(path, "another-session")
    missing = timeline.build_report(
        native_task_events(),
        {
            "sessionId": "missing",
            "home": str(tmp_path),
        },
    )
    assert missing["codex"]["status"] == "unavailable"
    assert missing["commandWallSeconds"] == 5
    assert "No different session was substituted" in timeline.markdown(missing)


def test_start_records_session_identity_and_report_does_not_guess_from_current_environment(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CODEX_THREAD_ID", "session-one")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "native"))
    path = tmp_path / "journal.jsonl"
    timeline.start(path, "Identity")
    source = timeline.read_events(path)[0]["codex"]
    assert source == {"sessionId": "session-one", "home": str(tmp_path / "native")}
    assert timeline.native_source(native_task_events()) is None
    assert (
        timeline.native_source(native_task_events(), "explicit")["sessionId"]
        == "explicit"
    )
    with pytest.raises(ValueError, match="Invalid"):
        timeline.resolve_rollout({"sessionId": "../*"})


def test_background_export_observes_final_completion_after_local_finish(tmp_path):
    path = tmp_path / "native.jsonl"
    native_fixture(path, complete=False)

    def complete():
        time.sleep(0.05)
        with path.open("a") as stream:
            stream.write(
                json.dumps(
                    native_record(
                        39,
                        "event_msg",
                        type="task_complete",
                        turn_id="turn-one",
                        duration_ms=39000,
                        time_to_first_token_ms=2000,
                    )
                )
                + "\n"
            )

    writer = Thread(target=complete)
    writer.start()
    try:
        assert timeline.wait_for_codex(
            native_task_events(path),
            {
                "sessionId": "session-one",
                "rolloutPath": str(path),
            },
            2,
        )
    finally:
        writer.join()
    assert (
        timeline.build_report(native_task_events(path))["codex"]["turns"][0]["status"]
        == "completed"
    )


def test_finished_cli_schedules_read_only_completion_export(tmp_path, monkeypatch):
    path = tmp_path / "journal.jsonl"
    native_path = tmp_path / "native.jsonl"
    native_fixture(native_path)
    timeline.start(path, "Schedule")
    timeline.append_event(
        path,
        "codex",
        codex={"sessionId": "session-one", "rolloutPath": str(native_path)},
    )
    calls = []
    monkeypatch.setattr(
        timeline.subprocess,
        "Popen",
        lambda command, **kwargs: calls.append((command, kwargs)),
    )
    assert timeline.main(["--file", str(path), "finish", "--status", "success"]) == 0
    assert len(calls) == 1 and "--wait-for-codex" in calls[0][0]
    assert calls[0][1]["start_new_session"] is True
    assert timeline.read_events(path)[-1]["codexReportDir"] == str(
        tmp_path / "timing-codex"
    )
    assert (tmp_path / "codex-export.log").stat().st_mode & 0o777 == 0o600


def test_history_backfills_completed_tasks_without_mutating_journals(tmp_path):
    native_path = tmp_path / "native.jsonl"
    native_fixture(native_path)
    task_dir = tmp_path / "tasks" / "first"
    task_dir.mkdir(parents=True)
    path = task_dir / "timeline.jsonl"
    original = "".join(json.dumps(e) + "\n" for e in native_task_events())
    path.write_text(original)
    output = tmp_path / "analysis"
    data = timeline.analyze_history(tmp_path / "tasks", output, rollout=native_path)
    assert data["completedTasks"] == 1
    assert data["medianFirstTokenSeconds"] == 2
    assert data["totals"]["commandWallSeconds"] == 5
    assert path.read_text() == original
    assert (output / "analysis.json").stat().st_mode & 0o777 == 0o600
    assert "PRIVATE_CONTENT" not in (output / "analysis.json").read_text()
