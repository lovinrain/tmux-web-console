from __future__ import annotations

import json

import pytest

from tmux_console.stdio_mirror import (
    MAX_ITEM_CHARS,
    MAX_ITEMS,
    MAX_RECORD_CHARS,
    CodexProgressMirror,
    CopilotProgressMirror,
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
        b'{"method":"item/agentMessage/delta","params":{"itemId":"unicode","delta":"\\ud800"}}\n',
        b"ordinary startup diagnostic\n",
        b'{"not_a_protocol_envelope":true}\n',
    ]
    rendered = CodexProgressMirror().feed(b"".join(records), final=True).decode()
    assert "[Agent] ?" in rendered
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


def test_rendered_secret_prefix_is_withheld_until_same_item_delta_can_be_redacted():
    from tmux_console.stdio_runner import StreamingRedactor

    secret = b"synthetic-joined-credential"
    first_part, second_part = secret[:13], secret[13:]
    raw = StreamingRedactor((secret,))
    view = CodexProgressMirror()
    rendered = StreamingRedactor((secret,))

    def project(data, *, final=False):
        return rendered.feed(
            view.feed(raw.feed(data, final=final), final=final), final=final
        )

    first_event = event(
        "item/agentMessage/delta",
        {
            "itemId": "same-message",
            "delta": "A review message long enough to reach the first output checkpoint: "
            + first_part.decode(),
        },
    )
    # Suppressed metadata flushes the previous JSONL record through the raw
    # redactor without adding visible text between same-item deltas.
    noise = event("thread/tokenUsage/updated", {"padding": "x" * 200})
    first_visible = project(first_event + noise)
    assert b"review message" in first_visible
    assert first_part not in first_visible
    second_event = event(
        "item/agentMessage/delta",
        {"itemId": "same-message", "delta": second_part.decode()},
    )
    visible = first_visible + project(second_event + noise) + project(b"", final=True)
    assert secret not in visible
    assert b"[REDACTED]" in visible
    assert b"review message" in visible


def test_semantic_flush_releases_safe_item_text_and_omission_notice_is_truthful():
    source = event(
        "muxpilot/capture/textFlush",
        {
            "itemId": "safe-item",
            "sourceMethod": "item/agentMessage/delta",
            "delta": "Retained nonsecret result",
            "reason": "capture EOF",
        },
    )
    source += event(
        "muxpilot/capture/omitted", {"reason": "JSON record exceeds capture line limit"}
    )
    rendered = CodexProgressMirror().feed(source, final=True).decode()
    assert "[Agent] Retained nonsecret result" in rendered
    assert (
        "Output omitted by credential filtering: JSON record exceeds capture line limit"
        in rendered
    )
    assert "Completed" not in rendered
    assert "muxpilot/capture" not in rendered


@pytest.mark.parametrize("chunk_size", [1, 31, 65536])
@pytest.mark.parametrize("long_secret", [False, True])
def test_semantic_turn_completion_releases_agent_tail_before_outcome(
    chunk_size, long_secret
):
    from tmux_console.stdio_capture import CodexCaptureSanitizer
    from tmux_console.stdio_runner import StreamingRedactor

    secret = b"synthetic-private-mirror-token"
    secrets = (secret, b"unused-long-secret-" * 16) if long_secret else (secret,)
    sanitizer = CodexCaptureSanitizer(secrets, redactor_factory=StreamingRedactor)
    mirror = CodexProgressMirror()
    display = StreamingRedactor(secrets)
    source = event(
        "item/agentMessage/delta",
        {
            "threadId": "mirror-thread",
            "turnId": "mirror-turn",
            "itemId": "visible",
            "delta": "Checking API " + secret.decode() + " 雪\n",
        },
    )
    source += event(
        "turn/completed",
        {
            "threadId": "mirror-thread",
            "turn": {"id": "mirror-turn", "status": "interrupted"},
        },
    )
    visible = bytearray()
    for position in range(0, len(source), chunk_size):
        visible.extend(
            display.feed(
                mirror.feed(sanitizer.feed(source[position : position + chunk_size]))
            )
        )
    # Completion must flush its own item state rather than depend on EOF or a
    # larger unrelated credential retaining all the display text until EOF.
    assert not sanitizer.items
    visible.extend(
        display.feed(
            mirror.feed(sanitizer.feed(b"", final=True), final=True), final=True
        )
    )
    agent_text = "[Agent] Checking API [REDACTED] 雪\n".encode()
    assert agent_text in visible
    assert visible.index(agent_text) < visible.index(b"[Turn] Interrupted.")
    assert secret not in visible
    assert (
        sanitizer.redacted
        and sanitizer.omitted_records == sanitizer.omitted_deltas == 0
    )


def copilot(kind, data=None, **envelope):
    return (
        json.dumps({"type": kind, "data": data or {}, **envelope}, ensure_ascii=False)
        + "\n"
    ).encode()


def copilot_stream():
    """Event shapes observed from Copilot CLI ``-p ... --output-format json``."""
    call = "call_shell"
    return b"".join(
        [
            copilot("session.mcp_server_status_changed", {"serverName": "x", "status": "pending"}, ephemeral=True),
            copilot("session.tools_updated", {"model": "fixture-model"}, ephemeral=True),
            copilot("user.message", {"content": "Your assigned issue ID is: 42", "transformedContent": "<private-context>"}),
            copilot("assistant.turn_start", {"turnId": "0"}),
            copilot("model.call_start", {"turnId": "0", "model": "fixture-model"}, ephemeral=True),
            copilot("assistant.reasoning_delta", {"reasoningId": "r1", "deltaContent": "Planning 雪 "}, ephemeral=True),
            copilot("assistant.reasoning_delta", {"reasoningId": "r1", "deltaContent": "the change"}, ephemeral=True),
            copilot("assistant.tool_call_delta", {"toolCallId": call, "inputDelta": "{"}, ephemeral=True),
            copilot("assistant.message", {"messageId": "m0", "content": "", "reasoningOpaque": "opaque-reasoning-blob",
                                          "toolRequests": [{"toolCallId": call, "name": "bash", "arguments": {"command": "pytest -q"}}]}),
            copilot("assistant.reasoning", {"reasoningId": "r1", "content": "Planning 雪 the change"}, ephemeral=True),
            copilot("tool.execution_start", {"toolCallId": call, "toolName": "bash", "arguments": {"command": "pytest -q", "description": "Run tests"}}),
            copilot("tool.execution_partial_result", {"toolCallId": call, "partialOutput": "collected 3\n"}, ephemeral=True),
            copilot("tool.execution_partial_result", {"toolCallId": call, "partialOutput": "collected 3\n3 passed\n"}, ephemeral=True),
            copilot("tool.execution_complete", {"toolCallId": call, "success": True, "shellExecution": {"exitCode": 0},
                                                "result": {"content": "collected 3\n3 passed\n<shellId: 0 completed>"}}),
            copilot("tool.execution_start", {"toolCallId": "call_view", "toolName": "view", "arguments": {"path": "/repo/src/api.py"}}),
            copilot("tool.execution_complete", {"toolCallId": "call_view", "success": True, "result": {"content": "secret-free file body"}}),
            copilot("assistant.turn_end", {"turnId": "0"}),
            copilot("assistant.message_start", {"messageId": "m1", "phase": "final_answer"}, ephemeral=True),
            copilot("assistant.message_delta", {"messageId": "m1", "deltaContent": "Implemented "}, ephemeral=True),
            copilot("assistant.message_delta", {"messageId": "m1", "deltaContent": "reset.\n"}, ephemeral=True),
            copilot("assistant.message", {"messageId": "m1", "content": "Implemented reset.\n", "toolRequests": []}),
            copilot("session.usage_checkpoint", {"totalPremiumRequests": 1, "modelCacheState": "internal-cache"}),
            copilot("assistant.idle", {}, ephemeral=True),
        ]
    ) + (json.dumps({"type": "result", "sessionId": "session-identity", "exitCode": 0,
                     "usage": {"premiumRequests": 0.33}}) + "\n").encode()


def test_copilot_progress_renders_work_without_duplicates_or_metadata():
    output = CopilotProgressMirror().feed(copilot_stream(), final=True).decode()
    assert "[Task] Your assigned issue ID is: 42" in output
    assert "[Turn] Working." in output
    assert output.count("Planning 雪 the change") == 1
    assert "[Command] pytest -q" in output
    # Partial output is cumulative upstream; each line is shown once.
    assert output.count("collected 3") == 1 and output.count("3 passed") == 1
    assert "[Command] Exit 0." in output
    assert "[Tool] view: /repo/src/api.py." in output
    assert "[Tool] view: completed." in output
    assert output.count("Implemented reset.") == 1
    assert "[Session] Completed; premium requests 0.33." in output
    for noise in ("private-context", "opaque-reasoning-blob", "internal-cache", "session-identity",
                  "secret-free file body", "toolCallId", "fixture-model", "mcp"):
        assert noise not in output


def test_copilot_projection_is_independent_of_utf8_and_record_chunk_boundaries():
    source = copilot_stream()
    expected = CopilotProgressMirror().feed(source, final=True)
    mirror = CopilotProgressMirror()
    actual = b"".join(
        mirror.feed(source[index : index + 1]) for index in range(len(source))
    ) + mirror.feed(b"", final=True)
    assert actual == expected


def test_copilot_failures_unknown_events_and_plain_text_remain_actionable():
    records = b"".join([
        b"plain startup diagnostic\n",
        copilot("tool.execution_start", {"toolCallId": "a", "toolName": "bash", "arguments": {"command": "make test"}}),
        copilot("tool.execution_complete", {"toolCallId": "a", "success": False, "error": {"message": "timed out"},
                                            "result": {"content": "partial log"}}),
        copilot("tool.execution_start", {"toolCallId": "b", "toolName": "edit", "arguments": {"path": "README.md"}}),
        copilot("tool.execution_complete", {"toolCallId": "b", "success": False, "error": {"message": "no match"}}),
        copilot("session.warning", {"message": "rate limited"}),
        copilot("session.error", {"message": "model unavailable"}),
        copilot("session.compaction_start", {}),
        copilot("session.compaction_start", {}),
        copilot("future.ephemeral", {"detail": "hidden"}, ephemeral=True),
        b"[1, 2]\n",
        b'{"type": 7}\n',
    ]) + (json.dumps({"type": "result", "exitCode": 1}) + "\n").encode()
    output = CopilotProgressMirror().feed(records, final=True).decode()
    assert "[Provider] plain startup diagnostic" in output
    assert "[Command] make test" in output
    assert output.count("partial log") == 1
    assert "[Command] Failed: timed out." in output
    assert "[Tool] edit: Failed: no match." in output
    assert "[Warning] rate limited" in output
    assert "[Error] model unavailable" in output
    assert output.count("[Provider] Event: session.compaction_start.") == 1
    assert "hidden" not in output
    assert "[View] Unrecognized structured provider record." in output
    assert "[View] Malformed structured provider event." in output
    assert "[Session] Ended with exit 1." in output


def test_copilot_non_cumulative_and_unbounded_output_stays_bounded():
    mirror = CopilotProgressMirror()
    mirror.feed(copilot("tool.execution_start", {"toolCallId": "c", "toolName": "bash", "arguments": {"command": "yes"}}))
    first = mirror.feed(copilot("tool.execution_partial_result", {"toolCallId": "c", "partialOutput": "alpha\n"})).decode()
    # A replacement that does not extend the shown text is displayed as new.
    second = mirror.feed(copilot("tool.execution_partial_result", {"toolCallId": "c", "partialOutput": "beta\n"})).decode()
    assert "alpha" in first and "beta" in second and "alpha" not in second
    huge = "x" * (MAX_ITEM_CHARS * 2)
    shown = mirror.feed(copilot("tool.execution_partial_result", {"toolCallId": "c", "partialOutput": "beta\n" + huge})).decode()
    assert shown.count("x") < MAX_ITEM_CHARS
    assert "Output shortened in this view." in shown
    for index in range(MAX_ITEMS + 5):
        mirror.feed(copilot("tool.execution_start", {"toolCallId": f"tool-{index}", "toolName": "view", "arguments": {}}))
    assert len(mirror.tools) <= MAX_ITEMS and len(mirror.items) <= MAX_ITEMS
