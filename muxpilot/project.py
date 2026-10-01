"""Project registry and fenced tools used by the ordinary main conversation.

This module never runs a scheduling loop. Stage/task truth and worker dispatch
remain in Multica; local SQLite owns intent, recovery and audit evidence.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from tmux_console.control_cli import ControlClient, ControlError, _record_identity

from .config import Config, private_directory, private_read, private_write
from .integration import Integrator, canonical_repository, git
from .multica import MulticaClient, MulticaError
from .store import JournalStore

ACTIVE_RUN_STATUSES = frozenset(
    {
        "queued",
        "dispatched",
        "running",
        "waiting_local_directory",
        "deferred",
        "pending",
        "waiting",
    }
)


class ProjectError(ValueError):
    code = "rejected"


class AuthorizationError(ProjectError):
    code = "unauthorized"


class ProjectRegistry:
    """Private canonical-checkout registry; UUIDs survive editable project names."""

    def __init__(self, state_root: Path):
        self.root = private_directory(state_root)
        self.path = self.root / "registry.json"
        self._mutex = threading.RLock()

    @contextmanager
    def lock(self, identity: str = "registry") -> Iterator[None]:
        if identity != "registry":
            identity = str(uuid.UUID(identity))
        with self._mutex:
            descriptor = os.open(
                self.root / (identity + ".lock"),
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                0o600,
            )
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def records(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        document = json.loads(private_read(self.path))
        if document.get("schema_version") != 1 or not isinstance(
            document.get("projects"), list
        ):
            raise ProjectError("unsupported or corrupt project registry")
        return document["projects"]  # type: ignore[no-any-return]

    def resolve(self, reference: str) -> dict[str, Any]:
        candidates = [
            item
            for item in self.records()
            if reference in {item["project_id"], item["repo_root"], item["name"]}
        ]
        if not candidates:
            try:
                path = str(canonical_repository(reference))
            except (OSError, RuntimeError):
                path = ""
            candidates = [item for item in self.records() if item["repo_root"] == path]
        if len(candidates) != 1:
            raise ProjectError(
                "project is unknown or ambiguous; supply its UUID or canonical repository"
            )
        return candidates[0]

    def get_or_create(
        self, repo: Path, name: str, project_id: str | None = None
    ) -> tuple[dict[str, Any], bool]:
        with self.lock():
            records = self.records()
            existing = next(
                (item for item in records if item["repo_root"] == str(repo)), None
            )
            if existing:
                return existing, False
            identifier = str(uuid.UUID(project_id)) if project_id else str(uuid.uuid4())
            if any(item["project_id"] == identifier for item in records):
                raise ProjectError(
                    "configured backend project is already bound to another checkout; remap explicitly"
                )
            record = {
                "project_id": identifier,
                "repo_root": str(repo),
                "name": name,
                "created_at": time.time(),
            }
            records.append(record)
            private_write(
                self.path,
                json.dumps({"schema_version": 1, "projects": records}, sort_keys=True),
            )
            return record, True

    def put_record(self, record: dict[str, Any]) -> None:
        with self.lock():
            records = self.records()
            if any(
                item["project_id"] != record["project_id"]
                and item["repo_root"] == record["repo_root"]
                for item in records
            ):
                raise ProjectError(
                    "repository is already associated with another project"
                )
            records = [
                item for item in records if item["project_id"] != record["project_id"]
            ]
            records.append(record)
            private_write(
                self.path,
                json.dumps({"schema_version": 1, "projects": records}, sort_keys=True),
            )


class ProjectController:
    def __init__(
        self,
        config: Config,
        *,
        multica_factory: Callable[..., Any] = MulticaClient,
        muxdeck_factory: Callable[..., Any] = ControlClient,
    ):
        self.config, self.registry = config, ProjectRegistry(config.state_root)
        self.multica_factory, self.muxdeck_factory = multica_factory, muxdeck_factory
        bootstrap_path = config.state_root / "control.key"
        with self.registry.lock():
            if not bootstrap_path.exists():
                private_write(bootstrap_path, secrets.token_urlsafe(48))

    def credential_for(self, action: str, project: str | None = None) -> str:
        return credential_for(self.config, action, project)

    def _authorize(
        self,
        action: str,
        payload: dict[str, Any],
        credentials: dict[str, Any] | None = None,
    ) -> None:
        supplied = payload.get("_credential", "")
        if not isinstance(supplied, str):
            raise AuthorizationError("a scoped credential is required")
        if action in {
            "start",
            "main",
            "resume",
            "list",
            "restore",
            "remap",
            "recovery",
        }:
            expected = private_read(self.config.state_root / "control.key").strip()
        else:
            if (
                not credentials
                or credentials.get("local_revoked")
                or credentials.get("local_expires_at", 0) <= time.time()
            ):
                raise AuthorizationError(
                    "project credential expired or was revoked; resume with operator authority"
                )
            if action not in credentials.get("scopes", []):
                raise AuthorizationError("project credential does not permit this tool")
            expected = credentials.get("local_token", "")
        if not expected or not secrets.compare_digest(supplied, expected):
            raise AuthorizationError("credential does not authorize this project")

    def _mint_local(self, credentials: dict[str, Any]) -> None:
        credentials.update(
            local_token=secrets.token_urlsafe(48),
            local_expires_at=time.time() + self.config.lease_seconds,
            local_revoked=False,
            scopes=[
                "status",
                "agents",
                "events",
                "plan",
                "activate",
                "hold",
                "control",
                "decision",
                "audit",
                "backup",
                "integrate",
                "close",
                "accept",
                "renew",
                "revoke",
                "operation",
                "archive",
            ],
        )

    def _store(self, record: dict[str, Any]) -> JournalStore:
        values = [private_read(self.config.state_root / "control.key").strip()]
        for path in (self.config.multica_token_file, self.config.muxdeck_token_file):
            if path and path.exists():
                values.append(private_read(path, maximum=4096).strip())
        credential_path = self._credentials_path(record)
        if credential_path.exists():
            credential = json.loads(private_read(credential_path))
            values.extend(
                str(credential.get(key, "")) for key in ("token", "local_token")
            )
        return JournalStore(
            self.config.state_root,
            record["project_id"],
            record["repo_root"],
            secret_values=tuple(values),
        )

    def _human(self) -> Any:
        if not self.config.multica_token_file or not self.config.multica_workspace_id:
            raise ProjectError(
                "configure a private Multica token file and workspace UUID"
            )
        return self.multica_factory(
            self.config.multica_url,
            self.config.multica_token_file,
            workspace_id=self.config.multica_workspace_id,
        )

    def _credentials_path(self, record: dict[str, Any]) -> Path:
        return self.config.state_root / record["project_id"] / "coordinator.json"

    def _credentials(self, record: dict[str, Any]) -> dict[str, Any]:
        try:
            result = json.loads(private_read(self._credentials_path(record)))
        except OSError as error:
            raise ProjectError(
                "project has no coordinator authority; run resume"
            ) from error
        if not isinstance(result, dict):
            raise ProjectError("invalid coordinator authority file")
        return result

    def _remote(self, credentials: dict[str, Any]) -> Any:
        return self.multica_factory(
            self.config.multica_url,
            token=credentials["token"],
            workspace_id=self.config.multica_workspace_id,
            generation=credentials["remote_generation"],
        )

    def _board_url(self, project_id: str) -> str | None:
        if not self.config.multica_workspace_slug:
            return None
        from urllib.parse import quote

        return (
            (self.config.multica_ui_url or self.config.multica_url).rstrip("/")
            + "/"
            + quote(self.config.multica_workspace_slug, safe="")
            + "/projects/"
            + project_id
        )

    def _authority(
        self, store: JournalStore, credentials: dict[str, Any], payload: dict[str, Any]
    ) -> tuple[str, int]:
        owner = payload.get("owner", credentials["owner"])
        generation = payload.get("generation", credentials["generation"])
        if owner != credentials["owner"] or generation != credentials["generation"]:
            raise ProjectError(
                "coordinator credentials are fenced; resume with a new owner"
            )
        store.assert_lease(owner, generation)
        store.renew_lease(owner, generation, self.config.lease_seconds)
        return owner, generation

    def _effect(
        self,
        store: JournalStore,
        credentials: dict[str, Any],
        operation_id: str,
        kind: str,
        payload: dict[str, Any],
        effect: Callable[[], dict[str, Any]],
        *,
        idempotent: bool = False,
    ) -> dict[str, Any]:
        owner, generation = credentials["owner"], credentials["generation"]
        operation = store.prepare_operation(
            operation_id, kind, payload, owner, generation
        )
        if operation["state"] == "confirmed":
            return operation.get("receipt", {})  # type: ignore[no-any-return]
        if operation["state"] == "rejected" or (
            operation["state"] in {"dispatched", "uncertain"} and not idempotent
        ):
            raise ProjectError(
                "operation requires receipt reconciliation; no blind retry: "
                + operation_id
            )
        store.assert_lease(owner, generation)
        if operation["state"] == "prepared":
            store.mark_dispatched(operation_id, owner, generation)
        try:
            result = effect()
        except MulticaError as error:
            if error.uncertain:
                store.mark_uncertain(operation_id, str(error), owner, generation)
            else:
                store.reject_operation(operation_id, str(error), owner, generation)
            raise
        except Exception:
            store.mark_uncertain(
                operation_id,
                "effect failed; inspect authoritative state before retry",
                owner,
                generation,
            )
            raise
        if operation["state"] in {"dispatched", "uncertain"}:
            store.reconcile_operation(
                operation_id, "confirmed", owner, generation, receipt=result
            )
        else:
            store.complete_operation(operation_id, result, owner, generation)
        return result

    def _lease_effect(
        self,
        store: JournalStore,
        credentials: dict[str, Any],
        record: dict[str, Any],
        operation_id: str,
        expected_generation: int | None,
    ) -> dict[str, Any]:
        """Lease minting has receiver-proven idempotency, including its secret response.

        The secret response is fsynced privately before the redacted receipt.
        Replaying this exact operation never creates a second lease generation.
        """
        saved_path = (
            self.config.state_root
            / record["project_id"]
            / ("lease-" + operation_id + ".json")
        )
        intent = {
            "project_id": credentials["multica_project_id"],
            "expected_generation": expected_generation,
            "runtime_profile_id": self.config.runtime_profile_id,
        }
        owner, generation = credentials["owner"], credentials["generation"]
        operation = store.prepare_operation(
            operation_id, "multica.lease", intent, owner, generation
        )
        if saved_path.exists():
            receipt = json.loads(private_read(saved_path))
        else:
            if operation["state"] == "confirmed":
                raise ProjectError(
                    "confirmed lease secret is missing; operator recovery is required"
                )
            if operation["state"] == "prepared":
                store.mark_dispatched(operation_id, owner, generation)
            try:
                receipt = self._human().lease(
                    credentials["multica_project_id"],
                    operation_id,
                    expected_generation=expected_generation,
                    worker_limit=self.config.worker_limit,
                    runtime_profile_id=self.config.runtime_profile_id,
                )
                private_write(saved_path, json.dumps(receipt))
            except MulticaError as error:
                store.mark_uncertain(operation_id, str(error), owner, generation)
                raise
        safe = self._safe_lease_receipt(receipt, credentials)
        if operation["state"] != "confirmed":
            store.reconcile_operation(
                operation_id, "confirmed", owner, generation, receipt=safe
            )
        return safe

    def _command(
        self,
        store: JournalStore,
        credentials: dict[str, Any],
        kind: str,
        payload: dict[str, Any],
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        identifier = str(uuid.UUID(operation_id)) if operation_id else str(uuid.uuid4())
        command = {"operation_id": identifier, "action": kind, **payload}
        remote = self._remote(credentials)
        return self._effect(
            store,
            credentials,
            identifier,
            "multica." + kind,
            command,
            lambda: remote.command(credentials["multica_project_id"], command),
        )

    def _main_identity(
        self, requested: str | None, pane: str | None = None
    ) -> dict[str, Any]:
        from urllib.parse import quote

        if not self.config.muxdeck_token_file:
            raise ProjectError("configure the private Muxdeck control token file")
        client = self.muxdeck_factory(
            self.config.muxdeck_url, self.config.muxdeck_token_file
        )
        inventory = client.request("GET", "/api/sessions")
        candidates = [
            record
            for record in inventory.get("sessions", [])
            if (requested and requested in {record.get("name"), record.get("id")})
            or (
                not requested
                and pane
                and any(item.get("id") == pane for item in record.get("panes", []))
            )
        ]
        if len(candidates) != 1:
            raise ProjectError(
                "main requires one verified visible tmux session; use the supported main launcher or --main-session"
            )
        record = candidates[0]
        return {
            "name": record["name"],
            "identity": _record_identity(record, pane),
            "terminal_url": (self.config.muxdeck_public_url or self.config.muxdeck_url)
            + "/session/"
            + quote(record["name"], safe=""),
        }

    def _ingest(
        self, store: JournalStore, credentials: dict[str, Any]
    ) -> dict[str, Any]:
        cursor = store.source_cursor("multica")
        feed = self._remote(credentials).events(
            credentials["multica_project_id"], cursor
        )
        if feed.get("gap") or feed.get("retention_gap"):
            snapshot = self._remote(credentials).snapshot(
                credentials["multica_project_id"]
            )
            store.record_feed_gap(
                "multica",
                int(snapshot.get("cursor", cursor)),
                "backend retention gap",
                snapshot,
            )
            raise ProjectError(
                "Multica retention gap; audit is incomplete and needs snapshot reconciliation"
            )
        entries = feed.get("events", [])
        # Store ingest_feed atomically deduplicates source IDs and advances cursor.
        if entries:
            translated = [
                {
                    "event_id": event["id"],
                    "cursor": event["sequence"],
                    "kind": event["type"],
                    "payload": event.get("payload", {}),
                    "actor": event.get("actor_type", "backend")
                    + ":"
                    + str(event.get("actor_id", "")),
                    "occurred_at": event.get("occurred_at"),
                    "operation_id": event.get("operation_id"),
                    "task_id": event.get("task_id"),
                    "run_id": event.get("run_id"),
                }
                for event in entries
            ]
            store.ingest_events(
                "multica",
                translated,
                previous_cursor=feed.get("prev_cursor"),
                page_complete=feed.get("page_complete", False),
            )
        self._ingest_runtime(store, credentials)
        return feed

    def _ingest_runtime(
        self,
        store: JournalStore,
        credentials: dict[str, Any],
        snapshot: dict[str, Any] | None = None,
    ) -> None:
        """Adopt only owned receipt files associated with authoritative attempts."""
        directory = self.config.state_root / store.project_id / "runs"
        files = sorted(directory.glob("*/executions/*/session.json"))
        if not files:
            return
        files.sort(
            key=lambda path: float(json.loads(private_read(path)).get("started_at", 0))
        )
        snapshot = snapshot or self._remote(credentials).snapshot(
            credentials["multica_project_id"]
        )
        attempts = {run["id"]: run for run in snapshot.get("runs", [])}
        for path in files:
            if any(parent.is_symlink() for parent in (path, *path.parents)):
                raise ProjectError("runtime receipt path traverses a symlink")
            binding = json.loads(private_read(path))
            run_id, execution_id = path.parents[2].name, path.parent.name
            uuid.UUID(run_id)
            uuid.UUID(execution_id)
            if (
                binding.get("project_id") != store.project_id
                or binding.get("run_id") != run_id
                or binding.get("execution_id") != execution_id
            ):
                raise ProjectError(
                    "runtime receipt does not match its project/run/execution path"
                )
            attempt = attempts.get(run_id)
            issue_id = binding.get("issue_id", binding.get("task_id"))
            if not attempt or attempt.get("issue_id") != issue_id:
                store.append_event(
                    "runtime.association_rejected",
                    {
                        "run_id": run_id,
                        "execution_id": execution_id,
                        "reason": "no authoritative matching attempt",
                    },
                    event_id=str(
                        uuid.uuid5(uuid.UUID(execution_id), "association-rejected")
                    ),
                )
                continue
            prior = store.get_mapping("provider_execution", execution_id)
            execution_path = path.parent / "execution.json"
            execution = (
                json.loads(private_read(execution_path))
                if execution_path.exists()
                else {}
            )
            ended = (
                execution.get("state")
                in {
                    "completed",
                    "outcome_unknown",
                    "exited",
                    "failed",
                    "interrupted",
                }
                or attempt.get("status") not in ACTIVE_RUN_STATUSES
            )
            terminal_state = "history" if ended else "live"
            if not prior or prior["payload"].get("terminal_state") != terminal_state:
                if binding.get("placement") != "confirmed" or not binding.get(
                    "identity"
                ):
                    continue
                from tmux_console.control_cli import _validate_identity

                identity = _validate_identity(binding["identity"])
                operation_id = str(
                    uuid.uuid5(
                        uuid.UUID(execution_id), "bind-terminal:" + terminal_state
                    )
                )
                self._command(
                    store,
                    credentials,
                    "bind_terminal",
                    {
                        "task_id": run_id,
                        "terminal_url": binding["terminal_url"],
                        "terminal_state": terminal_state,
                        "session_id": json.dumps(identity, sort_keys=True),
                    },
                    operation_id,
                )
                stored_binding = {**binding, "terminal_state": terminal_state}
                store.put_mapping(
                    "provider_execution",
                    execution_id,
                    stored_binding,
                    credentials["owner"],
                    credentials["generation"],
                )
                store.append_event(
                    "runtime.session_reconciled",
                    stored_binding,
                    run_id=run_id,
                    task_id=issue_id,
                    generation=credentials["generation"],
                )
                attempt.update(
                    terminal_url=binding["terminal_url"],
                    terminal_state=terminal_state,
                    session_id=json.dumps(identity, sort_keys=True),
                )
            if execution.get("state") in {
                "completed",
                "outcome_unknown",
                "exited",
                "failed",
                "interrupted",
            } and not store.get_mapping("execution_result", execution_id):
                artifacts = []
                missing = []
                for filename in (
                    "transcript.jsonl",
                    "stdout.bin",
                    "stderr.bin",
                    "execution.json",
                ):
                    capture = path.parent / filename
                    if capture.exists():
                        artifacts.append(
                            store.write_artifact(
                                "artifacts/executions/" + execution_id + "/" + filename,
                                private_read(capture, maximum=64 * 1024 * 1024)
                                if filename.endswith(("json", "jsonl"))
                                else capture.read_bytes(),
                                run_id=run_id,
                                actor="runtime",
                            )
                        )
                    else:
                        missing.append(filename)
                if missing:
                    store.append_event(
                        "audit.gap",
                        {
                            "source": "runtime-capture",
                            "run_id": run_id,
                            "execution_id": execution_id,
                            "missing": missing,
                            "coverage": "capture evidence is incomplete",
                        },
                        run_id=run_id,
                    )
                store.put_mapping(
                    "execution_result",
                    execution_id,
                    {
                        "execution": execution,
                        "artifacts": artifacts,
                        "capture_complete": not missing,
                    },
                    credentials["owner"],
                    credentials["generation"],
                )
                store.append_event(
                    "runtime.execution_reconciled",
                    execution,
                    run_id=run_id,
                    task_id=issue_id,
                    generation=credentials["generation"],
                )

    def _start(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._authorize("start", payload)
        repo = canonical_repository(payload["repo"])
        goal = payload.get("goal", "").strip()
        if not goal:
            raise ProjectError("start requires the user's goal")
        main = self._main_identity(
            payload.get("main_session"), payload.get("main_pane")
        )
        main["conversation_id"] = payload.get("main_conversation")
        if self.config.multica_project_id:
            resources = self._human().request(
                "GET",
                "/api/projects/"
                + str(uuid.UUID(self.config.multica_project_id))
                + "/resources",
            )
            entries = (
                resources.get("resources", [])
                if isinstance(resources, dict)
                else resources
            )
            local = [
                entry.get("resource_ref", {})
                for entry in entries
                if entry.get("resource_type") == "local_directory"
            ]
            if any(
                item.get("local_path") != str(repo)
                or item.get("daemon_id") != self.config.daemon_id
                for item in local
            ):
                raise ProjectError(
                    "existing backend project source differs; explicit repository remap is required"
                )
        record, created = self.registry.get_or_create(
            repo, payload.get("name") or repo.name, self.config.multica_project_id
        )
        with self.registry.lock(record["project_id"]), self._store(record) as store:
            credential_path = self._credentials_path(record)
            if credential_path.exists():
                credentials = self._credentials(record)
                bound = store.get_mapping("session", "main")
                if (
                    not bound
                    or bound["payload"]["identity"] != main["identity"]
                    or (
                        payload.get("main_conversation")
                        and bound["payload"].get("conversation_id")
                        != payload["main_conversation"]
                    )
                ):
                    raise ProjectError(
                        "project has a different main incarnation; use explicit resume --takeover handoff"
                    )
                owner, generation = self._authority(store, credentials, payload)
                from .runtime import ensure_project_workspace

                workspace = ensure_project_workspace(
                    self.config,
                    store,
                    owner,
                    generation,
                    record["name"],
                    main["name"],
                    client=self.muxdeck_factory(
                        self.config.muxdeck_url, self.config.muxdeck_token_file
                    ),
                )
                prior = store.get_mapping("project", "goal")
                resolved_delivery = payload.get("delivery") or (
                    "pr"
                    if re.search(
                        r"(?i)\b(?:pull request|open (?:a |the )?pr|create (?:a |the )?pr)\b",
                        goal,
                    )
                    else prior["payload"].get("delivery", "commit")
                    if prior
                    else "commit"
                )
                if prior and (
                    prior.get("payload", {}).get("goal") != goal
                    or prior["payload"].get("delivery") != resolved_delivery
                ):
                    store.append_event(
                        "input.amended",
                        {"goal": goal, "delivery": resolved_delivery},
                        actor=owner,
                        generation=generation,
                    )
                    store.put_mapping(
                        "project",
                        "goal",
                        {
                            **prior["payload"],
                            "goal": goal,
                            "delivery": resolved_delivery,
                        },
                        owner,
                        generation,
                    )
                return {
                    "project": record,
                    "reused": True,
                    "generation": generation,
                    "main": main,
                    "multica_url": self._board_url(credentials["multica_project_id"]),
                    "credential_expires_at": credentials["local_expires_at"],
                    "renew_before": credentials["local_expires_at"] - 60,
                    "muxdeck": workspace,
                }
            owner = (
                payload.get("owner")
                or payload.get("main_conversation")
                or (
                    "main:"
                    + str(main["identity"]["serverPid"])
                    + ":"
                    + main["identity"]["sessionId"]
                )
            )
            launched = store.get_mapping("main_session", "main")
            if launched:
                if launched["payload"]["identity"] != main["identity"]:
                    raise ProjectError(
                        "visible launcher belongs to another main incarnation"
                    )
                owner = store.status()["lease"]["owner"]
            lease = store.acquire_lease(owner, self.config.lease_seconds)
            credentials = {"owner": owner, "generation": lease["generation"]}
            store.append_event(
                "input.initial",
                {
                    "goal": goal,
                    "repo_root": str(repo),
                    "main": main,
                    "main_conversation": payload.get("main_conversation"),
                },
                actor=owner,
                generation=lease["generation"],
            )
            delivery = payload.get("delivery") or (
                "pr"
                if re.search(
                    r"(?i)\b(?:pull request|open (?:a |the )?pr|create (?:a |the )?pr)\b",
                    goal,
                )
                else "commit"
            )
            store.put_mapping(
                "project",
                "goal",
                {"goal": goal, "delivery": delivery},
                owner,
                lease["generation"],
            )
            store.write_artifact(
                "inputs/brief-0001.md", goal, media_type="text/markdown", actor=owner
            )
            store.put_mapping("session", "main", main, owner, lease["generation"])
            store.put_mapping(
                "project",
                "baseline",
                {
                    "sha": git(repo, "rev-parse", "HEAD"),
                    "dirty": bool(git(repo, "status", "--porcelain")),
                },
                owner,
                lease["generation"],
            )
            human = self._human()
            human.capabilities()
            project_id = self.config.multica_project_id or record["project_id"]
            credentials["multica_project_id"] = project_id
            operation_id = str(uuid.uuid5(uuid.UUID(record["project_id"]), "register"))
            registration = {
                "operation_id": operation_id,
                "name": record["name"],
                "goal": goal,
                "repo_root": str(repo),
                "worker_limit": self.config.worker_limit,
            }
            if self.config.daemon_id:
                registration["daemon_id"] = self.config.daemon_id
            self._effect(
                store,
                credentials,
                operation_id,
                "multica.register",
                registration,
                lambda: human.request(
                    "POST", human.project_path(project_id) + "/register", registration
                ),
                idempotent=True,
            )
            operation_id = str(
                uuid.uuid5(uuid.UUID(record["project_id"]), "initial-lease")
            )
            remote_lease = self._lease_effect(
                store, credentials, record, operation_id, None
            )
            credentials.update(
                multica_project_id=project_id,
                remote_generation=remote_lease["generation"],
                expires_at=remote_lease.get("expires_at"),
            )
            self._mint_local(credentials)
            private_write(credential_path, json.dumps(credentials))
            store.put_mapping(
                "project",
                "multica",
                {
                    "project_id": project_id,
                    "workspace_id": self.config.multica_workspace_id,
                    "backend_generation": remote_lease["generation"],
                },
                owner,
                lease["generation"],
            )
            from .runtime import ensure_project_workspace

            workspace = ensure_project_workspace(
                self.config,
                store,
                owner,
                lease["generation"],
                record["name"],
                main["name"],
                client=self.muxdeck_factory(
                    self.config.muxdeck_url, self.config.muxdeck_token_file
                ),
            )
            return {
                "project": record,
                "reused": not created,
                "generation": lease["generation"],
                "main": main,
                "multica_url": self._board_url(project_id),
                "muxdeck": workspace,
                "credential_expires_at": credentials["local_expires_at"],
                "renew_before": credentials["local_expires_at"] - 60,
            }

    @staticmethod
    def _safe_lease_receipt(
        receipt: dict[str, Any], credentials: dict[str, Any]
    ) -> dict[str, Any]:
        token = receipt.get("token")
        if not isinstance(token, str) or not token:
            raise ProjectError(
                "Multica lease did not return a scoped coordinator credential"
            )
        credentials["token"] = token
        return {key: value for key, value in receipt.items() if key != "token"}

    def dispatch(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action in {"health", "ping"}:
            return {
                "schema_version": 1,
                "service": "muxdeck-projectd",
                "scheduler": "Multica",
            }
        if action == "doctor":
            result: dict[str, Any] = {
                "schema_version": 1,
                "ready": False,
                "provider_smoke": "unqualified",
            }
            errors: list[str] = []
            try:
                result["multica"] = self._human().capabilities()
            except (ProjectError, MulticaError, OSError) as error:
                errors.append(str(error))
            try:
                if not self.config.muxdeck_token_file:
                    raise ProjectError("configure Muxdeck control token file")
                result["muxdeck"] = self.muxdeck_factory(
                    self.config.muxdeck_url, self.config.muxdeck_token_file
                ).request("GET", "/api/capabilities")
            except (ProjectError, ControlError, OSError) as error:
                errors.append(str(error))
            qualified = False
            if self.config.qualification_file:
                try:
                    qualification = json.loads(
                        private_read(self.config.qualification_file)
                    )
                    qualified = (
                        qualification.get("protocol") == "muxpilot-v1"
                        and qualification.get("passed") is True
                        and qualification.get("runtime_profile_id")
                        == self.config.runtime_profile_id
                    )
                    result["provider_smoke"] = (
                        qualification
                        if qualified
                        else "incompatible qualification record"
                    )
                except (OSError, ValueError):
                    result["provider_smoke"] = "qualification record unavailable"
            result.update(
                ready=not errors and qualified,
                service_ready=not errors,
                provider_qualified=qualified,
                errors=errors,
            )
            return result
        if action == "start":
            return self._start(payload)
        if action == "main":
            self._authorize("main", payload)
            repo = canonical_repository(payload["repo"])
            record, _created = self.registry.get_or_create(
                repo, repo.name, self.config.multica_project_id
            )
            with self.registry.lock(record["project_id"]), self._store(record) as store:
                if self._credentials_path(record).exists():
                    raise ProjectError(
                        "project already has a main; use resume/adopt before replacement"
                    )
                owner = payload.get("owner") or "main-launch:" + record["project_id"]
                lease = store.acquire_lease(owner, self.config.lease_seconds)
                prompt = (
                    "Use $muxpilot for "
                    + str(repo)
                    + ". "
                    + payload["goal"]
                    + ". Load the installed muxpilot skill and use its project tools."
                )
                command = payload.get("command_json") or [
                    "codex",
                    "-m",
                    payload.get("model", "gpt-6.1-sol"),
                    prompt,
                ]
                from .runtime import launch_main

                return launch_main(
                    self.config,
                    store,
                    command,
                    repo,
                    owner,
                    lease["generation"],
                    str(uuid.uuid5(uuid.UUID(record["project_id"]), "main-launch")),
                )
        if action == "list":
            self._authorize(action, payload)
            return {"projects": self.registry.records()}
        if action == "restore":
            self._authorize(action, payload)
            destination = Path(payload["destination"]).expanduser().absolute()
            if destination == self.config.state_root.absolute():
                raise ProjectError(
                    "restore requires an isolated destination state directory"
                )
            with JournalStore.restore(payload["backup"], destination) as restored:
                status = restored.status()
                record = {
                    "project_id": restored.project_id,
                    "repo_root": status["repo_root"],
                    "name": Path(status["repo_root"]).name,
                    "created_at": time.time(),
                    "restored": True,
                }
                ProjectRegistry(destination).put_record(record)
                mapping = restored.get_mapping("project", "multica")
                if mapping:
                    old = status.get("lease") or {}
                    credentials = {
                        "owner": old.get("owner", "restored-main"),
                        "generation": old.get("generation", 0),
                        "multica_project_id": mapping["payload"]["project_id"],
                        "remote_generation": mapping["payload"].get(
                            "backend_generation", 1
                        ),
                        "token": "",
                    }
                    self._mint_local(credentials)
                    credentials["local_revoked"] = True
                    private_write(
                        destination / restored.project_id / "coordinator.json",
                        json.dumps(credentials),
                    )
                return {
                    "project": record,
                    "state_root": str(destination),
                    "requires_resume": True,
                    "external_state_overwritten": False,
                    "evidence": restored.artifact_inventory(),
                }
        record = self.registry.resolve(payload["project"])
        if action == "events":
            wait = float(payload.get("wait", 0))
            if not 0 <= wait <= 30:
                raise ProjectError("await timeout must be between zero and 30 seconds")
            deadline = time.monotonic() + wait
            while True:
                with (
                    self.registry.lock(record["project_id"]),
                    self._store(record) as store,
                ):
                    credentials = self._credentials(record)
                    self._authorize(action, payload, credentials)
                    self._authority(store, credentials, payload)
                    try:
                        self._ingest(store, credentials)
                        degraded = None
                    except (MulticaError, ProjectError) as error:
                        degraded = str(error)
                    events = store.events(after=int(payload.get("after", 0)), limit=100)
                    result = {
                        "events": events,
                        "degraded": degraded,
                        "project_id": record["project_id"],
                        "generation": credentials["generation"],
                        "credential_expires_at": credentials["local_expires_at"],
                        "renew_required": credentials["local_expires_at"] - time.time()
                        <= 60,
                    }
                if events or degraded or time.monotonic() >= deadline:
                    return result
                time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        with self.registry.lock(record["project_id"]), self._store(record) as store:
            if action == "recovery":
                self._authorize(action, payload)
                result = {
                    "project": record,
                    "local": store.status(),
                    "backend": None,
                    "stale": True,
                    "evidence": store.artifact_inventory(),
                    "mutation_attempted": False,
                    "events": store.events(limit=100),
                }
                mapping = store.get_mapping("project", "multica")
                project_id = (
                    mapping["payload"]["project_id"]
                    if mapping
                    else record["project_id"]
                )
                try:
                    result["backend"] = self._human().request(
                        "GET", MulticaClient.project_path(project_id) + "/recovery"
                    )
                    result["stale"] = False
                except (ProjectError, MulticaError, OSError) as error:
                    result["backend_error"] = str(error)
                if payload.get("export"):
                    result["audit"] = store.export_audit(payload["export"])
                return result
            credentials = self._credentials(record)
            self._authorize(action, payload, credentials)
            if action == "status":
                result = {
                    "project": record,
                    "local": store.status(),
                    "backend": None,
                    "stale": True,
                }
                try:
                    credentials = self._credentials(record)
                    result["backend"] = self._remote(credentials).snapshot(
                        credentials["multica_project_id"]
                    )
                    if store.status()["lease_active"]:
                        self._ingest_runtime(store, credentials, result["backend"])
                        result["local"] = store.status()
                    result["stale"] = False
                except (MulticaError, ProjectError, OSError) as error:
                    result["backend_error"] = str(error)
                return result
            if action == "agents":
                snapshot = self._remote(credentials).snapshot(
                    credentials["multica_project_id"]
                )
                return {
                    "project_id": record["project_id"],
                    "agents": snapshot.get("approved_agents", []),
                    "runtime_profile_id": self.config.runtime_profile_id,
                    "selection": "explicit approved agent UUID in each task",
                }
            if action == "audit":
                return store.export_audit(payload.get("destination"))
            if action == "backup":
                return store.backup(payload["destination"])  # type: ignore[no-any-return]
            if action == "resume":
                return self._resume(record, store, credentials, payload)
            owner, generation = self._authority(store, credentials, payload)
            lifecycle = store.get_mapping("project", "lifecycle")
            if (
                lifecycle
                and lifecycle["payload"].get("state") == "archived"
                and action not in {"archive", "renew", "revoke"}
            ):
                raise ProjectError(
                    "project is archived; resume explicitly before further mutations"
                )
            if action == "archive":
                if lifecycle and lifecycle["payload"].get("state") == "archived":
                    return {
                        "state": "archived",
                        "reused": True,
                        "sessions_preserved": True,
                    }
                result = self._command(store, credentials, "hold", {"held": True})
                store.put_mapping(
                    "project",
                    "lifecycle",
                    {"state": "archived", "dispatch_held": True},
                    owner,
                    generation,
                )
                return {
                    "state": "archived",
                    "dispatch": result,
                    "sessions_preserved": True,
                    "worktrees_preserved": True,
                }
            if action == "remap":
                target = canonical_repository(payload["repo"])
                if store.pending_operations():
                    raise ProjectError(
                        "repository remap requires all pending operations reconciled"
                    )
                snapshot = self._remote(credentials).snapshot(
                    credentials["multica_project_id"]
                )
                if any(
                    run.get("status") in ACTIVE_RUN_STATUSES
                    for run in snapshot.get("runs", [])
                ):
                    raise ProjectError("repository remap requires no active attempts")
                baseline = store.get_mapping("project", "baseline")
                if (
                    not baseline
                    or git(
                        target, "rev-parse", baseline["payload"]["sha"] + "^{commit}"
                    )
                    != baseline["payload"]["sha"]
                ):
                    raise ProjectError(
                        "target repository does not contain the recorded baseline identity"
                    )
                result = self._command(
                    store,
                    credentials,
                    "remap_repository",
                    {
                        "repo_root": str(target),
                        "daemon_id": self.config.daemon_id,
                        "content": payload["reason"],
                    },
                )
                store.remap_repository(
                    target, owner, generation, reason=payload["reason"]
                )
                record["repo_root"] = str(target)
                self.registry.put_record(record)
                return {
                    "project": record,
                    "backend": result,
                    "resources_preserved": True,
                }
            if action == "plan":
                result = self._plan(store, credentials, payload)
                from .runtime import ensure_project_workspace

                main_mapping = store.get_mapping("session", "main")
                ensure_project_workspace(
                    self.config,
                    store,
                    owner,
                    generation,
                    record["name"],
                    main_mapping["payload"]["name"] if main_mapping else None,
                    client=self.muxdeck_factory(
                        self.config.muxdeck_url, self.config.muxdeck_token_file
                    ),
                )
                return result
            if action == "activate":
                stage = int(payload["stage"])
                mapping = store.get_mapping(
                    "project", "baseline" if stage == 1 else "integration"
                )
                recorded = (
                    mapping["payload"].get("sha" if stage == 1 else "integration_sha")
                    if mapping
                    else None
                )
                base = payload.get("base")
                if not base:
                    base = recorded
                if not base or not re.fullmatch(r"[0-9a-fA-F]{40,64}", base):
                    raise ProjectError(
                        "stage activation requires its exact verified --base commit; later stages need accepted integration"
                    )
                if stage > 1 and (not recorded or base != recorded):
                    raise ProjectError(
                        "later-stage base must match the exact accepted integration revision"
                    )
                if (
                    git(Path(record["repo_root"]), "rev-parse", base + "^{commit}")
                    != base
                ):
                    raise ProjectError("stage baseline commit is unavailable")
                if stage == 1 and base != recorded:
                    store.append_event(
                        "stage.baseline_override",
                        {"stage": stage, "previous": recorded, "base_sha": base},
                        actor=owner,
                        generation=generation,
                    )
                result = self._command(
                    store,
                    credentials,
                    "activate_stage",
                    {"stage": stage, "base_sha": base},
                    payload.get("operation_id"),
                )
                store.put_mapping(
                    "stage",
                    str(stage),
                    {"base_sha": base, "receipt": result},
                    owner,
                    generation,
                )
                return {**result, "base_sha": base}
            if action == "hold":
                return self._command(
                    store,
                    credentials,
                    "hold",
                    {"held": bool(payload.get("held", True))},
                    payload.get("operation_id"),
                )
            if action == "renew":
                result = self._command(store, credentials, "renew", {})
                credentials["local_expires_at"] = (
                    time.time() + self.config.lease_seconds
                )
                private_write(self._credentials_path(record), json.dumps(credentials))
                return {
                    "generation": generation,
                    "expires_at": credentials["local_expires_at"],
                    "backend": result,
                }
            if action == "revoke":
                result = self._command(store, credentials, "revoke", {})
                credentials["local_revoked"] = True
                private_write(self._credentials_path(record), json.dumps(credentials))
                store.release_lease(owner, generation)
                return {"revoked": True, "backend": result, "sessions_preserved": True}
            if action == "accept":
                evidence = payload["evidence"]
                if (
                    not evidence.get("checks")
                    or not evidence.get("revision")
                    or any(
                        check.get("passed") is not True
                        or check.get("revision") != evidence["revision"]
                        for check in evidence["checks"]
                    )
                ):
                    raise ProjectError(
                        "task acceptance requires commit and passing verification evidence"
                    )
                if (
                    not re.fullmatch(r"[0-9a-fA-F]{40,64}", evidence["revision"])
                    or git(
                        Path(record["repo_root"]),
                        "rev-parse",
                        evidence["revision"] + "^{commit}",
                    )
                    != evidence["revision"]
                ):
                    raise ProjectError(
                        "task evidence revision is not an existing full commit identity"
                    )
                snapshot = self._remote(credentials).snapshot(
                    credentials["multica_project_id"]
                )
                attempts = [
                    run
                    for run in snapshot.get("runs", [])
                    if run.get("issue_id") == payload["issue"]
                ]
                if attempts:
                    latest = attempts[-1]
                    if evidence.get("run_id") != latest["id"] or latest.get(
                        "status"
                    ) not in {"completed", "succeeded"}:
                        raise ProjectError(
                            "task acceptance must reference the latest successful authoritative run"
                        )
                    self._ingest_runtime(store, credentials, snapshot)
                    results = [
                        mapping
                        for mapping in store.list_mappings("execution_result")
                        if mapping["payload"]["execution"].get("run_id") == latest["id"]
                    ]
                    if not results or any(
                        not mapping["payload"].get("capture_complete")
                        for mapping in results
                    ):
                        raise ProjectError(
                            "worker acceptance requires complete captured execution evidence"
                        )
                elif not evidence.get("coordinator_owned"):
                    raise ProjectError(
                        "task without a worker run requires explicit coordinator-owned evidence"
                    )
                issue = next(
                    (
                        task
                        for task in snapshot.get("issues", [])
                        if task["id"] == payload["issue"]
                    ),
                    None,
                )
                stage_mapping = (
                    store.get_mapping("stage", str(issue["stage"])) if issue else None
                )
                baseline = store.get_mapping("project", "baseline")
                source_base = (
                    stage_mapping["payload"]["base_sha"]
                    if stage_mapping
                    else baseline["payload"]["sha"]
                    if baseline
                    else None
                )
                if not source_base or (
                    evidence.get("base_sha") and evidence["base_sha"] != source_base
                ):
                    raise ProjectError(
                        "task result base does not match its recorded stage baseline"
                    )
                evidence = {**evidence, "base_sha": source_base}
                artifact = store.write_artifact(
                    "artifacts/acceptance/"
                    + payload["issue"]
                    + "/"
                    + evidence["revision"]
                    + ".json",
                    json.dumps(evidence),
                    media_type="application/json",
                    actor=owner,
                )
                if not store.artifact_inventory()["complete"]:
                    raise ProjectError(
                        "missing or corrupt artifacts prevent task acceptance"
                    )
                evidence = {**evidence, "artifact": artifact}
                store.append_event(
                    "task.accepted",
                    {"issue_id": payload["issue"], "evidence": evidence},
                    actor=owner,
                    generation=generation,
                )
                result = self._command(
                    store,
                    credentials,
                    "update_task",
                    {"issue_id": payload["issue"], "status": "done"},
                    payload.get("operation_id"),
                )
                store.put_mapping(
                    "accepted_task", payload["issue"], evidence, owner, generation
                )
                return result
            if action == "operation":
                identifier = str(uuid.UUID(payload["operation_id"]))
                operation = store.prepare_operation(
                    identifier, payload["kind"], payload["payload"], owner, generation
                )
                if payload.get("receipt"):
                    if operation["state"] == "prepared":
                        raise ProjectError(
                            "operation was never admitted for external execution"
                        )
                    if (
                        operation["owner"] != owner
                        or operation["generation"] != generation
                    ):
                        return store.reconcile_operation(
                            identifier,
                            "confirmed",
                            owner,
                            generation,
                            receipt=payload["receipt"],
                        )
                    return store.complete_operation(
                        identifier, payload["receipt"], owner, generation
                    )
                if operation["state"] == "prepared":
                    return {
                        **store.mark_dispatched(identifier, owner, generation),
                        "execute_allowed": True,
                    }
                return {**operation, "execute_allowed": False}
            if action == "control":
                control = payload["action"]
                if control == "inspect":
                    return self._remote(credentials).snapshot(
                        credentials["multica_project_id"]
                    )  # type: ignore[no-any-return]
                if control not in {
                    "instruction",
                    "supplement",
                    "cancel",
                    "continue",
                    "interrupt",
                }:
                    raise ProjectError("unsupported control action")
                # Backend task_id means a run/attempt ID; require it explicitly.
                if not payload.get("run"):
                    raise ProjectError("control requires the exact --run UUID")
                snapshot = self._remote(credentials).snapshot(
                    credentials["multica_project_id"]
                )
                attempt = next(
                    (
                        run
                        for run in snapshot.get("runs", [])
                        if run["id"] == payload["run"]
                    ),
                    None,
                )
                if not attempt or (
                    payload.get("task") and attempt.get("issue_id") != payload["task"]
                ):
                    raise ProjectError(
                        "control target does not match the authoritative project issue/run association"
                    )
                mapped = {"instruction": "supplement"}.get(control, control)
                return self._command(
                    store,
                    credentials,
                    mapped,
                    {
                        "task_id": payload["run"],
                        "issue_id": payload.get("task"),
                        "content": payload.get("message", ""),
                    },
                    payload.get("operation_id"),
                )
            if action == "decision":
                return store.commit_decision(
                    owner,
                    generation,
                    int(payload.get("ack", 0)),
                    payload["message"],
                    payload.get("details"),
                )  # type: ignore[no-any-return]
            if action == "integrate":
                identifier = payload.get("operation_id") or str(uuid.uuid4())
                accepted = next(
                    (
                        mapping["payload"]
                        for mapping in store.list_mappings("accepted_task")
                        if mapping["payload"]["revision"] == payload["commit"]
                    ),
                    None,
                )
                baseline = store.get_mapping("project", "baseline")
                source_base = (
                    payload.get("base")
                    or (accepted.get("base_sha") if accepted else None)
                    or (baseline["payload"]["sha"] if baseline else None)
                )
                if not source_base:
                    raise ProjectError(
                        "integration requires the recorded worker/stage base SHA"
                    )
                integrator = Integrator(
                    Path(record["repo_root"]),
                    record["project_id"],
                    self.config.state_root / record["project_id"],
                )
                existing = store.operation(identifier)
                before_sha = (
                    existing["payload"].get("before_sha")
                    if existing
                    else git(integrator.path, "rev-parse", "HEAD")
                    if integrator.path.exists()
                    else source_base
                )
                result = self._effect(
                    store,
                    credentials,
                    identifier,
                    "git.integrate",
                    {
                        "commit": payload["commit"],
                        "base": source_base,
                        "before_sha": before_sha,
                    },
                    lambda: Integrator(
                        Path(record["repo_root"]),
                        record["project_id"],
                        self.config.state_root / record["project_id"],
                    ).integrate(payload["commit"], base=source_base),
                    idempotent=True,
                )
                store.put_mapping("project", "integration", result, owner, generation)
                return result
            if action == "close":
                return self._close(record, store, credentials, payload["evidence"])
            raise ProjectError("unknown project tool: " + action)

    def _plan(
        self, store: JournalStore, credentials: dict[str, Any], payload: dict[str, Any]
    ) -> dict[str, Any]:
        plan = payload["plan"]
        stages = plan.get("stages") if isinstance(plan, dict) else None
        if (
            not isinstance(stages, list)
            or not stages
            or not plan.get("completion_criteria")
        ):
            raise ProjectError("plan requires stages and explicit completion_criteria")
        if len(stages) > 100 or any(not isinstance(stage, dict) for stage in stages):
            raise ProjectError("plan stages must be bounded JSON objects")
        stage_ids = [stage.get("stage") for stage in stages]
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 1
            for value in stage_ids
        ) or stage_ids != sorted(set(stage_ids)):
            raise ProjectError("stage numbers must be unique positive ordered integers")
        if any(
            not isinstance(stage.get("tasks"), list)
            or not stage["tasks"]
            or len(stage["tasks"]) > 100
            or any(not isinstance(task, dict) for task in stage["tasks"])
            for stage in stages
        ):
            raise ProjectError("every planned stage requires tasks")
        allowed_task_keys = {"title", "description", "agent_id", "acceptance"}
        if any(
            set(task) - allowed_task_keys for stage in stages for task in stage["tasks"]
        ):
            raise ProjectError(
                "task fields must be title, description, agent_id and acceptance"
            )
        for stage in stages:
            for task in stage["tasks"]:
                if task.get("agent_id"):
                    try:
                        uuid.UUID(task["agent_id"])
                    except (ValueError, TypeError, AttributeError) as error:
                        raise ProjectError(
                            "task owner agent_id must be a UUID"
                        ) from error
        prior = store.get_mapping("project", "plan")
        if prior and prior.get("payload") == plan:
            return {
                "revision": prior["version"],
                "reused": True,
                "dispatch": "existing parked/active backend tasks preserved",
            }
        revision = (prior.get("version", 0) if prior else 0) + 1
        if any(
            not task.get("title") or not task.get("acceptance")
            for stage in stages
            for task in stage["tasks"]
        ):
            raise ProjectError(
                "each task requires title and acceptance evidence criteria"
            )
        store.append_event(
            "plan.recorded",
            {"revision": revision, "plan": plan},
            actor=credentials["owner"],
            generation=credentials["generation"],
        )
        epic_mapping = store.get_mapping("epic", "main")
        if epic_mapping:
            epic_id = epic_mapping["payload"]["issue_id"]
        else:
            goal = store.get_mapping("project", "goal")
            epic = self._command(
                store,
                credentials,
                "create_task",
                {
                    "title": plan.get("title")
                    or (goal["payload"]["goal"][:120] if goal else "Project goal"),
                    "description": "External interactive Muxpilot coordinator owns this epic; no native parent agent.",
                    "stage": 0,
                    "status": "backlog",
                    "no_start": True,
                    "acceptance": "\n".join(
                        str(item) for item in plan["completion_criteria"]
                    ),
                },
                str(uuid.uuid5(uuid.UUID(store.project_id), "project-epic")),
            )
            epic_id = epic["issue_id"]
            store.put_mapping(
                "epic",
                "main",
                {"issue_id": epic_id},
                credentials["owner"],
                credentials["generation"],
            )
        results = []
        for stage in stages:
            for index, task in enumerate(stage["tasks"]):
                if not task.get("title") or not task.get("acceptance"):
                    raise ProjectError(
                        "each task requires title and acceptance evidence criteria"
                    )
                operation_id = str(
                    uuid.uuid5(
                        uuid.UUID(store.project_id),
                        f"plan:{revision}:stage:{stage['stage']}:task:{index}",
                    )
                )
                task_payload = {
                    **task,
                    "stage": stage["stage"],
                    "no_start": True,
                    "status": "backlog",
                    "parent_issue_id": epic_id,
                }
                if isinstance(task_payload["acceptance"], list):
                    task_payload["acceptance"] = "\n".join(
                        str(item) for item in task_payload["acceptance"]
                    )
                results.append(
                    self._command(
                        store, credentials, "create_task", task_payload, operation_id
                    )
                )
        store.put_mapping(
            "project", "plan", plan, credentials["owner"], credentials["generation"]
        )
        return {
            "revision": revision,
            "epic_id": epic_id,
            "tasks": results,
            "dispatch": "parked backlog; activate an eligible stage explicitly",
        }

    def _resume(
        self,
        record: dict[str, Any],
        store: JournalStore,
        credentials: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        new_owner = payload.get("owner") or credentials["owner"]
        if new_owner != credentials["owner"] and not payload.get("takeover"):
            raise ProjectError(
                "another owner is bound; explicit --takeover is required"
            )
        new_main = (
            self._main_identity(payload["main_session"])
            if payload.get("main_session")
            else None
        )
        if new_main:
            new_main["conversation_id"] = payload.get("main_conversation")
        if new_owner != credentials["owner"] and not new_main:
            raise ProjectError(
                "takeover requires the replacement main's verified --main-session"
            )
        pending_path = self.config.state_root / record["project_id"] / "takeover.json"
        if pending_path.exists():
            pending = json.loads(private_read(pending_path))
            if pending["new_owner"] != new_owner:
                raise ProjectError(
                    "a different ownership transfer is pending; reconcile it first"
                )
            if not new_main:
                new_main = pending.get("main")
        else:
            operation_id = str(
                uuid.uuid5(
                    uuid.UUID(record["project_id"]),
                    f"takeover:{credentials['generation']}:{new_owner}",
                )
            )
            pending = {
                "new_owner": new_owner,
                "old_owner": credentials["owner"],
                "old_generation": credentials["generation"],
                "expected_remote_generation": credentials["remote_generation"],
                "operation_id": operation_id,
                "main": new_main,
            }
            private_write(pending_path, json.dumps(pending))
            store.append_event(
                "coordinator.takeover_intent",
                {key: value for key, value in pending.items() if key != "main"},
                actor="operator",
                operation_id=operation_id,
            )
        # Registry lock serializes all local effects against authority transfer.
        current = store.status().get("lease")
        if (
            current
            and current["owner"] == pending["old_owner"]
            and current["generation"] == pending["old_generation"]
            and not current["revoked"]
            and current["expires_at"] > time.time()
        ):
            store.release_lease(pending["old_owner"], pending["old_generation"])
        lease = store.acquire_lease(new_owner, self.config.lease_seconds)
        pending["local_generation"] = lease["generation"]
        private_write(pending_path, json.dumps(pending))
        updated = {**credentials, "owner": new_owner, "generation": lease["generation"]}
        operation_id = pending["operation_id"]
        remote_receipt = self._lease_effect(
            store, updated, record, operation_id, pending["expected_remote_generation"]
        )
        updated.update(
            remote_generation=remote_receipt["generation"],
            expires_at=remote_receipt.get("expires_at"),
        )
        self._mint_local(updated)
        private_write(self._credentials_path(record), json.dumps(updated))
        store.put_mapping(
            "project",
            "lifecycle",
            {"state": "active", "dispatch_requires_explicit_activation": True},
            new_owner,
            lease["generation"],
        )
        pending_path.unlink(missing_ok=True)
        if new_main:
            store.put_mapping(
                "session", "main", new_main, new_owner, lease["generation"]
            )
        store.put_mapping(
            "project",
            "multica",
            {
                "project_id": updated["multica_project_id"],
                "workspace_id": self.config.multica_workspace_id,
                "backend_generation": updated["remote_generation"],
            },
            new_owner,
            lease["generation"],
        )
        from .runtime import ensure_project_workspace

        main_mapping = store.get_mapping("session", "main")
        ensure_project_workspace(
            self.config,
            store,
            new_owner,
            lease["generation"],
            record["name"],
            main_mapping["payload"].get("name") if main_mapping else None,
            client=self.muxdeck_factory(
                self.config.muxdeck_url, self.config.muxdeck_token_file
            ),
        )
        reconciled, unresolved = [], []
        for operation in store.pending_operations():
            if operation["kind"] == "git.integrate":
                intent = operation["payload"]
                receipt = Integrator(
                    Path(record["repo_root"]),
                    record["project_id"],
                    self.config.state_root / record["project_id"],
                ).observe(intent["commit"], intent["base"], intent.get("before_sha"))
                if receipt:
                    store.reconcile_operation(
                        operation["operation_id"],
                        "confirmed",
                        new_owner,
                        lease["generation"],
                        receipt=receipt,
                    )
                    store.put_mapping(
                        "project",
                        "integration",
                        receipt,
                        new_owner,
                        lease["generation"],
                    )
                    reconciled.append(operation["operation_id"])
                else:
                    unresolved.append(operation["operation_id"])
                continue
            if operation["kind"].startswith("multica.") and operation["kind"] not in {
                "multica.lease",
                "multica.register",
            }:
                try:
                    receipt = self._remote(updated).operation(
                        updated["multica_project_id"], operation["operation_id"]
                    )
                    store.reconcile_operation(
                        operation["operation_id"],
                        "confirmed",
                        new_owner,
                        lease["generation"],
                        receipt=receipt.get("response", receipt),
                    )
                    reconciled.append(operation["operation_id"])
                except MulticaError:
                    unresolved.append(operation["operation_id"])
            else:
                unresolved.append(operation["operation_id"])
        try:
            self._ingest(store, updated)
            snapshot = self._remote(updated).snapshot(updated["multica_project_id"])
            adopted = []
            for run in snapshot.get("runs", []):
                if run.get("status") in ACTIVE_RUN_STATUSES:
                    receipt = self._command(
                        store,
                        updated,
                        "adopt_run",
                        {"task_id": run["id"]},
                        str(
                            uuid.uuid5(
                                uuid.UUID(record["project_id"]),
                                f"adopt:{lease['generation']}:{run['id']}",
                            )
                        ),
                    )
                    adopted.append(receipt)
            snapshot["adopted_attempts"] = adopted
        except (MulticaError, ProjectError) as error:
            snapshot = {"unavailable": str(error)}
        store.append_event(
            "coordinator.resumed",
            {"reconciled": reconciled, "unresolved": unresolved},
            actor=new_owner,
            generation=lease["generation"],
        )
        return {
            "project_id": record["project_id"],
            "generation": lease["generation"],
            "reconciled": reconciled,
            "unresolved": unresolved,
            "backend": snapshot,
            "goal": store.get_mapping("project", "goal"),
            "plan": store.get_mapping("project", "plan"),
            "duplicate_dispatch": False,
            "credential_expires_at": updated["local_expires_at"],
            "renew_before": updated["local_expires_at"] - 60,
        }

    def _close(
        self,
        record: dict[str, Any],
        store: JournalStore,
        credentials: dict[str, Any],
        evidence: dict[str, Any],
    ) -> dict[str, Any]:
        plan_mapping = store.get_mapping("project", "plan")
        plan = plan_mapping.get("payload", {}) if plan_mapping else {}
        integration = store.get_mapping("project", "integration")
        integrated = integration.get("payload", {}) if integration else {}
        revision = evidence.get("revision")
        if (
            not revision
            or integrated.get("status") != "integrated"
            or integrated.get("integration_sha") != revision
        ):
            raise ProjectError(
                "closure requires the exact accepted integration revision"
            )
        checks = evidence.get("checks", [])
        if not checks or any(
            check.get("passed") is not True
            or check.get("revision") != revision
            or not check.get("command")
            for check in checks
        ):
            raise ProjectError(
                "closure requires passing goal-level checks against the integration revision"
            )
        criteria = evidence.get("completion_criteria")
        if (
            not plan.get("completion_criteria")
            or criteria != plan["completion_criteria"]
        ):
            raise ProjectError(
                "closure evidence must cover every recorded completion criterion"
            )
        deliverable = evidence.get("deliverable", {})
        if deliverable.get("revision") != revision or deliverable.get("kind") not in {
            "commit",
            "pr",
        }:
            raise ProjectError("closure requires the authorized delivered revision/PR")
        if deliverable["kind"] == "pr" and not deliverable.get("url"):
            raise ProjectError("PR delivery requires its actual URL")
        if deliverable["kind"] == "pr":
            receipt_operation = store.operation(deliverable.get("operation_id", ""))
            receipt = receipt_operation.get("receipt") if receipt_operation else None
            if (
                not receipt_operation
                or receipt_operation["kind"] != "publish.pr"
                or receipt_operation["state"] != "confirmed"
                or not receipt
                or receipt.get("url") != deliverable["url"]
                or receipt.get("revision") != revision
            ):
                raise ProjectError(
                    "PR closure requires the confirmed publication operation receipt and exact URL/revision"
                )
        original = store.get_mapping("project", "goal")
        if original and original["payload"].get("delivery") != deliverable["kind"]:
            raise ProjectError(
                "delivered endpoint does not satisfy the recorded project request"
            )
        if store.pending_operations():
            raise ProjectError("uncertain operations prevent verified closure")
        if not store.artifact_inventory()["complete"]:
            raise ProjectError("missing or corrupt artifacts prevent verified closure")
        integrator = Integrator(
            Path(record["repo_root"]),
            record["project_id"],
            self.config.state_root / record["project_id"],
        )
        integrator.verify_revision(revision)
        snapshot = self._remote(credentials).snapshot(credentials["multica_project_id"])
        if any(
            control.get("delivery_reserved") or control.get("outcome_unknown")
            for control in snapshot.get("controls", [])
        ):
            raise ProjectError(
                "unresolved or reserved instruction delivery prevents verified closure"
            )
        epic_mapping = store.get_mapping("epic", "main")
        epic_id = epic_mapping["payload"]["issue_id"] if epic_mapping else None
        for task in snapshot.get("tasks", snapshot.get("issues", [])):
            if task["id"] == epic_id:
                continue
            state = task.get("status", task.get("state"))
            if state not in {"done", "completed", "accepted"}:
                raise ProjectError(
                    "backend contains unfinished/cancelled work; record an explicit scope decision first"
                )
            accepted = store.get_mapping("accepted_task", task["id"])
            if not accepted:
                raise ProjectError(
                    "backend completion requires recorded coordinator acceptance evidence"
                )
            if not integrator.includes_range(
                accepted["payload"]["base_sha"],
                accepted["payload"]["revision"],
                revision,
            ):
                raise ProjectError(
                    "accepted task revision is absent from the verified integration"
                )
            attempts = [
                run
                for run in snapshot.get("runs", [])
                if run.get("issue_id") == task["id"]
            ]
            if attempts and (
                accepted["payload"].get("run_id") != attempts[-1]["id"]
                or attempts[-1]["status"] not in {"completed", "succeeded"}
            ):
                raise ProjectError(
                    "a newer unsuccessful/unaccepted attempt prevents project closure"
                )
        if any(
            run.get("status") in ACTIVE_RUN_STATUSES for run in snapshot.get("runs", [])
        ):
            raise ProjectError("active backend attempts prevent project closure")
        if epic_id:
            self._command(
                store,
                credentials,
                "update_task",
                {"issue_id": epic_id, "status": "done"},
                str(
                    uuid.uuid5(
                        uuid.UUID(record["project_id"]), "epic-close:" + revision
                    )
                ),
            )
        store.append_event(
            "project.closed",
            evidence,
            actor=credentials["owner"],
            generation=credentials["generation"],
        )
        store.put_mapping(
            "project",
            "closure",
            evidence,
            credentials["owner"],
            credentials["generation"],
        )
        return {
            "project_id": record["project_id"],
            "status": "closed",
            "revision": revision,
            "deliverable": deliverable,
            "sessions_preserved": True,
            "audit": "available with project audit",
        }


def credential_for(config: Config, action: str, project: str | None = None) -> str:
    if action in {"start", "main", "resume", "list", "restore", "remap", "recovery"}:
        return private_read(config.state_root / "control.key").strip()
    if project is None:
        raise AuthorizationError("project reference required for scoped credentials")
    record = ProjectRegistry(config.state_root).resolve(project)
    credentials = json.loads(
        private_read(config.state_root / record["project_id"] / "coordinator.json")
    )
    return str(credentials["local_token"])
