"""Note capture routes and retention, sharing the existing successful session inventory."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Awaitable, Callable, Sequence
from functools import wraps
from pathlib import Path
from typing import Any

from aiohttp import BodyPartReader, web
from PIL import Image

from .note_captures import (
    MAX_IMAGE_BYTES,
    NoteCaptureConflict,
    NoteCaptureNotFound,
    NoteCaptureStorageFull,
    NoteCaptureStore,
    NoteCapturesUnavailable,
)
from .tmux import Session, TmuxClient, TmuxError, TmuxSessionNotFoundError
from .work_links import object_fields
from .workspaces import (
    WorkspaceNotFoundError,
    WorkspaceStore,
    WorkspaceStoreUnavailable,
)

LOGGER = logging.getLogger("muxdeck.note_captures")
Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


def _errors(handler: Handler) -> Handler:
    @wraps(handler)
    async def guarded(request: web.Request) -> web.StreamResponse:
        try:
            result = await handler(request)
        except (NoteCaptureNotFound, TmuxSessionNotFoundError, WorkspaceNotFoundError):
            result = web.json_response({"error": "note capture, session or destination not found"}, status=404)
        except NoteCaptureConflict as error:
            result = web.json_response({"error": str(error)}, status=409)
        except NoteCaptureStorageFull as error:
            result = web.json_response({"error": str(error)}, status=507)
        except (TmuxError, WorkspaceStoreUnavailable, NoteCapturesUnavailable) as error:
            result = web.json_response({"error": str(error)}, status=503)
        except (TypeError, ValueError, RecursionError) as error:
            result = web.json_response({"error": str(error) or "invalid capture request"}, status=400)
        except (OSError, sqlite3.Error):
            LOGGER.exception("Note capture storage operation failed")
            result = web.json_response({"error": "note capture storage operation failed"}, status=503)
        result.headers["Cache-Control"] = "no-store"
        result.headers["X-Content-Type-Options"] = "nosniff"
        return result
    return guarded


class NoteCaptureService:
    def __init__(self, store: NoteCaptureStore, workspaces: WorkspaceStore) -> None:
        self.store = store
        self.workspaces = workspaces
        self._last_maintenance = float("-inf")
        self._inventory: tuple[tuple[str, str], ...] = ()

    def notebook(self, scope: str, target: str) -> dict[str, Any]:
        if scope == "common" and target == "common":
            return self.workspaces.get_common_notebook()
        if scope == "workspace":
            return self.workspaces.get_workspace_notebook(target)
        if scope == "session":
            return self.workspaces.get_session_notebook(target)
        raise ValueError("invalid note destination")

    def validate_page(self, scope: str, target: str, page_id: str) -> None:
        notebook = self.notebook(scope, target)
        if not any(page["id"] == page_id for page in notebook["pages"]):
            raise NoteCaptureConflict("the destination page was removed; choose another page")

    def maintain(self, live: Sequence[Session], *, force: bool = False) -> int:
        inventory = tuple(sorted((session.identity, session.name) for session in live))
        now = time.monotonic()
        if not force and inventory == self._inventory and now - self._last_maintenance < 60:
            return 0
        identities = dict(inventory)
        captures = self.store.list()
        targets = {(item["scope"], item["target"]) for item in captures}
        # A native rename moves session notes too. Include every current name before reconciliation.
        targets.update(("session", name) for name in identities.values())
        valid_pages: dict[tuple[str, str], set[str]] = {}
        for scope, target in targets:
            try:
                valid_pages[scope, target] = {page["id"] for page in self.notebook(scope, target)["pages"]}
            except WorkspaceNotFoundError:
                valid_pages[scope, target] = set()
        freed = self.store.reconcile(live, valid_pages, reference_revisions={item["id"]: item["revision"] for item in captures})
        self._last_maintenance = now
        self._inventory = inventory
        return freed


def create_note_capture_service(registry_path: Path, workspaces: WorkspaceStore) -> NoteCaptureService:
    path = Path(os.environ.get("MUXDECK_NOTE_CAPTURES_FILE", str(registry_path.with_name("note-captures.sqlite3")))).expanduser()
    directory = Path(os.environ.get("MUXDECK_NOTE_IMAGES_DIR", str(path.with_name("note-images")))).expanduser()
    maximum = int(os.environ.get("MUXDECK_NOTE_IMAGES_MAX_BYTES", str(256 * 1024 * 1024)))
    days = int(os.environ.get("MUXDECK_NOTE_IMAGE_RETENTION_DAYS", "7"))
    return NoteCaptureService(NoteCaptureStore(path, image_directory=directory,
                                             max_bytes=maximum, retention_days=days), workspaces)


def register_note_capture_routes(
    app: web.Application, prefix: str, service: NoteCaptureService,
    tmux: TmuxClient, session_lock: asyncio.Lock,
) -> None:
    store = service.store
    ocr_lock = asyncio.Semaphore(1)
    preview_lock = asyncio.Semaphore(2)

    async def refresh(*, force: bool = False) -> None:
        async with session_lock:
            live = await tmux.list_sessions()
            await asyncio.to_thread(service.maintain, live, force=force)

    async def payload(request: web.Request) -> dict[str, Any]:
        value = await request.json()
        if not isinstance(value, dict):
            raise TypeError("request body must be an object")
        return value

    @_errors
    async def list_captures(request: web.Request) -> web.Response:
        if set(request.query) - {"scope", "target", "pageId"}:
            raise ValueError("unknown capture query field")
        scope, target, page_id = (request.query.get(key, "") for key in ("scope", "target", "pageId"))
        service.validate_page(scope, target, page_id)
        await refresh()
        captures = await asyncio.to_thread(store.list, scope, target, page_id)
        return web.json_response({"captures": captures})

    @_errors
    async def storage(request: web.Request) -> web.Response:
        await refresh()
        summary = await asyncio.to_thread(store.summary)
        captures = await asyncio.to_thread(store.list)
        images = sorted((item for item in captures if item["imageBytes"]),
                        key=lambda item: (-item["imageBytes"], item["id"]))[:200]
        return web.json_response({"summary": summary,
                                  "captures": [{**item, "text": item["text"][:160]} for item in images],
                                  "ocrAvailable": shutil.which("tesseract") is not None})

    @_errors
    async def create(request: web.Request) -> web.Response:
        if request.content_type != "multipart/form-data":
            raise ValueError("capture uploads require multipart/form-data")
        reader = await request.multipart()
        metadata: dict[str, Any] | None = None
        image: bytes | None = None
        seen: set[str] = set()
        async for part in reader:
            if not isinstance(part, BodyPartReader):
                raise TypeError("nested uploads are not supported")
            name = part.name
            if name is None or name not in {"metadata", "image"} or name in seen:
                raise ValueError("upload must contain metadata and an optional image")
            seen.add(name)
            data = bytearray()
            maximum = MAX_IMAGE_BYTES if name == "image" else 1024 * 1024
            while chunk := await part.read_chunk(64 * 1024):
                data.extend(chunk)
                if len(data) > maximum:
                    raise web.HTTPRequestEntityTooLarge(max_size=maximum, actual_size=len(data))
            if name == "image":
                image = bytes(data)
            else:
                metadata = json.loads(data)
        value = object_fields(metadata, {"id", "scope", "target", "pageId", "sourceSession", "sourceIdentity", "text"},
                              {"id", "scope", "target", "pageId", "sourceSession", "sourceIdentity"})
        async with session_lock:
            source = await tmux.get_session(value["sourceSession"])
            if source.identity != value["sourceIdentity"]:
                raise NoteCaptureConflict("source session changed; capture the current session again")
            service.validate_page(value["scope"], value["target"], value["pageId"])
            target_identity = ""
            if value["scope"] == "session":
                target_identity = (await tmux.get_session(value["target"])).identity
            capture = await asyncio.to_thread(
                store.create, identifier=value["id"], scope=value["scope"], target=value["target"],
                page_id=value["pageId"], source=source, target_identity=target_identity,
                text=value.get("text", ""), image=image,
            )
        return web.json_response({"capture": capture}, status=201)

    @_errors
    async def update(request: web.Request) -> web.Response:
        value = object_fields(await payload(request),
                              {"expectedRevision", "text", "caption", "kept", "scope", "target", "pageId"},
                              {"expectedRevision"})
        revision = value.pop("expectedRevision")
        if {"scope", "target", "pageId"} & value.keys():
            if not {"scope", "target", "pageId"} <= value.keys():
                raise ValueError("moving requires scope, target and pageId")
            service.validate_page(value["scope"], value["target"], value["pageId"])
            value["targetIdentity"] = (await tmux.get_session(value["target"])).identity if value["scope"] == "session" else ""
        result = await asyncio.to_thread(store.update, request.match_info["capture_id"], revision, **value)
        return web.json_response({"capture": result})

    @_errors
    async def delete(request: web.Request) -> web.Response:
        if set(request.query) - {"imageOnly"} or request.query.get("imageOnly", "false") not in {"true", "false"}:
            raise ValueError("invalid capture deletion query")
        freed = await asyncio.to_thread(store.delete, request.match_info["capture_id"],
                                        image_only=request.query.get("imageOnly") == "true")
        return web.json_response({"freedBytes": freed})

    @_errors
    async def image(request: web.Request) -> web.StreamResponse:
        path = await asyncio.to_thread(store.image_path, request.match_info["capture_id"])
        if set(request.query) - {"thumbnail", "v"}:
            raise ValueError("invalid image query")
        if request.query.get("thumbnail") == "true":
            def thumbnail() -> bytes:
                with Image.open(path) as source:
                    source.thumbnail((720, 480))
                    output = io.BytesIO()
                    source.save(output, format="PNG")
                    return output.getvalue()
            async with preview_lock:
                return web.Response(body=await asyncio.to_thread(thumbnail), content_type="image/png")
        return web.FileResponse(path, headers={"Content-Type": "image/png",
                                              "Content-Disposition": 'inline; filename="note-capture.png"'})

    @_errors
    async def ocr(request: web.Request) -> web.Response:
        async with ocr_lock:
            path = await asyncio.to_thread(store.image_path, request.match_info["capture_id"])
            executable = shutil.which("tesseract")
            if executable is None:
                raise NoteCapturesUnavailable("OCR requires the host's tesseract-ocr English package")

            def recognize() -> str:
                try:
                    result = subprocess.run([executable, str(path), "stdout", "-l", "eng", "--psm", "6"],
                                            capture_output=True, timeout=20, check=False,
                                            env={**os.environ, "OMP_THREAD_LIMIT": "1"})
                except subprocess.TimeoutExpired as error:
                    raise NoteCapturesUnavailable("OCR timed out; try a smaller image") from error
                if result.returncode:
                    raise NoteCapturesUnavailable("OCR could not read this image")
                return result.stdout.decode("utf-8", "replace")[:200_000].strip()

            text = await asyncio.to_thread(recognize)
        return web.json_response({"text": text})

    @_errors
    async def cleanup(request: web.Request) -> web.Response:
        value = object_fields(await payload(request), {"ids"}, {"ids"})
        ids = value["ids"]
        if not isinstance(ids, list) or len(ids) > 200 or not all(isinstance(item, str) for item in ids):
            raise ValueError("ids must be an array of at most 200 capture IDs")
        await refresh(force=True)
        freed = await asyncio.to_thread(store.delete_ended_images, ids)
        return web.json_response({"freedBytes": freed})

    base = f"{prefix}/api/note-captures"
    app.router.add_get(base, list_captures)
    app.router.add_post(base, create)
    app.router.add_get(base + "/storage", storage)
    app.router.add_post(base + "/cleanup", cleanup)
    app.router.add_patch(base + "/{capture_id}", update)
    app.router.add_delete(base + "/{capture_id}", delete)
    app.router.add_get(base + "/{capture_id}/image", image)
    app.router.add_post(base + "/{capture_id}/ocr", ocr)
