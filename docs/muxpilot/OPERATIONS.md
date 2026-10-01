# Muxpilot operations

Read [the full deployment runbook](../../AGENT_DEPLOYMENT_GUIDE.md) before any
deployment, migration, service, archive, upgrade, or rollback action. Routine
installation preserves the existing tmux server, sessions, and authentication
boundary. No instruction here authorizes killing sessions, restarting tmux,
or exposing the console publicly.

## One-time installation

Use a validated Muxdeck release containing `muxpilot/`, a Python 3.11+ environment
with the release dependencies, and the compatible Multica installation. The
Muxdeck service, Multica daemon, and bridge must run locally as the intended
tmux owner, with access to the same worktree paths. Existing healthy instances
are reused; the installer neither starts nor restarts them.

Obtain the actual Multica workspace ID and URL slug, the selected daemon and
custom runtime-profile IDs, its private human bootstrap PAT file, and the
existing Muxdeck control-token file. Keep token values outside commands,
Git, task descriptions, and reports. The human token bootstraps a scoped
coordinator; workers must not receive it or the broad Muxdeck control credential.
Provision Muxdeck control access using the deployment runbook's trusted
controller procedure when needed. Authenticate Codex through its supported
login flow; `codex login status` is a read-only check, and `codex login` is
interactive. Installing a skill does not authenticate the provider.

Review an installation inventory first, substituting your actual paths, URLs,
and workspace ID:

```bash
python3 scripts/install_muxpilot.py \
  --python /absolute/muxdeck/.venv/bin/python \
  --multica-url http://127.0.0.1:7331 \
  --multica-workspace-id ACTUAL_WORKSPACE_ID \
  --multica-workspace-slug ACTUAL_WORKSPACE_SLUG \
  --multica-ui-url https://console.example.test/multica/ \
  --multica-token-file /absolute/private/multica-pat \
  --runtime-profile-id ACTUAL_RUNTIME_PROFILE_ID \
  --daemon-id ACTUAL_DAEMON_ID \
  --qualification-file /absolute/private/verified-provider-smoke.json \
  --muxdeck-url http://127.0.0.1:7683/mux \
  --muxdeck-public-url https://console.example.test/mux \
  --muxdeck-token-file /absolute/private/control-token \
  --multica-api-service muxpilot-multica-api.service \
  --multica-web-service muxpilot-multica-web.service \
  --multica-daemon-service muxpilot-multica-daemon.service \
  --dry-run
```

Run the same command without `--dry-run` to install. The JSON result lists every
changed file, the precise command path, and the next check. It installs:

- `~/.local/bin/muxpilot`, bound to this release's Python and source directory;
- `~/.agents/skills/muxpilot/SKILL.md` with local command/configuration bindings
  and copies of the user, operations, and deployment guides;
- `~/.config/muxpilot/config.json`, referring to existing credential files;
- the private project-state root, respecting `XDG_STATE_HOME`.

New skill/config/state directories are `0700`; installed private files are
`0600` and the executable wrapper is `0700`. The installer refuses insecure
existing private directories, symlinked targets, and unmanaged or edited files.
It never prints credential contents. Use `--bin-dir`, `--skills-dir`, `--config`,
or `--state-root` to select another installation root. `--legacy-skills-dir`
optionally installs the same skill into an older local catalog such as
`~/.codex/skills`; it does not modify `~/.codex/config.toml`.

The runtime profile and daemon must support the recorded local repository and
worktree isolation. Browser URLs refer to existing protected routes, while
`multica_url` and `muxdeck_url` select authenticated control endpoints. The
workspace slug is required to form actual Multica board links; IDs alone are
not interchangeable URL slugs. Browser URLs may include a deployment path prefix, such as
`https://console.example.test/multica/`; generated project links retain it.
Keep `multica_url` pointed at the actual loopback API origin (this installation
uses `http://127.0.0.1:18230`; `7331` above is an example port), independently of
the public browser URL. Installing these values creates no public route.

Muxdeck's same-host receiver journal root must match `config.state_root`.
For a custom root, set the Muxdeck service's `MUXPILOT_STATE_ROOT` to that exact
absolute root during the validated deployment. The installer reports the needed
environment value and does not edit the service itself. An isolated restored
root likewise needs a matching isolated receiver; an existing live receiver
cannot silently be repointed as part of a restore.

Run the exact `next_check` returned by installation (`muxpilot doctor` when
the wrapper's directory is on PATH). It checks the authenticated service
capabilities and reports `service_ready`, `provider_qualified`, and overall
`ready` separately. Missing credentials or required capabilities prevent project
mutation. Installed executable versions alone are not a provider capability
proof. `qualification_file` references the retained private record of an actual
authorized provider smoke for the configured runtime profile; the installer
never creates or upgrades such evidence. Until that record is valid, provider
qualification remains pending. Keep the record's exact executable/version,
tested scope, and source-pair evidence; a fabricated `passed` flag is not a test.

The optional `--multica-api-service`, `--multica-web-service`, and
`--multica-daemon-service` flags name already-installed owned dependency units.
Use their actual names; the examples assume those three units exist. Select
`--service-manager user` for user units. The installed skill receives exact
status/start commands. On availability failure, the main verifies the configured
units, reuses active ones, starts inactive ones, and rechecks readiness itself.
Bootstrap does not stop or restart services. The installer creates no service
units and executes none of those commands. Missing credentials or capabilities
require the corresponding setup; restarting a healthy service cannot fix them.

Start a fresh Codex session with the configured model in a visible main terminal.
`muxpilot main --repo ~/git_farm/shop --goal 'Add password reset end to end, and
open a PR when it is tested.'` creates a visible main and returns its terminal
link for an explicit handoff when the requesting conversation has no usable
tmux session. Stop coordinating in the prior conversation after that handoff.
For an existing intended tmux terminal, an ordinary launch is:

```bash
codex --model gpt-6.1-sol --cd ~/git_farm/shop
```

Then use the prompt in [the user guide](USER_GUIDE.md). The default main model
request is `gpt-6.1-sol`; account/model access and worker protocol capabilities
must be measured for the actual installation. No flags disable the human's
existing approval or sandbox policy during installation.

[Official OpenAI skill documentation](https://developers.openai.com/codex/skills/)
documents user skill discovery at `~/.agents/skills`. Newly installed skills
are normally discovered automatically; if Muxpilot is missing, start a new
session. Changing configuration may also require the provider's supported
reload/restart. This is not a claim that an arbitrary active conversation can
hot-load tools. The CLI's model option is documented in the
[official reference](https://developers.openai.com/codex/cli/reference/).

## Diagnostic commands and lifetimes

The human's normal interface is the main conversation. These commands are
available for operators and installed agent tools; `project` may precede the
project commands, and `muxdeckctl project` provides the same command surface.
Use the installed wrapper to retain its selected private configuration.

| Command | Operational meaning |
| --- | --- |
| `doctor` | Read-only service/auth/capability readiness diagnostics |
| `start --repo PATH --goal TEXT` | Bind the actual main and resolve/create one project; repeat startup reconciles identity |
| `main --repo PATH --goal TEXT` | Explicitly launch one visible main when there is no existing usable main terminal |
| `status PROJECT` | Current authoritative observations plus local evidence/staleness |
| `agents PROJECT` | Approved project roster for selecting configured worker identities |
| `plan PROJECT --file FILE` | Record completion criteria and staged Multica tasks |
| `activate PROJECT --stage N --base SHA` | Dispatch an eligible batch from its verified baseline within its worker limit |
| `events PROJECT --after N --wait 30` | Bounded event wait; does not acknowledge decisions |
| `decision PROJECT --message TEXT --ack N` | Record a decision and acknowledge its processed cursor |
| `renew PROJECT` / `revoke PROJECT` | Renew/revoke project authority without treating that as worker cancellation |
| `hold PROJECT` / `hold PROJECT --off` | Hold/release new dispatch; active runs retain their lifetime |
| `control PROJECT --task TASK --run RUN --action ACTION` | Capability-aware exact-run instruction, supplement, inspect, cancel, or continue |
| `resume PROJECT --owner ID` | Acquire/reconcile main ownership before further mutations |
| `integrate PROJECT --commit SHA` | Apply accepted worker changes to the owned integration checkout |
| `accept PROJECT --issue TASK --evidence FILE` | Record inspected passing task evidence and accept its authoritative task |
| `close PROJECT --evidence FILE` | Verify recorded goal/delivery evidence before closure |
| `audit PROJECT --destination PATH` | Export bounded local/backend evidence to a new private destination |
| `backup PROJECT --destination PATH` | Create a SQLite-aware consistent backup with referenced artifacts |
| `restore --backup PATH --destination ISOLATED_STATE` | Operator-only restore into a separate private root; reconcile before further effects |
| `archive PROJECT` | Hold dispatch and mark local archive state while preserving workers, sessions, and worktrees |
| `remap PROJECT --repo PATH --reason TEXT` | Deliberately rebind a moved repository only without active runs or uncertain operations |
| `operation PROJECT --kind KIND --payload FILE --operation-id UUID` | Admit a durable intent before an authorized external effect; `--receipt FILE` confirms its actual result |

Project arguments can be an actual returned project ID or its registered
repository path. Use `--help` on a command for its current schema and supported
options. Do not infer worker/run IDs from tab titles. An instruction receipt
proves only its stated delivery stage. A timeout or lost reply remains uncertain
until reconciled with its original operation ID; never invent a new operation
or worker to make an uncertain action disappear.

Projectd is separate from the web console. Its private Unix socket and journal
are service-managed; restarting the web console is not a coordinator restart.
The main, project service, and Multica daemon have distinct lifetimes. Browser
disconnect and tab closure preserve worker ownership. The daemon owns structured
worker stdio; losing that controller can terminate its bridge provider. Neither
viewing nor archive is implicit process cancellation.

The active coordinator renews its project lease before expiry, including while
waiting for events. Closure requires the exact integrated `revision`, all plan
`completion_criteria`, nonempty passing `checks` with commands and matching
revisions, and a `deliverable` with its kind/revision and actual PR URL when
applicable. Task evidence also names its latest successful actual `run_id`;
explicitly coordinator-owned tasks use `coordinator_owned: true`. PR closure
names the confirmed `publish.pr` operation, whose receipt matches the URL and
revision. A prior pending external publication requires authoritative lookup
and receipt reconciliation, never blindly repeating `gh pr create`.

## Recovery, state, and coverage

Default state is `$XDG_STATE_HOME/muxdeck/projects`, or
`~/.local/state/muxdeck/projects`, with project UUID directories containing
`journal.sqlite3` and referenced private artifacts. The journal is the local
operation/audit authority; Multica remains authoritative for tasks and runs.
Provider-native history has its own retention and may contain inputs outside
Muxpilot's capture. Exports state capture coverage, staleness, uncertainty,
and missing/corrupt evidence. This same-user store is not a tamper-proof ledger
or hostile-worker isolation boundary.

The supported Codex worker bridge enforces `--disable multi_agent`, rejects
flags/configuration enabling that feature, and records its helper-control
evidence. Substantial delegation therefore uses visible managed workers. A
deterministic helper still needs a bounded input/output and recorded coverage;
unavailable native helper history remains explicit. Feature control is not an
operating-system sandbox against a hostile process sharing the same Unix user.

On main loss, resume the existing project and inspect ownership, active runs,
uncertain operations, and session identities before dispatch. Do not use
`--takeover` unless replacing the old coordinator is authorized. A fresh owner
generation fences the old main; stale requests must not bypass that fence.
On daemon loss, inspect actual authoritative outcomes and retained worktrees;
some providers may have stopped. On backend loss, use local evidence with its
staleness marker and stop dependent mutations. A session name reused by a new
process never establishes ownership of the previous run.

Create backups with the supported command, never by copying an active WAL
database alone. Retain the backup manifest, referenced artifact hashes, paired
release versions, and private configuration separately from credentials.
Use `restore --backup PATH --destination ISOLATED_STATE`, validate journal schema
and artifacts, then use `--state-root ISOLATED_STATE resume PROJECT` with operator
authority to reconcile with Multica before control or launch. The isolated
receiver root must match as described above. Do not overwrite current backend
truth or current launch-request fences with an older backup. Copying SQLite
files is not a supported substitute for that procedure. Archive preserves
resources and holds dispatch; it does not stop workers or authorize deletion.

## Upgrade and rollback

Follow the full deployment runbook and `ACCEPTANCE.md` for paired release gates.
Record both repository SHAs, API/event schema versions, provider executable and
version, runtime profile, and tested capability set. A fake-provider demo is
labeled synthetic; a required real-provider gate remains incomplete without
authorized evidence. Disable new dispatch before an incompatible change and
retain the actual running-worker policy.

Install a validated release into a separate directory, keep the old release,
and back up project/Multica state before migrations. Review the installer's
`--dry-run --replace --reuse-config` inventory to update unedited managed skill
and wrapper files while retaining the current configuration. A manually edited
file is preserved and reported for deliberate reconciliation.

Build frontend assets in staging, use `scripts/check_deployment.py` for baseline
and post-change reports, and record task-specific migration and recovery
evidence. Restart only the validated services that need it, after the runbook's
tmux cgroup/KillMode checks. The installer itself needs no service restart.

Rollback retains current ownership and duplicate-launch fences, points tools
back to the compatible retained release pair, and reconciles live runs. Never
downgrade a database version in place or restore older fences over newer ones.
Cleanup first reports owned resources and preserves live sessions and worktrees
by default; it is not a broad directory deletion or a tmux-server kill.

Muxpilot is built on [Multica](https://github.com/multica-ai/multica). Preserve
its source/license notices, product attribution, and existing board UI. The
intended deployment is private local use; public hosting is a separate scope.
