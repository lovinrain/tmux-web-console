# Muxdeck

Muxdeck is a small, mobile-friendly web console for tmux. It discovers existing
sessions, attaches a real tmux client over a WebSocket, relays raw terminal input
and output, and captures retained tmux scrollback only when requested.

## MVP features

- Live inventory of every tmux session and pane
- Claude, Codex, Copilot, Cursor, Grok, shell, and process labels
- Exact terminal rendering through xterm.js and a real PTY
- Persistent Light/Dark appearance for the dashboard, dialogs, and terminal palette
- Direct raw-key, control-key, arrow-key, and bracketed-paste input
- Local Page Up/Page Down controls for fixed mobile terminal views
- Permanent dictation-safe staged input with a per-session local draft
- Acknowledged staged delivery that retains uncertain or rejected input
- Persistent per-session memos for drafts, scratch notes, and explicitly queued input
- A persistent hierarchical snippet library with nested folders and safe draft insertion
- Automatic reconnect after a dropped mobile connection
- Immutable, paginated history snapshots in an adjustable desktop drawer
- Conservative activity states for supported agent CLIs
- Card dashboard by default, with a compact list view and shareable view preferences
- Visible, ordered multi-criterion sorting and optional attention-first state groups
- Persistent predefined session tags with tag search, grouping, and include/exclude filters
- One-tap, persistent stars that pin frequently used sessions above the rest
- A persistent ignored bucket for long-running background sessions
- Quick filters for All, Agents, Claude, Codex, Copilot, Cursor, Grok, and Shells
- Optional Muxdeck display aliases, kept separate from native tmux names
- Native tmux session rename with URL, tab, draft, and metadata migration
- Confirmed whole-session termination targeted by stable tmux identity
- Separate new-window links while card clicks keep same-window navigation
- A routed, confirm-before-create flow for starting a fresh default-shell session
- Named server-backed workspaces, ordered horizontal/vertical tabs, desktop shortcuts, and title search
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
the underlying session and foreground process continue running.

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
same command twice. The confirmation does not claim that the agent or shell
finished processing the text; it only confirms PTY delivery.

`Queue in memo` moves the same exact staged snapshot to the current session's
server-backed memo without writing anything to tmux and marks it as queued input.
It remains available when the terminal is disconnected. The local draft is
cleared only after persistence succeeds; a validation, session, storage, or
network failure leaves the draft intact for retry. Whitespace-only drafts cannot
be queued.

On wider screens, the header exposes two sizing modes:

- `Fit active` lets the browser resize the shared tmux window. This is the useful
  interactive mode on a phone and matches ttyd behavior.
- `Size protected` attaches with tmux's `ignore-size` flag. It does not disturb
  another client's dimensions, but tmux must crop the larger shared window.

Tmux cannot render the same pane at two independent responsive sizes.

The `Theme` control switches the full browser UI and xterm ANSI palette together.
Dark remains the default, and the selected appearance is stored only in that
browser. The Theme toggle never sends terminal input, resizes tmux, or reconnects
the PTY client.

When Muxdeck creates a session with tmux 3.2 or newer, it gives the new shell
`GROK_THEME=auto` and the browser's current `GROK_APPEARANCE=dark|light` value.
Grok Build launched from that shell therefore follows the selected appearance
without requiring `/theme`, while Grok's `auto_dark_theme` and
`auto_light_theme` settings still choose the concrete color schemes. Muxdeck
does not rewrite Grok's saved configuration or type into the terminal.

The startup appearance is fixed when tmux creates the shell. Changing the
browser theme later does not alter an already-running session. To override the
inherited behavior for one launch, use an explicit value such as
`GROK_THEME=tokyonight grok`; unset `GROK_THEME` before launching to use Grok's
saved theme preference instead. tmux 3.0 and 3.1 cannot set a per-session
environment during creation, so Muxdeck still creates the session, logs a
warning, and omits both Grok startup hints.

The shortcut strip in `Input` mode sends terminal input. Its `PgUp` and `PgDn`
controls send real Page Up/Page Down key sequences to the foreground application,
matching a physical keyboard for tools such as Claude Code. For Codex or other
content in tmux history, `Tmux PgUp` sends `Ctrl+B` followed by Page Up to enter
copy mode one page back; `Tmux PgDn` pages down once that mode is active. `^C`
returns to the live pane. The tmux controls assume the default `Ctrl+B` prefix.

The phone `Terminal` layout has a separate tmux-history rail. `Page up` enters
tmux copy mode one page back, `Page down` moves toward the current output, and
`Live` safely cancels copy mode, jumps to current output, and focuses raw terminal
input. Desktop keeps the same `Live` action in the bottom terminal shortcut
strip beside the other input buttons. These actions use explicit WebSocket
control messages dispatched to the exact tmux attachment. The server verifies
that attachment's process and stable session ID, then lets tmux resolve its
client-local active pane. No history action sends key bytes to or interrupts the
foreground application. The history actions are available while the terminal
connection is live; `Focus` / `Exit` remains available even during a reconnect.
Use Scrollback for a separate retained snapshot.

On tablet and desktop layouts, drag the left edge of the Scrollback drawer to
change its width. The resize handle also supports Left/Right arrows, Home/End,
and Enter to reset. The chosen width survives SPA navigation in the current page
but resets on reload; phone layouts keep Scrollback full-width.

`^A`, `^E`, and `^K` send `Ctrl+A`, `Ctrl+E`, and `Ctrl+K` respectively, letting
compatible shells and agents move to the beginning or end of their active input,
or delete from the cursor to the end. The `Other Keys` control reveals `Up`,
`Down`, `Left`, and `Right` in a secondary row so those less-frequent controls do
not crowd the main shortcut strip.

`Raw keys` focuses the live xterm input. It does not enable a separate mode or
send a control sequence; subsequent keyboard input goes directly to the
application attached through tmux instead of into the staged draft.

On desktop, `Focus` in the top `VIEW` toolbar expands the live terminal to the
full browser viewport and leaves only a floating `Exit` control. It does not invoke
the browser Fullscreen API, remount xterm, reconnect the WebSocket, change the
URL, or discard the staged draft. Entering and leaving refits the existing PTY
attachment so tmux receives the new dimensions. The choice is session-local and
resets when the active session changes, the workspace overview opens, the layout
switches to mobile, the console is left, or the page reloads. Escape remains raw
terminal input rather than an exit shortcut; `Ctrl+Shift+F` exits Focus even
while xterm owns keyboard focus.

The sticky `Details` shortcut in the terminal's bottom bar opens the same title
and tag editor used by the dashboard. The optional display title changes only
the label shown by Muxdeck; the native tmux session name and attach target do not
change. Tags are predefined Muxdeck metadata and never send terminal input.

The desktop bottom bar's `Redraw` shortcut asks xterm to rebuild its renderer and
repaint the buffered terminal when glyphs or colors become visually corrupted.
It does not reconnect, reset terminal state, send input, or resize the tmux pane.

The adjacent `Tmux` shortcut renames the real session, equivalent to tmux's
default `Ctrl+B`, then `$` command. A successful rename updates the active route,
all ordered `tab=` values, page-local Recents, and the staged-draft key without
adding a browser-history entry. Muxdeck also migrates the server-side display
alias, tags, star/ignored status, and memoranda. Browser Back and Forward entries that
still contain the old name are canonicalized for the lifetime of the page. As in
tmux itself, names cannot contain a colon or period. Muxdeck also rejects
backslashes, unsafe line separators, and names ending in a semicolon because they
cannot be round-tripped safely through tmux's command and inventory formats.

The adjacent `Memo` shortcut opens durable space for drafts, staged thoughts,
scratch notes, and reusable prompts. New items written in the drawer default to
notes; choose `Queue next` only for text intended as a future session input.
Queued items appear first and drive the amber `Q` indicators on mobile Input,
the Memo shortcut, Overview rows, and dashboard cards. `Stage` copies an item
into the local staged draft and moves queued items back to notes. If that exact,
unchanged staged snapshot is later acknowledged by the terminal, its source memo
is removed; editing the staged text turns it into an independent draft and leaves
the source memo untouched. `Send now` likewise delivers with Enter and removes
the item only after acknowledgment. Before directly sending a queued item, Memo
first persists its move back to notes; if that update fails, nothing is sent.
Unconfirmed deliveries remain as notes for manual resolution. If delivery is
acknowledged but automatic deletion fails, the sent note remains visible with
guidance to delete it manually without accidentally running it twice.

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

Muxdeck recognizes the live title signals emitted by current Claude Code, Codex,
and Grok Build versions. An animated title means the agent has an active turn;
for those panes, Muxdeck inspects the visible screen to distinguish foreground
work from `Background work`. That state means the parent agent is parked on
commands, background agents, or dynamic workflows: no human action is required,
but the terminal remains available for steering input. Claude's latest
column-zero activity headline is decisive across the visible pane, so an older
wait banner does not hide resumed work and a dense task panel does not hide the
current wait. Static titles indicate that the agent needs human input.
Dead, stale, or unfamiliar signals are marked Unclear instead of being guessed.
Grok Build is recognized when the active pane command is `grok`, which is also
the command used to launch it normally. Its working title begins with an animated
braille frame; its idle title is `grok` or ends in `- grok` after the conversation
receives a title.

GitHub Copilot CLI is recognized by the standalone `copilot` command. The
official npm launcher keeps `node` as tmux's foreground command while it runs the
native child, so Muxdeck also recognizes that exact process shape when its pane
title is `GitHub Copilot` or ends in ` - GitHub Copilot`; arbitrary Node panes
remain ordinary processes. Copilot does not currently expose a stable
interactive-state signal through tmux that Muxdeck can safely use to separate an
active turn, an idle prompt, a permission dialog, and idle background work.
Copilot sessions therefore participate in the agent inventory and filters but
remain Unclear instead of guessing that they are working or need input.

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

Use the pencil on a session card to edit its optional Muxdeck display alias and
tags. The native tmux session name remains visible underneath it. Saving an empty
alias clears it; changing the alias and tags together commits both in one metadata
write. Renaming the native session from its console preserves the alias and tags.
Tags use a fixed vocabulary: `Work`, `Review`, `Research`, `Urgent`,
`Blocked`, and `Background`. They are shared across browsers, survive server
restarts, and appear as compact badges in both card and list views.

Cards are the default dashboard view. Use the Cards/List control to switch to a
compact list. Sorting applies identically to both views and is shown as a
numbered priority of badges. For example, `1 State, 2 Title` compares state
first, then uses the optional human title (or tmux name when no title exists) to
order sessions within the same state. Move, remove, or add badges to change that
priority.

Sort directions are fixed and visible in the badges: activity and state-change
time use newest first; titles and tmux names use natural A-Z order (`cx2` before
`cx10`); state uses Needs input, Working, Background work, Unclear, then Other.
Grouping is independent of sorting. Enabling Group / State splits regular
results into that attention-first state order, then applies the badge criteria
inside each group. Group / Tags uses the fixed tag order followed by `Untagged`.
A session with several tags appears in every matching tag group; the summary
count remains the number of unique filtered sessions.

Dashboard controls are encoded in the URL, so a bookmark or shared link restores
the same search, filters, card/list view, grouping, and comparator priority:

```text
/mux/?q=deploy&kind=codex&state=waiting_human&view=list&group=state&sort=state,title
```

Tag filters use repeated parameters. Included tags are ORed with each other and
then ANDed with search, agent type, and state; excluded tags always subtract a
match. For example, this shows Work or Review sessions except anything also
marked Blocked:

```text
/mux/?tag=work&tag=review&not-tag=blocked
```

The visible `Exclude matches` control reverses every active tag filter in one
step and changes subsequent tag clicks to exclusions; `Include matches` swaps
them back. Included chips show `+`; excluded chips show `-` plus a red hatched
treatment. The URL keeps both sets independently, removes invalid or duplicate
values, and serializes them in the predefined order. If a malformed URL contains
the same tag in both sets, exclusion wins. Tag names also participate in text
search. Unlike the kind/state/search facets, tag inclusion and exclusion applies
before the Starred, filtered, and Ignored sections are partitioned, so a
reverse-filtered session cannot remain visible elsewhere.

The canonical background-work filter is `state=waiting_command`. Muxdeck also
accepts the more readable `state=background-work` and the older
`state=command-wait`, then canonicalizes either alias without breaking saved
links.

Supported sort keys are `activity`, `state`, `state-change`, `title`, and
`tmux-name`, listed from highest to lowest priority after `sort=`. Opening a
console carries the dashboard query with it, and Back restores the exact
dashboard configuration. A bare dashboard URL can still reuse older locally
saved view/sort preferences and then writes them into the URL.

Use the star beside a session title to add or remove it from the pinned section
with one tap. Stars persist across server restarts. Pinned sessions remain
visible above the regular results independently of the active All, Agents,
Claude, Codex, Copilot, Cursor, Grok, or Shells quick filter. The tag facet still
applies, including hard exclusions.

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

The landing page lists named saved workspaces in rough last-active order. `New
workspace` starts with an empty tab set by default; choose `Copy current tabs`
when the new workspace should instead inherit this browser page's open tabs and
their order. Creating either kind writes a separate server record before opening
it, so the workspace you came from is unchanged. A saved workspace can be
resumed, renamed, or deleted from that list. Deleting one removes only the saved
tab group; none of these workspace actions stops, renames, or sends input to a
tmux session.

An unsaved multi-tab console identifies itself as `Temporary workspace` and
exposes `Save workspace` directly in its tab bar. On phone layouts, the identity
and save action are repeated in `Overview`. After naming the workspace, the
current console stays open, its saved name replaces the temporary label, and its
URL gains the stable workspace identifier. The accompanying `Saved`, `Opening`,
or `Sync issue` state reports whether later tab-order and active-session changes
are synchronizing automatically.

Each saved workspace keeps its name, ordered open tabs, active session, and
server-generated creation, update, and last-active times in
`MUXDECK_WORKSPACES_FILE`. Opening or changing a saved workspace refreshes its
rough last-active time. Workspace names and tab membership are shared by every
browser connected to the same Muxdeck instance, so a phone or another computer
can resume the same group. Concurrent pages use last-write-wins semantics; the
most recently accepted full tab/activity update becomes the saved state. Each
snapshot also carries the server's native-session rename revision. If another
device tries to save names captured before a Muxdeck rename, the server rejects
that stale snapshot and the page reloads the migrated workspace instead of
restoring an obsolete tmux name.

The stable `workspace=` query parameter identifies a saved workspace without
putting its editable name in the route. Ordered `tab=` values remain in the URL
for navigation and backward-compatible ad hoc workspaces. When a saved workspace
is loaded, its server record is authoritative. A URL with `tab=` values but no
`workspace=` remains an unsaved browser workspace; its `Resume workspace` action
returns to the most recently active open tab without changing their order.

The landing-page `New session` action opens `/sessions/new` as a synthetic
workspace tab and waits for explicit confirmation before changing tmux. On
confirmation, Muxdeck uses the optional native tmux name entered in the form or
assigns a collision-resistant `muxdeck-*` name when the field is empty. It starts
tmux's configured default shell in the service user's home directory and replaces
the route with `/session/:name`. Existing ordered quick tabs stay in place and the
created session is appended. `New window` opens the same confirmation screen in
an isolated browser workspace. The synthetic tab is represented by the route,
never by a fake `tab=` value. A successfully created tmux session remains alive
until it is ended through tmux itself, independently of whether its quick tab is
saved in a named workspace.

Whole-session termination is available from the console's bottom `End` control,
the trash action on each landing-page session in both Cards and List views, every
live session row in workspace Overview, and the trash icon on each live workspace
quick tab. Each entry point opens the same explicit confirmation before changing
tmux. The `X` on a quick tab is intentionally different: it only removes that tab
from the current browser workspace, while the tmux session and its programs keep
running. Confirming `End` or a trash action terminates the tmux session itself,
closing every pane and disconnecting every client attached to it.

The confirmation names both the display alias and native tmux name when they
differ, starts focus on `Cancel`, and remains open with an error if tmux rejects
the request. Muxdeck binds the confirmation to the native name, tmux session ID,
creation time, and tmux server generation, then rechecks that identity atomically
with the kill. A stale page therefore cannot terminate a replacement after name
or ID reuse. Retrying after a lost success response is safe and idempotent. After
success, Muxdeck removes the session's quick tab if it is open; when that tab was
active, routing selects its neighbor or returns to the landing page. The current
saved workspace synchronizes that tab removal; memoranda, display metadata,
recent history, and references from other saved workspaces are retained rather
than silently deleted.

On phones, the top purpose switcher gives the console three mutually exclusive
layouts. `Overview` opens the routed, status-labelled workspace session list;
`Terminal` is the fresh-load default and keeps the compact identity header,
readable 13px terminal, and tmux-history rail; `Input` keeps terminal context
above the staged composer and input-sending shortcut strip. A Needs input session
marks the Input choice in amber, but live status changes never open the keyboard
or pull the user away from terminal context automatically. Explicitly entering
Input focuses the saved draft, while leaving it blurs the field and dismisses the
mobile keyboard.

`Focus` on the Terminal rail enters a distraction-free layout containing only
the terminal and that rail; the control becomes `Exit` so the normal purpose
switcher and identity header are always recoverable. Entering or leaving Focus
does not remount the terminal, reconnect its WebSocket, change the URL, or discard
the staged draft. The distraction-free choice resets when the active session
changes, Overview or Input is selected, the workspace overlay opens, the console
is left, or the page is reloaded.

The mobile purpose choice remains only in the current React page: it survives
SPA session switches and dashboard round trips, resets to Terminal on reload,
and never changes the URL, saved workspace, or terminal connection. The wider
desktop layout retains the independent `Tabs`, `Input`, and `Keys` visibility
controls. The console also follows `visualViewport` height and offset on iOS so
the composer and send actions remain inside the visible area while the software
keyboard moves.

Below the console header, the quick-tab strip selects another session by replacing
the active `/session/:name` URL without adding a browser-history entry, so browser
Back still returns to the filtered dashboard. `Side tabs` in the desktop `VIEW`
toolbar moves that strip into a vertically scrolling left rail; pressing it again
returns the tabs to the top. This orientation is a browser-local display preference
that survives reloads and session/New-session navigation, but it is not written to
the workspace record or URL. Compact mobile layouts keep their horizontal/Overview
navigation regardless of the desktop preference.

The side rail's right-edge grip resizes it from a 72px numbered icon rail to a
480px wide title view. As the rail narrows, text and secondary tab controls collapse
in stages instead of forcing a wide minimum; the same reorder, close, and terminate
actions remain available from Recents. Left/Right resize by 8px, Shift uses 32px,
Home/End jump to the limits, and Enter or double-click restores the 288px default.
Width is browser-local and follows console and New-session navigation.

The URL includes one ordered `tab=` query parameter per open session; the active
session remains in the path. Only the selected terminal is attached: inactive
quick tabs are lightweight navigation records and cannot resize tmux or consume
background PTY connections.

The fixed `+` button beside `Sessions` opens `New session` in that
workspace without a dashboard round trip. Opening or canceling the form does not
change saved tabs: Cancel or the synthetic tab's `X` returns to the console it
replaced. A successful creation appends the real session tab and synchronizes it
when the workspace is saved. If a saved workspace is still opening, creation
waits until its authoritative tab list has loaded rather than racing that state.

Each desktop quick tab has directional move controls: left/right in the top strip
and up/down in the side rail. Reordering keeps the active session selected and
immediately rewrites the ordered `tab=` parameters in the current history entry.
The tablist uses the matching arrow-key axis for keyboard focus. In the compact
mobile layout, open rows in Overview expose the same reorder action as up/down
controls, including while the session list is filtered.

On desktop, `Ctrl+Shift+,` and `Ctrl+Shift+.` select the previous or next open
tab and wrap at either end. `Ctrl+Shift+1` through `Ctrl+Shift+9` select that
numbered open tab directly; both the number row and numeric keypad work, and a
position that is not open is a no-op. `Ctrl+Shift+;` opens the `Find tab`
palette, which ranks matches against both the custom display title and native
tmux name; arrow keys choose a result and Enter jumps directly to it. These
exact chords remain available while xterm or staged input owns focus, while
unrelated browser/editor commands such as `Ctrl+/` pass through untouched. All
workspace shortcuts pause behind a modal dialog and are disabled in the compact
mobile layout, where Overview remains the session-switching surface.

`Recents` opens the route `/session/:name/recents`. The sheet separates open
quick tabs, closed recently visited sessions, and other sessions currently on
the tmux server. Closing an active tab selects its neighbor; closing the final
tab returns to the dashboard. Browser Back closes a sheet opened from a live
console, and selecting any row updates the canonical active-session URL.

Open quick tabs and their order are URL-backed across console, dashboard, and
Snippets routes. Reloading or sharing an ad hoc URL restores its ordered tabs.
When `workspace=` is present, Muxdeck also synchronizes the ordered tabs and
active session to the server so another device can resume them. The
closed-session visit trail remains page-local and clears on reload; it is not
part of a saved workspace. Existing appearance, dashboard preference,
staged-draft, title, tag, star, ignored-session, memorandum, and snippet storage keep
their documented behavior.

`MUXDECK_TITLES_FILE` stores optional display aliases, predefined tags, and
starred and ignored session names in the server-side `session-titles.json` file,
keyed by the current native tmux name. The metadata is shared across browsers
and reloaded when Muxdeck starts. A Muxdeck native rename moves the key to the
new name.
Entries for sessions that disappear outside Muxdeck remain dormant; a future
tmux session that reuses such a name inherits its saved alias and organization
status.

The current metadata schema is version 4. Existing version 1 through 3 files
load without a separate migration command and initially have no tags; the next
title, tag, star, or ignored-status write atomically rewrites the file as version
4. Keep a pre-upgrade copy when rollback is possible. A release that only knows
version 3 will discard tags on its next metadata write; releases that only know
version 1 or 2 can additionally discard ignored status. An unreadable,
malformed, or unsupported future metadata document disables metadata writes
instead of being replaced; repair the configured file and restart Muxdeck.

`MUXDECK_SNIPPETS_FILE` stores the global folder/snippet tree. Unlike staged
drafts, it lives on the server and is shared across browsers.

`MUXDECK_WORKSPACES_FILE` stores the global saved-workspace list. Tabs are keyed
by native tmux session name. A native rename performed through Muxdeck migrates
that name in every saved workspace; an out-of-band tmux rename cannot do so.
Unavailable names remain visible in the saved group until the workspace is
updated or deleted. The file contains workspace names and tmux session names, so
treat it as potentially sensitive runtime state.

The workspace schema is version 2. Version 1 files load at rename revision zero
and upgrade atomically on the next write. A workspace name is limited to 80
characters and a workspace can contain at most 32 unique ordered tabs. Writes
use an atomic file replacement. Keep a pre-upgrade copy when rollback is
possible because a version-1-only release rejects the version 2 document. If an
existing workspace file is unreadable, malformed, or uses an unsupported
schema, the workspace API returns `503` and refuses to overwrite it until the
file is repaired and Muxdeck is restarted.

## Scrollback behavior

Opening Scrollback runs `tmux capture-pane` and stores the result in memory for ten
minutes. Older pages come from that immutable snapshot, so live output cannot
cause duplicate or skipped lines while the user reads.

Tmux on this host retains at most 2,000 normal-screen rows. Claude Code commonly
uses the alternate screen, and Grok Build defaults to it, where tmux often retains
no previous rows. Muxdeck can show the current screen but cannot reconstruct
alternate-screen content that tmux never saved.

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
| `MUXDECK_TITLES_FILE` | `~/.local/state/muxdeck/session-titles.json` | Persistent titles, predefined tags, and starred/ignored session names |
| `MUXDECK_MESSAGES_FILE` | `~/.local/state/muxdeck/session-messages.json` | Persistent per-session notes and queued memo input |
| `MUXDECK_SNIPPETS_FILE` | `~/.local/state/muxdeck/snippets.json` | Persistent global folder/snippet tree |
| `MUXDECK_WORKSPACES_FILE` | `~/.local/state/muxdeck/workspaces.json` | Persistent named workspaces, ordered tabs, and activity times |
| `LOG_LEVEL` | `INFO` | Python log level |

Muxdeck intentionally has no application-level authentication in this MVP. Keep
it behind a trusted reverse proxy or private network until authentication and
controller leases are added.
