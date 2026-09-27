#!/usr/bin/env python3
"""Record task phases and concurrent commands without recording their arguments or output."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path


def utc_now():
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def private_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)


def start(path, task):
    event = {
        "event": "start",
        "version": 1,
        "task": task,
        "at": utc_now(),
        "elapsed": 0,
        "monotonicNs": time.monotonic_ns(),
        "bootId": boot_id(),
    }
    private_write(path, json.dumps(event) + "\n")


def stamp(origin):
    if origin["bootId"] != boot_id():
        raise ValueError("The host rebooted; report this timeline and start a new one.")
    return {
        "at": utc_now(),
        "elapsed": round((time.monotonic_ns() - origin["monotonicNs"]) / 1e9, 6),
    }


def read_events(path):
    with path.open() as stream:
        fcntl.flock(stream, fcntl.LOCK_SH)
        return [json.loads(line) for line in stream if line.strip()]


def append_event(path, kind, **fields):
    # Serialize only journal access, never the command itself. Parallel commands
    # can share a timeline without losing events or interleaving JSON records.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        events = [json.loads(line) for line in stream if line.strip()]
        if not events or events[0].get("version") != 1:
            raise ValueError("Unsupported task timeline.")
        if any(event["event"] == "finish" for event in events):
            raise ValueError("This timeline is finished; start a new one.")
        if kind == "finish" and fields["status"] != "incomplete":
            pending = {e["id"] for e in events if e["event"] == "command_start"}
            pending -= {e["id"] for e in events if e["event"] == "command_end"}
            if pending:
                raise ValueError(
                    "Commands are still running; wait or finish as incomplete."
                )
        if kind == "command_start" and fields.get("phase") is None:
            fields["phase"] = next(
                (e["phase"] for e in reversed(events) if e["event"] == "phase"),
                "unassigned",
            )
        event = dict(event=kind, **stamp(events[0]), **fields)
        stream.seek(0, os.SEEK_END)
        stream.write(json.dumps(event) + "\n")
        stream.flush()
    return event


def run(path, label, command, phase=None):
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise ValueError("Supply a command after --.")
    identifier = uuid.uuid4().hex
    begin = append_event(path, "command_start", id=identifier, phase=phase, label=label)
    print(f"[{begin['at']}] START {label}", flush=True)
    code = 1
    try:
        code = subprocess.run(command, check=False).returncode
    except OSError:
        print(
            "Unable to start command; check its executable and working directory.",
            flush=True,
        )
        code = 127
    except KeyboardInterrupt:
        code = 130
    finally:
        end = append_event(path, "command_end", id=identifier, exitCode=code)
        print(
            f"[{end['at']}] END {label}: exit {code}, {end['elapsed'] - begin['elapsed']:.3f}s",
            flush=True,
        )
    return code if code >= 0 else 128 - code


def merged_intervals(intervals):
    merged = []
    for begin, end in sorted(intervals):
        if merged and begin <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([begin, end])
    return merged


def capture_github(path, run_id, repo=None):
    command = [
        "gh",
        "run",
        "view",
        str(run_id),
        "--json",
        "databaseId,workflowName,url,createdAt,startedAt,updatedAt,status,conclusion,jobs",
    ]
    if repo:
        command += ["--repo", repo]
    try:
        result = subprocess.run(
            command, check=True, capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(
            "Unable to read GitHub timings; check gh authentication and the run ID."
        ) from error
    raw = json.loads(result.stdout)
    data = {
        key: raw.get(key)
        for key in [
            "databaseId",
            "workflowName",
            "url",
            "createdAt",
            "startedAt",
            "updatedAt",
            "status",
            "conclusion",
        ]
    }
    # Keep provider timestamps, not logs, step payloads or command arguments.
    data["jobs"] = [
        {
            key: job.get(key)
            for key in ["name", "startedAt", "completedAt", "status", "conclusion"]
        }
        for job in raw.get("jobs", [])
    ]
    append_event(path, "github", run=data)


def summarize(events, observed=None):
    origin = events[0]
    finish = next((e for e in events if e["event"] == "finish"), None)
    end = finish or observed or stamp(origin)
    elapsed = end["elapsed"]
    ends = {e["id"]: e for e in events if e["event"] == "command_end"}
    commands = []
    for event in events:
        if event["event"] != "command_start":
            continue
        done = ends.get(event["id"])
        until = done or end
        commands.append(
            {
                "label": event["label"],
                "phase": event["phase"],
                "startedAt": event["at"],
                "endedAt": done["at"] if done else None,
                "start": event["elapsed"],
                "end": until["elapsed"],
                "seconds": until["elapsed"] - event["elapsed"],
                "exitCode": done["exitCode"] if done else None,
                "status": ("passed" if done["exitCode"] == 0 else "failed")
                if done
                else ("unfinished" if finish else "running"),
            }
        )
    intervals = merged_intervals((c["start"], c["end"]) for c in commands)
    busy = sum(b - a for a, b in intervals)
    total = sum(c["seconds"] for c in commands)
    boundaries = {e["elapsed"]: e["at"] for e in [*events, end]}

    def timestamp(offset):
        return boundaries.get(offset) or (
            datetime.fromisoformat(origin["at"]) + timedelta(seconds=offset)
        ).isoformat(timespec="milliseconds")

    def span(begin, until):
        return {
            "startedAt": timestamp(begin),
            "endedAt": timestamp(until),
            "seconds": until - begin,
        }

    gaps = []
    cursor = 0
    for begin, until in intervals:
        if begin > cursor:
            gaps.append(span(cursor, begin))
        cursor = until
    if cursor < elapsed:
        gaps.append(span(cursor, elapsed))
    markers = [e for e in events if e["event"] == "phase"]
    if not markers or markers[0]["elapsed"] > 0:
        markers.insert(
            0,
            {"phase": "unassigned", "label": "Before first phase marker", "elapsed": 0},
        )
    phases = []
    for number, marker in enumerate(markers):
        begin = marker["elapsed"]
        until = markers[number + 1]["elapsed"] if number + 1 < len(markers) else elapsed
        covered = sum(max(0, min(b, until) - max(a, begin)) for a, b in intervals)
        phases.append(
            dict(
                phase=marker["phase"],
                label=marker.get("label", ""),
                **span(begin, until),
                commandWallSeconds=covered,
                betweenCommandsSeconds=until - begin - covered,
            )
        )
    ci_runs = {
        e["run"]["databaseId"]: e["run"] for e in events if e["event"] == "github"
    }
    return {
        "version": 1,
        "task": origin["task"],
        "startedAt": origin["at"],
        "endedAt": finish["at"] if finish else None,
        "observedAt": end["at"],
        "status": finish["status"] if finish else "in_progress",
        "seconds": elapsed,
        "commandSeconds": total,
        "commandWallSeconds": busy,
        "overlapSeconds": total - busy,
        "betweenCommandsSeconds": elapsed - busy,
        "phases": phases,
        "commands": commands,
        "gaps": gaps,
        "ciRuns": list(ci_runs.values()),
    }


def markdown(data):
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")

    lines = [
        "# Task timeline",
        "",
        cell(data["task"]),
        "",
        f"Status: {data['status']}. UTC: {data['startedAt']} → {data['observedAt']}.",
        (
            f"Elapsed: **{data['seconds']:.3f}s**. Timed-command wall time: **{data['commandWallSeconds']:.3f}s**. "
            f"Between timed commands: **{data['betweenCommandsSeconds']:.3f}s**."
        ),
        "",
        (
            f"Summed command runtime: {data['commandSeconds']:.3f}s; overlapping runtime: {data['overlapSeconds']:.3f}s. "
            "Parallel commands are counted once in wall time."
        ),
        "",
        (
            "Time between commands includes investigation, editing, communication, waiting and unwrapped work; "
            "it is not automatically idle time. Phase markers provide context, not a measurement of agent thinking. "
            "Only work after recording began is covered. UTC timestamps are recorded at each boundary; "
            "durations use the host's monotonic clock. CI watch duration measures local waiting; "
            "use the CI provider's job timestamps for remote queue/job durations."
        ),
        "",
        "## Phases",
        "",
        "| Phase / activity | Start (UTC) | End (UTC) | Elapsed s | Command wall s | Between commands s |",
        "| --- | --- | --- | ---: | ---: | ---: |",
    ]
    for phase in data["phases"]:
        lines.append(
            f"| {cell(phase['phase'])}: {cell(phase['label'])} | {phase['startedAt']} | {phase['endedAt']} | "
            f"{phase['seconds']:.3f} | {phase['commandWallSeconds']:.3f} | {phase['betweenCommandsSeconds']:.3f} |"
        )
    lines += [
        "",
        "## Commands",
        "",
        "| Command label | Phase | Start (UTC) | End (UTC) | Seconds | Result / exit |",
        "| --- | --- | --- | --- | ---: | --- |",
    ]
    for command in data["commands"]:
        result = command["status"] + (
            f" / {command['exitCode']}" if command["exitCode"] is not None else ""
        )
        lines.append(
            f"| {cell(command['label'])} | {cell(command['phase'])} | {command['startedAt']} | "
            f"{command['endedAt'] or '—'} | {command['seconds']:.3f} | {result} |"
        )
    lines += [
        "",
        "## Time between timed commands",
        "",
        "| Start (UTC) | End (UTC) | Seconds |",
        "| --- | --- | ---: |",
    ]
    lines += [
        f"| {gap['startedAt']} | {gap['endedAt']} | {gap['seconds']:.3f} |"
        for gap in data["gaps"]
    ]
    if data["ciRuns"]:
        lines += [
            "",
            "## GitHub Actions (provider timestamps)",
            "",
            (
                "Remote jobs overlap local work and are not added to local elapsed time. "
                "Job times below are measured by GitHub; workflow updated time may include final bookkeeping."
            ),
        ]
    for run in data["ciRuns"]:
        lines += [
            "",
            f"{cell(run['workflowName'])}: {run['url']} — {run['status']} / {run['conclusion']}",
            f"Created: {run['createdAt']}; started: {run['startedAt']}; updated: {run['updatedAt']}.",
            "",
            "| Job | Start (UTC) | End (UTC) | Seconds | Result |",
            "| --- | --- | --- | ---: | --- |",
        ]
        for job in run["jobs"]:
            seconds = "—"
            if job["status"] == "completed" and job["startedAt"] and job["completedAt"]:
                seconds = f"{(datetime.fromisoformat(job['completedAt']) - datetime.fromisoformat(job['startedAt'])).total_seconds():.3f}"
            lines.append(
                f"| {cell(job['name'])} | {job['startedAt']} | {job['completedAt']} | {seconds} | {job['conclusion'] or job['status']} |"
            )
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--file", type=Path, required=True, help="Private append-only JSONL timeline"
    )
    actions = parser.add_subparsers(dest="action", required=True)
    init = actions.add_parser("start", help="Start before investigation or editing")
    init.add_argument("task")
    phase = actions.add_parser(
        "phase", help="Mark the next activity, including work between commands"
    )
    phase.add_argument(
        "phase", choices=["implementation", "validation", "deployment", "reporting"]
    )
    phase.add_argument("--label", default="")
    command = actions.add_parser(
        "run", help="Run without a shell; forward output and exit status"
    )
    command.add_argument(
        "--label", required=True, help="Safe description; do not include secrets"
    )
    command.add_argument(
        "--phase",
        help="Optional category for work overlapping the current phase, such as CI",
    )
    command.add_argument("command", nargs=argparse.REMAINDER)
    finish = actions.add_parser("finish")
    finish.add_argument(
        "--status", choices=["success", "failed", "incomplete"], required=True
    )
    github = actions.add_parser(
        "github", help="Record workflow and job timestamps from GitHub using gh"
    )
    github.add_argument("--run-id", required=True, type=int)
    github.add_argument(
        "--repo", help="owner/repo; defaults to the current checkout's remote"
    )
    report = actions.add_parser(
        "report", help="Write JSON and Markdown; also works during a task"
    )
    report.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "start":
            start(args.file, args.task)
        elif args.action == "phase":
            append_event(args.file, "phase", phase=args.phase, label=args.label)
        elif args.action == "run":
            return run(args.file, args.label, args.command, args.phase)
        elif args.action == "finish":
            append_event(args.file, "finish", status=args.status)
        elif args.action == "github":
            capture_github(args.file, args.run_id, args.repo)
        else:
            data = summarize(read_events(args.file))
            args.output_dir.mkdir(parents=True, mode=0o700)
            private_write(
                args.output_dir / "timeline.json", json.dumps(data, indent=2) + "\n"
            )
            private_write(args.output_dir / "report.md", markdown(data))
            print(f"Timeline: {args.output_dir / 'report.md'}", flush=True)
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"Timeline error: {error}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
