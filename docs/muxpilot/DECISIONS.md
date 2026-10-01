# Muxpilot architecture decisions

Status: planning baseline, 2026-09-30. No runtime implementation or live provider qualification is implied. “Accepted” records the intended design; “proposed” requires the stated capability/security gate before shipping. Requirement IDs refer to SPEC.md; task dependencies and acceptance work live in TASKS.md. This document defines architecture, not permission to change live services.

## D01 — Natural invocation is explicit project opt-in (accepted)

A user can tell an installed coordinator: “Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR when tested.” Installed coordinator instructions and tools resolve the directory, establish project identity and adopt the requesting main conversation and its verified visible tmux incarnation. If that conversation has no usable tmux session, the supported launcher creates one through an explicit handoff and releases the prior lead authority; it never silently creates a second coordinator. Provider-supported tool loading/reload is a one-time setup prerequisite, not an ability inferred from the natural-language name. A mandatory per-project brief or CLI invocation would defeat this UX and is rejected. A CLI remains available for diagnostics and explicit control.

Bootstrap records the original request, canonical checkout path, repository identity, configured endpoints and permitted operations. Missing credentials or ambiguous project ownership produce a bounded question and no dependent side effect. The requested epic is planned, decomposed, delegated, integrated and verified by the main coordinator; substantial delegated work uses independent root worker sessions. Internal helpers are allowed only for bounded subtasks, not a hidden replacement for those sessions. Development-team model selection does not force a production provider/model.

Gate: exercise the literal invocation from a fresh directory without a pre-authored brief, including a second invocation that reuses identity rather than creating duplicate project state. Covers F01–F03.

## D02 — Separate project control service and Python package (accepted)

Add a `muxpilot/` Python package beside `tmux_console/`, included explicitly in setuptools packaging. Add `muxdeck-projectd = muxpilot.service:main`; extend `muxdeckctl` with a `project` namespace delegating to `muxpilot.cli`. Do not place durable project ownership in aiohttp application's startup/cleanup lifecycle: restarting the web console must not restart the coordinator or destroy project recovery state.

Proposed modules and responsibility boundaries:

| Module | Responsibility |
| --- | --- |
| `service.py`, `api.py` | Local projectd lifecycle, Unix API, authenticated requests |
| `project.py`, `config.py` | UUID registry, canonical roots, endpoint/version configuration |
| `journal.py`, `artifacts.py` | Transactions, migrations, bounded export, hashed external artifacts |
| `operations.py`, `recovery.py` | Intent/receipt state machine and conservative reconciliation |
| `coordinator.py`, `lease.py` | Main-session bootstrap, authority epoch and ownership |
| `multica.py`, `events.py` | Versioned API adapter, durable feed ingestion, capability checks |
| `sessions.py`, `workers.py` | Existing Muxdeck control API, worker-session associations |
| `integration.py` | Worktree ownership, artifact validation and integration evidence |
| `cli.py` | Human/tool commands and structured output |

These are implementation boundaries, not a requirement to create empty modules. Muxdeck's existing authenticated control API remains the session placement authority; projectd never reads browser cookies or reimplements terminal transport. Multica owns tasks and execution scheduling. Main is a separately launched interactive agent in tmux, independent of Multica daemon process ownership. Covers F02, F04, F12, N03.

Gate: restart the web process in an isolated fixture and demonstrate projectd/main survival; demonstrate independent main and daemon failure handling.

## D03 — Multica owns task/run truth; journal owns local action recovery (accepted)

Reuse Multica's board UI, task backend and daemon rather than building another scheduler. Multica task/run IDs, status, dependencies and cancellation outcomes are authoritative. Local projections are explicitly timestamped observations and may be stale. Projectd owns project mappings, action intents, receipts, leases, checkpoints and exported audit evidence. It does not independently queue or advance task statuses.

Alternatives rejected: a second local task DAG/scheduler would create divergent completion and retry decisions; tmux output scraping cannot replace framed provider results. The coordinator evaluates epic completeness against the original request and verification evidence, while observing authoritative task outcomes. Board completion alone does not establish end-to-end success or authorize a PR.

V1 uses **ordered stage batches**, persisted as parent/child issue stages in Multica, rather than claiming a native arbitrary dependency DAG. Main decomposes the goal into independently runnable tasks within each stage; later stages remain in the fixed `backlog` status until main has verified prerequisite-stage acceptance and explicitly activates an eligible batch within the configured concurrency limit. Main planning policy is not a competing local execution scheduler: it makes fenced Multica assignment/status requests; Multica creates/dispatches the actual runs. A failed or cancelled prerequisite does not automatically satisfy acceptance just because a native stage-closed notification fires. Rework creates a recorded stage/plan revision. Arbitrary per-task DAG eligibility is deferred unless a future paired backend relation/eligibility extension is separately designed and tested.

Source evidence: `server/pkg/db/queries/issue.sql` stores `stage`; `server/internal/service/issue_wakeup_system.go:49` asks the parent assignee to check dependencies before moving the next stage out of backlog. `apps/docs/content/docs/assigning-issues.mdx:45–82` documents ownership-only `--no-start`, fixed backlog parking, and immediate assignment/status-triggered runs elsewhere. Therefore create future work in fixed backlog, and apply no-start to every ownership-only assignment/status mutation. A generic custom “unstarted” status is not parking. Mentions, comments, automation/wakeups, reassignment and reruns must not bypass the project's dispatch hold/stage gate: the coordinator API/receiver policy prevents automation from starting ineligible work; an explicit authorized human override is recorded and surfaced for replanning. Native parent wakeups are hints, not permission to launch a second hidden coordinator; configure them for the adopted external main's durable inbox, or disable native agent execution on that parent.

Alternatives considered: adding a new arbitrary DAG relation and backend eligibility engine in v1 increases schema, cycle/concurrency and trigger-path enforcement scope; stage batches fit the inspected foundation and keep ownership explicit. Consequence: stage barriers may serialize some work that an arbitrary DAG could parallelize; disclose this bounded v1 limitation.

Gate: disagreeing local projection and backend state resolves to backend truth with a recorded reconciliation event. Future-stage creation/assignment/status updates produce zero runs; accepting one stage activates only its eligible next batch; cancelled/failed prerequisites and project dispatch hold prevent automatic advancement; mention/wakeup/reassignment bypass attempts are rejected or explicitly recorded human overrides. Covers F03, F07–F09.

## D04 — Interactive main, structured mirrored workers in v1 (accepted; provider qualification pending)

Main runs an ordinary interactive provider TUI in its own root tmux session. Multica daemon owns worker provider protocol/lifecycle; a provider-specific custom-runtime executable delegates unchanged arguments through `muxdeckctl exec`. Each substantial worker run has a primary root tmux session and project group, with Multica task/run IDs available in the UI. Model a run-to-execution-to-session association rather than assuming one provider process for an entire run: continuation, helper/model probes, or adapter restarts may invoke multiple subprocesses. A daemon-assigned execution UUID identifies each substantive provider invocation, and its stable launch operation UUID identifies retries of that invocation. Do not use only task/run ID or session display name as a launch idempotency key: a new legitimate invocation in the same run needs a fresh execution identity. Exact discovery probes bypass launch only after capability qualification. The daemon/adapter must provide that identity before wrapping execution; a wrapper-generated random ID on every retry cannot establish safe deduplication. Nested helpers do not stand in for these roots.

Muxdeck `docs/AGENT_ORCHESTRATION.md` around line 370 documents the implemented wrapper mechanism. It expressly states that providers receive pipes rather than a TTY and the bridge is local same-UID transport. Existing bridge output mirroring does not establish native worker TUI input forwarding or live provider compatibility. V1 inspection means terminal output plus structured run data; steering means a supported authenticated control command with an acknowledged result. Raw native worker TUI takeover is a separately gated capability and must never be presented as available merely because a terminal is visible.

Bridge exec lifetime remains coupled to the daemon's connection; worker survival across daemon failure is not promised. Coordinator failure and daemon failure are different recovery cases. Alternatives rejected: substituting pane capture/send-keys for structured provider protocols; silently claiming a human can type into a mirrored protocol worker.

Gate: qualify one pinned provider/backend/version pair for discovery probes, byte-preserving protocol, supplements/cancel, output mirror, disconnect cleanup and exit/error reporting. Keep provider stdout protocol-clean. Mark unsupported combinations explicitly. Covers F04–F06, N04.

## D05 — Local transport and project-scoped credentials (proposed)

Projectd listens on a private Unix socket under a mode-0700 state directory; socket mode 0600 and same-UID peer checks. Project-scoped tokens enforce application policy and attribution; they do not isolate hostile processes sharing the same Unix UID, which may access private files or processes. Strong worker isolation would require separate OS identities/sandboxing and is outside the v1 security claim. Coordinator tools receive a short-lived, project-scoped credential and explicit operation scopes, not a global human token. Muxdeck control credentials stay in private token files and are referenced rather than copied into transcripts, environment exports or tmux arguments. Multica communication uses configured authenticated HTTP endpoints; default installation is loopback/private network, not an unauthenticated public console.

Existing Multica task tokens are run-bound (`mat_`); they are not automatically a coordinator credential spanning an epic. Add explicit coordinator principal/project binding and authorize task reads/mutations against that project on every request. Expiry/renewal must be independent of one worker run, revocable and audited. Token values are never journal payloads.

`server/cmd/server/router.go:2047` applies `RequireHumanActor` to task supplements (and retries). Add a scoped coordinator steering route or deliberate principal-aware authorization; never impersonate a human or remove the human-only guard globally. Define supported stop/cancel/resume semantics at the backend adapter: resume may create a new authoritative run and must not claim to revive a dead provider.

Gate: project A cannot read or steer B; expired/revoked principals fail closed; human routes retain their current guard; CLI, API, UI and export redact secrets. Covers F05, F06, F11, N02.

## D06 — Execution-time fencing and durable operation receipts (proposed)

Use a per-project monotonically increasing coordinator epoch/lease. Each mutating request carries project UUID, operation UUID, coordinator epoch, request hash and expected resource/version where applicable. The authority validates the epoch at execution time, not only when queued. For Multica mutations, backend admission/execution must participate in fencing; Muxdeck session launch/control receivers must similarly validate generation or accept requests only through a fenced gateway that cannot leak a delayed admitted action; a local lease alone cannot protect a delayed remote request after takeover. Human board actions remain independently authorized and appear in the event feed; they do not silently inherit coordinator identity.

Local operation states: `prepared` → `dispatched` → `confirmed`, or `uncertain`/`rejected`. Persist intent before side effects and receipt after acknowledgement. Retrying the same operation UUID and identical payload returns the original receipt where the backend supports this contract; a changed payload is rejected. Existing CRUD endpoints are not presumed idempotent. Until their receipt support is implemented, loss of response triggers resource lookup/reconciliation and uncertainty, not blind repeated creates or provider launches. Cancellation and launch receipts identify the actual task/run/session involved.

Gate: crash before dispatch, after remote commit before reply, after reply before local checkpoint; delayed old-epoch request after takeover; same-ID changed payload; receipt lookup after restart. Verify no duplicate run or PR. Covers F05, F09, F11, N01.

## D07 — Durable cursor feed, with transactional backend outbox (proposed)

Websocket notifications are wakeup hints, not a replay guarantee. Add a Multica project-filtered ordered event feed backed by an outbox written transactionally with relevant task/board mutations. Cover both coordinator operations and human board actions. Include immutable event ID, project scope, cursor/sequence, schema version, actor kind/ID, operation ID where present, resource ID/version, event kind and sanitized payload.

Projectd fetches after its durable cursor, inserts unique source event IDs and advances the cursor in one local transaction. At-least-once delivery is deduplicated. Order is defined per project; no global order or exactly-once network delivery is promised. Cursor expiry has an explicit response: fetch a consistent authoritative snapshot with watermark, record the retention gap, rebuild the projection and resume after the watermark. A snapshot alone cannot reconstruct lost historical human actions; expose that audit limitation. A live websocket reconnect must not be described as filling such gaps.

Gate: offline projectd misses several human edits and worker events, resumes without duplicates or omissions within retention; retention-gap recovery is visibly distinct; snapshot watermark does not race writes. Covers F06–F09, N01.

## D08 — One private SQLite journal per project (accepted)

Canonical path: `~/.local/state/muxdeck/projects/<UUID>/journal.sqlite3`. Directory 0700, database/artifacts 0600, SQLite WAL and `synchronous=FULL`. A registry binds UUID to canonical repository/project root; renames require deliberate remapping, and copied checkouts do not automatically become the same active project. Reject unsupported filesystem durability/locking configurations rather than silently promising power-loss safety.

Use append-only event rows with schema version, local sequence, UTC timestamp, actor, correlation/operation IDs, kind and sanitized payload. In the same transaction update normalized operations, receipts, checkpoints, source cursors, lease epochs and task/run/session/worktree mappings. Materialized tables are mutable projections; audit event history is not. SQLite transactions cannot atomically commit a remote action: D06 handles that boundary. FULL/WAL is a crash-durability choice subject to filesystem/hardware behavior, not an unconditional guarantee.

Artifacts/transcripts are external, content-hashed files. A journal checkpoint advances only after the relevant local event/projection transaction commits; it cannot certify an unacknowledged remote action or a file merely buffered by the model. Write temporary file, fsync, rename, fsync directory, then reference hash/path/size in a committed journal transaction. Unreferenced files can be collected conservatively; referenced missing/corrupt files mark evidence incomplete. Never inline credentials or full ambient environment. Retention and redaction policies are explicit; sensitive transcript storage remains private.

JSONL and Markdown are generated exports with checkpoint/cursor and incomplete-evidence markers; neither is a second mutable source of truth. Export is bounded and redacted. Backups checkpoint safely and include referenced artifacts; schema migration is versioned, backed up and tested for interruption. Covers F08, F09, N01, N02.

Gate: kill/restart during transaction and artifact creation, foreign-key/mapping consistency, duplicate source events, redaction and corrupt/missing artifact detection.

## D09 — Recovery reconciles ownership before continuing (accepted)

| Fault | Recovery behavior |
| --- | --- |
| Main exits/crashes | Projectd/journal remain; observe surviving daemon workers; new main gets new fenced epoch and reconstructs request, plan, backend status and uncertain operations before mutations. |
| Projectd crashes | tmux main and daemon workers are independently owned; restart reads journal, validates lease/mappings and reconciles pending receipts before admitting writes. |
| Multica daemon crashes/disconnects | Structured bridge workers may terminate; query backend run outcomes and daemon health. Record interrupted/uncertain runs; request supported rerun/resume, never claim terminal mirroring preserved execution. |
| Multica backend unavailable | Read-only local evidence remains accessible with staleness marker; do not start duplicate local scheduling or unconfirmed task transitions. |
| tmux session missing/replaced | Match stored server/session identity and ownership, not only display name; mark mapping lost, recreate only an owned session when authorized. |
| Reboot | Restart configured private services; reconcile project state and authoritative runs before provider launch; do not kill/recreate unrelated sessions. |

A recovered coordinator does not reconstruct private model reasoning; it receives durable request/action/result evidence and current state. Human stop means an explicit scoped operation, not a global kill-server. Recovery must report ambiguity requiring intervention when ownership cannot be established. Covers F09, F12, N03.

## D10 — Worktree and artifact integration is explicit (accepted)

Main owns integration checkout and feature branch. Workers receive task-scoped worktrees/branches with recorded base SHA, owner and allowed paths; avoid concurrent writers to the same checkout. Shared read-only dependencies may be reused; writable caches or services require declared ownership. Existing dirty work is preserved/snapshotted before task-dependent edits. Local worktree paths must be visible to both daemon and bridge host; container path translation is explicit, not inferred.

Worker result links task/run, commit or patch hash, base SHA, affected files, artifact hashes, test commands/results and limitations. Main inspects and integrates artifacts into the project branch, resolves conflicts, verifies the whole epic and records final commit/test/PR receipt. Worker success alone cannot close the epic. No automatic commit attribution spoofing; preserve provenance. Covers F03, F07, N03.

Gate: two independent workers integrate disjoint changes, a conflicting change remains explicit, dirty unrelated work survives, invalid/stale-base artifact is rejected, and final acceptance runs on the integrated revision.

## D11 — Repository boundaries and version pairing (accepted; target gate pending)

Muxdeck repository owns `muxpilot/`, projectd/CLI, local journal/recovery, tmux associations, control integration and Muxdeck project affordances. Multica owns coordinator auth/fencing/receipt APIs, transactional durable event feed, board/task UI additions and any required daemon/runtime profile changes. Provider wrappers and adapter compatibility tests reside with Muxdeck; backend protocol contract fixtures are shared by pinned schema/version.

Muxdeck work proceeds on isolated `feat/muxpilot` and merges to its actual default `master` after review. Multica work requires an isolated feature branch and eventual merge to its default `main`. Inspected Multica origin is `https://github.com/multica-ai/multica`; no writable private fork or push permission is assumed. Select/confirm the writable fork/PR target before cross-repository publishing, without blocking local design or capability inspection.

Release manifest pins Muxdeck SHA, Multica SHA, provider executable/version, runtime profile/backend and event/API schema capability set. Refuse mutating startup on incompatible required capabilities; read-only diagnostics can explain the mismatch. Qualification chooses the runtime provider/model; GPT-6.1-sol here is the development team selection, not a mandated runtime backend. Covers F02, F12, N04.

Gate: build an executable capability matrix and one passing pinned pair; deliberately mismatched versions fail with actionable diagnostics. Do not broaden support claims beyond measured combinations.

## D12 — Safe local service packaging and retained attribution (accepted)

Bootstrap inspects and reuses configured healthy Multica server/daemon/projectd instances. It may start explicitly configured local dependencies under the requested workflow, with ownership, ports, health/version checks and journaled receipts. Installation packages separate service units and private state/config paths; no migration runs implicitly as a web import. Migrations/backups and rollout/rollback use the repository deployment runbook, staging frontend output and scoped health checks. Stop only services owned by the project/installation; never restart tmux or destroy unrelated sessions. Localhost/private exposure remains the default.

Retain Multica product name, logo, copyright and attribution in reused/derived UI. `LICENSE` Part I 1(b) covers extracted UI components as well as original apps. Headless backend/daemon/CLI use requires user-facing built-on-Multica documentation linking to its upstream, plus source/NOTICE preservation under 1(c). Internal local use is the intended scope; public third-party hosting/commercial distribution requires a separate license assessment under 1(a), not an architectural assumption of permission.

Gate: installation dry run/reuse tests, owned-service restart/reboot fixtures, migration rollback rehearsal and visible UI/docs attribution inspection. Planning/docs updates require no frontend build or live restart. Covers F10, F12, N02, N03.

## D13 — Commands and event envelopes are versioned contracts (proposed)

Natural-language coordinator calls resolve into typed project operations exposed by the CLI/local API: bootstrap/status, plan/task creation, worker inspect/steer/stop/resume, reconcile, export and finalize. Every operation declares required scope, project/resource IDs, expected version/epoch, operation UUID and bounded payload. Responses distinguish accepted/pending, confirmed, rejected and uncertain; a transport success is never represented as completed execution.

For the ordinary interactive main, the default event loop uses a bounded, interruptible await-events tool while work is outstanding, then records a decision before acknowledging that inbox cursor. Provider-specific push/wakeup mechanisms need an explicit capability proof. If the main returns idle, retain events and expose its resume state; do not inject raw terminal keys or start a hidden replacement leader. The first pairing probe demonstrates this continuation path and human interruption.

Local event families include project registration, request accepted, coordinator lease change, operation prepared/dispatched/receipt/uncertain, backend event ingested, session associated/lost, artifact recorded, verification result, recovery checkpoint and closure. Worker progress and human board events retain their source actor/cursor; receipt and event IDs link local and backend evidence. Terminal text remains supplementary evidence rather than a machine state protocol.

Gate: contract fixtures reject missing scope/epoch, unknown schema versions, oversized or secret-bearing payloads; structured outputs remain stable for installed coordinator tooling. Covers F01, F05–F08, F11, N04.

## D14 — GitHub Copilot CLI as a coordinator and worker provider (accepted; qualification per installation)

Copilot support reuses Multica's existing `copilot` backend unchanged: workers run
`copilot -p PROMPT --output-format json --allow-all --no-ask-user [--model]
[--resume SESSION]` through the approved `muxpilot-worker` custom runtime profile
(`runtime_type` `copilot`, fixed arguments `--provider /absolute/copilot --`).
The wrapper appends `--excluded-tools task read_agent write_agent list_agents`
and refuses `--fleet`, `--available-tools` and `--acp` in a task invocation, so
open-ended delegation remains visible Multica work. An exact `copilot --acp` with
no Muxpilot task identity is Multica's model discovery and passes through. The
JSONL stream keeps its exact wire bytes and redacted retained capture; the pane
receives the bounded `copilot-jsonl-v1` progress projection.

Copilot's non-interactive mode has no live input channel, so Multica negotiates no
task supplement for it and `supplement` fails with `task_supplement_unsupported`.
Steering uses an explicit cancel-and-resume workflow: cancel the exact run, then
`continue` it with a follow-up instruction. Multica stores the bounded
instruction as the new attempt's run-scoped handoff note (`continue-instruction-v1`)
and its rerun lineage resumes the source session in the source workdir when the
cancellation is resume-safe. Reports call this cancel-and-resume, never live steering.
The interactive main is an ordinary Copilot session; its shell exposes
`COPILOT_AGENT_SESSION_ID`, which `muxpilot start` binds as the main conversation.
Personal skills are discovered from `~/.copilot/skills`. Covers F01, F04, F05, F09, N04.

Gate: an installation-specific real Copilot smoke with at least two workers,
cancel-and-resume, integration, tests and main recovery before qualification.

## Shipping boundary

The design is a proposed baseline for task breakdown and bounded spikes, not a claim of implemented capabilities or human sign-off. Required pre-release gates are provider/version qualification (D04/D11), scoped auth and execution fencing (D05/D06), replayable human/backend audit (D07), crash/artifact recovery (D08/D09), integrated epic verification (D10), and owned-service packaging/attribution (D12). Broader provider matrices, remote-host stdio, raw worker TUI takeover and stronger hardware durability claims are outside the initial guarantee until separately demonstrated.
