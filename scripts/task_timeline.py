#!/usr/bin/env python3
"""Record task phases and concurrent commands without recording their arguments or output."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import itertools
import json
import math
import os
import re
import statistics
import subprocess
import sys
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
    session_id = os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")
    if session_id:
        event["codex"] = {
            "sessionId": session_id,
            "home": str(Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()),
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
    if data.get("codex"):
        lines += codex_markdown(data["codex"])
    return "\n".join(lines) + "\n"


def epoch(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str):
        return datetime.fromisoformat(value).timestamp()
    raise ValueError("Missing native timestamp")


def iso_at(value):
    return datetime.fromtimestamp(value, UTC).isoformat(timespec="milliseconds")


def seconds_ms(value):
    return (
        value / 1000
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
        else None
    )


def native_source(events, session_id=None, rollout=None, codex_home=None):
    saved = next((e["codex"] for e in reversed(events) if e.get("codex")), {})
    if not (session_id or rollout or saved):
        return None
    source = dict(saved)
    if session_id:
        source = {"sessionId": session_id}
    if rollout:
        source["rolloutPath"] = str(rollout.resolve())
    if codex_home:
        source["home"] = str(codex_home.resolve())
    return source


def resolve_rollout(source):
    session_id = source.get("sessionId")
    if session_id and not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", session_id):
        raise ValueError("Invalid Codex session ID")
    if source.get("rolloutPath"):
        return Path(source["rolloutPath"])
    home = Path(
        source.get("home") or os.environ.get("CODEX_HOME", "~/.codex")
    ).expanduser()
    matches = [
        path
        for folder in ("sessions", "archived_sessions")
        for path in (home / folder).rglob(f"*{session_id}.jsonl")
    ]
    if len(matches) != 1:
        raise ValueError(
            "The exact Codex session transcript is missing or ambiguous; supply --codex-rollout."
        )
    return matches[0]


def read_codex_rollout(path, expected_session_id=None):
    """Extract only timing, types and token counts; never retain message/tool content."""
    session_id = None
    turns, pending, ready, responses = {}, {}, {}, {}
    items, seen_items, compaction_responses = [], set(), set()
    current_turn = None
    malformed = 0
    last_at = None

    def span(kind, begin, end, turn_id):
        if begin is None or end < begin:
            return
        items.append(
            {
                "kind": kind,
                "turnId": turn_id,
                "startedAt": iso_at(begin),
                "endedAt": iso_at(end),
                "seconds": end - begin,
            }
        )

    with path.open() as stream:
        while True:
            offset = stream.tell()
            line = stream.readline()
            if not line:
                break
            if not line.endswith("\n"):
                # A writer may still be appending this record. The completion
                # exporter must resume before it, not lose its first bytes.
                malformed += 1
                break
            try:
                record = json.loads(line)
                payload = record.get("payload", {})
                if not isinstance(payload, dict):
                    continue
                at = epoch(record.get("timestamp"))
            except (ValueError, TypeError, AttributeError):
                malformed += 1
                continue
            last_at = at
            record_type, kind = record.get("type"), payload.get("type")
            if record_type == "session_meta":
                session_id = payload.get("id") or payload.get("session_id")
                if expected_session_id and session_id != expected_session_id:
                    raise ValueError(
                        "Codex session ID does not match the native transcript"
                    )
            elif record_type == "event_msg" and kind == "task_started":
                current_turn = payload.get("turn_id")
                if current_turn:
                    turns.setdefault(
                        current_turn,
                        {
                            "id": current_turn,
                            "startedAt": iso_at(at),
                            "endedAt": None,
                            "seconds": None,
                            "firstTokenSeconds": None,
                            "status": "in_progress",
                        },
                    )
                    ready[current_turn] = (at, "turn_started")
            elif record_type == "turn_context":
                current_turn = payload.get("turn_id", current_turn)
            elif record_type == "event_msg" and kind in (
                "task_complete",
                "turn_aborted",
            ):
                turn_id = payload.get("turn_id", current_turn)
                duration = seconds_ms(payload.get("duration_ms"))
                turn = turns.get(turn_id)
                if turn is None and duration is not None:
                    turn = {
                        "id": turn_id,
                        "startedAt": iso_at(at - duration),
                        "startReconstructedFromDuration": True,
                    }
                    turns[turn_id] = turn
                if turn is not None:
                    turn.update(
                        {
                            "endedAt": iso_at(at),
                            "seconds": duration
                            if duration is not None
                            else at - epoch(turn["startedAt"]),
                            "firstTokenSeconds": seconds_ms(
                                payload.get("time_to_first_token_ms")
                            ),
                            "status": "completed"
                            if kind == "task_complete"
                            else "interrupted",
                        }
                    )
            elif record_type == "event_msg" and kind == "item_completed":
                item = payload.get("item", {})
                begin = seconds_ms(payload.get("started_at_ms"))
                end = seconds_ms(payload.get("completed_at_ms"))
                if not isinstance(item, dict) or begin is None or end is None:
                    continue
                key = (item.get("id"), begin, end, item.get("type"))
                if key in seen_items:
                    continue
                seen_items.add(key)
                item_kind = {
                    "Reasoning": "model_item",
                    "AgentMessage": "model_item",
                    "ContextCompaction": "compaction",
                    "CommandExecution": "tool",
                    "FileChange": "tool",
                    "ImageView": "tool",
                    "McpToolCall": "tool",
                }.get(item.get("type"))
                turn_id = payload.get("turn_id", current_turn)
                if item_kind:
                    span(item_kind, begin, end, turn_id)
                turn = turns.get(turn_id)
                if turn is not None and item.get("type") == "AgentMessage":
                    if item.get("phase") in ("final_answer", "final"):
                        turn["finalResponseStartedAt"] = iso_at(begin)
                        turn["finalResponseEndedAt"] = iso_at(end)
                    else:
                        turn.setdefault("firstVisibleResponseAt", iso_at(begin))
            elif record_type == "response_item" and kind in (
                "function_call",
                "custom_tool_call",
            ):
                pending[payload.get("call_id")] = (at, current_turn)
            elif record_type == "response_item" and kind in (
                "function_call_output",
                "custom_tool_call_output",
            ):
                call = pending.pop(payload.get("call_id"), None)
                if call:
                    span("tool", call[0], at, call[1])
                    ready[call[1]] = (at, "tool_output")
            elif record_type == "token_usage_record":
                if payload.get("thread_id", session_id) != session_id:
                    continue
                turn_id = payload.get("turn_id", current_turn)
                response_id = payload.get("response_id")
                if not response_id or response_id in responses:
                    continue
                boundary = ready.get(turn_id)
                usage = payload.get("usage") or {}
                if not isinstance(usage, dict):
                    usage = {}
                responses[response_id] = {
                    "id": hashlib.sha256(str(response_id).encode()).hexdigest()[:16],
                    "turnId": turn_id,
                    "completedAt": iso_at(at),
                    "readyAt": iso_at(boundary[0])
                    if boundary and boundary[0] <= at
                    else None,
                    "boundarySource": boundary[1] if boundary else None,
                    "seconds": at - boundary[0]
                    if boundary and boundary[0] <= at
                    else None,
                    "outputTokens": usage.get("output_tokens")
                    if type(usage.get("output_tokens")) is int
                    else None,
                    "reasoningTokens": usage.get("reasoning_output_tokens")
                    if type(usage.get("reasoning_output_tokens")) is int
                    else None,
                }
                ready[turn_id] = (at, "previous_response")
            elif record_type == "compacted":
                compaction_responses.add(payload.get("compaction_response_id"))
    if not session_id:
        raise ValueError("Native transcript has no session identity")
    for identifier, response in responses.items():
        response["compaction"] = identifier in compaction_responses
    return {
        "sessionId": session_id,
        "rolloutPath": str(path),
        "turns": list(turns.values()),
        "items": items,
        "responses": list(responses.values()),
        "malformedLines": malformed,
        "lastEventAt": iso_at(last_at) if last_at else None,
        "readOffset": offset,
    }


def codex_summary(native, task):
    start_at = epoch(task["startedAt"])
    duration = task["seconds"]
    finish_at = start_at + duration

    def overlap(begin, end):
        return max(
            0,
            min(epoch(end) if end else finish_at, finish_at)
            - max(epoch(begin), start_at),
        )

    turns = [
        {**turn, "overlapSeconds": overlap(turn["startedAt"], turn["endedAt"])}
        for turn in native["turns"]
        if overlap(turn["startedAt"], turn["endedAt"]) > 0
    ]
    items = [
        {**item, "overlapSeconds": overlap(item["startedAt"], item["endedAt"])}
        for item in native["items"]
        if overlap(item["startedAt"], item["endedAt"]) > 0
    ]
    responses = [
        response
        for response in native["responses"]
        if (
            response["readyAt"]
            and overlap(response["readyAt"], response["completedAt"]) > 0
        )
        or start_at <= epoch(response["completedAt"]) <= finish_at
    ]
    intervals = {"command": [(c["start"], c["end"]) for c in task["commands"]]}
    for kind in ("compaction", "tool", "model_item"):
        intervals[kind] = [
            (
                max(0, epoch(i["startedAt"]) - start_at),
                min(duration, epoch(i["endedAt"]) - start_at),
            )
            for i in items
            if i["kind"] == kind
        ]
    intervals["response"] = [
        (
            max(0, epoch(r["readyAt"]) - start_at),
            min(duration, epoch(r["completedAt"]) - start_at),
        )
        for r in responses
        if r["readyAt"]
    ]
    intervals = {kind: merged_intervals(spans) for kind, spans in intervals.items()}
    # Priority makes this an exclusive wall-time partition, even when tools begin
    # before a streamed response ends. Model-item times are a separate lower bound.
    priority = ("command", "compaction", "tool", "response")
    points = sorted(
        {
            0,
            duration,
            *(point for k in priority for span in intervals[k] for point in span),
        }
    )
    segments = []
    for begin, end in itertools.pairwise(points):
        if end <= begin:
            continue
        kind = next(
            (
                k
                for k in priority
                if any(a <= begin and b >= end for a, b in intervals[k])
            ),
            "unobserved",
        )
        if segments and segments[-1]["kind"] == kind:
            segments[-1]["end"] = end
        else:
            segments.append({"kind": kind, "start": begin, "end": end})
    totals = {kind: 0.0 for kind in (*priority, "unobserved")}
    for segment in segments:
        segment.update(
            {
                "seconds": segment["end"] - segment["start"],
                "startedAt": iso_at(start_at + segment["start"]),
                "endedAt": iso_at(start_at + segment["end"]),
            }
        )
        totals[segment["kind"]] += segment["seconds"]
    return {
        "status": "available",
        "sessionId": native["sessionId"],
        "rolloutPath": native["rolloutPath"],
        "lastEventAt": native["lastEventAt"],
        "turns": turns,
        "responseWindows": responses,
        "items": items,
        "breakdownSeconds": totals,
        "segments": segments,
        "observedModelItemSeconds": sum(b - a for a, b in intervals["model_item"]),
        "providerRequestLatencySeconds": None,
        "malformedLines": native["malformedLines"],
        "limitations": (
            "Turn duration and first-token latency are reported by Codex. Response windows run from "
            "turn start, a tool result, or the previous response completion to token_usage_record. "
            "They include client preparation, orchestration, pauses, network/server waiting and generation; they are NOT "
            "measured HTTP request latency. Native item times cover only recorded items. "
            "Native timestamps use UTC wall time; local command durations use a monotonic clock. "
            "Missing boundaries stay unobserved. No prompts, reasoning text, tool arguments or outputs are exported."
        ),
    }


def build_report(events, source=None, cache=None):
    data = summarize(events)
    source = source or native_source(events)
    if source:
        try:
            path = resolve_rollout(source)
            key = (str(path), source.get("sessionId"))
            native = cache.get(key) if cache is not None else None
            if native is None:
                native = read_codex_rollout(path, source.get("sessionId"))
                if cache is not None:
                    cache[key] = native
            data["codex"] = codex_summary(native, data)
        except (OSError, ValueError) as error:
            data["codex"] = {
                "status": "unavailable",
                "reason": str(error),
                "sessionId": source.get("sessionId"),
            }
    return data


def codex_markdown(data):
    lines = ["", "## Codex request / response timing", ""]
    if data["status"] != "available":
        return lines + [
            f"Unavailable: {data['reason']}. No different session was substituted."
        ]
    lines += [
        f"Native session: `{data['sessionId']}`. Last observed event: {data['lastEventAt']}.",
        "",
        data["limitations"],
        "",
        (
            "Full turns can start before recording or finish after the task journal. Their durations are shown "
            "separately and are not added to task elapsed time. An in-progress turn has no final duration or TTFT yet."
        ),
        "",
        "| Turn | Accepted (UTC) | Completed (UTC) | Full turn s | First token s | Status |",
        "| --- | --- | --- | ---: | ---: | --- |",
    ]
    for turn in data["turns"]:
        elapsed = f"{turn['seconds']:.3f}" if turn["seconds"] is not None else "—"
        first = (
            f"{turn['firstTokenSeconds']:.3f}"
            if turn.get("firstTokenSeconds") is not None
            else "—"
        )
        lines.append(
            f"| {turn['id']} | {turn['startedAt']} | {turn['endedAt'] or '—'} | {elapsed} | {first} | {turn['status']} |"
        )
    lines += [
        "",
        "Task wall time, without double-counting overlaps:",
        "",
        "| Activity | Seconds |",
        "| --- | ---: |",
    ]
    labels = {
        "command": "Timed commands",
        "compaction": "Context compaction outside timed commands",
        "tool": "Other recorded tool activity",
        "response": "Response windows outside tools / compaction",
        "unobserved": "Unobserved",
    }
    lines += [
        f"| {labels[kind]} | {seconds:.3f} |"
        for kind, seconds in data["breakdownSeconds"].items()
    ]
    lines += [
        "",
        (
            f"Recorded response completions: {len(data['responseWindows'])}. "
            f"Recorded model-item activity: {data['observedModelItemSeconds']:.3f}s (overlaps response windows)."
        ),
        "",
        "Each response window and exclusive wall-time segment is included in the JSON report.",
    ]
    if data["malformedLines"]:
        lines += [
            "",
            f"Skipped malformed/incomplete native records: {data['malformedLines']}.",
        ]
    return lines


def write_report(data, output_dir):
    output_dir.mkdir(parents=True, mode=0o700)
    private_write(output_dir / "timeline.json", json.dumps(data, indent=2) + "\n")
    private_write(output_dir / "report.md", markdown(data))
    print(f"Timeline: {output_dir / 'report.md'}", flush=True)


def wait_for_codex(events, source, timeout):
    """Wait by tailing metadata only, so the final reply can be captured after this agent ends."""
    path = resolve_rollout(source)
    native = read_codex_rollout(path, source.get("sessionId"))
    selected = codex_summary(native, summarize(events))["turns"]
    pending = {turn["id"] for turn in selected if turn["status"] == "in_progress"}
    deadline = time.monotonic() + timeout
    with path.open() as stream:
        stream.seek(native["readOffset"])
        while pending and time.monotonic() < deadline:
            position = stream.tell()
            line = stream.readline()
            if not line.endswith("\n"):
                stream.seek(position)
                time.sleep(min(1, max(0, deadline - time.monotonic())))
                continue
            try:
                record = json.loads(line)
                payload = record.get("payload", {})
                if record.get("type") == "event_msg" and payload.get("type") in (
                    "task_complete",
                    "turn_aborted",
                ):
                    pending.discard(payload.get("turn_id"))
            except (ValueError, AttributeError):
                continue
    return not pending


def analyze_history(root, output_dir, session_id=None, rollout=None, codex_home=None):
    cache, reports = {}, []
    for path in sorted(root.glob("*/timeline.jsonl")):
        events = read_events(path)
        if not any(e["event"] == "finish" for e in events):
            continue
        source = native_source(events, session_id, rollout, codex_home)
        data = build_report(events, source, cache)
        data["journalPath"] = str(path)
        reports.append(data)
    if not reports:
        raise ValueError("No completed task timelines found")
    totals = {
        key: sum(r[key] for r in reports)
        for key in (
            "seconds",
            "commandWallSeconds",
            "commandSeconds",
            "betweenCommandsSeconds",
        )
    }
    breakdown = {
        key: sum(
            r.get("codex", {}).get("breakdownSeconds", {}).get(key, 0) for r in reports
        )
        for key in ("command", "compaction", "tool", "response", "unobserved")
    }
    turns = {
        (r["codex"]["sessionId"], t["id"]): t
        for r in reports
        if r.get("codex", {}).get("status") == "available"
        for t in r["codex"]["turns"]
    }
    phases = {}
    for report in reports:
        for phase in report["phases"]:
            entry = phases.setdefault(
                phase["phase"], {"seconds": 0, "commandWallSeconds": 0}
            )
            for key in entry:
                entry[key] += phase[key]
    first_tokens = [
        t["firstTokenSeconds"]
        for t in turns.values()
        if t.get("firstTokenSeconds") is not None
    ]
    commands = [c for r in reports for c in r["commands"]]
    ci_jobs = {
        (run["databaseId"], job["name"], job["startedAt"]): job
        for r in reports
        for run in r["ciRuns"]
        for job in run["jobs"]
    }
    data = {
        "recordedFrom": min(r["startedAt"] for r in reports),
        "recordedThrough": max(r["observedAt"] for r in reports),
        "completedTasks": len(reports),
        "totals": totals,
        "breakdownSeconds": breakdown,
        "phases": phases,
        "medianFirstTokenSeconds": statistics.median(first_tokens)
        if first_tokens
        else None,
        "maxFirstTokenSeconds": max(first_tokens) if first_tokens else None,
        "failedCommands": [c for c in commands if c["status"] == "failed"],
        "ciJobs": list(ci_jobs.values()),
        "tasks": reports,
    }

    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")

    lines = [
        "# Recorded task timing analysis",
        "",
        f"{len(reports)} completed tasks, {data['recordedFrom']} → {data['recordedThrough']} (UTC).",
        (
            "Open tasks and time between tasks are excluded. Totals sum task durations; overlapping tasks, "
            "if present, are not a measure of calendar elapsed time."
        ),
        "",
        (
            f"Total recorded task time: **{totals['seconds'] / 60:.2f} min**. "
            f"Timed commands: **{totals['commandWallSeconds'] / 60:.2f} min "
            f"({100 * totals['commandWallSeconds'] / totals['seconds']:.1f}%)**. "
            f"Between commands: **{totals['betweenCommandsSeconds'] / 60:.2f} min**."
        ),
        "",
        "| Task | Elapsed s | Command wall s | Between commands s | Response windows s | Compaction s | Unobserved s |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for report in reports:
        native = report.get("codex", {}).get("breakdownSeconds", {})
        cells = [
            f"{native[k]:.1f}" if k in native else "—"
            for k in ("response", "compaction", "unobserved")
        ]
        lines.append(
            f"| {cell(report['task'])} | {report['seconds']:.1f} | {report['commandWallSeconds']:.1f} | "
            f"{report['betweenCommandsSeconds']:.1f} | {' | '.join(cells)} |"
        )
    lines += [
        "",
        "## Phases",
        "",
        "| Phase | Elapsed s | Command wall s |",
        "| --- | ---: | ---: |",
    ]
    lines += [
        f"| {name} | {p['seconds']:.1f} | {p['commandWallSeconds']:.1f} |"
        for name, p in phases.items()
    ]
    lines += [
        "",
        "## Native Codex turns",
        "",
        (
            "Turn durations include work before the recorder started and the final response after it finished. "
            "First-token latency is the turn-level value reported by Codex, not per-API-call latency."
        ),
        "",
        "| Turn start (UTC) | Full request-to-completion s | First token s |",
        "| --- | ---: | ---: |",
    ]
    for turn in turns.values():
        elapsed = f"{turn['seconds']:.3f}" if turn["seconds"] is not None else "—"
        first = (
            f"{turn['firstTokenSeconds']:.3f}"
            if turn.get("firstTokenSeconds") is not None
            else "—"
        )
        lines.append(f"| {turn['startedAt']} | {elapsed} | {first} |")
    if first_tokens:
        lines += [
            "",
            f"First token: median **{statistics.median(first_tokens):.3f}s**, max **{max(first_tokens):.3f}s**.",
        ]
    lines += [
        "",
        "## Longest commands",
        "",
        "| Command | Phase | Seconds | Result |",
        "| --- | --- | ---: | --- |",
    ]
    lines += [
        f"| {cell(c['label'])} | {c['phase']} | {c['seconds']:.3f} | {c['status']} |"
        for c in sorted(commands, key=lambda c: c["seconds"], reverse=True)[:12]
    ]
    lines += [
        "",
        (
            f"Failed commands: {len(data['failedCommands'])}; summed runtime "
            f"{sum(c['seconds'] for c in data['failedCommands']):.3f}s. This excludes later diagnosis and fixes."
        ),
        "",
        "## Interpretation limits",
        "",
        (
            "Response windows are observed client boundaries: turn start / tool result / previous response completion "
            "to a recorded response completion. They include request preparation, waiting and generation. "
            "They do not measure HTTP request latency, and no unlabelled gap is relabelled as model latency. "
            "The exclusive breakdown prioritizes commands, compaction, other tools, then response windows. "
            "Native UTC and local monotonic clocks are distinct. Missing native sources appear as unavailable. "
            "GitHub job execution overlaps local work and is not added to task time."
        ),
        "",
        (
            "The JSON includes all commands, native timing boundaries, exclusive intervals, failures, and CI job metadata. "
            "Prompts, reasoning text, tool arguments and outputs are excluded."
        ),
    ]
    output_dir.mkdir(parents=True, mode=0o700)
    private_write(output_dir / "analysis.json", json.dumps(data, indent=2) + "\n")
    private_write(output_dir / "report.md", "\n".join(lines) + "\n")
    print(f"Analysis: {output_dir / 'report.md'}", flush=True)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, help="Private append-only JSONL timeline")
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
    finish.add_argument(
        "--codex-report-dir",
        type=Path,
        help="Final native timing report; defaults to timing-codex beside the journal",
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
    report.add_argument(
        "--wait-for-codex",
        type=int,
        default=0,
        help="Wait up to this many seconds for overlapping native turns to finish",
    )
    codex = actions.add_parser(
        "codex",
        help="Associate an existing journal with its exact native Codex session",
    )
    history = actions.add_parser(
        "analyze", help="Analyze completed journals without modifying previous evidence"
    )
    history.add_argument("--root", type=Path, required=True)
    history.add_argument("--output-dir", type=Path, required=True)
    for action in (report, codex, history):
        action.add_argument("--codex-session-id")
        action.add_argument("--codex-rollout", type=Path)
        action.add_argument("--codex-home", type=Path)
    args = parser.parse_args(argv)
    if args.action != "analyze" and args.file is None:
        parser.error("--file is required for this action")
    try:
        if args.action == "start":
            start(args.file, args.task)
        elif args.action == "phase":
            append_event(args.file, "phase", phase=args.phase, label=args.label)
        elif args.action == "run":
            return run(args.file, args.label, args.command, args.phase)
        elif args.action == "finish":
            source = native_source(read_events(args.file))
            output_dir = args.codex_report_dir or args.file.parent / "timing-codex"
            append_event(
                args.file,
                "finish",
                status=args.status,
                **({"codexReportDir": str(output_dir)} if source else {}),
            )
            if source:
                # This read-only exporter survives the agent turn. Waiting inline
                # would deadlock: task_complete is emitted only after our final reply.
                log_path = args.file.parent / "codex-export.log"
                fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as log:
                    subprocess.Popen(
                        [
                            sys.executable,
                            str(Path(__file__).resolve()),
                            "--file",
                            str(args.file.resolve()),
                            "report",
                            "--output-dir",
                            str(output_dir.resolve()),
                            "--wait-for-codex",
                            "900",
                        ],
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=log,
                        start_new_session=True,
                        close_fds=True,
                    )
                print(
                    f"Final Codex timing export scheduled: {output_dir / 'report.md'}",
                    flush=True,
                )
        elif args.action == "github":
            capture_github(args.file, args.run_id, args.repo)
        elif args.action == "codex":
            source = native_source(
                [], args.codex_session_id, args.codex_rollout, args.codex_home
            )
            if source is None:
                raise ValueError("Supply --codex-session-id or --codex-rollout")
            native = read_codex_rollout(
                resolve_rollout(source), source.get("sessionId")
            )
            append_event(
                args.file,
                "codex",
                codex={
                    "sessionId": native["sessionId"],
                    "rolloutPath": native["rolloutPath"],
                },
            )
        elif args.action == "analyze":
            analyze_history(
                args.root,
                args.output_dir,
                args.codex_session_id,
                args.codex_rollout,
                args.codex_home,
            )
        else:
            events = read_events(args.file)
            source = native_source(
                events, args.codex_session_id, args.codex_rollout, args.codex_home
            )
            completed = None
            if args.wait_for_codex and source:
                try:
                    completed = wait_for_codex(events, source, args.wait_for_codex)
                except (OSError, ValueError):
                    completed = False
            data = build_report(events, source)
            if completed is not None:
                data["codex"]["completionObserved"] = completed
            write_report(data, args.output_dir)
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"Timeline error: {error}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
