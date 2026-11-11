# Pre-archived sessions

Choose **Pre-archive** beside **End** in the terminal buttons, or use the archive
button in an individual tab's actions. Confirming ends that tmux session and all
programs in its panes. Unsaved terminal work can be lost. Child tabs represent
separate sessions and keep running.

The tab keeps its workspace position, nesting and pane assignments. Its recovery
view shows **Pre-archived**, the saved directory and recorded agent references,
with the same **Recreate shell** and copy-resume-command controls used after a
restart. Other workspaces and browsers see the same recovery state. Temporary
workspaces support the action too; their navigation remains browser-local.

**Recreate shell** starts one fresh shell in the saved directory. It bypasses
tmux's default command and does not restore running programs or previous pane
layouts. Copying a resume command does not run it. **Forget** retains its existing
behavior and removes the recovery record and saved tab references, with Undo.

## API

`POST /api/sessions/{session}/pre-archive` accepts exactly `sessionId`,
`sessionCreated`, `serverStarted` and `serverPid`, using the full observed native
identity. Browser authentication or the trusted control credential is required.
It returns `{recovery: <recoverable session>}` with `preArchived: true`.

The server saves the directory, history, title and detected agent references
before closing the identified session. Failed archival writes leave it running.
A stale identity returns `409`; a successful request can be retried while the
same archived identity is still missing, without affecting a replacement.

The marker comes from existing ended history with recovery still enabled,
including sessions closed by **Fold and close**. Sessions lost after a restart
remain ordinary missing recovery records. A recreated identity does not inherit
the marker. Registry schema 5 and workspace schema 16 are unchanged. Deploy
backend and frontend together and reload open pages.
