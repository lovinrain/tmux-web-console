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

## Candidate validation refresh

Evidence reviewed against Muxdeck candidate base `4391b0757448fc7e22ea227d6fab65b8d46d497b`; each report's recorded commit and source hashes remain authoritative. Earlier dirty-source results are historical, not final-release certification. Overlapping suites are not additive.

| Reference | Recorded outcome and scope | Private artifact / exact check |
| --- | --- | --- |
| E5 | 25 passed, 1 paired test skipped; command runtime 5.347s. Stable dirty-source run based on `6b223a773abf67ac7c62858d553bd65f25292a6c`, paired Multica `b528ac4`. Same E1 check IDs C01–C25; synthetic providers. | `/tmp/muxpilot-current-synthetic-evidence/report.json`, `pytest.xml`, `pytest.log` |
| E6 | 117 core/fault checks passed; pytest 7.81s, wrapped 8.252s; Ruff/mypy passed. POSIX-lock regression and concurrent child verify 96 controller plus 96 receiver effects, exact receipts and DB integrity/reopen. Source hashes identify fix. | `/tmp/muxpilot-fault-evidence/lock-fix-report.json`, `lock-fix-results.xml` |
| E7 | Actual isolated API/database/daemon process drill passed; pytest 10.413s, wrapped 10.71s. API loss preserves fake provider, replay deduplicates receipt; daemon loss stops fake provider and marks original run failed. One distinct automatic retry queues under hold, with zero new execution. | `/tmp/muxpilot-native-fault-drill/report-final.json`, `report.md`, `pytest-final.xml`; `tests/test_muxpilot_native_faults.py::test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker` |
| E8 | Independent native-pane privacy regression passed in 0.74s: both streams, split credential writes, unchanged daemon-facing bytes, retained redacted history and artifact sentinel absence. | `/tmp/muxpilot-independent-review.md`; `tests/test_muxpilot_mirror_privacy.py::test_known_credentials_never_enter_native_pane_or_retained_history` |
| E9 | Isolated installer 16 tests passed in 4.03s, Ruff and skill validation passed, real wrapped CLI help works outside checkout. Installer upgrade/rollback restores wrapper bytes and preserves private config; no service/provider started. | `/tmp/muxpilot-deployment/release-preparation/installation-rehearsal/report.json`; `tests/test_muxpilot_installer.py`; shared timeline `operator-final-contract-tests` and `operator-isolated-installer-upgrade-rollback` |
| E10 | Isolated local SQLite/artifact restore passed: artifact hashes match, restored lease revoked, newer original event retained, overwrite refused. External reconciliation still required. | `/tmp/muxpilot-deployment/release-preparation/rehearsal-v2/report.json` |
| E11 | Read-only existing live integrity PASS, 1.082s: all 48 original panes retain identities; local/external auth gates and service journal clean. Lead separately reports five DB integrity checks passed. This is preservation during validation, not feature deployment. | `/tmp/muxpilot-deployment/live-integrity-during-validation/report.md` |
| E12 | Focused controller and service commands passed; exact command IDs/times below. Controller owner reports `/root/tmux-web-console/.venv/bin/python -m pytest -q tests/test_muxpilot_cli.py`: 30 passed in 2.39s (`controller-url-regression`, 2026-10-01T01:49:46.315Z), with mypy/Ruff clean on its owned files, covering scoped credentials, recovery, stage pinning, worker commit ranges, lost receipts, lifecycle and public links. | Shared timeline; `tests/test_muxpilot_cli.py`, `tests/test_muxpilot_service.py`; independent review confirms resume/range/dependency fingerprint fixes |
| E13 | Terminal focused checks and two representative browser cases passed after fixture fixes; later affected frontend 101 tests passed after shortcut readiness fix. Earlier terminal 159-test report is a separate overlapping run. | Shared timeline passing terminal commands below; `/tmp/muxpilot-terminal-links-final-timing/report.md` |

E7 establishes actual outage replay. Native event-retention deletion is not implemented, so actual expiry is **not applicable**, not a tested retention-gap claim; C21 remains the separate synthetic gap/conflicting-duplicate evidence. Native recovery's unheld automatic retry admission remains under owner review. E8 does not close native Multica task-message/DB/UI redaction: final native sentinel proof and corrected exact source remain pending in independent review.

### Focused timeline results

Only completed exit0 validation commands are listed. Labels identify recorder entries; the private timeline records timestamps, not command text/output. Counts above come from reports or explicitly attributed owner handoffs. Successful helper/inspection commands are not counted as tests.

| Command label | Timeline command ID | Wrapped seconds | Outcome |
| --- | --- | ---: | --- |
| controller-final-tests | `3351deeb1e6145928047cf664d9cea48` | 2.026 | passed |
| controller-range-checks | `092268230c1f4490b9cb9d0169f5cde0` | 0.040 | passed |
| service final focused validation | `d949cb35b42144f8a3f4f687618225f2` | 0.407 | passed |
| service fingerprint tests | `5699a73d97b447a9b1eded0c9a72aedc` | 0.411 | passed |
| service dependency fingerprint static validation | `b1ebbfdf3c9745378b34b0dce5dbaf70` | 0.018 | passed |
| operator-final-contract-tests | `e15becbeb6e74cc187841653a1a4877f` | 4.264 | passed |
| operator-isolated-installer-upgrade-rollback | `0531e585dcb94ba2a0c6f742540dc9fb` | 0.894 | passed |
| terminal-python-tests | `d3e0486d098446a5a023b83e58ab617a` | 2.582 | passed |
| terminal-browser-tests-identity-retry | `13fdfa3bcc004e12a68d29cda89f03e8` | 9.651 | passed |
| terminal-workspace-related-tests | `ad1ac8ab6cd4461aadc04b0ad7ba019d` | 16.245 | passed |
| terminal-ci-console-validation | `19cbfe2d90224950a7006a6acccefa8d` | 27.885 | passed |
| terminal history final vi and emacs checks | `1dab7aa8bdff4149a0999f8200db2222` | 5.406 | passed |

## Scenario ledger

Partial means referenced checks cover part of the scenario in their stated scope. E1 IDs remain historical; E5 repeats C01–C25 on its recorded source. Additional E6–E13 evidence is credited explicitly. Missing means no positive reviewed evidence for the row. The release owner must attach reviewed evidence for the remaining requirement.

| Scenario | Evidence status | Exact passing checks | Remaining gate evidence |
| --- | --- | --- | --- |
| A01 | partial | E9 installer; E12 bootstrap | Installed interactive natural-language activation, cwd/path resolution and interruptible await proof. |
| A02 | partial | E12 auth/capability negatives | Authorized exact provider/version qualification and capability/auth negatives. |
| A03 | partial | E12 unknown-main no-effect check | Ambiguity/unsafe intent clarification transcript with no dependent effects. |
| A04 | missing | None | Autonomous staged continuation and actual backend bypass/override proof. |
| A05 | partial | C03; E13 terminal/browser | Paired browser grouping/navigation and distinct execution associations. |
| A06 | partial | E13 exact identity/browser | Focused exact identity/stale-link browser checks E13 passed; final paired native history/rename coverage review pending. |
| A07 | partial | E12 exact-run controls; Multica focused contracts | Paired control interaction with durable actor/acknowledgment trace. |
| A08 | partial | E12 scoped auth; Multica handler matrix | Actual paired role/project authorization denial matrix. |
| A09 | partial | Multica focused feed; E7 outage replay | Actual human board edit, offline replay and coordinator decision. |
| A10 | partial | C01, C02 | Actual provider failure/steering/retry and whole-goal integration trace. |
| A11 | partial | C01 | Complete goal/deliverable verification on intended paired sources. |
| A12 | partial | C01, C02 | Authorized requested external PR receipt and target/commit verification. |
| A13 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25; E6 core transactions | Complete paired event/artifact inventory, including coordinator/UI capture. |
| A14 | partial | C04; E8 native-pane privacy | E8 pane/history sentinel passed; native Multica task-message/DB/UI final sentinel and final source review pending. |
| A15 | partial | C04; E6 integrity failures | Final source integrity/export failure rerun and product error visibility. |
| A16 | partial | C03 | Actual paired active-worker main crash and reattachment trace. |
| A17 | partial | E7 actual daemon crash with fake provider | E7 fake provider stopped, original run failed, held retry did not execute; selected real-provider/version fate remains unqualified. |
| A18 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Actual Muxdeck delayed receiver and actual Multica stale in-flight request takeover. |
| A19 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25; E7 actual outage/replay | E7 native outage/replay passed; actual retention expiry N/A because deletion is absent. Synthetic gaps C21; final paired resync review pending. |
| A20 | partial | C03, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Actual daemon distinct invocation/probe/retry identities and uncertainty display. |
| A21 | partial | C03; E8 retained history; E13 browser | E8 retained output and E13 browser wiring passed; complete paired final-source association review pending. |
| A22 | partial | E13 bridge/main browser checks | Actual worker input refusal plus interactive main/browser proof. |
| A23 | partial | C04; E6; E10 restore | Intended release backup/restore with external reconciliation. |
| A24 | partial | C03; E7 unrelated fixture identity; E11 original 48 panes | Paired owned/unrelated resource preservation and final live inventory. |
| A25 | partial | C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25 | Complete demo audit reviewed against causal inventory and omissions. |
| A26 | partial | E12 expired/revoked auth | Runtime expired/revoked/renewed authority during active worker execution. |
| A27 | partial | E9 install mechanics; E10 local restore; E11 preservation | Paired final CI, install/upgrade/rollback rehearsal, then postmerge live checks. |

## Task ledger

MXP-001 remains the delivered planning baseline. MXP-002–024 are implementation/validation in progress; no dirty-source run constitutes final integrated task completion. MXP-025 is release rehearsal pending; MXP-026 is the gated merge/deployment task. The original task acceptance remains authoritative.

| Task | Evidence available | Remaining completion evidence |
| --- | --- | --- |
| MXP-001 | Planning feature commit `5d51474` | No runtime claim. |
| MXP-002 | Versioned controller/receiver/backend contracts exercised by E6, E12 and Multica focused tests | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-003 | E12 capability/auth negatives; installer capability metadata E9; real provider qualification pending | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-004 | Writable paired fork b528ac4; actual isolated DB/API/daemon fixtures E7 | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-005 | Multica handler role/scope contracts; E12 project credential checks | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-006 | E6 117 core/fault tests; E3 storage/audit/restore | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-007 | E12 service framing/fingerprint/lifecycle checks; E7 actual projectd feed import | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-008 | E6 117 checks and E7 receipt replay; C24–C25 synthetic receiver takeover | Actual paired receiver/daemon/backend faults; full fault matrix. |
| MXP-009 | E12 bootstrap/diagnostics auth and no-effect tests; E9 wrapper CLI | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-010 | E9 16 installer checks, skill validation and command upgrade/rollback; natural-language run pending | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-011 | E12 stage pinning/acceptance contracts; Multica parked-stage/admission tests | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-012 | E5 C03 isolated lifetime; E7 actual execution associations; Multica pinned worktree checks | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-013 | E5 C03 provider protocol/lifetime; E8 actual tmux privacy; E7 native daemon fate | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-014 | E5 C01–C02 result/integration; E6 immutable artifact/integrity tests | Whole-goal verification, requested external PR and final paired source. |
| MXP-015 | E5 C03 main/service loss; E12 lease-expiry resume and unchanged attempt contracts | Selected real pairing, full identities, native daemon outcomes and final source. |
| MXP-016 | Multica supplement race/authority tests and attribution/schema frontend suites | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-017 | E12 exact-run controls; Multica supplement authority/race tests; E7 held retry | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-018 | Multica durable scoped feed tests; E7 actual API outage/replay; C21 synthetic gap | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-019 | E13 focused identity/navigation/history/browser results; schema/frontend attribution tests | Focused exact-source passing evidence plus all referenced acceptance scenarios. |
| MXP-020 | E5 C01–C02 real Git; E12 full commit-range and lost receipt recovery | Whole-goal verification, requested external PR and final paired source. |
| MXP-021 | E6/E3 redacted deterministic audit/artifact validation; E8 native history privacy | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-022 | E10 local backup/restore; E12 archive/resume ownership/lifecycle | Final integrated source, complete scenario requirements and external reconciliation. |
| MXP-023 | E6 deterministic cross-process/lock faults; E7 actual API/daemon kill/restart | Actual paired receiver/daemon/backend faults; full fault matrix. |
| MXP-024 | E5 25 passed, 1 skipped; E7 native drill; E13 representative browser; final paired pending | A01–A26 reviewed product evidence, browser and final paired CI. |
| MXP-025 | E9 isolated installer upgrade/rollback; E10 local backup/restore; E11 live preservation | Pinned pair, staged install/upgrade/rollback and shared deployment reports. |
| MXP-026 | E11 existing-live preservation; final release acceptance remains pending | All premerge gates, authorized default merges, live checks and timeline report. |

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

Native fake-provider API/daemon fault behavior E7, representative terminal browser checks E13 and existing-live preservation E11 are established within their scope. Actual receiver delay across takeover, real-provider/natural-language qualification, complete paired browser/scenario coverage, external PR delivery, final paired CI and full version-paired release/rollback/live feature checks remain unclosed. Actual native retention expiry is N/A without a deletion policy; synthetic gap behavior is separately tested. Host/storage power-loss survival is not claimed. The first-demo gate and complete-v1 gate remain pending.

Private timeline: `/tmp/muxpilot-implementation-timeline.jsonl`. The lead adds the final timeline report and GitHub job timestamps after final validation.
