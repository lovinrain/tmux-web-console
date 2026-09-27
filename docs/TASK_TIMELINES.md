# Task timelines

Use `scripts/task_timeline.py` at the start of repository work, before investigation
or editing. It records an append-only private JSONL journal, then generates a
readable timeline and a JSON report. No dependency installation is needed on Linux.

```bash
MUXTASK_DIR="$HOME/.local/state/muxdeck/deployments/$(date -u +%Y%m%dT%H%M%SZ)-task"
MUXTASK_TIMELINE="$MUXTASK_DIR/timeline.jsonl"
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" start "Describe the task"
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" phase implementation --label "Investigate and edit"
```

The journal path is absolute so commands from a worktree or staging directory can
share it. Mark the next phase **before** doing the work; repeat a phase with a new
label when useful. Phases are implementation, validation, deployment and reporting.
Wrap each command separately, including preparation, builds, tests, backups,
commit/push, installation and verification. Output streams normally, the exit code
is preserved, and command arguments, environment variables and output are not
copied into the journal. Use safe labels without credentials or private content.

```bash
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" phase validation --label "Check the affected behavior"
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" run --label "Related frontend tests" -- npm run test:related -- src/components/HistoryPanel.tsx
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" run --label "Staged frontend build" -- npm run build
```

Run a frontend build only from the **staging directory**, never the live checkout.
Independent commands can run concurrently against one journal; a file lock protects
event writes without serializing the commands. `run --phase validation` can label
a CI wait while the main phase is deployment. The script does not authorize any
command; normal repository and deployment rules still apply.

For GitHub Actions, wrap `gh run watch RUN_ID --exit-status` to measure local wait
time. After completion, capture the provider's timestamps too:

```bash
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" github --run-id RUN_ID
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" phase reporting --label "Review evidence and prepare delivery report"
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" finish --status success
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" report --output-dir "$MUXTASK_DIR/timing"
```

Replace `RUN_ID` with the numeric run ID; optional `--repo owner/repo` selects a
different repository. Record each relevant run. Only workflow/job metadata is
retained, never logs or step commands. CI job durations come from GitHub, which
has its own timestamp precision; they are separate from local command wall time.
Workflow creation/start/update timestamps expose queueing and final bookkeeping.
Keep user-facing progress updates at least every 60 seconds during CI waits.

Finish only after required work and report preparation. Use `failed` or `incomplete`
when appropriate; pending commands prevent a successful finish. A killed recorder
leaves a visibly unfinished command rather than reporting a false pass. Commands
cannot append to a finished journal. `report` also works during a task; choose a
fresh output directory for each report because prior evidence is never overwritten.

The report includes:

- UTC start/end timestamps and monotonic durations for each phase and command.
- Exit status, concurrent intervals, and summed command runtime versus actual
  elapsed wall time. Parallel commands count once in command wall time.
- Every interval between timed commands, with phase labels for context. These
  intervals can contain editing, analysis, communication, user waits or unwrapped
  commands; they are **not automatically idle time**.
- GitHub workflow/job timestamps when captured, without adding remote execution
  to overlapping local time.

It cannot reconstruct work before recording started or determine what happened
inside an unlabelled gap. Clock changes do not distort local durations. After a
host reboot, keep the old evidence and start a new timeline; do not mix monotonic
clocks from different boots. Finished reports can still be regenerated.
