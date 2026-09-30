# Muxpilot product and behavior specification

Status: proposed v1 implementation contract. Read [the decisions](DECISIONS.md),
[task plan](TASKS.md), and [acceptance matrix](ACCEPTANCE.md) together with this
file. Examples of Muxpilot tools and commands are proposed interfaces.

## Product boundary

Muxpilot is a local integration package plus installed coordinator instructions.
Multica supplies the existing task UI, task/run records, and worker dispatch.
Muxdeck supplies tmux launch/control, workspaces, terminal viewing, and native
history. A new local service supplies project-scoped tools, durable operation
receipts, event delivery, session associations, and audit/recovery state.

The main agent is an ordinary coding-agent conversation that uses these tools.
It remains visible in its own tmux session and owns the project's reasoning and
coordination. The service provides deterministic bookkeeping and enforcement;
it does not introduce a competing task scheduler or a second agent planner.

### V1 scope

- One configured local host/runtime and Unix account with a pinned, tested
  Muxdeck/Multica/provider compatibility record. Multiple projects are supported;
  each has at most one active coordinator owner and a configured worker limit.
- An existing Multica UI with task/run-to-terminal links and control receipts.
- An interactive main agent. Multica-managed workers use the structured stdio
  bridge, with visible tmux output and instructions through the controller.
- Natural-language project start, status, direction changes, stop, resume, audit,
  and completion; diagnostic CLI commands are optional operator tooling.
- Worktree isolation, result handoff, explicit integration, and goal-level
  verification; delivery follows the project's requested endpoint such as a PR.
- Local durable event history, artifacts, checkpoints, export, backup, and
  recovery with clearly distinguished coordinator/runtime/service faults.

### Deferred capabilities

Native interactive worker TUI takeover, arbitrary provider parity, remote-host
stdio tunneling, embedded terminals inside Multica, a replacement board,
distributed coordinator leadership, and third-party hosted service operation
are outside v1. The existing bridge's observation pane does not forward browser
typing to provider stdin. V1 must not present a working takeover button for it.

## User experience

### One-time setup

The operator installs the integration and coordinator instruction/tool package,
connects the existing Multica and Muxdeck installations, registers a runtime and
provider profiles, and configures authentication, execution limits, and delivery
policy. Setup returns supported provider capabilities and checks private local
state access. Provider authentication is established through its supported flow;
credentials are not pasted into task descriptions or journal events.

An already-running main agent can use Muxpilot after its installed tools and
instructions are loaded through that provider's supported mechanism. The name
alone has no effect in an unconfigured agent. A supported new-session launcher
loads the same package automatically. No claim is made that an arbitrary running
agent can acquire new tools without the provider's required reload/restart.

### Start a project with natural language

> Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR
> when it is tested.

The main agent invokes project startup with the resolved repository path and
the user's verbatim goal. The service resolves an existing registered project
or creates a new project identity, checks/reuses configured services, records
the initial input, and binds the main conversation and tmux incarnation. If the
main conversation has no usable tmux session, the supported launcher creates a
visible main session with an explicit handoff; it does not silently run two leads.

The user receives the actual Multica project and Muxdeck workspace links. The
main agent reads the repository instructions and relevant code, records a plan
and completion criteria, creates an epic and tasks in Multica, and begins work
within the configured policy. Clarification is reserved for a materially missing
goal/constraint or authority, not routine delegation and board administration.

"Use Muxpilot for this repository..." uses the main session's resolved project
directory. An unknown repository or ambiguous project alias requires a concise
clarification. Repeated setup for the same bound project reconciles existing
records rather than duplicating its board or workers. A goal amendment is a
versioned input and plan revision, not a silent replacement of the original ask.

### Follow-up messages

| User message | Observable result |
| --- | --- |
| "Where are we?" | Completion criteria, task states, live attempts, blockers, and last confirmed activity |
| "Tell the API agent to reuse our email service." | Instruction tied to a specific run, with queued/delivered/acknowledged status |
| "Stop the frontend task and prioritize API tests." | Targeted cancellation/interrupt result and revised eligible work; other runs retained |
| "Stop starting tasks; let current work finish." | Dispatch held for this project while active runs continue |
| "Show me the authentication agent." | Exact run/session link, task context, and captured output/history |
| "Resume the shop password-reset project." | Ownership/reconciliation report followed by attachment or a replacement main conversation |
| "Show each agent's contribution." | Decisions, messages, changed artifacts, branches/commits, and verification evidence |

Generic "pause" must be translated into the stated scope: holding new dispatch,
interrupting a current turn where supported, or cancelling a run. It is not a
promise to freeze arbitrary operating-system processes or undo file changes.

While work remains, the main uses a bounded, interruptible await-events tool to
receive durable worker/human events and continue its decision loop. The cursor
is acknowledged after recording the resulting decision. A provider-specific
wakeup alternative requires capability evidence. Returning to an idle TUI is
not permission to inject raw keystrokes: retain pending events and expose the
coordinator's idle/resume state until a supported continuation is established.

### Worked example and final delivery

The shop goal becomes a parent epic with staged tasks for reset-token API, UI,
and integration/regression checks. V1 uses ordered Multica stage batches, not an
unimplemented general dependency scheduler. Future-stage tasks stay in the fixed
Backlog status; ownership-only writes carry no-start intent. The main explicitly
activates an eligible batch after verifying prerequisites. A cancelled task is
not an accepted prerequisite unless a recorded scope decision removes it.
Implementation workers get separate worktrees;
the test task receives the exact integration revision containing accepted API
and UI work. Backend admission checks prevent assignment, comment/mention,
wakeup, or rerun triggers from bypassing a parked stage or dispatch hold, except
for an explicit authorized and audited human override. Native parent wakeups
are routed into the external main's inbox or disabled for that project, avoiding
a second hidden leader. The main agent manages coordination and owns the
integration task itself or assigns an explicit integration owner.

The human can see the main coordinator and an epic group with active workers in
the project workspace. A task card opens the corresponding run's live terminal
or retained history if the run has ended. After evidence meets the goal and the
requested delivery endpoint, the final report names the delivered revision/PR,
checks and their outcomes, remaining limitations, and local audit export.

## Domain and lifecycle contracts

| Entity | Meaning and identity |
| --- | --- |
| Project | Stable local UUID associated with a Multica project, repository resources, policy, and Muxdeck workspace |
| Epic | Multica parent issue for v1; a Muxdeck group or dedicated workspace is a navigation projection |
| Task | Durable issue containing goal, owner, dependencies/stage, acceptance criteria, and result references |
| Agent profile | Reusable provider/model/instructions configuration; not a particular process |
| Run | One execution attempt with its own ID, runtime/provider conversation, workspace, artifacts, and state |
| Provider execution | One provider process invocation within a run; its daemon-assigned UUID distinguishes legitimate reinvocations from a retry of the same launch |
| Session binding | Full tmux/server/pane identity plus Muxdeck history reference, not merely a name |
| Coordinator generation | Monotonic ownership epoch checked for every mutating command, including deferred delivery |
| Instruction | Versioned message with stable ID, recipient attempt, delivery/acknowledgement, and failure state |

Task progress, run/process state, and attention requests are independent. A
completed process does not prove task acceptance; accepted tasks do not alone
prove integrated project completion. Cancelled work is excluded from success
claims unless its removal is an explicit logged scope decision.

Visual parent links are workspace-local. Muxdeck groups are contiguous/disjoint,
and nested children inherit their parent's group. Keep the overall coordinator
at project level and workers in epic groups; do not promise cross-group nesting.
Discover limits through capabilities and use another explicit workspace when a
project exceeds group/tab limits. Closing a tab or archiving a board record is
not implicit process termination.

## Functional requirements

| ID | Required behavior | Acceptance responsibility |
| --- | --- | --- |
| F01 | Explicit "Use Muxpilot" invocation loads the configured workflow; repository path or known cwd and an ordinary-language goal suffice. Follow-ups retain the project binding. | Activation and natural-language scenarios |
| F02 | Bootstrap or reuse configured services; bind source/worktree, goal revisions, project IDs, main conversation, policy, and tools without exposing credentials. Preserve existing work. | Startup/context and baseline scenarios |
| F03 | Main analyzes/decomposes the goal and creates individually owned staged tasks before launching meaningful delegated work. Backlog/no-start and backend trigger gates preserve verified stage eligibility, holds, and concurrency. | Delegation and scheduling scenarios |
| F04 | Each active provider execution has a visible, correctly grouped tmux session and durable run/execution/session/worktree linkage; reinvocations differ from launch retries and uncertain/partial launches reconcile without blind relaunch. | Launch/placement and stale-identity scenarios |
| F05 | Inspect, queued follow-up, live supplement, interrupt, cancel, and continue have distinct capability-aware contracts and receipts. Delivery is distinct from acknowledgement and compliance. | Control and authorization scenarios |
| F06 | Human board changes and instructions are attributed, delivered, and visible to the coordinator. Human control suspends conflicting automation at supported input surfaces. | Human-intervention and concurrent-input scenarios |
| F07 | Meaningful progress, blockers, decisions, artifacts, and integration evidence support goal-level completion; unsupported or failed verification remains explicit. | Result and project-closure scenarios |
| F08 | Private local journal and hashed artifact records survive main-agent loss; derived audit exports include bounded coverage and missing-evidence declarations. Human/worker backend events are replayable. | Journal, feed, artifact, and export scenarios |
| F09 | Resume fences old coordinator generations, adopts valid live attempts, reconciles uncertain operations, and reconstructs the main context without duplicate delegation. | Crash/recovery and ownership scenarios |
| F10 | Preserve Multica UI and add exact task/run terminal links, run history, and control feedback; stale/dead links never silently target a replacement with the same name. | Browser/task-link scenarios |
| F11 | Coordinator identity is project/workspace scoped, attributable, revocable, and renewable; workers lack broad control credentials. Human-only steering is extended with deliberate policy. | Positive and negative permission scenarios |
| F12 | Startup/status/export/backup/restore/shutdown have documented lifetimes; routine viewing, main exit, archive, and service operations preserve unrelated sessions. | Lifecycle and release scenarios |

Bounded internal helpers have a fixed input/output contract and restricted scope
(for example parsing a supplied report). Open-ended investigation, implementation,
or review becomes a visible task. Supported-provider tests must establish how
helper use is disabled, limited, or recorded; instructions alone cannot be called
a sandbox. Audits distinguish observed helper records from unavailable provider
detail, and task completion cannot conceal substantial untracked delegation.

## Nonfunctional requirements

| ID | Contract |
| --- | --- |
| N01 | Durable command intent precedes side effects; receipts, checkpoints, and input revisions are transactional. Retries preserve IDs and uncertain actions are reconciled. No exactly-once claim across independent services. |
| N02 | State directories are private (0700) and files 0600; auth headers/tokens/environment secrets are excluded from journal/export. Application scopes limit normal operations; shared Unix identity is not hostile-process isolation. |
| N03 | Existing tmux server/session identities, live Muxdeck state, unrelated Git changes, and protected access survive development and deployment. Tests target isolated sockets/resources. |
| N04 | Capabilities and provider/version support are explicit and verified. Default tests are synthetic; real provider smoke tests require explicit authorization. Tests cover distinct behavior at the cheapest appropriate layer. |

## Local state and audit contract

The default state root is XDG_STATE_HOME/muxdeck/projects, falling back to
~/.local/state/muxdeck/projects. One project directory is keyed by UUID, not its
editable display name:

~~~text
<project-id>/
  journal.sqlite3
  inputs/brief-0001.md
  runs/<run-id>/startup-context.md
  runs/<run-id>/transcript.jsonl
  runs/<run-id>/result.md
  runs/<run-id>/changes.patch
  runs/<run-id>/test-results.json
  exports/<export-id>/events.jsonl
  exports/<export-id>/status.md
  backups/<backup-id>/
~~~

The SQLite database is the sole authoritative local operation/audit store.
Events are append-only through the service; operation state, mappings, ingest
cursors, and checkpoints are transactionally maintained projections. A checkpoint
records the highest fully applied event sequence. Large artifacts are written
atomically and durably before their committed references, with hashes and byte
counts. Missing files and partial captures remain visible rather than invented.

An event includes schema version, local sequence, unique event ID, source event
ID when imported, UTC occurrence/observation times, actor/origin, project/epic/
task/run IDs, coordinator generation, operation/message correlation IDs, event
type, payload, and artifact references. The journal records decision summaries
and actual instructions/results; it does not require hidden model reasoning.

Multica remains authoritative for current tasks/runs and their history. Backend
events must be ingested through a durable cursor with deduplication; snapshots
are used for reconciliation, not reconstructed as missing transitions. For
backend mutations that lack replayable events, add the event/outbox in the same
transaction as the source mutation. Record gaps and pause dependent decisions
when authoritative history is unavailable. Unmanaged external shell activity is
outside the structured journal; captured provider transcripts have stated coverage.

Exports are generated at an explicit event watermark and include manifest hashes,
source revisions, coverage, and missing evidence. Backups use SQLite-aware backup
and immutable artifacts, not a bare copy of an active WAL database. A same-user
local store is not a tamper-proof compliance ledger. Retention is explicit; an
archive does not silently delete evidence or active-process ownership records.

## Recovery boundaries

- Main-agent loss: runtime-owned workers may continue. Reconcile before adopting
  them and issue a new fenced coordinator generation only when ownership permits.
  Muxdeck launch/input receivers as well as Multica receivers validate current
  authority at execution time; a local check before sending cannot fence a
  delayed request that arrives after a replacement has taken ownership.
- Integration-service loss: durable operations/inbox recover; the service is not
  the process holding workers' provider stdio open. No new mutation is accepted
  without available durable state and authorization.
- Multica daemon/provider loss: the bridge may cancel its provider. Persisted
  progress and worktrees support a documented retry, not a false continuity claim.
- tmux/host loss: record ended/unknown attempts and recover from retained evidence;
  do not assert that terminated processes survived or automatically restart tmux.
- Lost command receipt: correlate against actual external state before retrying;
  operations with no safe deduplication or proof remain outcome-unknown.

## Existing foundation

Inspected Muxdeck commit: 96769f6d7603df8a237ebca220883bed39a82d1d.
Inspected Multica commit: e31da86c90794b5c488279a3ead13ac2f31ac269.

| Existing evidence | Consequence for the implementation |
| --- | --- |
| [Muxdeck orchestration](../AGENT_ORCHESTRATION.md) and [control CLI](../../tmux_console/control_cli.py) | Reuse launch/control/group APIs and identity fences; add project semantics rather than another terminal engine. |
| [Multica wrapper and validation limits](../AGENT_ORCHESTRATION.md#a-multica-custom-runtime-wrapper) | Transport shape exists; authenticated provider proof is still a task, not established production evidence. |
| [Multica concepts](https://github.com/multica-ai/multica/blob/e31da86c90794b5c488279a3ead13ac2f31ac269/apps/docs/content/docs/concepts.mdx) | Separate reusable agent profiles from individual runs; project and parent issues already fit the board model. |
| [Multica steering routes](https://github.com/multica-ai/multica/blob/e31da86c90794b5c488279a3ead13ac2f31ac269/server/cmd/server/router.go#L2047) | Live supplements require a human actor today; implement scoped coordinator authority rather than impersonation. |
| [Task credential lifetime](https://github.com/multica-ai/multica/blob/e31da86c90794b5c488279a3ead13ac2f31ac269/apps/docs/content/docs/auth-tokens.mdx) | Existing run-scoped credentials cannot be reused as a persistent coordinator credential. |
| [Project resources/worktrees](https://github.com/multica-ai/multica/blob/e31da86c90794b5c488279a3ead13ac2f31ac269/apps/docs/content/docs/project-resources.mdx) | Reuse runtime isolation and continuation; explicit integration still needs an owner and verified revision. |
| [Muxdeck transcript selection](../AGENT_TRANSCRIPTS.md) | Bind exact conversations; do not use the newest file in a directory or rely on hidden subagent history for visible task ownership. |

## End deliverables

The full release includes the tested integration package and paired Multica
changes; installed natural-language coordinator instructions/tools; visible
worker lifecycle and control; Multica terminal links; private audit/checkpoint
storage and export; restart recovery; dependency/result/integration handling;
focused tests plus an authorized real-provider demonstration; and operating,
upgrade, backup, rollback, and compatibility documentation.

The definitive release gate is [ACCEPTANCE.md](ACCEPTANCE.md). Code written,
workers launched, a green unit suite, or a planning document alone cannot meet it.
