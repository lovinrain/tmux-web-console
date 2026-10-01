"""Known-credential privacy in transformed Codex evidence; no live provider."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import threading
from typing import Any

import pytest

from muxpilot.runtime import _Capture
from tmux_console.stdio_capture import CodexCaptureSanitizer
from tmux_console.stdio_runner import StreamingRedactor


def sanitizer_for(secrets: tuple[bytes, ...], **kwargs: Any) -> CodexCaptureSanitizer:
    return CodexCaptureSanitizer(secrets, redactor_factory=StreamingRedactor, **kwargs)


def record(method: str, **params: Any) -> bytes:
    return (json.dumps({"method": method, "params": params}, ensure_ascii=True) + "\n").encode()


def delta(text: str, item: str = "one", **params: Any) -> bytes:
    return record("item/agentMessage/delta", itemId=item, delta=text, **params)


def decoded(content: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in content.splitlines()]


def item_text(rows: list[dict[str, Any]], item: str = "one") -> str:
    return "".join(row["params"]["delta"] for row in rows
                   if row.get("params", {}).get("itemId") == item and "delta" in row["params"])


@pytest.mark.parametrize("secret,parts", [
    ("synthetic-credential-snow-雪", ["synthetic-credential-snow-雪"]),
    ("synthetic-secret-split-value", ["synthetic-secret-", "split-value"]),
])
def test_capture_decoded_privacy_and_transcript_match_artifact(tmp_path, secret, parts):
    wire = b"".join(delta(part) for part in parts)
    transcript = io.BytesIO()
    capture = _Capture(tmp_path / "stdout.bin", transcript, "stdout", 100_000,
                       threading.Lock(), (secret.encode(),), structured=True)
    for position in range(0, len(wire), 17):
        capture.observe(wire[position:position + 17])
    receipt = capture.close()
    content = (tmp_path / "stdout.bin").read_bytes()
    assert item_text(decoded(content)) == "[REDACTED]"
    assert secret not in json.dumps(decoded(content), ensure_ascii=False)
    transcript_rows = decoded(transcript.getvalue())
    assert b"".join(base64.b64decode(row["bytes_base64"]) for row in transcript_rows) == content
    assert all(row["representation"] == "sanitized codex-app-server JSONL" for row in transcript_rows)
    assert receipt["sha256"] == hashlib.sha256(content).hexdigest()
    assert receipt["observed_byte_count"] == len(wire)
    assert receipt["redacted"] and receipt["complete"]
    assert not receipt["truncated"]


def test_every_wire_split_and_single_byte_reads_preserve_safe_unicode_text():
    secret = "private-雪-token"
    expected = "Hello 雪 [REDACTED] end 🐈"
    wire = delta("Hello 雪 private-") + delta("雪-token end 🐈")
    fragmentations = [[wire[:split], wire[split:]] for split in range(len(wire) + 1)]
    fragmentations.append([wire[position:position + 1] for position in range(len(wire))])
    for fragments in fragmentations:
        sanitizer = sanitizer_for((secret.encode(),))
        content = b"".join(sanitizer.feed(fragment) for fragment in fragments) + sanitizer.feed(b"", final=True)
        assert item_text(decoded(content)) == expected
        assert sanitizer.redacted and not sanitizer.items and not sanitizer.pending


@pytest.mark.parametrize("completion", ["item", "turn", "EOF"])
def test_pending_nonsecret_prefix_flush_and_record_order(completion):
    sanitizer = sanitizer_for((b"synthetic-secret",))
    wire = delta("synthetic-", threadId="thread", turnId="turn")
    ending = b""
    if completion == "item":
        ending = record("item/completed", threadId="thread", turnId="turn", item={"id": "one", "text": "synthetic-"})
    elif completion == "turn":
        ending = record("turn/completed", threadId="thread", turn={"id": "turn", "status": "completed"})
    rows = decoded(sanitizer.feed(wire + ending) + sanitizer.feed(b"", final=True))
    assert item_text(rows) == "synthetic-"
    assert rows[0]["method"] == "item/agentMessage/delta"
    assert rows[1]["method"] == "muxpilot/capture/textFlush"
    if ending:
        assert rows[2]["method"] == ("item/completed" if completion == "item" else "turn/completed")
    assert not sanitizer.redacted and not sanitizer.items


def test_items_threads_and_delta_channels_are_independent():
    sanitizer = sanitizer_for((b"credential-value",))
    wire = (delta("credential-", "a", threadId="thread-a")
            + delta("value", "b", threadId="thread-a")
            + delta("value", "a", threadId="thread-b")
            + record("item/commandExecution/outputDelta", itemId="a", threadId="thread-a", delta="value")
            + delta("value", "a", threadId="thread-a"))
    rows = decoded(sanitizer.feed(wire) + sanitizer.feed(b"", final=True))
    streams: dict[tuple[str, str, str], str] = {}
    for row in rows:
        params = row["params"]
        key = (params["threadId"], params["itemId"], params.get("sourceMethod", row["method"]))
        streams[key] = streams.get(key, "") + params["delta"]
    assert streams[("thread-a", "a", "item/agentMessage/delta")] == "[REDACTED]"
    assert streams[("thread-a", "b", "item/agentMessage/delta")] == "value"
    assert streams[("thread-b", "a", "item/agentMessage/delta")] == "value"
    assert streams[("thread-a", "a", "item/commandExecution/outputDelta")] == "value"


@pytest.mark.parametrize("completion", [True, False])
def test_qualified_codex_long_opaque_item_id_correlates_and_flushes(completion):
    item = "opaque-agent-item-" + "x" * 483  # Actual qualified Codex IDs are 500 characters.
    sanitizer = sanitizer_for((b"private-token",))
    wire = delta("safe private-", item) + delta("token tail", item)
    if completion:
        wire += record("item/completed", item={"id": item, "type": "agentMessage"})
    rows = decoded(sanitizer.feed(wire) + sanitizer.feed(b"", final=True))
    assert item_text(rows, item) == "safe [REDACTED] tail"
    assert sanitizer.omitted_deltas == 0 and not sanitizer.items


@pytest.mark.parametrize("method", ["item/fileChange/outputDelta", "item/customOutput/delta"])
def test_additional_text_delta_methods_use_the_same_semantic_privacy_boundary(method):
    sanitizer = sanitizer_for((b"private-token",))
    wire = record(method, itemId="one", delta="private-") + record(method, itemId="one", delta="token tail")
    rows = decoded(sanitizer.feed(wire) + sanitizer.feed(b"", final=True))
    assert item_text(rows) == "[REDACTED] tail"
    assert rows[0]["method"] == rows[1]["method"] == method
    assert rows[-1]["params"]["sourceMethod"] == method
    assert sanitizer.omitted_records == sanitizer.omitted_deltas == 0


def test_nested_complete_fields_commands_and_metadata_are_sanitized():
    secret = "credential-雪"
    sanitizer = sanitizer_for((secret.encode(),))
    wire = record("item/completed", item={"id": "one", "text": secret,
        "command": ["echo", secret], "nested": [{secret: "output " + secret}]}, count=321)
    row = decoded(sanitizer.feed(wire) + sanitizer.feed(b"", final=True))[0]
    item = row["params"]["item"]
    assert item["text"] == "[REDACTED]"
    assert item["command"] == ["echo", "[REDACTED]"]
    assert item["nested"] == [{"[REDACTED]": "output [REDACTED]"}]
    assert row["method"] == "item/completed" and row["params"]["count"] == 321


@pytest.mark.parametrize("secret", ["params", "delta", "method", "itemId", "muxpilotCapture"])
def test_credentials_matching_protocol_keys_do_not_break_semantic_processing(secret):
    sanitizer = sanitizer_for((secret.encode(),))
    middle = len(secret) // 2
    wire = delta("Hello " + secret[:middle]) + delta(secret[middle:] + " tail")
    rows = decoded(sanitizer.feed(wire) + sanitizer.feed(b"", final=True))
    params_key = "[REDACTED]" if secret == "params" else "params"
    delta_key = "[REDACTED]" if secret == "delta" else "delta"
    text = "".join(row[params_key][delta_key] for row in rows if delta_key in row[params_key])
    assert text == "Hello [REDACTED] tail"
    assert secret not in json.dumps(rows, ensure_ascii=False)
    assert sanitizer.redacted and sanitizer.omitted_records == sanitizer.omitted_deltas == 0


def test_malformed_oversized_deep_records_never_fall_back_to_raw_content():
    secret = "credential-雪"
    sanitizer = sanitizer_for((secret.encode(),), line_limit=256)
    huge = b'{"unsafe":"' + secret.encode() + b"x" * 5000
    assert b"unsafe" not in sanitizer.feed(huge)
    assert not sanitizer.pending and sanitizer.discard_line
    output = sanitizer.feed(b'"}\n' + b"not JSON " + secret.encode() + b"\n"
                            + record("thread/tokenUsage/updated", count=321))
    output += sanitizer.feed(b"", final=True)
    rows = decoded(output)
    assert secret not in json.dumps(rows, ensure_ascii=False)
    assert rows[0]["method"] == "muxpilot/capture/omitted"
    assert rows[1]["params"]["count"] == 321
    assert sanitizer.omitted_records == 2
    deep = sanitizer_for((secret.encode(),))
    nested = b'{"nested":' + b"[" * 100 + json.dumps(secret).encode() + b"]" * 100 + b"}\n"
    assert decoded(deep.feed(nested))[0]["method"] == "muxpilot/capture/omitted"


def test_item_map_bound_does_not_evict_pending_prefix_and_reports_omissions():
    sanitizer = sanitizer_for((b"credential-value",), item_limit=1)
    output = sanitizer.feed(delta("credential-", "a") + delta("overflow", "b")
                            + record("item/agentMessage/delta", delta="unidentified")
                            + delta("value", "a"))
    assert len(sanitizer.items) == 1
    rows = decoded(output + sanitizer.feed(b"", final=True))
    assert item_text(rows, "a") == "[REDACTED]"
    assert item_text(rows, "b") == "[CAPTURE TEXT OMITTED]"
    assert sanitizer.omitted_deltas == 2


def test_invalid_utf8_and_decoding_failure_at_eof_are_safe_omissions():
    # Private credential files are byte sequences. A binary known value can
    # match inside UTF-8 code points across semantic deltas; omit that stream
    # rather than let an evidence decoder exception stop the provider bridge.
    sanitizer = sanitizer_for((b"\xa9z",))
    content = sanitizer.feed(delta("é") + delta("z"))
    content += sanitizer.feed(b'{"invalid":"\xff"}', final=True)
    assert all(row["method"] in {"item/agentMessage/delta", "muxpilot/capture/omitted"}
               for row in decoded(content))
    assert sanitizer.omitted_records == 3 and sanitizer.redacted and not sanitizer.items


def test_capture_omission_and_truncation_are_incomplete_but_generic_bytes_stay_supported(tmp_path):
    for name, structured, wire, limit in [
        ("omission", True, b"malformed private-token\n", 100_000),
        ("truncation", True, delta("safe output"), 4),
        ("generic", False, b"plain private-token output", 100_000),
    ]:
        capture = _Capture(tmp_path / name, io.BytesIO(), "stdout", limit, threading.Lock(),
                           (b"private-token",), structured=structured)
        capture.observe(wire)
        receipt = capture.close()
        if name == "generic":
            assert (tmp_path / name).read_bytes() == b"plain [REDACTED] output"
            assert receipt["complete"] and receipt["representation"] == "redacted provider bytes"
        else:
            assert not receipt["complete"]
            assert receipt["omitted_records"] == (1 if name == "omission" else 0)
