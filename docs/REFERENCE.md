# Muxdeck Reference

This guide documents Muxdeck's terminal, agent-state, workspace, persistence,
and routing behavior in detail. For a quick introduction and local setup, see
[`README.md`](../README.md). For production deployment, migration, validation,
and rollback, use [`AGENT_DEPLOYMENT_GUIDE.md`](../AGENT_DEPLOYMENT_GUIDE.md).

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

`Send`, `Send + Enter`, and `Send + Tab` take one snapshot of the staged text and
wait for the server to confirm that the complete payload was written to the
attached tmux PTY. `Send + Enter` follows that snapshot with a terminal Enter;
`Send + Tab` follows it with a terminal Tab, rather than inserting a tab into the
local draft.
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
browser. In a desktop workspace it is also available through fuzzy command search
or `Ctrl+Shift+Z`, then `T`; the visible Theme button remains available on the
landing page and compact layouts. The Theme toggle never sends terminal input,
resizes tmux, or reconnects the PTY client.

On desktop, `Copy New` starts a fresh detached shell in the active pane's current
working directory and immediately opens it as the active workspace tab. The
server tries `<source>_1`, then increments the suffix until it can atomically
claim an available tmux session name. `Ctrl+Shift+M` invokes the same action.
The button and shortcut are unavailable in compact mobile layouts.

`Split workspace` is the non-mutating browser-workspace counterpart beside that
control. It opens the current native session alone in a separate no-opener
window, removes the saved-workspace ID and tab groups from the destination URL,
and leaves the source tab exactly where it was. The new window is temporary
until its own `Save workspace` action is used; splitting never creates, copies,
renames, resizes, or sends input to a tmux session. A blocked pop-up leaves the
source unchanged and produces a dismissible error.

When Muxdeck creates a session with tmux 3.2 or newer, it gives the new shell
`GROK_THEME=auto` and the browser's current `GROK_APPEARANCE=dark|light` value.
Grok Build launched from that shell therefore follows the selected appearance
without requiring `/theme`, while Grok's `auto_dark_theme` and
`auto_light_theme` settings still choose the concrete color schemes. Muxdeck
does not rewrite Grok's saved configuration or type into the terminal.

The startup appearance is fixed when tmux creates the shell. Changing the
browser theme later does not alter an already-running session. When the active
pane is Grok, the console therefore shows an `Apply to Grok` action beside the
browser theme control. It loads the matching `/theme groknight` or
`/theme grokday` command into staged input for review and sends no terminal
bytes until `Send + Enter` is chosen. Grok saves a submitted `/theme` choice to
its user configuration, so the command is never injected automatically. Grok's
minimal mode already uses the terminal palette and does not support `/theme`.

To override the inherited behavior for one launch, use an explicit value such as
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

Muxdeck highlights the paging pair preferred for the detected foreground agent
in both the phone terminal rail and desktop shortcut strip. Claude, Copilot,
Cursor, and Grok start with application `PgUp` / `PgDn`; Codex, shells, and
unrecognized processes start with the tmux pair. Successfully using either pair
teaches that choice for the agent kind and stores it as a browser-local preference,
so the highlight follows that agent across sessions, workspaces, and reloads.
`Ctrl+Shift+U` and `Ctrl+Shift+D` invoke the highlighted Page Up and Page Down
actions on desktop.

The phone `Terminal` layout exposes both paging pairs. `Tmux Page up` enters tmux
copy mode one page back, `Tmux Page down` moves toward the current output, and
`Live` safely cancels copy mode, jumps to current output, and focuses raw terminal
input. Desktop keeps the same `Live` action in the bottom terminal shortcut strip
beside the other input buttons. The tmux actions use explicit WebSocket control
messages dispatched to the exact attachment. The server verifies that attachment's
process and stable session ID, then lets tmux resolve its client-local active pane.
No history action sends key bytes to or interrupts the foreground application.
The history actions are available while the terminal connection is live; `Focus`
/ `Exit` remains available even during a reconnect. Use Scrollback for a separate
retained snapshot.

On tablet and desktop layouts, drag the left edge of the Scrollback drawer to
change its width. The resize handle also supports Left/Right arrows, Home/End,
and Enter to reset. The chosen width survives SPA navigation in the current page
but resets on reload; phone layouts keep Scrollback full-width.

`^A`, `^E`, and `^K` send `Ctrl+A`, `Ctrl+E`, and `Ctrl+K` respectively, letting
compatible shells and agents move to the beginning or end of their active input,
or delete from the cursor to the end. `^Q` sends a literal `Ctrl+Q` byte, which
Copilot CLI uses to enqueue its current prompt. The `Other Keys` control reveals
`Up`, `Down`, `Left`, and `Right` in a secondary row so those less-frequent
controls do not crowd the main shortcut strip.

`Raw keys` focuses the live xterm input. It does not enable a separate mode or
send a control sequence; subsequent keyboard input goes directly to the
application attached through tmux instead of into the staged draft.

On desktop, `Copy` in the top `VIEW` toolbar temporarily gives mouse selection
to Muxdeck instead of the foreground TUI. Drag, double-click, and triple-click
use xterm's local text selection even when the agent has enabled terminal mouse
reporting; `Ctrl+C` / `Ctrl+V` (or `Cmd+C` / `Cmd+V` on macOS) then use the
browser clipboard, and the wheel navigates local scrollback. Turning `Copy` off
clears the local selection and returns mouse input to the TUI. The choice is
ephemeral and resets on session changes, workspace overview, mobile layout,
desktop Focus, or reload.

On desktop, `Focus` in the top `VIEW` toolbar expands the live terminal to the
full browser viewport and leaves floating `Redraw`, `Show all buttons`, and
`Exit` controls. `Show all buttons` overlays the existing bottom shortcut strip
as a wrapped floating panel, including `More Keys`; it does not shrink the
terminal or create duplicate actions. Drag the panel's `Move panel` handle to
place it anywhere within the viewport. With that handle focused, the arrow keys
move it by 16 pixels, Shift+Arrow moves it by 64 pixels, and Enter or Home resets
it to the centered bottom position. Hiding and reopening the panel preserves its
position until Focus ends. Actions that reveal staged input leave Focus so the
composer is visible. Focus does not invoke the browser Fullscreen API, remount
xterm, reconnect the WebSocket, change the URL, or discard the staged draft.
Entering and leaving refits the existing PTY attachment so tmux receives the new
dimensions. The choice is session-local and resets when the active session
changes, the workspace overview opens, the layout switches to mobile, the
console is left, or the page reloads. Escape remains raw terminal input rather
than an exit shortcut; `Ctrl+Shift+F` enters or exits Focus even while xterm or
staged input owns keyboard focus.

The sticky `Details` shortcut in the terminal's bottom bar opens the same title
and tag editor used by the dashboard. The optional display title changes only
the label shown by Muxdeck; the native tmux session name and attach target do not
change. Tags are predefined Muxdeck metadata and never send terminal input.

The desktop bottom bar and full-screen focus overlay provide a `Redraw` shortcut
that asks xterm to rebuild its renderer and repaint the buffered terminal when
glyphs or colors become visually corrupted.
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

On desktop, `Insert snippet` beside the staged-input heading opens the global
snippet library without moving the textarea's cursor or selection. The
bottom-strip `Snippets` shortcut remains an alternate entry point. Choosing a
snippet inserts its exact text at the current selection and never sends
automatically. The same picker is available on every dashboard card/list row
and inside memorandum editors. From a dashboard row, choosing a snippet saves
it as that session's local draft and opens the console for review.

`Attach files` is the adjacent desktop-only attachment flow. The file picker, a
file pasted into the staged textarea, and files dropped over the composer all
use the same behavior. Muxdeck accepts any non-empty file, limits each file to
12 MiB, and stores it with private permissions under `MUXDECK_UPLOADS_DIR`. A
selection can contain up to six files. Their shell-safe absolute host paths are
inserted at the textarea's current cursor; nothing is sent to tmux until the
user reviews the draft and chooses a send action. Compact cards show the
original name and full host path; browser-recognized images get a thumbnail and
other file types get an attachment icon. Closing a card dismisses only the card,
while `Copy path` copies the exact staged token. The host file remains available
to the CLI agent and is not deleted when the draft is cleared or sent.

The live terminal is a second desktop-only drop target. Dropping files over it
performs the same private upload, then sends the returned shell-safe paths
through the acknowledged terminal-input channel. Muxdeck adds
a trailing space for the next word but deliberately sends no Enter key, so the
path remains at the active shell or agent cursor for review. The terminal drop
overlay reports upload progress and keeps a copyable path if delivery loses its
connection. Switching sessions aborts an in-flight drop rather than inserting
an old session's path into the newly selected terminal. A browser cannot put
file bytes directly into a generic PTY; the host-readable path is the portable
handoff supported across shells and coding-agent TUIs.

The upload directory has a 512 MiB application cap. Muxdeck refuses additional
uploads with a visible storage error instead of deleting referenced files
automatically. An operator can archive or remove old files directly from the
configured directory. File attachments are deliberately hidden in compact
mobile layouts.

The working-directory line beneath the desktop session title opens a separate
movable and resizable file browser. It opens at the live pane CWD and can be
pointed elsewhere: `Go up` keeps stepping above that directory, and the address
row takes an absolute file or directory path (`~` is expanded by the server).
A directory opens in place. A regular file opens its parent directory, selects
that exact entry, and immediately starts its text, image, or binary preview; this
still works for a hidden file or when a large parent listing is truncated before
the requested entry. `Pane cwd` returns to the pane's own directory, and the first breadcrumb
shows `cwd` only while the browser is actually there. How far it may be pointed
is set by `MUXDECK_FILE_BROWSER_ROOT`, which defaults to the whole filesystem;
`Go up` stops being offered at that boundary, a path outside it is refused, and a
pane whose own working directory sits outside it cannot be browsed either.
Folder listing, UTF-8 previews, raster-image streams, downloads, uploads, and
every edit repeat the live tmux session and pane identity check, and each one is
confined to the directory currently being browsed, so symlinks that resolve
outside it remain inaccessible. Text preview remains capped at 1 MiB. Signature-verified PNG,
JPEG, GIF, WebP, AVIF, BMP, and ICO images render in a fitted viewer up to 25 MiB
and link to the same protected inline stream for full-size viewing. SVG, HTML,
and other active or unsupported formats are never embedded. Downloads stream
the selected regular file with an attachment filename and have no preview-size
limit.

`Copy path` puts the absolute server path on the clipboard. A console reached
over plain HTTP is not a secure context and has no clipboard, so instead of
reporting a failure the browser shows the full path in a selected read-only
field, ready for `Ctrl`/`Cmd`+`C`. The same fallback appears when a clipboard
exists but refuses the write.

`Upload` selects as many as six files, and dropping files anywhere over the
browser opens the same queue with an overlay naming the exact destination
folder. Each file is capped at 12 MiB and created directly in that displayed
folder with mode `0600`. Empty files are allowed. An existing file, directory,
or symlink with the same name causes a visible per-file conflict instead of an
overwrite; successful files refresh the listing and select the last upload.
These are project/CWD files, not temporary attachments: they are outside
`MUXDECK_UPLOADS_DIR`, have no application storage-total cap or cleanup policy,
and remain until the user or another host process removes them. Uploading changes
the host filesystem but never inserts terminal input or presses Enter.

The browser also edits the tree in place. The toolbar creates an empty folder
(mode `0700`) or an empty file (mode `0600`) in the folder currently shown. Each
row reveals rename, duplicate, move, and delete actions on hover or keyboard
focus; `F2` renames the focused row, `Delete` asks to remove it, and `Backspace`
goes up one folder. Renaming and moving are the same server operation and refuse
to replace an existing name rather than overwriting it, so a conflict is reported
instead of silently losing a file. Duplicating copies one regular file, preserves
its mode, and is capped at 256 MiB. Dragging a row onto a folder row or onto a
breadcrumb moves it there; dragging a checked row moves the whole checked set.

Deleting always asks first. Files, symlinks, and empty folders are removed on the
first confirmation. A folder with contents returns a conflict naming how many
entries it holds and needs a second, explicit recursive confirmation; trees above
20,000 entries are refused outright and left for the terminal. Deletes act on the
named entry itself, so removing a symlink never touches what it points at.

Row checkboxes select several entries at once, and the tools row toggles only
the rows currently on screen, so a checked entry hidden by the filter keeps its
state. The bulk bar then moves or deletes the whole selection, running one entry
at a time and reporting each result in the same per-item list the upload queue
uses, so a partial failure stays visible instead of being collapsed into a single
error. A bulk move whose destination folder is itself selected moves everything
else and says how many it skipped. Renaming an entry carries its checkbox along.
Entries can also be sorted by name, size, or modification time in either
direction, with folders kept first.

A text preview under 1 MiB that is not a symlink can be edited in place. `Edit`
swaps the preview for a textarea, `Save` (or `Ctrl`/`Cmd`+`S`) writes the file
through a temporary file and an atomic rename that preserves the original mode,
and the save carries the modification time the preview was read at. If the file
changed on disk in between, the save is refused with a conflict and the editor
keeps the unsaved text. Navigating, refreshing, or uploading while an edit is
unsaved is blocked with a visible reminder, and only `Discard` throws the text
away. `Escape` unwinds one layer at a time - an open name prompt, then a delete
confirmation, then a clean editor - and closes the browser only once nothing is
left to dismiss. The key is consumed only while such a layer is open, so with
the browser merely open `Escape` still reaches the pane and can leave a Vim
insert mode or interrupt an agent as usual.

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
remain ordinary processes. Because Copilot keeps that title static, Muxdeck
reads its current visible footer: `Working ... esc interrupt` identifies a live
turn, the command/help shortcut row identifies its idle input prompt, and a
selection footer identifies a permission or choice dialog. Missing, stale, or
unrecognized footer signals remain Unclear rather than being inferred from
transcript prose.

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

The separate pushpin action adds a live native tmux session to every saved
workspace. It is available on each landing-page session card and as `Pin all`
beside the desktop console's `Fit active`, `Scrollback`, and `Copy New` actions.
Muxdeck appends the session only to workspaces that do not already contain it,
so pinning repeatedly never duplicates or reorders a tab. New saved workspaces
inherit all current global pins, and ordinary tab/activity saves cannot drop
them while they remain pinned. Unpinning removes only memberships that Muxdeck
automatically inherited from that pin; a workspace that already contained the
session keeps its tab. This global workspace pin is independent of the star
that organizes landing-page results.

On desktop, `Move / Copy` sits immediately beside `Pin all`. It opens a
searchable list of the other saved workspaces, with an explicit `Copy` and
`Move` action on every destination. Copy adds the current native tmux session
without changing the current workspace. Move adds it to the destination and
removes it from the current workspace; an unsaved current workspace removes
only the browser's local tab. A destination that already contains the session
is marked `Added`: Copy becomes a no-op, and Move removes only the source tab,
so neither action can create duplicates. A globally pinned session cannot be
moved until it is unpinned, because the pin requires it to remain in every
workspace. Transfers are atomic, reject a full destination without touching
the source, and advance the workspace revision fence so an older browser
autosave cannot undo the result.

Selecting the main body of a card or list row opens its console in the current
window. Use the adjacent `New window` link to open that console in a separate
browser context instead. The link carries the current dashboard query, so its
Back action returns to the same filters, view, grouping, and sort priority. A
new window starts with only the selected session in its quick-tab workspace.
Inside a console, the joined landing-page control in the header makes the same
choice explicit: the left arrow returns to Sessions and Workspaces in the
current browser window, while the adjacent external-window segment opens that
landing page separately without changing the console. The latter preserves the
dashboard query and the complete current quick-tab or saved-workspace context.
The fixed `Sessions` control in the horizontal tab bar or vertical tab rail is
split the same way: its labeled segment navigates this window, and its external
link segment opens the same preserved landing-page URL in a new window.

The landing page lists named saved workspaces in rough last-active order. `New
workspace` starts with an empty tab set by default; choose `Copy current tabs`
when the new workspace should instead inherit this browser page's open tabs and
their order. Creating either kind writes a separate server record before opening
it, so the workspace you came from is unchanged. A saved workspace can be
resumed, opened in a new window, renamed, or deleted from that list. Its `New
window` link carries the workspace's stable ID, ordered tabs, groups, active
session, and current dashboard filters, then opens with no `window.opener`
relationship. Deleting one removes only the saved workspace record; none of
these workspace actions stops, renames, or sends input to a tmux session.

An unsaved multi-tab console identifies itself as `Temporary workspace` and
exposes `Save workspace` directly in its tab bar. On phone layouts, the identity
and save action are repeated in `Overview`. After naming the workspace, the
current console stays open, its saved name replaces the temporary label, and its
URL gains the stable workspace identifier. The accompanying `Saved`, `Opening`,
or `Sync issue` state reports whether later tab-order and active-session changes
are synchronizing automatically. On desktop, a saved identity has an adjacent
`Rename` action in both the horizontal strip and vertical rail. Renaming changes
the shared server name in place; the stable workspace ID, current URL, tabs,
groups, links, notes, timers, and activity history remain attached.

On desktop, the compact workspace quick switcher beside that identity changes
the saved workspace in the current browser tab. Its left and right buttons move
to the alphabetically adjacent workspace and wrap at either end, so activity
updates cannot reshuffle the sequence during repeated switching. `Switch` opens
a searchable chooser that matches both workspace names and member-session names;
Up/Down, Home/End, Enter, and Escape keep the whole flow keyboard-friendly. The
current workspace is marked explicitly, and a temporary workspace can jump to
the first or last saved workspace without visiting the landing page first.

Each saved workspace keeps its name, ordered open tabs, tab groups,
workspace-scoped quick links, active session, global-pin provenance, and
server-generated creation, update, and last-active times in
`MUXDECK_WORKSPACES_FILE`. Opening or changing a
saved workspace refreshes its rough last-active time. Workspace names, tab
membership, and workspace links are shared by every browser connected to the
same Muxdeck instance, so a phone or another computer can resume the same group.
Concurrent pages use last-write-wins semantics; the most recently accepted full
tab/activity or workspace-link update becomes the saved state. Each tab snapshot
also carries the server's workspace session revision. Native renames and global
pin/unpin changes and session transfers advance that fence. If another device tries to save tabs
captured before either change, the server rejects that stale snapshot and the
page reloads the authoritative workspace instead of restoring an obsolete name
or inherited pin.

The stable `workspace=` query parameter identifies a saved workspace without
putting its editable name in the route. Ordered `tab=` values remain in the URL
for navigation and backward-compatible ad hoc workspaces. Each group is encoded
as a repeated `tab-group=` JSON value so temporary workspaces, reloads, shared
links, and browser Back/Forward preserve the same structure. When a saved
workspace is loaded, its server record is authoritative. A URL with `tab=` values
but no `workspace=` remains an unsaved browser workspace; its `Resume workspace`
action returns to the most recently active open tab without changing their order.

The landing-page `New session` action opens `/sessions/new` as a synthetic
workspace tab and waits for explicit confirmation before changing tmux. On
confirmation, Muxdeck uses the optional native tmux name entered in the form or
assigns a collision-resistant `muxdeck-*` name when the field is empty. It starts
tmux's configured default shell in the optional absolute server directory entered
in the form, or in the service user's home directory when that field is blank.
The server rejects missing paths and paths that are not directories before it
invokes tmux. Workspace Memory shows up to eight one-click directory choices. It
learns the active-pane paths and activity times of known tmux sessions, counts a
session identity only once, remembers successful launches, and blends recency,
frequency, and currently live sessions into the order. Manually saved paths are
pinned above learned suggestions. Any suggestion can be pinned or unpinned,
hidden, and restored after hiding; a manually entered path remains available for
anything not yet known.

Workspace Memory is stored only in that browser and synchronizes between its open
Muxdeck windows. Unlike named Muxdeck workspaces, it is not written to
`MUXDECK_WORKSPACES_FILE` or shared across devices. Existing browser-local saved
directory lists from the earlier picker are migrated as pins.

After creation, Muxdeck replaces the route with `/session/:name`. Existing
ordered quick tabs stay in place and the created session is appended. `New
window` opens the same confirmation screen in an isolated browser workspace. The
synthetic tab is represented by the route, never by a fake `tab=` value. A
successfully created tmux session remains alive until it is ended through tmux
itself, independently of whether its quick tab is saved in a named workspace.

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
the workspace record or URL. `Ctrl+Shift+S` quickly hides or restores the session
tabs, including the left rail, without changing that orientation preference.
Compact mobile layouts keep their horizontal/Overview navigation regardless of the
desktop preference.

Desktop top and side tabs can also move as a selection. Shift-click selects the
contiguous range from the active or most recently clicked tab; Ctrl-click on
Windows/Linux or Cmd-click on macOS toggles individual tabs without changing the
active session. Selected tabs receive check marks and a compact `N selected`
tray; drag any selected tab to move the complete set while preserving its
relative order. Named groups are atomic, so selecting one member selects and
moves the whole group, including when the group is collapsed. A normal tab click,
the tray's close button, or Escape clears the browser-local selection. Selection
itself is intentionally temporary, while a completed move updates the URL and
synchronizes the new order to a saved workspace.

The side rail includes a `Non-working first` sort action. Each click performs a
one-time stable partition of the real workspace order: every state other than
`Working` stays first, `Working` sessions move after them, and tabs retain their
relative positions inside those two partitions. Explicit tab groups remain
atomic, sort as blocks, and receive the same stable ordering among their own
members. The resulting order updates the URL and synchronizes to a saved
workspace; later status changes do not silently reshuffle tabs until clicked
again.

The primary desktop `VIEW` toolbar also contains a link shelf split into three
regions: `Common`, the current workspace, and the active native tmux session. It
stays in that first row beside `Tabs`, `Input`, and `Keys`, including when the
session tabs are hidden or moved into the side rail. Common links are global to
this Muxdeck instance and stay pinned in every temporary or saved workspace. The
workspace region belongs only to the active saved workspace; a temporary
workspace must be saved before links can be added there. The session region is
available in both temporary and saved workspaces and follows that session across
every workspace in which it is opened. Use the plus or pencil at the end of a
region to open its manager, stage additions or removals, and choose `Save links`
to persist the complete ordered list. Each region supports up to 16 user-defined
links with 48-character labels. Links accept only HTTP or HTTPS URLs without
embedded credentials, open in a new browser tab, and send no referrer. The shelf
is not shown in compact mobile layouts.

The desktop console header places three compact sticky-note cards immediately to
the left of `Fit active`, `Scrollback`, `Copy New`, and the theme control. `Common`
is shared by every workspace on the Muxdeck server, `Workspace` belongs to the
active saved workspace, and `Session` follows the active native tmux session
across workspaces. A temporary workspace cannot have its own note, but its Common
and Session cards remain available. Selecting a card opens a focused editor;
changes autosave after a short pause and are flushed before the editor closes.
Each scope holds up to 8,000 characters. The cards and editor are desktop-only,
and concurrent editors use last-write-wins replacement.

A compact `Countdown` / `Stopwatch` card sits beside those note cards on desktop.
It opens a non-modal floating timer that moves by dragging its title strip and can
be pinned across session-tab switches. Countdown duration can be entered exactly
or selected from 5, 15, 25, and 45 minute presets; completion rings for up to one
minute, keeps a visible `TIME'S UP` state, and prefixes the browser-tab title until
the alarm is dismissed. Stopwatch and countdown progress use wall-clock timestamps,
so they remain accurate through background-tab throttling and reloads. Timer state,
the pin/open choice, and window position are browser-local and isolated by saved
workspace ID; they do not alter tmux or the server-side workspace record.

`Host Pulse` is the adjacent desktop server-health card. It always shows the
latest aggregate CPU and memory percentages; selecting it opens a non-modal panel
with an `Overview` and `Details` switch. Overview retains the aggregate CPU and
memory charts, one/five/fifteen-minute load average, available RAM, and swap use.
Details shows every logical core with its current load and trace, RAM used and
headroom, Linux memory PSI `some` and `full` stall averages, swap utilization,
and measured swap-in/out rates. The chart can select 15-minute, one-hour, or
24-hour history, while Pause stops that browser's sampling. The title strip moves
the panel, the corner grip resizes it, and both also support arrow-key operation.
Open, pinned, paused, view, range, position, and size state are browser-local and
isolated by saved workspace ID. An unpinned panel closes on a session switch; a
pinned one remains visible and is restored when that workspace is resumed. Host
Pulse is not rendered in compact/mobile layouts.

Host instrumentation is request-driven. A desktop card makes one initial request;
then five-second requests and history collection occur only while its floating
panel is open, visible, and unpaused. The backend reads aggregate and per-core
`/proc/stat`, `/proc/meminfo`, optional `/proc/pressure/memory`, and optional swap
counters from `/proc/vmstat` when the API is requested. A short cache and lock
coalesce near-simultaneous browser requests. The first request takes two closely
spaced counter reads so CPU and swap rates need not wait five seconds. The bounded
24-hour in-memory ring returns at most 180 chart points; gaps remain gaps when no
panel is actively viewing the host, and history is intentionally not written to
disk. `GET /api/host-metrics?range=15m|1h|24h` performs this on-demand collection.

`Actions` in the same desktop `VIEW` toolbar shows or hides the repeated controls
on every quick tab. Turning it off removes the directional reorder, new-window,
terminate, and close buttons from both the top strip and side rail while leaving
each tab selector and tab-group controls available. Overview keeps the full action
set as a fallback. The choice starts visible and persists as a browser-local display
preference; it does not change the workspace record, URL, or any tmux session.
`Ctrl+Shift+A` toggles the same setting from anywhere in the desktop workspace.

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

Each real quick tab also has `Move tab to new window` and `Copy tab to new
window` actions. Both open an isolated temporary workspace containing only that
session, without stopping or otherwise changing its tmux session. Copy leaves
the quick tab, order, and group unchanged in the current workspace. Move removes
the quick tab here only after the browser successfully creates the new context;
if a pop-up is blocked or child navigation fails, the source tab remains intact
and Muxdeck shows a dismissible error. Moving from a saved workspace synchronizes
the removal, while copying does not change the saved workspace. Move waits while
a saved workspace is still opening or has a sync issue. If an earlier autosave is
still pending, Muxdeck accelerates that save, keeps the source tab in place, and
asks you to retry Move after it finishes; this prevents an older request from
restoring the moved tab when the page exits. The non-mutating Copy action remains
available throughout.

The direct window buttons collapse with the other secondary controls in narrow
side rails and compact horizontal layouts, and all direct tab controls disappear
when `Actions` is off. Open-tab rows in `Overview` retain both window actions as
accessible 44px-or-larger controls, alongside reorder, terminate, and close, so
the actions remain available on compact and touch layouts.

`New group` in the scrollable tab strip opens the group editor for a required
name, one of nine colors, and one or more open tabs. A group stays contiguous and
moves as one block; member-tab arrows only reorder within that group, while an
ungrouped tab moves across a neighboring group atomically. The group chip can
collapse its members, but the active member remains visible. Editing membership
can move tabs between groups, while `Ungroup tabs` removes only the grouping and
never closes a tmux session. Mobile Overview repeats New/Edit group access, and
adds whole-group up/down controls. Tab groups are a multi-tab-view concern: the
landing page does not show group badges, counts, names, editors, or group-aware
tab search results.

By default, on desktop, `Ctrl+Shift+,` and `Ctrl+Shift+.` select the previous or next open
tab and wrap at either end. `Ctrl+Shift+1` through `Ctrl+Shift+9` select that
numbered open tab directly; both the number row and numeric keypad work, and a
position that is not open is a no-op. `Ctrl+Shift+;` opens the `Find tab`
palette, which ranks matches against both the custom display title and native
tmux name, then the tab-group name; arrow keys choose a result and Enter jumps
directly to it. These
exact chords remain available while xterm or staged input owns focus, while
unrelated browser/editor commands such as `Ctrl+/` pass through untouched. All
workspace shortcuts pause behind a modal dialog and are disabled in the compact
mobile layout, where Overview remains the session-switching surface. They are
also inactive on the landing page, even when its URL retains a workspace
snapshot for Back/Forward navigation.

The live console defaults to exact `Ctrl+Shift` chords for session and terminal actions:
`E` opens the existing End-session confirmation, `R` opens the native tmux
session rename dialog, `L` returns to live output, `C` toggles browser Copy mode,
and `U` / `D` invoke the paging controls highlighted for the current agent. `M`
creates a numbered session in the active pane's directory, `B` opens New session,
`F` enters or exits terminal Focus, and `S` shows or hides the session strip. The
desktop command palette uses `Ctrl+Shift+H`. The console-only
chords are captured before xterm can turn them into terminal input, keep unrelated
modifier combinations untouched, and pause while a modal dialog or mobile
workspace layout is active.

`Shortcuts` in the desktop workspace strip, or `Ctrl+Shift+Z` by default, opens a modal
shortcut layer containing the known tab, view, paging, Copy, Live, Rename, and
End actions. After releasing the opening chord, a single displayed key runs the
action: notably `E` opens End confirmation, `R` opens Rename, and `H` switches to
fuzzy command search. `T` toggles the theme. Escape or clicking outside closes
the layer. The paging entries intentionally say `Preferred page up/down` because
their raw-application or tmux implementation follows the remembered agent choice.
`Customize` opens the global keymap editor. Each action has an independently
editable direct `Ctrl+Shift` key and shortcut-window key where that layer applies;
duplicate keys within one layer cannot be saved. Clearing a binding removes its
hint and handler. Saving writes the versioned keymap to the backend, immediately
updates buttons, command results, and both shortcut windows, and makes the same
map available to every browser. Browser- or OS-reserved direct chords may never
reach the page, so the shortcut-window layer remains the dependable fallback.

`Recents` opens the route `/session/:name/recents`. The sheet separates open
quick tabs, closed recently visited sessions, and other sessions currently on
the tmux server. Closing an active tab selects its neighbor; closing the final
tab returns to the dashboard. Browser Back closes a sheet opened from a live
console, and selecting any row updates the canonical active-session URL.

Open quick tabs and their order are URL-backed across console, dashboard, and
Snippets routes. Reloading or sharing an ad hoc URL restores its ordered tabs.
When `workspace=` is present, Muxdeck also synchronizes the ordered tabs, groups,
collapse state, and active session to the server so another device can resume
them. During an in-place rollout, a newer browser retries workspace writes
without `groups` if a pre-group backend rejects that field; tabs and activity
continue saving without the generic sync-error banner. A workspace with local
groups is labeled `Tabs saved` until the server can store them. Normal activity
writes keep testing support, and refocusing a page checks again, so local groups
are sent once an upgraded backend is available. The closed-session visit trail
remains page-local and clears on reload; it is not
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

`MUXDECK_SHORTCUTS_FILE` stores the global desktop keymap. It is shared across
browsers, uses revision-checked whole-document writes, and defaults to the
built-in bindings until the first save. An unreadable, malformed, conflicting,
or unsupported document makes shortcut persistence unavailable rather than
overwriting the file; the browser continues with built-in defaults and exposes a
retry state in the editor.

`MUXDECK_AUTH_MODE` selects `server`, `basic`, or `none` when the process starts.
`server` uses the Muxdeck form login and remembered-device cookies. `basic` uses
the browser's standard HTTP Basic prompt without device cookies. `none`
deliberately bypasses application authentication, even when an auth-file path is
present. Explicit `server` and `basic` modes require valid credential state;
unknown modes and incomplete protected modes fail startup closed. When the mode
is omitted, compatibility behavior infers `server` if `MUXDECK_AUTH_FILE` is set
and `none` otherwise.

`MUXDECK_AUTH_FILE` stores the global account record and remembered browsers.
Create it interactively with
`python -m tmux_console.auth provision --path ABSOLUTE_PATH --username NAME`;
the password is read without echo and is never accepted as a command-line
argument. The versioned JSON document contains the username, a salted scrypt
password hash, and hashes of random device tokens. It never contains the
plaintext password or the bearer token held by a browser. The file must be a
regular, non-symlink file owned by the service user with mode `0600` or stricter.
If the configured file is missing, malformed, publicly readable, or otherwise
unavailable, application creation fails closed in a protected mode. Keep this
path outside the source tree for both protected modes.

A successful login sets an `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped
to the Muxdeck base path. Cookies are shared by tabs in the same browser profile.
The server-side remembered-device token has no fixed expiration; the browser
cookie uses a rolling 400-day lifetime because browsers cap persistent cookies.
Each normal authenticated response renews that lifetime, so an actively used
profile remains signed in. Browser data removal, private browsing, or explicit
revocation still removes access. The Account page lists, revokes, and logs out
remembered browsers. `MUXDECK_AUTH_COOKIE_SECURE=false` exists only for deliberate
direct-loopback HTTP development; keep the default for every HTTPS deployment.
These cookies and account revocation controls apply only to `server` mode.

In `basic` mode, Muxdeck validates the same stored username and password hash but
never issues a device cookie or changes the remembered-browser list. The Basic
username cannot contain `:`. Credentials are merely Base64-encoded on the wire,
so use HTTPS. Credential caching and prompts belong to the browser, and there is
no dependable application logout; close the browser or clear its saved site
credentials to forget the login.

`MUXDECK_UPLOADS_DIR` stores files attached from the desktop console. The legacy
variable and `uploads` directory names remain for compatibility. The directory
and per-session subdirectories use mode `0700`; attachment files use mode
`0600`. Names are generated from a timestamp, random token, safe filename slug,
and a hash of the native tmux session name. The API returns only an absolute path
inside this managed directory and never accepts a browser-selected destination.
Uploaded files are runtime state, may contain sensitive information, and remain
until an operator removes them; they require their own backup or retention
policy.

`MUXDECK_WORKSPACES_FILE` stores the global saved-workspace list and ordered
global session pins. Tabs are keyed by native tmux session name. Each workspace
also records which tab memberships were inherited from a global pin, allowing
unpin to remove those tabs without deleting pre-existing membership. A native
rename performed through Muxdeck migrates the pin, provenance, and that name in
every saved workspace and moves its session-scoped quick links and note; an
out-of-band tmux rename cannot do so. Unavailable names remain visible
in the saved workspace until the workspace is updated or deleted. Session-link
and session-note entries for sessions that disappear outside Muxdeck remain
dormant, so a future tmux session that reuses the same native name inherits that
link shelf and note. Deleting a saved workspace also deletes its workspace note,
but does not affect the Common note, a session note, or tmux. The file contains
workspace names, tmux session names, user-defined quick-link labels and URLs, and
user-authored notes, so treat it as potentially sensitive runtime state.
Desktop note-window layout is separate browser-local state, namespaced by saved
workspace ID. The open, floating, pinned, and position values do not modify the
server workspace document, but the browser restores them when that workspace is
resumed. Pinned Common and Workspace windows remain open across session-tab
switches, while a Session window remains tied to its native tmux session.

The workspace schema is version 7. Version 1 files load at session revision zero;
version 1 and 2 files load with no tab groups, version 1 through 3 files load with
no common or workspace quick links, version 1 through 4 files load with no
session quick links, version 1 through 5 files load with empty scoped notes, and
version 1 through 6 files load with no global session pins or inherited-pin
provenance. A legacy document upgrades atomically on its next workspace,
quick-link, note, or global-pin write. A workspace name is limited to 80
characters and a workspace can contain
at most 32 unique ordered tabs, 16 disjoint contiguous groups, and 16 ordered
quick links. The global common shelf and each native-session shelf also permit 16
links. Group names are limited to 40 characters, quick-link labels to 48
characters, quick-link URLs to 2,048 characters, and every scoped note to 8,000
characters. Writes use an atomic file replacement. Keep a pre-upgrade copy when
rollback is possible because releases that only understand versions 1 through 6
reject the version 7 document. If an existing workspace file is unreadable,
malformed, or uses an unsupported schema, the workspace API returns `503` and
refuses to overwrite it until the file is repaired and Muxdeck is restarted.

## Scrollback behavior

Opening Scrollback runs `tmux capture-pane` and stores the result in memory for ten
minutes. Older pages come from that immutable snapshot, so live output cannot
cause duplicate or skipped lines while the user reads.

Tmux retains normal-screen rows according to its `history-limit` option (2,000 by
default). Claude Code commonly uses the alternate screen, and Grok Build defaults
to it, where tmux often retains no previous rows. Muxdeck can show the current
screen but cannot reconstruct alternate-screen content that tmux never saved.

Scrollback follows the pane selected when the web client attaches. If you switch to
another tmux pane or window from inside the live terminal, return to the session
list and reopen it before capturing that pane's history.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUXDECK_HOST` | `127.0.0.1` | HTTP listen address |
| `MUXDECK_PORT` | `7683` | HTTP listen port |
| `MUXDECK_BASE_PATH` | `/mux` | API, WebSocket, and SPA prefix |
| `MUXDECK_TRUSTED_ORIGINS` | unset | Comma-separated exact external browser origins allowed through a reverse proxy |
| `MUXDECK_AUTH_MODE` | inferred | `server`, `basic`, or `none`; omitted infers `server` with an auth file and `none` without one |
| `MUXDECK_AUTH_FILE` | unset | Absolute path to private credential and remembered-device state; required by `server` and `basic` |
| `MUXDECK_AUTH_COOKIE_SECURE` | `true` | Mark the `server`-mode remembered-browser cookie Secure; use `false` only for intentional direct loopback HTTP development |
| `TMUX_BIN` | `tmux` | tmux executable |
| `MUXDECK_TMUX_SOCKET` | unset | Optional tmux socket name, used to isolate tests |
| `MUXDECK_TITLES_FILE` | `~/.local/state/muxdeck/session-titles.json` | Persistent titles, predefined tags, and starred/ignored session names |
| `MUXDECK_MESSAGES_FILE` | `~/.local/state/muxdeck/session-messages.json` | Persistent per-session notes and queued memo input |
| `MUXDECK_SNIPPETS_FILE` | `~/.local/state/muxdeck/snippets.json` | Persistent global folder/snippet tree |
| `MUXDECK_WORKSPACES_FILE` | `~/.local/state/muxdeck/workspaces.json` | Persistent named workspaces, ordered tabs, scoped quick links and notes, and activity times |
| `MUXDECK_SHORTCUTS_FILE` | `~/.local/state/muxdeck/shortcuts.json` | Persistent global desktop shortcut keymap |
| `MUXDECK_UPLOADS_DIR` | `~/.local/state/muxdeck/uploads` | Private host files uploaded from desktop staged input |
| `MUXDECK_FILE_BROWSER_ROOT` | `/` | Absolute directory the file browser may never be pointed above; a relative, missing, or non-directory value fails startup |
| `LOG_LEVEL` | `INFO` | Python log level |

Loopback Hosts are accepted by default. Every non-loopback Host must correspond
to an exact `http://` or `https://` origin in `MUXDECK_TRUSTED_ORIGINS`; entries
contain no path, query, credentials, or wildcard. For example, a console opened
at `https://console.example.test/mux/` needs:

```bash
MUXDECK_TRUSTED_ORIGINS=https://console.example.test
```

The reverse proxy must preserve the browser's `Host` and `Origin` headers. These
checks protect the local service from cross-site browser requests and DNS
rebinding; they are not authentication. Select a protected
`MUXDECK_AUTH_MODE`, keep the site behind a private network/tunnel, or use
another authenticated access layer before making the route reachable by
untrusted clients.
