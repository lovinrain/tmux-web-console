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

Muxdeck intentionally has no application-level authentication. A reachable
instance can read terminal output and send input with the privileges of the Unix
user that owns the selected tmux server. Keep the service on loopback and expose
it only through a private tunnel/network or an authenticated, access-controlled
reverse proxy.

Runtime state is not part of the source repository. Title metadata, session
names, memoranda, snippets, and saved workspaces can contain sensitive material;
keep their configured files private and do not attach them to reports.
