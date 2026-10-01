---
name: muxpilot
description: Coordinate a repository goal through Muxpilot, Multica tasks, and visible Muxdeck workers when the user says "Use Muxpilot" or follows up on a bound Muxpilot project.
---

# Muxpilot

Use this workflow after explicit project opt-in: “Use Muxpilot for
~/git_farm/shop. Add password reset end to end, and open a PR when tested.”
An ordinary request in another repository does not opt it into Muxpilot.

You are the main coordinator. Multica owns tasks and runs; Muxdeck provides
visible tmux terminals; Muxpilot records project identity, decisions, receipts,
and recovery evidence. Use the installed command and configuration in the
installation binding below. Without that binding, use `muxpilot --help` and
read [the operator guide](../../docs/muxpilot/OPERATIONS.md) from this repository.
Commands return JSON. Use `muxpilot COMMAND --help` for flags and the examples
below for evidence files. Keep the original start goal for idempotent retries.

## Activate and retain context

1. Resolve the user's explicit repository path, expanding `~`. “This repository”
   means the verified current Git checkout. Read its applicable `AGENTS.md` and
   inspect branch and dirty state. Preserve existing work; independent changes
   need owned worktrees, and task-dependent dirty work needs a baseline snapshot.
2. Run `muxpilot doctor`. Check the actual readiness and capability results.
   Reuse healthy configured services. On availability failure, use the installed
   binding's exact status/start commands for owned local Multica dependencies:
   read the installed operations and full deployment guides first, verify the
   named units belong to this installation, and start only inactive dependencies.
   Then recheck readiness. Bootstrap is part of the main's project workflow;
   do not hand routine service startup to the human. If no managed startup is
   configured, inspect the installation's operations information before reporting
   the precise missing dependency. Do not invent a startup command or stop or
   restart unrelated services. Missing credentials or an incompatible pairing
   block dependent effects. Report the precise missing setup; do not substitute a
   provider, scrape terminal output into a protocol, or weaken authentication.
   Installed binaries and a passing synthetic test do not qualify a live model.
3. Run `muxpilot start --repo ABSOLUTE_PATH --goal VERBATIM_GOAL`, supplying
   `--main-conversation` when the actual conversation identity is available.
   In GitHub Copilot CLI, the shell's `COPILOT_AGENT_SESSION_ID` is that
   identity and `start` binds it automatically. The CLI verifies the main's
   tmux incarnation. Do not invent a session or conversation ID. If the current main has no usable tmux terminal, use the
   `muxpilot main --repo ABSOLUTE_PATH --goal VERBATIM_GOAL --model MODEL` with
   the bound main-model preference for an explicit handoff and
   stop coordinating in the old conversation. Never silently create two leads.
4. Retain the returned project ID, coordinator owner/generation, board URL,
   workspace URL, and event cursor. Show the actual links. Subsequent short
   requests apply to this binding. Repeated activation reconciles existing
   state; a changed goal requires a recorded decision and plan revision.

Clarify only ambiguity that changes scope, target, or authority. The human
supplies a repository and goal; you write the machine-readable plan internally.

## Plan and delegate substantial work

Analyze the relevant code, then write a private JSON plan and submit it with
`muxpilot plan PROJECT --file PLAN.json`. Use ordered stages and completion
criteria, for example:

```json
{
  "completion_criteria": ["Reset works end to end", "Integrated regression checks pass"],
  "stages": [
    {"stage": 1, "title": "Implementation", "tasks": [
      {"title": "Reset API", "description": "Implement reset using the existing email service; report commits, checks and limitations.", "agent_id": "ACTUAL_CONFIGURED_AGENT_ID", "acceptance": ["Expired and reused tokens are rejected"]},
      {"title": "Reset UI", "description": "Implement the reset flow in an owned worktree; report commits, checks and limitations.", "agent_id": "ACTUAL_CONFIGURED_AGENT_ID", "acceptance": ["User can request and complete a reset"]}
    ]},
    {"stage": 2, "title": "Integrated verification", "tasks": [
      {"title": "Verify integrated reset", "description": "Verify the exact integrated revision supplied by the main; report independent evidence.", "agent_id": "ACTUAL_CONFIGURED_AGENT_ID", "acceptance": ["Representative end-to-end and failure cases pass"]}
    ]}
  ]
}
```

Discover the approved configured roster with `muxpilot agents PROJECT`;
the sample values are explanatory. Each assignment must include acceptance,
base revision, worktree/allowed-path ownership, handoff format, and constraints.
Open-ended implementation, investigation, and review each get a visible
Multica task and independent root worker execution. Only deterministic helpers
with a fixed input/output and narrow scope may remain internal. Record their
use and available capture coverage; instructions alone are not a sandbox.
Supported worker profiles disable provider-native helper delegation: Codex runs
with `--disable multi_agent`; GitHub Copilot runs with its `task`, `read_agent`,
`write_agent` and `list_agents` tools excluded and refuses `--fleet`. The
recorded control evidence does not claim that all provider-native history is
available, or isolate hostile same-user processes.

New projects begin with dispatch held. When the recorded plan is ready, run
`muxpilot hold PROJECT --off`, then activate the eligible batch with
`muxpilot activate PROJECT --stage NUMBER`.
For dependent verification, pass `--base EXACT_ACCEPTED_INTEGRATION_SHA`.
Future stages remain in fixed Backlog with no-start ownership writes. Verify
the current stage's accepted results before activating the next. A cancelled
or failed prerequisite does not count as acceptance unless a recorded scope
decision removes it. Respect the configured concurrency and dispatch hold.
Native parent wakeups must reach this main's inbox, never a hidden second lead.

## Continue, observe, and handle human direction

While work remains, call `muxpilot events PROJECT --after CURSOR --wait 30`.
After evaluating returned worker/human events, record your decision with
`muxpilot decision PROJECT --message SUMMARY --ack LAST_PROCESSED_CURSOR`.
Advance only the cursor whose events informed that recorded decision. Keep
awaits bounded and interruptible so the human can steer the interactive main.
Renew with `muxpilot renew PROJECT` before the returned lease expires; schedule
renewal during the active loop, allowing at least half the lease duration for
failures. Expired or revoked authority requires explicit resume/reconciliation.
Idle wakeup is provider-dependent: retain pending events and expose an idle
main explicitly; never inject raw terminal keystrokes as an assumed wakeup.

Use `muxpilot status PROJECT` for “Where are we?” Include completion criteria,
actual task/run states, blockers, live links, and last confirmed activity.

| Human intent | Tool operation and interpretation |
| --- | --- |
| “Tell the API agent to reuse our email service” | `control PROJECT --task TASK --run RUN --action supplement --message TEXT`; report queued/delivered/acknowledged status exactly as returned. If it fails with `task_supplement_unsupported` (GitHub Copilot workers have no live input channel), use cancel-and-resume below |
| Steering without live input (cancel-and-resume) | `control ... --action cancel` for the exact run; poll `status` until that run is `cancelled`; then `control PROJECT --task TASK --run SAME_RUN --action continue --message TEXT`. The new attempt resumes the same provider session and worktree when resume-safe and receives TEXT as a coordinator follow-up. Track the returned new run ID; report this as cancel-and-resume, not live steering |
| “Show me that agent” | Status plus `control ... --action inspect`; show the exact run's terminal/history link |
| “Stop starting tasks; let current work finish” | `hold PROJECT`; active runs continue |
| “Start tasks again” | `hold PROJECT --off`, then evaluate stage eligibility |
| “Stop the frontend task” | Exact-run `control ... --action cancel`; inspect the resulting authoritative outcome |
| “Resume this project” | Inspect `recovery PROJECT`; use `resume PROJECT --owner ACTUAL_BOUND_OWNER` for the same main, then reconcile existing workers before dispatch |
| “Show each agent's contribution” | `audit PROJECT --destination PRIVATE_NEW_DIRECTORY`; explain evidence and coverage gaps |

Request only supported control actions. Delivery is not acknowledgement or
compliance, interrupt is not proven termination, and process exit is not task
acceptance. A generic “pause” needs the intended scope established. Structured
worker panes mirror output; browser typing does not reach provider stdin.
Human-only routes stay human-only; never impersonate a human for steering.

Lost receipts or timeouts require reconciliation using the original operation
identity. Do not create another worker or another operation ID to hide an
uncertain result. Inspect `muxpilot recovery PROJECT` for read-only ownership,
main/session, run, and operation evidence even when authority expired or resume
is blocked; `--export PRIVATE_NEW_DIRECTORY` retains a private recovery bundle.
A stale ownership generation requires resume/reconciliation, never bypassing
the fence. Replacing the old main requires explicit human takeover authority.
After verifying the replacement main's actual current session and conversation,
use `muxpilot resume PROJECT --owner ACTUAL_NEW_OWNER --takeover
--main-session ACTUAL_CURRENT_MAIN_SESSION --main-conversation ACTUAL_CONVERSATION_ID`.
In GitHub Copilot CLI, use `"$COPILOT_AGENT_SESSION_ID"` for both the new owner
and conversation and `"$(tmux display-message -p '#S')"` for the session; a
Copilot main bound by `start` uses its conversation ID as its owner.
A new owner must supply that verified session; a reused name is insufficient.
Ordinary resume does not authorize takeover. Reconcile existing workers and
uncertain operations before any dispatch.

## Integrate and finish the goal

Inspect worker commits/patches and checks against their task/run/base identities.
Native Multica may remove a worker's temporary checkout after its run ends.
Its committed objects remain in the registered repository. For independent
checks, create your own disposable review checkout with
`git -C REPO worktree add --detach PRIVATE_REVIEW_PATH WORKER_SHA`; run checks
there and retain the resulting evidence. Do not assume an ended worker's `cwd`
still exists, and do not use an unrelated checkout's revision as its evidence.
Missing, corrupt, stale, or failing evidence blocks acceptance. First record each
verified task with `muxpilot accept PROJECT --issue ACTUAL_TASK_ID
--evidence FILE`. Its private JSON evidence names the latest actual successful
`run_id`, `revision`, the recorded stage `base_sha`, and nonempty
`checks` containing `command`, `revision`, and `passed: true`. Write factual
outcomes from executed checks; do not turn a worker's assertion into a pass.
For example, an acceptance file has this shape (replace every identity and
record only a check that you actually ran on that revision):

```json
{"run_id":"ACTUAL_RUN_ID","revision":"WORKER_SHA","base_sha":"STAGE_BASE_SHA","checks":[{"command":"ACTUAL_CHECK_COMMAND","revision":"WORKER_SHA","passed":true}]}
```

For an explicitly coordinator-owned task without a worker run, the evidence
declares `coordinator_owned: true`; never use that to hide delegated work.

Then integrate that accepted source revision in the owned integration checkout
with `muxpilot integrate PROJECT --commit SOURCE_SHA --base RECORDED_STAGE_BASE_SHA`.
The base identifies the full source change range, including multiple worker
commits; do not guess it from the integration checkout's later HEAD. Surface
conflicts and preserve unrelated work. Before releasing a verification stage,
give it the exact integrated revision and relevant results.
The integration response supplies `path`, `branch`, and `integration_sha`.
Use that returned path for combined checks and publication. A verification-only
worker can return the unchanged verified revision; accept its completed run and
checks without inventing a commit or integrating an empty change range.

Run the checks appropriate to the complete goal on that revision. Record check
commands, outcomes, artifact references, final commit, and requested delivery
receipt in a private evidence JSON file. Closure evidence contains `revision`,
the plan's exact `completion_criteria`, nonempty `checks` with `command`,
`revision`, and `passed: true`, and `deliverable` with `kind: "commit"` or
`"pr"`, the same `revision`, and the actual `url` for a PR. Call
`close PROJECT --evidence FILE`. Open a PR only when requested/authorized and
verified. Before the external publish, call `muxpilot operation PROJECT --kind
publish.pr --payload PRIVATE_PAYLOAD.json --operation-id STABLE_UUID` and execute
the external command only when its receipt says `execute_allowed: true`. After checking the
actual PR, confirm the same intent with the same command plus `--receipt
PRIVATE_RECEIPT.json`. A prior admitted/pending intent needs remote lookup and
reconciliation; do not repeat publication after a lost reply. Retain the actual
URL/revision and receipt.
For a PR, closure's `deliverable.operation_id` identifies that confirmed
publication, whose receipt includes the matching `url` and `revision`.
The publication payload describes your intended repository, head branch, base
branch, and revision; retain the same payload and operation UUID for confirmation.
For example, use `{"repo":"ABSOLUTE_REPO","head":"INTEGRATION_BRANCH",
"base":"main","revision":"INTEGRATION_SHA"}` as the intent and
`{"url":"ACTUAL_PR_URL","revision":"INTEGRATION_SHA"}` as its verified receipt.
After admission, push the integration branch and create the requested PR with
the repository's normal Git/GitHub tools, then query the PR to verify its actual
head revision and target before confirming that receipt.
For example, a PR closure file is:

```json
{"revision":"INTEGRATION_SHA","completion_criteria":["EXACT_CRITERION_FROM_PLAN"],"checks":[{"command":"ACTUAL_GOAL_CHECK","revision":"INTEGRATION_SHA","passed":true}],"deliverable":{"kind":"pr","revision":"INTEGRATION_SHA","url":"ACTUAL_PR_URL","operation_id":"CONFIRMED_PUBLICATION_UUID"}}
```

Use every criterion from the recorded plan and only actual final check results.
Failed, blocked, cancelled, or uncertain work cannot produce a completion claim.

Finish with the delivered revision/PR, checks and outcomes, material limitations,
and audit location. Keep token contents, ambient environment, and private
unrelated data out of task descriptions, decisions, exports, and user reports.
Never restart tmux, kill its server, destroy unrelated sessions, or expose an
unauthenticated console publicly. For installation, lifecycle, backup, or
rollback, read the installed operations guide and deployment runbook first.
