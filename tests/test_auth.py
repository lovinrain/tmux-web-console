from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from tmux_console.auth import (
    AuthConfigurationError,
    AuthMode,
    AuthStore,
    BasicAuthVerifier,
    parse_basic_authorization,
    provision_auth_file,
    resolve_auth_mode,
)

TEST_USERNAME = "console-user"
TEST_PASSWORD = "correct-horse-console"


def provision(path: Path) -> AuthStore:
    provision_auth_file(path, TEST_USERNAME, TEST_PASSWORD)
    return AuthStore(path)


def test_provision_stores_only_a_salted_password_hash(tmp_path: Path):
    path = tmp_path / "private" / "auth.json"

    store = provision(path)

    serialized = path.read_text(encoding="utf-8")
    payload = json.loads(serialized)
    assert TEST_PASSWORD not in serialized
    assert payload["username"] == TEST_USERNAME
    assert payload["password"]["algorithm"] == "scrypt"
    assert payload["password"]["digest"]
    assert payload["password"]["salt"]
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert store.verify_credentials(TEST_USERNAME, TEST_PASSWORD)
    assert not store.verify_credentials(TEST_USERNAME, "not-the-password")
    assert not store.verify_credentials("somebody-else", TEST_PASSWORD)


def test_remembered_device_token_is_hashed_persistent_and_revocable(tmp_path: Path):
    path = tmp_path / "auth.json"
    store = provision(path)

    device, cookie = store.issue_device("Chrome on Linux", now=100)
    token = cookie.split(".", 1)[1]

    serialized = path.read_text(encoding="utf-8")
    assert cookie not in serialized
    assert token not in serialized
    assert store.authenticate_cookie(cookie, now=101) == device
    assert AuthStore(path).authenticate_cookie(cookie, now=101) == device

    assert store.revoke_device(device.id)
    assert store.authenticate_cookie(cookie, now=102) is None
    assert AuthStore(path).authenticate_cookie(cookie, now=102) is None
    assert not store.revoke_device(device.id)


def test_server_side_device_has_no_absolute_expiration(tmp_path: Path):
    path = tmp_path / "auth.json"
    store = provision(path)
    device, cookie = store.issue_device("Firefox on macOS", now=50)

    remembered = store.authenticate_cookie(cookie, now=20 * 365 * 24 * 60 * 60)

    assert remembered is not None
    assert remembered.id == device.id
    assert remembered.last_seen_at == 20 * 365 * 24 * 60 * 60
    assert AuthStore(path).authenticate_cookie(cookie) is not None


@pytest.mark.parametrize(
    "setup",
    [
        lambda path: None,
        lambda path: path.write_text("not json", encoding="utf-8"),
        lambda path: path.write_text('{"version": 999}', encoding="utf-8"),
    ],
)
def test_missing_or_malformed_auth_state_fails_closed(tmp_path: Path, setup):
    path = tmp_path / "auth.json"
    setup(path)

    with pytest.raises(
        AuthConfigurationError, match="authentication state is unavailable"
    ):
        AuthStore(path)


def test_auth_state_with_public_permissions_is_rejected(tmp_path: Path):
    path = tmp_path / "auth.json"
    provision(path)
    path.chmod(0o644)

    with pytest.raises(
        AuthConfigurationError, match="authentication state is unavailable"
    ):
        AuthStore(path)


def test_provision_refuses_to_replace_existing_credentials(tmp_path: Path):
    path = tmp_path / "auth.json"
    provision(path)

    with pytest.raises(FileExistsError):
        provision_auth_file(path, "replacement", "another-safe-password")

    assert AuthStore(path).verify_credentials(TEST_USERNAME, TEST_PASSWORD)


@pytest.mark.parametrize(
    ("configured", "credentials_configured", "expected"),
    [
        (None, False, AuthMode.NONE),
        (None, True, AuthMode.SERVER),
        ("none", False, AuthMode.NONE),
        ("none", True, AuthMode.NONE),
        ("server", True, AuthMode.SERVER),
        ("basic", True, AuthMode.BASIC),
    ],
)
def test_auth_mode_resolution(
    configured: str | None,
    credentials_configured: bool,
    expected: AuthMode,
):
    assert (
        resolve_auth_mode(
            configured,
            credentials_configured=credentials_configured,
        )
        is expected
    )


@pytest.mark.parametrize("configured", ["", "SERVER", "form", "disabled", " basic"])
def test_auth_mode_rejects_unknown_values(configured: str):
    with pytest.raises(AuthConfigurationError, match="server, basic, none"):
        resolve_auth_mode(configured, credentials_configured=True)


@pytest.mark.parametrize("configured", ["server", "basic"])
def test_secure_auth_modes_require_credentials(configured: str):
    with pytest.raises(AuthConfigurationError, match="requires MUXDECK_AUTH_FILE"):
        resolve_auth_mode(configured, credentials_configured=False)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("Basic YWxpY2U6c2VjcmV0", ("alice", "secret")),
        ("basic YWxpY2U6c2VjcmV0", ("alice", "secret")),
        ("Basic YWxpY2U6c2VjcmV0OnR3bw==", ("alice", "secret:two")),
        (None, None),
        ("Bearer YWxpY2U6c2VjcmV0", None),
        ("Basic", None),
        ("Basic  YWxpY2U6c2VjcmV0", None),
        ("Basic !!!", None),
        ("Basic YWxpY2U=", None),
        ("Basic //46eA==", None),
    ],
)
def test_parse_basic_authorization(
    header: str | None,
    expected: tuple[str, str] | None,
):
    assert parse_basic_authorization(header) == expected


def test_basic_auth_verifier_accepts_only_configured_credentials(tmp_path: Path):
    verifier = BasicAuthVerifier(provision(tmp_path / "auth.json"))

    assert verifier.verify("Basic Y29uc29sZS11c2VyOmNvcnJlY3QtaG9yc2UtY29uc29sZQ==")
    assert verifier.verify("basic Y29uc29sZS11c2VyOmNvcnJlY3QtaG9yc2UtY29uc29sZQ==")
    assert not verifier.verify("Basic Y29uc29sZS11c2VyOndyb25n")


def test_basic_auth_rejects_a_username_with_a_colon(tmp_path: Path):
    path = tmp_path / "auth.json"
    provision_auth_file(path, "console:user", TEST_PASSWORD)

    with pytest.raises(AuthConfigurationError, match="cannot contain ':'"):
        BasicAuthVerifier(AuthStore(path))
