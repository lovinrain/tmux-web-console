# Muxpilot implementation evidence

Implementation is a candidate under validation on the paired `feat/muxpilot` branches. The [scenario/task ledger](EVIDENCE.md) records exact evidence and unclosed gates. This file
tracks evidence; it does not replace the acceptance gate in [ACCEPTANCE.md](ACCEPTANCE.md).

The Muxdeck integration worktree is `/root/tmux-web-console-worktrees/muxpilot`.
The paired Multica worktree is `/root/git_farm/multica-muxpilot`, based on
`e31da86c90794b5c488279a3ead13ac2f31ac269`, with writable fork
`lovinrain/multica` and the original upstream preserved. Muxdeck's default branch
is `master`; the Multica fork's default is `main`.

The development team uses GPT-6.1-sol. Closely coupled Muxdeck components have
disjoint file ownership in the isolated feature worktree, with the lead owning
integration and commits. Multica has a separate isolated feature worktree.
Neither feature branch is the running Muxdeck checkout.

| Component | Implementation owner | Evidence before release |
| --- | --- | --- |
| SQLite journal, operation receipts, leases, artifacts, audit, backup | Core lane | Transaction, crash, integrity, deduplication and restore tests |
| Private project service | Service lane | Peer/credential boundaries, framing, lifecycle and restart tests |
| CLI, main coordination, Multica adapter and integration | Controller lane | Scoped command contracts and real Git integration evidence |
| Daemon-owned workers, worktrees and structured output | Runtime lane | Isolated tmux/provider protocol, ownership and capture tests |
| Execution-time fencing | Receiver lane | Delayed stale requests, takeover serialization and uncertain receipts |
| Multica authorization, stages, event feed and UI | Multica lanes | PostgreSQL transaction/admission tests, UI and paired daemon checks |
| Exact terminal/history navigation | Terminal lane | Backend identity checks and browser navigation scenarios |
| Natural-language activation and human guide | Operator lane | Installed skill/launcher and temporary installation checks |
| Cross-component faults and delivery | Validation and lead lanes | Paired scenario report, independent review, CI and deployment preservation |

Private command evidence is recorded in
`/tmp/muxpilot-implementation-timeline.jsonl`. The original live deployment
baseline is `/tmp/muxpilot-deployment/before.json`; it records 48 panes. Release
verification must compare against this baseline, preserving session identities
and attributing independent user activity explicitly.

Real-provider qualification remains separately gated by Multica's repository
instructions. Synthetic tests cannot establish account-specific provider
compatibility. The final evidence ledger must distinguish those results.

Candidate evidence: the actual three-worker paired fake-provider scenario, native API/daemon fault drill, native privacy checks, Multica CI and isolated restore/rollback rehearsals pass within their recorded scope. The bounded natural-main real Codex qualification now passes (E21), including three completed workers, verified goal closure and the requested private draft PR. Final source CI, release binding and live deployment remain pending. See [EVIDENCE.md](EVIDENCE.md).

The planned [durable delivery report](/root/.local/state/muxdeck/deployments/20261001T015644Z-muxpilot/DELIVERY.md) retains the final source/artifact pair, acceptance evidence and operational gate results. G1, G3 and G4 close there only when their checks actually pass; this candidate document does not claim an installation.
