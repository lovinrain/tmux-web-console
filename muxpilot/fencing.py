"""Same-host receiver fencing for project-owned Muxdeck terminal operations.

The coordinator journal is the authority. Its write transaction stays open
through the actual receiver effect, so a takeover cannot commit while an old
operation executes. SQLite waits and lock ownership run in a worker thread;
the normal asynchronous handler runs on its original event loop. Receiver
intent commits before dispatch: a lost receipt is uncertain, never blindly
replayed. This is a trusted same-user boundary, not hostile-process isolation.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import web

from .store import (
    JournalStore,
    LeaseError,
    StoreError,
    _atomic_file,
    _private_file,
    default_state_root,
)


class FenceError(RuntimeError):
    """A request cannot safely execute; messages never contain request content."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ReceiverContext:
    project_id: str
    owner: str
    generation: int
    operation_id: str

    @classmethod
    def parse(cls, payload: Any) -> ReceiverContext:
        if not isinstance(payload, dict) or set(payload) != {"projectId", "owner", "generation", "operationId"}:
            raise FenceError("managed operation requires projectId, owner, generation and operationId", 400)
        try:
            project = str(uuid.UUID(payload["projectId"]))
            operation = str(uuid.UUID(payload["operationId"]))
        except (ValueError, TypeError, AttributeError):
            raise FenceError("managed project and operation identities must be UUIDs", 400) from None
        owner, generation = payload["owner"], payload["generation"]
        if not isinstance(owner, str) or not owner or len(owner) > 256 or any(ord(char) < 32 for char in owner):
            raise FenceError("managed coordinator owner is invalid", 400)
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            raise FenceError("managed coordinator generation must be positive", 400)
        return cls(project, owner, generation, operation)


def managed_name(name: Any) -> bool:
    return isinstance(name, str) and name.startswith(("mxp-", "muxpilot-"))


class FencedReceiver:
    def __init__(self, state_root: Path | str | None = None):
        self.state_root = Path(state_root or os.environ.get("MUXPILOT_STATE_ROOT") or default_state_root()).expanduser().absolute()

    def _binding_path(self, name: str, kind: str = "sessions") -> Path:
        digest = hashlib.sha256(name.encode()).hexdigest()
        return self.state_root / ("receiver-" + kind) / (digest + ".json")

    def binding(self, name: str, kind: str = "sessions") -> dict[str, Any] | None:
        path = self._binding_path(name, kind)
        try:
            _private_file(path)
            value = json.loads(path.read_text())
            if value.get("session" if kind == "sessions" else "workspaceId") != name:
                raise StoreError("managed session binding is unavailable")
            return value
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError) as error:
            raise StoreError("managed session binding is unavailable") from error

    def bind(self, context: ReceiverContext, receipt: dict[str, Any]) -> None:
        fields = ("sessionId", "sessionCreated", "serverStarted", "serverPid")
        if not isinstance(receipt.get("session"), str) or any(key not in receipt for key in fields):
            raise StoreError("managed launch did not return an exact session identity")
        value = {"projectId": context.project_id, "session": receipt["session"],
                 "identity": {key: receipt[key] for key in fields}, "operationId": context.operation_id}
        _atomic_file(self._binding_path(value["session"]), json.dumps(value, sort_keys=True).encode())

    def bind_workspace(self, context: ReceiverContext, receipt: dict[str, Any]) -> None:
        workspace = receipt.get("workspace")
        if not isinstance(workspace, dict) or not isinstance(workspace.get("id"), str):
            raise StoreError("managed workspace did not return an exact identity")
        value = {"projectId": context.project_id, "workspaceId": workspace["id"],
                 "operationId": context.operation_id}
        _atomic_file(self._binding_path(workspace["id"], "workspaces"), json.dumps(value, sort_keys=True).encode())

    async def execute(self, context: ReceiverContext, action: str, intent: dict[str, Any],
                      effect: Callable[[], Coroutine[Any, Any, dict[str, Any]]],
                      persist_binding: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        """Execute once, with immutable intent and a durable uncertainty marker.

        The callback must not write this project's JournalStore while the
        authority transaction is held. Do not impose a timeout that releases
        the fence while the callback could still execute: receiver commands
        themselves must be bounded and cancellation retains the worker guard.
        """
        loop = asyncio.get_running_loop()
        fingerprint = hashlib.sha256(json.dumps({"action": action, "intent": intent,
            "owner": context.owner, "generation": context.generation}, sort_keys=True,
            separators=(",", ":"), allow_nan=False).encode()).hexdigest()

        def invoke() -> dict[str, Any]:
            # Opening an absent authority must fail closed, never create a new
            # journal whose identity was chosen by an incoming HTTP request.
            authority = self.state_root / context.project_id / "journal.sqlite3"
            try:
                _private_file(authority)
            except (OSError, StoreError) as error:
                raise FenceError("managed project authority is unavailable", 503) from error
            with JournalStore(self.state_root, context.project_id) as store:
                with store.transaction() as db:
                    store._assert_lease(db, context.owner, context.generation)
                    db.execute("CREATE TABLE IF NOT EXISTS receiver_operations (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT)")
                    row = db.execute("SELECT * FROM receiver_operations WHERE operation_id=?", (context.operation_id,)).fetchone()
                    if row:
                        if row["fingerprint"] != fingerprint:
                            raise FenceError("managed operation identity has different intent")
                        if row["state"] == "confirmed":
                            return json.loads(row["receipt"])
                        raise FenceError("managed operation outcome is uncertain; reconcile before retrying")
                    db.execute("INSERT INTO receiver_operations VALUES (?,?,'uncertain',NULL)", (context.operation_id, fingerprint))
                    store._event(db, "receiver.prepared", {"action": action, "intent_sha256": fingerprint},
                                 actor=context.owner, generation=context.generation, operation_id=context.operation_id)
                with store.transaction() as db:
                    store._assert_lease(db, context.owner, context.generation)
                    # Schedule only after execution-time authority validation.
                    # Waiting here is off the event loop. The SQLite lock remains
                    # held until the coroutine, including the effect, completes.
                    result: dict[str, Any] = asyncio.run_coroutine_threadsafe(effect(), loop).result()
                    if persist_binding is not None:
                        persist_binding(result)
                    safe_result = store.sanitize(result)
                    db.execute("UPDATE receiver_operations SET state='confirmed',receipt=? WHERE operation_id=?",
                               (json.dumps(safe_result, sort_keys=True), context.operation_id))
                    store._event(db, "receiver.confirmed", {"action": action, "receipt": safe_result},
                                 actor=context.owner, generation=context.generation, operation_id=context.operation_id)
                    return safe_result

        try:
            return await asyncio.to_thread(invoke)
        except LeaseError as error:
            raise FenceError("managed coordinator authority is stale or expired") from error
        except StoreError as error:
            raise FenceError("managed project authority is unavailable", 503) from error

    async def receipt(self, project_id: str, operation_id: str) -> dict[str, Any] | None:
        """Read retained evidence without granting permission to repeat an effect."""
        project_id, operation_id = str(uuid.UUID(project_id)), str(uuid.UUID(operation_id))
        def read() -> dict[str, Any] | None:
            _private_file(self.state_root / project_id / "journal.sqlite3")
            with JournalStore(self.state_root, project_id) as store, store.transaction() as db:
                if not db.execute("SELECT 1 FROM sqlite_master WHERE name='receiver_operations'").fetchone():
                    return None
                row = db.execute("SELECT state,receipt FROM receiver_operations WHERE operation_id=?", (operation_id,)).fetchone()
                return {"operationId": operation_id, "state": row["state"],
                        "receipt": json.loads(row["receipt"]) if row["receipt"] else None} if row else None
        return await asyncio.to_thread(read)


def receiver_middleware(prefix: str, receiver: FencedReceiver | None = None) -> Any:
    receiver = receiver or FencedReceiver()
    launch_path = prefix + "/api/sessions"
    rename_path = prefix + "/api/session-name"
    workspace_path = prefix + "/api/workspaces"

    @web.middleware
    async def middleware(request: web.Request, handler: Any) -> web.StreamResponse:
        launch = request.method == "POST" and request.path == launch_path
        rename = request.method == "PUT" and request.path == rename_path
        session = request.match_info.get("session")
        copying = session is not None and request.method == "POST" and request.path.endswith("/copy")
        control = session is not None and (
            (request.method == "POST" and request.path.endswith("/input")) or
            (request.method == "DELETE" and request.path == launch_path + "/" + session)
        )
        workspace_create = request.method == "POST" and request.path == workspace_path
        workspace_mutation = request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.path.startswith(workspace_path + "/")
        if not (launch or rename or control or copying or workspace_create or workspace_mutation):
            return await handler(request)
        try:
            workspace_id = request.match_info.get("workspace_id")
            workspace_binding = await asyncio.to_thread(receiver.binding, workspace_id, "workspaces") if workspace_id else None
            binding = await asyncio.to_thread(receiver.binding, session) if session else None
            known_managed = managed_name(session) or binding is not None or workspace_binding is not None
            try:
                payload = await request.json()
            except (ValueError, TypeError, RecursionError):
                if known_managed:
                    raise FenceError("managed operation requires a JSON authority envelope", 400) from None
                return await handler(request)
            if not isinstance(payload, dict):
                if known_managed:
                    raise FenceError("managed operation requires a JSON authority envelope", 400)
                return await handler(request)
            name = payload.get("name") if launch else (payload.get("session") if rename else session)
            if rename and isinstance(name, str):
                binding = await asyncio.to_thread(receiver.binding, name)
            environment = payload.get("environment")
            flagged_environment = isinstance(environment, dict) and any(key.startswith("MUXPILOT_") for key in environment)
            managed_tabs = workspace_create and isinstance(payload.get("tabs"), list) and any(managed_name(tab) for tab in payload["tabs"])
            managed = "muxpilot" in payload or managed_name(name) or binding is not None or workspace_binding is not None or managed_tabs or (launch and flagged_environment)
            if not managed:
                return await handler(request)
            context = ReceiverContext.parse(payload.get("muxpilot"))
            if launch and not managed_name(name):
                raise FenceError("managed launch requires a reserved project session name", 400)
            if binding and binding["projectId"] != context.project_id:
                raise FenceError("managed session belongs to another project")
            if (rename or control or copying) and not binding:
                raise FenceError("managed session ownership is unavailable", 503)
            if workspace_binding and workspace_binding["projectId"] != context.project_id:
                raise FenceError("managed workspace belongs to another project")
            if workspace_mutation and not workspace_binding:
                raise FenceError("managed workspace ownership is unavailable", 503)
            if rename and not managed_name(payload.get("name")):
                raise FenceError("managed rename requires a reserved project session name", 400)
            intent = {key: value for key, value in payload.items() if key != "muxpilot"}
            # The existing handler retains its own validation and exact native
            # incarnation checks. Remove only our envelope from its JSON body.
            request._read_bytes = json.dumps(intent).encode()

            async def effect() -> dict[str, Any]:
                response = await handler(request)
                if not isinstance(response, web.Response) or (response.body is not None and not isinstance(response.body, (bytes, bytearray))):
                    raise FenceError("managed receiver returned an unsupported receipt", 503)
                result = json.loads(response.body) if response.body else {}
                if response.status >= 400:
                    # tmux diagnostics can include launch commands or environment.
                    result = {"error": "managed receiver operation failed", "retryable": False,
                              "delivery": "uncertain" if response.status >= 500 else "rejected"}
                return {"status": response.status, "body": result}

            def persist_binding(result: dict[str, Any]) -> None:
                if result["status"] >= 300:
                    return
                if launch or copying:
                    receiver.bind(context, result["body"])
                elif workspace_create:
                    receiver.bind_workspace(context, result["body"])
                elif rename and binding:
                    renamed = {**binding, "session": intent["name"]}
                    _atomic_file(receiver._binding_path(intent["name"]), json.dumps(renamed).encode())

            result = await receiver.execute(context, request.method + " " + request.path, intent, effect, persist_binding)
            return web.json_response(result["body"], status=result["status"], headers={"Cache-Control": "no-store"})
        except FenceError as error:
            return web.json_response({"error": str(error), "retryable": False}, status=error.status)
        except StoreError:
            return web.json_response({"error": "managed session authority is unavailable", "retryable": False}, status=503)

    return middleware
