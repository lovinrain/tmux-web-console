# Muxdeck

Muxdeck is a small, mobile-friendly web console for tmux. It discovers existing
sessions, attaches a real tmux client over a WebSocket, relays raw terminal input
and output, and captures retained tmux scrollback only when requested.

## MVP features

- Live inventory of every tmux session and pane
- Claude, Codex, Cursor, shell, and process labels
- Exact terminal rendering through xterm.js and a real PTY
- Persistent Light/Dark appearance for the dashboard, dialogs, and terminal palette
- Direct raw-key, control-key, arrow-key, and bracketed-paste input
- Local Page Up/Page Down controls for fixed mobile terminal views
- Permanent dictation-safe staged input with a per-session local draft
- Acknowledged staged delivery that retains uncertain or rejected input
- Persistent per-session memorandum queues with add, edit, delete, load, and send actions
- A persistent hierarchical snippet library with nested folders and safe draft insertion
- Automatic reconnect after a dropped mobile connection
- Immutable, paginated history snapshots in an adjustable desktop drawer
- Claude/Codex/Cursor activity states with filters for human and command waits
- Card dashboard by default, with a compact list view and shareable view preferences
- Visible, ordered multi-criterion sorting and optional attention-first state groups
- One-tap, persistent stars that pin frequently used sessions above the rest
- A persistent ignored bucket for long-running background sessions
- Quick filters for All, Agents, Claude, Codex, Cursor, and Shells
- Optional Muxdeck display aliases, kept separate from native tmux names
- Native tmux session rename with URL, tab, draft, and metadata migration
- Separate new-window links while card clicks keep same-window navigation
- A routed, confirm-before-create flow for starting a fresh default-shell session
- Page-local quick tabs, session switching, and a recently visited trail
- Always-available controls to hide session tabs, staged input, and shortcut keys
- Explicit warning when a full-screen alternate-screen app has no tmux history
- Responsive phone, tablet, and desktop layouts

## Run locally

Requirements: Python 3.11+, tmux 3.x, and Node.js `^20.19.0` or
`>=22.12.0`.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
npm ci
npm run build
.venv/bin/python -m tmux_console.app
```

Open `http://127.0.0.1:7683/mux/`.

For frontend development, run `npm run dev`. Vite runs at
`http://127.0.0.1:5173/mux/` and proxies the API and WebSocket to port 7683.

## Test

```bash
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
npm test
npm run build
npm run test:e2e
```

The Python end-to-end test and Playwright test run on dedicated tmux sockets,
fully isolated from the live tmux server. Even a broad cleanup such as
`kill-server` can only affect the disposable test server.

## Service deployment

For a fresh host, archive migration, systemd service, Caddy, state migration,
validation, rollback, and tmux-safety instructions, follow
[`AGENT_DEPLOYMENT_GUIDE.md`](AGENT_DEPLOYMENT_GUIDE.md). The files under
`deploy/` are templates and must not be installed before all `@@TOKEN@@` values
are rendered.

The minimal local build remains:

```bash
/usr/bin/python3 -m venv .venv
.venv/bin/pip install -e .
npm ci
npm run build
```

## How live terminals work

Each browser WebSocket owns one short-lived PTY running roughly:

```text
tmux attach-session -E -f active-pane -t $SESSION_ID
```

Input from xterm.js is written directly to the PTY. Output from the PTY is sent
as binary WebSocket frames. Closing the tab terminates only that tmux client;
the underlying session and Claude/Codex process continue running.

The staged input box is intentionally separate from the editable line inside the
terminal. Its draft is saved in the current browser under the tmux session name,
which lets iOS dictation and replacement-style input methods finish composing in
a normal textarea without xterm clearing their provisional text. Muxdeck never
tries to merge terminal-side cursor edits back into that local draft.

`Send` and `Send + Enter` take one snapshot of the staged text and wait for the
server to confirm that the complete payload was written to the attached tmux PTY.
With the staged textarea focused, `Shift+Enter` invokes `Send + Enter`; plain
`Enter` remains available for multiline drafts.
Only then is the local draft cleared. A timeout or reconnect leaves it intact and
is never retried automatically, because an unconfirmed retry could execute the
same command twice. The confirmation does not claim that Claude, Codex, or the
shell finished processing the text; it only confirms PTY delivery.

On wider screens, the header exposes two sizing modes:

- `Fit active` lets the browser resize the shared tmux window. This is the useful
  interactive mode on a phone and matches ttyd behavior.
- `Size protected` attaches with tmux's `ignore-size` flag. It does not disturb
  another client's dimensions, but tmux must crop the larger shared window.

Tmux cannot render the same pane at two independent responsive sizes.

The `Theme` control switches the full browser UI and xterm ANSI palette together.
Dark remains the default, and the selected appearance is stored only in that
browser. Changing it never sends terminal input, resizes tmux, or reconnects the
PTY client.

The `PgUp` and `PgDn` controls send real Page Up/Page Down key sequences to the
foreground application, matching a physical keyboard for tools such as Claude
Code. For Codex or other content in tmux history, `Tmux PgUp` sends `Ctrl+B`
followed by Page Up to enter copy mode one page back; `Tmux PgDn` pages down once
that mode is active. `^C` returns to the live pane. The tmux controls assume the
default `Ctrl+B` prefix. Use Scrollback for retained content from before the browser
attached.

On tablet and desktop layouts, drag the left edge of the Scrollback drawer to
change its width. The resize handle also supports Left/Right arrows, Home/End,
and Enter to reset. The chosen width survives SPA navigation in the current page
but resets on reload; phone layouts keep Scrollback full-width.

`^A` and `^E` send `Ctrl+A` and `Ctrl+E` respectively, letting compatible shells
and agents move to the beginning or end of their active input. The `Other Keys`
control reveals `Up`, `Down`, `Left`, and `Right` in a secondary row so those
less-frequent controls do not crowd the main shortcut strip.

`Raw keys` focuses the live xterm input. It does not enable a separate mode or
send a control sequence; subsequent keyboard input goes directly to the
application attached through tmux instead of into the staged draft.

The sticky `Alias` shortcut in the terminal's bottom bar opens the same optional
display-title editor used by the dashboard. It changes only the label shown by
Muxdeck; the native tmux session name and attach target do not change.

The adjacent `Tmux` shortcut renames the real session, equivalent to tmux's
default `Ctrl+B`, then `$` command. A successful rename updates the active route,
all ordered `tab=` values, page-local Recents, and the staged-draft key without
adding a browser-history entry. Muxdeck also migrates the server-side display
alias, star/ignored status, and memoranda. Browser Back and Forward entries that
still contain the old name are canonicalized for the lifetime of the page. As in
tmux itself, names cannot contain a colon or period; Muxdeck also rejects names
ending in a semicolon because tmux parses that final character as a command
separator.

The adjacent `Memo` shortcut opens that session's reusable message queue. Queue
items are stored by the server and remain available across browsers and service
restarts. `Use` copies an item into the local staged draft, while `Send now`
delivers it with Enter using the same acknowledgment protocol. Neither action
deletes the stored item; deletion is always explicit.

The `Snippets` shortcut opens the global snippet library picker. Choosing a
snippet inserts its exact text at the staged textarea's current selection and
never sends automatically. The same picker is available on every dashboard
card/list row and inside memorandum editors. From a dashboard row, choosing a
snippet saves it as that session's local draft and opens the console for review.

Use the top-level `Snippets` section to configure the shared tree. The virtual
library root can contain snippets or folders, folders can nest, and snippets are
always leaves. Items can be renamed, moved between folders, reordered, or
deleted. Saves use a revision check so an older browser cannot silently
overwrite changes made by a newer one.

## Agent state detection

Muxdeck recognizes the live title signals emitted by current Claude Code and
Codex versions. An animated title means the agent is active; for those panes,
Muxdeck inspects only the tail of the visible screen to distinguish explicit
background-command waits from active work. Static Claude/Codex titles indicate
that the agent needs human input. Dead, stale, or unfamiliar signals are marked
Unclear instead of being guessed.

Cursor Agent (`cursor-agent`, also installed as `agent`) names its pane after the
conversation, so its title carries no state. Muxdeck reads the footer of its
visible screen instead, locating it from the last rendered line because Cursor
draws inline rather than filling the pane. A turn counts as live while the footer
shows the interrupt hint or, since typing a follow-up hides that hint, while the
spinner still sits above the input prompt. An approval prompt on the input line
means Cursor is waiting on an answer, and a footer carrying neither signal means
the agent is idle at its input prompt or holding a dialog open.

This is a terminal heuristic, not an agent API. The server samples session state
about once per second and streams changed snapshots to the dashboard with
server-sent events. The browser automatically reconnects and falls back to a
four-second poll if the stream is unavailable; the header shows `live` or
`polling` accordingly.

Muxdeck records when it first observes each state and updates that timestamp only
when the state changes. Transition timestamps are held in memory, so restarting
the service starts a fresh observation timeline.

## Session organization

Use the pencil on a session card to add an optional Muxdeck display alias. The
native tmux session name remains visible underneath it. Saving an empty alias
clears it; renaming the native session from its console preserves the alias.

Cards are the default dashboard view. Use the Cards/List control to switch to a
compact list. Sorting applies identically to both views and is shown as a
numbered priority of badges. For example, `1 State, 2 Title` compares state
first, then uses the optional human title (or tmux name when no title exists) to
order sessions within the same state. Move, remove, or add badges to change that
priority.

Sort directions are fixed and visible in the badges: activity and state-change
time use newest first; titles and tmux names use natural A-Z order (`cx2` before
`cx10`); state uses Needs input, Working, Command wait, Unclear, then Other.
Grouping is independent of sorting. Enabling Group / State splits regular
results into that attention-first state order, then applies the badge criteria
inside each group.

Dashboard controls are encoded in the URL, so a bookmark or shared link restores
the same search, filters, card/list view, grouping, and comparator priority:

```text
/mux/?q=deploy&kind=codex&state=waiting_human&view=list&group=state&sort=state,title
```

Supported sort keys are `activity`, `state`, `state-change`, `title`, and
`tmux-name`, listed from highest to lowest priority after `sort=`. Opening a
console carries the dashboard query with it, and Back restores the exact
dashboard configuration. A bare dashboard URL can still reuse older locally
saved view/sort preferences and then writes them into the URL.

Use the star beside a session title to add or remove it from the pinned section
with one tap. Stars persist across server restarts. Pinned sessions remain
visible above the regular results independently of the active All, Agents,
Claude, Codex, Cursor, or Shells quick filter.

Use the eye-off action to move a long-running background session into the
collapsed `Ignored` section below the filtered results. Ignored sessions do not
contribute to the regular filtered queue or its agent-state counts, but remain
available in that section and can still be opened normally. Restoring one makes
it eligible for the current filters again. Starred and ignored are mutually
exclusive: ignoring a starred session unpins it, while starring an ignored
session restores and pins it. Both choices persist across browser and Muxdeck
restarts.

Selecting the main body of a card or list row opens its console in the current
window. Use the adjacent `New window` link to open that console in a separate
browser context instead. The link carries the current dashboard query, so its
Back action returns to the same filters, view, grouping, and sort priority. A
new window starts with only the selected session in its quick-tab workspace.

The landing-page `New session` action opens `/sessions/new` as a synthetic
workspace tab and waits for explicit confirmation before changing tmux. On
confirmation, Muxdeck assigns a collision-resistant `muxdeck-*` name, starts
tmux's configured default shell in the service user's home directory, and
replaces the route with `/session/:name`. Existing ordered quick tabs stay in
place and the created session is appended. `New window` opens the same
confirmation screen in an isolated browser workspace. The synthetic tab is
represented by the route, never by a fake `tab=` value. Closing the browser
clears only the browser-local workspace state; a successfully created tmux
session remains alive until it is ended through tmux itself.

The top `View` toolbar stays available while the console is open. Its `Tabs`,
`Input`, and `Keys` controls independently collapse the quick-tab strip, staged
composer, and terminal shortcut strip so the terminal can use more of a phone's
screen. These choices remain only in the current React page: they survive SPA
session switches and dashboard round trips, but reset when the page reloads or
the browser tab closes. They do not change the URL or reconnect the terminal.

Below the console header, a horizontally scrollable quick-tab strip selects
another session by replacing the active `/session/:name` URL without adding a
browser-history entry, so browser Back still returns to the filtered dashboard.
The URL includes one ordered `tab=` query parameter per open session; the active
session remains in the path. Only the selected terminal is attached: inactive
quick tabs are lightweight navigation records and cannot resize tmux or consume
background PTY connections.

`Recents` opens the route `/session/:name/recents`. The sheet separates open
quick tabs, closed recently visited sessions, and other sessions currently on
the tmux server. Closing an active tab selects its neighbor; closing the final
tab returns to the dashboard. Browser Back closes a sheet opened from a live
console, and selecting any row updates the canonical active-session URL.

Open quick tabs and their order are URL-backed across console, dashboard, and
Snippets routes. Reloading or sharing that URL restores the ordered tabs, while
the closed-session visit trail remains page-local and clears on reload. Neither
collection is written to the server or `localStorage`. Existing appearance,
dashboard preference, staged-draft, title, star, ignored-session, memorandum,
and snippet storage keep their documented behavior.

`MUXDECK_TITLES_FILE` stores optional display aliases plus starred and ignored
session names in the server-side `session-titles.json` file, keyed by the
current native tmux name. The metadata is shared across browsers and reloaded
when Muxdeck starts. A Muxdeck native rename moves the key to the new name.
Entries for sessions that disappear outside Muxdeck remain dormant; a future
tmux session that reuses such a name inherits its saved alias and organization
status.

The current metadata schema is version 3. Existing version 1 and 2 files load
without migration work and initially have no ignored sessions; the next title,
star, or ignored-status write atomically rewrites the file as version 3. Keep a
pre-upgrade copy when rollback is possible. Older releases that only write
version 1 or 2 ignore the version 3 ignored list and will discard it on their
next title or star write.

`MUXDECK_SNIPPETS_FILE` stores the global folder/snippet tree. Unlike staged
drafts, it lives on the server and is shared across browsers.

## Scrollback behavior

Opening Scrollback runs `tmux capture-pane` and stores the result in memory for ten
minutes. Older pages come from that immutable snapshot, so live output cannot
cause duplicate or skipped lines while the user reads.

Tmux on this host retains at most 2,000 normal-screen rows. Claude Code commonly
uses the alternate screen, where tmux often retains no previous rows. Muxdeck can
show Claude's current screen but cannot reconstruct alternate-screen content that
tmux never saved.

Scrollback follows the pane selected when the web client attaches. If you switch to
another tmux pane or window from inside the live terminal, return to the session
list and reopen it before capturing that pane's history.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUXDECK_HOST` | `127.0.0.1` | HTTP listen address |
| `MUXDECK_PORT` | `7683` | HTTP listen port |
| `MUXDECK_BASE_PATH` | `/mux` | API, WebSocket, and SPA prefix |
| `TMUX_BIN` | `tmux` | tmux executable |
| `MUXDECK_TMUX_SOCKET` | unset | Optional tmux socket name, used to isolate tests |
| `MUXDECK_TITLES_FILE` | `~/.local/state/muxdeck/session-titles.json` | Persistent titles plus starred and ignored session names |
| `MUXDECK_MESSAGES_FILE` | `~/.local/state/muxdeck/session-messages.json` | Persistent per-session memorandum queues |
| `MUXDECK_SNIPPETS_FILE` | `~/.local/state/muxdeck/snippets.json` | Persistent global folder/snippet tree |
| `LOG_LEVEL` | `INFO` | Python log level |

Muxdeck intentionally has no application-level authentication in this MVP. Keep
it behind a trusted reverse proxy or private network until authentication and
controller leases are added.
