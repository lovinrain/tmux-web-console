# Muxdeck

[![CI](https://github.com/lovinrain/tmux-web-console/actions/workflows/ci.yml/badge.svg)](https://github.com/lovinrain/tmux-web-console/actions/workflows/ci.yml)
[![Secret scan](https://github.com/lovinrain/tmux-web-console/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/lovinrain/tmux-web-console/actions/workflows/secret-scan.yml)

Muxdeck is a mobile-friendly web console for monitoring and controlling tmux
sessions from a browser. It combines real PTY terminals with persistent
workspaces, session organization, and status detection for Claude Code, Codex,
GitHub Copilot CLI, Cursor Agent, and Grok Build.

> [!CAUTION]
> `MUXDECK_AUTH_MODE` selects `server`, `basic`, or `none`. Without an explicit
> mode, Muxdeck keeps its legacy behavior: a configured `MUXDECK_AUTH_FILE`
> enables the remembered-browser login and no file means no authentication.
> Anyone who can reach a `none` instance can control shells with the tmux
> owner's privileges. Keep the service bound to loopback, enable authentication
> or another access-control layer before exposing it, and never publish its HTTP
> port directly to the internet.

## Screenshots

### Desktop

<p align="center">
  <img src="docs/images/muxdeck-workspace.png" alt="Muxdeck desktop workspace with ordered tmux tabs, a live terminal, staged input, and terminal controls">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/images/muxdeck-dashboard.png" alt="Muxdeck desktop dashboard with saved workspaces, session filters, tags, and agent states"></td>
    <td width="50%"><img src="docs/images/muxdeck-workspace-vertical-tabs.png" alt="Muxdeck desktop workspace using an adjustable vertical session tab rail"></td>
  </tr>
  <tr>
    <td align="center">Session dashboard</td>
    <td align="center">Adjustable side tabs</td>
  </tr>
</table>

### Mobile

<table>
  <tr>
    <td width="33%"><img src="docs/images/muxdeck-mobile-overview.png" alt="Muxdeck mobile workspace overview with ordered sessions and agent states"></td>
    <td width="33%"><img src="docs/images/muxdeck-mobile-terminal-focus.png" alt="Muxdeck distraction-free mobile terminal with touch navigation controls"></td>
    <td width="33%"><img src="docs/images/muxdeck-mobile-input-focus.png" alt="Muxdeck distraction-free mobile staged input with compact send and memo controls"></td>
  </tr>
  <tr>
    <td align="center">Overview</td>
    <td align="center">Terminal focus</td>
    <td align="center">Input focus</td>
  </tr>
</table>

## Highlights

- Live tmux inventory with conservative status detection for Claude Code, Codex,
  GitHub Copilot CLI, Cursor Agent, and Grok Build
- Real xterm.js terminals with direct keyboard input and responsive desktop,
  tablet, and phone layouts
- Persistent named workspaces with colored, collapsible tab groups, ordered top
  or side tabs, common/workspace/session quick-link shelves, scoped sticky notes,
  and cross-device resume
- Session titles, tags, search, filters, grouping, stars, and an ignored-session
  bucket
- Dictation-friendly staged input, durable per-session memos, queued-input
  indicators, reusable snippets, and desktop file attachments
- A desktop file manager that opens at the pane CWD and browses anywhere inside
  a configurable boundary, with an absolute-path address bar, safe text and
  raster-image previews, uploads/downloads, shell-safe path staging, in-place
  text editing, and confirmed create/rename/move/duplicate/delete including
  multi-select bulk actions
- Confirmed session creation with reusable starting directories, native rename,
  and whole-session termination
- Light/dark appearance, reconnect support, and retained tmux scrollback snapshots

## Quick start

Requirements: Python 3.11+, tmux 3.x, and Node.js `^20.19.0` or
`>=22.12.0`.

~~~bash
git clone https://github.com/lovinrain/tmux-web-console.git
cd tmux-web-console
python3 -m venv .venv
.venv/bin/python -m pip install -e .
npm ci
npm run build
.venv/bin/python -m tmux_console.app
~~~

Open `http://127.0.0.1:7683/mux/`.

For frontend development, run `npm run dev`. Vite serves
`http://127.0.0.1:5173/mux/` and proxies the API and WebSocket to port 7683.

## Important behavior

- Opening a console attaches a real tmux client. Closing the browser disconnects
  that client but leaves the tmux session and foreground process running.
- A tab's `X` and workspace deletion only remove Muxdeck navigation records.
  `End` terminates the entire tmux session after confirmation.
- Landing-page workspace cards can resume in place or open the same saved
  workspace in a separate browser window. The console header uses a joined
  back/new-window control so the Sessions and Workspaces landing page can also
  be opened without replacing the active console. The fixed `Sessions` action
  in the horizontal tab bar or vertical tab rail offers the same split choice.
- New Session can start in an absolute server directory. Its browser-local
  Workspace Memory ranks paths learned from tmux sessions and successful
  launches by recency and frequency; paths can also be pinned, hidden, restored,
  or entered manually. Blank continues to use the service user's home directory.
- `Fit active` may resize the shared tmux window. Use `Size protected` when
  observing a valuable session without disturbing another client.
- Desktop consoles place Common, Workspace, and Session sticky notes beside the
  header controls. They autosave to the server; temporary workspaces can use the
  Common and Session notes until the workspace itself is saved. Each note button
  toggles a floating window that moves by dragging its title strip. Pinned Common
  and Workspace windows stay visible while switching session tabs. The browser
  remembers the open, pinned, and position state separately for each saved
  workspace and restores that arrangement when the workspace is resumed.
- The adjacent desktop timer card provides countdown and stopwatch modes in a
  draggable floating window. Pinning keeps it visible while switching sessions;
  saved workspaces restore its browser-local clock, layout, and pin state. An
  expired countdown rings, stays visibly alarmed, and marks the browser-tab title
  until dismissed.
- A staged-input acknowledgement confirms only that bytes reached the PTY, not
  that a command or agent turn completed. Uncertain deliveries are never
  retried automatically.
- Desktop staged input accepts any non-empty file from its picker, clipboard, or
  drag-and-drop target (12 MiB per file, six at once). Composer attachments
  stage shell-safe paths for review; dropping files over the live terminal
  pastes those paths at its cursor without pressing Enter. The active CLI agent
  runs as the same Unix user and can read the private host files directly.
- On desktop, click the working-directory line beneath the session title to open
  a movable, resizable file browser. Its root is always derived from
  the live tmux pane; requests cannot select an arbitrary server root or follow
  a symlink outside that CWD. Text previews are UTF-8 and capped at 1 MiB.
  Signature-verified PNG, JPEG, GIF, WebP, AVIF, BMP, and ICO files render in a
  fitted viewer up to 25 MiB and can be opened full size; active formats such as
  SVG are never embedded. Other binary files show metadata. Selected regular
  files can be downloaded without a preview-size limit. `Upload` and
  drag-and-drop write up to six files at once into the folder shown (12 MiB
  each, mode `0600`) and refuse to overwrite an existing name. `Copy path`
  copies the absolute server path, while `Stage path` inserts its shell-quoted
  form into the composer without sending.
- Agent activity is inferred conservatively from tmux-visible signals.
  Unsupported or ambiguous states appear as `Unclear` instead of being guessed.
- Alternate-screen applications may leave no retained tmux history; Muxdeck
  cannot reconstruct output tmux did not save.

## Workspace shortcuts

These are the default shortcuts for the desktop multi-tab view. They are not
active on the landing page or compact mobile layout.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+H` | Open fuzzy command search |
| `Ctrl+Shift+Z` | Open the shortcut window; then press one action key |
| `Ctrl+Shift+B` | Open New session in the current workspace |
| `Ctrl+Shift+,` | Previous tab |
| `Ctrl+Shift+.` | Next tab |
| `Ctrl+Shift+1...9` | Jump to a numbered tab |
| `Ctrl+Shift+;` | Find a tab by title, tmux name, or group |
| `Ctrl+Shift+A` | Show or hide tab action buttons |
| `Ctrl+Shift+S` | Show or hide the session tab strip |
| `Ctrl+Shift+F` | Enter or exit terminal Focus |
| `Ctrl+Shift+U` / `Ctrl+Shift+D` | Page with the current agent's remembered controls |
| `Ctrl+Shift+L` | Leave scrollback and return to live output |
| `Ctrl+Shift+C` | Toggle browser terminal Copy mode |
| `Ctrl+Shift+M` | Create and open a numbered session in the active pane's directory |
| `Ctrl+Shift+R` | Rename the active tmux session |
| `Ctrl+Shift+E` | Open the End-session confirmation |
| `Ctrl+Shift+Z`, then `T` | Toggle the saved light/dark theme |

The shortcut window provides a browser-safe second route to known actions. In
particular, the defaults `Z` then `E`, `R`, or `H` open End confirmation, Rename,
or fuzzy command search. Open `Shortcuts`, then `Customize`, to change every
direct `Ctrl+Shift` chord and every one-key shortcut-window action. The keymap is
stored by the backend and shared by every browser using this Muxdeck instance;
all visible hints update after saving. Browsers and operating systems may still
reserve a direct chord, so keep a shortcut-window binding as a fallback.

Use `Keymap` in the desktop workspace strip to see these chords in the app.
Muxdeck highlights whether raw Page Up/Page Down or tmux history is preferred for
the active agent, and successful paging-button use remembers that choice locally.

## Deployment and security

Follow [`AGENT_DEPLOYMENT_GUIDE.md`](AGENT_DEPLOYMENT_GUIDE.md) for fresh
installs, state migration, systemd, Caddy, validation, upgrades, and rollback.
Report vulnerabilities through the private process in
[`SECURITY.md`](SECURITY.md).

Keep `MUXDECK_HOST=127.0.0.1`. For a reverse proxy, list each exact external
origin and preserve the browser's `Host` and `Origin` headers:

~~~bash
MUXDECK_TRUSTED_ORIGINS=https://console.example.test
~~~

Origin validation prevents cross-site requests and DNS rebinding; it is not
authentication. To enable Muxdeck's remembered-browser login, provision its
state interactively outside the repository, then select `server` mode and set
the resulting absolute path in the service environment:

~~~bash
.venv/bin/python -m tmux_console.auth provision \
  --path /var/lib/muxdeck/auth.json \
  --username console-admin
export MUXDECK_AUTH_FILE=/var/lib/muxdeck/auth.json
export MUXDECK_AUTH_MODE=server
~~~

The command prompts for the password without echoing it. The file contains only
a salted scrypt password hash and hashes of random remembered-device tokens; it
uses mode `0600` and must never be committed, copied into a source archive, or
placed directly in a systemd unit. The browser receives an `HttpOnly`, `Secure`,
`SameSite=Strict` cookie shared across tabs in that browser profile. Server-side
device tokens have no fixed expiration, while the browser cookie uses the
maximum broadly supported lifetime and is renewed on authenticated requests.
Clearing browser data still removes it. Use **Account** to revoke remembered
browsers or log out.

The same private credential file can instead back standard HTTP Basic
authentication with `MUXDECK_AUTH_MODE=basic`. Muxdeck validates the Basic
credentials but does not issue device cookies or create remembered-browser
records. The browser decides how long to cache those credentials, and HTTP Basic
has no reliable application-level logout; close the browser or clear its saved
site credentials to forget them. A Basic-auth username cannot contain `:`.

Set `MUXDECK_AUTH_MODE=none` only when deliberately relying on loopback, a
private tunnel/network, or a separate authentication layer. Explicit `none`
ignores `MUXDECK_AUTH_FILE`. Explicit `server` and `basic` modes require a valid
private auth file and fail startup closed if it is absent or unsafe. An unknown
mode also prevents startup.

Titles, session names, memos, snippets, workspace state, authentication state,
and uploaded files can contain sensitive information and should remain outside
the source tree.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUXDECK_HOST` | `127.0.0.1` | HTTP listen address |
| `MUXDECK_PORT` | `7683` | HTTP listen port |
| `MUXDECK_BASE_PATH` | `/mux` | API, WebSocket, and SPA prefix |
| `MUXDECK_TRUSTED_ORIGINS` | unset | Exact external origins allowed through a proxy |
| `MUXDECK_AUTH_MODE` | inferred | `server`, `basic`, or `none`; when omitted, an auth file selects `server` and no file selects `none` |
| `MUXDECK_AUTH_FILE` | unset | Absolute path to provisioned credential and remembered-device state; required by `server` and `basic` |
| `MUXDECK_AUTH_COOKIE_SECURE` | `true` | Require HTTPS for the `server`-mode remembered-browser cookie; disable only for intentional direct loopback HTTP development |
| `TMUX_BIN` | `tmux` | tmux executable |
| `MUXDECK_TMUX_SOCKET` | unset | Optional tmux socket name |

The [complete reference](docs/REFERENCE.md#configuration) documents persistence
paths and every runtime setting.

## Development

~~~bash
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
npm test
npm run build
npm run test:e2e
~~~

Python and Playwright end-to-end tests use isolated disposable tmux sockets and
never target the default tmux server.

## Documentation

- [Detailed behavior and complete configuration](docs/REFERENCE.md)
- [Deployment, migration, validation, and rollback](AGENT_DEPLOYMENT_GUIDE.md)
- [Vulnerability reporting and the security boundary](SECURITY.md)
