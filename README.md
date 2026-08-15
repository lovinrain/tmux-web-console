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
- Immutable, paginated history snapshots
- Claude/Codex/Cursor activity states with filters for human and command waits
- Card dashboard by default, with a compact list view and shareable view preferences
- Visible, ordered multi-criterion sorting and optional attention-first state groups
- One-tap, persistent stars that pin frequently used sessions above the rest
- Quick filters for All, Agents, Claude, Codex, Cursor, and Shells
- Optional human titles persisted by tmux session name
- Separate new-window links while card clicks keep same-window navigation
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
default `Ctrl+B` prefix. Use History for retained content from before the browser
attached.

`^A` and `^E` send `Ctrl+A` and `Ctrl+E` respectively, letting compatible shells
and agents move to the beginning or end of their active input. The `Other Keys`
control reveals `Up`, `Down`, `Left`, and `Right` in a secondary row so those
less-frequent controls do not crowd the main shortcut strip.

`Raw keys` focuses the live xterm input. It does not enable a separate mode or
send a control sequence; subsequent keyboard input goes directly to the
application attached through tmux instead of into the staged draft.

The sticky `Name` shortcut in the terminal's bottom bar opens the same optional
human-title editor used by the dashboard. It updates the label shown by Muxdeck,
not the real tmux session name, so attached clients and saved metadata remain
stable.

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

Use the pencil on a session card to add an optional title. The original tmux
session name remains visible and is used as the stable storage key. Saving an
empty title clears it.

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

Selecting the main body of a card or list row opens its console in the current
window. Use the adjacent `New window` link to open that console in a separate
browser context instead. The link carries the current dashboard query, so its
Back action returns to the same filters, view, grouping, and sort priority.

`MUXDECK_TITLES_FILE` stores both optional titles and starred session names,
using the original tmux session name as the key.

`MUXDECK_SNIPPETS_FILE` stores the global folder/snippet tree. Unlike staged
drafts, it lives on the server and is shared across browsers.

## History behavior

Opening History runs `tmux capture-pane` and stores the result in memory for ten
minutes. Older pages come from that immutable snapshot, so live output cannot
cause duplicate or skipped lines while the user reads.

Tmux on this host retains at most 2,000 normal-screen rows. Claude Code commonly
uses the alternate screen, where tmux often retains no previous rows. Muxdeck can
show Claude's current screen but cannot reconstruct alternate-screen content that
tmux never saved.

History follows the pane selected when the web client attaches. If you switch to
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
| `MUXDECK_TITLES_FILE` | `~/.local/state/muxdeck/session-titles.json` | Persistent optional titles and starred session names |
| `MUXDECK_MESSAGES_FILE` | `~/.local/state/muxdeck/session-messages.json` | Persistent per-session memorandum queues |
| `MUXDECK_SNIPPETS_FILE` | `~/.local/state/muxdeck/snippets.json` | Persistent global folder/snippet tree |
| `LOG_LEVEL` | `INFO` | Python log level |

Muxdeck intentionally has no application-level authentication in this MVP. Keep
it behind a trusted reverse proxy or private network until authentication and
controller leases are added.
