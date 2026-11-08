"""Stream a reviewed file-manager selection to the configured public Clipboard."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import stat
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlsplit

from aiohttp import ClientError, ClientResponse, ClientSession, ClientTimeout, FormData

from .file_browser import FileBrowserUnsupportedFileError, resolve_file_download

DEFAULT_CLIPBOARD_BASE_URL = "http://127.0.0.1:8899/c"
MAX_RESPONSE_BYTES = 32 * 1024
CHUNK_BYTES = 64 * 1024


class ClipboardUploadError(Exception):
    def __init__(self, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ClipboardFile:
    handle: BinaryIO
    name: str
    size: int


def prepare_clipboard_file(root_path: str, relative_path: str, *, boundary: Path | None) -> ClipboardFile:
    download = resolve_file_download(root_path, relative_path, boundary=boundary)
    # Resolution checks the browse boundary. Pin the resolved file without
    # following a directory or leaf link swapped in between validation and open.
    directory = os.open(download.path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    descriptor = -1
    try:
        for part in download.path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(download.path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise FileBrowserUnsupportedFileError("path is not a regular file")
        if not info.st_size:
            raise ValueError("Clipboard cannot store an empty file")
        handle = os.fdopen(descriptor, "rb")
        descriptor = -1
        return ClipboardFile(handle, download.name, info.st_size)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory)


async def _file_chunks(source: ClipboardFile) -> AsyncIterator[bytes]:
    remaining = source.size
    while remaining:
        chunk = await asyncio.to_thread(source.handle.read, min(CHUNK_BYTES, remaining))
        if not chunk:
            raise ClipboardUploadError("The file changed while uploading. Check Clipboard before retrying.", 409)
        remaining -= len(chunk)
        yield chunk


async def _response_json(response: ClientResponse) -> dict[str, Any]:
    raw = bytearray()
    async for chunk in response.content.iter_chunked(4096):
        if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
            raise ClipboardUploadError("Clipboard returned an oversized response", 502)
        raw.extend(chunk)
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ClipboardUploadError("Clipboard returned an invalid response", 502) from error
    if not isinstance(payload, dict):
        raise ClipboardUploadError("Clipboard returned an invalid response", 502)
    return payload


def _valid_link(url: object) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        return bool(parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password)
    except ValueError:
        return False


class ClipboardUploader:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or os.environ.get("MUXDECK_CLIPBOARD_BASE_URL", DEFAULT_CLIPBOARD_BASE_URL)).rstrip("/")
        parsed = urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("MUXDECK_CLIPBOARD_BASE_URL must be an HTTP(S) service URL without credentials")

    async def upload(self, source: ClipboardFile) -> dict[str, object]:
        timeout = ClientTimeout(total=300, sock_connect=3, sock_read=60)
        async with ClientSession(timeout=timeout) as client:
            try:
                async with client.get(self.base_url + "/api/stats", headers={"Accept": "application/json"}, allow_redirects=False) as response:
                    if response.status != 200:
                        raise ClipboardUploadError("Clipboard is unavailable")
                    limits = await _response_json(response)
                maximum = limits.get("max_file")
                if type(maximum) is not int or maximum <= 0:
                    raise ClipboardUploadError("Clipboard did not report its upload limit", 502)
                if source.size > maximum:
                    raise ClipboardUploadError(f"Clipboard accepts files up to {maximum / (1024 * 1024):g} MiB", 413)
                if limits.get("mode") != "open":
                    raise ClipboardUploadError("Clipboard is currently write-protected")
            except (ClientError, TimeoutError) as error:
                raise ClipboardUploadError("Clipboard is unavailable. Try again later.") from error

            # The source stays on the server; memory usage is bounded by chunks.
            form = FormData(quote_fields=False)
            filename = source.name.replace("\r", "").replace("\n", "") or "file"
            form.add_field("file", _file_chunks(source), filename=filename,
                           content_type=mimetypes.guess_type(filename)[0] or "application/octet-stream")
            try:
                async with client.post(self.base_url + "/api/paste", data=form, headers={"Accept": "application/json"}, allow_redirects=False) as response:
                    payload = await _response_json(response)
                    if response.status != 201:
                        message = payload.get("error")
                        status = response.status if response.status in {400, 413, 429, 507} else 503
                        raise ClipboardUploadError(message if isinstance(message, str) else "Clipboard upload was not accepted", status)
            except (ClientError, TimeoutError) as error:
                raise ClipboardUploadError("Could not confirm the upload. Check Clipboard before retrying.") from error

        entries = payload.get("entries")
        entry = entries[0] if isinstance(entries, list) and len(entries) == 1 else None
        url = entry.get("url") if isinstance(entry, dict) else None
        if not isinstance(entry, dict) or entry.get("kind") != "file" or not _valid_link(url):
            raise ClipboardUploadError("The upload completed but its link was invalid. Check Clipboard.", 502)
        return {"url": url, "name": source.name, "size": source.size}
