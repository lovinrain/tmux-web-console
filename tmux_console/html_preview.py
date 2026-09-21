"""Short-lived, directory-scoped capabilities for isolated HTML previews.

The normal file browser authenticates the caller before issuing a grant. The
preview document and its local assets can then use that grant without receiving
the console's credentials or a same-origin browser context.
"""

from __future__ import annotations

import math
import secrets
import stat
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .file_browser import (
    MAX_HTML_PREVIEW_BYTES,
    FileBrowserContentTooLargeError,
    FileBrowserHtmlPreview,
    FileBrowserPathOutsideRootError,
    FileBrowserUnsupportedFileError,
    resolve_file_download,
)

HTML_PREVIEW_GRANT_TTL_SECONDS = 60 * 60
MAX_HTML_PREVIEW_GRANTS = 128
MAX_PREVIEW_CODE_BYTES = 10 * 1024 * 1024
MAX_PREVIEW_ASSET_BYTES = 25 * 1024 * 1024
MAX_PREVIEW_MEDIA_BYTES = 50 * 1024 * 1024

# Explicit MIME types prevent platform-specific guessing from turning a source
# file, environment file, or arbitrary download into a browser document.
_ASSET_TYPES: dict[str, tuple[str, int]] = {
    ".html": ("text/html", MAX_HTML_PREVIEW_BYTES),
    ".htm": ("text/html", MAX_HTML_PREVIEW_BYTES),
    ".js": ("text/javascript", MAX_PREVIEW_CODE_BYTES),
    ".mjs": ("text/javascript", MAX_PREVIEW_CODE_BYTES),
    ".css": ("text/css", MAX_PREVIEW_CODE_BYTES),
    ".json": ("application/json", MAX_PREVIEW_CODE_BYTES),
    ".map": ("application/json", MAX_PREVIEW_CODE_BYTES),
    ".png": ("image/png", MAX_PREVIEW_ASSET_BYTES),
    ".jpg": ("image/jpeg", MAX_PREVIEW_ASSET_BYTES),
    ".jpeg": ("image/jpeg", MAX_PREVIEW_ASSET_BYTES),
    ".gif": ("image/gif", MAX_PREVIEW_ASSET_BYTES),
    ".webp": ("image/webp", MAX_PREVIEW_ASSET_BYTES),
    ".avif": ("image/avif", MAX_PREVIEW_ASSET_BYTES),
    ".ico": ("image/x-icon", MAX_PREVIEW_ASSET_BYTES),
    ".svg": ("image/svg+xml", MAX_PREVIEW_ASSET_BYTES),
    ".woff": ("font/woff", MAX_PREVIEW_ASSET_BYTES),
    ".woff2": ("font/woff2", MAX_PREVIEW_ASSET_BYTES),
    ".ttf": ("font/ttf", MAX_PREVIEW_ASSET_BYTES),
    ".otf": ("font/otf", MAX_PREVIEW_ASSET_BYTES),
    ".wasm": ("application/wasm", MAX_PREVIEW_ASSET_BYTES),
    ".mp3": ("audio/mpeg", MAX_PREVIEW_MEDIA_BYTES),
    ".mp4": ("video/mp4", MAX_PREVIEW_MEDIA_BYTES),
    ".webm": ("video/webm", MAX_PREVIEW_MEDIA_BYTES),
    ".ogg": ("audio/ogg", MAX_PREVIEW_MEDIA_BYTES),
    ".wav": ("audio/wav", MAX_PREVIEW_MEDIA_BYTES),
}


@dataclass(frozen=True)
class HtmlPreviewGrant:
    token: str
    root: Path
    document_name: str
    document_path: Path
    session_name: str
    session_id: str
    session_created: int
    server_started: int
    server_pid: int
    pane_id: str
    expires_at: float
    root_device: int
    root_inode: int


@dataclass(frozen=True)
class HtmlPreviewAsset:
    path: Path
    name: str
    media_type: str
    is_html: bool


class HtmlPreviewGrantStore:
    """Bounded, process-local capabilities, expired on an absolute timer.

    Reading a grant never extends its lifetime. A service restart also revokes
    all grants because tokens are deliberately not persisted.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = HTML_PREVIEW_GRANT_TTL_SECONDS,
        max_grants: int = MAX_HTML_PREVIEW_GRANTS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("preview grant lifetime must be positive and finite")
        if isinstance(max_grants, bool) or not isinstance(max_grants, int) or max_grants < 1:
            raise ValueError("preview grant capacity must be a positive integer")
        self._ttl_seconds = ttl_seconds
        self._max_grants = max_grants
        self._clock = clock
        self._grants: OrderedDict[str, HtmlPreviewGrant] = OrderedDict()
        self._lock = threading.Lock()

    def issue(
        self,
        selected_html: FileBrowserHtmlPreview,
        *,
        session_name: str,
        session_id: str,
        session_created: int,
        server_started: int,
        server_pid: int,
        pane_id: str,
    ) -> HtmlPreviewGrant:
        # The file-browser validator already returned a canonical path. Keep
        # that boundary: resolving it again before choosing the parent could
        # let a file replaced with an outside symlink widen a new grant.
        document = selected_html.path
        if not document.is_absolute():
            raise ValueError("preview document path must be absolute")
        root = document.parent
        root_stat = root.lstat()
        if Path(selected_html.name).name != selected_html.name:
            raise ValueError("preview document name must be a filename")
        if Path(selected_html.name).suffix.casefold() not in {".html", ".htm"}:
            raise FileBrowserUnsupportedFileError("preview document must be HTML")
        now = self._clock()
        grant = HtmlPreviewGrant(
            token=secrets.token_urlsafe(32),
            root=root,
            document_name=selected_html.name,
            document_path=document,
            session_name=session_name,
            session_id=session_id,
            session_created=session_created,
            server_started=server_started,
            server_pid=server_pid,
            pane_id=pane_id,
            expires_at=now + self._ttl_seconds,
            root_device=root_stat.st_dev,
            root_inode=root_stat.st_ino,
        )
        # Validate here as well as on each request. In particular, an HTML
        # symlink must not authorize a directory containing a hidden target.
        resolve_html_preview_asset(grant, grant.document_name)
        with self._lock:
            self._expire(now)
            while len(self._grants) >= self._max_grants:
                self._grants.popitem(last=False)
            self._grants[grant.token] = grant
        return grant

    def get(self, token: str) -> HtmlPreviewGrant | None:
        with self._lock:
            self._expire(self._clock())
            return self._grants.get(token)

    def revoke(self, token: str) -> None:
        with self._lock:
            self._grants.pop(token, None)

    def _expire(self, now: float) -> None:
        expired = [
            token for token, grant in self._grants.items()
            if grant.expires_at <= now
        ]
        for token in expired:
            del self._grants[token]


def _verify_root(grant: HtmlPreviewGrant) -> None:
    root_stat = grant.root.lstat()
    if (
        not stat.S_ISDIR(root_stat.st_mode)
        or grant.root.resolve(strict=True) != grant.root
        or (root_stat.st_dev, root_stat.st_ino) != (grant.root_device, grant.root_inode)
    ):
        raise FileBrowserPathOutsideRootError("preview directory identity changed")


def resolve_html_preview_asset(
    grant: HtmlPreviewGrant,
    relative_path: str,
) -> HtmlPreviewAsset:
    """Resolve only permitted web assets below the grant's original directory."""
    if not isinstance(relative_path, str):
        raise TypeError("path must be a string")
    if not relative_path or relative_path.startswith("/") or "\\" in relative_path:
        raise ValueError("preview asset path must be a relative file path")
    if any(part.startswith(".") for part in relative_path.split("/")):
        raise FileBrowserPathOutsideRootError("hidden paths and traversal are not preview assets")
    name = Path(relative_path).name
    asset_type = _ASSET_TYPES.get(Path(name).suffix.casefold())
    if asset_type is None:
        raise FileBrowserUnsupportedFileError("path is not a supported preview asset")
    _verify_root(grant)
    # Preserve the selected document's visible name even if it was a symlink
    # with a different basename. All other requests resolve normally.
    actual_relative_path = (
        grant.document_path.name
        if relative_path == grant.document_name
        else relative_path
    )
    resolved = resolve_file_download(
        str(grant.root), actual_relative_path, boundary=grant.root,
    )
    _verify_root(grant)
    resolved_parts = resolved.path.relative_to(grant.root).parts
    if any(part.startswith(".") for part in resolved_parts):
        raise FileBrowserPathOutsideRootError("hidden paths are not preview assets")
    target_type = _ASSET_TYPES.get(resolved.path.suffix.casefold())
    if target_type is None:
        raise FileBrowserUnsupportedFileError("target is not a supported preview asset")
    media_type, maximum_bytes = asset_type
    maximum_bytes = min(maximum_bytes, target_type[1])
    if resolved.path.stat().st_size > maximum_bytes:
        raise FileBrowserContentTooLargeError("file exceeds the preview asset size limit")
    return HtmlPreviewAsset(
        path=resolved.path,
        name=name,
        media_type=media_type,
        is_html=media_type == "text/html",
    )
