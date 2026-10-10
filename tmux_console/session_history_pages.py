"""Bounded, process-local ordering snapshots for the session history list."""
from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

HistoryFilters = tuple[str | None, str, bool, str | None]
PAGE_SIZE = 50
MAX_HISTORY_IDS = 100_000


@dataclass(frozen=True)
class HistoryOrdering:
    ids: tuple[str, ...]
    filters: HistoryFilters
    created: float


class HistoryPageStore:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._items: OrderedDict[str, HistoryOrdering] = OrderedDict()

    def _prune(self) -> None:
        cutoff = self._clock() - 600
        for key, item in list(self._items.items()):
            if item.created < cutoff:
                del self._items[key]

    def create(self, ids: tuple[str, ...], filters: HistoryFilters) -> str:
        self._prune()
        while self._items and (
            len(self._items) >= 32
            or sum(len(item.ids) for item in self._items.values()) + len(ids) > 250_000
        ):
            self._items.popitem(last=False)
        key = secrets.token_urlsafe(18)
        self._items[key] = HistoryOrdering(ids, filters, self._clock())
        return key

    def get(self, cursor: str, filters: HistoryFilters) -> tuple[str, HistoryOrdering, int]:
        self._prune()
        key, separator, offset_text = cursor.partition(".")
        if (len(cursor) > 128 or not separator or not offset_text.isascii()
                or not offset_text.isdecimal()):
            raise ValueError("invalid history cursor; refresh session history")
        offset = int(offset_text)
        item = self._items.get(key)
        if item is None:
            raise ValueError("history list expired; refresh session history")
        if item.filters != filters or not 0 < offset < len(item.ids) or offset % PAGE_SIZE:
            raise ValueError("invalid history cursor; refresh session history")
        self._items.move_to_end(key)
        return key, item, offset
