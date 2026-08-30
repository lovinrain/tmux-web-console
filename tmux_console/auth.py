from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import getpass
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import stat
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("muxdeck.auth")

AUTH_VERSION = 1
PASSWORD_ALGORITHM = "scrypt"
SCRYPT_N = 1 << 15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024
MAX_AUTH_FILE_BYTES = 1024 * 1024
MAX_DEVICES = 64
DEVICE_TOUCH_INTERVAL_SECONDS = 24 * 60 * 60

_DEVICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{12,64}$")
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
_TOKEN_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class AuthConfigurationError(RuntimeError):
    """Raised when configured authentication state cannot be used safely."""


class AuthPersistenceError(RuntimeError):
    """Raised when an authentication mutation cannot be saved durably."""


class AuthMode(StrEnum):
    SERVER = "server"
    BASIC = "basic"
    NONE = "none"


def resolve_auth_mode(
    configured: str | AuthMode | None,
    *,
    credentials_configured: bool,
) -> AuthMode:
    """Resolve launch configuration while preserving the legacy file-based default."""
    if configured is None:
        return AuthMode.SERVER if credentials_configured else AuthMode.NONE
    try:
        mode = AuthMode(configured)
    except ValueError as error:
        raise AuthConfigurationError(
            "MUXDECK_AUTH_MODE must be one of: server, basic, none"
        ) from error
    if mode is not AuthMode.NONE and not credentials_configured:
        raise AuthConfigurationError(
            f"MUXDECK_AUTH_MODE={mode.value} requires MUXDECK_AUTH_FILE"
        )
    return mode


def parse_basic_authorization(value: object) -> tuple[str, str] | None:
    if not isinstance(value, str):
        return None
    scheme, separator, encoded = value.partition(" ")
    if separator != " " or scheme.casefold() != "basic" or not encoded:
        return None
    if any(character.isspace() for character in encoded):
        return None
    try:
        decoded = base64.b64decode(encoded, validate=True)
        if base64.b64encode(decoded).decode("ascii") != encoded:
            return None
        credentials = decoded.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    username, colon, password = credentials.partition(":")
    return (username, password) if colon else None


class BasicAuthVerifier:
    """Verify Basic credentials while caching only the one accepted header hash."""

    def __init__(self, store: AuthStore) -> None:
        if ":" in store.username:
            raise AuthConfigurationError(
                "the configured username cannot contain ':' in basic auth mode"
            )
        self._store = store
        self._accepted_digest: bytes | None = None
        self._lock = threading.Lock()

    def verify(self, authorization: object) -> bool:
        parsed = parse_basic_authorization(authorization)
        if parsed is None or not isinstance(authorization, str):
            return False
        try:
            encoded = authorization.partition(" ")[2].encode("ascii")
        except UnicodeEncodeError:
            return False
        digest = hashlib.sha256(encoded).digest()
        with self._lock:
            if self._accepted_digest is not None and hmac.compare_digest(
                digest, self._accepted_digest
            ):
                return True
            if not self._store.verify_credentials(*parsed):
                return False
            self._accepted_digest = digest
            return True


@dataclass(frozen=True)
class RememberedDevice:
    id: str
    token_hash: str
    label: str
    created_at: int
    last_seen_at: int

    def public_dict(self, *, current: bool = False) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "createdAt": self.created_at,
            "lastSeenAt": self.last_seen_at,
            "current": current,
        }


def default_auth_path() -> Path | None:
    configured = os.environ.get("MUXDECK_AUTH_FILE")
    return Path(configured).expanduser() if configured else None


def validate_username(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("username must be a string")
    if value != value.strip() or not 1 <= len(value) <= 64:
        raise ValueError("username must be between 1 and 64 characters")
    if any(ord(character) < 0x21 or ord(character) == 0x7F for character in value):
        raise ValueError("username cannot contain whitespace or control characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("username must be valid UTF-8") from error
    return value


def _password_bytes(value: object, *, provisioning: bool = False) -> bytes:
    if not isinstance(value, str):
        raise TypeError("password must be a string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("password must be valid UTF-8") from error
    if provisioning and len(encoded) < 12:
        raise ValueError("password must contain at least 12 UTF-8 bytes")
    if not encoded or len(encoded) > 1024:
        raise ValueError("password must contain between 1 and 1024 UTF-8 bytes")
    return encoded


def _derive_password(password: bytes, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password,
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
        maxmem=SCRYPT_MAXMEM,
    )


def _encode_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_bytes(value: object, *, field: str, expected_length: int) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a base64url string")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as error:
        raise ValueError(f"{field} must be valid base64url") from error
    if len(decoded) != expected_length:
        raise ValueError(f"{field} has an unexpected length")
    return decoded


def _validate_label(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("device label must be a string")
    normalized = " ".join(value.split())[:80]
    return normalized or "Browser"


def _validate_timestamp(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _serialize_device(device: RememberedDevice) -> dict[str, Any]:
    return {
        "tokenHash": device.token_hash,
        "label": device.label,
        "createdAt": device.created_at,
        "lastSeenAt": device.last_seen_at,
    }


def _parse_devices(value: object) -> dict[str, RememberedDevice]:
    if not isinstance(value, dict):
        raise TypeError("devices must be an object")
    if len(value) > MAX_DEVICES:
        raise ValueError(f"devices cannot contain more than {MAX_DEVICES} entries")

    devices: dict[str, RememberedDevice] = {}
    for device_id, raw_device in value.items():
        if not isinstance(device_id, str) or not _DEVICE_ID_PATTERN.fullmatch(
            device_id
        ):
            raise ValueError("device id is invalid")
        if not isinstance(raw_device, dict):
            raise TypeError(f"device {device_id} must be an object")
        if set(raw_device) != {"tokenHash", "label", "createdAt", "lastSeenAt"}:
            raise ValueError(f"device {device_id} has an invalid schema")
        token_hash = raw_device["tokenHash"]
        if not isinstance(token_hash, str) or not _TOKEN_HASH_PATTERN.fullmatch(
            token_hash
        ):
            raise ValueError(f"device {device_id} token hash is invalid")
        created_at = _validate_timestamp(
            raw_device["createdAt"], f"device {device_id} createdAt"
        )
        last_seen_at = _validate_timestamp(
            raw_device["lastSeenAt"], f"device {device_id} lastSeenAt"
        )
        if last_seen_at < created_at:
            raise ValueError(f"device {device_id} lastSeenAt predates createdAt")
        devices[device_id] = RememberedDevice(
            id=device_id,
            token_hash=token_hash,
            label=_validate_label(raw_device["label"]),
            created_at=created_at,
            last_seen_at=last_seen_at,
        )
    return devices


def _sync_directory(path: Path) -> None:
    directory_fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _write_auth_payload(
    path: Path, payload: dict[str, Any], *, replace_file: bool
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())

        if replace_file:
            os.replace(temporary, path)
            temporary = None
        else:
            os.link(temporary, path)
        _sync_directory(path.parent)
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)


def provision_auth_file(path: Path, username: str, password: str) -> None:
    validated_username = validate_username(username)
    password_bytes = _password_bytes(password, provisioning=True)
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"authentication file already exists: {path}")

    salt = secrets.token_bytes(16)
    digest = _derive_password(password_bytes, salt)
    payload = {
        "version": AUTH_VERSION,
        "username": validated_username,
        "password": {
            "algorithm": PASSWORD_ALGORITHM,
            "salt": _encode_bytes(salt),
            "digest": _encode_bytes(digest),
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
        },
        "devices": {},
    }
    _write_auth_payload(path, payload, replace_file=False)


class AuthStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        (
            self._username,
            self._salt,
            self._password_digest,
            self._devices,
        ) = self._load()

    @property
    def username(self) -> str:
        return self._username

    def verify_credentials(self, username: object, password: object) -> bool:
        try:
            candidate_password = _password_bytes(password)
        except (TypeError, ValueError):
            return False
        candidate_digest = _derive_password(candidate_password, self._salt)
        username_matches = isinstance(username, str) and hmac.compare_digest(
            username.encode("utf-8", errors="surrogatepass"),
            self._username.encode("utf-8"),
        )
        return username_matches and hmac.compare_digest(
            candidate_digest, self._password_digest
        )

    def issue_device(
        self, label: str, *, now: int | None = None
    ) -> tuple[RememberedDevice, str]:
        observed_at = int(time.time()) if now is None else now
        validated_label = _validate_label(label)
        with self._lock:
            devices = dict(self._devices)
            if len(devices) >= MAX_DEVICES:
                oldest = min(
                    devices.values(),
                    key=lambda device: (
                        device.last_seen_at,
                        device.created_at,
                        device.id,
                    ),
                )
                devices.pop(oldest.id)

            while True:
                device_id = secrets.token_urlsafe(12)
                if device_id not in devices:
                    break
            token = secrets.token_urlsafe(32)
            device = RememberedDevice(
                id=device_id,
                token_hash=hashlib.sha256(token.encode("ascii")).hexdigest(),
                label=validated_label,
                created_at=observed_at,
                last_seen_at=observed_at,
            )
            devices[device_id] = device
            self._persist(devices)
            self._devices = devices
            return device, f"{device_id}.{token}"

    def authenticate_cookie(
        self, value: str | None, *, now: int | None = None
    ) -> RememberedDevice | None:
        if not isinstance(value, str) or value.count(".") != 1:
            return None
        device_id, token = value.split(".", 1)
        if not _DEVICE_ID_PATTERN.fullmatch(device_id) or not _TOKEN_PATTERN.fullmatch(
            token
        ):
            return None
        observed_at = int(time.time()) if now is None else now
        with self._lock:
            device = self._devices.get(device_id)
            if device is None or not hmac.compare_digest(
                hashlib.sha256(token.encode("ascii")).hexdigest(), device.token_hash
            ):
                return None
            if observed_at - device.last_seen_at < DEVICE_TOUCH_INTERVAL_SECONDS:
                return device

            touched = replace(device, last_seen_at=max(observed_at, device.created_at))
            devices = {**self._devices, device_id: touched}
            try:
                self._persist(devices)
            except AuthPersistenceError as error:
                LOGGER.warning("Unable to update remembered-device activity: %s", error)
                return device
            self._devices = devices
            return touched

    def list_devices(self) -> list[RememberedDevice]:
        with self._lock:
            return sorted(
                self._devices.values(),
                key=lambda device: (device.last_seen_at, device.created_at),
                reverse=True,
            )

    def revoke_device(self, device_id: str) -> bool:
        with self._lock:
            if device_id not in self._devices:
                return False
            devices = dict(self._devices)
            devices.pop(device_id)
            self._persist(devices)
            self._devices = devices
            return True

    def _load(self) -> tuple[str, bytes, bytes, dict[str, RememberedDevice]]:
        try:
            file_stat = self.path.lstat()
            if not stat.S_ISREG(file_stat.st_mode) or self.path.is_symlink():
                raise ValueError(
                    "authentication path must be a regular non-symlink file"
                )
            if file_stat.st_uid != os.geteuid():
                raise ValueError(
                    "authentication file must be owned by the service user"
                )
            if stat.S_IMODE(file_stat.st_mode) & 0o077:
                raise ValueError(
                    "authentication file permissions must be 0600 or stricter"
                )
            if file_stat.st_nlink != 1:
                raise ValueError("authentication file cannot have multiple hard links")
            if file_stat.st_size > MAX_AUTH_FILE_BYTES:
                raise ValueError("authentication file is too large")
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or set(payload) != {
                "version",
                "username",
                "password",
                "devices",
            }:
                raise ValueError("authentication document has an invalid schema")
            if payload["version"] != AUTH_VERSION or isinstance(
                payload["version"], bool
            ):
                raise ValueError("unsupported authentication document version")
            username = validate_username(payload["username"])
            password = payload["password"]
            if not isinstance(password, dict) or set(password) != {
                "algorithm",
                "salt",
                "digest",
                "n",
                "r",
                "p",
            }:
                raise ValueError("password record has an invalid schema")
            if (
                password["algorithm"] != PASSWORD_ALGORITHM
                or password["n"] != SCRYPT_N
                or password["r"] != SCRYPT_R
                or password["p"] != SCRYPT_P
            ):
                raise ValueError("password record uses unsupported parameters")
            salt = _decode_bytes(
                password["salt"], field="password salt", expected_length=16
            )
            digest = _decode_bytes(
                password["digest"],
                field="password digest",
                expected_length=SCRYPT_DKLEN,
            )
            devices = _parse_devices(payload["devices"])
        except (
            FileNotFoundError,
            OSError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            raise AuthConfigurationError(
                "configured authentication state is unavailable; inspect its path, "
                "ownership, permissions, and schema"
            ) from error
        return username, salt, digest, devices

    def _payload(self, devices: dict[str, RememberedDevice]) -> dict[str, Any]:
        return {
            "version": AUTH_VERSION,
            "username": self._username,
            "password": {
                "algorithm": PASSWORD_ALGORITHM,
                "salt": _encode_bytes(self._salt),
                "digest": _encode_bytes(self._password_digest),
                "n": SCRYPT_N,
                "r": SCRYPT_R,
                "p": SCRYPT_P,
            },
            "devices": {
                device_id: _serialize_device(device)
                for device_id, device in sorted(devices.items())
            },
        }

    def _persist(self, devices: dict[str, RememberedDevice]) -> None:
        try:
            _write_auth_payload(self.path, self._payload(devices), replace_file=True)
        except OSError as error:
            raise AuthPersistenceError(
                "unable to persist authentication state"
            ) from error


def _provision_command(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser()
    password = getpass.getpass("Password: ")
    confirmation = getpass.getpass("Confirm password: ")
    if not hmac.compare_digest(password, confirmation):
        raise SystemExit("passwords do not match")
    try:
        provision_auth_file(path, args.username, password)
    except (FileExistsError, OSError, TypeError, ValueError) as error:
        raise SystemExit(str(error)) from error
    print(f"Provisioned authentication state at {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Muxdeck authentication state")
    subparsers = parser.add_subparsers(required=True)
    provision = subparsers.add_parser(
        "provision", description="Create a new password and remembered-device store"
    )
    provision.add_argument("--path", required=True)
    provision.add_argument("--username", required=True)
    provision.set_defaults(handler=_provision_command)
    args = parser.parse_args()
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
