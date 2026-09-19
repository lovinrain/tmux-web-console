# Report a completed task to Muxdeck

When the user says **“after you complete the work, follow ~/s/g/cb.md to post a message about XXXX”**, finish the requested work first, then post one callback whose message answers that request. Describe the actual result, relevant validation, and any remaining blocker; do not claim unfinished work is complete. Use the user's supplied text verbatim when they explicitly ask for an exact message. Do not include credentials or unrelated private data.

The message is stored persistently on **https://la.99818888.xyz/mux/** and appears in its callback list with the actual tmux session name, agent type, working directory, host, and timestamp. It survives browser refreshes and server restarts. This is an explicit HTTP notification; it does not depend on terminal output or an agent's built-in completion hooks.

## Post a callback

Run the helper from the task's own tmux session. Choose your actual lowercase agent type explicitly: `codex`, `claude`, `cursor`, `grok`, or another accurate name. Do not copy `codex` if you are a different agent.

```bash
python3 ~/s/g/cb.py post --agent codex <<'MUXDECK_CALLBACK_MESSAGE'
XXXX: describe the completed work and its result here.
MUXDECK_CALLBACK_MESSAGE
```

The quoted heredoc passes message text literally, including quotes, backticks, dollar signs, and newlines. For arbitrary content, create a UTF-8 file using your file-writing tool and use:

```bash
python3 ~/s/g/cb.py post --agent codex --message-file /absolute/path/to/callback-message.txt
```

Do not interpolate the message into an unquoted shell command. Do not put the bearer token in a command, source file, callback message, or chat reply.

The helper uses `TMUX_PANE` and the socket in `TMUX` to ask tmux for its native session name and IDs, plus `pane_current_path`. It checks that the pane's process is an ancestor of this invocation, rejecting an inherited/stale tmux environment that points to an unrelated session. `cwd` defaults to that pane's current path. If the agent worked in a different directory within the same session, pass its verified absolute path with `--cwd /actual/task/directory`.

If running outside tmux, the helper fails rather than guessing. Run it inside the correct session, or supply **both** `--session actual-tmux-name --cwd /actual/task/directory` only after verifying those values independently. Explicit session/directory overrides omit tmux IDs because they cannot verify the target pane. Never invent a session name from a display title, browser URL, project name, or prior agent response.

To inspect the exact metadata without sending anything or loading credentials, add `--dry-run` to the post command. This does not fulfill the user's request to post a callback.

## Confirm delivery and handle retries

A successful command exits `0` and prints JSON with `callback` and `duplicate`. A new record has `duplicate: false`; an idempotent retry returns the existing record with `duplicate: true`. Only report the callback as posted after receiving this success response.

The helper prints a `requestId` UUID to stderr before sending. It automatically retries transient failures up to three times using the same body and UUID. If the command ultimately fails and receipt is uncertain, retry the **same message and metadata** with the printed UUID:

```bash
python3 ~/s/g/cb.py post --agent codex \
  --request-id REPLACE_WITH_THE_ORIGINAL_UUID \
  --message-file /absolute/path/to/callback-message.txt
```

Reusing the UUID prevents duplicate callbacks. Do not reuse a UUID for a different task or changed message. If authentication fails, report the failure and ask the Muxdeck owner to provision the callback token; do not scrape browser credentials or weaken server authentication.

## Read callbacks programmatically

All commands print JSON to stdout; diagnostics go to stderr. The default list contains pending callback messages. Reviewed messages remain in persistent history.

```bash
# One page of pending callbacks.
python3 ~/s/g/cb.py list

# Every pending callback, fetching all pages.
python3 ~/s/g/cb.py list --all-pages

# Complete history, including reviewed callbacks.
python3 ~/s/g/cb.py list --status all --all-pages

# Mark one message reviewed, when the user requests acknowledgement.
python3 ~/s/g/cb.py review CALLBACK_ID
```

A page has `messages`, `nextAfter`, and `revision`. Fetch another page with `--after 'VALUE_FROM_nextAfter'`; `nextAfter: null` ends pagination. `--limit` sets the page size. Listing never marks messages reviewed. `--all-pages` combines pages into one result; it is a live listing, so concurrent posts/reviews can change the revision during traversal.

## Endpoint and authentication

The default collection URL is:

```text
https://la.99818888.xyz/mux/api/callback-messages
```

| Method | Path relative to `/mux` | Purpose |
| --- | --- | --- |
| `POST` | `/api/callback-messages` | Store a callback; HTTP 201 for new, 200 for duplicate |
| `GET` | `/api/callback-messages?status=pending&limit=100&after=CURSOR` | Read persistent messages (`status`: `pending`, `reviewed`, `all`; omit `after` initially) |
| `POST` | `/api/callback-messages/{id}/review` | Mark a message reviewed while preserving history |

The JSON POST body is:

```json
{
  "message": "Requested completion message",
  "sessionName": "example-session",
  "agentType": "codex",
  "cwd": "/work/project",
  "requestId": "3d593fea-9e4b-44ac-9c51-2bf031896274",
  "tmuxSessionId": "$0",
  "tmuxPaneId": "%0",
  "host": "actual-hostname"
}
```

These values are examples, not defaults. `tmuxSessionId`, `tmuxPaneId`, and `host` are optional metadata; the helper discovers the relevant values. The server records receipt time. The request UUID makes repeated delivery idempotent.

Requests authenticate with `Authorization: Bearer …`. The helper loads a **callback-only** token from `~/.config/muxdeck/callback-token`, whose permissions must be `600`. The owner provisions this private file separately; the token is never embedded in this guide or the helper. `MUXDECK_CALLBACK_TOKEN_FILE` or `--token-file /private/path` can select another private file. This credential cannot operate terminals or access other Muxdeck APIs. The helper refuses redirects to keep it from reaching another origin.

## Maintainer installation

The maintained source files are `scripts/muxdeck_callback.py` and `docs/AGENT_CALLBACKS.md` in `/root/tmux-web-console`. The local copies used by agents are `~/s/g/cb.py` and `~/s/g/cb.md`. After changing these source files, refresh the installed copies:

```bash
install -d -m 700 ~/s/g
install -m 700 /root/tmux-web-console/scripts/muxdeck_callback.py ~/s/g/cb.py
install -m 600 /root/tmux-web-console/docs/AGENT_CALLBACKS.md ~/s/g/cb.md
```

The helper requires Python 3.10+ and a Linux `/proc` filesystem for automatic tmux ancestry checks. It has no third-party dependencies. Server token provisioning and service configuration are documented in the deployment guide.
