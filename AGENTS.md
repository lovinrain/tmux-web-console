# Repository Agent Instructions

For any deployment, migration, service, reverse-proxy, archive, upgrade, or
rollback task, read `AGENT_DEPLOYMENT_GUIDE.md` completely before taking action.

The guide is a runbook, not standing authorization to mutate a machine. Follow
the user's requested scope and approval model. In particular, never restart
tmux, run an unscoped `tmux kill-server`, destroy live sessions, or expose this
unauthenticated console publicly without explicit human direction.

## Delivery preference

After completing and validating requested code changes, commit and push the
task's changes to the configured remote and deploy them to the existing
Muxdeck installation unless the user says otherwise. The user has explicitly
authorized routine pushes and deployments; do not ask for the same approval
again. Preserve unrelated work and follow the deployment safety checks above.

## Execution and progress

- Start a private task timeline with `scripts/task_timeline.py` before investigation
  or editing. Mark phase changes, wrap commands (including tests, staging, push,
  deployment and CI waits), and include the generated report at completion.
  Record GitHub job timestamps with its `github` command. See
  `docs/TASK_TIMELINES.md`; distinguish command runtime from time between commands.
- Before editing a dirty checkout, use a separate worktree for independent
  changes. When the task depends on existing uncommitted work, snapshot that
  baseline first and define which changes belong to the task before editing.
- State the current phase: implementation, validation, deployment, or reporting.
  During active work, send a meaningful update at least every 60 seconds,
  including during patch or report preparation. Say promptly when a check fails
  and requires a fix. Distinguish a command's runtime from total task time.
- Run independent checks together and collect completed results promptly. Keep
  waits short enough to give updates; do not leave a finished command looking
  like the current activity while silently preparing the next step.
- For routine deployment checks, reuse `scripts/check_deployment.py` and its
  generated report; see section 13 of `AGENT_DEPLOYMENT_GUIDE.md`. Retain
  task-specific tests, backups, and migration checks. Extend shared tooling when
  a recurring check is missing instead of writing a new temporary verifier.
- Build frontend releases in a staging directory. The live `dist/` is served
  immediately, so building in the running checkout deploys before validation.
  Documentation and tooling changes need no frontend build or service restart.

## Testing

- Start with the test files or cases that exercise the changed behavior. Use
  `npm run test:related -- src/path.ts` for frontend import dependents,
  `npm run test:changed` for Git changes, and explicit pytest files for Python.
  Import-based selection does not cover backend contracts or every runtime
  dependency; select those checks explicitly. Full frontend/Python suites remain
  in CI and are appropriate locally for broad changes or uncertain impact.
- Add coverage for a distinct behavior, regression, or failure mode. Prefer
  extending an existing test. Copy, spacing, or icon-only edits generally need
  inspection rather than new automated tests.
- Keep exhaustive mappings and input combinations in inexpensive unit tests.
  Use representative component/browser scenarios for wiring and interaction;
  an additional test layer should cover a distinct integration risk.
- Consolidate duplicate scenarios as the affected tests are touched. Identify
  the retained coverage before removing a case, especially for authentication,
  terminal input, persistence, concurrency, and time-zone boundaries.
- Run affected browser specs for browser behavior, then stop once appropriate
  checks pass. Repeat or broaden a run only for new changes, failures, or an
  unresolved concern. Evaluate runtime, reliability, and useful coverage rather
  than targeting a test count.
