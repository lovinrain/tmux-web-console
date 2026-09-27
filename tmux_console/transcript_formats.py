"""Visible conversation records from native agent storage, never model reasoning."""
from __future__ import annotations

import json
import math
import re
from datetime import datetime
from typing import Any

MAX_MESSAGE_BYTES = 256 * 1024
CONVERSATION_KINDS = {"prompt", "response"}
_CONTEXT_BLOCK = re.compile(r"\s*<(environment_context|user_info)>[\s\S]*</\1>\s*")
_USER_QUERY = re.compile(r"\s*<user_query>([\s\S]*?)</user_query>\s*")


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


def _user_text(content: object, agent: str) -> tuple[str, str]:
    """Separate known injected blocks, preserving real input in mixed records."""
    parts = [_text([block]) for block in content] if isinstance(content, list) else [_text(content)]
    prompts: list[str] = []
    context: list[str] = []
    for text in parts:
        stripped = text.strip()
        generated = bool(_CONTEXT_BLOCK.fullmatch(text)) or (
            agent == "codex" and stripped.startswith("# AGENTS.md instructions for ")
            and "<INSTRUCTIONS>" in stripped and stripped.endswith("</INSTRUCTIONS>")
        )
        if generated:
            context.append(text)
        elif text:
            query = _USER_QUERY.fullmatch(text) if agent in {"cursor", "grok"} else None
            prompts.append(query[1].strip() if query else text)
    return "\n\n".join(prompts), "\n\n".join(context)


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


def _entry(role: str, kind: str, text: str, timestamp: int | None) -> dict[str, Any]:
    encoded = text.encode("utf-8", errors="replace")
    return {"role": role, "kind": kind,
            "text": encoded[:MAX_MESSAGE_BYTES].decode("utf-8", errors="ignore"),
            "timestamp": timestamp, "truncated": len(encoded) > MAX_MESSAGE_BYTES}


def visible_messages(agent: str, record: dict[str, Any]) -> list[dict[str, Any]]:
    """Split visible text and tools; never treat tool results as user prompts.

    Native completion markers distinguish replies from progress. Where a format
    lacks them, text accompanying a tool call is progress and other assistant
    text stays visible. Do not guess from wording or discard unmarked answers.
    Duplicate Codex events and hidden reasoning are never rendered.
    """
    role: str | None = None
    text = context = ""
    tools: list[str] = []
    phase: object = None
    stop: object = None
    timestamp = _timestamp(record.get("timestamp", record.get("ts")))
    if agent == "codex":
        if record.get("type") != "response_item":
            return []
        payload = record.get("payload")
        if not isinstance(payload, dict):
            return []
        kind = payload.get("type")
        if kind == "message":
            phase = payload.get("phase") or payload.get("channel")
            phase = phase if isinstance(phase, str) else None
            if payload.get("role") not in {"user", "assistant"} or payload.get("channel") == "analysis" or phase in {"analysis", "reasoning"}:
                return []
            role = payload["role"]
            if role == "user":
                text, context = _user_text(payload.get("content"), agent)
            else:
                text = _text(payload.get("content"))
        elif kind in {"function_call", "custom_tool_call"}:
            role = "tool"
            text = _tool(payload.get("name"), payload.get("arguments", payload.get("input")))
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            role = "tool"
            text = _text(payload.get("output"))
    elif agent == "claude":
        if record.get("type") not in {"user", "assistant"} or record.get("isSidechain"):
            return []
        message = record.get("message")
        if not isinstance(message, dict):
            return []
        role = message.get("role")
        content = message.get("content")
        text = _text(content)
        stop = message.get("stop_reason")
        if role == "user" and (record.get("isMeta") or record.get("isCompactSummary")):
            context, text = text, ""
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
            return []
        kind = record.get("type")
        if kind in {"user.message", "assistant.message"}:
            role = "user" if kind == "user.message" else "assistant"
            text = _text(data.get("content"))
            phase = data.get("phase")
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
        if isinstance(cursor, dict) and "requestContextCompleteness" in cursor:
            return []
        content = record.get("content")
        text, context = _user_text(content, agent) if role == "user" else (_text(content), "")
        phase = record.get("phase")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool-call":
                    tools.append(_tool(block.get("toolName"), block.get("args")))
                elif block.get("type") == "tool-result":
                    tools.append(_tool(block.get("toolName"), block.get("result")))
    elif agent == "grok":
        role = record.get("type")
        if role == "tool_result":
            role = "tool"
        content = record.get("content")
        text, context = _user_text(content, agent) if role == "user" else (_text(content), "")
        if role == "user" and record.get("synthetic_reason"):
            context, text = "\n\n".join(part for part in [context, text] if part), ""
        phase = record.get("phase")
        for tool in record.get("tool_calls", []) if isinstance(record.get("tool_calls"), list) else []:
            if isinstance(tool, dict):
                function = tool.get("function")
                if not isinstance(function, dict):
                    function = tool
                tools.append(_tool(function.get("name"), function.get("arguments")))
    if role not in {"user", "assistant", "tool"}:
        return []
    phase = phase if isinstance(phase, str) else None
    if role == "assistant" and phase in {"analysis", "reasoning"}:
        return []
    kind = "prompt" if role == "user" else "tool" if role == "tool" else "response"
    if role == "assistant" and (phase in {"commentary", "progress"}
                                or phase not in {"final", "final_answer"} and (stop == "tool_use" or tools)):
        kind = "progress"
    entries = []
    if context.strip():
        entries.append(_entry("user", "context", context, timestamp))
    if text.strip():
        entries.append(_entry(role, kind, text, timestamp))
    tool_text = "\n\n".join(part for part in tools if part.strip())
    if tool_text:
        entries.append(_entry("tool", "tool", tool_text, timestamp))
    return entries
