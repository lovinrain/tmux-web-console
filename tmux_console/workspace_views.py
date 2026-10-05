from __future__ import annotations

import asyncio
import contextlib
import re
import secrets
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from aiohttp import web

from .pty_bridge import PtyBridge

VIEW_ID_PATTERN = re.compile(r"[a-zA-Z0-9_-]{1,128}\Z")
VIEW_SCOPE_PATTERN = re.compile(r"(?:workspace|fork):[a-zA-Z0-9_-]{1,128}\Z")
MAX_RETAINED_VIEW_IDS = 4096


def validate_view_id(value: str | None) -> str | None:
    if value is not None and (not isinstance(value, str) or not VIEW_ID_PATTERN.fullmatch(value)):
        raise ValueError("invalid browser view identifier")
    return value


def validate_view_scope(value: str | None) -> str | None:
    if value is not None and (not isinstance(value, str) or not VIEW_SCOPE_PATTERN.fullmatch(value)):
        raise ValueError("invalid workspace view scope")
    return value


@dataclass
class ViewAttachment:
    view_id: str
    scope: str | None
    group: str | None
    session: str
    cols: int
    rows: int
    ignore_size: bool
    websocket: web.WebSocketResponse
    bridge: PtyBridge


class WorkspaceViewRegistry:
    """Browser presence follows attached PTYs; eviction never stops a session."""

    def __init__(self) -> None:
        self.attachments: dict[str, ViewAttachment] = {}
        self._evicted: OrderedDict[str, None] = OrderedDict()
        self._numbers: OrderedDict[str, int] = OrderedDict()
        self._next_number = 1

    def is_evicted(self, view_id: str | None) -> bool:
        return view_id is not None and view_id in self._evicted

    def attach(self, attachment: ViewAttachment) -> str:
        if self.is_evicted(attachment.view_id):
            raise PermissionError("This browser view was disconnected; rejoin to connect again.")
        token = secrets.token_hex(16)
        self.attachments[token] = attachment
        if attachment.view_id not in self._numbers:
            self._numbers[attachment.view_id] = self._next_number
            self._next_number += 1
            while len(self._numbers) > MAX_RETAINED_VIEW_IDS:
                self._numbers.popitem(last=False)
        return token

    def detach(self, token: str) -> None:
        self.attachments.pop(token, None)

    def resize(self, token: str, cols: int, rows: int) -> None:
        attachment = self.attachments.get(token)
        if attachment is not None:
            attachment.cols, attachment.rows = cols, rows

    def snapshot(self, scope: str, sessions: list[str], view_id: str | None) -> dict[str, Any]:
        views: dict[str, dict[str, Any]] = {}
        for attachment in self.attachments.values():
            in_scope = attachment.scope == scope
            # Existing pages lack workspace metadata. Keep their matching
            # terminal attachments visible separately, rather than inventing
            # workspace/group membership for them.
            if not in_scope and not (
                attachment.scope is None and attachment.session in sessions
            ):
                continue
            view = views.setdefault(attachment.view_id, {
                "id": attachment.view_id,
                "number": self._numbers.get(attachment.view_id, 0),
                "inScope": False,
                "group": attachment.group,
                "terminals": [],
            })
            view["inScope"] = view["inScope"] or in_scope
            view["terminals"].append({
                "session": attachment.session,
                "cols": attachment.cols,
                "rows": attachment.rows,
                "ignoreSize": attachment.ignore_size,
            })
        return {
            "views": sorted(views.values(), key=lambda view: view["number"]),
            "evicted": self.is_evicted(view_id),
        }

    async def evict(self, scope: str, sessions: list[str], target: str) -> bool:
        visible = self.snapshot(scope, sessions, None)["views"]
        if not any(view["id"] == target for view in visible):
            return False
        self._evicted[target] = None
        self._evicted.move_to_end(target)
        while len(self._evicted) > MAX_RETAINED_VIEW_IDS:
            self._evicted.popitem(last=False)
        targets = [
            (token, attachment) for token, attachment in self.attachments.items()
            if attachment.view_id == target
        ]

        async def disconnect(token: str, attachment: ViewAttachment) -> None:
            async def notify() -> None:
                async def send() -> None:
                    if attachment.websocket.closed:
                        return
                    await attachment.websocket.send_json({
                        "type": "viewEvicted",
                        "message": "This view was disconnected from another workspace view. Rejoin to reconnect.",
                    })
                    # Older bundles already stop automatic reconnect on exit.
                    # New bundles handle viewEvicted first and ignore this frame.
                    await attachment.websocket.send_json({"type": "exit", "code": None})

                with contextlib.suppress(ConnectionError, RuntimeError, TimeoutError):
                    await asyncio.wait_for(send(), timeout=1)

            async def release() -> None:
                try:
                    await attachment.bridge.close()
                finally:
                    self.detach(token)

            # A stalled WebSocket must not hold the tmux size constraint alive.
            await asyncio.gather(release(), notify())
            with contextlib.suppress(ConnectionError, RuntimeError, TimeoutError):
                await asyncio.wait_for(
                    attachment.websocket.close(code=4004, message=b"Browser view disconnected"),
                    timeout=1,
                )

        await asyncio.gather(*(disconnect(token, attachment) for token, attachment in targets))
        return True

    def resume(self, view_id: str) -> None:
        self._evicted.pop(view_id, None)

    async def close(self) -> None:
        # A normal service shutdown must keep automatic reconnect enabled.
        await asyncio.gather(*(
            attachment.websocket.close(code=1001, message=b"Server restarting")
            for attachment in tuple(self.attachments.values())
        ), return_exceptions=True)
