from __future__ import annotations

import hashlib
import os
import re
import secrets
import shlex
import threading
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_IMAGE_UPLOAD_STORAGE_BYTES = 512 * 1024 * 1024
MAX_IMAGE_UPLOAD_NAME_LENGTH = 255


class ImageUploadStorageFullError(OSError):
    pass


def default_uploads_path() -> Path:
    configured = os.environ.get("MUXDECK_UPLOADS_DIR")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "uploads"


def _normalized_original_name(value: str) -> str:
    name = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name:
        raise ValueError("image filename is required")
    if len(name) > MAX_IMAGE_UPLOAD_NAME_LENGTH:
        raise ValueError(
            f"image filename must be {MAX_IMAGE_UPLOAD_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError("image filename cannot contain control characters")
    return name


def _safe_slug(value: str, fallback: str, limit: int) -> str:
    ascii_value = (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", ascii_value).strip("-_")
    return (slug or fallback)[:limit]


def _detect_image_type(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    raise ValueError("image must be PNG, JPEG, GIF, or WebP")


@dataclass(frozen=True)
class UploadedImage:
    original_name: str
    path: Path
    content_type: str
    size: int

    def to_dict(self) -> dict[str, Any]:
        path = str(self.path)
        return {
            "name": self.original_name,
            "path": path,
            "terminalText": shlex.quote(path),
            "contentType": self.content_type,
            "size": self.size,
        }


class ImageUploadStore:
    def __init__(
        self,
        path: Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
        token_factory: Callable[[], str] | None = None,
        max_total_bytes: int = MAX_IMAGE_UPLOAD_STORAGE_BYTES,
    ) -> None:
        self.path = (path or default_uploads_path()).resolve()
        self._clock = clock
        self._token_factory = token_factory or (lambda: secrets.token_hex(8))
        self._max_total_bytes = max_total_bytes
        self._lock = threading.Lock()

    def save(self, session_name: str, original_name: str, data: bytes) -> UploadedImage:
        original_name = _normalized_original_name(original_name)
        if not data:
            raise ValueError("image file cannot be empty")
        if len(data) > MAX_IMAGE_UPLOAD_BYTES:
            raise ValueError(
                f"image must be {MAX_IMAGE_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller"
            )
        content_type, extension = _detect_image_type(data)

        session_hash = hashlib.sha256(session_name.encode("utf-8")).hexdigest()[:10]
        session_slug = _safe_slug(session_name, "session", 48)
        image_stem = _safe_slug(Path(original_name).stem, "image", 64)
        timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(self._clock()))

        with self._lock:
            self._prepare_directory(self.path)
            if self._stored_bytes() + len(data) > self._max_total_bytes:
                raise ImageUploadStorageFullError(
                    "image upload storage is full; remove old files from the uploads directory"
                )

            session_directory = self.path / f"{session_slug}-{session_hash}"
            self._prepare_directory(session_directory)
            destination: Path | None = None
            descriptor: int | None = None
            for _ in range(10):
                token = _safe_slug(self._token_factory(), "upload", 32)
                candidate = session_directory / (
                    f"{timestamp}-{token}-{image_stem}{extension}"
                )
                try:
                    descriptor = os.open(
                        candidate,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                    )
                except FileExistsError:
                    continue
                destination = candidate
                break
            if destination is None or descriptor is None:
                raise OSError("unable to allocate a unique image upload path")

            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(destination, 0o600)
            except BaseException:
                destination.unlink(missing_ok=True)
                raise

        return UploadedImage(
            original_name=original_name,
            path=destination,
            content_type=content_type,
            size=len(data),
        )

    @staticmethod
    def _prepare_directory(path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.is_dir():
            raise OSError(f"image upload path is not a directory: {path}")
        os.chmod(path, 0o700)

    def _stored_bytes(self) -> int:
        total = 0
        for child in self.path.rglob("*"):
            try:
                if child.is_file():
                    total += child.stat().st_size
            except FileNotFoundError:
                continue
        return total
