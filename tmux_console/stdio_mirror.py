"""Bounded display projections of qualified structured provider stdout.

Call only on already-redacted bytes. This never controls a provider, forwards
input, changes protocol bytes, or replaces the authoritative execution capture.
"""

from __future__ import annotations

import codecs
import hashlib
import json
from collections import OrderedDict
from typing import Any

MAX_RECORD_CHARS = 262144
MAX_ITEM_CHARS = 16384
MAX_ITEMS = 256

CODEX_MIRROR_FORMAT = "codex-app-server-v1"
COPILOT_MIRROR_FORMAT = "copilot-jsonl-v1"
MIRROR_FORMATS = frozenset({CODEX_MIRROR_FORMAT, COPILOT_MIRROR_FORMAT})


class _ProgressMirror:
    """JSONL records become progress text, with bounded display state."""

    record_limit = MAX_RECORD_CHARS

    def __init__(self) -> None:
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.pending = ""
        self.discarding = False
        self.items: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.notices: set[str] = set()
        self.notice_limit_reported = False
        self.active: str | None = None
        self.line_start = True

    def feed(self, payload: bytes, *, final: bool = False) -> bytes:
        text = self.decoder.decode(payload, final=final)
        output: list[str] = []
        for part in text.splitlines(keepends=True):
            complete = part.endswith("\n")
            if self.discarding:
                if complete:
                    self.discarding = False
                continue
            self.pending += part
            if len(self.pending) > self.record_limit:
                output.append(
                    self._line(
                        "View", "Structured record exceeds this view's size limit."
                    )
                )
                self.pending = ""
                self.discarding = not complete
            elif complete:
                output.append(self._safe_record(self.pending.rstrip("\r\n")))
                self.pending = ""
        if final:
            if self.pending:
                output.append(self._safe_record(self.pending))
                self.pending = ""
            if not self.line_start:
                output.append(self._emit("\n"))
        # JSON may decode escaped, unpaired surrogates; malformed display text
        # must not stop the provider relay or its independent wire capture.
        return "".join(output).encode("utf-8", errors="replace")

    def _emit(self, text: str) -> str:
        if text:
            self.line_start = text.endswith("\n")
        return text

    def _line(self, label: str, text: str) -> str:
        self.active = None
        return self._emit(("" if self.line_start else "\n") + f"[{label}] {text}\n")

    @staticmethod
    def _text(value: Any, limit: int = 1000) -> str:
        if isinstance(value, str):
            return value[:limit] + ("…" if len(value) > limit else "")
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            return _ProgressMirror._text(" ".join(value), limit)
        return ""

    def _item(self, value: Any) -> tuple[str, dict[str, Any]]:
        # Opaque reasoning item identities may themselves be enormous. Retain
        # only a fixed-size correlation hash, never print provider identities.
        identity = value if isinstance(value, str) else "unidentified-item"
        key = hashlib.sha256(identity.encode()).hexdigest()
        if key not in self.items:
            self.items[key] = {"streamed": False, "count": 0, "shortened": False}
        self.items.move_to_end(key)
        while len(self.items) > MAX_ITEMS:
            self.items.popitem(last=False)
        return key, self.items[key]

    def _delta(self, label: str, identity: Any, text: Any) -> str:
        if not isinstance(text, str) or not text:
            return ""
        key, item = self._item(identity)
        remaining = max(0, MAX_ITEM_CHARS - item["count"])
        shown = text[:remaining]
        result = ""
        if shown:
            if self.active != key:
                result += ("" if self.line_start else "\n") + f"[{label}] "
            result += shown
            self.active = key
            item["streamed"] = True
            item["count"] += len(shown)
            self._emit(result)
        if len(text) > remaining and not item["shortened"]:
            item["shortened"] = True
            result += self._line("View", "Output shortened in this view.")
        return result

    def _once(self, key: str, label: str, text: str) -> str:
        if key in self.notices:
            return ""
        if len(self.notices) >= MAX_ITEMS:
            if self.notice_limit_reported:
                return ""
            self.notice_limit_reported = True
            return self._line(
                "View", "Additional activity summaries omitted in this view."
            )
        self.notices.add(key)
        return self._line(label, text)

    def _safe_record(self, line: str) -> str:
        try:
            return self._record(line)
        except (ValueError, TypeError, KeyError, RecursionError):
            # The display projection must not terminate a correctly relayed
            # provider when an unfamiliar/malformed record cannot be rendered.
            return self._once(
                "malformed-record", "View", "Provider record could not be displayed."
            )

    def _record(self, line: str) -> str:
        raise NotImplementedError

    def _event(self, line: str) -> dict[str, Any] | str:
        """Return a decoded object, or the display text for a non-object line."""
        if not line.strip():
            return ""
        try:
            event = json.loads(line)
        except ValueError:
            # A qualified provider can still emit startup diagnostics/plain text.
            return self._line("Provider", self._text(line, 4000))
        if not isinstance(event, dict):
            return self._once(
                "invalid-record", "View", "Unrecognized structured provider record."
            )
        return event


class CodexProgressMirror(_ProgressMirror):
    """Codex app-server JSONL notifications become progress text."""

    def _record(self, line: str) -> str:
        event = self._event(line)
        if isinstance(event, str):
            return event
        method = event.get("method")
        if method is None:
            error = event.get("error")
            if isinstance(error, dict):
                return self._line(
                    "Error",
                    self._text(error.get("message")) or "Provider request failed.",
                )
            # Successful RPC responses carry IDs, configuration and thread data;
            # notifications supply the useful progress projection.
            if "id" in event and "result" in event:
                return ""
            return self._once(
                "unknown-record", "View", "Unrecognized structured provider record."
            )
        params = event.get("params", {})
        if not isinstance(method, str) or not isinstance(params, dict):
            return self._once(
                "invalid-envelope", "View", "Malformed structured provider event."
            )
        if method == "turn/started":
            self.items.clear()
            self.notices.clear()
            self.notice_limit_reported = False
            return self._line("Turn", "Working.")
        if method == "turn/completed":
            turn = params.get("turn", {})
            status = turn.get("status") if isinstance(turn, dict) else None
            if status is not None and not isinstance(status, str):
                raise TypeError("malformed turn status")
            label = {
                "completed": "Completed",
                "interrupted": "Interrupted",
                "failed": "Failed",
            }.get(status or "", "Ended with unreported status")
            result = self._line("Turn", label + ".")
            error = turn.get("error") if isinstance(turn, dict) else None
            if isinstance(error, dict) and error.get("message"):
                result += self._line("Error", self._text(error["message"]))
            return result
        if method == "muxpilot/capture/textFlush":
            source_method = params.get("sourceMethod")
            if not isinstance(source_method, str):
                raise TypeError("malformed capture source method")
            label = {
                "item/agentMessage/delta": "Agent",
                "item/reasoning/summaryTextDelta": "Progress",
                "item/commandExecution/outputDelta": "Output",
            }.get(source_method, "")
            if label:
                return self._delta(label, params.get("itemId"), params.get("delta"))
            return ""
        if method == "muxpilot/capture/omitted":
            reason = self._text(params.get("reason"))
            return self._line(
                "View",
                "Output omitted by credential filtering"
                + (": " + reason if reason else "")
                + ".",
            )
        if method == "item/agentMessage/delta":
            return self._delta("Agent", params.get("itemId"), params.get("delta"))
        if method == "item/reasoning/summaryTextDelta":
            return self._delta("Progress", params.get("itemId"), params.get("delta"))
        if method == "item/commandExecution/outputDelta":
            return self._delta("Output", params.get("itemId"), params.get("delta"))
        if method in {"item/started", "item/completed"}:
            return self._item_event(params, completed=method.endswith("completed"))
        if method in {"warning", "configWarning", "error"}:
            message = params.get("message") or params.get("summary")
            error = params.get("error")
            if not message and isinstance(error, dict):
                message = error.get("message")
            return self._line(
                "Error" if method == "error" else "Warning",
                self._text(message) or "Provider reported a warning or error.",
            )
        if method in {
            "thread/started",
            "thread/name/updated",
            "thread/status/changed",
            "thread/tokenUsage/updated",
            "account/rateLimits/updated",
            "remoteControl/status/changed",
            "turn/diff/updated",
            "item/reasoning/textDelta",
            "item/reasoning/summaryPartAdded",
        }:
            return ""
        if method == "turn/plan/updated":
            plan = params.get("plan")
            if isinstance(plan, list):
                lines = [
                    self._text(step.get("step"))
                    for step in plan[:20]
                    if isinstance(step, dict)
                ]
                lines = [line for line in lines if line]
                return self._line("Plan", "; ".join(lines)[:2000]) if lines else ""
        # Do not dump unknown opaque payloads, and do not invent their meaning.
        return self._once(
            "event:" + method[:120],
            "Provider",
            "Event: " + self._text(method, 120) + ".",
        )

    def _item_event(self, params: dict[str, Any], *, completed: bool) -> str:
        item = params.get("item")
        if not isinstance(item, dict):
            return self._once("invalid-item", "View", "Malformed provider item.")
        kind = item.get("type")
        key, state = self._item(item.get("id"))
        if kind == "agentMessage":
            if completed and not state["streamed"]:
                return self._delta("Agent", item.get("id"), item.get("text"))
            return ""
        if kind == "reasoning":
            return (
                ""
                if completed
                else self._once("thinking:" + key, "Progress", "Thinking.")
            )
        if kind == "commandExecution":
            if not completed:
                command = self._text(item.get("command"), 1000)
                return self._line("Command", command or "Running a command.")
            result = ""
            if not state["streamed"] and item.get("aggregatedOutput"):
                result += self._delta(
                    "Output", item.get("id"), item["aggregatedOutput"]
                )
            status, code = item.get("status"), item.get("exitCode")
            detail = (
                f"Exit {code}"
                if isinstance(code, int) and not isinstance(code, bool)
                else self._text(status) or "Ended with unreported status"
            )
            return result + self._line("Command", detail + ".")
        if kind == "fileChange":
            changes = item.get("changes", [])
            paths = (
                [
                    self._text(change.get("path"), 200)
                    for change in changes[:12]
                    if isinstance(change, dict)
                ]
                if isinstance(changes, list)
                else []
            )
            status = self._text(item.get("status")) if completed else "Editing"
            return self._line(
                "Files",
                (status or "Ended with unreported status")
                + (": " + ", ".join(path for path in paths if path) if paths else "")
                + ".",
            )
        if kind == "mcpToolCall":
            name = self._text(item.get("tool")) or "Provider tool"
            status = self._text(item.get("status")) if completed else "Running"
            error = item.get("error")
            result = self._line(
                "Tool", name + ": " + (status or "Ended with unreported status") + "."
            )
            if isinstance(error, dict) and error.get("message"):
                result += self._line("Error", self._text(error["message"]))
            return result
        if kind == "userMessage":
            return ""  # do not echo the entire worker brief into its observation pane
        if kind == "contextCompaction":
            return self._line(
                "Progress", "Context compacted." if completed else "Compacting context."
            )
        return self._once(
            "item:" + str(kind)[:120],
            "Provider",
            "Activity: " + self._text(kind, 120) + ".",
        )


class CopilotProgressMirror(_ProgressMirror):
    """GitHub Copilot CLI ``--output-format json`` events become progress text.

    Partial tool output is cumulative upstream; only its unseen suffix is shown.
    Records describing transport, usage accounting, MCP status, or opaque
    reasoning state are silent. Unknown durable events are summarized once.
    """

    # Tool results and opaque reasoning payloads can legitimately be large.
    record_limit = 4 * MAX_RECORD_CHARS
    SHELL_TOOLS = frozenset({"bash", "shell", "powershell"})
    QUIET = frozenset({
        "assistant.idle",
        "assistant.message_start",
        "assistant.tool_call_delta",
        "assistant.turn_end",
        "assistant.usage",
        "model.call_finished",
        "model.call_final_result",
        "model.call_start",
        "session.background_tasks_changed",
        "session.info",
        "session.mcp_server_status_changed",
        "session.mcp_servers_loaded",
        "session.shutdown",
        "session.tools_updated",
        "session.usage_checkpoint",
    })

    def __init__(self) -> None:
        super().__init__()
        self.tools: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def _tool(self, value: Any) -> dict[str, Any]:
        identity = value if isinstance(value, str) else "unidentified-tool"
        key = hashlib.sha256(identity.encode()).hexdigest()
        if key not in self.tools:
            self.tools[key] = {"name": "", "seen": 0, "tail": "", "shell": False}
        self.tools.move_to_end(key)
        while len(self.tools) > MAX_ITEMS:
            self.tools.popitem(last=False)
        return self.tools[key]

    def _record(self, line: str) -> str:
        event = self._event(line)
        if isinstance(event, str):
            return event
        kind = event.get("type")
        data = event.get("data", {})
        if not isinstance(kind, str) or not isinstance(data, dict):
            return self._once(
                "invalid-envelope", "View", "Malformed structured provider event."
            )
        if kind == "session.start":
            model = self._text(data.get("selectedModel"), 120)
            return self._line("Session", "Started" + (f" with {model}" if model else "") + ".")
        if kind == "user.message":
            prompt = self._text(data.get("content"), 1200)
            return self._line("Task", prompt) if prompt else ""
        if kind == "assistant.turn_start":
            return self._line("Turn", "Working.")
        if kind == "assistant.message_delta":
            return self._delta("Agent", data.get("messageId"), data.get("deltaContent"))
        if kind == "assistant.message":
            _key, state = self._item(data.get("messageId"))
            if not state["streamed"]:
                return self._delta("Agent", data.get("messageId"), data.get("content"))
            return ""
        if kind == "assistant.reasoning_delta":
            return self._delta("Progress", data.get("reasoningId"), data.get("deltaContent"))
        if kind == "assistant.reasoning":
            _key, state = self._item(data.get("reasoningId"))
            if not state["streamed"]:
                return self._delta("Progress", data.get("reasoningId"), data.get("content"))
            return ""
        if kind == "tool.execution_start":
            return self._tool_start(data)
        if kind == "tool.execution_partial_result":
            return self._tool_output(data.get("toolCallId"), data.get("partialOutput"))
        if kind == "tool.execution_complete":
            return self._tool_complete(data)
        if kind in {"session.warning", "session.error"}:
            message = data.get("message")
            error = data.get("error")
            if not message and isinstance(error, dict):
                message = error.get("message")
            return self._line(
                "Error" if kind == "session.error" else "Warning",
                self._text(message) or "Provider reported a warning or error.",
            )
        if kind == "result":
            return self._result(event)
        if kind in self.QUIET or event.get("ephemeral") is True:
            return ""
        # Do not dump unknown opaque payloads, and do not invent their meaning.
        return self._once(
            "event:" + kind[:120], "Provider", "Event: " + self._text(kind, 120) + "."
        )

    def _tool_start(self, data: dict[str, Any]) -> str:
        state = self._tool(data.get("toolCallId"))
        name = self._text(data.get("toolName"), 120) or "tool"
        arguments = data.get("arguments")
        arguments = arguments if isinstance(arguments, dict) else {}
        state["name"], state["shell"] = name, name in self.SHELL_TOOLS
        if state["shell"]:
            command = self._text(arguments.get("command"), 1000)
            return self._line("Command", command or "Running a command.")
        detail = (
            self._text(arguments.get("path"), 300)
            or self._text(arguments.get("pattern"), 300)
            or self._text(data.get("toolTitle"), 300)
            or self._text(arguments.get("description"), 300)
        )
        return self._line("Tool", name + (": " + detail if detail else "") + ".")

    def _tool_output(self, identity: Any, output: Any) -> str:
        if not isinstance(output, str) or not output:
            return ""
        state = self._tool(identity)
        seen, tail = state["seen"], state["tail"]
        if seen and len(output) >= seen and output[max(0, seen - len(tail)):seen] == tail:
            fresh = output[seen:]
        else:
            # Not an extension of the text already shown: display it as new.
            fresh = output
        state["seen"], state["tail"] = len(output), output[-64:]
        return self._delta("Output", identity, fresh)

    def _tool_complete(self, data: dict[str, Any]) -> str:
        identity = data.get("toolCallId")
        state = self._tool(identity)
        name = state["name"] or "tool"
        result = data.get("result")
        result = result if isinstance(result, dict) else {}
        error = data.get("error")
        output = ""
        _key, item = self._item(identity)
        if state["shell"] and not item["streamed"]:
            output = self._delta("Output", identity, result.get("content"))
        if data.get("success") is not True:
            message = self._text(error.get("message")) if isinstance(error, dict) else ""
            return output + self._line(
                "Command" if state["shell"] else "Tool",
                (name + ": " if not state["shell"] else "")
                + "Failed"
                + (": " + message if message else "")
                + ".",
            )
        if state["shell"]:
            shell = data.get("shellExecution")
            code = shell.get("exitCode") if isinstance(shell, dict) else None
            detail = (
                f"Exit {code}"
                if isinstance(code, int) and not isinstance(code, bool)
                else "Completed"
            )
            return output + self._line("Command", detail + ".")
        return output + self._line("Tool", name + ": completed.")

    def _result(self, event: dict[str, Any]) -> str:
        code = event.get("exitCode")
        outcome = (
            ("Completed" if code == 0 else f"Ended with exit {code}")
            if isinstance(code, int) and not isinstance(code, bool)
            else "Ended with unreported status"
        )
        usage = event.get("usage")
        premium = usage.get("premiumRequests") if isinstance(usage, dict) else None
        if isinstance(premium, (int, float)) and not isinstance(premium, bool):
            outcome += f"; premium requests {premium:g}"
        return self._line("Session", outcome + ".")
