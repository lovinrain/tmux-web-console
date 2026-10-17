# Workspace folds

Folds collect sibling branches behind one placeholder without changing their
tree or order. Click the placeholder to preview its contents. **Unfold** exposes
the original tabs and leaves their sessions running.

In a saved, synced workspace, **Fold and close** saves recovery metadata before
ending the sessions. The preview can recover a shell or resume a supported
recorded coding conversation. Recovery restores one pane; running programs,
unsaved terminal state and previous pane layouts are not restored.

**Delete fold** removes the placeholder and all its member tabs, including
descendants, from the current workspace. A confirmation lists the affected names:

- Running sessions are archived before their tmux sessions and programs end.
- Dead tmux containers are archived and removed. A session that has started
  running again requires a fresh confirmation.
- Already-closed sessions stay closed; deleting them never launches recovery.

History, recovery records, directories, titles, notes and recorded coding
conversation references are retained. The History/recycle-bin view remains the
place to find them after the fold is gone. Native transcripts are not copied or
deleted. Other workspaces retain their tabs, although sessions ended by this
action appear closed there. Globally pinned members must be unpinned first.

If archival storage fails, sessions are left running. If closure or final tab
removal fails, the fold and its saved metadata stay available for retry. Save a
temporary workspace before using these archive/delete actions.

## Delete API

`DELETE /api/workspaces/{workspaceId}/folds/{foldId}` uses the existing authenticated
API (or trusted control token). Its JSON body contains `tabs` (the confirmed fold
roots), `sessions` (every branch member and descendant), `sessionRevision`, and
`expectedUpdatedAt`. Both versions must match the current saved workspace.

Each session entry contains `name`, `sessionId`, `sessionCreated`, `serverStarted`
and `serverPid`. Entries confirmed dead can add `onlyDeadPanes: true` to reject a
subsequent respawn. An already-missing session is `{ "name": "example",
"sessionId": null }`; a new live session with that name causes a conflict.

The response contains `workspace`, `closed`, `failures`, and `deleted`. A partial
close returns `deleted: false` with per-session failures and a retained fold.
Refresh the saved workspace before retrying. A replay after successful removal
does no further tmux work when every confirmed tab is already absent.

This uses existing workspace schema 16 and registry schema 5. No migration or
additional transcript archive is required.
