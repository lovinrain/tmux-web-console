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

When the desktop header runs out of room, `All console controls` opens a compact
panel with Workspace tools, Session actions, and Preferences sections. Notes and
widgets stay aligned, full action labels are shown, and short windows scroll
within the panel. The controls retain their state when the panel opens or closes;
`Escape` closes it and returns focus to its toggle.

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

`Space` (`Split workspace` in its tooltip) is the non-mutating browser-workspace counterpart beside that
control. With multiple tabs selected using Shift-click or Ctrl/Cmd-click, it
opens that selection in its existing tab order; the button shows the selected
count. Otherwise it opens the current native session alone. The active session
stays focused if selected; otherwise the first selected tab receives focus.
It opens a separate no-opener window and removes the saved-workspace ID and tab groups from the destination URL,
and leaves the source tab exactly where it was. The new window is temporary
until its own `Save workspace` action is used; splitting never creates, copies,
renames, resizes, or sends input to a tmux session. A blocked pop-up leaves the
source unchanged and produces a dismissible error.

`Tab` (`Split to ephemeral tab` in its tooltip), immediately beside `Space`, opens the
current session in a lighter session-only page. It always uses the active
session, regardless of other selected tabs. The page has no tab sidebar,
workspace Overview, save controls, pins, transfers, or workspace widgets.
Terminal input, scrollback, files, theme, and explicit session actions remain
available. A floating `Single tab` badge identifies this page, including in
desktop Focus and mobile distraction-free modes; hover explains the tab's scope.
The URL is `/session/{encoded-name}?ephemeral=1`; workspace and tab
parameters are removed on entry and remain absent after renaming or reloading.
This page does not initialize a temporary workspace or read, subscribe to, or
save workspace state. It attaches to the same tmux session rather than creating
another shell. `Close tab` only detaches this browser; explicit `End` still
requires confirmation to terminate the session. Blocked pop-ups show an error
in the source page.

Both buttons share one bordered control with an always-visible `Split` caption.
They use distinct icons when the header is narrow; hover reveals the full action
and explanation. Their complete accessible labels remain available.

The desktop tab-selection bar also provides `Close tabs` and `End sessions`.
Both show a confirmation listing the captured selection, native names, and
display titles. `Close tabs` removes tabs only from the current workspace and
records their history without stopping tmux. `End sessions` terminates the
selected sessions everywhere, including their panes, programs, and owned
session terminals, using full captured tmux identities. Session history retains
metadata, not recoverable running programs or terminal transcripts.
Items are processed independently, with the active tab last. Partial failures
remain visible alongside successful results; retry only attempts failed items
and never substitutes a replacement session that reused a name. This is not an
atomic operation: a failure does not roll back earlier successful actions.

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
Copilot CLI uses to enqueue its current prompt. `^T` sends a literal `Ctrl+T`
byte, which Codex CLI uses to open earlier messages and the full transcript. The
`Other Keys` control reveals
`Up`, `Down`, `Left`, `Right`, `Home`, and `End` in a secondary row so those
less-frequent controls do not crowd the main shortcut strip. `Home` and `End`
send the xterm sequences for those keys, which tmux re-encodes for the
foreground application; use them where `^A` and `^E` are bound to something else.

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
full browser viewport and leaves floating `Redraw`, `Float input`, `Show all
buttons`, and `Exit` controls. `Show all buttons` overlays the existing bottom
shortcut strip
as a wrapped floating panel, including `More Keys`; it does not shrink the
terminal or create duplicate actions. Drag the panel's `Move panel` handle to
place it anywhere within the viewport. With that handle focused, the arrow keys
move it by 16 pixels, Shift+Arrow moves it by 64 pixels, and Enter or Home resets
it to the centered bottom position. Hiding and reopening the panel preserves its
position until Focus ends. `Float input`, also available beside the normal
`Input` toolbar control, opens a separate non-modal editor without leaving
Focus. The editor mirrors the active session's staged draft immediately in both
directions and saves through the same per-session browser storage as the full
composer. Drag its title strip to move it; arrow keys move it when the strip is
focused. Pinning keeps it open and follows the newly active session's own draft,
while an unpinned window closes on a session switch. Open, pin, and position
state persist locally per saved workspace. Closing clears the pin, and `Open
full input` leaves Focus and reveals the complete composer. Focus does not
invoke the browser Fullscreen API, remount
xterm, reconnect the WebSocket, change the URL, or discard the staged draft.
Entering and leaving refits the existing PTY attachment so tmux receives the new
dimensions. The choice is session-local and resets when the active session
changes, the workspace overview opens, the layout switches to mobile, the
console is left, or the page reloads. Escape remains raw terminal input rather
than an exit shortcut; `Ctrl+Shift+F` enters or exits Focus and
`Ctrl+Shift+Y` toggles floating input even while xterm or staged input owns
keyboard focus.

### Session history

`Session history` on the landing page opens the SQLite-backed record of closed
tabs and ended/missing sessions. The same control in a workspace's
tab-strip/side-rail is filtered by that workspace's stable ID, and its `Closed
& ended` filter narrows the list to sessions that are gone. This is distinct
from `Switch session`, the browser-local switcher for sessions that are running
right now; the two carry different icons. Temporary workspaces see the global
history; save a workspace to retain its own membership history across browsers
and reloads.

A session's own `Agents` control, beside `Scrollback` in the console header,
opens the same history scoped to that session: every coding agent recorded in
it, oldest first, following the session across renames and recreations under
the same name.

Each observed tmux process identity has a separate history record, even when
its native name is reused later. The record retains native and previous names,
display title, last CWD, first/last observation times, known end/disappearance
or tab-close time, saved-workspace names and membership, and the last captured
agent type and conversation ID. Agent IDs are reference-only, may be absent,
and do not imply a supported resume command. Terminal output/transcripts,
environment variables, and running process state are not archived.

Both views default to closed/ended history and also offer `All history`.
Search explicitly with Enter or Search by name, old name, title, directory,
agent type, or agent ID. Results are newest activity first, 50 at a time with
`Load older sessions`; records have no automatic expiry. `Reopen session`
checks the original full tmux identity before adding/focusing its tab through
the existing deduplicating workspace navigation. `Recreate shell` requires a
second confirmation and an existing saved directory, refuses a same-name live
conflict, and explicitly launches a shell instead of tmux's default command.
Recreation keeps the original historical record. Neither action resumes a
coding agent, restores terminal output, or re-adds tabs to every former
workspace. Closed/reopened records remain available as history.

Metadata is collected during normal successful session inventories and session
actions. Saved-workspace changes capture membership before and after the
write, so removing a tab, moving it, or deleting a workspace retains its former
association. Closing a quick tab does not terminate its tmux session; the
history labels it `Still running`. End Session retains history and labels it
`Ended`. A previously observed session absent from a successful inventory is
`Missing`; inventory failures never count as a disappearance. Last-seen writes
are throttled to once per minute when no meaningful metadata changes occur.
History searches run on demand without a new polling timer.

Existing SQLite recovery records are imported at upgrade, including those
previously marked non-recoverable. Their old end times and former workspace
memberships were not recorded, so those cannot be retroactively reconstructed.
Sessions deleted or overwritten before this history feature and sessions
created/ended externally between observations cannot be recovered from nothing.
The existing `Forget` recovery action does not erase the new history archive.

### Backgrounding the file browser (desktop)

The file browser also supports `Background` in its title strip and
`Foreground Files` beside the console CWD (and in Focus controls). Background
hides the existing panel without destroying its view: folder/file selection,
list and editor scroll, unsaved editor text, filters, sort, checked entries,
Find/Recent mode, and window layout remain intact. Foreground restores that
same panel without refetching its directory or preview. Started file operations
may finish while hidden; Background is not a cancellation or a save-to-disk.
The close icon also retains the view. A retained browser remains bound to its
original session/pane and browsing root when another session tab is selected;
its header identifies that source. Explicit CWD/file-path clicks still navigate
to the requested location. Use Refresh to re-read externally changed files.
This full view state is kept only while the console page remains mounted,
not across a browser reload or a trip back to the landing page. Unsaved file
edits are never implicitly written to disk by Background.

### Floating utility terminal (desktop)

`Workspace Terminal` in the VIEW toolbar or Focus controls opens an independent shell in
a compact non-modal panel. The default shortcut is `Ctrl+Shift+J` (or `J` in the
shortcut window); both bindings are configurable in Shortcuts and saved on the
backend. Existing custom assignments take precedence over the new defaults.

The shell starts in the active coding-agent pane's CWD, using tmux's configured
default shell, not its default command. It does not type into or interrupt the
coding agent. Each saved workspace has one utility shell, found through a
tmux session option even after Muxdeck restarts or that shell is renamed.
Opening the same workspace in another browser tab reuses this shell. The shell
also appears in the landing-page session inventory as `muxdeck-terminal-*`.

Drag the title strip to move the panel or any edge/corner to resize, including
the left edge. With the title strip focused, arrows move and Shift+arrows resize.
Pin keeps the same shell visible across session switches; an unpinned panel
hides. Open/pin/position/size are browser-local per saved workspace. Temporary
workspaces retain their panel association only for the current mounted view.

Close or the toggle shortcut hides the panel and disconnects only its attach
client; the shell keeps running. `End shell` requires confirmation and checks
the session's full tmux identity. Reloading a saved open panel only reconnects
to an existing shell; if it ended, `Start shell` explicitly creates another.
`Session Terminal` opens a separate shell belonging to the active session. Its
association uses the full tmux identity, so renaming the parent preserves it and
reusing a terminated parent's name does not inherit it. Its open state and layout
are browser-local per session; returning to that session restores its panel.
It has no cross-session pin. Both terminal windows may be open together.

The small external-link button beside `Session Terminal` opens the current
workspace in another browser tab using the exact current URL. It also appears
beside that control in desktop Focus mode.

New utility shells carry explicit ownership metadata. Every five seconds the
backend checks for ended parents or deleted saved workspaces and ends only their
owned utility shells. Closing a session tab does not end its session shell.
Existing utility shells from before ownership tracking remain untouched.
Leaving or closing a temporary workspace view sends a best-effort cleanup
request for its workspace shell; hiding the panel does not. Saving the temporary
workspace transfers that shell to the saved workspace. A browser crash or lost
network can prevent temporary cleanup; such a shell can still be ended from the
landing page. Host reboot still ends live shell processes; this feature does not
silently recreate them.

The panel uses the existing authenticated WebSocket terminal, with no additional
service or idle polling. Resizing the independent shell cannot resize the coding
agent's session, though two browser views of the same utility shell share tmux
window sizing. Main-session end/rename and terminal-control chords are suppressed
while keyboard focus is in this panel; use its explicit `End shell` control.

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

`Ctrl+Shift+I` opens the picker from a desktop console, including terminal Focus.
`Insert snippet` is also listed in the shortcut window and fuzzy command palette.
Search receives focus automatically: fuzzy title matches work across folders,
and optional snippet `Shortcuts` (short words such as `review` or `deploy`) rank
ahead of title matches. Exact shortcut matches rank first, followed by prefix
and fuzzy shortcut matches; text and folder-path search remain available.
Arrow keys preview results and Enter inserts the selected snippet into the draft.
The picker includes full library management: `New snippet` creates a snippet
with a name, text, shortcut words, and folder location. `Edit snippet` changes
all of those fields, including moving it to another folder. `Delete snippet`
asks for confirmation before removing it. `New folder` and the current folder's
`Edit folder` / `Delete folder` controls organize the same shared tree without
leaving the session. Folder deletion explicitly includes its contents.
Save updates the shared library without inserting anything or changing the
staged draft. A conflicting save keeps the form edits and offers a library
reload before retrying; a conflicting deletion requires another confirmation.

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
movable file browser. Any of its four corners resizes both dimensions, and the
left-edge grip changes width while keeping the right edge anchored. It opens at
the live pane CWD and can be
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
and link to the same protected inline stream for full-size viewing. SVG and
other active or unsupported formats are never embedded. HTML/HTM files expose
an `Open webpage` action and a hosted new-tab view. That response is bounded
to 10 MiB and carries an opaque-origin CSP sandbox with scripts, forms, and
network connections disabled, so untrusted markup cannot access the authenticated
Muxdeck page or APIs. A signature-verified
PDF up to 50 MiB uses the browser's built-in PDF viewer inside the preview pane;
`Open PDF` gives it a full browser tab, while Download remains available for
browsers that disable inline PDF viewing and for larger documents. The server
does no PDF rendering or parsing beyond the signature and size gate, so this
adds no PDF library, conversion process, or idle cost. Markdown files offer a
client-side rendered view with 100%, 125%, 150%, and 175% text sizes; 100% keeps
the original presentation, and the selected size is remembered with the
browser-local file-panel layout. Downloads stream a regular file with an
attachment filename and have no preview-size limit. Each accessible file row
has its own download shortcut, so selecting or previewing the file first is not
required.

Checked entries expose `Download ZIP` in the bulk bar. Direct-listing selections
are placed at the archive root; selections from a nested filter retain their
path relative to the displayed folder. The server recursively includes ordinary
files and empty folders, skips symlinks and special files rather than following
them, and collapses a checked descendant when its parent folder is also checked.
The browser receives one archive, so it does not need permission for a burst of
separate downloads. Preparing the archive is non-mutating and does not clear the
checked rows; the status line reports file, folder, and skipped counts when the
download starts.

Archive generation accepts at most 1,000 explicitly selected entries, inspects
at most 10,000 entries after folder expansion, and stops above 256 MiB of
uncompressed file content. Builds are serialized, use a private temporary ZIP,
repeat the live session/pane identity and configured-boundary checks, and never
follow a symlink during traversal. The temporary archive is removed after it is
streamed, after a build error, or after an interrupted browser request.

`Find` replaces the directory/preview split with a fuzzy locator rooted at the
directory named in the file-browser header. A query may use fragments or
initials across both a basename and its relative path; multiple space-separated
tokens must all match. Submit explicitly with Enter or `Locate`, use Up/Down to
move through ranked results, and press Enter again to open the highlighted file
or folder. Opening a nested file moves the ordinary browser to its parent and
starts the same protected preview. The existing `Show dotfiles` setting also
controls whether hidden trees participate.

The ordinary directory filter remains a fast, case-insensitive basename match
in the folder currently shown. Its `Here`/`Nested` scope button switches to the
bounded locator for a convenient recursive filter: `Nested` searches that folder
and its descendants as the query changes, displays each match relative to the
current folder, and keeps the normal row actions (including selection, preview,
download, move, and delete). Clearing the query returns to the live directory
listing without starting a tree walk.

Locator walks are on demand, never follow symlinks, and are bounded to 80 best
results, 50,000 inspected entries, 32 directory levels, and roughly 1.5 seconds.
Common dependency, cache, and build trees remain searchable but run after
ordinary project folders so they do not consume the scan first. The result
footer reports partial searches; refine the query when the cap is reached.

`Recent` replaces the split view with `All recent paths` and `Under current CWD`.
Both include successfully previewed files and opened folders. The CWD list is a
filtered subset of the same session history, retaining its most-recent-first order;
it includes the CWD itself and its descendants, excluding sibling path prefixes.
The CWD appears above the filtered list. Forgetting a path removes it from both
sections, since they share one history. Selecting an item resolves its
absolute path again through the normal identity-checked file API, so a moved,
deleted, or newly forbidden item produces the ordinary path error instead of
using stale file data. Each path is deduplicated and refreshed to the front;
individual entries can be forgotten or the current session's list can be
cleared. Up to 32 paths are retained per tmux session, with old session buckets
pruned from browser storage. This history is browser-local, survives closing or
reloading the panel, and is neither uploaded to the backend nor shared with a
different browser profile.

On desktop, xterm also detects terminal-output candidates ending in `.md`,
`.pdf`, `.png`, `.txt`, `.json`, or `.csv`. It understands absolute paths, `~/` paths,
CWD-relative paths, quoted paths with spaces, and shell-escaped spaces; common
trailing punctuation and
`:line` suffixes are excluded from the target. A plain click remains available
to the terminal application. `Ctrl`+click on Windows/Linux or `Cmd`+click on
macOS resolves the candidate against the live pane CWD where necessary, opens
the floating browser, and selects and previews the resolved file. HTTP(S) URLs
have higher link priority and continue to open as browser links. Detection is
client-side and does not probe the filesystem on hover; the authenticated,
identity-checked file resolver runs only after activation and still enforces
`MUXDECK_FILE_BROWSER_ROOT`.

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
Each successful upload result also provides `FULL` and `REL` copy buttons without
needing to find its row in the listing. Both update the PATH bar and attempt a
clipboard copy; `REL` uses the active pane's CWD, falling back to the full path
for files outside that directory.
These are project/CWD files, not temporary attachments: they are outside
`MUXDECK_UPLOADS_DIR`, have no application storage-total cap or cleanup policy,
and remain until the user or another host process removes them. Uploading changes
the host filesystem but never inserts terminal input or presses Enter.

The browser also edits the tree in place. Use `New folder` in the toolbar to
create an empty folder (mode `0700`), or `New text file` to create an empty file
(mode `0600`) in the folder currently shown. Enter a name such as `notes.txt`
and click `Create`; no initial content is required. Each
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
named entry itself, so removing a symlink never touches what it points at. For a
deliberate high-throughput cleanup, `Unlock` in the title strip enables the
temporary unsafe-delete mode for this browser panel: row and bulk deletes are
sent immediately (including recursive folders) until the panel is locked again.
The unlock is never persisted, and switching sessions or reopening the browser
starts locked.

Row checkboxes select several entries at once, and the tools row toggles only
the rows currently on screen, so a checked entry hidden by the filter keeps its
state. The bulk bar downloads that selection as one ZIP, or moves or deletes the
whole selection. Move and delete run one entry at a time and report each result
in the same per-item list the upload queue uses, so a partial failure stays
visible instead of being collapsed into a single error. A bulk move whose
destination folder is itself selected moves everything else and says how many
it skipped. Renaming an entry carries its checkbox along. Entries can also be
sorted by name, size, or modification time in either direction, with folders
kept first.

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
Each snippet can have up to eight shortcut words, each up to 32 characters,
configured in either the library editor or the insert picker. Separate them
with spaces or commas; matching is case-insensitive. Reusing a shortcut is
allowed, with library order breaking equally ranked matches.

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
`Move` action on every destination. When two or more tabs are selected, both
that header action and the `Move / Copy` action in the selection toolbar use
the complete selection in workspace order. Copy keeps the source tabs and adds
only missing destination tabs. Move removes every selected source tab even if
some were already present at the destination. An unsaved current workspace
removes only the browser's local tabs. Existing tabs are never duplicated. If
any selected session is globally pinned, the complete move is rejected until
it is unpinned. Batch transfers are atomic, reject a full destination without
touching the source, and advance the workspace revision fence once so an older
browser autosave cannot undo the result.

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

`Add sessions` beside the workspace's `New session` control opens a compact
picker over the current multi-tab view. It lists running tmux sessions that are
not already tabs in this workspace and fuzzily searches display title, native
name, CWD, agent, command, pane title, state, reason, and tags. With no query,
non-ignored and starred sessions are favored before actionable state and recent
activity. `Add` appends a tab without moving focus and keeps the picker open for
repeated additions; `Open` appends the tab, closes the picker, and focuses that
session. Up/Down selects a result, Enter adds it, and Shift+Enter adds and opens
it. Existing tabs are excluded, so repeated adds cannot duplicate a session.
Changes to a named workspace enter the same automatic persistence flow as tab
movement and closing; temporary workspaces remain encoded in the current URL.

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
`Rename` action in both the horizontal strip and vertical rail. `Overview`
repeats that explicitly labeled action on every viewport, including compact and
mobile layouts, and desktop command search finds it by workspace name,
settings, attributes, or details. The rename dialog also summarizes whether the
workspace is server-saved, its session-tab, tab-group, and pane-view counts, and
its stable workspace ID, making it the home for future workspace-level
attributes. Renaming changes only the shared server name; the stable ID,
current URL, tabs, groups, links, notes, timers, and activity history remain
attached.

On desktop, the compact workspace quick switcher beside that identity changes
the saved workspace in the current browser tab. Its left and right buttons move
to the alphabetically adjacent workspace and wrap at either end, so activity
updates cannot reshuffle the sequence during repeated switching. `Switch` opens
a searchable chooser that matches both workspace names and member-session names;
Up/Down, Home/End, Enter, and Escape keep the whole flow keyboard-friendly. The
current workspace is marked explicitly, and a temporary workspace can jump to
the first or last saved workspace without visiting the landing page first.

Each saved workspace keeps its name, ordered open tabs, tab groups,
workspace-scoped quick links, workspace callback sessions, named multi-pane layouts, active session,
global-pin provenance, and
server-generated creation, update, and last-active times in
`MUXDECK_WORKSPACES_FILE`. Opening or changing a
saved workspace refreshes its rough last-active time. Workspace names, tab
membership, and workspace links are shared by every browser connected to the
same Muxdeck instance, so a phone or another computer can resume the same group.
Open pages subscribe to a workspace event stream, so tab additions, closes,
group changes, and other workspace updates propagate without a reload. Each
page keeps its current selected session when that tab remains available. If it
is removed, the page selects a surviving tab or returns to the landing page.
Connecting or reconnecting receives the full current server record; when
streaming is unavailable, pages fetch it every four seconds and on refocus.
The same connection carries the global callback snapshot, so saved-workspace
pages do not need an additional callback stream.

Browser tab/activity saves include the last observed workspace `updatedAt`
value as `expectedUpdatedAt`. A concurrent change causes `409` instead of
letting an old full snapshot overwrite the workspace. The browser reconciles
pending local tab/group edits with the new record before retrying, retaining
independent additions and removals from both pages. Page-exit activity saves
carry the same protection. Older API callers may omit `expectedUpdatedAt` for
compatibility and therefore do not get that version check.
During a mixed-version rollout, the browser omits the field only after an older
backend explicitly returns `400` with `unknown field: expectedUpdatedAt`.
That compatibility decision lasts until reload, including page-exit saves;
`409` conflicts never trigger an unguarded retry. Reload after updating the
backend to restore the version check.

Each tab snapshot also carries the server's global workspace `sessionRevision`.
Native renames, global pin/unpin changes, session transfers, and forgetting a
recovery record advance that separate fence. Stale identities cause a reload
of authoritative state rather than restoring obsolete names or membership.
Quick-link and note replacements retain their own last-write-wins behavior.

The stable `workspace=` query parameter identifies a saved workspace without
putting its editable name in the route. Ordered `tab=` values remain in the URL
for navigation and backward-compatible ad hoc workspaces. Each group is encoded
as a repeated `tab-group=` JSON value so temporary workspaces, reloads, shared
links, and browser Back/Forward preserve the same structure. When a saved
workspace is loaded, its server record is authoritative. A URL with `tab=` values
but no `workspace=` remains an unsaved browser workspace; its `Resume workspace`
action returns to the most recently active open tab without changing their order.

### Named multi-pane views (desktop)

`Pane view` in the horizontal workspace strip, or the `Pane views` section in
Side tabs, creates a named workspace view without creating or splitting any
native tmux session. A pane view is a recursive tree: any leaf can `Split right`
or `Split down`, so the same model supports two, three, or more panes instead of
stopping at a fixed side-by-side mode. Each leaf chooses one existing session
from the current workspace; choosing a session already visible in another leaf
moves that assignment rather than opening a duplicate connection in the layout.

Every assigned leaf contains the regular session identity, CWD/file browser,
connection state, Fit/Scrollback/Copy New/theme and workspace actions, live
xterm terminal, staged input, and terminal key strip. Click inside a leaf to
make it the target for configurable desktop session shortcuts. Pane toolbar
controls add a nested horizontal or vertical split, clear/remove the leaf, and
collapse the removed space into its sibling. Drag the divider to resize it;
arrow keys adjust the focused divider, Shift uses a larger step, Home/End reach
the safe bounds, and Enter returns to 50/50.

`Navigate` arms tmux-style spatial focus movement. Its default leader is
`Ctrl+Shift+G`; release the chord, then use an arrow key. The mode remains armed
for 1.5 seconds after each move so successive arrows can cross a larger layout,
and `Escape` cancels it. Movement does not wrap at an outside edge. Muxdeck
chooses the nearest visible pane in that direction with an overlapping edge,
marks it as active, and focuses its xterm input so subsequent typing reaches the
new session. Empty leaves receive focus on their session selector instead. A
small HUD identifies the armed state and result. The shortcut window provides
the fallback sequence `Ctrl+Shift+Z`, then `G`, then Arrow. The leader's direct
and window keys are configurable under `Pane navigation`; clicking a pane still
selects it normally.

The pane-view tab itself has a name and session-count badge. Its header can
rename or explicitly delete the view, and the ordinary session tabs remain the
canonical workspace inventory and a fast way to leave the layout. Common,
workspace, and session links plus workspace widgets remain available above the
board. Saved workspaces persist the recursive tree, assignments, names, split
directions, and bounded ratios in `MUXDECK_WORKSPACES_FILE`; closing a workspace
tab clears that session's pane assignment without destroying the layout, and a
Muxdeck session rename follows all assignments. Temporary-workspace pane views
live for the current page and are included when `Save workspace` gives the
workspace a server identity. Multi-pane rendering is intentionally desktop-only.

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

The workspace strip's split `New session` control also provides a quick action.
It skips the form, asks the server for a collision-resistant `muxdeck-*` name,
and focuses the created session immediately. Its starting directory follows a
strict browser-memory precedence: a pinned path first, then a path with at least
three observed/explicit launches ranked by frequency, then the most recently
seen or used path, and finally the service user's home directory when memory is
empty. A successful quick launch updates the same frequency and recency record.

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

Session tabs show the coding agent's brand icon at the end of the title: OpenAI
for Codex, Anthropic for Claude, and the Grok, Cursor, or GitHub Copilot mark.
Shells use a terminal icon. Each icon sits in a small square using the same
agent colors as the session header badge, including dark/light theme variants.
Icons remain visible in the compact side rail.
Hover for the agent name; the
separate status dot continues to indicate activity. Icons update with live pane
changes rather than using historical recovery metadata.

Closing or forgetting a tab leaves the sidebar at its current scroll position,
including when removing the active tab selects a replacement. Live/unavailable
session transitions retain the sidebar instead of remounting it. Deliberately
selecting another tab still scrolls that tab into view, so keyboard navigation
and explicit session switching remain easy to follow.

In Side tabs, select a session and use the two separator buttons on the same row:
`Insert separator` puts an amber line immediately before it (including the first tab), while
`Append separator` puts one immediately after it. In narrow rails, the buttons
use up/down icons and descriptive tooltips.
Use a line's small remove button to delete it. Separators
are independent of named groups and can appear inside expanded groups; collapsing
a group hides separators belonging to its hidden tabs. A line follows its anchor
tab when reordered, and saved-workspace lines follow native renames made through
Muxdeck. Closing or moving the anchor out of the workspace removes its line.
In desktop Side tabs, an up/down arrow crosses an immediately adjacent separator
before moving past another tab. This changes the separator anchor without
changing session order. A contiguous multi-selection crosses as one block.
Dragging the adjacent tab or selected block onto the separator crosses it too;
the separator highlights while it can accept that drop. Noncontiguous selections
retain their existing tab-reorder behavior. Separator crossing is saved as one
update and waits for any pending tab-order save rather than overwriting it.
Saved workspaces persist separators on the backend. Temporary-workspace separators
last for the current page and are included when explicitly saving that workspace.

Desktop top and side tabs can also move as a selection. Shift-click selects the
contiguous range from the active or most recently clicked tab; Ctrl-click on
Windows/Linux or Cmd-click on macOS toggles individual tabs without changing the
active session. Selected tabs receive check marks and a compact `N selected`
tray; drag any selected tab to move the complete set while preserving its
relative order. The tray also offers up/down (or left/right) buttons; the arrows
on a selected tab move the complete selection too. The selection remains active
after moving, and the tray controls remain available when per-tab Actions are hidden.
Named groups are atomic, so selecting one member selects and
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
Each scope is a notebook with up to 128 named pages. Existing single-note text
is migrated into `Page 1`; page content has no separate character validator
(the HTTP request boundary still protects the service). Page selection and the
optional page sidebar are remembered in each browser window. The cards and
editor are desktop-only, and concurrent editors use last-write-wins replacement.
Each editor has quick `Small` (430 × 430), `Medium` (640 × 560), and `Large`
(860 × 720) size buttons. Windows move as needed to fit the chosen size on screen.
The `Default` selector sets the opening size for all three note scopes in that
browser and synchronizes across its tabs. `Last size` preserves each note's last
size and starts new notes at Small; choosing a fixed size applies it each time
you deliberately open a note. Reloading or returning to a workspace restores
already-open windows at their saved size. Quick resizing does not change the
default. Enter or double-click on a resize corner restores the configured size
(Small under `Last size`).
The cards keep whatever room the session identity and the action buttons leave:
as that narrows they drop their preview line, then their labels, and finally the
whole widget row scrolls horizontally instead of covering its neighbours.

Nothing the header cannot show is lost. A counted tray button appears at the end
of the header whenever a control has been dropped by a breakpoint, collapsed to
nothing, or clipped out of the widget row, and its number is how many. Opening
it lifts the real controls - both the widget cards and the action buttons - into
a panel below the header, at full size and with every label and reading
restored; they are the same controls, not copies, so their state, shortcuts and
disabled reasons come with them. Opening it from the keyboard moves focus to its
`Close control panel` button, while a click leaves terminal focus alone. The
panel closes on `Escape`, on that button, or on a click outside the header, and
returns keyboard focus to the tray button; a dialog opened from a control inside
it keeps `Escape` for itself. Clicking a control leaves the panel open. The tray
is desktop-only, like the widgets it exposes, and the embedded pane header
scrolls instead.

A compact `Countdown` / `Stopwatch` card sits beside those note cards on desktop.
It opens a non-modal floating timer that moves by dragging its title strip and can
be pinned across session-tab switches. Countdown duration can be entered exactly
or selected from 5, 15, 25, and 45 minute presets; completion rings for up to one
minute, keeps a visible `TIME'S UP` state, and prefixes the browser-tab title until
the alarm is dismissed. Stopwatch and countdown progress use wall-clock timestamps,
so they remain accurate through background-tab throttling and reloads. The timer
has independent `Global`, `Workspace`, and `Session` scopes. Global is the fresh
browser default and follows the browser across workspaces; Workspace follows a
saved (or temporary browser) workspace; Session follows the full native tmux
identity so a recreated session with the same name starts clean. Timer state,
the pin/open choice, and window position are browser-local per scope; they do
not alter tmux or the server-side workspace record. The selected timer scope is
remembered in that browser.

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

The fixed split control beside `Sessions` opens `New session` with its `+` side
or creates the quick temporary session with its terminal side, both without a
dashboard round trip. Opening or canceling the form does not change saved tabs:
Cancel or the synthetic tab's `X` returns to the console it replaced. A
successful creation appends the real session tab and synchronizes it when the
workspace is saved. If a saved workspace is still opening, creation waits until
its authoritative tab list has loaded rather than racing that state.

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
and `U` / `D` invoke the paging controls highlighted for the current agent. `I`
opens Insert snippet with its search field focused. `M`
creates a numbered session in the active pane's directory, `B` opens New session,
`K` adds or removes the active session from the workspace callback list (and that
entry is automatically visible in the global callback list),
`F` enters or exits terminal Focus, `Y` toggles the floating staged-input
window, and `S` shows or hides the session strip. The
desktop command palette uses `Ctrl+Shift+H`. The console-only
chords are captured before xterm can turn them into terminal input, keep unrelated
modifier combinations untouched, and pause while a modal dialog or mobile
workspace layout is active.

`Shortcuts` in the desktop workspace strip, or `Ctrl+Shift+Z` by default, opens a modal
shortcut layer containing the known tab, view, floating-input, paging, Copy, Live, Rename, and
End actions. After releasing the opening chord, a single displayed key runs the
action: notably `E` opens End confirmation, `R` opens Rename, and `H` switches to
fuzzy command search. `I` opens Insert snippet. `T` toggles the theme. Escape or clicking outside closes
the layer. The paging entries intentionally say `Preferred page up/down` because
their raw-application or tmux implementation follows the remembered agent choice.
`Customize` opens the global keymap editor. Each action has an independently
editable direct `Ctrl+Shift` key and shortcut-window key where that layer applies;
duplicate keys within one layer cannot be saved. Clearing a binding removes its
hint and handler. Saving writes the versioned keymap to the backend, immediately
updates buttons, command results, and both shortcut windows, and makes the same
map available to every browser. Browser- or OS-reserved direct chords may never
reach the page, so the shortcut-window layer remains the dependable fallback.

Quick temporary session creation remains available through the shortcut window
as `Ctrl+Shift+Z`, then `K`; its direct chord is intentionally unassigned because
`Ctrl+Shift+K` is reserved for the callback toggle.

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

`MUXDECK_SESSION_REGISTRY_FILE` is a private SQLite database that records each
observed tmux session under a stable Muxdeck UUID. Its reconstruction fields are
the native name, last active-pane working directory, last-seen tmux identity,
and first/last observation times. The registry can also retain the latest
recognized coding-agent type and a passively discovered conversation/session ID.
Those agent fields are identification references only: Muxdeck does not build,
display, or execute an agent resume command from them.

When a registered, recovery-enabled identity is absent from the live tmux
inventory, the landing page lists it under `Missing after restart`. The same
recovery controls appear when its saved workspace tab is opened. Recovery is
always manual. `Recreate shell` asks tmux for a new detached shell with exactly
the saved name and CWD, then opens that new session; it does not start the prior
agent or replay any terminal input. An existing live name or unavailable CWD is
reported as a conflict and nothing is renamed, replaced, or killed. `Forget`
deletes the selected registry record and removes that shell from every saved
workspace's tabs, groups, pane layouts, separators, pins, and callback queues.
The current browser also removes it from open tabs and its recent-session trail,
then selects a neighboring tab or returns to the landing page. A floating
notification offers `Undo` with a 30-second countdown. Undo restores the recovery
record, workspace placement, groups, pane assignments, separators, pins, and
callbacks while keeping unrelated subsequent edits. Each forgotten session has
its own deadline, enforced by the server. Expiration or a Muxdeck restart makes
Forget final; reloading the page dismisses that page's notifications. Historical
session records, notes, and quick links remain archived. Ending a live session
through Muxdeck disables recovery for that exact identity, while a later
independently created same-name identity becomes eligible after it is observed.

Dashboard cards for live and recoverable sessions also show their current saved
workspace membership. One workspace name is shown directly; `+N` indicates
additional memberships, with all names available in the tooltip and accessible
label. An amber `No workspace` label highlights sessions in none. Membership is
refreshed after dashboard actions, on focus, and every four seconds while the
page is visible. An unavailable workspace list is shown as unknown rather than
incorrectly marking sessions unassigned.

Saved workspaces remain in the existing atomic JSON workspace store; they
already survive Muxdeck and host restarts and retain unavailable native session
names. Recreating a missing shell under that exact name therefore makes the
existing workspace tab usable again without rewriting the workspace document.
The session registry does not duplicate workspace content.

Agent-reference discovery is conservative and bounded. It examines only the
active pane's capped descendant process tree and already-open paths matching a
known Claude, Codex, Copilot, Cursor, or Grok state-file shape. Results are
cached; Muxdeck never recursively searches the session CWD, changes an agent's
configuration, or installs hooks. Some agent versions expose no safely
attributable ID, in which case only the agent type (or neither field) is stored.
Treat the database as sensitive because names, paths, and agent IDs can reveal
project information. Schema version 1 fails closed on an unsupported future
schema rather than replacing it.

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
Snippet documents load versions 1 and 2; the next save writes version 2 with
optional shortcut aliases. Keep the pre-upgrade file for rollback to a release
that only reads version 1.

`MUXDECK_SHORTCUTS_FILE` stores the global desktop keymap. It is shared across
browsers, uses revision-checked whole-document writes, and defaults to the
built-in bindings until the first save. An unreadable, malformed, conflicting,
or unsupported document makes shortcut persistence unavailable rather than
overwriting the file; the browser continues with built-in defaults and exposes a
retry state in the editor. Shortcut documents are version 7. Version 6 loads by
adding Insert snippet with `I` in each unoccupied layer. Version 5 loads by
adding the workspace callback action with `K`; if the legacy quick temporary
session still owns `K` directly, that direct binding is moved out of the way while
its shortcut-window binding remains available. Version 4 loads by adding pane
navigation with `G` in each unoccupied layer. Version 3 additionally adds the
floating utility terminal with `J`; version 2 adds floating input with `Y`, and
version 1 first adds the quick temporary session with `K`. Upgrades add each
later action in order, and a conflict leaves only that layer unbound instead of
replacing a custom key. The first keymap save atomically rewrites a version 1
through 6 document as version 7. Keep a pre-upgrade backup when rollback to an
older release is possible.

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
workspace ID. Any corner resizes the window while keeping its opposite corner
anchored. The open, floating, pinned, position, and size values do not modify
the server workspace document, but the browser restores them when that
workspace is resumed. Pinned Common and Workspace windows remain open across
session-tab switches, while a Session window remains tied to its native tmux
session.

### Workspace callback list

The desktop `Callback` card is a deliberate follow-up queue for sessions that
need a human check later. It has two scopes: `Global` (the default) and
`Workspace`. `Current` marks the active session, or the chooser can add another
known session; each entry is deduplicated, ordered by the user's additions, and
can be opened or marked reviewed with its check button. Live agent state is
shown as `Working`, `Ready`, `Waiting`, or `Ended / unavailable`, so a completed
session remains easy to find after the operator returns. `Clear ended` removes
stale entries and `Clear all` empties the active queue.
The card shows `ready/total` (for example, `3/8 ready`), counting entries labeled
`Ready` or `Ready for review`. Hover for working-session and message counts.

The global queue is the higher-level union of explicitly global entries and all
workspace callback entries. A session registered in any workspace therefore
always appears in the global list, with its owning workspace shown as provenance.
Entries not open as tabs in the current workspace are display-only for
navigation, so selecting one cannot accidentally add it to the current
workspace; the review check remains enabled from any workspace. Reviewing a
session clears its explicit global marker and every workspace-owned marker in
one operation. Open pages receive authenticated callback events through the
saved-workspace stream or the separate callback stream when outside a saved workspace,
so a review or add/remove action in another browser tab is reflected without
waiting for a manual refresh. Explicit global entries are persisted in the shared workspace
store, while workspace entries remain attached to their saved workspace. Both
follow native session renames, and moving a tracked session transfers its
workspace callback entry with it; copying a session does not silently create a
second callback. An
unsaved temporary workspace keeps its queue in browser-local storage until it is
explicitly saved. The list opens in a movable, resizable floating window;
pinning keeps it visible when switching session tabs, and its open, pin,
position, and size preferences are namespaced by callback scope in that browser.
The selected scope is remembered in browser storage and a fresh browser starts
at `Global`.

The workspace schema is version 13. Version 1 files load at session revision zero;
version 1 and 2 files load with no tab groups, version 1 through 3 files load with
no common or workspace quick links, version 1 through 4 files load with no
session quick links, version 1 through 5 files load with empty scoped notes, and
version 1 through 6 files load with no global session pins or inherited-pin
provenance. Versions 1 through 7 load with no sidebar separators; version 8 retains
its after-session separators and loads with no before-session separators, and
versions 1 through 9 load with no named pane views. A legacy document
upgrades atomically on its next workspace,
quick-link, note, global-pin, or callback-list write. Versions 1 through 10 load
with an empty callback list, and older files load with an empty explicit global
callback list. A workspace name is limited to 80
characters and a workspace can contain
at most 256 unique ordered tabs, 16 disjoint contiguous groups, and 16 ordered
quick links. It can keep 16 named pane layouts, each with at most 12 leaves and
six levels of nested splits. Pane names are limited to 64 characters and split
ratios stay between 15% and 85%. The global common shelf and each native-session shelf also permit 16
links. Group names are limited to 40 characters, quick-link labels to 48
characters, quick-link URLs to 2,048 characters, every notebook to 128 pages
with 80-character names, workspace callback lists to 64 unique session names,
and the explicit global callback list to 256 unique session names.
Page content has no separate character validator. Writes use an
atomic file replacement. Keep a pre-upgrade copy when
rollback is possible because releases that only understand versions 1 through 12
reject the version 13 document. If an existing workspace file is unreadable,
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
| `MUXDECK_SESSION_REGISTRY_FILE` | `~/.local/state/muxdeck/sessions.sqlite3` | Persistent session reconstruction metadata and reference-only detected agent IDs |
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
