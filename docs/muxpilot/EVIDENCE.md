# Muxpilot evidence ledger

Status: aggregate contracts reviewed and the second bounded real Codex qualification passed. The first failed run remains historical evidence. Final source CI (G1), release binding (G3) and live deployment (G4) remain pending.

## Recorded checks

- **E1:** `/tmp/muxpilot-combined-evidence-0142/report.{md,json}`, with `pytest.xml` and `pytest.log`: 25 passed, 1 skipped; command runtime **5.248s**. Real disposable Git repositories, isolated tmux and synthetic providers. Muxdeck base `5d51474a2fac6bde3a39ff5c0f512cb73e7cc819` plus uncommitted code; the report records before/after source hashes. Its recorded Multica base is `e31da86c90794b5c488279a3ead13ac2f31ac269` plus dirty changes. This is not evidence for the later committed pair.
- **E2:** `/tmp/muxpilot-fault-evidence/report.json`, `results.xml`, `pytest.txt`: 21 passed; pytest runtime **2.74s**, wrapped runtime **3.023s**. Actual local controller/journal/HTTP adapter against a disk-persisted synthetic authoritative receiver. This overlaps E1; do not add the counts together.
- **E3:** `/tmp/muxpilot-core-evidence/core-report.json`: 21 storage tests passed; pytest runtime **0.4s**, wrapped runtime **0.665s**. Synthetic audit, artifact and WAL-aware restore evidence; not host power-loss proof.
- **E4:** `/tmp/muxpilot-deployment/paired-evidence-attempt2/report.json`: paired scenario **failed**, Multica HTTP 404; wrapped runtime **2.019s**. Recorded Multica commit `b528ac408cd6963eb09e973ff48e0c229dca0a8a`. Historical failure; E14 is the passing replacement within its fake-provider scope.

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

Evidence includes successive Muxdeck candidates through `779b9209b6a04e6eb5d3547867d91a113b8934f8`; each report's recorded commit and source hashes remain authoritative. Earlier dirty-source results are historical, not final-release certification. Overlapping suites are not additive.

| Reference | Recorded outcome and scope | Private artifact / exact check |
| --- | --- | --- |
| E5 | 25 passed, 1 paired test skipped; command runtime 5.347s. Stable dirty-source run based on `6b223a773abf67ac7c62858d553bd65f25292a6c`, paired Multica `b528ac4`. Same E1 check IDs C01–C25; synthetic providers. | `/tmp/muxpilot-current-synthetic-evidence/report.json`, `pytest.xml`, `pytest.log` |
| E6 | 117 core/fault checks passed; pytest 7.81s, wrapped 8.252s; Ruff/mypy passed. POSIX-lock regression and concurrent child verify 96 controller plus 96 receiver effects, exact receipts and DB integrity/reopen. Source hashes identify fix. | `/tmp/muxpilot-fault-evidence/lock-fix-report.json`, `lock-fix-results.xml` |
| E7 | Actual isolated API/database/daemon process drill passed; pytest 10.413s, wrapped 10.71s. API loss preserves fake provider, replay deduplicates receipt; daemon loss stops fake provider and marks original run failed. One distinct automatic retry queues under hold, with zero new execution. | `/tmp/muxpilot-native-fault-drill/report-final.json`, `report.md`, `pytest-final.xml`; `tests/test_muxpilot_native_faults.py::test_native_api_outage_replay_and_daemon_sigkill_reconcile_exact_worker` |
| E8 | Independent native-pane privacy regression passed in 0.74s: both streams, split credential writes, unchanged daemon-facing bytes, retained redacted history and artifact sentinel absence. | `/tmp/muxpilot-independent-review.md`; `tests/test_muxpilot_mirror_privacy.py::test_known_credentials_never_enter_native_pane_or_retained_history` |
| E9 | Isolated installer 16 tests passed in 4.03s, Ruff and skill validation passed, real wrapped CLI help works outside checkout. Installer upgrade/rollback restores wrapper bytes and preserves private config; no service/provider started. | `/tmp/muxpilot-deployment/release-preparation/installation-rehearsal/report.json`; `tests/test_muxpilot_installer.py`; shared timeline `operator-final-contract-tests` and `operator-isolated-installer-upgrade-rollback` |
| E10 | Isolated local SQLite/artifact restore passed: artifact hashes match, restored lease revoked, newer original event retained, overwrite refused. External reconciliation still required. | `/tmp/muxpilot-deployment/release-preparation/rehearsal-v2/report.json` |
| E11 | Read-only existing live integrity PASS, 1.082s: all 48 original panes retain identities; local/external auth gates and service journal clean. Lead separately reports five DB integrity checks passed. This is preservation during validation, not feature deployment. | `/tmp/muxpilot-deployment/live-integrity-during-validation/report.md` |
| E12 | Focused controller and service commands passed; exact command IDs/times below. Controller owner reports `/root/tmux-web-console/.venv/bin/python -m pytest -q tests/test_muxpilot_cli.py`: 30 passed in 2.39s (`controller-url-regression`, 2026-10-01T01:49:46.315Z), with mypy/Ruff clean on its owned files, covering scoped credentials, recovery, stage pinning, worker commit ranges, lost receipts, lifecycle and public links. The later positive active-run renewal regression passed in the owner's 31-test CLI run with Ruff/diff checks: `test_active_run_renewal_extends_expiry_without_replacing_authority_or_worker` verifies extended expiry, unchanged scope/authority/remote generation/worker identity and exactly one renewal effect. | Shared timeline; `tests/test_muxpilot_cli.py`, `tests/test_muxpilot_service.py`; independent review confirms resume/range/dependency fingerprint fixes |
| E13 | Terminal focused checks and two representative browser cases passed after fixture fixes; later affected frontend 101 tests passed after shortcut readiness fix. Earlier terminal 159-test report is a separate overlapping run. | Shared timeline passing terminal commands below; `/tmp/muxpilot-terminal-links-final-timing/report.md` |

E7 establishes actual outage replay. Native event-retention deletion is not implemented, so actual expiry is **not applicable**, not a tested retention-gap claim; C21 remains the separate synthetic gap/conflicting-duplicate evidence. Native DB admission and recovery contracts reject held/future-stage execution; E7 distinguishes a queued retry from a new provider execution. E8 pane privacy is now complemented by E18 actual native DB/API sentinel proof at the final Multica source. The protected deployed UI remains G4; E8/E18 cover the controlled pane/history and native API/storage privacy boundaries without duplicating a browser sentinel walkthrough.

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

## Aggregate candidate gates

The candidate has passing paired fake-provider evidence (E14) and bounded natural-main real Codex qualification (E21). E19 remains the failed first run; E21 completes the separately authorized second run with accepted verification, goal closure and the requested private draft PR. Final source CI, release binding and live deployment remain pending.

| Reference | Result and scope | Evidence |
| --- | --- | --- |
| E14 | Paired attempt9 passed: actual Multica API/database/daemon, projectd, Muxdeck and tmux; three staged fake RPC workers, overlapping implementation, human timeline-delivered supplement, main SIGKILL/replacement with fenced generation, exact integration baseline, commit closure, terminal associations and complete audit. Command 10.733s; pytest runtime remains recorded in the report. Muxdeck `3faff527c6e5767c5e088c82f0332f3851865294` plus stable dirty hashes; Multica `06d24ee9f52d8dc48287f24f956451979cb04469` plus recorded hashes. | `/tmp/muxpilot-deployment/paired-evidence-attempt9/report.{md,json}` and `fixtures/test_paired_multica_daemon_thr0/stack/paired-report.json` |
| E15 | PostgreSQL17 exported-snapshot dump/restore passed into a disposable DB: all 130 public-table counts, representative project/task/feed/operation/migration fingerprints, schema constraints/indexes/triggers preserved. No restored daemon started and source services not restarted. | `/tmp/muxpilot-pg-restore-rehearsal/report-final.json` |
| E16 | Actual protected isolated systemd Muxdeck upgrade/rollback passed: old `96769f6` → immutable candidate `4391b075` → old. Three shared checker reports pass; SQLite-aware backups of five DBs have integrity OK; cookie/state and newer launch fences retained; stale receiver 409/current 201 verified; two owned pane identities and default socket preserved. Harness 6.5s, prior staged build 17.3s separate. | `/tmp/muxpilot-deployment/rollback-rehearsal/attempt-2/report.{md,json}`, `old-checks`, `candidate-checks`, `rolled-back-checks` |
| E17 | Multica full manual CI 36804875579, PR CI 36804879056 and Mobile Verify 36804879075 completed success at `06d24ee9f52d8dc48287f24f956451979cb04469`. Individual conditional jobs skipped remain identified in the report; workflow success is not every-job execution. Lead reports Muxdeck CI `36807078878` success at `779b9209b6a04e6eb5d3547867d91a113b8934f8`; the earlier `4391b075` run reported 1859 Python checks, 1347 frontend checks and 44-module typecheck. Later source deltas still require affected validation and final CI binding (G1). | `/tmp/muxpilot-deployment/multica-ci-timeline/report.md`; GitHub workflow/job timestamps in shared timeline |
| E18 | Native Multica PostgreSQL and API sentinel checks pass: both saved text/tool-result message types omit sentinel and contain redaction markers; paired fake9 additionally checks three stored native text/tool privacy records. Native tmux/privacy E8 remains separate. | `/tmp/muxpilot-deployment/paired6-native-transcript-{db,api}-redaction.json`; E14 paired report |
| E19 | First authorized real Codex `gpt-6.1-sol`/CLI 0.159.2 run failed qualification at its active deadline: 504.754s plus prior 31.801s = 536.555s charged aggregate; exactly three worker runs. Ordinary main created the plan, two overlapping implementations completed and were accepted/integrated, and the exact-base verifier passed 12 tests plus independent real HTTP/security checks. No final verifier acceptance, goal closure or draft PR. All three wrappers/observed provider descendants and owned stack resources closed. Audit hashes match at watermark241; late execution event242 is outside that snapshot. The separately authorized second run later passed at E21; this first report remains failed history. | `/tmp/muxpilot-deployment/real-smoke-report.json`; `real/ed50401f-1fae-4194-b4d5-73505b2e333e`; `/tmp/muxpilot-independent-review.md` |
| E20 | Readable Codex mirror and semantic capture privacy corrections independently reviewed clear. Qualified stdout is decoded/sanitized per thread/turn/item/text channel; known Unicode/ASCII JSON escapes and joined/interleaved deltas are protected, while daemon wire remains exact. Sanitized JSONL representation and omissions are explicit; incomplete captures emit audit gaps and block acceptance. Actual500-character provider IDs, completion/EOF tails, invalid UTF8/decoded surrogates, state/record bounds and reserved-key collisions are covered. Owners report76 capture/runtime/CLI cases (6.14s),21 final helper cases (0.10s) and17 final pane cases (1.38s), with Ruff/mypy/diff checks; overlapping counts are not additive. Final helper SHA `48c1e0eb9feb50009f00d7b801c1837071b695194ddd343a3ae7584d60328482`. Prior helper interoperability processed all three retained native streams with zero omissions/pending items. Final integrated rerun/CI binding remains G1. | `/tmp/muxpilot-capture-privacy.patch`, `/tmp/muxpilot-capture-key-collision.patch`, `/tmp/muxpilot-fault-evidence/mirror-privacy.patch`; `/tmp/muxpilot-semantic-capture-native-interop-final.json`; `/tmp/muxpilot-independent-review.md` |
| E21 | Second authorized natural-main Codex `gpt-6.1-sol` run passed in 414.107s: exactly three workers completed; verifier handoff/acceptance and final checks passed; requested private draft PR 1 targets `main` at verified head `e95bd733e399e900e822b777f433fdd1f157d6a2`. Settled complete audit watermark 283/event count 283 verifies all 12 worker artifacts and 16 artifacts total. Run `063e8613-84d4-4b7c-ae59-2e33dd530d29`, project `df7dccea-8420-4aae-ab35-849f639958a4`, source base `fa4149`; final source CI/binding remains separate. Qualification applies to this exact configured pairing and exercised goal. Independent final result review passed. Goal closure was observed at event 261; the operator cleanup takeover later reset local lifecycle to active at event 274 while retaining closure evidence and holding dispatch. No final closed-state or live deployment claim. | `/tmp/muxpilot-deployment/real-smoke-second-report.json`; [private demo PR1](https://github.com/lovinrain/muxpilot-demo-20261001-0144/pull/1); settled export `real-second/063e8613-84d4-4b7c-ae59-2e33dd530d29/projects/df7dccea-8420-4aae-ab35-849f639958a4/exports/e9570d88-4013-410a-804a-ca98e45543b0` |

E14 uses a synthetic issue-retrieval sidecar to emulate delegated CLI context.
It proves protocol, lifecycle and real Git effects; it does **not** prove the
installed real provider's CLI task-context retrieval or model-driven planning.
E16 is loopback staging rehearsal, not public-proxy deployment or a full browser
walkthrough. E15 restores database state without launching workers. The prior
failed attempts remain retained diagnostics and are superseded only within
E14's successful exercised scope. Final candidate source is still evolving;
release evidence must pin the final pair and rerun affected checks.

## Scenario ledger

This is an aggregate review of E1–E21, the focused native contracts below, installed skill behavior and the passing source CI. **Covered** means the applicable contract is supported within the stated boundary; it does not mean every historical suite was repeated on every later commit. **Outcome gate** identifies the recorded qualification boundary; E21 now closes the bounded real outcome. Test existence alone is never credited as a pass. Final source deltas and deployment are tracked once in G1–G4 rather than requiring duplicate scenarios for already established behavior.

| Scenario | Aggregate status | Reviewed evidence and boundary | Remaining gate |
| --- | --- | --- | --- |
| A01 | covered within qualification scope | E9 installed tools/launcher; E12 canonical identity, existing-main adoption and second-main refusal; E14 pairing; E19 ordinary natural-language main/bootstrap and bounded event continuation observed. | E21 bounded real outcome passed. |
| A02 | outcome gate | E12 capability/account/project-auth negatives; E19 actual approved profile, Codex CLI 0.159.2, helper-disable proof and native delegated issue/context retrieval. No fallback or fabricated completion. | E21 closes bounded G2; G1 final source binding remains pending. |
| A03 | covered | Installed skill clarifies path/scope/authority ambiguity; E12 canonical project resolution and unknown/changed-main no-dependent-effect contracts. These combine instruction and negative-effect evidence without a universal-language guarantee. | None beyond G1. |
| A04 | covered within qualification scope | Native `TestDurableFeedAndAdmission`, `TestMuxpilotCoordinatorTaskIdempotencyAndStageScope` and scope/admission regressions reject hold, Backlog/future-stage work and cancelled prerequisites. E12 exact base pins; E14 staged continuation; E19 accepted implementations precede verifier dispatch at SHA `252cf751`. | E21 bounded real outcome passed; backend bypass coverage is established. |
| A05 | covered | E13 representative grouping/navigation/browser assertions; E12/E14 distinct provider-execution UUIDs, immutable task/run links and native session associations; E19 three visible native executions. | G1 readable-mirror delta; G4 installed browser observation. |
| A06 | covered | E13 actual tmux/browser exact identity, rename/name-reuse/stale-link cases; E8 retained native history; E14 completed-run association reconciliation. | None beyond G1. |
| A07 | covered | E12 exact-run controls/attempt distinctions; native negotiated supplement/idempotency/ack contracts; E14 attributed human supplement and durable delivery receipts. Receipt is delivery evidence, not compliance. | None beyond G1. |
| A08 | covered | E12 scoped credentials and denied effects; native human/coordinator/worker role and tenant matrix; explicit external-coordinator attribution. No human impersonation. | None beyond G1. |
| A09 | covered | Native `TestMuxpilotNativeHumanChangeRetainsActor` proves authoritative edit actor/source; E12 sparse cursors plus C22–C23 lost-reply human-edit replay retain the edit and explicit decision/ack without duplicate mutation; E7 native outage replay. | None beyond G1; no duplicate real-provider edit run required. |
| A10 | covered | C01–C02 actual Git result/conflict behavior; E7 failed-run/held-retry distinction; E12 latest-attempt evidence and full source ranges; E14 whole-goal fake closure; E19 real accepted sources and integration. | E21 bounded real outcome passed. |
| A11 | covered within qualification scope | E12 absent/failing/mismatched/latest-run checks and closure blockers; E14 actual final goal check and commit closure; E19 passing real checks correctly did not become accepted closure. | E21 bounded real outcome passed. |
| A12 | covered within qualification scope | C01–C02 preserve dirty/unrelated source and expose conflicts; E12 full-range/lost-receipt integration; E19 source baseline preserved and both real source ranges integrated. | E21 bounded real outcome passed. |
| A13 | covered | E3/E6 WAL/FULL journal/settings, atomic decisions/projections, immutable artifacts; E14 reviewed causal inventory and all 19 artifact hashes; E19 13 snapshot file/artifact hashes match. Coverage explicitly excludes hidden reasoning/unmanaged shell/provider-native history. | E21 bounded real outcome passed; no power-loss/tamperproof claim. |
| A14 | covered | E6 permissions; E8 raw split-stream pane/history and byte-exact wire; E18 native DB/API text/tool-result privacy. E20 corrects independently reproduced JSON-decoded/same-item split credentials in views and retained capture, with bounded per-item semantic sanitization and post-display defense. Controlled known values are protected; arbitrary encodings/fragmented unrelated fields are not guaranteed. | G1 final integrated privacy checks/source CI binding. |
| A15 | covered | E3/E6 missing/corrupt/denied-export and transaction rollback fixtures surface errors, preserve journal and block unsupported acceptance/closure; E12 applies artifact completeness gates. | None beyond G1. |
| A16 | covered | C03 separate ownership lifetimes; E12 expiry/takeover/adoption; E14 actual main loss advances generation while adopting the same two running attempts without respawn. | None beyond G1; not a worker-survival promise for daemon loss. |
| A17 | covered | E7 actual native daemon death stops the fixture provider and records failure; the actual bridge owner-death test cleans a provider/grandchild, and native terminal-report/recovery contracts preserve interrupted/uncertain truth. E19 selected real processes were factually reaped during cancellation. | None beyond G1; selected-provider daemon survival is not claimed. |
| A18 | covered | Actual aiohttp `test_real_muxdeck_receiver_rejects_delayed_old_launch_and_input` and serialized admission/fence tests; native DB stale-generation/takeover and supplement-reservation/late-ack contracts; C24–C25 uncertain replay. | None beyond G1; no all-provider chaos guarantee. |
| A19 | covered | C21 sparse/reordered/conflicting duplicate and explicit gap handling; E7 native outage replay; E12 sparse native cursor adapter; E14 source cursor/audit reconciliation. Native retention expiry is N/A without deletion. | None beyond G1; no native-retention-expiry claim. |
| A20 | covered | E12/E14 distinct invocation identities and same-receipt replay, unknown-outcome refusal; probe entrypoint/decorated-helper regressions isolate diagnostic execution; E7 retry queues under hold without another provider execution. | None beyond G1. |
| A21 | covered | E8 saved native scrollback after exact session closure; E13 view/navigation/history/browser wiring; E14 exact run/execution/history links after completion. View closure does not confer process ownership. | G4 installed exact-link observation. |
| A22 | covered | E13 representative browser/main interaction and worker input rejection; structured bridge refuses native worker takeover; E19 ordinary interactive main remains usable. | G1 readable worker projection; G4 deployed browser observation. |
| A23 | covered | C04/E6 WAL-aware restore/integrity; E10 revoked restored lease, artifact hashes and overwrite refusal; E15 consistent PostgreSQL17 isolated restore; E16 protected SQLite-aware rollback. External ownership reconciliation remains required. | G3 final release backup/binding and G4 live deployment record. |
| A24 | covered | C03/E7/E14 scoped fixture inventory and cleanup; E11 original 48 pane identities; E16 unrelated default socket preserved; E19 owned sessions/processes closed. No unscoped server/session destruction. | G4 final live before/after inventory. |
| A25 | covered | E6 operation/crash causal chains and explicit omissions; E14 independently reviewed export/241 events/all artifact hashes; E19 truthful failed report and watermark-bounded audit. Process exit does not establish task acceptance. | E21 bounded real outcome passed. |
| A26 | covered | E12 wrong-project/missing/expired/revoked/readonly recovery and active-run adoption; positive renewal extends expiry while preserving scope/authority/worker identity with one effect (31 CLI tests passed); E19 actual renew/hold/takeover traces. | None beyond G1. |
| A27 | release gate | E9 installer mechanics/rollback; E10 local restore; E15 PostgreSQL restore; E16 protected immutable upgrade/rollback; E17 both repositories' passing recorded CI; prepared final pinned installer, persistent native/local worker binding and browser verifier independently reviewed. | G1/G3 premerge final-source binding, then G4 postmerge delivery. |

## Task ledger

The implementation contracts below have reviewed aggregate evidence; they are not left pending merely because the old E1-only ledger was partial. No row claims default-branch integration or release completion. MXP-001 remains the planning baseline; G1–G4 are the concrete shared gates. The second bounded real qualification passes at E21; E19 remains failed history. Shared G1/G3/G4 stay pending.

| Task | Reviewed evidence available | Remaining completion evidence |
| --- | --- | --- |
| MXP-001 | Planning feature commit `5d51474`. | No runtime claim. |
| MXP-002 | E6/E12 native/controller/receiver version, scope, fence/feed/invocation contracts; E17 CI; A08/A18–A20/A26 covered. | G1 final source binding. |
| MXP-003 | E12 negatives; E8 exact transport/privacy; E7 lifetime; E19 actual provider/version/delegated CLI evidence. | E21 bounded qualification passed; G1 final source validation pending. |
| MXP-004 | Actual isolated DB/API/daemon fixtures E7/E14; private real fixture and exact owned cleanup E19. | G1 final pair; G4 delivery preservation. |
| MXP-005 | Native role/scope/generation contracts; E12 project credential and positive renewal; E17 CI. | G1 final source binding. |
| MXP-006 | E3/E6 journal/transactions/artifact failure contracts; E8/E18 privacy; E10 restore. | G1 final source binding. |
| MXP-007 | E12 framing/fingerprint/lifecycle; E7 actual feed/outage; E14 main adoption/inbox continuation. | G1 final source binding. |
| MXP-008 | E6/C05–C25 crash/replay ledger; actual aiohttp stale launch/input/serialized takeover; native fence/supplement reservation tests; E14. | G1 final source binding; no duplicate all-provider matrix. |
| MXP-009 | E12 bootstrap/auth/no-effect/readonly recovery; E9 installed CLI; E19 native bootstrap reconciliation. | G1 final source binding; E21 bounded real outcome passed. |
| MXP-010 | E9 installer/skill validation; E12 adoption/identity; E19 natural main plan and continuation; reviewed usability correction. | G1 skill/mirror delta validation; E21 bounded real outcome passed. |
| MXP-011 | E12 stage/acceptance pins; native hold/Backlog/cancelled prerequisite admission; E14 and E19 actual staged continuation. | E21 bounded real outcome passed; G1 final source binding. |
| MXP-012 | Native exact worktrees plus C01–C03/E12/E13 associations/dirty preservation; E14/E19 real Git staged sources. | G1 final source binding; E21 bounded real outcome passed. |
| MXP-013 | Exact bridge/lifetime/input/privacy contracts E7/E8/E12/E13; E14/E19 native invocations. | G1 readable-mirror validation; E21 bounded qualification passed. |
| MXP-014 | E6 immutable artifact/missing evidence; E12 latest-run acceptance; E14 goal handoff; E19 two accepted real sources. | E21 bounded real outcome passed. |
| MXP-015 | C03/E12 main recovery/lease/adoption; E14 same active attempts after actual main loss with generation fencing. | G1 final source binding; E21 bounded real outcome passed; final G1/G3/G4 pending. |
| MXP-016 | Native human/coordinator supplement/actor/race contracts; feed replay/decision C22–C23; E14 timeline delivery; E17. | G1 final source binding. |
| MXP-017 | E12 exact-run controls; native authority/late-ack serialization; E7 held retry and E19 factual cancelled cleanup. | G1 final source binding. |
| MXP-018 | Native durable actor/scoped feed contracts; E7 replay; C21 gaps; E12 sparse cursors; E14/E17. | G1 final source binding; expiry is N/A without deletion. |
| MXP-019 | E13 representative identity/navigation/history/input browser checks; native link/schema/attribution suites; E14 associations. | G1 final source binding; G4 installed exact-link observation. |
| MXP-020 | C01–C02/E12 full source range and receipt recovery; E14 goal closure; E19 exact real integration/verifier base. | E21 bounded real outcome passed. |
| MXP-021 | E3/E6 failure/causal/export contracts; E8/E18 privacy; E14 complete reviewed fake audit; E19 truthful bounded failed audit. | E21 bounded real outcome passed; G1 final source binding. |
| MXP-022 | E10/E12 archive/revoke/reconcile; E15 isolated PostgreSQL restore; E16 protected rollback; E19 owned cleanup. | G3 final release binding/backup and G4 live preservation. |
| MXP-023 | E6/C05–C25 faults; E7 actual API/daemon death; actual aiohttp takeover; native admission/supplement races and scope tests. | G1 final source binding; exercised boundaries documented, not all-provider/power-loss claims. |
| MXP-024 | Aggregate A01–A26 contracts above; E13 representative browsers; E14 paired fake; E17 recorded CI; E19 real partial outcome. | G1 affected final checks and E21 bounded real outcome passed; G4 deployed UI belongs to delivery. |
| MXP-025 | E9/E10 install/restore; E15 PostgreSQL rehearsal; E16 protected immutable upgrade/rollback; frozen final installer/units reviewed. | G3 exact final pin/artifact/backup binding; no live deployment before source gate. |
| MXP-026 | E11 existing-live preservation, reviewed source evidence and explicitly unqualified E19. | G1–G3 before default merges, then G4 scoped live delivery and final timeline. |

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
baseline proof establishing those failures as pre-existing. This historical handoff precedes E14 paired protocol evidence and E17 final fork CI. This historical handoff is superseded for bounded real qualification by E21; complete deployed browser walkthrough remains G4. Package runtimes above exclude command setup.

## Remaining qualification and release gates

- **G1 — Final source validation:** bind the reviewed readable mirror/usability and semantic credential corrections to the integrated source, run their affected checks, record the final Muxdeck/Multica commits and passing required CI. Existing aggregate contracts do not require duplicate new suites; broaden only for a changed dependency or unresolved failure.
- **G2 — Real outcome: PASS within the exercised pairing.** E21 supplies accepted verifier handoff, final goal checks, requested private draft PR with verified head/base and a complete settled audit. E19 remains failed history; its original artifacts and cap accounting are preserved. Independent final review passed and is recorded separately.
- **G3 — Premerge release binding:** bind staged binaries/frontend/config/persistent native+local runtime profile to the final reviewed pair, preserve source/artifact equality evidence for reused builds, retain a fresh consistent backup after owned worker drain, and retain the install/upgrade/restore/rollback rehearsal bundle. Rehearsals E9/E10/E15/E16 pass within their stated boundaries.
- **G4 — Postmerge delivery:** after G1–G3 and authorized default merges, install the immutable releases, run shared deployment checks and protected browser Basic+inner-cookie/API/WebSocket/exact-terminal-link verification, compare live unrelated-session/state inventory, and attach final timeline/GitHub timestamps. Prepared verifier source is not deployed browser success.

Actual receiver delay/takeover, native role/actor/feed contracts, positive active-run renewal, representative terminal browsers and isolated backup/rollback are established aggregate evidence, not still-unclosed duplicate tests. Native retention expiry is N/A without deletion; host/storage power-loss, tamperproof logging, all-language intent resolution, all-provider fault behavior and unavailable provider-native retention are not claimed. The protocol fake demo and bounded real qualification pass; complete-v1 delivery remains pending on G1, G3 and G4.

Private timeline: `/tmp/muxpilot-implementation-timeline.jsonl`. The lead adds the final timeline report and GitHub job timestamps after final validation.

## Durable acceptance and installation record

The planned [durable delivery report](/root/.local/state/muxdeck/deployments/20261001T015644Z-muxpilot/DELIVERY.md) is the durable release record. Named evidence is retained beneath that deployment directory with an original-path→retained-path/hash manifest; existing `/tmp` references are provenance, not the sole retention location. Reports and settled audit artifacts retain their original bytes and hashes; credential/config/auth files are excluded. The lead closes G1/G3/G4 in that report only after final CI, source/artifact binding and live checks pass, avoiding recursive source restaging solely to record postmerge checks.
