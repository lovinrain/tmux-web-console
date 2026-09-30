# Muxpilot development and delivery workflow

This is the feature-specific delivery policy requested by the user. It supplements
[AGENTS.md](../../AGENTS.md) and the [deployment runbook](../../AGENT_DEPLOYMENT_GUIDE.md).

## Planning change

The current change writes the specification, decisions, task plan, and definition
of done. Commit and push these documents on **feat/muxpilot** after validation.
Keep the feature on that branch for implementation; do not merge planning alone
to the default branch or deploy an incomplete feature. Documentation needs no
frontend build or service restart.

The isolated worktree is /root/tmux-web-console-worktrees/muxpilot. The primary
checkout and unrelated task worktrees remain independent. This repository's
actual default branch is **master**, despite the user's generic wording "main".

## Branch topology

~~~text
Muxdeck origin/master
  feat/muxpilot                    shared integration branch
    muxpilot/mxp-006-journal       task branch and isolated worktree
    muxpilot/mxp-010-activation    task branch and isolated worktree
    muxpilot/mxp-019-terminal-ui   task branch and isolated worktree

Authorized Multica fork/main
  feat/muxpilot                    paired integration branch
    muxpilot/mxp-005-auth
    muxpilot/mxp-016-supplements
    muxpilot/mxp-018-events
~~~

The names of task branches are examples; task IDs and target integration branch
must be recorded. Task branches start from the latest appropriate feature branch,
not an old default checkout. Merge reviewed tasks into the integration branches;
do not land individual feature tasks on defaults before the full-v1 gate.

The Multica checkout currently has only upstream multica-ai/multica as origin.
MXP-004 must establish the writable target and base explicitly before publishing
changes. Preserve the upstream remote and existing history. A fork default is
the merge target unless an upstream contribution is separately authorized;
creating a paired feature does not imply permission to merge upstream main.

## Agent team

Use **gpt-6.1-sol** for development subagents, as explicitly requested by the
user. The lead agent owns integration, decisions that span components, and
delivery evidence. This is a development policy, not a restriction on the
providers/models supported by the finished Muxpilot runtime.

Recommended parallel lanes after the shared contracts are settled:

| Lane | Ownership | Typical output |
| --- | --- | --- |
| Project service/storage | New Python package, journal, operations, fencing, restore | Transaction/fault tests and service contracts |
| Multica integration | Scoped coordinator API, worker metadata, durable events | Go/API tests, SQL migrations/sqlc output |
| Agent/runtime | Instruction package, tool adapters, capability probe, worktrees | Synthetic protocol tests and authorized smoke evidence |
| User interface | Multica task/run links and control feedback | Shared view/component and representative browser checks |
| Independent review | Requirement traceability, failure semantics, compatibility | Findings tied to files and acceptance scenarios |

Assign one writer per file/component at a time. The lead defines shared API and
event schemas before dependent agents edit callers. Independent implementation
tasks get separate Git worktrees and branches; a dirty baseline must be preserved
before dependent edits. All agents read the applicable repository instructions.

For this documentation-only planning pass, authors may share the isolated
planning worktree with disjoint file ownership: SPEC/README/DELIVERY (lead),
DECISIONS (architecture), TASKS (planning), ACCEPTANCE (QA). Only the lead stages,
commits, and pushes the combined document set. Reviewers do not silently rewrite
another author's active file.

Every task handoff includes:

1. Task ID, requirement IDs, dependencies, branch/base, and exact file ownership.
2. Deliverables and acceptance/evidence expected from TASKS.md and ACCEPTANCE.md.
3. Interface assumptions and relevant architecture decisions.
4. Commands/checks actually run, results, source SHA, remaining concerns, and
   the commit(s) ready for integration.

The user explicitly authorizes this multi-agent development team. It does not
claim that the unfinished Muxpilot system already manages these agents. Later
dogfooding may use Muxpilot only after its initial capability/scope checks pass.

## Task completion and integration

Before marking a task done, inspect the diff, run the focused tests for changed
behavior, verify the task's acceptance items, and attach evidence to its status
entry. Use docs link/reference checks and git diff --check for documentation.
Avoid full local test suites for low-risk document edits; CI retains its current
Python/frontend/secret checks. No new redundant tests are needed for prose.

Merge or cherry-pick the reviewed task commits to the feature branch, preserving
their attribution and any source-to-artifact evidence. Resolve integration
conflicts there and rerun checks for affected behavior. Changes to an API/event
contract require reconciliation of its provider, consumer, fixtures, and docs.
Do not let concurrent tasks update a shared schema independently.

Task status belongs in TASKS.md. Use planned, in_progress, blocked, or done with
the actual evidence and reason. Blocked identifies a missing dependency or
capability; it does not mean a feature has passed. A released claim must be tied
to the source pair and provider matrix that were tested.

## Final merge and release

1. Complete the premerge portion of the full-v1 gate in ACCEPTANCE.md, including failures/recovery,
   permissions, human intervention, artifact closure, audit/export, and provider
   capabilities. Real agent runs require the explicit authorization specified
   by the Multica repository; routine unit/browser tests use fakes/disposable
   resources. Authorization to use GPT-6.1-sol development subagents is not by
   itself authorization to run authenticated provider smoke tests on live work.
2. Update both feature branches against their intended default branches in
   isolated worktrees. Verify the combined source pair and rerun checks affected
   by those updates. Record the exact Muxdeck and Multica SHAs, migrations,
   supported protocol/capability versions, and deployment artifact hashes.
3. Build frontend artifacts in staging directories. Exercise the paired
   installation with isolated database/runtime/session resources and record
   the first-install, upgrade, rollback, and restore results.
4. Complete final feature PRs/reviews against the authorized default branches.
   Merge the feature only after all required premerge evidence and checks pass. The two
   Git repositories cannot merge atomically: capability negotiation and the
   compatibility manifest must keep an incomplete source/deploy pair disabled.
5. Read the entire deployment runbook before runtime changes. Capture baseline
   evidence using scripts/check_deployment.py; preserve persistent state,
   credentials, current launch fences, and a usable previous release.
6. Deploy the tested pair in the sequence established by MXP-025: update the
   Multica backend and coordinator capability while feature activation is off,
   install the compatible Muxdeck/project service and UI, verify the pair, then
   enable project use. Mixed-version startup fails explicitly for unsupported
   capabilities rather than bypassing auth or substituting terminal scraping.
7. Reuse check_deployment.py for post-install verification and compare the
   original tmux/session identities. Restart only the services whose validated
   changes require it; never restart tmux or terminate unrelated sessions.
8. Retain the rollback pair and backups until acceptance. Rollback disables new
   dispatch first and follows a tested running-worker policy. Do not restore an
   old launch-request database over newer duplicate-launch fences. Restore
   journal backups into a new ownership generation and reconcile live systems.

A27 separates isolated premerge release rehearsal from actual postmerge
deployment verification. The latter closes the delivered-release gate; requiring
it before merging would contradict this branch-first workflow. A failed live
verification triggers the rehearsed rollback and leaves delivery incomplete.

The current planning turn does not execute these release steps. The user's
branch-first request overrides routine immediate deployment for this feature;
it does not add repeated approval questions for already authorized task pushes.

## Timing and evidence

Start a private scripts/task_timeline.py journal before every implementation or
deployment task; record phase changes and wrap commands, tests, Git actions,
builds, and CI waits. Concurrent commands use the same journal safely. Capture
GitHub workflow/job timestamps using the timeline github command and link the
generated report. Distinguish measured command runtime from elapsed task time.

Progress reports identify implementation, validation, deployment, or reporting
and describe findings at least every 60 seconds during active work. Surface a
failed check promptly and state its impact. Do not leave finished checks
presented as ongoing while preparing a patch or report.

Keep runtime logs, credentials, provider transcripts, project briefs, and private
reports outside Git. Commit reproducible fixtures and sanitized acceptance
summaries. The release report names the paired source versions, evidence paths,
actual checks, remaining limitations, and exact services changed.
