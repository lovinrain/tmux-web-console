# Session work links

Attach GitHub PRs, Jira tickets, and Google Docs to a Muxdeck session. The console
shows chips and a movable, resizable **Work links** panel with one status card
and retained note per link. Google Docs chips use the supplied document `title`,
with `label` as a fallback. Long document URLs stay in the destination, tooltip,
and editor. Click a chip to open its URL. Dashboard search includes link labels,
titles, URLs, and reported states.

**The coding agent accesses providers and updates status.** Muxdeck stores and
displays links, notes, and reports. It never contacts GitHub, Jira, or Google,
runs access instructions, schedules refresh, launches an agent, or sends terminal
input for this feature. Enterprise hosts and path prefixes are accepted; links
must be absolute HTTP(S) URLs without embedded credentials.

## Configuration

Settings persist immediately and apply to this Muxdeck installation. Edit them
through **Work links → Configure** or the authenticated API; no restart is needed.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for chips, panels, and link/status writes. |
| `providers.github.enabled` | `true` | Enable GitHub PR links. |
| `providers.jira.enabled` | `true` | Enable Jira ticket links. |
| `providers.google_docs.enabled` | `true` | Enable Google Docs title chips. |
| Each provider's `refreshEnabled` | `false` | Allow agent-submitted status reports. Notes and links remain editable when refresh is off. |
| Each provider's `refreshIntervalSeconds` | `300` | Suggested agent refresh cadence, from 30 to 86,400 seconds; creates no server timer. |
| Each provider's `instructions` | empty | User-supplied tool, enterprise host, and account guidance. |

Each link also has `instructions` for its specific host/account/document. Agents
read these alongside provider instructions. Store tool/account guidance here;
keep secrets in existing private credential stores.

An agent-owned watch loop must reread configuration before each external read,
honor both enable switches and `refreshEnabled`, and use the supplied access
instructions. An idle/stopped agent performs no refresh. The panel's **Reload
saved reports** and normal session updates read Muxdeck only. Cards show server
receipt time, not independently verified provider freshness; `reportedBy` is
agent-supplied attribution. These APIs do not modify upstream tickets or PRs.

Disabling a provider or the master switch retains all stored records. Reads and
configuration remain available for discovery/recovery. Re-enable the master
switch through the API/CLI when its UI is hidden.

## Discovery for running agents

```bash
muxdeckctl work-links context
muxdeckctl work-links config
```

Context uses `TMUX_PANE` on the configured Muxdeck server. It returns the stable
session `historyId`, links, config, access instructions, limits, and API operations.
Use `--session NAME` or `--pane '%42'` to select explicitly. Outside tmux, omitting
a target returns guidance/config without a session. A pane on a different tmux
server requires selecting the correct Muxdeck installation first.

Equivalent discovery endpoints are `GET /api/work-links/context?paneId=%2542`
and `GET /api/work-links/context?session=ENCODED_SESSION_NAME`.
`GET /api/capabilities` advertises `workLinks` even while disabled.

The CLI reads `MUXDECK_URL` (default `http://127.0.0.1:7683/mux`) and
`MUXDECK_CONTROL_TOKEN_FILE` (default `~/.config/muxdeck/control-token`). Existing
trusted control credentials and normal browser login can access these endpoints;
callback-only credentials cannot. The control token retains its existing
shell-control privileges; it is not a link-only token. No new public route,
port, or authentication exception is needed.

Discovery works for already-running agents without relaunch. It does not inject
instructions into their conversations: tell an existing agent to run the command,
or include this instruction in repository guidance.

## Programmatic configuration

Read the current configuration revision, then save a patch file such as:

```json
{
  "expectedRevision": 0,
  "providers": {
    "github": {
      "enabled": true,
      "refreshEnabled": true,
      "refreshIntervalSeconds": 300,
      "instructions": "For git.company.example, use gh with the work account. Read PR state, review decision, and checks; report them in Muxdeck."
    },
    "jira": {
      "enabled": true,
      "refreshEnabled": false,
      "instructions": "Use the company Jira MCP for jira.company.example."
    },
    "google_docs": {
      "enabled": true,
      "instructions": "Use Google Docs MCP with the work account. Supply the document title and retain decisions in notes."
    }
  }
}
```

```bash
muxdeckctl work-links config --json @config-patch.json
```

This calls `PATCH /api/work-links/config`. A stale `expectedRevision` returns
`409`; reread and reconcile intended fields instead of overwriting another writer.
Unknown fields and invalid values return `400`.

## Link API

Paths are relative to the configured base path, normally `/mux`. Percent-encode
session names and query values. `muxdeckctl api` accepts these paths directly.

| Method and path | Request/result |
| --- | --- |
| `GET /api/work-links/config` | `{config}` with its revision. |
| `PATCH /api/work-links/config` | `expectedRevision` and changed configuration fields. |
| `GET /api/sessions/{session}/work-links` | Session identity, links, config, guide, and limits. |
| `POST /api/sessions/{session}/work-links` | Required `historyId`, `provider`, `url`; optional `label`, `title`, `notes`, `instructions`. Returns `{link, created}`. |
| `GET /api/work-links/{id}` | `{link, config}`. |
| `PATCH /api/work-links/{id}` | `expectedRevision` and changed `url`, `label`, `title`, `notes`, `instructions`. |
| `PUT /api/work-links/{id}/status` | `expectedStatusRevision` and `status`. |
| `DELETE /api/work-links/{id}` | JSON body with `expectedRevision`; removes the Muxdeck record only. |
| `GET /api/session-history/{historyId}/work-links` | Retained links/notes for that incarnation, including ended sessions. |

For example, use the `historyId` returned by discovery in an add payload:

```json
{
  "historyId": "RETURNED_SESSION_HISTORY_ID",
  "provider": "google_docs",
  "url": "https://docs.google.com/document/d/DOCUMENT_ID/edit?tab=t.0",
  "title": "Release planning and decisions",
  "notes": "Keep the launch checklist and unresolved questions here."
}
```

```bash
muxdeckctl api POST /api/sessions/ENCODED_SESSION_NAME/work-links --json @link.json
```

Use `github` for PR URLs or `jira` for ticket URLs. Labels default to `PR #123`,
`ENG-123`, or `Google Doc` when recognizable. A Google Docs title takes precedence
in chips; other providers keep their short label. No metadata is fetched.

Adding the same provider/URL again for a session returns the existing record with
`created: false` and preserves its notes. Each incarnation permits 32 links;
different sessions can associate the same URL independently.

After an actual provider read, report the observed status:

```json
{
  "expectedStatusRevision": 0,
  "status": {
    "state": "Changes requested",
    "tone": "warning",
    "summary": "Checks passing. One review requests changes to error handling.",
    "reportedBy": "implementation agent"
  }
}
```

```bash
muxdeckctl api PUT /api/work-links/LINK_ID/status --json @status.json
```

`state` is free text for enterprise workflows. `tone` is `neutral`, `info`,
`success`, `warning`, or `danger`; `summary` and `reportedBy` are optional.
The server records `statusUpdatedAt` on receipt. Agent activity, ticket state,
and PR status stay separate signals.

Update notes with `PATCH /api/work-links/{id}` and, for example,
`{"expectedRevision":1,"notes":"Retain this decision across status updates."}`.
Metadata/notes use `revision`; reports use `statusRevision`. Reports never replace
notes or invalidate a current notes edit. Concurrent edits to the same channel
return `409`. Changing a URL clears the old report and advances the status revision
so an in-flight report for the old target cannot overwrite it. Do not blindly
retry stale writes.

## Persistence and deployment

Links use the registry's stable session-history UUID, not its editable name.
Renames retain links. Fresh sessions reusing a name start independently; ending
a session retains its records through the history endpoint. Recreating a shell
creates a new incarnation; explicitly add any links wanted there.

The private `work-links.sqlite3` file lives beside the configured session registry;
`MUXDECK_WORK_LINKS_FILE` overrides it. Schema version 1 is separate from workspace
and registry schemas. Include it in private SQLite backups and keep it on rollback;
older releases ignore it. A damaged/unsupported database returns `503` for this
feature while terminal access remains available. Do not edit a running database
by hand.
