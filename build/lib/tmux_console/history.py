from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass

from .tmux import HistoryCapture


@dataclass(frozen=True)
class HistorySnapshot:
    id: str
    pane_id: str
    created_at: float
    lines: list[str]
    history_size: int
    history_limit: int
    alternate_on: bool

    def page(self, before: int | None, limit: int) -> dict:
        end = len(self.lines) if before is None else min(max(before, 0), len(self.lines))
        start = max(0, end - limit)
        return {
            "snapshotId": self.id,
            "paneId": self.pane_id,
            "capturedAt": self.created_at,
            "lines": self.lines[start:end],
            "nextCursor": start if start > 0 else None,
            "totalLines": len(self.lines),
            "historySize": self.history_size,
            "historyLimit": self.history_limit,
            "alternateOn": self.alternate_on,
        }


class SnapshotStore:
    def __init__(self, max_items: int = 64, ttl_seconds: float = 600):
        self.max_items = max_items
        self.ttl_seconds = ttl_seconds
        self._items: OrderedDict[str, HistorySnapshot] = OrderedDict()

    def create(self, capture: HistoryCapture) -> HistorySnapshot:
        self.prune()
        snapshot = HistorySnapshot(
            id=secrets.token_urlsafe(12),
            pane_id=capture.pane.id,
            created_at=time.time(),
            lines=capture.lines,
            history_size=capture.pane.history_size,
            history_limit=capture.pane.history_limit,
            alternate_on=capture.pane.alternate_on,
        )
        self._items[snapshot.id] = snapshot
        while len(self._items) > self.max_items:
            self._items.popitem(last=False)
        return snapshot

    def get(self, snapshot_id: str) -> HistorySnapshot | None:
        self.prune()
        snapshot = self._items.get(snapshot_id)
        if snapshot is not None:
            self._items.move_to_end(snapshot_id)
        return snapshot

    def prune(self) -> None:
        cutoff = time.time() - self.ttl_seconds
        expired = [key for key, item in self._items.items() if item.created_at < cutoff]
        for key in expired:
            self._items.pop(key, None)

