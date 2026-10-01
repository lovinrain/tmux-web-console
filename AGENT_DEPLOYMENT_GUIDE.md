# Muxdeck Agent Deployment Guide

This is the primary runbook for an agent deploying an archived copy of Muxdeck
on another machine. Read it completely before changing the target. The normal
deployment is Linux + systemd + Caddy, with Muxdeck bound to loopback and served
under `/mux/`.

This guide is operationally reproducible, not bit-for-bit hermetic: the frontend
is locked by `package-lock.json`, while Python currently allows compatible
`aiohttp` releases in the range declared by `pyproject.toml`.

## 1. Non-negotiable rules

1. Muxdeck must run as the same Unix user that owns the tmux server it controls.
   A different user normally sees a different tmux socket.
2. Never restart tmux, run plain `tmux kill-server`, kill a real session, or send
   validation input to a valuable Claude/Codex pane.
3. Never install `deploy/muxdeck.service.template` without rendering every
   `@@TOKEN@@` first.
4. Never reuse an archived `.venv` or `node_modules`; both contain
   machine/path-specific artifacts. Create them again on the target.
5. Keep `MUXDECK_HOST=127.0.0.1`. Remote access should go through a trusted
   tunnel, VPN, or authenticated/restricted reverse proxy.
6. Set `MUXDECK_AUTH_MODE` explicitly. Use `server` for the persistent Muxdeck
   login, `basic` for browser-managed HTTP Basic authentication, or `none` only
   behind an intentional separate trust boundary. Anyone who reaches a `none`
   instance can type into shells with the tmux owner's privileges. Do not create
   an unprotected public route. Protected modes require a valid private
   `MUXDECK_AUTH_FILE` and must fail startup closed when it is unavailable.
7. Preserve an existing release, unit, proxy configuration, and state files
   until the replacement passes all validation gates.
8. Restart only `muxdeck.service` during a normal deployment. Validate Caddy
   before reloading it. Do not restart Caddy when a reload is sufficient.
9. Before restarting Muxdeck, prove the restart cannot take tmux with it: confirm
   `systemctl show muxdeck -p KillMode` reports `process`, and that no tmux server
   appears under `systemctl status muxdeck`. A frontend-only change needs no
   restart - rebuild `dist/` instead. See section 13.

Stop and ask the human if the tmux owner, socket, public exposure, base path, or
state-migration intent cannot be established safely.

## 2. Architecture and archive boundaries

```text
browser
  -> HTTPS reverse proxy or private tunnel
  -> 127.0.0.1:7683
  -> aiohttp API / SSE / WebSocket / built frontend
  -> tmux CLI and a short-lived attach client
  -> tmux server owned by the service user
```

The source archive should contain at least:

```text
AGENT_DEPLOYMENT_GUIDE.md
README.md
deploy/
e2e/
src/
scripts/
tests/
tmux_console/
index.html
package.json
package-lock.json
playwright.config.ts
pyproject.toml
tsconfig.json
vite.config.ts
```

Do not rely on these copied/generated directories:

```text
.venv/
node_modules/
dist/
*.egg-info/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.benchmarks/
artifacts/
test-results/
playwright-report/
```

`dist/` may be included as a convenience artifact, but a source deployment
must rebuild it on the target. An archive of this folder does not include:

- the target machine's tmux server, sessions, or agent processes;
- titles, predefined session tags, starred/ignored session names, memoranda, the
  snippet library, saved workspaces and their named pane layouts, callback
  lists, shortcut
  keymap, authentication state, and uploaded attachments stored outside the
  source folder;
- the SQLite session-recovery registry, including saved CWDs and reference-only
  coding-agent IDs, the separate persistent callback-message database, and the
  persistent launch-request receipt database;
- browser-local staged drafts and dashboard preferences;
- in-memory history snapshots or agent-state transition timestamps.

Create a transfer archive from a reviewed commit rather than archiving the
working directory. `git archive` includes only tracked files from that commit,
so ignored or untracked environment files, rendered configuration, runtime
state, and credentials cannot slip into the archive:

```bash
cd /absolute/path/to/tmux-web-console
git status --short
git archive --format=tar.gz --output=../muxdeck-source.tar.gz HEAD
tar -tzf ../muxdeck-source.tar.gz
sha256sum ../muxdeck-source.tar.gz > ../muxdeck-source.tar.gz.sha256
```

Review any status output before choosing the commit to archive. Inspect the
archive listing, transfer the checksum with the archive, and verify it before
extraction.

## 3. Deployment facts worksheet

Discover or obtain these values before installing anything. Use task-specific
shell variables; do not repurpose `HOME` or another standard environment name.

| Fact | Recommended/default | Notes |
| --- | --- | --- |
| Deployment type | fresh or replacement | A replacement requires backups and rollback data. |
| App directory | `/opt/muxdeck` or tmux owner's home | Must be absolute, traversable by the run user, and contain no whitespace. Never put a non-root service under `/root`. |
| Run user/group | target tmux owner | Must list the intended sessions using the same tmux command/socket. |
| Python | 3.11+ | Needs venv/pip support. |
| Node | `^20.19.0` or `>=22.12.0` | Node is needed to build, not to run after build. |
| tmux | 3.x | 3.2+ enables Grok startup appearance hints; `xterm-256color` terminfo must exist. |
| Base path | `/mux` | No trailing slash at runtime; build value is `/mux/`. |
| Loopback port | `7683` | Must not conflict with an unrelated service. |
| State directory | `/var/lib/muxdeck` | Explicit, persistent, mode `0700`, owned by the run user; contains six JSON files, SQLite recovery and callback databases, and private uploaded attachments. |
| Authentication mode | `server` | Use `basic` only when browser-managed credentials are intended; use `none` only behind another explicit trust boundary. |
| Application login | required for `server` or `basic` | Provision interactively; never put a plaintext password in source, a unit, an environment file, or command-line arguments. |
| tmux socket | default or `-L NAME` | `MUXDECK_TMUX_SOCKET` is a name, never a filesystem path. |
| `TMUX_TMPDIR` | usually unset | If the real server uses it, reproduce it in the service. |
| Public host | optional | Must be protected by a VPN, trusted network, tunnel, or proxy access control. |
| Browser origins | empty for loopback-only | Exact external `http://` or `https://` origins, comma-separated; required for a reverse proxy. |
| Proxy | Caddy, existing proxy, or none | Proxy must preserve the base path and support WebSocket + streaming SSE. |
| State migration | yes/no | Runtime JSON files, the SQLite recovery registry, and uploaded attachments are separate from the source archive. |

A useful working set is:

```bash
MUXDEPLOY_APP_DIR=/opt/muxdeck
MUXDEPLOY_RUN_USER=replace_me
MUXDEPLOY_RUN_GROUP=replace_me
MUXDEPLOY_BASE_PATH=/mux
MUXDEPLOY_PORT=7683
MUXDEPLOY_TRUSTED_ORIGINS=
MUXDEPLOY_STATE_DIR=/var/lib/muxdeck
MUXDEPLOY_TMUX_BIN=/usr/bin/tmux
MUXDEPLOY_TMUX_SOCKET_NAME=
MUXDEPLOY_AUTH_MODE=server
MUXDEPLOY_AUTH_USERNAME=replace_me
```

Before using these variables in `sed` or a unit, ensure usernames contain only
normal account characters and paths contain only letters, digits, `_`, `-`,
`.`, and `/`. The base path must begin with `/`, must not end with `/`, and the
provided Caddy template expects a non-root path such as `/mux`.

Reject any authentication mode other than the three exact launch values:

```bash
case "$MUXDEPLOY_AUTH_MODE" in
  server|basic|none) ;;
  *) echo 'Invalid MUXDEPLOY_AUTH_MODE' >&2; exit 1 ;;
esac
```

`MUXDEPLOY_TRUSTED_ORIGINS` is not an authentication setting. It prevents
cross-site browser requests and DNS rebinding by listing the exact public origins
allowed to reach Muxdeck. Each entry is only a scheme and authority, with no path,
query, fragment, credentials, or wildcard. For example, a Caddy deployment at
`https://console.example.test/mux/` uses
`https://console.example.test`. Multiple origins are comma-separated. Leave the
value empty only when browsers connect through loopback (`localhost`, `127.0.0.1`,
or `::1`); any non-loopback Host is rejected unless its origin is listed. Before
rendering, reject origin values containing whitespace, newlines, `&`, `|`, or
backslashes so they cannot alter the `sed` expression or systemd environment.

## 4. Read-only target preflight

### 4.1 Verify the archive

```bash
cd "$MUXDEPLOY_APP_DIR"
test -f AGENT_DEPLOYMENT_GUIDE.md
test -f pyproject.toml
test -f package-lock.json
test -d tmux_console
test -d src
test -f deploy/muxdeck.service.template
test -f deploy/Caddyfile.snippet.template
```

If an archive checksum exists, verify it before extracting. Do not unpack a new
archive over a running release; stage a separate directory for replacements.

### 4.2 Verify tool versions

```bash
python3 --version
node --version
npm --version
tmux -V
infocmp xterm-256color >/dev/null
command -v tmux
```

Debian/Ubuntu runtime packages normally include `python3`, `python3-venv`,
`python3-pip`, `tmux`, `ncurses-term`, `curl`, and `ca-certificates`. Build-time
aiohttp may also need a compiler and Python headers when no wheel exists. Install
Node from an approved source if the distribution version does not satisfy
Vite's requirement. Caddy is optional unless this guide's HTTPS proxy flow is
used.

Do not pipe an unreviewed network script into a root shell to install Node or
Caddy. Use the target's approved package repository or version manager.

### 4.3 Prove tmux identity

Run the checks as the proposed service user (use `sudo -u`, `runuser`, or the
platform equivalent). For the default socket:

```bash
sudo -u "$MUXDEPLOY_RUN_USER" -- "$MUXDEPLOY_TMUX_BIN" list-sessions \
  -F '#{session_name}=#{session_id}'
sudo -u "$MUXDEPLOY_RUN_USER" -- "$MUXDEPLOY_TMUX_BIN" display-message \
  -p '#{socket_path}'
```

For a server started with `tmux -L NAME`, include `-L NAME` before each tmux
subcommand:

```bash
sudo -u "$MUXDEPLOY_RUN_USER" -- "$MUXDEPLOY_TMUX_BIN" \
  -L "$MUXDEPLOY_TMUX_SOCKET_NAME" list-sessions \
  -F '#{session_name}=#{session_id}'
```

Record session and pane identities before changing an existing deployment:

```bash
sudo -u "$MUXDEPLOY_RUN_USER" -- "$MUXDEPLOY_TMUX_BIN" list-panes -a \
  -F '#{session_name}=#{session_id}:#{pane_id}:#{pane_pid}:#{pane_current_command}:#{pane_dead}'
```

Add `-L NAME` to that command when applicable. Save the output as deployment
evidence and compare it after service/proxy changes.

Important interpretations:

- `no server running` can mean wrong user, wrong socket, wrong `TMUX_TMPDIR`, or
  genuinely no tmux server;
- zero sessions is not a successful identity check if sessions were expected;
- an explicit `tmux -S /path/to/socket` target is not supported by the current
  `MUXDECK_TMUX_SOCKET` setting; stop and request an application change;
- one Muxdeck process connects to one tmux server/socket.

### 4.4 Inspect an existing deployment

For replacements, collect these before mutation:

```bash
systemctl cat muxdeck.service --no-pager
systemctl show muxdeck.service \
  -p User -p Group -p WorkingDirectory -p Environment -p ExecStart --no-pager
systemctl is-active muxdeck.service
journalctl -u muxdeck.service -n 100 --no-pager
caddy validate --config /etc/caddy/Caddyfile
```

Back up the existing unit, the relevant Caddy configuration, all six state JSON
files, every configured SQLite database (including recovery, callbacks,
submitted messages, scrollback and launch requests), the upload directory when
present, and the old release path. Preserve control and callback credentials
separately as private secrets when automation access is in scope. Stop only Muxdeck or use
SQLite's backup API before copying the database so the backup is consistent. Use
timestamped copies; do not overwrite the only known-good copy. In particular,
retain the pre-upgrade
`session-titles.json` through the rollback window because its schema may be
upgraded by the new release. Also retain the pre-upgrade `workspaces.json`:
the first workspace-state write can upgrade it to schema 14, and a release that
only understands versions 1 through 13 cannot read the upgraded document.

## 5. Build a clean release

The app directory must be readable/traversable by the run user. The state
directory must be writable by that user. On a fresh destination, set ownership
only after resolving and confirming the exact path; never recursively change a
broad directory such as `/`, `/opt`, `/home`, or `/root`.

If `.venv` or `node_modules` arrived in the archive, move them to explicitly
named quarantine paths outside the release or extract a clean archive. Do not
execute copied binaries from them.

From the app directory:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
.venv/bin/python -m pip check
npm ci
VITE_BASE_PATH=/mux/ npm run build
test -f dist/index.html
test -d dist/assets
```

Replace `/mux/` in the build command when using another base path. These three
values must agree exactly:

```text
frontend build: VITE_BASE_PATH=/prefix/
backend runtime: MUXDECK_BASE_PATH=/prefix
proxy match: /prefix and /prefix/*
```

Changing only the runtime variable causes broken asset, API, and WebSocket URLs.

The packaging check must work from outside the source tree:

```bash
cd /
/absolute/path/to/muxdeck/.venv/bin/python -c \
  'import tmux_console; print(tmux_console.__file__)'
cd /absolute/path/to/muxdeck
```

The printed path must point into this release's `tmux_console/` directory.

### Optional source validation

Install the declared development extra when the deployment policy permits:

```bash
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check tmux_console tests
.venv/bin/mypy tmux_console
npm test -- --run
npm run build
```

The Python real-tmux test uses a unique `tmux -L` server and cleans only that
disposable server. Never edit it to use the default socket.

Browser E2E is optional for deployment and requires a Chromium browser. Either
install Playwright's browser or point at an approved existing executable:

```bash
npx playwright install chromium
npm run test:e2e
```

or:

```bash
MUXDECK_PLAYWRIGHT_BROWSER=/absolute/path/to/chrome npm run test:e2e
```

The Playwright configuration uses the project `.venv` when present and creates
a unique disposable tmux socket plus title, memorandum, snippet, workspace,
shortcut, session-registry, authentication, and attachment-upload state paths
per run. Do not run browser
validation against valuable target sessions, and do not remove those state-path
overrides.

## 6. Optional runtime-state migration

The default source paths are under the old service user's state directory:

```text
~/.local/state/muxdeck/session-titles.json
~/.local/state/muxdeck/session-messages.json
~/.local/state/muxdeck/snippets.json
~/.local/state/muxdeck/workspaces.json
~/.local/state/muxdeck/shortcuts.json
~/.local/state/muxdeck/auth.json
~/.local/state/muxdeck/sessions.sqlite3
~/.local/state/muxdeck/callbacks.sqlite3
~/.local/state/muxdeck/launch-requests.sqlite3
~/.local/state/muxdeck/uploads/
```

The first file contains titles, predefined tags, and starred and ignored session
names. The
second contains memoranda and may include sensitive commands or prose. The third
contains the global folder/snippet tree and may also contain sensitive commands
or prose. The fourth contains saved workspace names, ordered tmux session names,
workspace-local parent/child tab relationships,
tab-group names/colors/membership, named pane layouts and their session
assignments/split ratios, common, workspace-specific, and session-specific quick
links, Common/Workspace/Session notes, global session pins and their
per-workspace inherited-membership provenance, and activity times.
Notes may contain sensitive commands or prose. The upload directory contains
arbitrary files attached from the desktop console; it is capped at 512 MiB by
the application but has no automatic deletion policy. Attachments may be
sensitive and remain after their path is pasted, sent, or cleared from a draft.
The fifth file contains the global desktop keymap shared by every browser. The
sixth file contains the salted login password hash and hashes of remembered
browser tokens. It is security-sensitive even though it contains neither the
plaintext password nor bearer tokens. Keep it mode `0600`, never include it in a
source archive, and do not print its contents in deployment evidence.
The SQLite database contains stable Muxdeck session IDs, native tmux names,
working directories, last-seen tmux identities, and optional passively detected
coding-agent types and IDs. The latter are reference metadata only; migration
does not resume an agent. Treat the whole database as sensitive and keep it mode
`0600`.
An existing unit may override any path; inspect its environment rather than
assuming defaults.

Submitted-message history uses a separate private `submitted-messages.sqlite3`
archive beside the configured recovery registry, overridden by
`MUXDECK_SUBMITTED_MESSAGES_FILE`. It contains submitted Claude Code/Codex input
text and uses schema version 1, with no change to the recovery or workspace
schemas. Back it up consistently with SQLite's backup API alongside
`sessions.sqlite3`, include it in private state migrations, and retain it during
rollback; older code ignores the separate archive. Do not include it in source
archives or print its contents in deployment evidence. Native agent history is
read only. See [Submitted messages](docs/SUBMITTED_MESSAGES.md) for source paths,
capture limits, and history-file overrides for isolated installations and tests.

Saved beginning and recent output uses a separate private `scrollback.sqlite3`
archive beside the recovery registry, overridden by `MUXDECK_SCROLLBACK_FILE`.
It uses schema version 1 and mode `0600`. Back it up with SQLite's backup API
alongside the recovery and submitted-message databases, include it in private
state migrations, and retain it during rollback; older code ignores it. This
does not change any existing state schema. Never include its terminal text in
source archives or deployment evidence. Output recording begins with the first
available capture after installation and cannot recover previously lost output.
See [Saved scrollback](docs/SCROLLBACK.md) for sampling, bounds, and limitations.

The separate `callbacks.sqlite3` file stores agent-posted callback messages,
reported session/agent/CWD metadata, receipt times, idempotency keys, and review
history, shared custom callback group names and memberships, and manual on-hold
session markers. It uses schema version 3 and does not alter workspace or recovery
schemas. Versions 1 and 2 upgrade transactionally at startup, preserving all
reports, review history, and existing groups. Version 1 gains the group tables and
their independent revision; version 3 adds the hold table, with changes fenced by
the callback-message revision. Keep a consistent pre-upgrade backup: older
releases reject version 3. To roll back, stop only
Muxdeck, retain the upgraded database separately, and restore the pre-upgrade
database alongside the older code. Never downgrade `user_version` in place.
`MUXDECK_CALLBACKS_FILE` overrides its path; otherwise it lives beside
the configured workspace file. Back it up using SQLite's backup API alongside
the recovery registry, migrate it as a private `0600` file, and retain it during
rollback even when the older release does not display messages. The callback
token file described in section 13 is a separate secret: migrate it privately
only when agent callback access should carry over.

Programmatic launch idempotency uses a separate private
`launch-requests.sqlite3`, overridden by `MUXDECK_LAUNCH_REQUESTS_FILE`, beside
the configured recovery registry. Schema version 1 stores request fingerprints,
reservations and creation receipts, not the original argument vector or
environment overlay. Back it up with SQLite's backup API alongside the other
databases, migrate it as a private `0600` file, and retain it during rollback.
Deleting or replacing it with an older copy can permit a previously submitted
request ID to launch again. An interrupted pending reservation deliberately
returns an uncertain `409`; inspect the tmux inventory and controller evidence
instead of deleting the reservation or blindly creating a new attempt.
This feature does not change workspace or session-registry schemas.
All request IDs remain indefinitely, with a 100,000-ID lifetime cap; after
that, new IDs are refused. Do not remove the database as space/capacity cleanup
while prior request retries could occur.

The control-token file described in section 13 is a separate secret. Migrate it
privately only when shell-control access should carry over. Keep it outside
source archives and ordinary evidence; never print its contents. The local
stdio bridge's temporary Unix sockets are not persistent state and must not be
archived or migrated. A bridge invocation is owned by its controller and is
cancelled if that controller disconnects; detached interactive sessions retain
their normal tmux lifetime.

The SQLite registry uses `PRAGMA user_version = 4`. Version 1 upgrades in a
transaction by adding `session_history` and `history_workspaces` and importing
the existing recovery records; the original `sessions` table remains intact.
Version 3 adds the history of observed coding agents. Version 4 adds
`session_origins` and bounded `session_view_events` tables, preserving all
existing records and agent references. Existing origins remain unknown; do not
infer them from names. Native session start times come from tmux's existing
`created` identity field, separately from first-observed timestamps.

Back up `sessions.sqlite3` consistently before a backend upgrade, retain the
private backup, and deploy backend and frontend together. Older releases reject
version 4. Rollback requires stopping only Muxdeck, retaining the upgraded
database separately, and restoring the pre-upgrade database with the old code.
Never downgrade `user_version` in place. Keep the registry private (`0600`).

The workspace file uses schema version 14. Version 1 loads at workspace session
revision zero; versions 1 and 2 load with no tab groups, and versions 1
through 3 load with no common or workspace-specific quick links. Versions 1
through 4 load with no session-specific quick links, versions 1 through 5 load
with empty scoped notes, and versions 1 through 6 load with no global session
pins or inherited-pin provenance. Versions 1 through 7 load with no sidebar
separators. Version 8 preserves after-session separators and loads with no
before-session separators. Version 9 loads with no named pane layouts. A legacy
file upgrades atomically on the next workspace, quick-link, note, global-pin, or
callback-list write. Versions 1 through 10 load with an empty callback list.
Versions 1 through 13 load with no nested tab relationships. Version 14 permits
an optional `parents` mapping from child session to parent session; both must be
workspace tabs and the links must be acyclic. Removing a parent promotes its
children to the closest surviving ancestor without terminating their sessions.
Each record permits an 80-character name, at most 256 unique ordered
tabs, at most 16 disjoint contiguous tab groups whose names are at most 40
characters, and at most 16 quick links; the global common shelf and each
native-session shelf also permit 16 links. A workspace can keep at most 16 named
pane layouts, each with at most 12 leaves and six split levels. Pane-layout names
are limited to 64 characters and divider ratios to 15%-85%. Quick-link labels
are limited to 48 characters and URLs to 2,048 characters. Each notebook has at
most 128 pages with 80-character names; page content has no separate character
validator. Each workspace callback list permits 64 unique session names, and the
explicit global callback list permits 256 unique session names. Workspace
callback entries are always included in the deduplicated global queue.
Keep a pre-upgrade copy for rollback because a release that only understands
versions 1 through 13 rejects the version 14 document. As with snippets, an
unreadable, malformed, or unsupported existing
workspace file makes that store unavailable; Muxdeck returns `503` for workspace
APIs instead of overwriting the file.

Muxdeck accepts version 1 through 4 title files. Version 1 through 3 files have
no tags, and versions 1 and 2 also treat their missing ignored list as empty.
The first title, tag, star, or ignored-status mutation under this release
atomically rewrites that file as version 4. This upgrade needs no separate
migration command, but it
creates a rollback boundary: a version-3 release will discard tags on its next
metadata write, while a version-1-or-2 release can additionally discard ignored
status. Keep the timestamped pre-upgrade file until the new release is accepted.
An unreadable, malformed, or unsupported future title file disables metadata
writes instead of being overwritten; repair the configured file and restart
Muxdeck.

The snippet file loads schemas 1 and 2. Schema 2 supports optional shortcut
aliases on snippet leaves (up to eight non-whitespace words, each at most 32
characters). Loading a version-1 file does not rewrite it; the next snippet
save atomically writes version 2. Preserve the pre-upgrade `snippets.json` for
rollback because older releases reject version 2.

The shortcut file uses schema version 8. Version 7 loads by adding Open scrollback
with `KeyP` only in unoccupied direct/shortcut-window layers. Version 6 loads by adding Insert snippet
with `KeyI` only in unoccupied direct/shortcut-window layers. Existing custom
bindings, including the shortcut-window opening chord, remain unchanged.
Version 5 loads by adding the workspace
callback binding with `KeyK`; when the older quick temporary-session default also
owns `KeyK`, its direct binding is moved out of the way while its shortcut-window
binding remains available. Versions 1 through 4 add the pane navigation binding
with `KeyG` wherever that key is not already assigned. Version 3 also adds the
floating utility-terminal binding with `KeyJ`; version 2 adds the floating
staged-input binding with `KeyY`, and version 1 first adds the quick
temporary-session binding with `KeyK`. Each legacy upgrade adds the later bindings
in that order; occupied keys leave only that layer unbound. The next keymap save
atomically writes version 8. Keep a pre-upgrade copy for rollback: releases that
only understand versions 1 through 7 reject version 8. An unreadable, malformed,
conflicting, or unsupported shortcut file makes that store unavailable instead
of overwriting it.

Migration procedure:

1. Stop only Muxdeck on the source if a consistent final copy is needed. This
   disconnects web clients but does not stop tmux sessions.
2. Copy the six JSON files and `sessions.sqlite3` that exist separately from the
   source archive. Stop only Muxdeck or use SQLite's backup API while copying
   the database; never restart or stop tmux for this operation. An
   older release may not have created `workspaces.json`, `shortcuts.json`, or
   `auth.json` yet. Treat `auth.json` as credential state and never print or
   archive its contents with ordinary source/deployment evidence.
   If attachment retention is in scope, copy the configured upload directory
   without following or introducing symlinks; an older release may not have one.
3. Create the target state directory with owner/group equal to the run user and
   mode `0700`.
4. Install migrated JSON files with mode `0600` and the same owner/group. Keep
   the upload directory and its per-session subdirectories at `0700`, and
   attachment files at `0600`.
5. Point the rendered unit at their absolute target paths, including
   `MUXDECK_SHORTCUTS_FILE`, `MUXDECK_SESSION_REGISTRY_FILE`,
   `MUXDECK_AUTH_FILE`, and `MUXDECK_UPLOADS_DIR`.
6. Start Muxdeck and inspect logs for read/JSON/permission warnings.

Title, tag, star, ignored, memorandum, saved-workspace tab and pane assignment,
session-link, and session-note entries are keyed by tmux session name, so old
entries may remain dormant until a session with the same name exists. A new
session that reuses that name inherits the stored metadata, workspace position,
pane assignment, link shelf, or note. The
snippet tree, saved-workspace collection, shortcut keymap, login account, and
remembered-device list are global to the Muxdeck instance rather than per
browser. Do not run two Muxdeck processes
against the same state files; persistence is atomic within one process, not
coordinated between processes.

Saved workspaces are server-global and shared by every browser that can reach
this Muxdeck instance. Their stable `workspace=` URL identifier is independent
of the editable workspace name. Opening or changing one records its ordered tabs,
groups and collapse state, named pane layouts and assignments, workspace-specific
quick links, active session, and last-active time. A separate common quick-link list is pinned across all
workspaces. Session-specific quick-link lists are keyed by native tmux name and
follow the active session across temporary and saved workspaces. Common,
workspace, and session notes use the same scopes and last-write-wins replacement;
deleting a workspace also deletes only its workspace-scoped note. Quick-link
and note replacements retain those semantics. Saved-workspace pages subscribe
to `/api/workspaces/{workspaceId}/stream` for complete initial/reconnect and
changed snapshots, with a four-second polling fallback and refocus refresh.
The proxy must allow unbuffered SSE for this route as well as the session and
callback streams. Events contain `{ "workspace": <record or null>, "callbacks":
<global callback snapshot> }`; deletion sets `workspace` to `null`. A loaded
saved-workspace page uses this single stream for both workspace and callback
updates, reducing HTTP/1.1 connection usage across open tabs.
Each browser preserves its selected session when that tab still exists.

Ordinary browser tab/activity writes include `expectedUpdatedAt` with the
last observed workspace `updatedAt`. The store rejects a stale version with
`409`, and the browser reconciles pending local tab/group edits with the current
record before retrying. This includes page-exit activity saves, preventing stale
snapshots from restoring tabs another page closed. Older API callers may omit
the field for compatibility and retain their previous replacement behavior.
Each tab snapshot also echoes the document-wide native session rename
revision; native renames, global-pin changes, atomic copy/move transfers, and
forgetting a recovery record advance that fence. Stale snapshots receive `409` and reload instead of
restoring an obsolete session name or undoing an explicit session transfer.
Copying to a workspace deduplicates existing membership. Moving writes the
destination and saved source in one state-file replacement, and rejects a full
destination or globally pinned session without removing the source. Deleting a saved workspace must not stop,
rename, resize, or send input to any referenced tmux session.

Renaming a native session through Muxdeck moves its title/tag/star/ignored
metadata, memorandum queue, session-specific quick links, session note, and
every saved-workspace tab to the new name. Renaming directly in another tmux
client does not notify Muxdeck to migrate those
name-keyed files. If Muxdeck reports a post-rename storage warning, the tmux
rename itself has already succeeded; keep all affected state files and resolve
the warned migration before deleting old-name records.

Not migrated: live tmux processes or agent processes, browser local storage, page-local workspace
Recents, history snapshots, and state-change observation times. Uploaded
attachments are migrated only when the upload directory is explicitly copied
in step 2.

## 7. Render and install the systemd unit

Create the state directory first, using the exact resolved values:

```bash
install -d -m 0700 \
  -o "$MUXDEPLOY_RUN_USER" \
  -g "$MUXDEPLOY_RUN_GROUP" \
  "$MUXDEPLOY_STATE_DIR"
```

If a valid `auth.json` was not migrated, provision it interactively as the run
user before installing or starting the unit:

```bash
sudo -u "$MUXDEPLOY_RUN_USER" -- \
  "$MUXDEPLOY_APP_DIR/.venv/bin/python" -m tmux_console.auth provision \
  --path "$MUXDEPLOY_STATE_DIR/auth.json" \
  --username "$MUXDEPLOY_AUTH_USERNAME"
```

The command prompts twice without echoing the password and refuses to overwrite
an existing file. Never put the password in a command-line argument, shell
history, environment or unit file, source patch, deployment archive, log, or
evidence bundle. The resulting file is mode `0600` and contains only a salted
scrypt password hash plus hashes of later remembered-device tokens. The unit
template applies the selected `MUXDEPLOY_AUTH_MODE` and points
`MUXDECK_AUTH_FILE` at this path; missing or unsafe state in a protected mode
makes Muxdeck fail startup instead of falling back to unauthenticated access.

Change the rendered mode to `basic` only when standard browser-managed HTTP
Basic authentication is intended. It uses the same auth file but does not issue
remembered-device cookies and has no reliable application logout; the browser
controls credential caching. A Basic username cannot contain `:`. Select `none`
only when an explicitly reviewed private network, tunnel, or external access
layer is the authentication boundary. Explicit `none` ignores the auth file.
Never rely on the omitted-mode compatibility inference in a deployed unit.

The remembered-browser cookie is Secure by default. Keep that default behind
HTTPS. Only an intentional direct-loopback HTTP development deployment may add
`Environment=MUXDECK_AUTH_COOKIE_SECURE=false`; never use that setting for a
public or plain-LAN route.

Render the template to a temporary file. The values must already have passed
the restricted-character checks in section 3:

```bash
MUXDEPLOY_RENDERED_UNIT="$(mktemp)"
sed \
  -e "s|@@RUN_USER@@|$MUXDEPLOY_RUN_USER|g" \
  -e "s|@@RUN_GROUP@@|$MUXDEPLOY_RUN_GROUP|g" \
  -e "s|@@APP_DIR@@|$MUXDEPLOY_APP_DIR|g" \
  -e "s|@@PORT@@|$MUXDEPLOY_PORT|g" \
  -e "s|@@BASE_PATH@@|$MUXDEPLOY_BASE_PATH|g" \
  -e "s|@@TRUSTED_ORIGINS@@|$MUXDEPLOY_TRUSTED_ORIGINS|g" \
  -e "s|@@STATE_DIR@@|$MUXDEPLOY_STATE_DIR|g" \
  -e "s|@@AUTH_MODE@@|$MUXDEPLOY_AUTH_MODE|g" \
  -e "s|@@TMUX_BIN@@|$MUXDEPLOY_TMUX_BIN|g" \
  deploy/muxdeck.service.template > "$MUXDEPLOY_RENDERED_UNIT"
```

If the target uses `tmux -L NAME`, add this line to the rendered service's
environment block:

```ini
Environment=MUXDECK_TMUX_SOCKET=NAME
```

If the target tmux server uses a custom `TMUX_TMPDIR`, add its exact absolute
value too:

```ini
Environment=TMUX_TMPDIR=/absolute/path
```

Confirm no template tokens remain and inspect the entire rendered unit:

```bash
if grep -n '@@' "$MUXDEPLOY_RENDERED_UNIT"; then
  echo 'Refusing to install an incompletely rendered unit' >&2
  exit 1
fi
sed -n '1,240p' "$MUXDEPLOY_RENDERED_UNIT"
```

On a replacement, save the existing unit first. Then install and verify:

```bash
install -m 0644 "$MUXDEPLOY_RENDERED_UNIT" \
  /etc/systemd/system/muxdeck.service
systemd-analyze verify /etc/systemd/system/muxdeck.service
systemctl daemon-reload
```

For a fresh install:

```bash
systemctl enable --now muxdeck.service
```

For a replacement after the new release and unit are validated:

```bash
systemctl restart muxdeck.service
```

Do not restart tmux or Caddy as part of this step.

## 8. Mandatory local validation

Run all gates before changing the reverse proxy:

```bash
systemctl is-active muxdeck.service
systemctl show muxdeck.service \
  -p MainPID -p User -p Group -p WorkingDirectory -p Environment --no-pager
journalctl -u muxdeck.service -n 100 --no-pager
case "$MUXDEPLOY_AUTH_MODE" in
  server)
    curl -fsS \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/login" >/dev/null
    test "$(curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health")" = 401
    test "$(curl -sS -o /dev/null -w '%{http_code}' \
      -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/")" = 303
    ;;
  basic)
    test "$(curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health")" = 401
    curl -sS -D - -o /dev/null \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health" \
      | tr -d '\r' | grep -Fx 'WWW-Authenticate: Basic realm="Muxdeck", charset="UTF-8"'
    ;;
  none)
    test "$(curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health")" = 200
    ;;
esac
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Host: untrusted.invalid' \
  "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health")" = 403
```

Expected results:

- service is `active`;
- `server` returns its login HTML, denies unauthenticated API health with `401`,
  and redirects browser navigation to login; `basic` returns a `401` Basic
  challenge; or intentional `none` allows health without application credentials;
- a request with an untrusted Host returns `403`;
- direct tmux identity checks still show the expected server and session count;
- logs contain no import, authentication-state, permission, socket, or
  malformed-state errors, including errors loading the saved-workspace file.

Do not put the login password or a browser bearer cookie into a curl command or
evidence file merely to automate this gate. Section 10 validates authenticated
health, API, SSE, WebSocket, dashboard, and deep-link behavior through the
intended HTTPS route.

Compare the recorded pre-deployment session/pane identities now. Session IDs,
pane IDs, pane PIDs, commands, and dead/alive flags should remain unchanged.

## 9. Render and install the Caddy route

Skip this section when using a private SSH tunnel, another proxy, or direct
trusted-LAN access. Do not add a public route until access protection has been
resolved.

The provided template belongs inside an existing Caddy site block, before any
generic fallback `handle`. It uses `handle`, not `handle_path`, because Muxdeck
expects the prefix to reach the backend intact.

Caddy preserves the browser's `Host` and `Origin` headers by default. Do not
rewrite either header to bypass Muxdeck's request checks. The external browser
origin must be present in `MUXDECK_TRUSTED_ORIGINS` in the rendered service.

Render it:

```bash
MUXDEPLOY_RENDERED_CADDY="$(mktemp)"
sed \
  -e "s|@@BASE_PATH@@|$MUXDEPLOY_BASE_PATH|g" \
  -e "s|@@PORT@@|$MUXDEPLOY_PORT|g" \
  deploy/Caddyfile.snippet.template > "$MUXDEPLOY_RENDERED_CADDY"
if grep -n '@@' "$MUXDEPLOY_RENDERED_CADDY"; then
  echo 'Refusing to use an incompletely rendered Caddy snippet' >&2
  exit 1
fi
sed -n '1,120p' "$MUXDEPLOY_RENDERED_CADDY"
```

Back up the active Caddy configuration, inspect its routing order, and insert or
import the rendered routes into the intended site block. Do not blindly append
them outside a site block. Then:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl is-active caddy
```

If validation fails, do not reload. Restore or correct the staged configuration
without touching tmux or the healthy local Muxdeck service.

## 10. External smoke checks

From a client allowed by the chosen access controls, verify:

For `server`, use a fresh browser profile to confirm the site shows the Muxdeck
login instead of the SPA, a wrong password produces only a generic error, and
the provisioned credentials open the original deep link. Open a second tab in
the same profile and confirm it is already authenticated. Reload both tabs, then
open **Account** and confirm the current browser is listed. Do not revoke that
only test browser until the remaining checks finish. A separate private profile
must still see the login page. This demonstrates that the cookie is
browser-profile-wide rather than tab-local.

For `basic`, confirm a fresh profile receives the browser's Basic prompt, wrong
credentials do not reveal which field failed, valid credentials open the deep
link, and **Account** explains that credential caching and logout are controlled
by the browser. For `none`, verify the reviewed tunnel, network policy, or
external authentication boundary before continuing; do not expose the route
merely to test that the application itself has no login.

1. `/mux` redirects to `/mux/` and retains a query string.
2. The dashboard loads and the header reaches `live`, not permanent `polling`.
3. API health works through the proxy.
4. A dashboard URL with search, include/exclude tags, view, grouping, and sort
   reloads identically.
5. A session deep link returns the SPA.
6. Card and list layouts have no horizontal overflow at phone width.
7. Titles, predefined tags, starred/ignored organization, memoranda, the snippet
   library, and saved workspaces appear if state was migrated. Ignored sessions
   should be in the collapsed background section and absent from regular state
   counts; a reverse-filtered tag must hide matches from every session section.
8. Opening a saved workspace restores its ordered tabs, tab groups, collapse
   state, workspace-specific quick links, named pane layouts, and active session. Common quick links
   appear in both temporary and saved workspaces. Session-specific quick links
   follow the active native session across both kinds of workspace. On desktop,
   Common, Workspace, and Session notes appear immediately left of the console
   action controls, autosave edits, survive reload, and remain isolated by scope;
   a temporary workspace disables only the Workspace note. Its approximate
   last-active label updates after an explicit workspace interaction; merely
   listing workspaces, links, or notes must not mutate tmux. The workspace
   card's `New window` link must restore the same workspace in a no-opener tab,
   while the console header's split landing-page control must leave the console
   intact when it opens Sessions and Workspaces in a new window. The desktop
   `Split workspace` action must open the multi-selected tabs in source order,
   or only the active session without a multi-selection, in a no-opener
   temporary workspace without changing the source. Save that destination from
   its tab strip, then rename it there; confirm its stable ID, membership, and
   tmux identities remain unchanged through the rename.
   Create a disposable named Pane view, split it right and then split one leaf
   down, assign three existing workspace sessions, resize both dividers, and
   rename the view. Reload the saved workspace and confirm the tree, assignments,
   ratios, and name return. Removing a workspace tab should clear only its pane
   assignment; deleting the Pane view must not stop or resize any tmux session.
   Use the displayed pane-navigation leader followed by arrows to traverse the
   three panes, including successive arrows within its repeat window. Confirm
   the highlight and keyboard input focus move together, an outside edge does
   not wrap, `Escape` cancels, and the shortcut-window `G` action arms the same
   mode. Do not type validation input into a valuable session.
   Open the same disposable saved workspace in two pages, close a tab in one,
   and confirm both sidebars update without reloading. Independently select a
   remaining tab in each page and confirm workspace updates keep those choices.
   Make independent additions/removals in both pages, then reload in either
   order and confirm the changes survive. In a long Side tabs list, close a
   visible entry and confirm the viewport stays steady; explicitly selecting
   another entry should still reveal it. Use only disposable workspace records
   for these mutation checks.
9. On desktop, open the `Callback` card, add the current and another workspace
   session, and confirm the list deduplicates entries, shows Working/Ready/
   Ended status, opens a live session from its row, and removes an item with the
   reviewed check button. Put an entry On hold with the pause button: its row
   should turn gray, keep its messages, and leave the Ready count. Confirm the
   hold survives reload and appears in another browser, then take it off hold
   or remove it. Confirm `Clear ended` and `Clear all`, reload the
   saved workspace, and verify entries persist. Drag and resize the floating
   panel, pin it, switch sessions, and confirm it stays visible; unpinned panels
   close on a session switch. A temporary workspace should keep its list only
   in that browser until it is saved.
10. Deleting a disposable saved workspace removes only that workspace record and
   leaves all referenced tmux sessions and pane identities unchanged.
11. On desktop, `Move / Copy` lists other saved workspaces. Copying twice leaves
    one destination tab; moving to a destination that already contains the
    session removes only the source tab. A globally pinned session explains why
    Move is unavailable until it is unpinned.
12. On desktop, the workspace quick switcher's Previous and Next buttons replace
    the current page's saved workspace without opening the landing page, wrap in
    stable alphabetical order, and its searchable chooser opens the selected
    workspace in the same browser tab.
13. In desktop Side tabs, `Non-working first` stably moves every non-Working tab
    before Working tabs, preserves relative order inside each partition, keeps
    tab groups intact, and writes the resulting order to the URL or saved
    workspace without changing the active session. In both top and side tabs,
    Shift-click a range, Ctrl/Cmd-click individual tabs, and drag the selection;
    confirm its relative order is preserved and any selected group moves whole.
14. On desktop, the workspace timer opens as a draggable floating window, runs
    both countdown and stopwatch modes, keeps a pinned window visible across
    session switches, and restores its browser-local state per saved workspace.
    A disposable short countdown should visibly alarm and mark the browser-tab
    title; audio depends on the browser allowing Web Audio after the Start click.
    In terminal Focus, `Float input` and its configured shortcut should open the
    movable staged-input editor without leaving Focus. Confirm edits mirror the
    full composer in both directions, an unpinned window closes on session
    switch, and a pinned window stays open with the newly active session's draft.
15. On desktop, Host Pulse should take one initial CPU/memory sample, then remain
    idle until its movable/resizable panel is open and unpaused. Confirm Overview
    switches to Details, every logical core appears, and RAM headroom, PSI
    `some`/`full`, swap use, and swap-in/out rates render. Switch among 15-minute,
    one-hour, and 24-hour history; restore the selected view and pinned layout
    after switching sessions and reloading the saved workspace. Closing or pausing
    the panel must stop five-second sampling, and both card and panel must disappear
    at compact mobile width. A fresh service should bootstrap its first aggregate
    and per-core CPU percentages within the initial API request.
16. Against a deliberately disposable session, `Attach files` accepts a small
    text or binary file through the picker and inserts an absolute path under
    the configured upload directory without sending it automatically. An image
    should additionally show a preview. Confirm that dropping another arbitrary
    file over the live desktop terminal uploads it and pastes its shell-safe path
    without Enter, the run user can read both files, each file is `0600`, and all
    attachment affordances are hidden at compact mobile width. Do not upload
    sensitive material merely for a smoke test.
17. In that disposable session, open the desktop pane-CWD browser and upload a
    small file into a disposable folder with both the picker and drag-and-drop.
    Confirm the files land in the folder shown with mode `0600`, a repeated name
    is rejected without changing the original bytes, and downloading returns the
    same bytes. Add a small PNG or JPEG and confirm it renders in the fitted
    preview and opens through the protected full-size link; an SVG must remain a
    non-embedded text or binary preview. Add a small disposable PDF and confirm
    its signature-checked inline viewer, new-tab link, and download fallback; a
    renamed non-PDF must not render through the PDF route.
    Open a disposable HTML report with `Open webpage` and its terminal link;
    verify a scripted button, relative JavaScript/CSS/module files, and a local
    JSON request work. Its temporary preview URL must retain an opaque-origin
    sandbox, reject console API calls, and refuse hidden/out-of-directory assets.
    Reopen from the original file after the one-hour URL lifetime or a service
    restart. Preview grants are bounded, process-local state and need no migration
    or reverse-proxy changes. Enter one disposable file's absolute path
    in the address row and confirm its parent opens with that file previewed
    immediately. Open `Find`, fuzzy-locate a nested disposable file, and confirm
    selecting it opens the same parent and preview; a deliberately broad search
    must report when its bounded traversal is partial. In the ordinary listing,
    type a disposable filename, toggle `Nested`, and confirm a descendant match
    appears with its relative path and opens through the same preview/actions;
    turn the toggle off and confirm the local folder filter returns. Open
    `Recent` and confirm the file and its parent appear in All recent paths and
    Under current CWD when inside the pane CWD, preserving the same relative
    order; paths outside the CWD appear only in All recent paths. Confirm entries
    survive closing and reopening the panel, reopen with one click, and do not
    appear for another tmux session. Check the uploaded file plus a disposable
    nested folder, use `Download ZIP`, and confirm one archive contains both
    selected roots and the nested contents; the checked rows should remain
    selected afterward.
    Confirm an accessible regular-file row downloads directly without first
    selecting it. Render a disposable Markdown file, enlarge it from the 100%
    default, close and reopen the panel, and confirm that browser remembers the
    chosen text size; the percentage control must also reset it to 100%.
    Print disposable relative
    `.md`, `.pdf`, `.txt`, `.png`, `.json`, and `.csv` paths in the live
    terminal; confirm a plain click remains terminal input while `Ctrl`+click
    (or `Cmd`+click on macOS) opens each in this browser without sending a
    terminal mouse frame. Delete only those disposable fixtures
    afterward; none of these file operations should send terminal input or
    change tmux identities.
18. On desktop, `Shortcuts` then `Customize` shows both direct and window keys.
    Change one unused test binding, save, reload, and confirm the visible hint
    and handler both use it; then restore the original binding. A duplicate key
    in either layer must be identified and must keep Save disabled.

Merely viewing the dashboard is read-only with respect to tmux. Opening a
console creates an attach client, and `Fit active` may resize the shared tmux
window. Test interactive input only against a deliberately disposable session.
Use `Size protected` when observing a valuable session, and do not type into it.

## 11. Completion report

The deployment agent should report:

- target host and app directory;
- run user/group and tmux socket selection;
- Python, Node, npm, and tmux versions;
- base path, port, trusted browser origins, and proxy/access-control choice;
- whether state was migrated and its target directory (not memorandum, snippet,
  workspace-name, workspace-tab, pane-layout, quick-link, note, password-hash, or
  remembered-device content);
- the selected authentication mode and its expected unauthenticated result;
  for `server`, whether same-profile tabs shared the login; for `basic`, whether
  the browser challenge succeeded; never report a password or bearer cookie;
- source/unit/Caddy, JSON/SQLite state, and uploaded-attachment backups retained for rollback;
- build/test commands and results;
- local and external health results;
- pre/post tmux identity comparison;
- exact services reloaded or restarted;
- any accepted security or reproducibility caveats.

Do not claim success if the dashboard works but points at the wrong user's tmux
server or returns an unexpected session count.

## 12. Rollback

Keep the previous release and all backups until the human accepts the new
deployment.

For a failed replacement:

1. Remove or restore the new Caddy route first if external traffic is affected.
2. Validate the restored Caddy configuration, then reload Caddy.
3. Stop only `muxdeck.service`, then restore the prior systemd unit or point it
   back to the prior release.
4. Restore all six state JSON files and `sessions.sqlite3` only while Muxdeck is
   stopped; preserve owner and modes. Preserve `workspaces.json` even when the rollback release
   does not understand it, so a later compatible release can recover the saved
   workspace list.
   When rolling back to a release that only understands workspace-file versions
   1 through 13, retain the version-14 file separately and restore the pre-upgrade
   workspace file; older releases cannot read nested tab relationships.
   When rolling back to a release that only understands workspace-file versions
   1 through 10, retain the version-11 file separately and restore the pre-upgrade
   workspace file; older releases cannot read workspace callback lists. A release
   that only understands versions 1 through 12 additionally cannot read the
   explicit global callback list in the version-13 document; retain that file
   separately and restore the pre-upgrade workspace file. A release that only
   understands versions 1 through 9 additionally cannot read named pane layouts
   or their session assignments and split ratios.
   When rolling back to version 8 or earlier, retain the version-9 file separately
   and restore the pre-upgrade workspace file; older releases cannot read
   before-session separators. A separator anchors before or after a session and
   follows Muxdeck renames; removing that tab also removes the separator.
   When rolling back to a release that only understands workspace-file versions
   1 through 6, retain a separate copy of the version-7 file and restore the
   pre-upgrade `workspaces.json`; global pins and inherited-membership provenance
   are unavailable to that older release. Versions 1 through 5 also lack scoped
   notes, versions 1 through 4 lack session-specific quick links, and versions 1
   through 3 additionally lack common and workspace-specific quick links.
   When rolling back to a release that only writes title-file version 1 through
   3, retain a separate copy of the version-4 file and restore the pre-upgrade
   `session-titles.json`; tags are unavailable to that older release and would be
   discarded by its next metadata write. Version-1-or-2 releases can also lose
   ignored statuses.
   When rolling back to a release that only reads snippet-file version 1,
   preserve the version-2 document and restore the pre-upgrade `snippets.json`.
   When rolling back to a release that only understands shortcut-file version 7
   or earlier, preserve the version-8 document and restore the pre-upgrade
   `shortcuts.json`; the Open scrollback binding is unavailable there.
   When rolling back to a release that only understands shortcut-file version 6
   or earlier, preserve the version-7 document and restore the pre-upgrade
   `shortcuts.json`; the Insert snippet binding is unavailable there.
   When rolling back to a release that only understands shortcut-file version 5
   or earlier, also restore the pre-upgrade
   `shortcuts.json`; the workspace-callback action is unavailable there. A
   release that only understands version 4 or earlier additionally lacks the
   pane-navigation action. Version-3 releases also lack the utility-terminal
   action, and version-2 releases additionally lack the floating-input binding.
   A version-1 release also lacks the quick temporary-session binding.
   Preserve the upload directory separately. An older release ignores it; do not
   delete attachments created after the pre-deployment backup merely to roll back
   application code.
   Preserve `auth.json` separately even when the rollback release does not
   support it. Before exposing an older unauthenticated release, remove the
   public route or add a separate authenticated proxy/access layer; retaining an
   ignored auth file does not protect old application code.
   Retain the current `launch-requests.sqlite3` even if the rollback release
   ignores it. Restoring an older launch-request backup discards newer duplicate
   fences, so reconcile outstanding attempts before allowing launch traffic
   after a database restore. Keep the control and callback token files private;
   retaining an ignored control credential does not grant a rollback release
   any automation features or protect an otherwise unauthenticated route.
5. Run `systemctl daemon-reload` and start only `muxdeck.service`.
6. Recheck local health, external routing, persistent session organization, and
   the recorded tmux identities.

Never use `tmux kill-server` as deployment cleanup or rollback.

## 13. Updating an existing deployment later

### Reusable checks and progress

Start `scripts/task_timeline.py` before investigating or preparing an update,
and keep its timeline through validation, staging, commit/push, deployment, CI,
and reporting. Wrap independent commands separately so their overlap remains
visible. Mark non-command work with phase/activity labels. Capture remote CI job
timestamps as well as local wait time, and link the generated timeline alongside
the deployment checker report. See [Task timelines](docs/TASK_TIMELINES.md) for
the commands and measurement limits. Do not infer total task time from test
runtime or file modification times.

Use `scripts/check_deployment.py` for the common read-only checks instead of
writing temporary verification and report scripts for every release. It uses
Python's standard library and runs as the service user. It reads the running
service's environment privately to select the correct tmux socket, loopback URL,
base path, and authentication mode. It never restarts services or sends input.

Before an authorized update, record the existing identities in a new private
evidence directory:

```bash
MUXDEPLOY_EVIDENCE="$HOME/.local/state/muxdeck/deployments/$(date -u +%Y%m%dT%H%M%SZ)"
python3 scripts/check_deployment.py snapshot \
  --service muxdeck.service --output "$MUXDEPLOY_EVIDENCE/before.json"
```

After the update, use that baseline and a fresh report directory:

```bash
python3 scripts/check_deployment.py verify \
  --baseline "$MUXDEPLOY_EVIDENCE/before.json" \
  --output-dir "$MUXDEPLOY_EVIDENCE/checks" \
  --public-origin https://console.example.test \
  --expected-dist /absolute/path/to/tested-release/dist
```

Replace the example public origin with the exact configured HTTPS origin, or
omit it for a loopback-only deployment. Repeat `--public-origin` for multiple
routes. Use `--expected-dist` to compare the installed frontend with the separate
tested build; omit it for a change that does not replace frontend assets.

Every phase prints its start, result, and elapsed time immediately. Commands
have an eight-second timeout; HTTP requests have a five-second timeout. There
are no automatic retry loops. `verification.json` and `report.md` are written
automatically on success or check failure, with private permissions; existing
evidence is never overwritten. A nonzero exit requires review. A pane identity
change can be legitimate user activity, so inspect it rather than discarding
the original baseline. A previous web-process stop timeout is reported separately
from application errors and merits graceful-shutdown investigation.

Protected assets correctly return `401` without a login. The checker verifies
that denial, the server-mode login redirect, Basic challenges when applicable,
and rejection of an untrusted Host. It does not create credentials or claim to
validate authenticated application behavior. Keep task-specific browser tests,
database/migration checks, CI results, and rollback backups as separate evidence.

Do independent development in a separate worktree before changing a dirty live
checkout. Stage frontend builds outside the live `dist/`, validate them, then
install the reviewed assets. Documentation and tooling changes require neither
a frontend build nor a service restart. Announce phase changes and report
progress at least every 60 seconds, including while preparing code or reports.
Once checks finish, link the generated report rather than reconstructing it.

### Release installation

Prefer versioned release directories rather than extracting over the running
tree:

1. stage the new archive in a new exact directory;
2. create a fresh venv and run `npm ci` + build there;
3. run source and loopback checks on the staged release;
4. retain the external state directory unchanged and keep timestamped
   pre-upgrade copies of all six JSON state files, all configured SQLite
   databases (including `launch-requests.sqlite3`), plus the upload directory
   when it exists; preserve private credentials separately;
5. render/verify a unit pointing at the new release;
6. restart only Muxdeck;
7. validate health and tmux identities;
8. keep the previous release for rollback.

A Muxdeck restart resets in-memory state-change timestamps and disconnects open
web consoles. It stops the underlying tmux sessions **only** if the tmux server
shares Muxdeck's cgroup - which happens whenever Muxdeck was the first thing to
run a tmux command (typically after a host reboot). The tmux server daemonizes to
`PPID 1`, so process parentage will not reveal this. Check the cgroup, not the
parent:

```bash
systemctl show muxdeck -p KillMode          # must be: process
cat /proc/<tmux-server-pid>/cgroup          # must NOT be muxdeck.service
```

With the default `KillMode=control-group`, `systemctl restart muxdeck` signals
every process in the cgroup and destroys every live tmux session. This happened
on 2026-09-15. `KillMode=process` prevents it, including on a hung stop, because
the escalation SIGKILL also targets only the main PID.

Most redeployments do not need a restart at all. The frontend is served from disk
(`add_static` over `dist/assets`, `FileResponse` for `index.html`), so rebuilding
`dist/` ships frontend changes immediately with no restart and no risk to tmux.
Restart only when Python code or unit environment actually changed.

Workspace streaming and `expectedUpdatedAt` checks do not themselves require a
schema change. Nested tab relationships use schema 14, upgraded atomically on
the next state write; keep the pre-upgrade workspace file for rollback.
When deploying this change under an authorized
update, include both the backend and rebuilt frontend. Reload existing browser
pages so they use the version-aware client; a previously loaded older bundle
can still send compatibility writes without `expectedUpdatedAt`.
The new client also permits compatibility writes when an older backend returns
the explicit `400` error `unknown field: expectedUpdatedAt`; it remembers that
decision for the current page, including page-exit requests. It never strips
the check on `409`. Reload after the backend upgrade to clear that compatibility
decision and restore guarded writes.

### Trusted controller setup

`muxdeckctl` is installed with the Python package and talks to the existing
authenticated service. Programmatic launch, capture and input use the existing
HTTP route/base path; no public port, authentication-mode change or proxy
exception is needed. The dedicated `MUXDECK_CONTROL_TOKEN_FILE` grants session,
workspace and callback operations with shell-control privileges, while account,
file-browser and terminal-WebSocket routes stay outside its bearer scope.
Browser access retains its usual authentication. Keep this credential with
the trusted controller rather than every delegated agent; it does not restrict
holders to one workspace or one process.

Provision it as the service user, refusing any existing file:

```bash
.venv/bin/python -m tmux_console.control_auth provision \
  --path "$HOME/.config/muxdeck/control-token"
```

The command creates a private file and prints its path, not its token value.
Ensure the containing directory is mode `0700`. Configure the service's
`MUXDECK_CONTROL_TOKEN_FILE` to that absolute path, and set the controller's
same variable or `muxdeckctl --token-file` to its accessible private path.
A missing, unsafe or malformed configured token fails startup closed.
Callback and control credentials must differ; accidental reuse is rejected so
a callback-only credential cannot gain command-execution privileges. Rotation
and removal take effect when the token is reread on a request; long-lived
control event streams also recheck authorization.

For an existing installation, retain all persistent paths and existing browser
authentication settings, including `MUXDECK_LAUNCH_REQUESTS_FILE` if overridden.
A backend/CLI-only update can reuse the validated existing frontend; Python
changes require restarting only Muxdeck after the cgroup/KillMode preflight.
Follow section 13's deployment checker and timeline, and keep task-specific
tests against an isolated tmux socket. Verify control scope with authenticated
capabilities and read-only inventory; test launch/input/cancellation only on
deliberately disposable sessions.

The transparent `muxdeckctl exec` runner must be installed on the service host
and accessible to the same effective Unix UID with shared filesystem visibility
of its interpreter, runner and private socket paths. It exchanges provider argv, environment
and stdio through a private local Unix socket. These temporary sockets need no
migration or public route. The pane is a best-effort output mirror; the
controller receives the real provider protocol. Browser disconnect leaves the
run alone, but loss of the owning controller cancels the bridge's owned provider
process group.
See [Agent orchestration](docs/AGENT_ORCHESTRATION.md) for setup, launch-request
recovery rules and a Multica custom-runtime profile example.

### Agent callback endpoint setup

Agent posting and reading use `/api/callback-messages`; browser users continue
using their ordinary login. Scripts can instead use one callback-only bearer
token configured by `MUXDECK_CALLBACK_TOKEN_FILE`. The token also permits a
read-only global callback snapshot, and cannot access terminal, file, workspace,
or account operations. Host and browser-origin checks still apply. No proxy
change or unauthenticated route is needed.

Provision a token as the service user without printing it. For this host's root
service and agents, the shared private path is
`/root/.config/muxdeck/callback-token`, which is also the helper's default:

```bash
python3 - <<'PY'
import os
import secrets
from pathlib import Path
directory = Path.home() / '.config/muxdeck'
directory.mkdir(parents=True, mode=0o700, exist_ok=True)
path = directory / 'callback-token'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(secrets.token_urlsafe(32) + '\n')
PY
```

This refuses to overwrite an existing credential. Set the service's
`MUXDECK_CALLBACK_TOKEN_FILE` to that absolute file path and
`MUXDECK_CALLBACKS_FILE` to its persistent callback database path. Keep the token
outside the source tree and archives. A configured missing, malformed, symlinked,
or group/world-accessible token file prevents startup. Rotation or removal is
checked on each bearer request and takes effect immediately. All token holders
can post, read, and review callback messages; treat the file as access to the
whole callback inbox.

Deploy both backend and frontend, following the tmux cgroup/KillMode preflight
above before restarting only Muxdeck. Copy `scripts/muxdeck_callback.py` to
`~/s/g/cb.py` (mode `0700`) and `docs/AGENT_CALLBACKS.md` to `~/s/g/cb.md` (mode
`0600`) for the intended agent user. The helper reads its token from the private
file and supports posting, paginated JSON reads, review, and metadata-only dry
runs. Use a disposable report for smoke validation: confirm a repeated request
ID returns the original report, open browser callback panels update, review
removes it from pending, and `status=all` still returns it. Never put the token
itself in commands, logs, screenshots, documentation, or source control.

## 14. Troubleshooting

| Symptom | Likely cause | Safe checks/fix |
| --- | --- | --- |
| `ModuleNotFoundError: tmux_console` | Stale/broken copied venv or package not installed | Recreate the exact release venv, run `pip install -e .`, and test import from `/`. |
| Vite rejects Node | Node is below `20.19.0` or below `22.12.0` on Node 22 | Install an approved compatible Node release, then run `npm ci` again. |
| Health is 503 / `no server running` | Wrong run user/socket, missing tmux server, wrong `TMUX_TMPDIR` | Repeat section 4.3 as the service user; do not start or kill tmux unless explicitly requested. |
| Health is OK with zero/wrong sessions | Service can reach a different tmux server | Compare user, socket path/name, `TMUX_TMPDIR`, and expected identities. |
| 502 through Caddy | Service down, wrong port, or wrong loopback target | Check local health, unit environment, journal, and rendered proxy target. |
| HTML loads but assets/API/WebSocket fail | Build/runtime/proxy base paths differ | Rebuild with `/prefix/`; use runtime `/prefix`; preserve prefix in Caddy. |
| Dashboard stays `polling` | SSE is blocked/buffered or reconnecting | Curl the stream locally and externally; retain `flush_interval -1` in Caddy. |
| Saved-workspace pages update only on refocus or after several seconds | Workspace SSE is unavailable, buffered, or an older browser bundle is loaded | Inspect `/api/workspaces/{workspaceId}/stream` in the browser network panel, preserve streaming proxy settings, and reload the page after the frontend/backend update. Four-second polling is the fallback. |
| Console WebSocket returns 403 | External browser origin is absent from `MUXDECK_TRUSTED_ORIGINS`, or proxy rewrote `Host`/`Origin` | Configure the exact scheme and authority, preserve both headers, then retry without typing into a valuable pane. |
| Console WebSocket otherwise fails | Proxy path/TLS/upgrade issue or wrong compiled base | Check browser network logs and proxy routing without typing into a live pane. |
| Login page loops, a Basic prompt repeats, or the service fails during startup | Invalid `MUXDECK_AUTH_MODE`, missing/malformed `MUXDECK_AUTH_FILE`, wrong ownership/mode, wrong credentials, or a Secure server-mode cookie used over intentional direct HTTP | Inspect the selected mode without exposing credentials; keep the auth file outside source, owned by the run user and mode `0600`; use HTTPS, or set `MUXDECK_AUTH_COOKIE_SECURE=false` only for direct loopback HTTP development. Never fall back to an unprotected public route. |
| Titles/tags/starred/ignored organization, memoranda, snippets, saved workspaces, shortcuts, authentication devices, or attachments do not persist | State path or ownership/mode is wrong | Inspect all configured paths in the unit, directory ownership, mode `0700`, files mode `0600`, and journal without printing credential state. |
| File attachment returns `400`, `413`, `507`, or `503` | Empty file, 12 MiB file limit, 512 MiB directory cap, or unwritable upload path | Try a small non-empty file in a disposable session, inspect `MUXDECK_UPLOADS_DIR` and the journal, then archive/remove old uploads or repair ownership without changing tmux. |
| Pane-CWD upload returns `403`, `409`, or `413` | Destination is not writable/root-confined, the name already exists, or the file exceeds 12 MiB | Refresh the live pane identity and folder, choose a new filename, and inspect only that disposable destination's ownership/permissions; Muxdeck deliberately never overwrites. |
| Pane-CWD bulk ZIP returns `413` or `415` | The selection exceeds 1,000 selected entries, 10,000 expanded entries, or 256 MiB uncompressed; or it contains only links/special files | Narrow the checked selection or archive a very large tree from the terminal; do not raise the bounds merely to hide the error, and do not make symlink traversal permissive. |
| Pane-CWD image preview returns `413` or `415` | The raster image exceeds 25 MiB, has an unsupported or active format, or its signature does not match a supported image | Use Download for large files; convert trusted content to PNG, JPEG, GIF, WebP, AVIF, BMP, or ICO rather than weakening the inline allowlist. |
| Snippet API returns `503` | The configured snippet file exists but is unreadable, invalid, or unsupported | Preserve a copy, inspect the journal, repair or move only that file, then restart Muxdeck; the service deliberately refuses to overwrite it. |
| Workspace API returns `503` | The configured workspace file exists but is unreadable, invalid, or unsupported | Preserve a copy, inspect the journal, repair or move only that file, then restart Muxdeck; the service deliberately refuses to overwrite it. Do not delete tmux sessions. |
| Another terminal layout changes | Browser opened in `Fit active` | This is tmux shared-size behavior; use `Size protected` for observation. |
| Playwright cannot find a browser | No Playwright Chromium and no configured system browser | Run `npx playwright install chromium` or set `MUXDECK_PLAYWRIGHT_BROWSER`. |
| Port already in use | Existing Muxdeck or unrelated listener | Identify the listener before stopping anything; choose another port only if all coupled settings change. |
