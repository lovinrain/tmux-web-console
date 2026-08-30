# Security Policy

## Supported version

Security fixes target the latest commit on the default branch. This project does
not currently maintain older release lines.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting from the repository's
**Security** tab. Do not open a public issue with exploit details, credentials,
terminal output, session names, saved workspace data, memoranda, or snippets.

If private reporting is unavailable, open a minimal issue asking a maintainer to
enable a private channel. Do not include vulnerability details in that issue.

## Deployment boundary

`MUXDECK_AUTH_MODE` selects the authentication boundary at process startup.
`server` uses Muxdeck's remembered-browser login, `basic` uses standard HTTP
Basic authentication, and `none` deliberately disables application
authentication. Both protected modes require `MUXDECK_AUTH_FILE` state created
by `python -m tmux_console.auth provision`; invalid modes and missing or unsafe
credential state fail startup closed. For backward compatibility only, an
omitted mode infers `server` when the file is configured and `none` otherwise.
Explicit `none` ignores the file. A reachable unauthenticated instance can read
terminal output and send input with the privileges of the Unix user that owns
the selected tmux server. Keep the service on loopback and configure
authentication, a private tunnel/network, or a separate authenticated access
layer before exposing it.

The authentication file stores a salted scrypt password hash and hashed random
device tokens, not the plaintext password or bearer tokens. Keep it outside the
source repository with mode `0600`; do not pass a password in command-line
arguments, commit it, place it in a systemd unit, or include it in a source
archive. A configured missing, malformed, symlinked, non-private, or wrong-owner
file makes startup fail closed instead of silently disabling authentication.
Remembered-device cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to
the configured base path, shared across tabs in one browser profile, and renewed
on authenticated responses. Account controls can revoke each browser token.

Basic mode validates the same username and salted password hash on requests but
does not issue or mutate remembered-device tokens. The browser controls Basic
credential retention, and the application cannot reliably force a logout;
closing the browser or clearing its saved site credentials is the dependable
way to forget them. Basic credentials are only transport-safe behind HTTPS, and
Basic-mode usernames cannot contain `:`.

Runtime state is not part of the source repository. Title metadata, session
names, memoranda, snippets, saved workspaces, authentication state, and uploaded
attachments can contain sensitive material; keep their configured files private
and do not attach them to reports.

The authenticated desktop CWD browser can download regular files and create new
files with the tmux owner's Unix privileges. Uploads are root-confined to the
live pane CWD, reject path separators and escaping symlinks, use mode `0600`, cap
each body at 12 MiB, and refuse existing names instead of overwriting them. They
still modify the real host working tree and persist independently of Muxdeck's
private attachment store, so access to this feature should be treated with the
same trust as terminal input access.
