#!/usr/bin/env python3
"""Run isolated synthetic Muxpilot checks and retain an honest evidence ledger.

Passing checks are not full-v1 acceptance. Real provider, natural-language,
browser, paired CI and release evidence are independent required inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[1]
COVERAGE: dict[str, dict[str, Any]] = {
    "test_real_worktree_result_handoff_and_goal_integration_preserve_dirty_source": {
        "scenarios": ["A10", "A11", "A12"],
        "claim": "Real dirty repository preservation, worker commit handoff, missing-check rejection and integration-revision goal verification.",
    },
    "test_real_git_conflicting_workers_leave_explicit_unresolved_integration": {
        "scenarios": ["A10", "A12"],
        "claim": "Real conflicting worker commits remain unresolved in the owned integration worktree; source work is retained.",
    },
    "test_real_journal_replay_fencing_artifact_integrity_and_wal_restore": {
        "scenarios": ["A13", "A14", "A15", "A18", "A19", "A23", "A25"],
        "claim": "Durable journal replay, local generation fencing, artifact integrity, redacted audit and SQLite-aware active-WAL backup/restore.",
    },
    "test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution": {
        "scenarios": ["A05", "A16", "A20", "A21", "A24"],
        "claim": "Actual isolated-tmux stdio wrapper with synthetic provider continues after main requester and project service loss; replay refuses duplicate execution and retains output.",
    },
    "test_real_service_controller_replays_backend_events_and_fences_stale_mutation": {
        "scenarios": ["A09", "A13", "A18", "A19", "A26"],
        "claim": "Unix service/controller and fake HTTP Multica cross-process replay, restart, receiver fence and authorization boundary.",
    },
    "test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker": {
        "scenarios": ["A13", "A17", "A18", "A19", "A20", "A25"],
        "claim": "Opt-in isolated native API outage/restart preserves receipt/event identity and active fake provider; actual daemon SIGKILL/restart confirms old process stopped and failure with distinct queued retry lineage while dispatch hold persists. Retention expiry remains synthetic coverage.",
    },
    "test_paired_multica_daemon_three_workers_stage_steering_resume_integration": {
        "scenarios": ["A01", "A04", "A05", "A07", "A09", "A10", "A11", "A12", "A13", "A16", "A18", "A20", "A24", "A25"],
        "claim": "Opt-in actual Multica backend/daemon, projectd, Muxdeck and tmux: three staged synthetic RPC workers, human supplement, main loss/resume, exact integration baseline, terminal bindings and commit closure. Scripted coordinator; no real provider or browser proof.",
    },
}

FAULT_CHECKS = {
    "main loss with independently owned worker": ["test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution"],
    "integration service crash/restart": ["test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution"],
    "separate process crash after committed WAL event": ["test_real_journal_replay_fencing_artifact_integrity_and_wal_restore"],
    "duplicate execution retry versus distinct invocation": ["test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution"],
    "local stale ownership after lease expiry": ["test_real_journal_replay_fencing_artifact_integrity_and_wal_restore"],
    "artifact corruption/missing file and incomplete export": ["test_real_journal_replay_fencing_artifact_integrity_and_wal_restore"],
    "conflicting accepted worker commits": ["test_real_git_conflicting_workers_leave_explicit_unresolved_integration"],
    "real daemon crash with active provider": ["test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker"],
    "actual Muxdeck receiver delay across takeover": [],
    "native Multica backend outage/restart": ["test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker"],
    "native retention expiry/recovery": [],
    "host/storage power-loss durability": [],
    "before intent commit": ["test_fault_before_intent_commit_has_no_remote_effect_or_phantom_intent"],
    "intent committed before send": ["test_fault_after_intent_before_send_replays_same_operation_identity"],
    "sent before remote acceptance": ["test_fault_sent_before_acceptance_requires_lookup_before_idempotent_retry"],
    "remote acceptance followed by lost reply": ["test_fault_remote_acceptance_before_reply_recovers_without_duplicate_effect"],
    "received receipt before local commit": ["test_fault_received_receipt_before_local_commit_is_recovered_from_authority"],
    "receipt before plan projection": ["test_fault_receipt_before_plan_projection_repairs_from_durable_receipt"],
    "integration receipt before local projection": ["test_fault_integration_receipt_before_projection_reuses_actual_git_result"],
    "checkpoint transaction failure": ["test_fault_checkpoint_failure_rolls_back_receipt_then_reconciles_once"],
    "backend outage/restart and disk receipt reconciliation": ["test_fault_backend_outage_restart_restores_disk_receipt_without_new_effect"],
    "human edit during lost reply and cursor replay": ["test_fault_human_edit_during_lost_reply_survives_cursor_replay_and_decision"],
    "fake HTTP receiver delay across takeover": ["test_fault_receiver_rejects_old_epoch_request_already_in_flight"],
    "feed reorder/duplicate conflict/retention gap": ["test_fault_http_feed_reorder_duplicate_conflict_and_retention_gap_are_explicit"],
}

for boundary, names in FAULT_CHECKS.items():
    for name in names:
        if name.startswith("test_fault_"):
            COVERAGE[name] = {"scenarios": ["A13", "A18", "A19", "A20", "A25"],
                              "claim": "Deterministic actual journal/controller/HTTP adapter with durable authoritative fake backend: " + boundary + ". See call-count and receipt assertions; no actual provider process is inferred."}


def private_write(path: Path, content: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(content)


def version(command: list[str], cwd: Path | None = None) -> str | None:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                                timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def cases_from_junit(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    cases = []
    for case in ET.parse(path).iter("testcase"):
        status = "passed"
        reason = None
        for kind in ("failure", "error", "skipped"):
            detail = case.find(kind)
            if detail is not None:
                status = "skipped" if kind == "skipped" else "failed"
                reason = detail.attrib.get("message", kind)
                break
        name = case.attrib.get("name", "unknown")
        coverage = COVERAGE.get(name.split("[", 1)[0], {})
        cases.append({"name": name, "class": case.attrib.get("classname"),
                      "status": status, "seconds": float(case.attrib.get("time", 0)),
                      "reason": reason, "scenarios": coverage.get("scenarios", []),
                      "claim": coverage.get("claim", "Focused check; inspect source for its exact scope.")})
    return cases


def source_hashes() -> dict[str, str]:
    paths = list((REPOSITORY / "muxpilot").glob("*.py"))
    paths.extend(REPOSITORY / "tmux_console" / name for name in
                 ("app.py", "control_cli.py", "stdio_bridge.py", "stdio_runner.py", "tmux.py", "workspaces.py"))
    paths.extend((REPOSITORY / "tests").glob("test_muxpilot*.py"))
    paths.append(Path(__file__).resolve())
    return {str(path.relative_to(REPOSITORY)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="new private evidence directory (never overwritten)")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--multica-checkout", type=Path)
    parser.add_argument("--paired-config", type=Path,
                        help="opt in to the actual managed Multica backend/daemon with its dedicated fake-provider profile")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--require-v1", action="store_true",
                        help="fail unless complete-v1 evidence is available; synthetic checks alone never satisfy it")
    default_tests = ["tests/test_muxpilot_e2e.py"]
    if (REPOSITORY / "tests/test_muxpilot_faults.py").is_file():
        default_tests.append("tests/test_muxpilot_faults.py")
    parser.add_argument("tests", nargs="*", default=default_tests)
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    output = args.output_dir.expanduser().absolute()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    started = datetime.now(UTC).isoformat()
    sources_before = source_hashes()
    command = [args.python, "-m", "pytest", "-q", *args.tests,
               "--basetemp=" + str(output / "fixtures"),
               "--junitxml=" + str(output / "pytest.xml")]
    environment = dict(os.environ)
    if args.paired_config:
        environment["MUXPILOT_PAIRED_CONFIG"] = str(args.paired_config.expanduser().absolute())
    else:
        environment.pop("MUXPILOT_PAIRED_CONFIG", None)
    print("validation: isolated synthetic Muxpilot checks started", flush=True)
    descriptor = os.open(output / "pytest.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    began = time.monotonic()
    with os.fdopen(descriptor, "w") as log:
        try:
            process = subprocess.Popen(command, cwd=REPOSITORY, env=environment, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + args.timeout
            while process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Let pytest unwind fixture cleanup before escalation.
                    process.send_signal(signal.SIGINT)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    returncode = 124
                    break
                try:
                    process.wait(timeout=min(30, remaining))
                except subprocess.TimeoutExpired:
                    print(f"validation: checks running ({time.monotonic() - began:.1f}s command runtime)", flush=True)
            else:
                returncode = process.returncode
        except OSError as error:
            log.write(f"Runner could not start: {type(error).__name__}\n")
            returncode = 127
    elapsed = time.monotonic() - began
    sources_after = source_hashes()
    if (output / "pytest.xml").exists():
        (output / "pytest.xml").chmod(0o600)
    cases = cases_from_junit(output / "pytest.xml")
    ledger = []
    for number in range(1, 28):
        scenario = f"A{number:02d}"
        covered = [case for case in cases if scenario in case["scenarios"]]
        outcome = "failed" if any(case["status"] == "failed" for case in covered) else "partial" if any(case["status"] == "passed" for case in covered) else "missing"
        ledger.append({"scenario": scenario, "status": outcome,
                       "checks": [case["name"] for case in covered],
                       "reason": "Exact synthetic assertions passed; remaining scenario/product evidence requires separate review." if outcome == "partial" else "See failed check evidence." if outcome == "failed" else "No evidence supplied by this synthetic check run."})
    suite_passed = returncode == 0 and any(case["status"] == "passed" for case in cases) and all(case["status"] != "failed" for case in cases)
    fault_ledger = []
    for injection, test_names in FAULT_CHECKS.items():
        selected = [case for case in cases if case["name"].split("[", 1)[0] in test_names]
        status = "failed" if any(case["status"] == "failed" for case in selected) else "exercised" if selected and all(case["status"] == "passed" for case in selected) else "missing"
        fault_ledger.append({"injection": injection, "status": status,
                             "checks": [case["name"] for case in selected]})
    report = {
        "schema_version": 1, "started_at": started,
        "finished_at": datetime.now(UTC).isoformat(),
        "mode": "synthetic providers; isolated repositories, sockets and local services",
        "suite_passed": suite_passed, "v1_accepted": False,
        "command_runtime_seconds": elapsed, "returncode": returncode,
        "muxdeck_commit": version(["git", "rev-parse", "HEAD"], REPOSITORY),
        "muxdeck_dirty": bool(version(["git", "status", "--porcelain"], REPOSITORY)),
        "muxdeck_source_hashes_before": sources_before,
        "muxdeck_source_hashes_after": sources_after,
        "muxdeck_source_stable_during_checks": sources_before == sources_after,
        "multica_commit": version(["git", "rev-parse", "HEAD"], args.multica_checkout) if args.multica_checkout else None,
        "multica_dirty": bool(version(["git", "status", "--porcelain"], args.multica_checkout)) if args.multica_checkout else None,
        "python": platform.python_version(), "tmux": version(["tmux", "-V"]),
        "tests": cases, "scenario_ledger": ledger, "fault_ledger": fault_ledger,
        "paired_reports": [str(path.relative_to(output)) for path in (output / "fixtures").rglob("paired-report.json")],
        "unverified": ["Authenticated provider pairing and natural-language autonomous coordinator",
                       "Complete Multica backend/daemon fault matrix and browser scenarios",
                       "Requested external PR delivery, paired CI, deployment/rollback and live release checks"],
        "artifacts": {"test_log": "pytest.log", "junit": "pytest.xml"},
    }
    private_write(output / "report.json", json.dumps(report, indent=2) + "\n")
    lines = ["# Muxpilot isolated validation", "",
             f"Synthetic checks: **{'passed' if suite_passed else 'failed'}**. Complete v1 acceptance: **not established**.", "",
             f"Command runtime: {elapsed:.2f}s. Muxdeck commit: `{report['muxdeck_commit']}` (dirty: {report['muxdeck_dirty']}).",
             "", "| Check | Outcome | Evidence scope |", "| --- | --- | --- |"]
    lines.extend(f"| {case['name']} | {case['status']} | {case['claim']} |" for case in cases)
    lines.extend(["", "| Scenario | Evidence status |", "| --- | --- |"])
    lines.extend(f"| {item['scenario']} | {item['status']} |" for item in ledger)
    lines.extend(["", "| Fault boundary | Evidence status |", "| --- | --- |"])
    lines.extend(f"| {item['injection']} | {item['status']} |" for item in fault_ledger)
    lines.extend(["", "Missing product/release evidence:", ""])
    lines.extend("- " + item for item in report["unverified"])
    lines.extend(["", "Raw output: [pytest.log](pytest.log). Structured cases: [pytest.xml](pytest.xml). Full ledger: [report.json](report.json).", ""])
    private_write(output / "report.md", "\n".join(lines))
    print(f"validation: {'passed' if suite_passed else 'failed'} after {elapsed:.2f}s; report {output / 'report.md'}", flush=True)
    if args.require_v1:
        print("validation: complete-v1 gate remains unsatisfied; synthetic success alone is insufficient", flush=True)
        return 2
    return 0 if suite_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
