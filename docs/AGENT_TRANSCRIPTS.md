# Agent transcripts

Open **Pane scrollback → Transcript** to read the coding agent's local
conversation. Recognized Codex, Claude Code, Copilot, Cursor, and Grok panes open
this view first. It can show messages that the terminal replaced with a notice
such as “Earlier messages are available — press ctrl+t to view the full
transcript,” or that tmux no longer retains.

The default conversation view shows your prompts and agent replies, starting
with the first saved prompt. Progress updates, tool calls/results, and generated
setup context stay out of that view. **Show activity** includes those records in
collapsed groups between messages. Text accompanying a tool call is kept separate
from the tool payload. Unmarked assistant text stays visible so a provider without
completion metadata does not lose its answers.

**First prompt** and **Latest loaded reply** navigate the loaded conversation.
**Load later messages** continues through it. Filtering happens before page limits,
and the browser automatically continues past bounded windows of metadata, so
setup instructions or tool chatter do not occupy the whole first page. Very large
empty scans offer **Continue searching**. **Copy loaded transcript** copies the
loaded messages included by the activity choice. Refresh returns to the beginning
and includes newly saved records. **Formatted** displays Markdown paragraphs,
headings, lists, tables, links, and code blocks in a conversation layout. **Plain
text** shows the original text; switching formats does not reload the conversation.
Copying preserves the original Markdown in either format. Text stays selectable;
embedded HTML and scripts are skipped, remote images become text placeholders,
and links open separately. Activity remains literal text.

There is one **Transcript** tab. **Scrollback** captures the retained tmux buffer;
**Recorded output** opens the earliest terminal output saved by Muxdeck, which can
start after the conversation began. A captured “Earlier messages are available”
notice belongs to that recording. **Submitted messages** is the separate archive
of input. Plain shell panes default to Scrollback. **Escape** closes pane history
and returns keyboard focus to its opener without sending input to the terminal.

**Session history / Agents → Transcript** reads a recorded conversation even
after its shell ends. When several conversations ran in that tmux session, use
the conversation selector. Viewing a transcript never resumes an agent, sends
terminal input, switches the agent into its transcript mode, or changes tmux's
history limit.

## Sources

| Agent | Native source | Default transcript directory |
| --- | --- | --- |
| Codex | `sessions/YYYY/MM/DD/rollout-…-ID.jsonl`, also `archived_sessions/rollout-…-ID.jsonl` | `$CODEX_HOME`, otherwise `~/.codex` |
| Claude Code | `PROJECT/ID.jsonl` | `$CLAUDE_CONFIG_DIR/projects`, otherwise `~/.claude/projects` |
| Copilot | `ID/events.jsonl` | `~/.copilot/session-state` |
| Cursor CLI | `PROJECT/ID/store.db` | `~/.cursor/chats` |
| Grok | `PROJECT/ID/chat_history.jsonl` | `$GROK_HOME/sessions`, otherwise `~/.grok/sessions` |

Override a directory with `MUXDECK_CODEX_TRANSCRIPTS_DIR`,
`MUXDECK_CLAUDE_TRANSCRIPTS_DIR`, `MUXDECK_COPILOT_TRANSCRIPTS_DIR`,
`MUXDECK_CURSOR_TRANSCRIPTS_DIR`, or `MUXDECK_GROK_TRANSCRIPTS_DIR`. The configured
directory must retain the corresponding layout above. The Muxdeck service user
must be able to read it. Tests use separate directories for every provider.

Selection uses the recorded conversation ID, never the newest file in a shared
working directory. Live panes refresh reference detection rather than waiting
for the inventory cache. Codex's current open rollout takes precedence over an
old command-line resume argument; rollouts marked as subagents are excluded.
Session history keeps existing stable history identities, so renaming preserves
access and reusing a tmux name does not merge conversations. Claude's existing
reference detector uses PID registrations when available, with legacy detection
for older versions. An ID that was never detectable cannot be reconstructed by
the transcript reader.

Codex discovery follows executable launchers such as Volta and Node before
looking for the actual CLI's rollout, while still excluding nested agents.
When an idle CLI exposes no current ID, a single-pane session can offer IDs
previously recorded for that exact session incarnation, with an explicit notice
and conversation selector. This fallback never guesses from a shared working
directory, and does not reuse another pane's or a replacement session's IDs.

Reply classification uses Codex/Copilot `phase` (`commentary` versus
`final_answer`), Claude's `stop_reason` (`tool_use` versus `end_turn`), and
Cursor/Grok tool-call structure. Legacy Codex `channel` markers also work.
Codex also marks internal compaction summaries as `final_answer`. Bounded
lookahead links these messages to the following native `compacted` record,
checking the full summary text and response ID when available. Confirmed
summaries appear as **Session context** under **Show activity**, not as replies.
Headings such as "Active request" alone never hide a genuine answer. Lookahead
respects the saved pagination snapshot; refresh after an unfinished compaction
has been written to update its classification.
Claude metadata messages, Codex environment/AGENTS blocks, and Grok synthetic
reminders are activity rather than user prompts. Cursor's generated context is
excluded, and native `<user_query>` wrappers are unwrapped for Cursor and Grok.

Only visible user/assistant text and supported tool records are extracted.
System/developer instructions, provider context, reasoning blocks, encrypted
reasoning, and image bytes are omitted. Image and file attachments have text
placeholders. Codex's duplicate event notifications are ignored. Cursor follows
the ordered message list in its saved root, including committed WAL data,
rather than showing unrelated or abandoned blobs from SQLite insertion order.

## Availability and limits

Native transcript files are read only and on demand. This feature creates no
new archive or database schema. If an agent disables logging, removes a file,
uses a different directory, or changes to an unsupported storage format, Muxdeck
shows an availability notice. **Terminal scrollback**, **Recorded terminal output**, and
the independent **Submitted messages** archive remain available.

The reader cannot recover messages deleted from native storage. Cursor exposes
its saved active conversation; context removed from that conversation by native
compaction may be absent even if older internal blobs remain. Grok and Claude
also depend on what their native files retained. Protect and back up agent
storage separately if long-term transcript retention is needed. Muxdeck's saved
terminal-output and submitted-input retention policies are unchanged.

Pages have at most 100 entries (50 by default) and 1 MiB of message text. Each
entry is capped at 256 KiB and visibly marked if shortened. JSONL records are
bounded to 16 MiB; each request scans at most 32 MiB or 5,000 records and returns
a continuation when needed, including when a page contains only metadata.
Malformed/oversized records produce a partial-result notice. Discovery scans
fixed native layouts with a 50,000-entry bound and never follows child symlinks.

JSONL pagination fixes the file's original end so appends do not shift the
pages; identity and boundary fingerprints detect rotation or rewriting. Cursors
are bound to the selected conversation/activity view and can resume within a
record containing both text and tool activity. A read-budget boundary defers a
whole native record rather than discarding the first prompt in that record.
Cursor pagination retains the original root's order while its current root
advances. Changed or removed snapshots require a refresh. Timestamps are shown
only when present in the native record; Cursor and Grok may have no per-message
timestamp.

Both endpoints require the console's existing authentication and reject
callback-only tokens. They accept no filesystem path and return no source path
or native credentials. See [the API reference](API.md#agent-transcripts).
