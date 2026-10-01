# Muxpilot implementation tasks

Status: implementation candidate with validation and release gates pending. MXP-001 is the delivered planning baseline; implementation tasks are in progress, with evidence and remaining gaps in [EVIDENCE.md](EVIDENCE.md). Requirement IDs refer to [SPEC.md](SPEC.md); technical contracts belong to [DECISIONS.md](DECISIONS.md); global release criteria belong to [ACCEPTANCE.md](ACCEPTANCE.md). If filenames change during planning, update these references before publishing.

## Delivery boundaries and working rules

Muxdeck starts at `master` commit `96769f6`; Multica starts at `main` commit `e31da86`. Use aggregate `feat/muxpilot` branches in both writable repositories, with isolated per-task worktrees and task branches based on those feature branches. The currently known Multica remote is upstream `multica-ai/multica`; identifying an authorized writable fork/remote is a prerequisite to publishing its changes, not authorization to push upstream. Routine feature pushes are authorized. Do not merge to defaults or deploy the feature before the final v1 gate. Final release maps Muxdeck to `master` and Multica to `main` after checking their actual configured default branches.

The development team uses **GPT-6.1-sol**. Assign each task one owner and exact file ownership before parallel implementation; shared interfaces must land before their consumers. Keep commits small and independently reviewable. Split a task if its implementation spans unrelated review concerns. Preserve unrelated work, existing tmux sessions, and local applications. Follow root `AGENTS.md`, private timelines in [../TASK_TIMELINES.md](../TASK_TIMELINES.md), and [../../AGENT_DEPLOYMENT_GUIDE.md](../../AGENT_DEPLOYMENT_GUIDE.md) for eventual deployment. Planning publication needs no frontend build or restart.

Each implementation task must attach a feature-branch commit, targeted command/test results, and a compact evidence artifact to its task record. Runtime evidence belongs outside the repository under `~/.local/state/muxdeck/projects/<UUID>`; checked-in fixtures must be synthetic and sanitized. Evidence must identify exact tool/provider versions and tested configurations. A passing mock is not a live provider proof. Sizes S/M/L express relative scope, not elapsed-time promises.

A task is ready only when its dependencies are accepted, ownership is assigned, referenced contracts are versioned, fixtures are available, and any provider/auth dependency is actually supported by evidence. A task is locally done only when its acceptance criteria and focused checks pass, its evidence is attached, its interfaces/docs are updated, and its commit is integrated into the aggregate feature branch. Local completion does not imply the global v1 definition of done.

## Milestones and dependency DAG

| Milestone | Tasks | Exit condition |
| --- | --- | --- |
| M0: reviewable plan and contracts | 001–004 | Plan reconciled; interface decisions frozen; paired local fixtures available before the minimal exact provider transport pairing spike. |
| M1a: transport and recovery foundation | 005–015 | Natural-language goal creates an epic and independent workers, yields results, and survives one main interruption without duplicating workers. |
| M1b: first usable coordination demo | 016–020 plus 005–015 | Add live human steering/interruption, task-to-terminal links, integration and verified delivery to M1a. Use three visible substantial workers including dependency-bound verification. Complete audit/recovery acceptance remains a v1 gate. |
| M2: complete product behavior | 021–022 | Human control, durable audit, UI links, verified integration, and lifecycle operate together. |
| M3: release candidate | 023–026 | Fault drills, paired end-to-end checks, deploy/rollback rehearsal, and all global acceptance criteria pass. |

The dependency list below is identical to each task record. The likely critical path is contracts → provider proof → operation fencing → worker bridge → results → recovery → fault drills → paired end-to-end → release rehearsal → final gate. Reassess from measured outcomes rather than treating this as a schedule.

| Task | Required predecessors |
| --- | --- |
| MXP-001 | None |
| MXP-002 | 001 |
| MXP-003 | 002, 004 |
| MXP-004 | 002 |
| MXP-005 | 002, 004 |
| MXP-006 | 002, 004 |
| MXP-007 | 005, 006 |
| MXP-008 | 006, 007 |
| MXP-009 | 003, 005, 007, 008 |
| MXP-010 | 009 |
| MXP-011 | 010, 012, 013 |
| MXP-012 | 003, 004, 008 |
| MXP-013 | 003, 012 |
| MXP-014 | 013, 008 |
| MXP-015 | 008, 011, 014 |
| MXP-016 | 005, 007, 011 |
| MXP-017 | 013, 014, 016 |
| MXP-018 | 002, 005, 016 |
| MXP-019 | 011, 013, 018 |
| MXP-020 | 014, 016, 017 |
| MXP-021 | 006, 014, 017, 018, 020 |
| MXP-022 | 009, 012, 015, 021 |
| MXP-023 | 015, 017, 018, 021, 022 |
| MXP-024 | 019, 020, 021, 023 |
| MXP-025 | 024 |
| MXP-026 | 001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 021, 022, 023, 024, 025 |

Parallel lanes after contracts: **A** Multica scoped identity/human API/event feed (005,016,018); **B** local journal/daemon/recovery (006–008,015,021–023); **C** main activation/planning/integration (009–011,020); **D** worktrees/worker observation/results (012–014,017); **E** Multica terminal links (019); **F** verification/release (024–026). Parallelism is constrained by ownership and dependencies, not merely lane labels. Consumers use contract fixtures until implementations land; passing fixture tests cannot close live integration gates.

## Task records

### MXP-001 — Publish the planning baseline (S)
- **Status:** done; planning documents only, delivered by the feature commit containing this record. **Requirements:** F01–F12, N01–N04. **Dependencies:** none.
- **Acceptance scenarios:** Planning gate; traceability review for A01–A27.
- **Deliverable/owner:** Muxdeck `docs/muxpilot/`, divided among named document authors; reconciled specification, decisions, backlog, and acceptance matrix.
- **Acceptance:** documents agree on main-agent activation, Multica source of truth, local durability, v1 structured worker bridge, deferred native worker takeover, exact provider gate, and feature-only publication.
- **Focused validation:** inspect cross-links, requirement coverage, dependency acyclicity, and explicit demo versus v1 distinction.
- **Evidence:** six planning documents; GPT-6.1-sol architecture/task/acceptance authors and cross-review; 30 local links and pinned source paths validated; all 26 task records and 27 scenarios checked; the 89-edge task dependency graph is acyclic. The feature commit and remote branch identify the published document snapshot; implementation tasks remain planned.

### MXP-002 — Freeze cross-repository interfaces (M)
- **Status:** in_progress; versioned contracts and focused compatibility checks passed (E6/E12/E14); final pair acceptance pending ([ledger](EVIDENCE.md)). **Requirements:** F04–F09, F11, N01–N04. **Dependencies:** 001.
- **Acceptance scenarios:** A02, A08, A18–A20, A26.
- **Deliverable/owner:** Muxdeck `muxpilot/contracts` and paired Multica API/schema contract fixtures; exact file paths assigned before work.
- **Acceptance:** versioned project/epic/task/run/worker/session identities; distinguish Multica run ID from provider execution UUID and full terminal binding. One run may legitimately invoke multiple provider subprocesses; each execution has its own launch ID, retries preserve that ID, and discovery probes bypass worker launch; scoped coordinator identity; operation IDs and receipts; event cursor/inbox; worker assignment/result envelopes; human supplements; task-terminal link; terminal observation and cancellation contracts; v1 stage/batch eligibility, parked backlog, dispatch hold, and no-start ownership updates. Backend must enforce stage/hold eligibility against every launch trigger, including mentions, comments, wakeups and reruns. Define authoritative versus derived fields, stale-version conflicts, retry/idempotency semantics, redaction, and error behavior. Existing `mat` run token is not assumed to authorize project coordination.
- **Focused validation:** inexpensive schema/contract tests for representative valid payloads, two legitimate provider executions within one run versus duplicate retry of one execution, forbidden scope, stale cursors, duplicates, incompatible versions, and secret redaction.
- **Evidence:** contract version manifest, compatibility table, test results; both repository consumers review before parallel writers start.

### MXP-003 — Prove one provider transport/capability pairing (M)
- **Status:** in_progress; fake capability/negative checks passed; bounded real provider qualification passed (E21); final source CI/release binding pending ([ledger](EVIDENCE.md)). **Requirements:** F01, F03, F11, N04. **Dependencies:** 002,004.
- **Acceptance scenarios:** A02 and transport/lifetime prerequisites of A07, A16, A17, A22; full product scenarios close in their later implementation tasks.
- **Deliverable/owner:** Muxdeck disposable fixture driver/probe using the existing provider wrapper; documented exact main/worker provider/model/CLI/auth pairing and sanitized protocol fixture.
- **Acceptance:** obtain explicit user authorization for the real-agent smoke before invoking a paid/live provider; default checks use synthetic fixtures. With MXP-004 disposable services/resources, prove existing wrapper transport, byte-preserving protocol, output mirror, exit/error reporting, supported messaging/cancel and disconnect behavior. Probe the selected main provider’s interruptible bounded await-tool/event-wake behavior; prove what happens after an active main turn returns idle without claiming arbitrary idle TUI injection. Prove minimal main tool registration with a fixture-only tool, not complete Muxpilot activation/worktrees. Existing authorized human supplement may be probed in the fixture; this does not certify coordinator steering/scope, implemented and accepted in 005/016. This spike requires neither 010 activation nor 012 worktree integration. Unsupported combinations remain unavailable; a currently unvalidated wrapper remains unvalidated until actual evidence succeeds.
- **Focused validation:** disposable live transport happy path, existing authorized control capability, main process loss and daemon disconnect; missing/expired-auth failures and protocol/secret-removal unit checks. Record the precise capability exercised rather than claiming future product scenarios passed.
- **Evidence:** sanitized live protocol/transcript/receipts, tool-registration probe and exact versions; blocks downstream provider-dependent task completion only for capabilities actually demonstrated.

### MXP-004 — Establish paired development fixtures (S)
- **Status:** in_progress; paired isolated API/database/daemon fixtures proven (E7/E14); final release pins pending ([ledger](EVIDENCE.md)). **Requirements:** N02–N04, F12. **Dependencies:** 002.
- **Acceptance scenarios:** A02, A24, A27.
- **Deliverable/owner:** both repositories' feature branches/worktrees and synthetic local project fixture tooling.
- **Acceptance:** authorized writable Multica remote identified; pinned paired commits; isolated Multica/backend/daemon and Muxdeck fixture endpoints/ports; tools detect already configured applications and never alter unrelated services/sessions. Fixture teardown removes only owned resources.
- **Focused validation:** fresh and reused fixtures, occupied-port/conflicting-config refusal, unrelated session preservation.
- **Evidence:** pairing manifest, resource ownership inventory, fixture commands and outcomes.

### MXP-005 — Add scoped Multica coordinator identity (M)
- **Status:** in_progress; role/project scope and native coordinator contracts passed; final real runtime authorization trace pending ([ledger](EVIDENCE.md)). **Requirements:** F04, F05, F11, N02. **Dependencies:** 002,004.
- **Acceptance scenarios:** A08, A18, A26.
- **Deliverable/owner:** Multica backend auth and coordinator API, separately owned from event-feed and frontend files.
- **Acceptance:** a project/epic scoped coordinator can operate assigned tasks/runs without borrowing unrestricted user credentials or a worker's `mat` run token. Worker credentials cannot coordinate siblings; wrong project, revoked/expired credentials, and forbidden actions fail closed; renewal/revocation semantics are explicit.
- **Focused validation:** backend auth matrix unit/integration tests covering scope, expiry, worker/coordinator separation, and revocation during an operation.
- **Evidence:** sanitized authorization matrix and paired API version.

### MXP-006 — Implement transactional local journal and checkpoints (M)
- **Status:** in_progress; 117 core/fault checks and cross-process lock/integrity regression passed (E6); final-source gate pending ([ledger](EVIDENCE.md)). **Requirements:** F08, F09, N01, N02. **Dependencies:** 002,004.
- **Acceptance scenarios:** A13–A15, A23.
- **Deliverable/owner:** Muxdeck new Python `muxpilot` storage/schema/migrations module.
- **Acceptance:** per-project UUID directory outside repo; SQLite transactional events, operation IDs, receipts, checkpoint versions, worker/session/worktree associations, and durable cursor. Multica remains authoritative for task/run truth; journal contains coordination intent, observations, and recoverable local state. SQLite WAL with synchronous=FULL, directories 0700/files 0600, stable repo association, migration and corruption/error behavior are defined. Events include schema/local/source IDs, actor, occurrence/observation timestamps, correlation, coordinator generation, and coverage. Durability claims remain bounded by tested storage/process behavior.
- **Focused validation:** transaction rollback, atomic checkpoint/event commit, duplicate IDs, concurrent writers, reopen after killed writer, invalid schema/corruption handling.
- **Evidence:** synthetic DB fixtures, schema version, targeted Python results.

### MXP-007 — Implement project daemon and durable wakeup inbox (M)
- **Status:** in_progress; service transport/fingerprint checks and actual paired feed/recovery passed (E12/E14); natural-main activation passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F02, F06, F07, F09, F12, N01. **Dependencies:** 005,006.
- **Acceptance scenarios:** A09, A16, A17, A19.
- **Deliverable/owner:** Muxdeck `muxdeck-projectd` entry point, local IPC and inbox modules.
- **Acceptance:** one daemon ownership lease per project; authenticated/local-only IPC; durable inbox and acknowledged cursor; external-main inbox events reach the running ordinary main through an interruptible bounded await tool, with cursor acknowledged only after its decision is durably recorded. Use supported native parent wakeups for that conversation where qualified; do not create a second hidden squad leader. Worker/backend/human events remain available for resume. Retry and ordering semantics survive daemon/main restart; an idle main receives only qualified provider wakeups or explicit resume; never silently inject raw keystrokes. Bounded await duration keeps human steering responsive, and lack of a supported idle wake is an explicit capability boundary. Health/status expose actionable failure.
- **Focused validation:** enqueue/decision-commit/ack/replay, bounded interruptible await and human interruption, main returning idle without key injection, supported native parent wakeup, duplicate notification, daemon restart, unavailable subscriber, lease contention, unauthorized local IPC.
- **Evidence:** process-level inbox/restart test report.

### MXP-008 — Implement fenced operations and reconciliation outbox (M)
- **Status:** in_progress; durable receipt/fence replay and actual main takeover passed (E6/E14); full fault acceptance pending ([ledger](EVIDENCE.md)). **Requirements:** F03, F05, F09, N01, N03. **Dependencies:** 006,007.
- **Acceptance scenarios:** A18, A20; operation fault matrix.
- **Deliverable/owner:** Muxdeck operation/reconciliation modules and narrow paired Multica idempotency handling if contract requires it.
- **Acceptance:** durable intent precedes external side effects; stable operation IDs, ownership generation/fencing, unique receipts, and reconcile queries make task creation and worker launch safe across uncertain replies. Stale mains cannot issue actions; timeout means unknown pending state until reconciled, not a new launch. Explicit failure states retain evidence.
- **Focused validation:** fault injection before/after external success and before receipt commit; duplicate retries; two main owners; lost response; stale fence rejection.
- **Evidence:** operation state transition table and no-duplicate test traces.

### MXP-009 — Implement bootstrap and diagnostic tools (M)
- **Status:** in_progress; bootstrap/auth/no-effect contracts and installed wrapper checks passed (E9/E12); bounded real setup qualification passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F02, F11, F12, N02, N03. **Dependencies:** 003,005,007,008.
- **Acceptance scenarios:** A02, A03, A24, A26.
- **Deliverable/owner:** Muxdeck Python start/resume/status/audit diagnostic CLI and agent-facing tool entry points.
- **Acceptance:** discover/reuse configured local Multica and Muxdeck; inspect repository/branch/dirty state and project association; create durable project identity once, including XDG_STATE_HOME override and UUID-scoped private state. Tools report missing configuration/auth precisely, with safe resumable setup. CLI is diagnostic plumbing behind agent tools, not required user ceremony or a public network service.
- **Focused validation:** fresh/reused project, symlink/canonical path identity, unavailable application/auth, dirty checkout, incompatible pairing, repeated bootstrap.
- **Evidence:** sanitized tool outputs and bootstrap integration results.

### MXP-010 — Install natural-language main-agent activation (M)
- **Status:** in_progress; installer/skill tests and isolated upgrade/rollback passed (E9); natural-main proof passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F01, F02, F06, N04. **Dependencies:** 009.
- **Acceptance scenarios:** A01, A03.
- **Deliverable/owner:** Muxdeck installed agent instruction/tool package and provider adapter configuration.
- **Acceptance:** an ordinary visible interactive agent handles “Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR when tested.” by invoking tools, collecting repository context, and carrying the requested goal forward. No mandatory CLI/form/brief per project. The package must be installed/loaded through the tested provider mechanism; unsupported hot tool reload is not assumed. Bind one main conversation and full tmux identity; if a launcher handoff is needed it must not silently create two leads. Keep main TUI interactive and human-accessible; ambiguity that materially changes scope gets focused clarification without losing the original goal.
- **Focused validation:** live supported-provider invocation on synthetic repo; second invocation resumes correct project; unrelated natural-language work does not accidentally activate Muxpilot.
- **Evidence:** sanitized main-session transcript and activation/tool receipts.

### MXP-011 — Create epics and verified stage-batch plans (M)
- **Status:** in_progress; three-stage fake delegation, parked verification and exact integrated baseline passed (E14); natural-main real planning passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F03, F04, F07. **Dependencies:** 010,012,013.
- **Acceptance scenarios:** A04, A10, A11.
- **Deliverable/owner:** Muxdeck planning/dispatch tools and agent instructions, consuming frozen Multica contracts.
- **Acceptance:** goal/context produce an epic and bounded stage-batch task plan with prerequisite acceptance checks, ownership, and delegation of substantial independent work. This is v1 stage gating, not an arbitrary runtime task DAG. Future-stage tasks stay in fixed parked backlog; ownership-only mutations cannot start them. Main activates the next batch only after verified acceptance of prerequisites; canceled members are not success unless an explicit logged scope removal changes the plan. Backend eligibility enforcement rejects bypass launches from mentions/comments/wakeups/reruns during parked stages or project dispatch hold. Tasks within the current accepted stage may run independently under authoritative Multica eligibility/concurrency. Terminal/session/project/epic/task/run IDs are linked. Main revises the plan and reconciles existing work rather than re-creating it. Open-ended investigation/implementation/review uses visible root runs; bounded helpers require fixed input/output, restricted scope and recorded or explicitly unavailable provider evidence. Prove provider helper controls rather than treating instructions as a sandbox.
- **Focused validation:** independent workers within a stage, verified next-stage activation, partial-existing epic, stage barrier with canceled/failed prerequisites, fixed-backlog ownership-only updates, project dispatch hold and bypass triggers asserting zero premature run, dispatch retry.
- **Evidence:** Multica records and correlated launch receipts from live demo fixture.

### MXP-012 — Create owned worktrees and worker metadata (M)
- **Status:** in_progress; owned worktrees/metadata/three execution associations passed (E14); three-worker real inventory recorded (E21); final delivery inventory pending ([ledger](EVIDENCE.md)). **Requirements:** F03, F04, F12, N02, N03. **Dependencies:** 003,004,008.
- **Acceptance scenarios:** A05, A06, A12, A24.
- **Deliverable/owner:** Muxdeck worker workspace/resource allocator modules.
- **Acceptance:** task branches/worktrees derive from chosen project baseline; dirty baseline is preserved/snapshotted where required; project/epic grouping and task/run metadata attach to independently owned tmux workers. The Multica daemon assigns provider execution UUID/launch ID before the wrapper invokes a worker; map run → execution → full session identity, accepting multiple legitimate executions per run. Branch/session name collisions reconcile or refuse safely. Record full tmux/server/pane identity and history reference; keep main at project level and workers in disjoint epic groups, using another explicit workspace when capability limits require it. Cleanup is ownership scoped and never kills tmux server or unrelated sessions.
- **Focused validation:** concurrent workers, dirty repo, existing branch/worktree/session collisions, repeated allocation and orphan inspection.
- **Evidence:** resource inventory with preservation assertions.

### MXP-013 — Wire structured terminal execution and observation (M)
- **Status:** in_progress; structured fake worker protocol, independent lifetime and pane privacy passed (E8/E14); bounded real provider proof passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F03–F05, F07, N04. **Dependencies:** 003,012.
- **Acceptance scenarios:** A02, A05, A17, A21, A22.
- **Deliverable/owner:** Muxdeck provider worker wrapper and existing `muxdeckctl exec` observation bridge adapters.
- **Acceptance:** real paired worker runs in independent terminal, structured command/observation envelopes carry identity/operation receipts, output and completion reach coordinator, and main can inspect bounded context. Each actual provider execution uses its daemon-assigned execution/launch ID; retry of that execution reconciles the same launch rather than launching again. Discovery probes bypass terminal allocation; legitimate distinct subprocess invocations within one run receive distinct identities. v1 uses implemented structured bridge; native direct worker-TUI takeover remains deferred. Terminal disconnect is distinguishable from worker completion; command errors and output truncation are visible.
- **Focused validation:** live wrapper success/failure, two legitimate subprocess invocations in one run versus duplicate execution launch retry, discovery probe bypass, interrupted connection, malformed envelopes, long output, exit observation, representative terminal bridge integration.
- **Evidence:** versioned real-provider run plus synthetic edge-case tests; reference existing [../AGENT_ORCHESTRATION.md](../AGENT_ORCHESTRATION.md), [../AGENT_TRANSCRIPTS.md](../AGENT_TRANSCRIPTS.md), and [../API.md](../API.md).

### MXP-014 — Record worker result and artifact handoff (M)
- **Status:** in_progress; actual Git handoff, acceptance and artifacts passed (E5/E14); accepted real result/verifier proof passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F04, F07, F08, N01. **Dependencies:** 013,008.
- **Acceptance scenarios:** A10, A11, A15.
- **Deliverable/owner:** Muxdeck result receipt/artifact validator modules and paired Multica result endpoint adapter.
- **Acceptance:** completed worker supplies commit/branch identity, artifact pointers, validation commands/outcomes, blockers, and explicit result status; coordinator validates association and stores receipt durably. Artifacts carry hash, byte count and base SHA; write/fsync/rename/fsync parent before committing their references. Missing/corrupt artifacts and orphan files have explicit incomplete-evidence/cleanup policy. Repeated or late results are deduplicated, stale run results do not replace current results, and absent evidence prevents a successful-task claim.
- **Focused validation:** duplicate/late/stale/partial result, missing commit, invalid path or oversized artifact, disconnect after accepted result.
- **Evidence:** correlated run/result/artifact records and focused tests.

### MXP-015 — Recover main interruption for the foundation demo (M)
- **Status:** in_progress; main SIGKILL and verified replacement adopt existing workers without duplicate execution (E14); bounded real goal outcome passed (E21); final source binding pending ([ledger](EVIDENCE.md)). **Requirements:** F03, F09, N01, N03. **Dependencies:** 008,011,014.
- **Acceptance scenarios:** A16, A18, A20; M1a foundation gate.
- **Deliverable/owner:** Muxdeck resume/reconcile workflow and M1a scripted scenario.
- **Acceptance:** terminate/restart main during an in-flight worker; resume finds existing tasks, terminal ownership, and receipts, retains goal/context, and processes completion without duplicate workers or lost task associations. Demonstrate natural-language activation, parallel independent work, dependency release, and a main interruption. Report remaining v1 gates explicitly.
- **Focused validation:** deterministic fault at uncertain launch receipt and live main interruption at known worker execution point.
- **Evidence:** foundation demo report with before/after identity inventory; first usable coordination demo also requires 016–020 and does not close full recovery or audit requirements.

### MXP-016 — Add live human supplements and event delivery (M)
- **Status:** in_progress; actual human timeline supplement delivered and attributed in paired fake (E14); real interaction pending ([ledger](EVIDENCE.md)). **Requirements:** F06, F08, N01, N02. **Dependencies:** 005,007,011.
- **Acceptance scenarios:** A07–A09, A19.
- **Deliverable/owner:** Multica backend human-supplement API and minimal existing-board interaction; Muxdeck inbox adapter.
- **Acceptance:** extend current human-only supplement capability with a deliberate scoped coordinator-write route/principal policy for exact-run live supplements. Validate project/workspace scope, target run, expected version, coordinator generation and stable message/operation ID; issue queued/delivered/acknowledged receipts and deduplicate retries. Preserve original human routes and their guards. Scoped coordinator also reads live additions and responds through supported task context; preserve actor attribution, revision, authorization and ordering. Human additions while workers/main are running survive reconnect/restart and reach appropriate coordinator/task. Conflicting scope changes become visible decisions.
- **Focused validation:** human and scoped coordinator write/read authorization, exact-run targeting, duplicate same-ID supplement retry and changed-payload rejection, sequential edits, offline delivery/replay, wrong-project denial, one representative board interaction.
- **Evidence:** durable supplement events and main acknowledgment trace.

### MXP-017 — Implement scoped steer, pause and cancel (M)
- **Status:** in_progress; scoped controls and held native retry/fencing passed (E7/E12/E14); full real control matrix pending ([ledger](EVIDENCE.md)). **Requirements:** F05, F06, F09, N03. **Dependencies:** 013,014,016.
- **Acceptance scenarios:** A07, A08, A10, A24, A26.
- **Deliverable/owner:** Muxdeck control tools/worker adapter and Multica control state integration.
- **Acceptance:** main and authorized human can inspect/steer/cancel selected task/run or epic; controls record who/why and acknowledgment. Distinguish pending, accepted, effected, and failed/unknown controls. Cancellation stops only owned work; late completion cannot falsely revive canceled work. Provider-supported pause semantics are documented precisely; unsupported actions return a clear capability error.
- **Focused validation:** active/queued/already-finished cancel, retry/late result race, steer during disconnected worker, unrelated session preservation.
- **Evidence:** correlated control receipts and terminal ownership checks.

### MXP-018 — Implement durable Multica backend event feed (M)
- **Status:** in_progress; actual API outage/replay and paired durable feed passed (E7/E14); retention expiry N/A without deletion ([ledger](EVIDENCE.md)). **Requirements:** F06–F09, N01, N02. **Dependencies:** 002,005,016.
- **Acceptance scenarios:** A09, A13, A19.
- **Deliverable/owner:** Multica append-only event persistence, scoped cursor API, migration/retention policy; Muxdeck feed adapter.
- **Acceptance:** task/run transitions, human additions, coordinator actions, worker results and controls have stable ordered event identities and actor/correlation metadata. Reconnect/replay is gap detectable; retention gaps trigger authoritative resync with explicit audit-gap marker. Transport wakeups supplement durable feed rather than serving as the only history. Define transaction boundary between state mutation and event append.
- **Focused validation:** state/event atomicity, cursor pagination/reconnect, duplicate consume, cross-project denial, retention gap, restart persistence.
- **Evidence:** backend migration/check results and replay report.

### MXP-019 — Add task-to-terminal navigation in Multica (S)
- **Status:** in_progress; exact terminal/history browser checks and actual paired bindings passed (E13/E14); final protected browser walkthrough pending ([ledger](EVIDENCE.md)). **Requirements:** F04, F10, N02. **Dependencies:** 011,013,018.
- **Acceptance scenarios:** A05, A06, A21, A22.
- **Deliverable/owner:** Multica existing task detail/board link component and terminal-link backend field; Muxdeck deep-link adapter.
- **Acceptance:** task opens correct Muxdeck project/epic worker terminal or retained history, shows useful live/ended association and control feedback, and handles missing/stale full session identity even after name reuse. Main and worker terminals remain ordinary accessible Muxdeck terminals. Preserve existing board; no rewrite. Do not put credentials into URLs or expose unauthenticated console publicly.
- **Focused validation:** related frontend checks plus affected browser spec for navigation, stale target, and wrong/missing association; backend link contract explicitly checked.
- **Evidence:** paired browser recording/screenshot and exact test results.

### MXP-020 — Integrate results and verify goal closure (M)
- **Status:** in_progress; real Git integration and verified commit closure passed with fake providers (E14); real goal and requested private draft PR passed (E21); final delivery gates pending ([ledger](EVIDENCE.md)). **Requirements:** F03, F07, N03, N04. **Dependencies:** 014,016,017.
- **Acceptance scenarios:** A04, A10–A12; first demo gate.
- **Deliverable/owner:** Muxdeck integration tools/main-agent instructions and acceptance evidence summarizer.
- **Acceptance:** main reviews result evidence, integrates accepted worker commits into owned integration branch/worktree, handles merge conflicts deliberately, runs goal-level verification, and updates task/epic status accurately. Failed/blocked tasks cannot produce a completion claim. Open PR only when requested and tests/evidence satisfy the goal; retain PR/commit references and unresolved risks. Worker unit success is distinct from integrated success.
- **Focused validation:** independent commits, dependency integration, conflict/failed validation, missing result evidence, explicit PR goal on disposable authorized remote fixture.
- **Evidence:** integration commit, checks, final Multica statuses, requested PR receipt.

### MXP-021 — Implement reconstructable audit export (M)
- **Status:** in_progress; reconstructable paired audit and native DB/API/pane privacy checks passed (E8/E14/E18); complete settled real audit inventory verified (E21); final delivery gates pending ([ledger](EVIDENCE.md)). **Requirements:** F08, F09, N01, N02. **Dependencies:** 006,014,017,018,020.
- **Acceptance scenarios:** A13–A15, A19, A25.
- **Deliverable/owner:** Muxdeck audit/query/export module and diagnostic tool.
- **Acceptance:** reconstruct goal, plan revisions, actor decisions, delegated work, terminal/run identities, human messages, controls, results/artifacts, integration and closure from durable local/backend records. Export at an explicit event watermark with manifest/source hashes and capture coverage; stable machine-readable events plus readable chronology with source IDs, timestamps, correlation, gaps, and redaction. Export is restart safe and excludes secrets/private unrelated context.
- **Focused validation:** golden synthetic reconstruction, duplicate/out-of-order sources, missing/retained-away feed, redaction, reopen/export determinism.
- **Evidence:** sanitized complete-demo export validated against known event inventory.

### MXP-022 — Implement project lifecycle, backup and safe cleanup (M)
- **Status:** in_progress; SQLite/artifact and PostgreSQL restore plus ownership preservation passed (E10/E15/E16); final release lifecycle pending ([ledger](EVIDENCE.md)). **Requirements:** F12, F09, N01–N03. **Dependencies:** 009,012,015,021.
- **Acceptance scenarios:** A23, A24, A26.
- **Deliverable/owner:** Muxdeck lifecycle/backup/restore commands and operator documentation.
- **Acceptance:** start/resume/status/close/archive/restore retain associations and useful diagnostics. Consistent SQLite backup plus manifest covers needed local state without secret export; restore validates versions and reconciles against Multica rather than overwriting task truth. Cleanup requires scoped ownership, reports resources first, preserves live sessions/working trees by default, and handles moved repository roots.
- **Focused validation:** backup while journal active, restore into isolated fixture, close with running work, repeat archive, stale resources, moved repo association.
- **Evidence:** backup/restore inventory and preservation checks.

### MXP-023 — Complete recovery and fault-injection drills (M)
- **Status:** in_progress; deterministic faults and native API/daemon SIGKILL drill passed (E6/E7); remaining receiver/full fault gates pending ([ledger](EVIDENCE.md)). **Requirements:** F09, F12, N01, N03, N04. **Dependencies:** 015,017,018,021,022.
- **Acceptance scenarios:** A15–A20, A23, A24; full fault matrix.
- **Deliverable/owner:** Muxdeck/Multica fault harness and focused cross-process regression tests.
- **Acceptance:** exercise main crash, daemon crash, backend outage/restart, worker crash, network lost reply, duplicate/reordered events, stale coordinator, simultaneous resume, unknown process state and checkpoint failure. Assert no duplicate live worker, no accepted action lost, explicit audit gaps, correct blocked/failed status, and preserved unrelated sessions. Document irrecoverable conditions and operator recovery.
- **Focused validation:** cheap deterministic matrix first; representative actual process-kill/restart scenarios test a distinct integration risk.
- **Evidence:** fault matrix mapping injection→expected/observed states and receipts; all unresolved failures block v1.

### MXP-024 — Verify complete paired end-to-end and UI behavior (M)
- **Status:** in_progress; three-worker actual paired fake passed and Multica CI green (E14/E17); bounded real provider outcome passed (E21); final protected browser/Muxdeck CI pending ([ledger](EVIDENCE.md)). **Requirements:** F01–F12, N01–N04. **Dependencies:** 019,020,021,023.
- **Acceptance scenarios:** A01–A26 and A27 premerge test/CI inputs; release ledger without future deployment assertions.
- **Deliverable/owner:** both repositories' integration/browser scenario and requirements evidence index.
- **Acceptance:** this task closes product scenarios A01–A26 and supplies test/CI inputs for A27; staging rehearsal belongs to 025 and live deployment checks to 026, so neither is a prerequisite here. Exact supported provider pairing completes password-reset-style synthetic goal from natural language through bootstrap, epic/tasks, independent terminal workers, human supplement/control, crash/resume, integration checks, requested PR, terminal navigation and audit export. Test existing Multica/Muxdeck behavior affected by changes; assert preservation and auth boundaries. This is a requirement-complete scenario, not permission to claim all providers work.
- **Focused validation:** affected Python/backend/frontend/browser checks, contract tests explicitly selected, relevant CI suites; broaden only for impact or unresolved failures.
- **Evidence:** exact paired commits/provider versions, CI job timestamps, live scenario report and requirement links to evidence.

### MXP-025 — Rehearse version-paired deployment and rollback (M)
- **Status:** in_progress; isolated installer, PostgreSQL restore and actual protected service upgrade/rollback passed (E9/E15/E16); final release pins pending ([ledger](EVIDENCE.md)). **Requirements:** F11, F12, N01–N04. **Dependencies:** 024.
- **Acceptance scenarios:** A23, A24, A26, A27.
- **Deliverable/owner:** paired release manifest, install/upgrade compatibility checks, deployment runbook updates and isolated rehearsal.
- **Acceptance:** pin Muxdeck/Multica API/schema/tool/provider versions; refuse incompatible pairing; backup DB/state before migrations; define migration rollback limits and restore path. Rehearse install/upgrade/rollback in isolated staging without touching live installation. Use shared `scripts/check_deployment.py`, task-specific tests/backups, staging frontend builds, scoped resources and runbook safety. State default-branch mapping and final rollout steps explicitly.
- **Focused validation:** compatible upgrade, incompatible version rejection, backup restore and rollback rehearsal, health/status checks using shared generated report.
- **Evidence:** release manifest, backup inventory, staging deployment/rollback reports; no early live feature deployment.

### MXP-026 — Pass global v1 gate, merge and deliver (S)
- **Status:** in_progress; candidate evidence aggregated; real qualification passed (E21); final source CI/binding/default merges and live deployment pending ([ledger](EVIDENCE.md)). **Requirements:** F01–F12, N01–N04. **Dependencies:** 001–025.
- **Acceptance scenarios:** Planning and first demo gates; complete v1 premerge gate, then postmerge release completion; A01–A27 split by release phase.
- **Deliverable/owner:** release owner in both repositories; final acceptance matrix, default-branch merges, paired release and user report.
- **Acceptance:** every premerge criterion in [ACCEPTANCE.md](ACCEPTANCE.md) has passing evidence before merge; postmerge/live deployment criteria close release afterward, never acting as a circular prerequisite to the merge that enables deployment; all critical defects resolved, demo shortcuts removed, actual provider limitations stated, feature commits reviewed, paired defaults checked. With the premerge gate accepted, merge Muxdeck feature to configured `master` and Multica feature to configured `main`, push routine authorized changes and deploy the paired release to existing installation under root safety instructions. Never restart tmux, kill server/sessions, or expose unauthenticated console publicly. If deployment would require one of those excluded actions, stop that action and present the concrete need.
- **Focused validation:** final CI at released commits with recorded job timestamps; version-paired post-deploy shared check report plus task-specific natural-language/worker/audit smoke; retain rollback evidence.
- **Evidence:** final acceptance matrix, release/merge SHAs, deployment checks, private timeline report and concise delivery/limitations report. A failed gate leaves feature branches intact and v1 incomplete.

## Status changes and handoff

Record task status as planned → in_progress → done, with blocked as an explicit condition carrying the missing prerequisite. Readiness, validation, and feature integration are evidence milestones within those states; done requires all three. Link evidence rather than treating a checkbox as proof. Re-plan dependencies if live provider findings alter the design; revisit SPEC/DECISIONS/ACCEPTANCE together before incompatible implementation. First usable coordination demo closure is M1b only; v1 closure requires MXP-026 and the complete global definition of done.

Bounded real qualification passes in E21; shared final G1/G3/G4 remain pending. Task statuses stay in_progress until final acceptance and operational delivery actually close. The [durable delivery report](/root/.local/state/muxdeck/deployments/20261001T015644Z-muxpilot/DELIVERY.md) will retain the final checks and installation outcome without claiming deployment in the source candidate.
