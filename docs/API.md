# Muxdeck HTTP API Reference

Muxdeck exposes the same authenticated operations used by its web UI as an
HTTP and WebSocket API. The API can create and organize tmux sessions, manage
saved workspaces and pane views, edit notes and quick links, browse files, and
observe live state.

The API controls shells with the Unix privileges of the Muxdeck service. Treat
credentials, remembered-device cookies, terminal output, and downloaded files
as sensitive.

## Conventions

### Base URL

Every route is below the configured `MUXDECK_BASE_PATH`, which defaults to
`/mux`. Examples in this document use:

```text
https://mux.example.test/mux/api/...
```

If `MUXDECK_BASE_PATH` is empty, routes begin at `/api`. `GET
/api/capabilities` returns the active base path, API version, authentication
mode, supported resource families, and workspace limits.

### Authentication

All terminal and automation routes use the configured server authentication
mode. There is no separate unauthenticated automation API.

Callback automation can also use a dedicated `Authorization: Bearer <token>`
credential configured by `MUXDECK_CALLBACK_TOKEN_FILE`. It permits only listing,
posting, and reviewing callback messages, plus reading `/api/callback-sessions`.
It grants no access to terminals, files, workspaces, login devices, or streams.
An invalid supplied bearer token returns `401`, even with a valid browser cookie;
using a valid callback token outside its scope returns `403`. Use
`scripts/muxdeck_callback.py` to read the private token file without putting the
credential in shell arguments. See [Agent callback instructions](AGENT_CALLBACKS.md).

| Mode | Automation method |
| --- | --- |
| `server` | Log in once with `POST /api/auth/login`, then send the returned HttpOnly device cookie. |
| `basic` | Send HTTP Basic credentials with every request. |
| `none` | No credential is required. Use only behind an intentional external trust boundary. |

For `server` mode, use a private cookie jar:

```bash
umask 077
read -r -p "Muxdeck user: " MUXDECK_USER
read -r -s -p "Muxdeck password: " MUXDECK_PASSWORD
curl --fail-with-body \
  --cookie-jar ./muxdeck.cookies \
  --header 'Content-Type: application/json' \
  --data "$(jq -n --arg u "$MUXDECK_USER" --arg p "$MUXDECK_PASSWORD" \
    '{username:$u,password:$p}')" \
  https://mux.example.test/mux/api/auth/login
unset MUXDECK_PASSWORD

curl --fail-with-body --cookie ./muxdeck.cookies \
  https://mux.example.test/mux/api/workspaces
```

The cookie jar is bearer-equivalent authentication material. Do not commit it,
share it, or make it world-readable. In `basic` mode, prefer an environment,
netrc, or secret-manager integration over a literal password in shell history.

Non-browser clients may omit `Origin`. Requests with an untrusted `Origin` or
`Host` are rejected by the same request-security middleware used for the UI.

Authentication endpoints are:

| Method and route | Request/result |
| --- | --- |
| `POST /api/auth/login` | In `server` mode, accepts `username` and `password`, sets the remembered-device cookie, and returns the authenticated device. |
| `GET /api/auth/session` | Reports the current authentication mode and remembered-device status. |
| `POST /api/auth/logout` | Revokes the current remembered device and clears its cookie. |

The login route is public only so credentials can be exchanged for a device
cookie. The session and logout routes remain protected as appropriate for the
active mode.

### JSON, identifiers, and errors

JSON request bodies require `Content-Type: application/json`. Unknown fields
are rejected so misspelled automation inputs do not silently succeed. Binary
upload routes are noted separately.

Session names in URL path segments must be percent-encoded. Workspace, group,
pane-layout, message, history, and recovery IDs are opaque strings returned by
the API; do not derive them from display names.

JSON errors have this shape:

```json
{"error":"human-readable explanation"}
```

Typical status codes are:

| Status | Meaning |
| --- | --- |
| `200`, `201`, `204` | Success, creation, or success without a body. |
| `400` | Invalid JSON, field, identifier, or operation. |
| `401`, `403` | Authentication is required or the request/path is forbidden. |
| `404` | The requested tmux or persisted resource no longer exists. |
| `409` | Identity/revision conflict, duplicate resource, or unsafe state transition. |
| `413`, `415` | Body is too large or the preview/file type is unsupported. |
| `500`, `503`, `507` | Persistence/service failure or attachment storage exhaustion. |

### Session identity

Destructive and pane-scoped operations require identity fields returned by
`GET /api/sessions`. A native tmux name can be reused, so a name alone is not a
safe identity.

- `sessionId` is the native tmux session ID.
- `sessionCreated`, `serverStarted`, and `serverPid` fence session termination.
- `paneId` fences file and history operations to a pane from the current
  session snapshot.

Refresh the session inventory and retry deliberately after a `409`; do not
blindly retry a destructive request with old identity values.

### Workspace session revision

Every workspace response includes `sessionRevision`. Supply that exact integer
for any mutation containing session-name references: tabs, groups, separators,
pane layouts, callback sessions, or the active session. The revision is a
global rename/transfer fence, not a per-workspace version. A revision mismatch
returns `409` when session identity or membership changed through a rename,
global-pin change, transfer, or recovery-record removal. Reload the workspace,
resolve names, and retry.

### Workspace update version

For `PATCH /api/workspaces/{workspaceId}` and
`POST /api/workspaces/{workspaceId}/activity`, also send `expectedUpdatedAt`
with the exact `updatedAt` value from the workspace snapshot being edited.
The server checks it under the workspace lock and returns `409` without
writing if the workspace has changed. This protects ordinary concurrent
tab/activity edits in addition to the global `sessionRevision` fence. Reload
and reconcile the intended change with the current snapshot before retrying;
do not simply replace the version token on an obsolete full tab list.

`expectedUpdatedAt` is optional for older API callers. Omitting it retains
the previous replacement behavior without this workspace-version protection.
The current web client sends it for autosaves and page-exit activity requests.
For an older backend, only the explicit `400` error
`unknown field: expectedUpdatedAt` enables a compatibility retry without the
field. The browser remembers that lack of support for the current page and
also omits the field from subsequent page-exit requests. A `409` never removes
the version check. Reload the page after upgrading the backend to restore
version-aware writes.

The granular collection routes described below mutate state atomically under
the workspace lock. This avoids the read-modify-replace race of editing a whole
array with `PATCH /api/workspaces/{workspaceId}`.

## Discovery and health

| Method and route | Purpose |
| --- | --- |
| `GET /api/capabilities` | Machine-readable API version, base path, auth mode, resource families, enums, and limits. |
| `GET /api/health` | tmux connectivity check; returns `ok` and the live session count. |
| `GET /api/host-metrics?range=15m` | On-demand CPU, per-core, memory, PSI, swap, and process-host snapshot. `range` is `15m`, `1h`, or `24h`. |

Example:

```bash
curl --fail-with-body --cookie ./muxdeck.cookies \
  https://mux.example.test/mux/api/capabilities | jq
```

## Workspaces

### Workspace representation

```json
{
  "id": "b58f...",
  "name": "Release work",
  "tabs": ["agent-a", "agent-b"],
  "groups": [],
  "quickLinks": [],
  "separators": [],
  "separatorsBefore": [],
  "paneLayouts": [],
  "callbackSessions": [],
  "activeSession": "agent-a",
  "createdAt": 1770000000000,
  "updatedAt": 1770000000000,
  "lastActiveAt": 1770000000000,
  "sessionRevision": 7
}
```

`callbackSessions` may be omitted when empty; clients should interpret an
absent value as `[]`. Saved workspace tabs may reference ended sessions so the
navigation/history record survives process exit.

### Workspace CRUD

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspaces` | None | `{workspaces:[...]}`, most recently active first. |
| `POST /api/workspaces` | `name`, `tabs`, `activeSession`; optional `groups`, `separators`, `separatorsBefore`, `paneLayouts`, `callbackSessions` | Creates a workspace and returns `{workspace}` with `201`. |
| `GET /api/workspaces/{workspaceId}` | None | `{workspace}`. |
| `GET /api/workspaces/{workspaceId}/stream` | None | SSE `workspace` events containing `{workspace,callbacks}`; `workspace` is `null` when deleted or absent. |
| `PATCH /api/workspaces/{workspaceId}` | One or more workspace fields; `sessionRevision` when any session-bearing field is present; optional `expectedUpdatedAt` | Replaces the supplied fields and returns `{workspace}`; rejects a stale version with `409`. |
| `DELETE /api/workspaces/{workspaceId}` | None | Deletes saved navigation state and its workspace note; does not terminate tmux sessions. |
| `POST /api/workspaces/{workspaceId}/activity` | `tabs`, `activeSession`, `sessionRevision`; optional `groups`, `expectedUpdatedAt` | Saves tab activity and advances `lastActiveAt`; rejects a stale version with `409`. |

Create a workspace:

```bash
curl --fail-with-body --cookie ./muxdeck.cookies \
  --header 'Content-Type: application/json' \
  --data '{"name":"API workspace","tabs":["agent-a"],"activeSession":"agent-a"}' \
  https://mux.example.test/mux/api/workspaces
```

`PATCH` supports `name`, `tabs`, `groups`, `separators`,
`separatorsBefore`, `paneLayouts`, `callbackSessions`, and `activeSession`.
Renaming with only `name` does not need `sessionRevision`. Whole-array updates
are useful for import/export; prefer granular routes for interactive or
concurrent automation.

### Workspace event stream

`GET /api/workspaces/{workspaceId}/stream` sends a complete current workspace
on connection and reconnection, followed by changed snapshots in `workspace`
events. Each event's JSON body is
`{ "workspace": <workspace object or null>, "callbacks": <global callback snapshot> }`.
`callbacks` has the same snapshot shape as `GET /api/callback-sessions`.
Deletion or an absent workspace sets `workspace` to `null`. Clients
can reconnect without replaying an event log because the initial snapshot is
authoritative. Heartbeat comments keep intermediaries alive; an `auth` event
with `{ "authenticated": false }` precedes closure when remembered-device
authentication expires or is revoked. The route uses the same authentication
and origin checks as the other APIs.

The web client applies these snapshots while retaining its current session
selection if that session is still a workspace tab. Pending local tab/group
edits are reconciled against the new state so independent additions and closes
survive. If streaming is unavailable, it fetches the workspace every four
seconds and when the page regains focus. A loaded saved-workspace page receives
callback updates on this same connection instead of opening a second callback
stream, avoiding unnecessary HTTP/1.1 connection slots across open tabs.

### Workspace sessions

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspaces/{workspaceId}/sessions` | None | `sessions`, `activeSession`, and `sessionRevision`. |
| `POST /api/workspaces/{workspaceId}/sessions` | `sessions`, `sessionRevision`; optional `position`, `relativeTo`, `activeSession` | Adds missing names without duplicates and returns `added` plus the workspace. |
| `PUT /api/workspaces/{workspaceId}/sessions` | `sessions`, `sessionRevision`; optional `activeSession` | Replaces/reorders the full tab list atomically. |
| `DELETE /api/workspaces/{workspaceId}/sessions` | `sessions`, `sessionRevision` | Removes existing names and returns `removed` plus the workspace. |

`position` is `start`, `end` (default), `before`, or `after`. `relativeTo` is
required for `before` and `after` and forbidden otherwise. Existing names in an
add request are ignored while the order of newly added names is preserved.
When removal eliminates the active tab, the first remaining tab becomes
active. A globally pinned session cannot be removed through these routes;
unpin it first.

Add two sessions after a known tab and focus one:

```bash
curl --fail-with-body --cookie ./muxdeck.cookies \
  --request POST --header 'Content-Type: application/json' \
  --data '{
    "sessions":["review-a","review-b"],
    "position":"after",
    "relativeTo":"agent-a",
    "activeSession":"review-a",
    "sessionRevision":7
  }' \
  https://mux.example.test/mux/api/workspaces/WORKSPACE_ID/sessions
```

Workspace membership does not require the named session to be live. Use `GET
/api/sessions` first when automation should add only live sessions.

### Groups

A group object is:

```json
{
  "id": "review",
  "name": "Review",
  "color": "cyan",
  "collapsed": false,
  "tabs": ["review-a", "review-b"]
}
```

Group tabs must exist in the workspace, be contiguous in workspace order, and
belong to at most one group. Group IDs are stable ASCII identifiers. Available
colors are returned by `/api/capabilities`.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspaces/{workspaceId}/groups` | None | `groups` and `sessionRevision`. |
| `POST /api/workspaces/{workspaceId}/groups` | `group`, `sessionRevision` | Creates and position-sorts the group; returns `201`. |
| `GET /api/workspaces/{workspaceId}/groups/{groupId}` | None | `group` and `sessionRevision`. |
| `PATCH /api/workspaces/{workspaceId}/groups/{groupId}` | `sessionRevision` plus one or more of `name`, `color`, `collapsed`, `tabs` | Updates the group. |
| `DELETE /api/workspaces/{workspaceId}/groups/{groupId}` | `sessionRevision` | Deletes only the grouping metadata. |

### Separators

Separators are orthogonal to groups. They are anchored to a session and render
immediately `before` or `after` that session.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspaces/{workspaceId}/separators` | None | `{separators:{before:[],after:[]},sessionRevision}`. |
| `POST /api/workspaces/{workspaceId}/separators` | `session`, `placement`, `sessionRevision` | Adds or moves the anchor; `placement` is `before` or `after`. |
| `DELETE /api/workspaces/{workspaceId}/separators` | `session`, `sessionRevision`; optional `placement` | Removes one placement, or both when omitted. |

### Pane layouts (Pane views)

The UI calls these saved resources "Pane views". Their persisted/API field is
`paneLayouts`. A workspace can have multiple named layouts. Each layout root is
either a pane leaf or a recursive split:

```json
{
  "id": "review-pair",
  "name": "Review pair",
  "root": {
    "id": "root",
    "kind": "split",
    "direction": "horizontal",
    "ratio": 0.5,
    "first": {"id":"left","kind":"pane","session":"agent-a"},
    "second": {"id":"right","kind":"pane","session":"agent-b"}
  }
}
```

A pane leaf's `session` can be a workspace session name or `null`. A layout
cannot assign the same session twice. Split directions are `horizontal`
(left/right) and `vertical` (top/bottom). Ratios and current layout limits are
published by `/api/capabilities`.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspaces/{workspaceId}/pane-layouts` | None | `paneLayouts` and `sessionRevision`. |
| `POST /api/workspaces/{workspaceId}/pane-layouts` | `paneLayout`, `sessionRevision` | Creates a named layout and returns `201`. |
| `GET /api/workspaces/{workspaceId}/pane-layouts/{layoutId}` | None | `paneLayout` and `sessionRevision`. |
| `PATCH /api/workspaces/{workspaceId}/pane-layouts/{layoutId}` | `sessionRevision` plus `name` and/or `root` | Renames or replaces the layout tree. |
| `DELETE /api/workspaces/{workspaceId}/pane-layouts/{layoutId}` | `sessionRevision` | Deletes the pane layout, not its sessions. |

Create the example layout:

```bash
jq -n --argjson rev 7 '{
  sessionRevision:$rev,
  paneLayout:{
    id:"review-pair", name:"Review pair",
    root:{
      id:"root", kind:"split", direction:"horizontal", ratio:0.5,
      first:{id:"left",kind:"pane",session:"agent-a"},
      second:{id:"right",kind:"pane",session:"agent-b"}
    }
  }
}' | curl --fail-with-body --cookie ./muxdeck.cookies \
  --request POST --header 'Content-Type: application/json' \
  --data-binary @- \
  https://mux.example.test/mux/api/workspaces/WORKSPACE_ID/pane-layouts
```

Floating UI panels such as the timer and file-browser window are browser-local
presentation state and are not pane layouts. They are intentionally not
exposed as server resources at this time.

### Callback sessions

Callback entries may refer to live or ended sessions. The global queue is the
deduplicated union of explicitly global entries, every workspace callback
entry, and sessions with pending posted callback messages. A workspace
registration therefore always appears in the global view.
Entries that are not open in the current workspace are shown as inherited and
are read-only for navigation (opening one would otherwise add it to the current
workspace), while their review action remains available from any workspace.
Reviewing an entry removes that session from the explicit global queue and
every workspace callback queue, and marks its pending messages reviewed.
The session-queue update and message archive use separate durable stores;
retry after a partial storage failure is safe.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/callback-sessions` | None | Effective `callbackSessions`, explicit `globalCallbackSessions`, contributing `workspaceCallbacks`, `sessionRevision`, pending `callbackMessages`, and `callbackMessageRevision`. |
| `GET /api/callback-sessions/stream` | None | Authenticated `text/event-stream`; emits `callbacks` records whenever the callback snapshot changes. |
| `PUT /api/callback-sessions` | `sessions`, `sessionRevision` | Replaces explicitly global entries and returns the refreshed snapshot. |
| `POST /api/callback-sessions` | `sessions`, `sessionRevision` | Idempotently appends explicitly global entries and returns `added` plus the refreshed snapshot. |
| `DELETE /api/callback-sessions` | `sessions`, `sessionRevision` | Removes explicitly global entries, reviews pending messages for those names, and returns `removed` plus the refreshed snapshot. |
| `POST /api/callback-sessions/review` | `session`, `sessionRevision` | Marks one session reviewed across the global/workspace queues and posted messages. |
| `GET /api/workspaces/{workspaceId}/callback-sessions` | None | `callbackSessions` and `sessionRevision`. |
| `POST /api/workspaces/{workspaceId}/callback-sessions` | `sessions`, `sessionRevision` | Idempotently appends missing entries and returns `added`. |
| `DELETE /api/workspaces/{workspaceId}/callback-sessions` | `sessions`, `sessionRevision` | Removes present entries and returns `removed`. |

### Posted callback messages

Agents can post completion reports independently of the manual session queues.
Records live in `callbacks.sqlite3` (override with `MUXDECK_CALLBACKS_FILE`) and
survive service restarts. Reviewing a message preserves its content and metadata
in history. It never ends the session or executes the message text.

| Method and route | Request | Result |
| --- | --- | --- |
| `POST /api/callback-messages` | JSON described below | `{callback, duplicate}`; `201` for a new record, `200` for an identical retry. |
| `GET /api/callback-messages` | Optional `status=pending\|reviewed\|all`, `after`, `limit` | `{messages, nextAfter, revision}` in ascending sequence order. |
| `POST /api/callback-messages/{id}/review` | No body required | `{callback, callbacks}` with the reviewed record and refreshed global callback snapshot. Already reviewed records are unchanged. |

Required POST fields are `message` (nonblank text, up to 16,384 characters),
`sessionName` (native tmux name), `agentType` (up to 64 characters), and `cwd`
(absolute path, up to 4,096 characters). Optional fields are `requestId`
(up to 128 characters), `tmuxSessionId`, `tmuxPaneId`, and `host` (up to 255
characters). Unknown fields and invalid/control-character metadata return `400`.
Message text may contain newlines and tabs and is rendered as text.
Metadata describes what the agent reported; posting does not require a live
session and does not prove that a session with a reused name is the same process.

Each returned record includes those fields (omitted optional fields become
`null`) and a server-assigned `id`, increasing integer `sequence`, Unix-second
`createdAt`, and nullable `reviewedAt`. Reuse the same `requestId` and identical
body when retrying delivery; a different body under that ID returns `409`.
Idempotency survives review and server restart. At most 256 messages may be
pending; further new messages return `409` until some are reviewed. Reviewed
history is retained.

Listing defaults to `status=pending`, `after=0`, and `limit=100` (maximum 200).
Pass the returned `nextAfter` as `after` to fetch the next page; `null` means
there are no more records in that result. `status=all` is useful for incremental
readers tracking the largest sequence. To observe later review-state changes,
refresh pending/reviewed records rather than relying only on a sequence cursor.
Pages are live reads, not a frozen snapshot; `revision` changes with new posts
and review updates. Reading never acknowledges a message.

Pending messages appear in global callback snapshots and existing callback and
workspace streams. `callbackMessageRevision` advances independently of workspace
`sessionRevision`; clients reconcile both independently. Posting only derives a
callback entry from the message and does not add a manual queue marker or change
workspace tabs. Replacing a manual queue with `PUT /api/callback-sessions` leaves
posted messages intact; use explicit review operations to acknowledge them.

### Move, copy, and global pin

| Method and route | Request | Result |
| --- | --- | --- |
| `POST /api/session-workspace-transfer` | `session`, `destinationWorkspaceId`, `operation`, `sessionRevision`; optional `sourceWorkspaceId` | Atomically `copy` or `move` one live session between workspaces. |
| `POST /api/session-workspace-transfer/bulk` | Ordered, unique `sessions`, `destinationWorkspaceId`, `operation`, `sessionRevision`; optional `sourceWorkspaceId` | Atomically transfers the complete batch, including saved references to ended sessions. |
| `PUT /api/session-workspace-pin` | `session`, `pinned` | Adds/removes a live session across every saved workspace with deduplication. |

Moving a globally pinned session returns `409`. A transfer reports whether the
destination already contained the session, whether it was added, and whether
the source entry was removed.

The bulk response returns ordered arrays in `destinationAlreadyContained`,
`destinationAdded`, and `sourceRemoved`. Destination additions follow the
request order and existing tabs are never duplicated. A move that includes any
globally pinned session, exceeds either workspace capacity, or uses a stale
revision returns `409` without moving any member of the batch.

### Quick links

A link has `id`, `label`, and an absolute `http` or `https` `url`. Collection
updates replace the complete ordered list for that scope.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/workspace-quick-links` | None | Common links shared by all workspaces. |
| `PUT /api/workspace-quick-links` | `{links:[...]}` | Replaces common links. |
| `GET /api/workspaces/{workspaceId}/quick-links` | None | Workspace links. |
| `PUT /api/workspaces/{workspaceId}/quick-links` | `{links:[...]}` | Replaces workspace links. |
| `GET /api/sessions/{session}/quick-links` | None | Live-session links. |
| `PUT /api/sessions/{session}/quick-links` | `{links:[...]}` | Replaces live-session links. |

### Notes and notebooks

Each note scope is a notebook with one or more ordered pages:

```json
{
  "notebook": {
    "pages": [
      {"id":"main","name":"Page 1","content":"Remember this"}
    ]
  }
}
```

`PUT` accepts exactly one of `note` (legacy first-page text) or `notebook`.
Responses contain both `note` and `notebook`.

| Method and route | Scope |
| --- | --- |
| `GET`, `PUT /api/common-note` | Shared by all workspaces. |
| `GET`, `PUT /api/workspaces/{workspaceId}/note` | One saved workspace. |
| `GET`, `PUT /api/sessions/{session}/note` | One live session. |

## Tmux sessions

### Inventory and lifecycle

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/sessions` | None | Live session snapshot, metadata, pane identities, agent state/reference, recovery history, and workspace pin state. |
| `POST /api/sessions` | Optional `name`, `directory`, `theme` (`dark` or `light`) | Creates a tmux session; returns `session` and `sessionId` with `201`. |
| `POST /api/sessions/{session}/copy` | `sessionId`; optional `theme` | Creates a session in the source PWD with the next available suffixed name. |
| `PUT /api/session-name` | `session`, `name` | Renames a live native tmux session and migrates Muxdeck references. |
| `DELETE /api/sessions/{session}` | `sessionId`, `sessionCreated`, `serverStarted`, `serverPid` | Terminates exactly the identified tmux session. This is destructive. |

Creation launches the configured default shell; it does not automatically
start a coding agent. `directory` must be an absolute accessible server path.

### Metadata

These routes require a live session and return the saved value:

| Method and route | JSON request |
| --- | --- |
| `PUT /api/session-title` | `session`, `title` |
| `PUT /api/session-star` | `session`, `starred` boolean |
| `PUT /api/session-ignored` | `session`, `ignored` boolean |
| `PUT /api/session-tags` | `session`, `tags` array |
| `PUT /api/session-details` | `session`, `title`, `tags` array |

### Session history and recovery

| Method and route | Request | Purpose |
| --- | --- | --- |
| `GET /api/session-history?workspace=ID&q=TEXT&recycled=0&offset=0` | Optional query fields | Lists observed/current or recycled session history. |
| `POST /api/session-history/close-tab` | `session`, `sessionId` | Records that a live session tab was closed without ending tmux. |
| `POST /api/session-history/{historyId}/restore` | `create` boolean | Finds the original live identity or explicitly recreates a shell from saved name/PWD. |
| `POST /api/recoverable-sessions/{recoveryId}/recreate` | Optional `theme` | Recreates a saved recoverable shell. |
| `DELETE /api/recoverable-sessions/{recoveryId}` | None | Immediately forgets an ended recovery record and removes its saved-workspace references; returns `{undoToken, expiresAt}` with a 30-second undo deadline in Unix milliseconds. Refuses a live session. |
| `POST /api/recoverable-sessions/{recoveryId}/undo-forget` | `undoToken` | Restores the forgotten record and its saved-workspace references, preserving later edits; returns `{recovery, workspaces}` with canonical workspace snapshots. |

Undo tokens are single-use and the server enforces the deadline. An expired
token returns `410`; an unknown, used, or mismatched token returns `404`.
A live or reused session name returns `409`. Pending undo snapshots are held
in memory, so restarting Muxdeck finalizes outstanding forgets. Undo never
creates a tmux session. The updated browser also accepts an older server's
`204` DELETE response, but cannot offer Undo for that response.

Recovery stores reference metadata (including detected agent type/session ID
when available), but recreation starts a shell. It does not resume an agent's
private conversation automatically.

### Utility terminals

| Method and route | Request | Purpose |
| --- | --- | --- |
| `POST /api/utility-terminal` | `workspaceKey`, `sourceSession`, `sourceSessionId`, `create` boolean | Gets or creates the hidden shell backing a workspace/session utility terminal. |
| `POST /api/utility-terminal/release` | `workspaceKey`; optional `destination` saved workspace key | Releases or transfers utility-terminal ownership. |

Saved workspace keys use `workspace:{workspaceId}`. The UI also uses
session-scoped and temporary keys; discover those from UI state before calling
this lower-level route. Utility sessions are implementation resources and may
be renamed internally.

## Memos and queued messages

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/sessions/{session}/messages` | None | Ordered memo/queue entries. |
| `POST /api/sessions/{session}/messages` | `text`; optional `state` | Creates an entry with `201`; default state is `queued`. |
| `PATCH /api/sessions/{session}/messages/{messageId}` | One or more of `text`, `position`, `state` | Updates content, order, or state. |
| `DELETE /api/sessions/{session}/messages/{messageId}` | None | Deletes the entry. |

These records are Muxdeck staging/memo data. Posting a record does not write
bytes to the PTY. Interactive terminal input is sent over the terminal
WebSocket described below.

## Snippets and keyboard shortcuts

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/snippets` | None | `{revision,tree}`. |
| `PUT /api/snippets` | `revision`, `tree` | Replaces the complete tree if the revision matches. |
| `GET /api/shortcuts` | None | `{revision,bindings,...}`. |
| `PUT /api/shortcuts` | `revision`, `bindings` | Replaces all bindings if the revision matches. |

Both update routes return `409` plus the current revision on concurrent edit.
Preserve unknown response metadata and begin changes from a fresh `GET`.

## Attachments and files

### Composer attachments

`POST /api/sessions/{session}/attachments?filename=NAME&sessionId=ID` uploads
the raw request body to Muxdeck's private temporary attachment store and
returns its server path. `/images` is a compatibility alias for the same
handler. Uploading does not press Enter or otherwise submit terminal input.

### File-browser identity query

File routes operate relative to a verified live pane and require these query
parameters:

- `sessionId`: current tmux session ID;
- `paneId`: a pane ID belonging to that session;
- `path`: relative path within the selected root, when the route needs a
  target;
- `root`: optional absolute browse root replacing the pane PWD while still
  respecting `MUXDECK_FILE_BROWSER_ROOT`.

All path resolution is server-side and rejects escapes outside the configured
boundary, including symlink escapes. Use URL encoding for every query value.

### Read, search, preview, and download

| Method and route | Additional input | Result |
| --- | --- | --- |
| `GET /api/sessions/{session}/files` | Optional `path`, `root` | Directory listing. |
| `GET /api/sessions/{session}/files/resolve` | Required `path`; optional `root` | Resolves an absolute file/directory target inside the boundary. |
| `GET /api/sessions/{session}/files/search` | `q`; optional `hidden=0|1`, `root` | Fuzzy recursive file locator. |
| `GET /api/sessions/{session}/files/preview` | Required `path`; optional `root` | Safe text preview metadata/content. |
| `GET /api/sessions/{session}/files/image` | Required `path`; optional `root` | Inline raster image response. |
| `GET /api/sessions/{session}/files/pdf` | Required `path`; optional `root` | Inline PDF response. |
| `GET /api/sessions/{session}/files/html` | Required `path`; optional `root` | Authenticated redirect to a temporary interactive HTML preview. |
| `GET /api/sessions/{session}/files/download` | Required `path`; optional `root` | Attachment download. |

The HTML redirect targets `GET /preview/{token}/{path}` (also supports `HEAD`),
under the configured base path. This URL permits cookie-free reads of supported
assets inside the HTML file's directory tree for up to one hour, while the
original session and pane remain live. A service restart also expires it.
The document runs scripts in an opaque-origin sandbox without console API,
cookie, or browser-storage access. Reopen the original HTML endpoint to refresh
an expired preview. See the [reference](REFERENCE.md) for supported preview
assets and limits.

### File mutations

The identity and path fields stay in the query string; mutation-specific
fields are JSON unless noted.

| Method and route | JSON/body | Result |
| --- | --- | --- |
| `POST /api/sessions/{session}/files/upload` | Raw bytes; query also requires `filename` | Creates a file with `201`. |
| `POST /api/sessions/{session}/files/create` | `name`; optional `kind` (`directory` default or `file`) | Creates an empty file/folder with `201`. |
| `POST /api/sessions/{session}/files/move` | `destination` | Renames or moves one entry. |
| `POST /api/sessions/{session}/files/copy` | `destination` | Copies one entry with `201`. |
| `POST /api/sessions/{session}/files/delete` | Optional `recursive` boolean | Deletes one entry. This is destructive. |
| `PUT /api/sessions/{session}/files/content` | `content`; optional `expectedModified` | Saves text with an optional modification-time conflict fence. |
| `POST /api/sessions/{session}/files/archive` | Exactly one of `names` or `paths` arrays | Streams a ZIP of selected files/folders. |

The archive response includes `X-Muxdeck-Archive-*` count/size headers. File
limits are bounded; inspect a `413` error instead of assuming an upload or
archive completed.

## Terminal history and real-time APIs

### Scrollback snapshots

| Method and route | Purpose |
| --- | --- |
| `POST /api/panes/{paneId}/history?limit=250` | Captures current tmux scrollback into a short-lived snapshot. |
| `GET /api/history/{snapshotId}?before=N&limit=250` | Reads an older page from that immutable snapshot. |

`limit` is clamped to 20-1000.

### Session event stream

`GET /api/sessions/stream` is a Server-Sent Events stream. `sessions` events
contain serialized session snapshots, heartbeat comments keep intermediaries
alive, and an `auth` event reports an expired/revoked remembered device before
the stream closes.

### Terminal WebSocket

Connect to:

```text
/ws/terminal?session=NAME&identity=IDENTITY&cols=100&rows=30&ignoreSize=0
```

`identity` is the current identity string supplied by the session snapshot.
The server first sends a JSON `ready` message. Binary WebSocket frames carry
PTY output and client binary/text frames carry terminal input. JSON control
messages support `{type:"resize",cols,rows}`, acknowledged staged writes via
`{type:"input",id,data}`, and `{type:"history",action}` navigation. Consumers
should follow the behavior of the web client in `src/api.ts` and
`src/components/LiveTerminal.tsx`. A terminal WebSocket is a live tmux
attachment: arbitrary input can execute commands.

## Current limits

Do not hard-code these where discovery is possible. Read
`GET /api/capabilities` at startup.

| Resource | Current limit |
| --- | --- |
| Sessions per workspace | 256 |
| Groups per workspace | 16 |
| Callback sessions per workspace | 64 |
| Explicit global callback sessions | 256 |
| Quick links per scope | 16 |
| Notebook pages per scope | 128 |
| Pane layouts per workspace | 16 |
| Pane leaves per layout | 12 |
| Pane split depth | 6 |
| Pane split ratio | 0.15-0.85 |

## Automation guidance

1. Discover `/api/capabilities` and fetch the current resource before writing.
2. Carry tmux identity fields into destructive or pane-scoped operations.
3. Carry `sessionRevision` into every workspace session-bearing mutation, and
   send the last observed `updatedAt` as `expectedUpdatedAt` for workspace
   `PATCH` and activity requests.
4. Treat `409` as a request to reload and reconcile, not as permission to
   force an old snapshot over new state.
5. Prefer granular workspace endpoints for adds/removes; use whole-array
   replacements for intentional import/export.
6. Apply your own idempotency logic around tmux session creation. Workspace
   session adds and callback adds are already deduplicating/idempotent.
7. Never automate `DELETE /api/sessions/{session}` from a name alone; use the
   complete current identity tuple and require an explicit operator policy.
