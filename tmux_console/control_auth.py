"""Private bearer credentials for trusted tmux and workspace automation.

A control credential can execute commands as the service user through tmux. It
must never be shared with an agent that only needs to report callback messages.
"""

from __future__ import annotations

import argparse
import contextlib
import hmac
import os
import re
import secrets
import tempfile
from pathlib import Path
from urllib.parse import unquote

from .auth import AuthConfigurationError
from .callback_auth import CallbackTokenVerifier
from .tmux import validate_tmux_session_name

_READ = frozenset({"GET", "HEAD"})
_ID = r"[A-Za-z0-9_-]{1,128}"
_SMALL_ID = r"[A-Za-z0-9_-]{1,64}"
_SESSION = r"(?P<session>[^/\\?#\x00-\x1f\x7f]{1,3072})"
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")

# Raw, escaped path components keep a slash in a session name from becoming a
# route delimiter. Every resource and method is explicit: file operations,
# account endpoints, HTML previews, and terminal websockets remain out of scope.
_EXACT_ROUTES: dict[str, frozenset[str]] = {
    "/api/health": _READ,
    "/api/capabilities": _READ,
    "/api/work-links/config": _READ | {"PATCH"},
    "/api/work-links/context": _READ,
    "/api/sessions": _READ | {"POST"},
    "/api/sessions/stream": _READ,
    "/api/session-history": _READ,
    "/api/worker-terminal": _READ,
    "/api/session-name": frozenset({"PUT"}),
    "/api/session-title": frozenset({"PUT"}),
    "/api/session-star": frozenset({"PUT"}),
    "/api/session-ignored": frozenset({"PUT"}),
    "/api/session-tags": frozenset({"PUT"}),
    "/api/session-details": frozenset({"PUT"}),
    "/api/session-workspace-pin": frozenset({"PUT"}),
    "/api/session-workspace-transfer": frozenset({"POST"}),
    "/api/session-workspace-transfer/bulk": frozenset({"POST"}),
    "/api/workspaces": _READ | {"POST"},
    "/api/callback-sessions": _READ | {"POST", "PUT", "DELETE"},
    "/api/callback-sessions/review": frozenset({"POST"}),
    "/api/callback-sessions/hold": frozenset({"PUT"}),
    "/api/callback-sessions/stream": _READ,
    "/api/callback-messages": _READ | {"POST"},
}

_PATTERN_ROUTES: tuple[tuple[re.Pattern[str], frozenset[str]], ...] = tuple(
    (re.compile(pattern), frozenset(methods))
    for pattern, methods in (
        (rf"/api/sessions/{_SESSION}", {"DELETE"}),
        (rf"/api/sessions/{_SESSION}/copy", {"POST"}),
        (rf"/api/sessions/{_SESSION}/input", {"POST"}),
        (rf"/api/sessions/{_SESSION}/capture", _READ),
        (rf"/api/sessions/{_SESSION}/work-links", _READ | {"POST"}),
        (rf"/api/session-history/{_ID}/work-links", _READ),
        (rf"/api/work-links/{_ID}", _READ | {"PATCH", "DELETE"}),
        (rf"/api/work-links/{_ID}/status", {"PUT"}),
        (rf"/api/sessions/{_SESSION}/submitted-messages", _READ),
        (rf"/api/sessions/{_SESSION}/messages", _READ | {"POST"}),
        (rf"/api/sessions/{_SESSION}/messages/{_ID}", {"PATCH", "DELETE"}),
        (rf"/api/callback-messages/{_ID}/review", {"POST"}),
        (rf"/api/session-history/{_ID}/(?:saved-scrollback|agent-transcript|submitted-messages)", _READ),
        (r"/api/panes/%25[0-9]+/(?:saved-scrollback|agent-transcript)", _READ),
        (rf"/api/workspaces/{_ID}", _READ | {"PATCH", "DELETE"}),
        (rf"/api/workspaces/{_ID}/sessions", _READ | {"POST", "PUT", "DELETE"}),
        (rf"/api/workspaces/{_ID}/callback-sessions", _READ | {"POST", "DELETE"}),
        (rf"/api/workspaces/{_ID}/groups", _READ | {"POST"}),
        (rf"/api/workspaces/{_ID}/groups/{_SMALL_ID}", _READ | {"PATCH", "DELETE"}),
        (rf"/api/workspaces/{_ID}/pane-layouts", _READ | {"POST"}),
        (rf"/api/workspaces/{_ID}/pane-layouts/{_SMALL_ID}", _READ | {"PATCH", "DELETE"}),
        (rf"/api/workspaces/{_ID}/separators", _READ | {"POST", "DELETE"}),
        (rf"/api/workspaces/{_ID}/stream", _READ),
        (rf"/api/workspaces/{_ID}/activity", {"POST"}),
    )
)


def control_token_allows(path: str, prefix: str, method: str) -> bool:
    """Check an escaped URL path, without its query, against the control scope.

    In aiohttp callers must use ``request.rel_url.raw_path``. Unquoting the whole
    path before checking loses the distinction between a slash in a session
    name and a slash that selects a different HTTP resource.
    """
    if not path.startswith(f"{prefix}/api/"):
        return False
    relative = path[len(prefix):]
    exact = _EXACT_ROUTES.get(relative)
    if exact is not None:
        return method in exact
    for pattern, methods in _PATTERN_ROUTES:
        if method not in methods:
            continue
        match = pattern.fullmatch(relative)
        if match is None:
            continue
        if "session" in match.groupdict():
            raw_name = match.group("session")
            if _BAD_ESCAPE.search(raw_name):
                return False
            try:
                validate_tmux_session_name(unquote(raw_name, errors="strict"))
            except (UnicodeError, ValueError):
                return False
        return True
    return False


class ControlTokenVerifier(CallbackTokenVerifier):
    """Reread a private credential on every verification, including revocation.

    The callback verifier's secure file reader is shared here; its route scope
    is independent and unchanged. Only a digest is retained while verifying.
    """

    def _read_digest(self) -> bytes:
        try:
            return super()._read_digest()
        except AuthConfigurationError as error:
            raise AuthConfigurationError(
                "control token file must be a private regular file owned by the "
                "service user and contain a 32-128 character URL-safe token"
            ) from error


def control_token_conflicts_with_callback(
    control: ControlTokenVerifier, callback: CallbackTokenVerifier
) -> bool:
    """Detect accidental reuse of a callback credential for command execution."""
    return hmac.compare_digest(control._read_digest(), callback._read_digest())


def provision_control_token_file(path: Path) -> None:
    """Atomically create a new private token file, refusing any existing entry."""
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="ascii", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            handle.write(secrets.token_urlsafe(48) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        # A hard link publishes only the complete private file. Unlike replace,
        # it refuses regular files, directories, and even dangling symlinks.
        os.link(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Muxdeck automation credentials")
    subparsers = parser.add_subparsers(required=True)
    provision = subparsers.add_parser("provision", help="Create a new private control token file")
    provision.add_argument("--path", required=True)
    args = parser.parse_args()
    path = Path(args.path).expanduser()
    try:
        provision_control_token_file(path)
    except OSError as error:
        parser.exit(1, f"Could not provision control credential: {error}\n")
    print(f"Provisioned control credential at {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
