"""Bounded semantic sanitization for retained Codex app-server JSONL.

This is a transformed evidence representation, never the provider wire. Delta
text can move to a later same-item record; synthetic flush records retain its
safe tail at completion/EOF. Invalid records are omitted rather than persisted
as raw bytes that could bypass decoded-text credential redaction.
"""

from __future__ import annotations

import codecs
import json
from collections.abc import Callable
from typing import Any

MAX_CAPTURE_LINE = 1024 * 1024
MAX_CAPTURE_ITEMS = 128
MAX_CAPTURE_DEPTH = 64
MAX_CAPTURE_ID = 4096


class CodexCaptureSanitizer:
    """Sanitize complete JSON values and independently streamed item text.

    The line and active-item limits bound state. Full maps never evict a live
    prefix: text from new streams is omitted until capacity is available. Item
    IDs and thread/turn IDs are protocol boundaries, not a hostile-provider
    guarantee against arbitrary encodings or intentionally fragmented fields.
    """

    def __init__(self, secrets: tuple[bytes, ...], *, redactor_factory: Callable[..., Any], line_limit: int = MAX_CAPTURE_LINE,
                 item_limit: int = MAX_CAPTURE_ITEMS):
        self.secrets = secrets
        self.redactor_factory = redactor_factory
        self.full = redactor_factory(secrets)
        self.line_limit, self.item_limit = line_limit, item_limit
        self.pending = bytearray()
        self.discard_line = False
        self.items: dict[tuple[str, str, str, str], tuple[Any, Any]] = {}
        self.redacted = False
        self.omitted_records = 0
        self.omitted_deltas = 0

    def _sanitize(self, value: Any, depth: int = 0) -> Any:
        if depth > MAX_CAPTURE_DEPTH:
            raise ValueError("capture nesting limit")
        if isinstance(value, str):
            content = value.encode("utf-8", errors="surrogatepass")
            if self.full.pattern is not None:
                content, count = self.full.pattern.subn(b"[REDACTED]", content)
                self.redacted |= bool(count)
            return content.decode("utf-8", errors="surrogatepass")
        if isinstance(value, dict):
            return {self._sanitize(key, depth + 1): self._sanitize(item, depth + 1)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [self._sanitize(item, depth + 1) for item in value]
        return value

    def _encode(self, value: dict[str, Any]) -> bytes:
        return (json.dumps(self._sanitize(value), ensure_ascii=True, allow_nan=False,
                           separators=(",", ":")) + "\n").encode()

    def _notice(self, reason: str) -> bytes:
        self.omitted_records += 1
        return self._encode({"method": "muxpilot/capture/omitted", "params": {"reason": reason}})

    @staticmethod
    def _identity(params: dict[str, Any], item: Any) -> tuple[str, str, str] | None:
        values = (params.get("threadId", ""), params.get("turnId", ""), item)
        if any(not isinstance(value, str) or len(value) > MAX_CAPTURE_ID for value in values) or not item:
            return None
        return values  # type: ignore[return-value]

    def _flush(self, keys: list[tuple[str, str, str, str]], reason: str) -> bytes:
        output = bytearray()
        for key in keys:
            redactor, decoder = self.items.pop(key)
            safe = redactor.feed(b"", final=True)
            self.redacted |= redactor.redacted
            try:
                tail = decoder.decode(safe, final=True)
            except UnicodeError:
                output.extend(self._notice("invalid decoded text stream at capture boundary"))
                continue
            if tail:
                thread, turn, item, method = key
                output.extend(self._encode({"method": "muxpilot/capture/textFlush", "params": {
                    "threadId": thread, "turnId": turn, "itemId": item,
                    "sourceMethod": method, "delta": tail, "reason": reason}}))
        return bytes(output)

    def _record(self, line: bytes) -> bytes:
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise TypeError("not a protocol object")
            # Work on the parsed protocol keys. Recursive sanitization in
            # _encode can rename keys matching a credential (e.g. "params"),
            # so that transformation must happen after semantic processing.
            method = value.get("method")
            params = value.get("params")
            before = b""
            if isinstance(params, dict):
                # Textual deltas from additional provider methods have the same
                # privacy boundary even when the readable view ignores them.
                if isinstance(params.get("delta"), str):
                    identity = self._identity(params, params.get("itemId"))
                    key = (*identity, method) if identity is not None and isinstance(method, str) and 0 < len(method) <= MAX_CAPTURE_ID else None
                    if key is None or (key not in self.items and len(self.items) >= self.item_limit):
                        self.omitted_deltas += 1
                        params["delta"] = "[CAPTURE TEXT OMITTED]"
                        value["muxpilotCapture"] = {"omitted": "missing item identity or active-item limit"}
                    else:
                        if key not in self.items:
                            self.items[key] = (self.redactor_factory(self.secrets),
                                               codecs.getincrementaldecoder("utf-8")("surrogatepass"))
                        redactor, decoder = self.items[key]
                        safe = redactor.feed(params["delta"].encode("utf-8", errors="surrogatepass"))
                        self.redacted |= redactor.redacted
                        params["delta"] = decoder.decode(safe)
                elif method == "item/completed":
                    item = params.get("item", {})
                    identity = self._identity(params, item.get("id") if isinstance(item, dict) else None)
                    if identity is not None:
                        before = self._flush([key for key in self.items if key[:3] == identity], "item completed")
                elif method == "turn/completed":
                    turn = params.get("turn", {})
                    turn_id = params.get("turnId", turn.get("id") if isinstance(turn, dict) else None)
                    thread_id = params.get("threadId", "")
                    before = self._flush([key for key in self.items
                                          if key[0] == thread_id and key[1] == turn_id], "turn completed")
            return before + self._encode(value)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self._notice("invalid or unsupported JSON record")

    def feed(self, payload: bytes, *, final: bool = False) -> bytes:
        output = bytearray()
        position = 0
        while position < len(payload):
            newline = payload.find(b"\n", position)
            end = len(payload) if newline < 0 else newline
            if not self.discard_line:
                if len(self.pending) + end - position > self.line_limit:
                    self.pending.clear()
                    self.discard_line = True
                    output.extend(self._notice("JSON record exceeds capture line limit"))
                else:
                    self.pending.extend(payload[position:end])
            if newline < 0:
                break
            if not self.discard_line:
                output.extend(self._record(bytes(self.pending)))
            self.pending.clear()
            self.discard_line = False
            position = newline + 1
        if final:
            if self.pending and not self.discard_line:
                output.extend(self._record(bytes(self.pending)))
            self.pending.clear()
            self.discard_line = False
            output.extend(self._flush(list(self.items), "capture EOF"))
        return bytes(output)
