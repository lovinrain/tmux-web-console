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

The authenticated desktop file browser can read, create, rename, move, duplicate,
edit, and delete files with the tmux owner's Unix privileges. It opens at the
live pane working directory but is no longer confined to it: a request may name
any absolute directory, and every operation is then confined to that directory.
Which directories may be named is what `MUXDECK_FILE_BROWSER_ROOT` controls.

**It defaults to `/`, so by default the browser reaches every file the tmux owner
can already read and write from the shell.** That matches the trust this feature
has always required - a console user can `cat` and `rm` the same files through
terminal input - but it is a wider reach than the pane directory this browser was
previously limited to. Two differences are worth stating plainly: the HTTP
endpoints return exact bytes where a terminal read is lossy, and they leave no
trace in the pane scrollback or shell history that a `cat` would.

Set `MUXDECK_FILE_BROWSER_ROOT` to an absolute directory to narrow the reach. A
value that is relative, missing, or not a directory fails startup rather than
silently widening or narrowing it. The boundary is enforced on the directory each
operation actually resolves, not once when a request is accepted, so it also
covers the pane's own working directory, which a console user chooses simply by
typing `cd`. A directory outside the boundary is refused with 403 whether it is
reached by typing a path, by stepping above the current one, or by moving the
pane; every such refusal returns the same message whatever is actually there, and
containment is decided from the fully resolved path before its existence is
checked, so the error cannot be used to map what exists outside.

Re-checking at resolution time also shrinks, but does not close, the window in
which a directory validated as inside the boundary is swapped for a symlink
pointing out of it: a download or preview still resolves a path that the response
opens fractionally later. Defeating a narrowed boundary that way needs a local
process renaming continuously and succeeds in roughly one read in a thousand. It
crosses no privilege boundary for an adversary who already has terminal access at
this trust level, but it does mean a narrowed boundary should be treated as a
guard-rail against mis-navigation rather than as a barrier against a local
attacker. With the default `/` there is nothing outside the boundary to reach.

Within whatever directory a request names, the confinement is unchanged: new
names may not contain path separators, paths that resolve outside that directory
are refused, and the live tmux session and pane identity check still runs on
every request. Reads are `GET`s, which the request-origin guard deliberately does
not cover, so every response carries `Cross-Origin-Resource-Policy: same-origin`
to keep another origin from embedding one and using load or error timing as an
oracle for what exists on the host. Uploads use mode `0600`, cap each body at 12 MiB, and refuse
existing names instead of overwriting them. New folders are created `0700` and
new empty files `0600`. Duplicating a file copies the source's own permission
bits rather than forcing `0600`, so a copy is never more permissive than the file
it came from; setuid, setgid, and sticky bits are always dropped, because the new
inode belongs to the server's user and re-creating those bits would hand a local
attacker an executable running as that user.

Renames, moves, deletes, and in-place edits act on the named entry itself and
resolve only its parent directory, so they never follow a final-component symlink
out of the root; deleting a symlink removes the link and leaves its target
untouched, and editing through a symlink is refused. Renames and moves refuse an
existing destination rather than replacing it; the check is an `lstat` guard
followed by `rename`, which leaves a small race window inside the caller's own
working tree. A moved symlink is described only when its target resolves back
inside the root, so renaming cannot report the size, type, or modification time
of a file outside the directory being browsed. Deleting a non-empty folder requires an
explicit second recursive confirmation and is refused above 20,000 entries;
recursive deletes walk the tree through the already-validated parent descriptor,
and a delete that fails part way through reports that it removed some entries
rather than presenting itself as a no-op. In-place edits are capped at
1 MiB, write through a temporary file and an atomic rename that preserves the
original mode, and accept an optional modification-time precondition that fails
closed with a conflict when the file changed on disk.

These operations modify and destroy content in the real host working tree,
persist independently of Muxdeck's private attachment store, and are not
recoverable through Muxdeck. Access to this feature should be treated with the
same trust as terminal input access.

Inline CWD image previews repeat the same live pane identity and root-containment
checks. They are capped at 25 MiB, detected from raster signatures rather than
filename extensions, served with `nosniff`, same-origin resource policy, and
private no-store caching, and restricted to PNG, JPEG, GIF, WebP, AVIF, BMP, and
ICO. SVG, HTML, PDF, and arbitrary binary content are not embedded; Download
remains available separately with attachment disposition.
