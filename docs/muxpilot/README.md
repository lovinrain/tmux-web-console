# Muxpilot implementation proposal

Status: planning baseline, 2026-09-30. The Muxpilot runtime, project commands,
coordinator tools, and UI additions described here are proposed, not installed
features. Existing Muxdeck orchestration and Multica functionality are identified
separately in [the specification](SPEC.md#existing-foundation).

Muxpilot lets a person give a main coding agent a project-level goal in natural
language. The main agent organizes the work in Multica, delegates substantial
tasks to visible tmux workers in Muxdeck, coordinates integration and verification,
and keeps a private local history that supports audit and recovery.

> Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR
> when it is tested.

The user chooses **Multica's existing board and UI**. A new board inside Muxdeck
is outside this plan. The user supplies a repository and goal, not a required
brief file, project CLI invocation, or manually maintained agent roster.

## Read the plan

| Document | Purpose |
| --- | --- |
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
- Planning worktree: **/root/tmux-web-console-worktrees/muxpilot**.
- Muxdeck default branch: **master**, the branch meant by "main" in the user's
  delivery request. There is no planned default-branch rename.
- Planning base: **96769f6d7603df8a237ebca220883bed39a82d1d**.
- Multica inspected base: **e31da86c90794b5c488279a3ead13ac2f31ac269**, branch main.
- This change publishes planning documents on the feature branch. It neither
  merges the feature nor changes the running installation.
- Subsequent implementation uses an agent team and task worktrees based on the
  feature branch. Team agents use **gpt-6.1-sol**, as requested by the user.
  This development-team choice does not impose a model on Muxpilot end users.

Multica currently points to the upstream multica-ai/multica repository. The
paired implementation task must establish an authorized writable fork/remote;
upstream write access and permission to merge upstream main are not assumed.

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
