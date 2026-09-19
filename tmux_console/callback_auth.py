"""A private bearer credential limited to callback APIs."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
from pathlib import Path

from .auth import AuthConfigurationError

_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")


def callback_token_allows(path: str, prefix: str, method: str) -> bool:
    messages = f"{prefix}/api/callback-messages"
    if path == messages:
        return method in {"GET", "HEAD", "POST"}
    if path == f"{prefix}/api/callback-sessions":
        return method in {"GET", "HEAD"}
    return method == "POST" and re.fullmatch(
        re.escape(messages) + r"/[A-Za-z0-9_-]{1,128}/review", path
    ) is not None


class CallbackTokenVerifier:
    def __init__(self, path: Path) -> None:
        self.path = path.expanduser()
        self._read_digest()  # Refuse startup with an unsafe configured credential.

    def _read_digest(self) -> bytes:
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_uid != os.geteuid()
                    or stat.S_IMODE(metadata.st_mode) & 0o077
                    or metadata.st_size > 130
                ):
                    raise ValueError("unsafe token file")
                token = stream.read(256).strip().decode("ascii")
                if not _TOKEN.fullmatch(token):
                    raise ValueError("invalid token")
                return hashlib.sha256(token.encode("ascii")).digest()
        except (OSError, UnicodeError, ValueError) as error:
            raise AuthConfigurationError(
                "callback token file must be a private regular file owned by the "
                "service user and contain a 32-128 character URL-safe token"
            ) from error

    def verify(self, authorization: str) -> bool:
        scheme, separator, token = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not separator or not _TOKEN.fullmatch(token):
            return False
        try:
            expected = self._read_digest()  # Rotation/removal takes effect immediately.
        except AuthConfigurationError:
            return False
        return hmac.compare_digest(expected, hashlib.sha256(token.encode("ascii")).digest())
