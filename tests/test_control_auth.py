from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import pytest

from tmux_console.auth import AuthConfigurationError
from tmux_console.callback_auth import CallbackTokenVerifier, callback_token_allows
from tmux_console.control_auth import (
    ControlTokenVerifier,
    control_token_allows,
    control_token_conflicts_with_callback,
    provision_control_token_file,
)

TOKEN = "control-test-token-" + "a" * 32


def token_file(tmp_path: Path, name: str = "control-token", token: str = TOKEN) -> Path:
    path = tmp_path / name
    path.write_text(token + "\n", encoding="ascii")
    path.chmod(0o600)
    return path


def test_control_token_rotation_and_revocation_are_immediate(tmp_path: Path) -> None:
    path = token_file(tmp_path)
    verifier = ControlTokenVerifier(path)
    assert verifier.verify(f"Bearer {TOKEN}")
    replacement = "b" * 64
    incoming = token_file(tmp_path, "replacement", replacement)
    incoming.replace(path)
    assert not verifier.verify(f"Bearer {TOKEN}")
    assert verifier.verify(f"bearer {replacement}")
    path.chmod(0o644)
    assert not verifier.verify(f"Bearer {replacement}")
    with pytest.raises(AuthConfigurationError, match="control token file"):
        ControlTokenVerifier(path)
    path.chmod(0o600)
    assert verifier.verify(f"Bearer {replacement}")
    path.unlink()
    assert not verifier.verify(f"Bearer {replacement}")


@pytest.mark.parametrize("authorization", (
    "", f"Basic {TOKEN}", f"Bearer  {TOKEN}", f"Bearer {TOKEN} ",
    f"Bearer {TOKEN}\n", "Bearer " + "x" * 131, "Bearer ☃" * 32,
))
def test_malformed_authorization_is_rejected(tmp_path: Path, authorization: str) -> None:
    assert not ControlTokenVerifier(token_file(tmp_path)).verify(authorization)


def test_symlinks_nonregular_files_and_changed_ownership_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = token_file(tmp_path)
    linked = tmp_path / "linked"
    linked.symlink_to(path)
    with pytest.raises(AuthConfigurationError):
        ControlTokenVerifier(linked)
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo, 0o600)
    for unsafe in (fifo, tmp_path, tmp_path / "missing"):
        with pytest.raises(AuthConfigurationError):
            ControlTokenVerifier(unsafe)
    verifier = ControlTokenVerifier(path)
    original_uid = os.geteuid()
    monkeypatch.setattr(os, "geteuid", lambda: original_uid + 1)
    with pytest.raises(AuthConfigurationError):
        ControlTokenVerifier(path)
    assert not verifier.verify(f"Bearer {TOKEN}")


@pytest.mark.parametrize("contents", (
    b"short", b"a" * 131, TOKEN.encode() + b"\n" + b" " * 200,
    b"a" * 32 + b"\n" + b"b" * 32, "☃".encode() * 40,
))
def test_malformed_token_files_fail_closed(tmp_path: Path, contents: bytes) -> None:
    path = token_file(tmp_path)
    verifier = ControlTokenVerifier(path)
    path.write_bytes(contents)
    with pytest.raises(AuthConfigurationError):
        ControlTokenVerifier(path)
    assert not verifier.verify(f"Bearer {TOKEN}")


@pytest.mark.parametrize("mode", (0o604, 0o620, 0o640, 0o660, 0o777))
def test_any_group_or_other_permission_is_rejected(tmp_path: Path, mode: int) -> None:
    path = token_file(tmp_path)
    path.chmod(mode)
    with pytest.raises(AuthConfigurationError):
        ControlTokenVerifier(path)


def test_control_and_callback_secret_collision_detection_rereads_files(tmp_path: Path) -> None:
    control_path = token_file(tmp_path)
    callback_path = token_file(tmp_path, "callback", "c" * 64)
    control = ControlTokenVerifier(control_path)
    callback = CallbackTokenVerifier(callback_path)
    assert not control_token_conflicts_with_callback(control, callback)
    callback_path.write_text(TOKEN)
    assert control_token_conflicts_with_callback(control, callback)
    callback_path.unlink()
    with pytest.raises(AuthConfigurationError):
        control_token_conflicts_with_callback(control, callback)
    # The callback scope remains narrow even when the underlying token matches.
    assert not callback_token_allows("/api/sessions", "", "POST")
    assert callback_token_allows("/api/callback-messages", "", "POST")


_ALLOWED_ROUTES = (
    ("/api/health", ("GET", "HEAD")),
    ("/api/capabilities", ("GET", "HEAD")),
    ("/api/sessions", ("GET", "HEAD", "POST")),
    ("/api/sessions/stream", ("GET", "HEAD")),
    ("/api/session-history", ("GET", "HEAD")),
    ("/api/sessions/agent", ("DELETE",)),
    ("/api/sessions/agent/copy", ("POST",)),
    ("/api/sessions/agent/input", ("POST",)),
    ("/api/sessions/agent/capture", ("GET", "HEAD")),
    ("/api/sessions/agent/submitted-messages", ("GET", "HEAD")),
    ("/api/sessions/agent/messages", ("GET", "HEAD", "POST")),
    ("/api/sessions/agent/messages/message-1", ("PATCH", "DELETE")),
    ("/api/session-name", ("PUT",)),
    ("/api/session-title", ("PUT",)),
    ("/api/session-star", ("PUT",)),
    ("/api/session-ignored", ("PUT",)),
    ("/api/session-tags", ("PUT",)),
    ("/api/session-details", ("PUT",)),
    ("/api/session-workspace-pin", ("PUT",)),
    ("/api/session-workspace-transfer", ("POST",)),
    ("/api/session-workspace-transfer/bulk", ("POST",)),
    ("/api/workspaces", ("GET", "HEAD", "POST")),
    ("/api/workspaces/project-1", ("GET", "HEAD", "PATCH", "DELETE")),
    ("/api/workspaces/project-1/sessions", ("GET", "HEAD", "POST", "PUT", "DELETE")),
    ("/api/workspaces/project-1/groups", ("GET", "HEAD", "POST")),
    ("/api/workspaces/project-1/groups/epic-1", ("GET", "HEAD", "PATCH", "DELETE")),
    ("/api/workspaces/project-1/pane-layouts", ("GET", "HEAD", "POST")),
    ("/api/workspaces/project-1/pane-layouts/layout-1", ("GET", "HEAD", "PATCH", "DELETE")),
    ("/api/workspaces/project-1/separators", ("GET", "HEAD", "POST", "DELETE")),
    ("/api/workspaces/project-1/activity", ("POST",)),
    ("/api/workspaces/project-1/stream", ("GET", "HEAD")),
    ("/api/workspaces/project-1/callback-sessions", ("GET", "HEAD", "POST", "DELETE")),
    ("/api/callback-sessions", ("GET", "HEAD", "POST", "PUT", "DELETE")),
    ("/api/callback-sessions/stream", ("GET", "HEAD")),
    ("/api/callback-sessions/review", ("POST",)),
    ("/api/callback-messages", ("GET", "HEAD", "POST")),
    ("/api/callback-messages/message-1/review", ("POST",)),
    ("/api/panes/%251/saved-scrollback", ("GET", "HEAD")),
    ("/api/panes/%251/agent-transcript", ("GET", "HEAD")),
    ("/api/session-history/archive-1/saved-scrollback", ("GET", "HEAD")),
    ("/api/session-history/archive-1/agent-transcript", ("GET", "HEAD")),
    ("/api/session-history/archive-1/submitted-messages", ("GET", "HEAD")),
)


@pytest.mark.parametrize("prefix", ("", "/mux", "/other"))
def test_control_scope_allows_only_each_resource_defined_methods(prefix: str) -> None:
    for path, methods in _ALLOWED_ROUTES:
        for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            assert control_token_allows(prefix + path, prefix, method) == (method in methods), (
                path, method
            )
    assert not control_token_allows(prefix + "/api/sessions", prefix, "get")
    assert not control_token_allows(prefix + "/api/sessions", prefix + "-other", "GET")


@pytest.mark.parametrize("prefix", ("", "/mux"))
def test_control_scope_excludes_unrelated_stores_auth_files_and_browser_routes(prefix: str) -> None:
    denied = (
        "/", "/login", "/logout", "/account", "/api/auth/login", "/api/auth/session",
        "/api/auth/logout", "/api/account/password", "/ws/terminal", "/api/host-metrics",
        "/api/snippets", "/api/shortcuts", "/api/workspace-quick-links", "/api/common-note",
        "/api/sessions/agent/note", "/api/sessions/agent/quick-links",
        "/api/workspaces/project-1/note", "/api/workspaces/project-1/quick-links",
        "/api/sessions/agent/files", "/api/sessions/agent/files/resolve",
        "/api/sessions/agent/files/search", "/api/sessions/agent/files/preview",
        "/api/sessions/agent/files/image", "/api/sessions/agent/files/svg",
        "/api/sessions/agent/files/pdf", "/api/sessions/agent/files/html",
        "/api/sessions/agent/files/download", "/api/sessions/agent/files/archive",
        "/api/sessions/agent/files/upload", "/api/sessions/agent/files/create",
        "/api/sessions/agent/files/move", "/api/sessions/agent/files/copy",
        "/api/sessions/agent/files/delete", "/api/sessions/agent/files/content",
        "/api/sessions/agent/attachments", "/api/sessions/agent/images",
        "/preview/" + "x" * 43 + "/index.html", "/api/history/snapshot-1",
        "/api/utility-terminal", "/api/utility-terminal/release",
        "/api/session-history/archive-1/restore", "/api/session-history/close-tab",
        "/api/recoverable-sessions/old/recreate", "/api/recoverable-sessions/old",
    )
    for path in denied:
        for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"):
            assert not control_token_allows(prefix + path, prefix, method), (path, method)


@pytest.mark.parametrize("path", (
    "/api/sessions/../input", "/api/sessions/%2e%2e/input",
    "/api/sessions/name%2Etxt/input", "/api/sessions/a%3Ab/input",
    "/api/sessions/name%5C/input", "/api/sessions/name%00/input",
    "/api/sessions/name%0A/input", "/api/sessions/name%FF/input",
    "/api/sessions/name%/input", "/api/sessions/name%ZZ/input",
    "/api/sessions/name/input/", "/api/sessions/name/input?extra=1",
    "/api/sessions/name/input#fragment", "/api/sessions/name/input\n",
    "/api/sessions/name/../input", "/api/sessions/name/files/copy",
    "/api/sessions/name/files/../input", "/api/workspaces/../sessions",
    "/api/workspaces/name%2Fsessions", "/api/workspaces/name%2E/groups",
    "/api/workspaces/name/groups/../sessions", "/api/panes/%251/files",
    "/api/panes/%2525x1/agent-transcript", "/api/callback-messages/../review",
    "/api/callback-messages/name/review/extra", "/api/sessions-extra",
))
def test_scope_rejects_traversal_encoding_errors_and_route_suffix_confusion(path: str) -> None:
    for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"):
        assert not control_token_allows(path, "", method), (path, method)


@pytest.mark.parametrize("name", (
    "agent", "task/child", "task/files", "literal%2Fname", "agent with spaces",
    "☃" * 256, "a" * 256,
))
def test_raw_session_components_keep_supported_tmux_names_distinct_from_resources(name: str) -> None:
    component = quote(name, safe="")
    assert control_token_allows(f"/api/sessions/{component}/input", "", "POST")
    assert control_token_allows(f"/api/sessions/{component}/capture", "", "GET")
    assert control_token_allows(f"/api/sessions/{component}/copy", "", "POST")
    assert control_token_allows(f"/api/sessions/{component}", "", "DELETE")
    assert not control_token_allows("/api/sessions/" + "a" * 257 + "/input", "", "POST")


def test_provision_creates_complete_private_unique_tokens_without_printing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    first = tmp_path / "credentials" / "first"
    second = first.with_name("second")
    previous_umask = os.umask(0)
    try:
        provision_control_token_file(first)
        provision_control_token_file(second)
    finally:
        os.umask(previous_umask)
    assert stat.S_IMODE(first.stat().st_mode) == 0o600
    assert stat.S_IMODE(first.parent.stat().st_mode) == 0o700
    token = first.read_text().strip()
    assert len(token) == 64
    assert token != second.read_text().strip()
    assert ControlTokenVerifier(first).verify(f"Bearer {token}")
    assert list(first.parent.glob(".*.tmp")) == []
    captured = capsys.readouterr()
    assert captured.out == captured.err == ""


@pytest.mark.parametrize("existing", ("regular", "symlink", "dangling", "directory"))
def test_provision_never_overwrites_any_existing_entry(tmp_path: Path, existing: str) -> None:
    path = tmp_path / "control"
    original = token_file(tmp_path, "original")
    if existing == "regular":
        path.write_text("existing contents")
    elif existing in {"symlink", "dangling"}:
        path.symlink_to(original if existing == "symlink" else tmp_path / "missing")
    else:
        path.mkdir()
    with pytest.raises(FileExistsError):
        provision_control_token_file(path)
    assert original.read_text() == TOKEN + "\n"
    if existing == "regular":
        assert path.read_text() == "existing contents"
    elif existing in {"symlink", "dangling"}:
        assert path.is_symlink()
    else:
        assert path.is_dir()
    assert list(tmp_path.glob(".*.tmp")) == []


def test_provision_cli_has_no_secret_output_and_refuses_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "control"
    command = [sys.executable, "-m", "tmux_console.control_auth", "provision", "--path", str(path)]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    token = path.read_text().strip()
    assert token not in result.stdout + result.stderr
    assert "Provisioned control credential" in result.stdout
    assert ControlTokenVerifier(path).verify(f"Bearer {token}")
    refused = subprocess.run(command, capture_output=True, text=True, check=False)
    assert refused.returncode == 1
    assert token not in refused.stdout + refused.stderr
    assert path.read_text().strip() == token
