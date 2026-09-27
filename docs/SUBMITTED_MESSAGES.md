# Submitted messages

Open **Pane scrollback → Submitted messages** to search and copy input submitted
in Claude Code or Codex. Each entry shows its agent and submission time. Older
entries load on demand. **Session history / Agents → Submitted messages** also
opens the archive for a session that has ended, without restarting its shell.

Muxdeck reads the agents' native `history.jsonl` input records after submission.
This includes input entered directly in a terminal and the final text after
editing. It does not reconstruct prompts from keystrokes or log drafts, pasted
text awaiting submission, or assistant output. Native input history can include
submitted CLI slash commands; an entry is evidence of submission to the CLI,
not a guarantee that a model request completed successfully.

Claude text-paste placeholders are expanded from inline `pastedContents` or the
native `paste-cache`. If old pasted content is already unavailable, the message
retains its placeholder and is marked incomplete. Image bytes are not archived.
Unsupported or malformed records are skipped with an explicit source notice;
individual native records and expanded message text are limited to 16 MiB.

The archive copies only conversation IDs recorded in this Muxdeck installation's
session registry. It uses conversation IDs, not working-directory matches, when
selecting messages. Recent Claude versions' process registrations are validated
against process start ticks to identify their current conversations. Older
versions retain Muxdeck's existing argument/descriptor/transcript detection.
Several agents may run in one tmux session over time; its recorded conversations
are all searchable. Renaming a session preserves its archive, while a fresh
session reusing an old name has a separate history identity.

A background task observes live session references and checks input histories
every five seconds, even with no browser open. Conversation discovery has the
existing up-to-30-second cache. Opening or refreshing the view also imports
available input. The first import recovers older entries still present in native
history. If native history recording is disabled, a conversation ID cannot be
detected, or the native file has already been removed, missing submissions cannot
be recovered. Other coding agents currently have no submitted-input adapter.

Saved entries survive tmux scrollback truncation, native input-history rotation,
session termination, and Muxdeck restarts. There is no automatic archive expiry.
The separate [saved beginning and recent output](SCROLLBACK.md) limits do not
trim submitted input. Messages from the omitted middle remain in this archive.
Identical submissions at different times remain separate; repeated identical
records within one native timestamp are preserved without duplication on refresh.

## Storage and configuration

The private SQLite archive defaults to `submitted-messages.sqlite3` beside the
configured session registry (normally `~/.local/state/muxdeck/`). It uses a
separate schema version 1; no recovery, workspace, or callback migration is
required for this feature. Back it up consistently with SQLite's backup API,
alongside `sessions.sqlite3`, and preserve both during rollback. It contains
submitted message text and is kept mode `0600`. Include it in private state
migrations, never source archives. Older releases leave the separate file alone.

| Setting | Default |
| --- | --- |
| `MUXDECK_SUBMITTED_MESSAGES_FILE` | `submitted-messages.sqlite3` beside the session registry |
| `MUXDECK_CODEX_HISTORY_FILE` | `$CODEX_HOME/history.jsonl`, or `~/.codex/history.jsonl` |
| `MUXDECK_CLAUDE_HISTORY_FILE` | `$CLAUDE_CONFIG_DIR/history.jsonl`, or `~/.claude/history.jsonl` |

Claude's paste cache is read beside its configured input history. Native files
are read only. The endpoints require the console's normal authentication;
callback-only tokens cannot read the archive. An unavailable archive returns
`503` without changing terminal input delivery.

## API

`GET /api/sessions/{name}/submitted-messages` resolves the current session.
An optional `identity` query guards against name reuse, using the same
`id:created:serverStarted:serverPid` format as the terminal WebSocket.

`GET /api/session-history/{historyId}/submitted-messages` reads the conversations
recorded under a stable history ID, including ended sessions.

Both accept `q` (up to 256 characters), `limit` (1–200, default 50), and the opaque
`before` cursor returned as `nextCursor`. The response has `messages`,
`nextCursor`, and `sources`. Messages include `id`, `agentType`, `agentSessionId`,
`submittedAt` (Unix milliseconds), `text`, and `complete`. Results are newest
first; timestamps and IDs together keep pagination stable as new input arrives.
Source statuses are `available`, `missing`, `unreadable`, or `partial`.
