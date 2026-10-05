# Saved scrollback

Muxdeck keeps the **beginning and recent output**, with **all recorded submitted
input in a separate archive**. Output retention limits never trim submitted
messages, including input from the omitted middle of a session.

For coding-agent conversations, **Pane scrollback → Transcript** reads the local
Codex, Claude Code, Copilot, Cursor, or Grok transcript by conversation ID. This
view opens first for recognized agent panes and can recover messages hidden by
Codex's “Earlier messages are available” notice or absent from tmux's buffer.
**Session history / Agents → Transcript** also works for ended sessions while
their native files remain available. See [Agent transcripts](AGENT_TRANSCRIPTS.md)
for formats, paging, and availability limits.

On desktop, the pane-history header offers **50%**, **75%**, and **100%** window
widths across all its tabs. **Restore** returns to the width used before the
presets; dragging the edge or using its arrow keys sets a new custom width.
The minimum desktop width is 360 pixels, and phones always use the full width.
Sizing keeps the loaded transcript or scrollback snapshot intact. The chosen
pixel width is retained for the current browser page, as with manual resizing;
**Esc** closes the window.

- **Pane scrollback → Scrollback** captures the live pane's currently retained
  tmux buffer. Older lines load automatically in 250-line pages as you scroll
  near the top, preserving the text you are reading. Its older pages belong
  to one immutable, ten-minute snapshot. A failed page pauses automatic loading
  and offers a retry; the refresh button captures a new snapshot after expiry.
- **Pane scrollback → Recorded output** opens the earliest terminal output Muxdeck
  saved for that pane, which can start after the conversation began. This is
  separate from the native **Transcript**, which shows prompts and replies with
  optional Markdown formatting. Recordings survive clearing tmux history and
  restarting Muxdeck.
- **Session history / Agents → Saved output** offers Beginning and Recent,
  including for ended sessions. Select a saved pane when a session had several
  panes or a pane was respawned. Viewing saved output never recreates a shell.
- **Submitted messages** in either history view searches and copies recorded
  Claude Code and Codex input, independently of saved output. See
  [Submitted messages](SUBMITTED_MESSAGES.md) for source availability and limits.

Each output section retains at most 2,000 terminal rows and 1 MiB of UTF-8 text
per pane incarnation. Wrapped rows are joined for reading, so the displayed
line count may be smaller. Beginning grows while output appends to the same
opening; it freezes when the limit is reached, history rolls, or the screen is
redrawn. Recent is replaced by later captures. An empty screen does not erase
useful saved output. Copy saved output copies the whole selected section.

Recording runs on the server with no browser required. A background pass runs
approximately every five seconds; unchanged pane signatures skip recapture for
up to thirty seconds. Creating a session through Muxdeck wakes the recorder.
Opening or refreshing a live pane's recorded terminal output forces a capture. Ending a session
through Muxdeck attempts a final capture with a three-second timeout; a storage
failure does not prevent the requested termination.

**Recording began** is the first successful nonempty capture, not a claim that
Muxdeck observed the session's creation. For sessions already running when this
feature is installed, Beginning starts with the earliest output still available
then. Output that disappeared before recording began or was redrawn between
samples cannot be recovered. A full-screen program can therefore leave a short
opening capture. This is a pair of saved sections, not a complete transcript of
every screen. Submitted input remains searchable separately.

Session names are not archive identities. Renames preserve the saved output;
reused names, restarted tmux servers, and respawned panes have separate records.
The recorder checks session and pane identity before and after capture. It only
reads tmux output and does not inject input or change tmux's history limit.

## Storage

Output lives in the private `scrollback.sqlite3` file beside the session registry
(normally `~/.local/state/muxdeck/`). `MUXDECK_SCROLLBACK_FILE` overrides its path.
The separate database uses schema version 1 and mode `0600`; existing recovery,
workspace, callback, and submitted-message schemas do not change.

There is no automatic expiry. Storage is bounded per pane's two output sections
and grows as more pane incarnations are recorded; submitted-input retention is
independent. Back up this database with SQLite's backup API alongside
`sessions.sqlite3` and `submitted-messages.sqlite3`. Include it in private state
migrations, preserve it during rollback, and exclude it from source archives.
Older releases leave the separate file alone.

The endpoints use normal console authentication. Callback-only tokens cannot
read saved terminal output. Unavailable archives return `503` while live
terminal input remains usable. See [the API reference](API.md#saved-scrollback)
for request and response details.
