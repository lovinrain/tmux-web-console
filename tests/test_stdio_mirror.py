from __future__ import annotations

import json

import pytest

from tmux_console.stdio_mirror import (
    MAX_ITEM_CHARS,
    MAX_ITEMS,
    MAX_RECORD_CHARS,
    CodexProgressMirror,
)


def event(method, params=None):
    return (
        json.dumps(
            {"jsonrpc": "2.0", "method": method, "params": params or {}},
            ensure_ascii=False,
        )
        + "\n"
    ).encode()


def sample_stream():
    opaque = "opaque-reasoning-id-" * 1000
    return b"".join(
        [
            event("turn/started"),
            event("item/started", {"item": {"id": opaque, "type": "reasoning"}}),
            event(
                "item/agentMessage/delta",
                {"itemId": "message", "delta": "Inspecting 雪 "},
            ),
            event(
                "item/agentMessage/delta",
                {"itemId": "message", "delta": "and the API.\n"},
            ),
            event(
                "item/completed",
                {
                    "item": {
                        "id": "message",
                        "type": "agentMessage",
                        "text": "Inspecting 雪 and the API.\n",
                    }
                },
            ),
            event("thread/tokenUsage/updated", {"tokenUsage": {"total": 99999}}),
            event("account/rateLimits/updated", {"opaque": "internal-limit-detail"}),
            event(
                "item/started",
                {
                    "item": {
                        "id": "command",
                        "type": "commandExecution",
                        "command": "pytest -q tests/test_api.py",
                    }
                },
            ),
            event(
                "item/commandExecution/outputDelta",
                {"itemId": "command", "delta": "3 passed\n"},
            ),
            event(
                "item/completed",
                {
                    "item": {
                        "id": "command",
                        "type": "commandExecution",
                        "aggregatedOutput": "3 passed\n",
                        "exitCode": 0,
                        "status": "completed",
                    }
                },
            ),
            event(
                "item/completed",
                {
                    "item": {
                        "id": "files",
                        "type": "fileChange",
                        "status": "completed",
                        "changes": [{"path": "src/api.py"}],
                    }
                },
            ),
            event("turn/completed", {"turn": {"status": "completed"}}),
        ]
    )


def test_codex_progress_renders_contribution_without_duplicate_text_or_metadata():
    mirror = CodexProgressMirror()
    output = mirror.feed(sample_stream(), final=True).decode()
    assert "[Turn] Working." in output
    assert output.count("Inspecting 雪 and the API.") == 1
    assert "[Command] pytest -q tests/test_api.py" in output
    assert output.count("3 passed") == 1
    assert "[Command] Exit 0." in output
    assert "[Files] completed: src/api.py." in output
    assert "[Turn] Completed." in output
    for noise in (
        "opaque-reasoning-id",
        "tokenUsage",
        "99999",
        "internal-limit-detail",
        "jsonrpc",
        "itemId",
    ):
        assert noise not in output


def test_codex_projection_is_independent_of_utf8_and_record_chunk_boundaries():
    source = sample_stream()
    expected = CodexProgressMirror().feed(source, final=True)
    mirror = CodexProgressMirror()
    actual = b"".join(
        mirror.feed(source[index : index + 1]) for index in range(len(source))
    ) + mirror.feed(b"", final=True)
    assert actual == expected


@pytest.mark.parametrize("status", ["failed", "interrupted", None])
def test_turn_outcome_never_invents_success(status):
    mirror = CodexProgressMirror()
    rendered = mirror.feed(
        event(
            "turn/completed",
            {
                "turn": {
                    "status": status,
                    "error": {"message": "Provider could not finish"},
                }
            },
        ),
        final=True,
    ).decode()
    assert "Completed" not in rendered
    assert "Provider could not finish" in rendered
    assert (status.capitalize() if status else "unreported status") in rendered


def test_errors_warnings_unknown_and_invalid_records_remain_actionable():
    records = [
        event("configWarning", {"summary": "A configured feature is unavailable"}),
        event("warning", {"message": "Command needs attention"}),
        (json.dumps({"id": 9, "error": {"message": "Request denied"}}) + "\n").encode(),
        event("future/method", {"opaque": "private-opaque-value"}),
        event("future/method", {"opaque": "second-private-opaque-value"}),
        event("turn/completed", {"turn": {"status": ["malformed"]}}),
        b"ordinary startup diagnostic\n",
        b'{"not_a_protocol_envelope":true}\n',
    ]
    rendered = CodexProgressMirror().feed(b"".join(records), final=True).decode()
    assert "A configured feature is unavailable" in rendered
    assert "Command needs attention" in rendered and "Request denied" in rendered
    assert rendered.count("Event: future/method.") == 1
    assert "private-opaque-value" not in rendered
    assert "Provider record could not be displayed" in rendered
    assert "ordinary startup diagnostic" in rendered
    assert "Unrecognized structured provider record" in rendered


def test_tool_failure_and_nonstreamed_agent_result_are_visible():
    data = event(
        "item/completed",
        {
            "item": {
                "id": "final",
                "type": "agentMessage",
                "text": "Result ready for review",
            }
        },
    )
    data += event(
        "item/completed",
        {
            "item": {
                "id": "tool",
                "type": "mcpToolCall",
                "tool": "email-service",
                "status": "failed",
                "error": {"message": "Service unavailable"},
            }
        },
    )
    rendered = CodexProgressMirror().feed(data, final=True).decode()
    assert "[Agent] Result ready for review" in rendered
    assert "[Tool] email-service: failed." in rendered
    assert "[Error] Service unavailable" in rendered


def test_record_item_output_and_identity_state_are_bounded_and_resume():
    mirror = CodexProgressMirror()
    oversized = b'{"method":"opaque","blob":"' + b"x" * (MAX_RECORD_CHARS + 1)
    assert b"size limit" in mirror.feed(oversized)
    assert mirror.pending == "" and mirror.discarding
    assert mirror.feed(b'tail"}\n') == b""
    assert b"Working" in mirror.feed(event("turn/started"))
    rendered = mirror.feed(
        event(
            "item/agentMessage/delta",
            {"itemId": "long-result", "delta": "x" * (MAX_ITEM_CHARS + 1)},
        )
    )
    assert rendered.count(b"x") == MAX_ITEM_CHARS
    assert b"Output shortened" in rendered
    for index in range(MAX_ITEMS + 30):
        mirror.feed(
            event(
                "item/agentMessage/delta", {"itemId": str(index), "delta": "progress"}
            )
        )
    assert len(mirror.items) == MAX_ITEMS
    assert max(map(len, mirror.items)) == 64


def test_unrecognized_notifications_are_bounded_and_known_progress_continues():
    mirror = CodexProgressMirror()
    notifications = b"".join(
        event(f"future/event-{index}", {"opaque": "unavailable private details"})
        for index in range(MAX_ITEMS + 30)
    )
    rendered = mirror.feed(notifications).decode()
    assert rendered.count("[Provider]") == MAX_ITEMS
    assert rendered.count("Additional activity summaries omitted") == 1
    assert "private details" not in rendered
    assert b"Still working" in mirror.feed(
        event(
            "item/agentMessage/delta", {"itemId": "message", "delta": "Still working"}
        )
    )
    mirror.feed(event("turn/started"))
    assert b"future/new-turn" in mirror.feed(event("future/new-turn"))
