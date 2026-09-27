"""Visible conversation records from native agent storage, never model context."""
from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Any

MAX_MESSAGE_BYTES = 256 * 1024


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind in {"text", "input_text", "output_text"} and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif kind in {"image", "image_url", "input_image"}:
            parts.append("[Image attachment]")
        elif kind in {"document", "input_file", "file"}:
            parts.append("[File attachment]")
    return "\n\n".join(parts)


def _argument(value: object) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _tool(name: object, value: object) -> str:
    return f"Tool: {name if isinstance(name, str) else 'result'}\n{_argument(value)}".rstrip()


def _timestamp(value: object) -> int | None:
    try:
        if isinstance(value, str):
            number = datetime.fromisoformat(value).timestamp() * 1000
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            number = value if value > 100_000_000_000 else value * 1000
        else:
            return None
        return int(number) if math.isfinite(number) and 0 <= number <= 8_640_000_000_000_000 else None
    except (ValueError, OverflowError, OSError):
        return None


def visible_message(agent: str, record: dict[str, Any]) -> dict[str, Any] | None:
    """One entry per native record; duplicate Codex event notifications are ignored.

    Thinking, encrypted reasoning, system/developer instructions, provider
    metadata, and embedded image bytes are deliberately not rendered.
    """
    role: str | None = None
    text = ""
    tools: list[str] = []
    timestamp = _timestamp(record.get("timestamp", record.get("ts")))
    if agent == "codex":
        if record.get("type") != "response_item":
            return None
        payload = record.get("payload")
        if not isinstance(payload, dict):
            return None
        kind = payload.get("type")
        if kind == "message":
            if payload.get("role") not in {"user", "assistant"} or payload.get("channel") == "analysis":
                return None
            role = payload["role"]
            text = _text(payload.get("content"))
        elif kind in {"function_call", "custom_tool_call"}:
            role = "tool"
            text = _tool(payload.get("name"), payload.get("arguments", payload.get("input")))
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            role = "tool"
            text = _text(payload.get("output"))
    elif agent == "claude":
        if record.get("type") not in {"user", "assistant"} or record.get("isSidechain"):
            return None
        message = record.get("message")
        if not isinstance(message, dict):
            return None
        role = message.get("role")
        content = message.get("content")
        text = _text(content)
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tools.append(_tool(block.get("name"), block.get("input")))
                elif block.get("type") == "tool_result":
                    tools.append(_text(block.get("content")))
    elif agent == "copilot":
        data = record.get("data")
        if not isinstance(data, dict):
            return None
        kind = record.get("type")
        if kind in {"user.message", "assistant.message"}:
            role = "user" if kind == "user.message" else "assistant"
            text = _text(data.get("content"))
            if kind == "user.message" and data.get("attachments"):
                text += "\n\n[Attachments]"
            for tool in data.get("toolRequests", []) if isinstance(data.get("toolRequests"), list) else []:
                if isinstance(tool, dict):
                    tools.append(_tool(tool.get("name"), tool.get("arguments")))
        elif kind == "tool.execution_start":
            role = "tool"
            text = _tool(data.get("toolName"), data.get("arguments"))
        elif kind == "tool.execution_complete":
            role = "tool"
            result = data.get("result")
            text = _text(result.get("content")) if isinstance(result, dict) else _text(result)
    elif agent == "cursor":
        role = record.get("role")
        options = record.get("providerOptions")
        cursor = options.get("cursor") if isinstance(options, dict) else None
        # Cursor stores its generated environment/context as a user-role blob.
        if isinstance(cursor, dict) and "requestContextCompleteness" in cursor:
            return None
        content = record.get("content")
        text = _text(content)
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool-call":
                    tools.append(_tool(block.get("toolName"), block.get("args")))
                elif block.get("type") == "tool-result":
                    result = block.get("result")
                    tools.append(_tool(block.get("toolName"), result))
    elif agent == "grok":
        role = record.get("type")
        if role == "tool_result":
            role = "tool"
        text = _text(record.get("content"))
        for tool in record.get("tool_calls", []) if isinstance(record.get("tool_calls"), list) else []:
            if isinstance(tool, dict):
                tools.append(_tool(tool.get("name"), tool.get("arguments")))
    if role not in {"user", "assistant", "tool"}:
        return None
    if tools:
        if not text.strip():
            role = "tool"
        text = "\n\n".join(part for part in [text, *tools] if part)
    if not text.strip():
        return None
    encoded = text.encode("utf-8", errors="replace")
    return {
        "role": role,
        "text": encoded[:MAX_MESSAGE_BYTES].decode("utf-8", errors="ignore"),
        "timestamp": timestamp,
        "truncated": len(encoded) > MAX_MESSAGE_BYTES,
    }
