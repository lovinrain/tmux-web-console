# Muxpilot

Status: implementation and paired release validation are in progress on
`feat/muxpilot`. The runtime, project commands, coordinator skill, and UI
integration now have code and focused tests. The bounded real-provider qualification passes; final CI/source binding and the
complete release gate remain required before deployment.

Muxpilot lets a person give a main coding agent a project-level goal in natural
language. The main agent organizes the work in Multica, delegates substantial
tasks to visible tmux workers in Muxdeck, coordinates integration and verification,
and keeps a private local history that supports audit and recovery.

> Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR
> when it is tested.

The installed `muxpilot` skill's name and description let Codex recognize
“Use Muxpilot” and load its full coordinator workflow. Use `/skills` to check
that it is available, or explicitly mention `$muxpilot` with your repository
and goal. If it is missing after installation, start a fresh Codex session.
See [the user guide](USER_GUIDE.md) and
[official Codex skill discovery documentation](https://developers.openai.com/codex/skills/).

The user chooses **Multica's existing board and UI**. A new board inside Muxdeck
is outside this plan. The user supplies a repository and goal, not a required
brief file, project CLI invocation, or manually maintained agent roster.

Candidate evidence: the actual three-worker paired fake-provider scenario, native API/daemon fault drill, native privacy checks, Multica CI and isolated restore/rollback rehearsals pass within their recorded scope. The bounded natural-main real Codex qualification now passes (E21), including three completed workers, verified goal closure and the requested private draft PR. Final source CI, release binding and live deployment remain pending. See [EVIDENCE.md](EVIDENCE.md).

## Read the plan

| Document | Purpose |
| --- | --- |
| [USER_GUIDE.md](USER_GUIDE.md) | Three-step human workflow and ordinary-language examples |
| [OPERATIONS.md](OPERATIONS.md) | One-time installation, service lifecycle, diagnostics, audit and recovery |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Implementation ownership and validation evidence |
| [SPEC.md](SPEC.md) | User journeys, scope, requirements, task/run semantics, and end deliverables |
| [DECISIONS.md](DECISIONS.md) | Architecture decisions, local storage, APIs, authorization, and failure boundaries |
| [TASKS.md](TASKS.md) | Dependency-ordered implementation tasks with acceptance and validation evidence |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Planning, first-demo, and full-v1 definitions of done and fault scenarios |
| [DELIVERY.md](DELIVERY.md) | Feature branches, GPT-6.1-sol team workflow, cross-repository release and final merge policy |

Task status is maintained in TASKS.md. A design decision is a selected direction,
not evidence that its implementation works. An implementation task becomes done
only with the linked evidence required by ACCEPTANCE.md.

## Working branch and scope of this change

- Muxdeck integration branch: **feat/muxpilot**.
- Feature worktree: **/root/tmux-web-console-worktrees/muxpilot**.
- Muxdeck default branch: **master**, the branch meant by "main" in the user's
  delivery request. There is no planned default-branch rename.
- Planning base: **96769f6d7603df8a237ebca220883bed39a82d1d**.
- Multica inspected base: **e31da86c90794b5c488279a3ead13ac2f31ac269**, branch main.
- Implementation and paired validation use isolated feature worktrees; defaults
  and the existing installation change only after the complete acceptance gate.
- Team agents use **gpt-6.1-sol**, as requested by the user.
  This development-team choice does not impose a model on Muxpilot end users.

The paired Multica implementation uses the writable fork `lovinrain/multica`,
preserving `multica-ai/multica` as upstream. Upstream merge authority is not
assumed.

## Milestones and bounded gates

1. Publish this consistent, reviewed specification and task plan.
2. Prove a specific installed provider pairing and its launch, messaging,
   cancellation, and recovery contracts in an isolated environment.
3. Demonstrate one natural-language epic with a main coordinator, three visible
   workers, steering, terminal links, and recovery from loss of the main agent.
4. Complete durable audit ingestion, project integration/closure, backup/restore,
   and the full fault and authorization acceptance matrix.
5. Validate a pinned Muxdeck/Multica release pair, merge the finished feature to
   the authorized defaults, and deploy using the existing safety runbooks.

The exact first provider/executable/version combination and the writable Multica
remote are implementation prerequisites assigned to tasks, not promises hidden
inside the plan. A failed capability proof changes the supported capability
matrix or design before dependent work proceeds; it cannot be called a pass.

## Preserved user requirements

- Explicit invocation by name: "Use Muxpilot..."; short follow-up messages then
  operate within the bound project.
- The main agent analyzes, decomposes, hands off, coordinates, integrates, and
  checks the whole project's completion criteria.
- Substantial implementation, investigation, and review are individually visible
  tasks and root worker executions. Only bounded helpers may remain internal.
- The main agent operates Multica; the human may inspect its board or terminals
  and intervene without taking over routine project administration.
- Local audit and recovery are service-managed, rather than dependent on a
  model remembering to write a log.
- Development happens on isolated feature/task branches. The finished feature
  reaches the default branches together with a tested compatibility record.

## Related existing documentation

- [Agent orchestration and the Multica bridge](../AGENT_ORCHESTRATION.md)
- [HTTP and WebSocket API](../API.md)
- [Agent transcripts](../AGENT_TRANSCRIPTS.md)
- [Task timing evidence](../TASK_TIMELINES.md)
- [Deployment runbook](../../AGENT_DEPLOYMENT_GUIDE.md)

The planned [durable delivery report](/root/.local/state/muxdeck/deployments/20261001T015644Z-muxpilot/DELIVERY.md) retains the final source/artifact pair, acceptance evidence and operational gate results. G1, G3 and G4 close there only when their checks actually pass; this candidate document does not claim an installation.
