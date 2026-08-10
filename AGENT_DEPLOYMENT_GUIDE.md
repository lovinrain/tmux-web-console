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
6. Muxdeck has no application authentication or controller lease. Anyone who
   can reach it can type into shells with the tmux owner's privileges. Do not
   create an unprotected public route without the human explicitly accepting
   that risk.
7. Preserve an existing release, unit, proxy configuration, and state files
   until the replacement passes all validation gates.
8. Restart only `muxdeck.service` during a normal deployment. Validate Caddy
   before reloading it. Do not restart Caddy when a reload is sufficient.

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
- titles/stars and memoranda stored outside the source folder;
- browser-local staged drafts and dashboard preferences;
- in-memory history snapshots or agent-state transition timestamps.

If creating the transfer archive on a source machine, exclude generated files:

```bash
cd /absolute/path/to/tmux-web-console
tar \
  --exclude='./.git' \
  --exclude='./.venv' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./*.egg-info' \
  --exclude='./src/*.egg-info' \
  --exclude='./__pycache__' \
  --exclude='./.pytest_cache' \
  --exclude='./.mypy_cache' \
  --exclude='./.ruff_cache' \
  --exclude='./.benchmarks' \
  --exclude='./artifacts' \
  --exclude='./test-results' \
  --exclude='./playwright-report' \
  -czf ../muxdeck-source.tar.gz .
sha256sum ../muxdeck-source.tar.gz > ../muxdeck-source.tar.gz.sha256
```

Transfer the checksum with the archive and verify it before extraction.

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
| tmux | 3.x | `xterm-256color` terminfo must exist. |
| Base path | `/mux` | No trailing slash at runtime; build value is `/mux/`. |
| Loopback port | `7683` | Must not conflict with an unrelated service. |
| State directory | `/var/lib/muxdeck` | Explicit, persistent, mode `0700`, owned by the run user. |
| tmux socket | default or `-L NAME` | `MUXDECK_TMUX_SOCKET` is a name, never a filesystem path. |
| `TMUX_TMPDIR` | usually unset | If the real server uses it, reproduce it in the service. |
| Public host | optional | Must be protected by a VPN, trusted network, tunnel, or proxy access control. |
| Proxy | Caddy, existing proxy, or none | Proxy must preserve the base path and support WebSocket + streaming SSE. |
| State migration | yes/no | Runtime JSON files are separate from the source archive. |

A useful working set is:

```bash
MUXDEPLOY_APP_DIR=/opt/muxdeck
MUXDEPLOY_RUN_USER=replace_me
MUXDEPLOY_RUN_GROUP=replace_me
MUXDEPLOY_BASE_PATH=/mux
MUXDEPLOY_PORT=7683
MUXDEPLOY_STATE_DIR=/var/lib/muxdeck
MUXDEPLOY_TMUX_BIN=/usr/bin/tmux
MUXDEPLOY_TMUX_SOCKET_NAME=
```

Before using these variables in `sed` or a unit, ensure usernames contain only
normal account characters and paths contain only letters, digits, `_`, `-`,
`.`, and `/`. The base path must begin with `/`, must not end with `/`, and the
provided Caddy template expects a non-root path such as `/mux`.

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

Back up the existing unit, the relevant Caddy configuration, both state JSON
files, and the old release path. Use timestamped copies; do not overwrite the
only known-good copy.

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
a unique disposable tmux socket per run. Do not run browser validation against
valuable target sessions.

## 6. Optional runtime-state migration

The default source paths are under the old service user's state directory:

```text
~/.local/state/muxdeck/session-titles.json
~/.local/state/muxdeck/session-messages.json
```

The first file contains titles and starred session names. The second contains
memoranda and may include sensitive commands or prose. An existing unit may
override both paths; inspect its environment rather than assuming defaults.

Migration procedure:

1. Stop only Muxdeck on the source if a consistent final copy is needed. This
   disconnects web clients but does not stop tmux sessions.
2. Copy the two JSON files separately from the source archive.
3. Create the target state directory with owner/group equal to the run user and
   mode `0700`.
4. Install migrated JSON files with mode `0600` and the same owner/group.
5. Point the rendered unit at their absolute target paths.
6. Start Muxdeck and inspect logs for read/JSON/permission warnings.

State is keyed by tmux session name. Old entries may remain dormant until a
session with the same name exists. Do not run two Muxdeck processes against the
same state files; persistence is atomic within one process, not coordinated
between processes.

Not migrated: tmux sessions, browser local storage, history snapshots, and
state-change observation times.

## 7. Render and install the systemd unit

Create the state directory first, using the exact resolved values:

```bash
install -d -m 0700 \
  -o "$MUXDEPLOY_RUN_USER" \
  -g "$MUXDEPLOY_RUN_GROUP" \
  "$MUXDEPLOY_STATE_DIR"
```

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
  -e "s|@@STATE_DIR@@|$MUXDEPLOY_STATE_DIR|g" \
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
curl -fsS \
  "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/health"
curl -fsS \
  "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/" >/dev/null
curl -fsS \
  "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/session/nonexistent" \
  >/dev/null
curl --max-time 5 -NsS \
  "http://127.0.0.1:$MUXDEPLOY_PORT$MUXDEPLOY_BASE_PATH/api/sessions/stream"
```

Expected results:

- service is `active`;
- health returns `{"ok": true, "sessions": N}`;
- `N` matches the intended tmux server, not merely any tmux server;
- dashboard and deep-link routes return the built SPA;
- the SSE request emits a `sessions` event (the command may end at its timeout);
- logs contain no import, permission, socket, or malformed-state errors.

Compare the recorded pre-deployment session/pane identities now. Session IDs,
pane IDs, pane PIDs, commands, and dead/alive flags should remain unchanged.

## 9. Render and install the Caddy route

Skip this section when using a private SSH tunnel, another proxy, or direct
trusted-LAN access. Do not add a public route until access protection has been
resolved.

The provided template belongs inside an existing Caddy site block, before any
generic fallback `handle`. It uses `handle`, not `handle_path`, because Muxdeck
expects the prefix to reach the backend intact.

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

1. `/mux` redirects to `/mux/` and retains a query string.
2. The dashboard loads and the header reaches `live`, not permanent `polling`.
3. API health works through the proxy.
4. A dashboard URL with filters/view/group/sort reloads identically.
5. A session deep link returns the SPA.
6. Card and list layouts have no horizontal overflow at phone width.
7. Titles/stars/memoranda appear if state was migrated.

Merely viewing the dashboard is read-only with respect to tmux. Opening a
console creates an attach client, and `Fit active` may resize the shared tmux
window. Test interactive input only against a deliberately disposable session.
Use `Size protected` when observing a valuable session, and do not type into it.

## 11. Completion report

The deployment agent should report:

- target host and app directory;
- run user/group and tmux socket selection;
- Python, Node, npm, and tmux versions;
- base path, port, and proxy/access-control choice;
- whether state was migrated and its target directory (not memorandum content);
- source/unit/Caddy backups retained for rollback;
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
3. Restore the prior systemd unit or point it back to the prior release.
4. Run `systemctl daemon-reload` and restart only `muxdeck.service`.
5. Restore state JSON only while Muxdeck is stopped; preserve owner and modes.
6. Recheck local health, external routing, and the recorded tmux identities.

Never use `tmux kill-server` as deployment cleanup or rollback.

## 13. Updating an existing deployment later

Prefer versioned release directories rather than extracting over the running
tree:

1. stage the new archive in a new exact directory;
2. create a fresh venv and run `npm ci` + build there;
3. run source and loopback checks on the staged release;
4. retain the external state directory unchanged;
5. render/verify a unit pointing at the new release;
6. restart only Muxdeck;
7. validate health and tmux identities;
8. keep the previous release for rollback.

A Muxdeck restart resets in-memory state-change timestamps and disconnects open
web consoles, but it should not stop the underlying tmux sessions or agents.

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
| Console WebSocket fails | Proxy path/TLS/upgrade issue or wrong compiled base | Check browser network logs and proxy routing without typing into a live pane. |
| Titles/stars/memoranda do not persist | State path or ownership/mode is wrong | Inspect unit environment, directory ownership, mode `0700`, files mode `0600`, and journal. |
| Another terminal layout changes | Browser opened in `Fit active` | This is tmux shared-size behavior; use `Size protected` for observation. |
| Playwright cannot find a browser | No Playwright Chromium and no configured system browser | Run `npx playwright install chromium` or set `MUXDECK_PLAYWRIGHT_BROWSER`. |
| Port already in use | Existing Muxdeck or unrelated listener | Identify the listener before stopping anything; choose another port only if all coupled settings change. |

