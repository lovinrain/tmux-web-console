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

When run inside Codex, `start` automatically records `CODEX_THREAD_ID` (falling back
to `CODEX_SESSION_ID`) and the native transcript location under `CODEX_HOME`.
It never guesses a session from the working directory or the most recently modified
transcript. Outside Codex, the command/phase recorder works without native timing.

The journal path is absolute so commands from a worktree or staging directory can
share it. Mark the next phase **before** doing the work; repeat a phase with a new
label when useful. Phases are implementation, validation, deployment and reporting.
Wrap each command separately, including preparation, builds, tests, backups,
commit/push, installation and verification. Output streams normally, the exit code
is preserved, and command arguments, environment variables and output are not
copied into the journal. Use safe labels without credentials or private content.

```bash
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" phase validation --label "Check the affected behavior"
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" run --label "Affected frontend tests" -- npm test -- src/components/HistoryPanel.test.tsx
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

For a linked Codex session, `finish` also starts a bounded, read-only background
exporter. It tails the native transcript until the overlapping turn completes, so
the final reply and Codex's reported first-token latency can be included. Waiting
for that event inside the agent turn would deadlock. The completed report goes to
`timing-codex/report.md` beside the journal; override it with
`finish --codex-report-dir PATH`. Its log is `codex-export.log`. It exits after
15 minutes if completion is not observed and leaves open turns explicitly incomplete.
The ordinary `report` command remains an immediate snapshot. No service is installed
or restarted, and the native transcript and finished journal are never changed.

The report includes:

- UTC start/end timestamps and monotonic durations for each phase and command.
- Exit status, concurrent intervals, and summed command runtime versus actual
  elapsed wall time. Parallel commands count once in command wall time.
- Every interval between timed commands, with phase labels for context. These
  intervals can contain editing, analysis, communication, user waits or unwrapped
  commands; they are **not automatically idle time**.
- GitHub workflow/job timestamps when captured, without adding remote execution
  to overlapping local time.
- Native Codex turn start/completion, full turn duration, first-token delay, final
  reply boundaries, context compaction, and tool activity when those records exist.
- Each completed model response's observed window, from turn start, the last tool
  result, or the preceding response completion to its `token_usage_record`.
  These are **client response windows**, including preparation, orchestration,
  waiting and generation. They are not measured HTTP request latency or pure model
  inference time; the transcript does not provide a per-request send timestamp.
- An exclusive wall-time breakdown: timed commands, compaction, other recorded
  tools, response windows, then unobserved time. Higher-priority categories win
  overlaps. Recorded reasoning/message item durations are shown separately
  because they cover only part of a streamed model response.

Only native event types, IDs, timestamps and numeric token counts are imported.
Prompts, reasoning text, tool arguments and outputs are not copied. Missing records
remain missing: older Codex versions may lack turn duration, first-token, item, or
response-completion metadata. Full Codex turns can extend before/after the command
journal, and their durations are not added to the journal's elapsed time.

The command recorder cannot reconstruct commands before recording started or
determine what happened inside an unlabelled gap. Clock changes do not distort
local command durations; native Codex timestamps use a separate UTC wall clock. After a
host reboot, keep the old evidence and start a new timeline; do not mix monotonic
clocks from different boots. Finished reports can still be regenerated.

To associate a journal that was started before automatic linking:

```bash
python3 scripts/task_timeline.py --file "$MUXTASK_TIMELINE" codex --codex-session-id SESSION_UUID
```

For a finished journal, supply `--codex-session-id` to `report` instead; this
backfills a new report without rewriting prior evidence. An explicit native path
can be passed as `--codex-rollout PATH`; use `--codex-home PATH` for a different
Codex data directory. If both an ID and path are given, their identities must match.

Analyze every completed task under the recording directory:

```bash
python3 scripts/task_timeline.py analyze \
  --root "$HOME/.local/state/muxdeck/deployments" \
  --output-dir "$MUXTASK_DIR/history"
```

This uses each journal's own linked session. For older journals known to belong
to one session, add `--codex-session-id SESSION_UUID` explicitly. The analysis
includes per-task and phase totals, native turn/response timing, failed commands,
and GitHub job metadata. Open tasks and gaps between tasks are excluded. Totals sum
task durations; concurrent tasks must not be interpreted as calendar elapsed time.
