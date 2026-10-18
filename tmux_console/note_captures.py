"""Bounded, private note clips and images, independent of notebook replacement writes."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from .tmux import Session

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000
MAX_STORAGE_BYTES = 256 * 1024 * 1024
MAX_CAPTURE_TEXT = 200_000
MAX_CAPTURES = 10_000
MAX_TEXT_STORAGE_BYTES = 32 * 1024 * 1024
DEFAULT_RETENTION_DAYS = 7
IMAGE_ID = re.compile(r"[0-9a-f]{32}\Z")
LOGGER = logging.getLogger("muxdeck.note_captures")


class NoteCaptureNotFound(KeyError):
    pass


class NoteCaptureConflict(ValueError):
    pass


class NoteCaptureStorageFull(OSError):
    pass


class NoteCapturesUnavailable(OSError):
    pass


def normalize_image(data: bytes) -> bytes:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("note image must be nonempty and at most 8 MiB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("note images must be PNG, JPEG or WebP")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("note image exceeds 12 megapixels")
            image.load()
            output = io.BytesIO()
            image.convert("RGBA" if image.mode in {"RGBA", "LA"} or "transparency" in image.info else "RGB").save(output, format="PNG")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as error:
        raise ValueError("unable to read this note image") from error
    result = output.getvalue()
    if len(result) > MAX_IMAGE_BYTES:
        raise ValueError("normalized note image exceeds 8 MiB")
    return result


def capture_id(value: str) -> str:
    if not IMAGE_ID.fullmatch(value):
        raise ValueError("invalid capture ID")
    return value


def capture_text(value: Any, maximum: int = MAX_CAPTURE_TEXT) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"capture text must contain at most {maximum} characters")
    if any(0xD800 <= ord(char) <= 0xDFFF or (ord(char) < 32 and char not in "\r\n\t")
           for char in value):
        raise ValueError("capture text contains invalid characters")
    return value


class NoteCaptureStore:
    def __init__(
        self, path: Path, *, image_directory: Path | None = None,
        max_bytes: int = MAX_STORAGE_BYTES, retention_days: int = DEFAULT_RETENTION_DAYS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.image_directory = image_directory or path.with_name("note-images")
        self.max_bytes = max_bytes
        self.retention_seconds = retention_days * 86400
        if max_bytes <= 0 or not 1 <= retention_days <= 365:
            raise ValueError("invalid note image storage policy")
        self._clock = clock
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        connection: sqlite3.Connection | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if path.is_symlink() or self.image_directory.is_symlink():
                raise OSError("note storage cannot be a symlink")
            self.image_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.image_directory.chmod(0o700)
            connection = sqlite3.connect(path, timeout=5, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA secure_delete=ON")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                connection.close()
                raise OSError("unsupported note capture database version")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS captures (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, target TEXT NOT NULL,
                    page_id TEXT NOT NULL, target_identity TEXT NOT NULL,
                    text TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
                    source_name TEXT NOT NULL, source_identity TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    source_ended_at REAL, kept INTEGER NOT NULL DEFAULT 0,
                    image_bytes INTEGER NOT NULL DEFAULT 0, image_expired_at REAL,
                    revision INTEGER NOT NULL DEFAULT 0, request_hash TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS captures_target ON captures(scope,target,page_id);
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY, recorded_at REAL NOT NULL,
                    action TEXT NOT NULL, capture_id TEXT NOT NULL, freed_bytes INTEGER NOT NULL
                );
                PRAGMA user_version=1;
            """)
            connection.commit()
            path.chmod(0o600)
            self._connection = connection
        except (OSError, sqlite3.Error):
            if connection is not None:
                connection.close()
            LOGGER.warning("Note capture storage is unavailable; preserve and repair it")

    def _db(self) -> sqlite3.Connection:
        if self._connection is None:
            raise NoteCapturesUnavailable("note capture storage is unavailable; preserve and repair it")
        return self._connection

    def _image(self, identifier: str) -> Path:
        return self.image_directory / f"{capture_id(identifier)}.png"

    def _image_bytes_on_disk(self) -> int:
        return sum(path.stat().st_size for path in self.image_directory.iterdir()
                   if path.suffix == ".png" and IMAGE_ID.fullmatch(path.stem)
                   and not path.is_symlink() and path.is_file())

    def _payload(self, row: sqlite3.Row) -> dict[str, Any]:
        ended = row["source_ended_at"]
        return {
            "id": row["id"], "scope": row["scope"], "target": row["target"],
            "pageId": row["page_id"], "text": row["text"], "caption": row["caption"],
            "sourceSession": row["source_name"], "sourceIdentity": row["source_identity"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "sourceEndedAt": ended, "kept": bool(row["kept"]),
            "imageBytes": row["image_bytes"], "imageExpiredAt": row["image_expired_at"],
            "expiresAt": ended + self.retention_seconds
            if ended is not None and not row["kept"] and row["image_bytes"] else None,
            "revision": row["revision"],
        }

    def get(self, identifier: str) -> dict[str, Any]:
        with self._lock:
            row = self._db().execute("SELECT * FROM captures WHERE id=?", (capture_id(identifier),)).fetchone()
            if row is None:
                raise NoteCaptureNotFound(identifier)
            return self._payload(row)

    def list(self, scope: str | None = None, target: str | None = None,
             page_id: str | None = None) -> list[dict[str, Any]]:
        clauses, values = [], []
        for column, value in (("scope", scope), ("target", target), ("page_id", page_id)):
            if value is not None:
                clauses.append(f"{column}=?")
                values.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock:
            return [self._payload(row) for row in self._db().execute(
                "SELECT * FROM captures" + where + " ORDER BY created_at,id", values,
            )]

    def create(self, *, identifier: str, scope: str, target: str, page_id: str,
               source: Session, target_identity: str = "", text: str = "",
               image: bytes | None = None) -> dict[str, Any]:
        identifier = capture_id(identifier)
        text = capture_text(text)
        if scope not in {"common", "workspace", "session"} or not target or not page_id:
            raise ValueError("invalid capture destination")
        if not text.strip() and image is None:
            raise ValueError("capture must include text or an image")
        normalized = normalize_image(image) if image is not None else None
        digest = hashlib.sha256(json.dumps([scope, target, page_id, source.identity, text]).encode()
                                + (normalized or b"")).hexdigest()
        with self._lock:
            db = self._db()
            existing = db.execute("SELECT * FROM captures WHERE id=?", (identifier,)).fetchone()
            if existing is not None:
                # A retried upload must not insert a second clip or silently change its destination.
                if existing["request_hash"] != digest:
                    raise NoteCaptureConflict("capture ID already belongs to another capture")
                return self._payload(existing)
            if db.execute("SELECT COUNT(*) FROM captures").fetchone()[0] >= MAX_CAPTURES:
                raise NoteCaptureStorageFull("note capture limit reached; delete old captures")
            if db.execute("SELECT COUNT(*) FROM captures WHERE scope=? AND target=? AND page_id=?",
                          (scope, target, page_id)).fetchone()[0] >= 256:
                raise NoteCaptureStorageFull("this page has 256 captures; move captures or add another page")
            text_bytes = db.execute("SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM captures").fetchone()[0]
            if text_bytes + len(text.encode("utf-8")) > MAX_TEXT_STORAGE_BYTES:
                raise NoteCaptureStorageFull("note capture text storage is full; remove old captures")
            destination = self._image(identifier)
            already_written = normalized is not None and destination.exists()
            if already_written and (destination.is_symlink() or destination.read_bytes() != normalized):
                raise NoteCaptureConflict("capture image ID already exists")
            used = self._image_bytes_on_disk()
            if normalized is not None and used + (0 if already_written else len(normalized)) > self.max_bytes:
                raise NoteCaptureStorageFull("note image storage is full; review storage or delete images")
            if normalized is not None and not already_written:
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(normalized)
            now = self._clock()
            try:
                with db:
                    db.execute("""INSERT INTO captures
                        (id,scope,target,page_id,target_identity,text,source_name,source_identity,
                         created_at,updated_at,image_bytes,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (identifier, scope, target, page_id, target_identity, text, source.name,
                         source.identity, now, now, len(normalized) if normalized else 0, digest))
            except sqlite3.Error:
                if normalized is not None:
                    destination.unlink(missing_ok=True)
                raise
            return self.get(identifier)

    def update(self, identifier: str, revision: int, **changes: Any) -> dict[str, Any]:
        mapping = {"text": "text", "caption": "caption", "kept": "kept",
                   "scope": "scope", "target": "target", "pageId": "page_id",
                   "targetIdentity": "target_identity"}
        if set(changes) - mapping.keys():
            raise ValueError("unknown capture field")
        if type(revision) is not int or revision < 0:
            raise ValueError("expectedRevision must be a nonnegative integer")
        for key in ("text", "caption"):
            if key in changes:
                changes[key] = capture_text(changes[key], 1000 if key == "caption" else MAX_CAPTURE_TEXT)
        if "kept" in changes and type(changes["kept"]) is not bool:
            raise ValueError("kept must be a boolean")
        with self._lock:
            previous = self.get(identifier)
            destination_keys = {"scope", "target", "pageId"}
            if destination_keys & changes.keys():
                if not destination_keys <= changes.keys():
                    raise ValueError("moving requires scope, target and pageId")
                if (changes["scope"] not in {"common", "workspace", "session"}
                        or not isinstance(changes["target"], str) or not changes["target"]
                        or not isinstance(changes["pageId"], str) or not changes["pageId"]):
                    raise ValueError("invalid capture destination")
                count = self._db().execute(
                    "SELECT COUNT(*) FROM captures WHERE scope=? AND target=? AND page_id=? AND id!=?",
                    (changes["scope"], changes["target"], changes["pageId"], identifier),
                ).fetchone()[0]
                if count >= 256:
                    raise NoteCaptureStorageFull("this page has 256 captures; choose another page")
            if "text" in changes:
                text_bytes = self._db().execute(
                    "SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM captures",
                ).fetchone()[0]
                if (text_bytes - len(previous["text"].encode("utf-8"))
                        + len(changes["text"].encode("utf-8")) > MAX_TEXT_STORAGE_BYTES):
                    raise NoteCaptureStorageFull("note capture text storage is full")
            assignments = [f"{mapping[key]}=?" for key in changes]
            with self._db():
                cursor = self._db().execute(
                    "UPDATE captures SET " + ",".join([*assignments, "revision=revision+1", "updated_at=?"])
                    + " WHERE id=? AND revision=?",
                    (*changes.values(), self._clock(), identifier, revision),
                )
                if cursor.rowcount != 1:
                    raise NoteCaptureConflict("capture changed in another browser; reload before editing")
            return self.get(identifier)

    def _remove_image(self, row: sqlite3.Row, reason: str) -> int:
        size = row["image_bytes"]
        if size:
            self._image(row["id"]).unlink(missing_ok=True)
            self._db().execute("UPDATE captures SET image_bytes=0,image_expired_at=?,revision=revision+1 WHERE id=?",
                               (self._clock(), row["id"]))
            self._db().execute("INSERT INTO audit(recorded_at,action,capture_id,freed_bytes) VALUES (?,?,?,?)",
                               (self._clock(), reason, row["id"], size))
        return int(size)

    def delete(self, identifier: str, *, image_only: bool = False) -> int:
        with self._lock, self._db():
            self.get(identifier)
            row = self._db().execute("SELECT * FROM captures WHERE id=?", (identifier,)).fetchone()
            freed = self._remove_image(row, "remove-image" if image_only else "delete")
            if not image_only:
                self._db().execute("DELETE FROM captures WHERE id=?", (identifier,))
            return freed

    def image_path(self, identifier: str) -> Path:
        with self._lock:
            if not self.get(identifier)["imageBytes"]:
                raise NoteCaptureNotFound(identifier)
            path = self._image(identifier)
            if path.is_symlink() or not path.is_file():
                raise NoteCaptureNotFound(identifier)
            return path

    def delete_ended_images(self, identifiers: Sequence[str]) -> int:
        with self._lock, self._db():
            rows = []
            for identifier in set(identifiers):
                self.get(identifier)
                row = self._db().execute("SELECT * FROM captures WHERE id=?", (identifier,)).fetchone()
                if row["source_ended_at"] is None or row["kept"]:
                    raise NoteCaptureConflict("an image is live or kept; refresh the storage list")
                rows.append(row)
            return sum(self._remove_image(row, "delete-ended-image") for row in rows)

    def reconcile(self, live: Sequence[Session], valid_pages: Mapping[tuple[str, str], set[str]], *,
                  reference_revisions: Mapping[str, int] | None = None) -> int:
        """Only successful complete inventories may mark sources ended or expire images."""
        by_identity = {session.identity: session.name for session in live}
        now = self._clock()
        freed = 0
        with self._lock, self._db():
            for row in self._db().execute("SELECT * FROM captures").fetchall():
                if reference_revisions is not None and reference_revisions.get(row["id"]) != row["revision"]:
                    continue  # Do not remove a capture created or moved after the page-reference snapshot.
                if (row["image_expired_at"] is not None and not row["image_bytes"]
                        and not row["text"].strip() and not row["caption"].strip()
                        and now - row["image_expired_at"] >= 30 * 86400):
                    self._db().execute("DELETE FROM captures WHERE id=?", (row["id"],))
                    continue
                source_name = by_identity.get(row["source_identity"])
                target = by_identity.get(row["target_identity"], row["target"])
                if (target != row["target"] and row["page_id"] not in valid_pages.get((row["scope"], target), set())
                        and row["page_id"] in valid_pages.get((row["scope"], row["target"]), set())):
                    target = row["target"]  # An external tmux rename may not have migrated its notebook yet.
                pages = valid_pages.get((row["scope"], target))
                if pages is None:
                    continue  # A target added after the reference snapshot is checked next time.
                if row["page_id"] not in pages:
                    freed += self._remove_image(row, "unreferenced-page")
                    self._db().execute("DELETE FROM captures WHERE id=?", (row["id"],))
                    continue
                ended = None if source_name is not None else row["source_ended_at"]
                if source_name is None and ended is None:
                    ended = now
                self._db().execute("UPDATE captures SET target=?,source_name=?,source_ended_at=? WHERE id=?",
                                   (target, source_name or row["source_name"], ended, row["id"]))
                if row["image_bytes"] and not self._image(row["id"]).is_file():
                    freed += self._remove_image(row, "missing-image")
                elif ended is not None and not row["kept"] and now - ended >= self.retention_seconds:
                    freed += self._remove_image(row, "source-ended-expiry")
            # Recover files left by an interrupted upload, with an explicit reference check and grace.
            referenced = {row[0] for row in self._db().execute("SELECT id FROM captures WHERE image_bytes>0")}
            for path in self.image_directory.iterdir():
                if path.suffix != ".png" or not IMAGE_ID.fullmatch(path.stem) or path.stem in referenced:
                    continue
                if path.is_symlink():
                    continue
                info = path.stat()
                if now - info.st_mtime >= 3600:
                    path.unlink()
                    freed += info.st_size
                    self._db().execute("INSERT INTO audit(recorded_at,action,capture_id,freed_bytes) VALUES (?,?,?,?)",
                                       (now, "unreferenced-file", path.stem, info.st_size))
            self._db().execute("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)")
        return freed

    def summary(self) -> dict[str, Any]:
        with self._lock:
            rows = self._db().execute("SELECT scope,target,image_bytes,source_ended_at FROM captures").fetchall()
            referenced_bytes = sum(row["image_bytes"] for row in rows)
            used = self._image_bytes_on_disk()
            ended = [row for row in rows if row["source_ended_at"] is not None and row["image_bytes"]]
            by_target: dict[str, dict[str, int]] = {}
            for row in rows:
                key = json.dumps([row["scope"], row["target"]], separators=(",", ":"), ensure_ascii=False)
                entry = by_target.setdefault(key, {"bytes": 0, "images": 0, "endedImages": 0, "captures": 0})
                entry["captures"] += 1
                entry["bytes"] += row["image_bytes"]
                entry["images"] += int(row["image_bytes"] > 0)
                entry["endedImages"] += int(row["image_bytes"] > 0 and row["source_ended_at"] is not None)
            return {"usedBytes": used, "limitBytes": self.max_bytes,
                    "unreferencedBytes": max(0, used - referenced_bytes),
                    "imageCount": sum(row["image_bytes"] > 0 for row in rows),
                    "endedImageCount": len(ended), "endedBytes": sum(row["image_bytes"] for row in ended),
                    "warning": "critical" if used >= self.max_bytes * .95 else
                    "warning" if used >= self.max_bytes * .8 or ended else "normal",
                    "retentionDays": self.retention_seconds // 86400,
                    "targets": by_target}

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
