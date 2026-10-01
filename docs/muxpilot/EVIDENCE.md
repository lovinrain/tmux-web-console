# Muxpilot evidence ledger

Status: implementation candidate; complete v1 gate pending. No scenario is marked fully accepted by this ledger.

## Recorded checks

- **E1:** `/tmp/muxpilot-combined-evidence-0142/report.{md,json}`, with `pytest.xml` and `pytest.log`: 25 passed, 1 skipped; command runtime **5.248s**. Real disposable Git repositories, isolated tmux and synthetic providers. Muxdeck base `5d51474a2fac6bde3a39ff5c0f512cb73e7cc819` plus uncommitted code; the report records before/after source hashes. Its recorded Multica base is `e31da86c90794b5c488279a3ead13ac2f31ac269` plus dirty changes. This is not evidence for the later committed pair.
- **E2:** `/tmp/muxpilot-fault-evidence/report.json`, `results.xml`, `pytest.txt`: 21 passed; pytest runtime **2.74s**, wrapped runtime **3.023s**. Actual local controller/journal/HTTP adapter against a disk-persisted synthetic authoritative receiver. This overlaps E1; do not add the counts together.
- **E3:** `/tmp/muxpilot-core-evidence/core-report.json`: 21 storage tests passed; pytest runtime **0.4s**, wrapped runtime **0.665s**. Synthetic audit, artifact and WAL-aware restore evidence; not host power-loss proof.
- **E4:** `/tmp/muxpilot-deployment/paired-evidence-attempt2/report.json`: paired scenario **failed**, Multica HTTP 404; wrapped runtime **2.019s**. Recorded Multica commit `b528ac408cd6963eb09e973ff48e0c229dca0a8a`. A successful replacement must be attached before closing the paired demo.

Private artifacts stay outside Git. Source hashes bind dirty-source runs; later edits require appropriate reruns. Test existence alone is not a passing result. A skipped scenario supplies no positive evidence. Runtime above is command time, not total task elapsed time.

## Exact E1 passing checks

| Reference | Test ID |
| --- | --- |
| C01 | `tests/test_muxpilot_e2e.py::test_real_worktree_result_handoff_and_goal_integration_preserve_dirty_source` |
| C02 | `tests/test_muxpilot_e2e.py::test_real_git_conflicting_workers_leave_explicit_unresolved_integration` |
| C03 | `tests/test_muxpilot_e2e.py::test_real_wrapper_survives_main_and_service_loss_without_duplicate_execution` |
| C04 | `tests/test_muxpilot_e2e.py::test_real_journal_replay_fencing_artifact_integrity_and_wal_restore` |
| C05 | `tests/test_muxpilot_faults.py::test_fault_before_intent_commit_has_no_remote_effect_or_phantom_intent[activate_stage]` |
| C06 | `tests/test_muxpilot_faults.py::test_fault_before_intent_commit_has_no_remote_effect_or_phantom_intent[cancel]` |
| C07 | `tests/test_muxpilot_faults.py::test_fault_after_intent_before_send_replays_same_operation_identity[activate_stage]` |
| C08 | `tests/test_muxpilot_faults.py::test_fault_after_intent_before_send_replays_same_operation_identity[cancel]` |
| C09 | `tests/test_muxpilot_faults.py::test_fault_sent_before_acceptance_requires_lookup_before_idempotent_retry[activate_stage]` |
| C10 | `tests/test_muxpilot_faults.py::test_fault_sent_before_acceptance_requires_lookup_before_idempotent_retry[cancel]` |
| C11 | `tests/test_muxpilot_faults.py::test_fault_remote_acceptance_before_reply_recovers_without_duplicate_effect[activate_stage]` |
| C12 | `tests/test_muxpilot_faults.py::test_fault_remote_acceptance_before_reply_recovers_without_duplicate_effect[cancel]` |
| C13 | `tests/test_muxpilot_faults.py::test_fault_received_receipt_before_local_commit_is_recovered_from_authority[activate_stage]` |
| C14 | `tests/test_muxpilot_faults.py::test_fault_received_receipt_before_local_commit_is_recovered_from_authority[cancel]` |
| C15 | `tests/test_muxpilot_faults.py::test_fault_checkpoint_failure_rolls_back_receipt_then_reconciles_once[activate_stage]` |
| C16 | `tests/test_muxpilot_faults.py::test_fault_checkpoint_failure_rolls_back_receipt_then_reconciles_once[cancel]` |
| C17 | `tests/test_muxpilot_faults.py::test_fault_backend_outage_restart_restores_disk_receipt_without_new_effect[activate_stage]` |
| C18 | `tests/test_muxpilot_faults.py::test_fault_backend_outage_restart_restores_disk_receipt_without_new_effect[cancel]` |
| C19 | `tests/test_muxpilot_faults.py::test_fault_receipt_before_plan_projection_repairs_from_durable_receipt` |
| C20 | `tests/test_muxpilot_faults.py::test_fault_integration_receipt_before_projection_reuses_actual_git_result` |
| C21 | `tests/test_muxpilot_faults.py::test_fault_http_feed_reorder_duplicate_conflict_and_retention_gap_are_explicit` |
| C22 | `tests/test_muxpilot_faults.py::test_fault_human_edit_during_lost_reply_survives_cursor_replay_and_decision[activate_stage]` |
| C23 | `tests/test_muxpilot_faults.py::test_fault_human_edit_during_lost_reply_survives_cursor_replay_and_decision[cancel]` |
| C24 | `tests/test_muxpilot_faults.py::test_fault_receiver_rejects_old_epoch_request_already_in_flight[activate_stage]` |
| C25 | `tests/test_muxpilot_faults.py::test_fault_receiver_rejects_old_epoch_request_already_in_flight[cancel]` |

## Scenario ledger

Partial means the referenced assertions passed within E1’s synthetic scope. Missing means E1 supplies no passing check; it does not assert that no implementation or other test exists. The release owner must attach reviewed evidence for the remaining requirement.

| Scenario | E1 status | Exact passing checks | Remaining gate evidence |
| --- | --- | --- | --- |
| A01 | missing | None | Installed interactive natural-language activation, cwd/path resolution and interruptible await proof. |
| A02 | missing | None | Authorized exact provider/version qualification and capability/auth negatives. |
| A03 | missing | None | Ambiguity/unsafe intent clarification transcript with no dependent effects. |
| A04 | missing | None | Autonomous staged continuation and actual backend bypass/override proof. |
| A05 | partial | C03 | Paired browser grouping/navigation and distinct execution associations. |
| A06 | missing | None | Rename, removal, name reuse and browser stale-link evidence. |
| A07 | missing | None | Paired control interaction with durable actor/acknowledgment trace. |
| A08 | missing | None | Actual paired role/project authorization denial matrix. |
| A09 | missing | None | Actual human board edit, offline replay and coordinator decision. |
| A10 | partial | C01, C02 | Actual provider failure/steering/retry and whole-goal integration trace. |
| A11 | partial | C01 | Complete goal/deliverable verification on intended paired sources. |
| A12 | partial | C01, C02 | Authorized requested external PR receipt and target/commit verification. |
| A13 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Complete paired event/artifact inventory, including coordinator/UI capture. |
| A14 | partial | C04 | Final source secret-sentinel scan across adapter/UI/export and retention review. |
| A15 | partial | C04 | Final source integrity/export failure rerun and product error visibility. |
| A16 | partial | C03 | Actual paired active-worker main crash and reattachment trace. |
| A17 | missing | None | Native daemon kill/restart with active selected provider and observed outcomes. |
| A18 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Actual Muxdeck delayed receiver and actual Multica stale in-flight request takeover. |
| A19 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Native backend restart/retention-gap replay and authoritative resync. |
| A20 | partial | C03, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Actual daemon distinct invocation/probe/retry identities and uncertainty display. |
| A21 | partial | C03 | Browser close/reconnect and retained output retrieval. |
| A22 | missing | None | Actual worker input refusal plus interactive main/browser proof. |
| A23 | partial | C04 | Intended release backup/restore with external reconciliation. |
| A24 | partial | C03 | Paired owned/unrelated resource preservation and final live inventory. |
| A25 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Complete demo audit reviewed against causal inventory and omissions. |
| A26 | missing | None | Runtime expired/revoked/renewed authority during active worker execution. |
| A27 | missing | None | Paired final CI, install/upgrade/rollback rehearsal, then postmerge live checks. |

## Task ledger

MXP-001 remains the delivered planning baseline. MXP-002–024 are implementation/validation in progress; no dirty-source run constitutes final integrated task completion. MXP-025 is release rehearsal pending; MXP-026 is the gated merge/deployment task. The original task acceptance remains authoritative.

| Task | Evidence available | Remaining completion evidence |
| --- | --- | --- |
| MXP-001 | Planning feature commit `5d51474` | No runtime claim. |
| MXP-002 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-003 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-004 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-005 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-006 | E1 C04; E3 storage/audit/restore | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-007 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-008 | E1 C05–C25; E2 operation fault boundaries | Actual paired receiver/daemon/backend faults; full fault matrix. |
| MXP-009 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-010 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-011 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-012 | E1 C03 isolated tmux/provider and lifetime | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-013 | E1 C03 isolated tmux/provider and lifetime | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-014 | E1 C01–C02 real Git result/integration | Whole-goal verification, requested external PR and final paired source. |
| MXP-015 | E1 C03 isolated tmux/provider and lifetime | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-016 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-017 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-018 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-019 | Implementation/test files present; no complete task acceptance reviewed | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-020 | E1 C01–C02 real Git result/integration | Whole-goal verification, requested external PR and final paired source. |
| MXP-021 | E1 C04; E3 storage/audit/restore | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-022 | E1 C04; E3 storage/audit/restore | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-023 | E1 C05–C25; E2 operation fault boundaries | Actual paired receiver/daemon/backend faults; full fault matrix. |
| MXP-024 | E1 targeted checks; E4 failed paired attempt | A01–A26 reviewed product evidence, browser and final paired CI. |
| MXP-025 | No passing rehearsal bundle reviewed | Pinned pair, staged install/upgrade/rollback and shared deployment reports. |
| MXP-026 | No final release acceptance reviewed | All premerge gates, authorized default merges, live checks and timeline report. |

## Multica focused validation handoff

The Multica implementation owner reports these passing checks at source commit
`b528ac408cd6963eb09e973ff48e0c229dca0a8a`; private source handoff is
`/tmp/muxpilot-deployment/multica-source-handoff.json`, and commands are recorded
in the shared timeline. These are focused contracts, not complete scenario closure.

- `bash scripts/dev-env.sh exec -- go -C server test ./internal/handler -run TestMuxpilot -count=1`: package runtime 0.214s.
- `go -C server test -race ./pkg/agent -run 'Test(Supplement|CodexSupplementAuthority|GrokSupplement|Claude.*Supplement|ClaudeHeldHook)' -count=1`: package runtime 4.293s.
- `go test ./internal/daemon/execenv -run 'LocalWorktree|TaskBranch|UserState|BranchRecord' -count=1`: package runtime 0.911s.
- Focused frontend schema (194), views (254), and attribution/locale (224) checks plus typecheck/lint passed; suites overlap and their counts must not be summed.

The authorized Codex smoke harness compiled/skipped without its authorization
environment; it is not real-provider evidence. Two Redis integration cases were
skipped. A full execenv run failed in Cursor MCP configuration tests, without a
baseline proof establishing those failures as pre-existing. Fork CI activation,
actual browser walkthrough, full paired protocol matrix and real provider smoke
remain pending in this handoff. Package runtimes above exclude command setup.

## Unclosed fault and release gates

Actual daemon failure with active provider, actual receiver delay across takeover, native backend outage/retention recovery, natural-language provider qualification, browser scenarios, external PR delivery, final paired CI, staged release/rollback and live preservation remain unclosed here. Host/storage power-loss survival is not claimed. The first-demo gate and complete-v1 gate remain pending.

Private timeline: `/tmp/muxpilot-implementation-timeline.jsonl`. The lead adds the final timeline report and GitHub job timestamps after final validation.
