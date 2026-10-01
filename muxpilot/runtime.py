"""Owned Git resources and a daemon-owned, protocol-preserving worker bridge.

This module is deliberately not a worker scheduler. Multica supplies each run
and execution identity and owns the process calling :class:`ProviderBridge`.
The project service can inspect its durable receipts without owning its stdio.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote, urlsplit

from tmux_console.control_cli import (
    ControlClient,
    ControlError,
    PartialSuccess,
    _validate_identity,
    is_loopback_url,
    launch_session,
)
from tmux_console.stdio_bridge import is_lightweight_probe
from tmux_console.stdio_bridge import run as bridge_run
from tmux_console.stdio_capture import CodexCaptureSanitizer
from tmux_console.stdio_runner import StreamingRedactor


class RuntimeErrorBase(RuntimeError):
    """A resource or provider operation could not be safely completed."""


class ResourceConflict(RuntimeErrorBase):
    pass


class ExecutionConflict(RuntimeErrorBase):
    pass


class CapabilityError(RuntimeErrorBase):
    pass


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError(f"{label} must contain 1-128 letters, digits, '_' or '-'")
    return value


def _uuid(value: str, label: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError(f"{label} must be a UUID") from error


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ResourceConflict("private state directory is not a real directory")
    os.chmod(path, 0o700)


def _atomic(path: Path, content: bytes) -> None:
    """Commit bytes before referencing them; preserve restrictive file modes."""
    _private_directory(path.parent)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _json_write(path: Path, value: dict[str, Any]) -> None:
    _atomic(path, (json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode())


def _json_read(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise ResourceConflict("state file is a symlink")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ResourceConflict("state file is not a JSON object")
    return value


@contextlib.contextmanager
def _lock(path: Path, *, blocking: bool = True):
    _private_directory(path.parent)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(descriptor)


def _git(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(["git", "-C", str(repository), *arguments], capture_output=True, check=False)
    if result.returncode:
        raise ResourceConflict(result.stderr.decode("utf-8", errors="replace").strip() or "Git operation failed")
    return result.stdout


class _FencedClient(ControlClient):
    """Propagate receiver authority into launch_session's placement requests."""

    def __init__(self, client: Any, project_id: str, owner: str, generation: int, operation_id: str):
        self.client = client
        self.envelope = {"projectId": project_id, "owner": owner, "generation": generation}
        self.operation_id = uuid.UUID(operation_id)

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if method not in {"GET", "HEAD"} and path.startswith("/api/workspaces"):
            payload = dict(payload or {})
            if "muxpilot" not in payload:
                correlation = f"{method}:{path}:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
                payload["muxpilot"] = {**self.envelope, "operationId": str(uuid.uuid5(self.operation_id, correlation))}
        return self.client.request(method, path, payload)


@dataclass(frozen=True)
class ResourceAllocation:
    project_id: str
    task_id: str
    run_id: str
    repository: str
    worktree: str
    branch: str
    base_sha: str
    dirty_baseline: bool
    snapshot_artifact: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class WorkerAllocator:
    """Allocate one independently owned worktree per authoritative run.

    A dirty source checkout is snapshotted and left intact. The worktree starts
    at the selected committed baseline; uncommitted edits are never silently
    included in a delegated task. An existing branch/path without our matching
    receipt is a conflict, including an interrupted allocation.
    """

    def __init__(self, state_root: str | Path, *, snapshot_limit: int = 32 * 1024 * 1024):
        self.state_root = Path(state_root).expanduser().resolve()
        self.snapshot_limit = snapshot_limit
        _private_directory(self.state_root)

    def allocate(self, project_id: str, task_id: str, run_id: str,
                 repository: str | Path, *, base_sha: str | None = None) -> ResourceAllocation:
        project_id = _uuid(project_id, "project_id")
        task_id, run_id = _identifier(task_id, "task_id"), _identifier(run_id, "run_id")
        repository = Path(repository).expanduser().resolve(strict=True)
        repository = Path(_git(repository, "rev-parse", "--show-toplevel").decode().strip()).resolve()
        # Treat the selected revision as a literal rev, never an option.
        if base_sha is not None and (not base_sha or base_sha.startswith("-") or "\0" in base_sha):
            raise ValueError("invalid baseline revision")
        selected = _git(repository, "rev-parse", "--verify", (base_sha or "HEAD") + "^{commit}").decode().strip()
        run_root = self.state_root / project_id / "runs" / run_id
        receipt = run_root / "allocation.json"
        worktree = self.state_root / project_id / "worktrees" / run_id
        branch = f"muxpilot/{project_id[:8]}/{run_id}"
        with _lock(run_root / "allocation.lock"):
            if receipt.exists():
                prior = _json_read(receipt)
                identity = (prior.get("project_id"), prior.get("task_id"), prior.get("run_id"), prior.get("repository"))
                if identity != (project_id, task_id, run_id, str(repository)) or (base_sha and selected != prior.get("base_sha")):
                    raise ResourceConflict("run allocation identity or baseline changed")
                if prior.get("worktree") != str(worktree) or prior.get("branch") != branch or not re.fullmatch(r"[0-9a-f]{40,64}", str(prior.get("base_sha", ""))):
                    raise ResourceConflict("allocation receipt has inconsistent resource paths or revision")
                if prior.get("state") != "allocated":
                    raise ResourceConflict("allocation outcome is uncertain; inspect owned resources before retry")
                if not worktree.is_dir() or worktree.is_symlink():
                    raise ResourceConflict("owned worktree is missing or moved")
                if _git(worktree, "symbolic-ref", "--short", "HEAD").decode().strip() != branch:
                    raise ResourceConflict("owned worktree branch changed")
                return ResourceAllocation(**{field: prior[field] for field in ResourceAllocation.__dataclass_fields__})
            if worktree.exists() or worktree.is_symlink():
                raise ResourceConflict("worktree path already exists without an ownership receipt")
            branches = _git(repository, "for-each-ref", "--format=%(refname:short)", "refs/heads").decode().splitlines()
            if branch in branches:
                raise ResourceConflict("worker branch already exists without an ownership receipt")
            status = _git(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all")
            snapshot_artifact = None
            if status:
                # Binary diff covers staged and unstaged tracked content. Capture
                # regular untracked files as bytes, never follow external links.
                patch = _git(repository, "diff", "--binary", "HEAD")
                files = _git(repository, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
                untracked, byte_count = [], len(patch)
                if byte_count > self.snapshot_limit:
                    raise ResourceConflict("dirty baseline snapshot exceeds configured limit")
                for raw_path in files:
                    if not raw_path:
                        continue
                    relative = os.fsdecode(raw_path)
                    path = repository / relative
                    if path.is_symlink() or not path.is_file():
                        raise ResourceConflict("dirty baseline contains a non-regular untracked path")
                    if path.stat().st_size + byte_count > self.snapshot_limit:
                        raise ResourceConflict("dirty baseline snapshot exceeds configured limit")
                    content = path.read_bytes()
                    byte_count += len(content)
                    if byte_count > self.snapshot_limit:
                        raise ResourceConflict("dirty baseline snapshot exceeds configured limit")
                    untracked.append({"path": relative, "content_base64": base64.b64encode(content).decode(),
                                      "sha256": hashlib.sha256(content).hexdigest()})
                snapshot = run_root / "baseline-snapshot.json"
                _json_write(snapshot, {"base_sha": selected, "status_base64": base64.b64encode(status).decode(),
                                       "patch_base64": base64.b64encode(patch).decode(), "untracked": untracked})
                snapshot_artifact = str(snapshot)
            allocation = ResourceAllocation(project_id, task_id, run_id, str(repository), str(worktree),
                                            branch, selected, bool(status), snapshot_artifact)
            _json_write(receipt, {**allocation.to_dict(), "state": "allocating"})
            _private_directory(worktree.parent)
            _git(repository, "worktree", "add", "-b", branch, str(worktree), selected)
            _json_write(receipt, {**allocation.to_dict(), "state": "allocated"})
            return allocation

    def inventory(self, project_id: str) -> list[dict[str, Any]]:
        project_id = _uuid(project_id, "project_id")
        rows = []
        for path in sorted((self.state_root / project_id / "runs").glob("*/allocation.json")):
            row = _json_read(path)
            row["worktree_exists"] = Path(row["worktree"]).is_dir()
            rows.append(row)
        return rows


@dataclass(frozen=True)
class ExecutionContext:
    state_root: str
    project_id: str
    task_id: str
    run_id: str
    execution_id: str
    worktree: str
    coordinator_owner: str | None = None
    generation: int | None = None
    muxdeck_url: str = "http://127.0.0.1:7683/mux"
    muxdeck_public_url: str | None = None
    token_file: str = ""
    workspace_id: str | None = None
    group_id: str | None = None
    group_name: str = "Workers"
    epic_id: str | None = None
    provider: str = "stdio"
    helper_policy: str = "unavailable"
    output_limit: int = 32 * 1024 * 1024

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_id", _uuid(self.project_id, "project_id"))
        object.__setattr__(self, "execution_id", _uuid(self.execution_id, "execution_id"))
        _identifier(self.task_id, "task_id")
        _identifier(self.run_id, "run_id")
        if not Path(self.worktree).is_absolute() or not Path(self.worktree).is_dir():
            raise ValueError("worker directory must be an existing absolute directory")
        if self.group_id and not self.workspace_id:
            raise ValueError("worker group requires a workspace")
        if not is_loopback_url(self.muxdeck_url):
            raise ValueError("provider stdio bridge requires a same-host loopback Muxdeck URL")
        if self.muxdeck_public_url is not None:
            _public_url(self.muxdeck_public_url)
        if self.coordinator_owner is not None and (not isinstance(self.coordinator_owner, str) or
                not self.coordinator_owner or len(self.coordinator_owner) > 256 or
                any(ord(char) < 32 for char in self.coordinator_owner)):
            raise ValueError("invalid coordinator_owner")
        if self.generation is not None and (isinstance(self.generation, bool) or not isinstance(self.generation, int) or self.generation <= 0):
            raise ValueError("generation must be positive")
        if isinstance(self.output_limit, bool) or not isinstance(self.output_limit, int) or self.output_limit < 0:
            raise ValueError("output_limit must be a nonnegative byte count")
        if self.helper_policy not in {"unavailable", "disable_multi_agent"}:
            raise ValueError("unsupported provider helper policy")
        if self.helper_policy == "disable_multi_agent" and self.provider != "codex":
            raise CapabilityError("multi_agent feature control is only qualified for the Codex CLI")

    @property
    def directory(self) -> Path:
        return Path(self.state_root).expanduser().resolve() / self.project_id / "runs" / self.run_id / "executions" / self.execution_id

    @property
    def request_id(self) -> str:
        return "muxpilot-" + hashlib.sha256(f"{self.project_id}:{self.run_id}:{self.execution_id}".encode()).hexdigest()

    @property
    def session_name(self) -> str:
        return f"mxp-{self.project_id[:8]}-{self.execution_id.replace('-', '')[:20]}"


class _Capture:
    """Retain bounded, redacted evidence after bytes reach the daemon."""

    def __init__(self, artifact: Path, transcript: BinaryIO,
                 kind: str, limit: int, transcript_lock: threading.Lock, secrets: tuple[bytes, ...],
                 *, structured: bool = False):
        self.artifact = artifact
        self.kind, self.limit, self.transcript = kind, limit, transcript
        self.transcript_lock = transcript_lock
        self.total = self.retained = 0
        self.sanitized_total = 0
        self.structured = structured
        self.redactor = CodexCaptureSanitizer(secrets, redactor_factory=StreamingRedactor) if structured else StreamingRedactor(secrets)
        self.representation = "sanitized codex-app-server JSONL" if structured else "redacted provider bytes"
        descriptor = os.open(artifact, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.file = os.fdopen(descriptor, "wb")

    def observe(self, content: bytes) -> None:
        self.total += len(content)
        self._retain(self.redactor.feed(content))

    def _retain(self, content: bytes) -> None:
        self.sanitized_total += len(content)
        retained = content[:max(0, self.limit - self.retained)]
        if retained:
            self.file.write(retained)
            self.file.flush()
            self.retained += len(retained)
            row = {"stream": self.kind, "observed_at": time.time(), "bytes_base64": base64.b64encode(retained).decode(),
                   "representation": self.representation}
            with self.transcript_lock:
                self.transcript.write((json.dumps(row, sort_keys=True) + "\n").encode())
                self.transcript.flush()

    def close(self) -> dict[str, Any]:
        self._retain(self.redactor.feed(b"", final=True))
        self.file.flush()
        os.fsync(self.file.fileno())
        self.file.close()
        structured = self.redactor if isinstance(self.redactor, CodexCaptureSanitizer) else None
        omitted_records = structured.omitted_records if structured else 0
        omitted_deltas = structured.omitted_deltas if structured else 0
        truncated = self.sanitized_total > self.retained
        return {"path": str(self.artifact), "sha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest(),
                "byte_count": self.retained, "observed_byte_count": self.total,
                "truncated": truncated, "complete": not (truncated or omitted_records or omitted_deltas),
                "redacted": self.redactor.redacted, "representation": self.representation,
                "omitted_records": omitted_records, "omitted_deltas": omitted_deltas,
                "coverage": "decoded complete strings and per-item delta text sanitized; synthetic tail flushes; malformed/oversize records omitted"
                            if self.structured else "delivered provider bytes with known credential values redacted"}


class ProviderBridge:
    """Run a Multica-owned invocation through Muxdeck's existing stdio bridge.

    Each actual invocation requires a new daemon-assigned execution UUID. A
    repeated UUID returns a conflict containing the retained evidence location;
    it cannot attach a new socket to an old bridge or launch another provider.
    """

    def __init__(self, context: ExecutionContext, *, client: Any = None,
                 event_callback: Callable[[str, dict[str, Any]], None] | None = None,
                 secret_values: tuple[str, ...] = ()):
        self.context = context
        self.client = client
        self.event_callback = event_callback
        self.secret_values = secret_values

    def _event(self, kind: str, payload: dict[str, Any]) -> None:
        if self.event_callback:
            self.event_callback(kind, payload)

    def run(self, command: list[str], *, stdin: BinaryIO, stdout: BinaryIO, stderr: BinaryIO,
            environment: dict[str, str] | None = None) -> int:
        if not command or not all(isinstance(arg, str) and "\0" not in arg for arg in command):
            raise ValueError("valid literal provider argv is required")
        environment = dict(os.environ if environment is None else environment)
        secrets = [value.encode() for value in self.secret_values if value]
        secrets.extend(value.encode() for key, value in environment.items()
                       if re.search(r"(?:TOKEN|SECRET|PASSWORD|API_KEY)$", key, re.IGNORECASE) and len(value) >= 4)
        if self.context.token_file:
            secrets.append(Path(self.context.token_file).read_bytes().strip())
        # The wrapper is trusted runtime infrastructure; the actual worker is
        # not given the wrapper's broad controller credential references.
        for key in tuple(environment):
            if key in {"MUXPILOT_CONFIG", "MUXDECK_CONTROL_TOKEN_FILE", "MUXPILOT_COORDINATOR_TOKEN_FILE"}:
                environment.pop(key)
        environment.update({"MUXPILOT_ROLE": "worker", "MUXPILOT_PROJECT_ID": self.context.project_id,
                            "MUXPILOT_TASK_ID": self.context.task_id, "MUXPILOT_RUN_ID": self.context.run_id,
                            "MUXPILOT_EXECUTION_ID": self.context.execution_id})
        if is_lightweight_probe(command):
            return bridge_run(command, cwd=self.context.worktree, environment=environment,
                              stdin=stdin, stdout=stdout, stderr=stderr)
        if self.context.coordinator_owner is None or self.context.generation is None:
            raise ValueError("managed provider execution requires coordinator owner and generation")
        if self.context.helper_policy == "disable_multi_agent":
            for index, argument in enumerate(command):
                if argument == "--enable=multi_agent" or (argument == "--enable" and index + 1 < len(command) and command[index + 1] == "multi_agent"):
                    raise CapabilityError("worker cannot enable hidden multi_agent delegation")
                if re.search(r"features\.multi_agent\s*=\s*true", argument):
                    raise CapabilityError("worker cannot override the helper control policy")
            # The qualified Codex CLI/app-server exposes this global feature
            # option. Original daemon arguments retain their order and values.
            command = [*command, "--disable", "multi_agent"]
        directory = self.context.directory
        _private_directory(directory)
        try:
            with _lock(directory / "execution.lock", blocking=False):
                return self._run_owned(command, stdin, stdout, stderr, environment, tuple(secrets))
        except BlockingIOError as error:
            raise ExecutionConflict("provider execution is already owned by another invocation") from error

    def _run_owned(self, command: list[str], stdin: BinaryIO, stdout: BinaryIO,
                   stderr: BinaryIO, environment: dict[str, str], secrets: tuple[bytes, ...]) -> int:
        directory = self.context.directory
        execution_file = directory / "execution.json"
        if execution_file.exists():
            prior = _json_read(execution_file)
            raise ExecutionConflict(f"execution already recorded as {prior.get('state', 'unknown')}; inspect {execution_file}")
        request_hash = hashlib.sha256(json.dumps(command, ensure_ascii=True).encode()).hexdigest()
        identity = {"project_id": self.context.project_id, "task_id": self.context.task_id,
                    "run_id": self.context.run_id, "execution_id": self.context.execution_id,
                    "task_attempt_id": self.context.run_id, "issue_id": self.context.task_id,
                    "request_id": self.context.request_id, "session_name": self.context.session_name,
                    "workspace_id": self.context.workspace_id, "group_id": self.context.group_id,
                    "epic_id": self.context.epic_id,
                    "worktree": self.context.worktree, "provider": self.context.provider,
                    "helper_control": {"policy": self.context.helper_policy,
                                       "enforced": self.context.helper_policy == "disable_multi_agent",
                                       "provider_native_history": "unavailable",
                                       "boundary": "supported provider feature control; not a Unix process sandbox"},
                    "command_hash": request_hash, "started_at": time.time()}
        _json_write(execution_file, {**identity, "state": "launching"})
        self._event("execution.prepared", identity)
        assert self.context.coordinator_owner is not None and self.context.generation is not None
        client = _FencedClient(self.client or ControlClient(self.context.muxdeck_url, self.context.token_file),
                               self.context.project_id, self.context.coordinator_owner,
                               self.context.generation, self.context.execution_id)

        def launch(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            if method != "POST" or path != "/api/sessions" or payload is None:
                return client.request(method, path, payload)
            try:
                # Workspace groups require at least one tab. Serialize first
                # worker placement so the first launch can create its epic
                # group without a dummy agent/session or two competing creates.
                with _lock(Path(self.context.state_root) / self.context.project_id / "placement.lock"):
                    group = self.context.group_id
                    group_exists = False
                    if group:
                        assert self.context.workspace_id is not None
                        workspace = client.request("GET", "/api/workspaces/" + quote(self.context.workspace_id, safe=""))["workspace"]
                        group_exists = any(item["id"] == group for item in workspace.get("groups", []))
                    created = launch_session(client, payload, workspace=self.context.workspace_id,
                                             group=group if group_exists else None)
                    if group and not group_exists:
                        assert self.context.workspace_id is not None
                        _json_write(directory / "session.json", {**identity, "receipt": created, "placement": "pending_group"})
                        workspace = client.request("GET", "/api/workspaces/" + quote(self.context.workspace_id, safe=""))["workspace"]
                        try:
                            client.request("POST", "/api/workspaces/" + quote(self.context.workspace_id, safe="") + "/groups",
                                           {"group": {"id": group, "name": self.context.group_name, "color": "cyan",
                                                      "collapsed": False, "tabs": [created["session"]]},
                                            "sessionRevision": workspace["sessionRevision"],
                                            "muxpilot": {"projectId": self.context.project_id,
                                                         "owner": self.context.coordinator_owner,
                                                         "generation": self.context.generation,
                                                         "operationId": str(uuid.uuid5(uuid.UUID(self.context.execution_id), "group-placement"))}})
                        except Exception as error:
                            placement_error = error if isinstance(error, ControlError) else ControlError("worker grouping failed")
                            raise PartialSuccess(created, placement_error) from error
            except PartialSuccess as error:
                _json_write(directory / "session.json", {**identity, "receipt": error.created, "placement": "failed"})
                raise
            full_identity = _validate_identity(created)
            history_id = None
            history_error = None
            try:
                historical = client.request("GET", "/api/worker-terminal?" + "&".join(
                    f"{quote(key, safe='')}={quote(str(value), safe='')}" for key, value in full_identity.items()))
                history_id = historical.get("historyId")
            except (ControlError, OSError, ValueError, KeyError) as error:
                # Older Muxdeck versions may lack the resolver. The immutable
                # session identity still permits reconciliation; history missing
                # is recorded explicitly rather than guessed from a name.
                history_error = type(error).__name__
            binding = {**identity, "receipt": created, "identity": full_identity, "placement": "confirmed",
                       "history_reference": history_id,
                       "history_error": history_error,
                       "terminal_url": terminal_url(self.context.muxdeck_public_url or self.context.muxdeck_url, self.context.workspace_id,
                                                    full_identity, history_id=history_id,
                                                    run_id=self.context.run_id, execution_id=self.context.execution_id)}
            _json_write(directory / "session.json", binding)
            _json_write(execution_file, {**identity, "state": "running"})
            self._event("session.associated", binding)
            return created

        transcript_descriptor = os.open(directory / "transcript.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        transcript_lock = threading.Lock()
        structured = self.context.provider == "codex" and "app-server" in command[1:]
        with os.fdopen(transcript_descriptor, "wb") as transcript:
            output = _Capture(directory / "stdout.bin", transcript, "stdout", self.context.output_limit, transcript_lock, secrets,
                              structured=structured)
            errors = _Capture(directory / "stderr.bin", transcript, "stderr", self.context.output_limit, transcript_lock, secrets)
            status, failure = None, None
            try:
                status = bridge_run(command, api=launch, cwd=self.context.worktree, environment=environment,
                                    launch_options={"name": self.context.session_name, "requestId": self.context.request_id,
                                                    "environment": {"MUXPILOT_PROJECT_ID": self.context.project_id},
                                                    "muxpilot": {"projectId": self.context.project_id,
                                                                 "owner": self.context.coordinator_owner,
                                                                 "generation": self.context.generation,
                                                                 "operationId": self.context.execution_id}},
                                    stdin=stdin, stdout=stdout, stderr=stderr,
                                    mirror_secrets=secrets,
                                    mirror_format="codex-app-server-v1" if structured else None,
                                    output_observer=lambda kind, content: (output if kind == "stdout" else errors).observe(content))
                return status
            except BaseException as error:
                # No exception text: provider/API diagnostics can contain private
                # launch details. The daemon gets its original exception.
                failure = type(error).__name__
                raise
            finally:
                evidence = {"stdout": output.close(), "stderr": errors.close()}
                transcript.flush()
                os.fsync(transcript.fileno())
                state = "completed" if status is not None else "outcome_unknown"
                result = {**identity, "state": state, "exit_status": status, "error_type": failure,
                          "finished_at": time.time(), "artifacts": evidence,
                          "capture_complete": all(item["complete"] for item in evidence.values()),
                          "coverage": "sanitized provider capture; structured stdout is transformed JSONL; process exit is not task acceptance"}
                _json_write(execution_file, result)
                self._event("execution.observed", result)


def _public_url(value: str) -> str:
    parts = urlsplit(value)
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or (
            parts.scheme != "https" and not is_loopback_url(value)):
        raise ValueError("public Muxdeck URL requires HTTPS or local HTTP, without credentials/query/fragment")
    return value.rstrip("/")


def terminal_url(base_url: str, workspace_id: str | None,
                 identity: dict[str, Any], *, history_id: str | None = None,
                 run_id: str | None = None, execution_id: str | None = None) -> str:
    """A link includes the full incarnation; clients must validate before use."""
    _validate_identity(identity)
    base_url = _public_url(base_url)
    parameters = {**identity, **({"workspace": workspace_id} if workspace_id else {}),
                  **({"historyId": history_id} if history_id else {}),
                  **({"runId": run_id} if run_id else {}),
                  **({"providerExecutionId": execution_id} if execution_id else {})}
    return base_url.rstrip("/") + "/worker?" + "&".join(f"{quote(str(key), safe='')}={quote(str(value), safe='')}" for key, value in parameters.items())


def inspect_execution(context: ExecutionContext, *, max_bytes: int = 65536) -> dict[str, Any]:
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 0 <= max_bytes <= 1024 * 1024:
        raise ValueError("max_bytes must be from 0 to 1048576")
    directory = context.directory
    result = _json_read(directory / "execution.json")
    if (directory / "session.json").exists():
        result["session"] = _json_read(directory / "session.json")
    result["output"] = {}
    for kind in ("stdout", "stderr"):
        path = directory / f"{kind}.bin"
        if path.exists():
            with path.open("rb") as handle:
                size = path.stat().st_size
                handle.seek(max(0, size - max_bytes))
                result["output"][kind] = {"text": handle.read(max_bytes).decode("utf-8", errors="replace"),
                                          "partial": size > max_bytes, "retained_bytes": size}
    return result


class WorkerControls:
    """Capability-aware exact-run controls through the owning Multica backend.

    Native tmux keys cannot supplement an observation pane. ``pause`` here
    means holding new project dispatch; a provider process freeze is unsupported.
    The backend must authorize/fence/deduplicate each supplied operation envelope.
    """

    def __init__(self, backend: Any, capabilities: dict[str, bool]):
        self.backend, self.capabilities = backend, capabilities

    def control(self, action: str, *, project_id: str, task_id: str, run_id: str,
                execution_id: str | None, operation_id: str, generation: int,
                expected_version: int, message: str | None = None, reason: str = "") -> dict[str, Any]:
        if action not in {"supplement", "interrupt", "cancel", "hold_dispatch", "resume_dispatch"}:
            raise CapabilityError("unsupported control; pause must explicitly mean hold_dispatch or interrupt")
        if not self.capabilities.get(action, False):
            raise CapabilityError(f"provider/backend does not support {action}")
        if action in {"supplement", "interrupt", "cancel"} and not execution_id:
            raise ValueError("live worker control requires an exact execution identity")
        if action == "supplement" and (not isinstance(message, str) or not message.strip()):
            raise ValueError("supplement requires a nonempty message")
        envelope = {"project_id": _uuid(project_id, "project_id"), "task_id": _identifier(task_id, "task_id"),
                    "run_id": _identifier(run_id, "run_id"), "execution_id": _uuid(execution_id, "execution_id") if execution_id else None,
                    "operation_id": _uuid(operation_id, "operation_id"), "generation": generation,
                    "expected_version": expected_version, "action": action, "reason": reason}
        if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
            raise ValueError("generation must be positive")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("expected_version must be nonnegative")
        if message is not None:
            envelope["message"] = message
        return self.backend.control_run(envelope)


def validate_worker_result(allocation: ResourceAllocation, result: dict[str, Any]) -> dict[str, Any]:
    """Validate handoff evidence without equating process exit with acceptance."""
    if any(result.get(field) != getattr(allocation, field) for field in ("project_id", "task_id", "run_id")):
        raise ResourceConflict("result belongs to another project, task, or attempt")
    if result.get("status") not in {"completed", "failed", "blocked", "cancelled"}:
        raise ValueError("result requires an explicit status")
    commit = result.get("commit")
    if result["status"] == "completed":
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            raise ResourceConflict("completed result requires a full commit identity")
        checks = result.get("checks")
        if not isinstance(checks, list) or not checks or any(not isinstance(check, dict) or
                not isinstance(check.get("command"), str) or not check["command"].strip() or
                isinstance(check.get("exit_status"), bool) or not isinstance(check.get("exit_status"), int) or check.get("exit_status") != 0 for check in checks):
            raise ResourceConflict("completed result requires successful verification evidence")
        _git(Path(allocation.worktree), "cat-file", "-e", commit + "^{commit}")
        _git(Path(allocation.worktree), "merge-base", "--is-ancestor", allocation.base_sha, commit)
        if _git(Path(allocation.worktree), "symbolic-ref", "--short", "HEAD").decode().strip() != allocation.branch:
            raise ResourceConflict("worker checkout no longer has its owned branch")
        branch_tip = _git(Path(allocation.worktree), "rev-parse", "HEAD").decode().strip()
        _git(Path(allocation.worktree), "merge-base", "--is-ancestor", commit, branch_tip)
        if result.get("branch") != allocation.branch:
            raise ResourceConflict("result branch does not match the owned worker")
    validated = {**result, "base_sha": allocation.base_sha, "validated_at": time.time(),
                 "task_accepted": False, "coverage": "handoff identity and recorded checks; coordinator must verify integration"}
    return validated


def _receiver_receipt(store: Any, operation_id: str) -> dict[str, Any] | None:
    """Read actual receiver evidence; absence never authorizes repeating an effect."""
    with store.transaction() as database:
        if not database.execute("SELECT 1 FROM sqlite_master WHERE name='receiver_operations'").fetchone():
            return None
        row = database.execute("SELECT state,receipt FROM receiver_operations WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            return None
        if row["state"] != "confirmed":
            raise ExecutionConflict("receiver outcome is uncertain; inspect retained evidence before retry")
        if not row["receipt"]:
            raise ResourceConflict("confirmed receiver receipt is missing")
        receipt = json.loads(row["receipt"])
        if not isinstance(receipt, dict):
            raise ResourceConflict("confirmed receiver receipt is malformed")
        return receipt


def _main_receipt(config: Any, store: Any, operation_id: str, workspace_id: str | None,
                  handoff: str, created: dict[str, Any]) -> dict[str, Any]:
    identity = _validate_identity(created)
    if not isinstance(created.get("session"), str):
        raise ResourceConflict("confirmed main receipt is missing its session")
    public_url = _public_url(getattr(config, "muxdeck_public_url", None) or config.muxdeck_url)
    return {"project_id": store.project_id, "operation_id": operation_id,
            "request_id": "muxpilot-main-" + operation_id,
            "session_name": created["session"], "identity": identity, "receipt": created,
            "workspace_id": workspace_id, "handoff": handoff,
            "terminal_url": public_url + "/session/" + quote(created["session"], safe="") +
                            ("?workspace=" + quote(workspace_id, safe="") if workspace_id else "")}


def launch_main(config: Any, store: Any, command: list[str], repo_root: str | Path,
                owner: str, generation: int, operation_id: str,
                workspace_id: str | None = None, *, client: Any = None) -> dict[str, Any]:
    """Launch one visible coordinator with a durable, fenced explicit handoff.

    Installing/loading its tools and deciding when a prior conversation stops
    coordinating are caller responsibilities. This launches an interactive
    command; projectd does not hold its stdio or own its process lifetime.
    """
    repository = Path(repo_root).expanduser().resolve(strict=True)
    _public_url(getattr(config, "muxdeck_public_url", None) or config.muxdeck_url)
    if not repository.is_dir() or not command or not all(isinstance(arg, str) and "\0" not in arg for arg in command):
        raise ValueError("main requires an existing repository and literal command argv")
    operation_id = _uuid(operation_id, "operation_id")
    handoff = "explicit visible main; caller must cease conflicting coordination"
    payload = {"repository": str(repository), "command_hash": hashlib.sha256(json.dumps(command).encode()).hexdigest(),
               "workspace_id": workspace_id, "handoff": handoff}
    prepared = store.prepare_operation(operation_id, "main.launch", payload, owner, generation)
    if prepared["state"] == "confirmed":
        if store.get_mapping("main_session", "main") is None:
            store.put_mapping("main_session", "main", prepared["receipt"], owner, generation)
        return prepared["receipt"]
    receiver_receipt = _receiver_receipt(store, operation_id)
    if receiver_receipt is not None and prepared["state"] in {"prepared", "dispatched", "uncertain"}:
        receipt = _main_receipt(config, store, operation_id, workspace_id, handoff, receiver_receipt)
        store.reconcile_operation(operation_id, "confirmed", owner, generation, receipt=receipt)
        if store.get_mapping("main_session", "main") is None:
            store.put_mapping("main_session", "main", receipt, owner, generation)
        return receipt
    if prepared["state"] != "prepared":
        raise ExecutionConflict("main launch outcome must be reconciled before retry")
    existing = store.get_mapping("main_session", "main")
    if existing is not None:
        store.reject_operation(operation_id, "project already has a coordinator session", owner, generation)
        raise ExecutionConflict("project already has a coordinator session; reconcile/adopt it before replacement")
    # A second operation must not bypass an uncertain launch under another ID.
    if any(row["kind"] == "main.launch" and row["operation_id"] != operation_id for row in store.pending_operations()):
        store.reject_operation(operation_id, "another coordinator launch awaits reconciliation", owner, generation)
        raise ExecutionConflict("another coordinator launch awaits reconciliation")
    client = _FencedClient(client or ControlClient(config.muxdeck_url, config.muxdeck_token_file),
                           store.project_id, owner, generation, operation_id)
    request_id = "muxpilot-main-" + operation_id
    launch_payload = {"name": "mxp-main-" + store.project_id[:8], "directory": str(repository),
                      "launchMode": "command", "command": command, "remainOnExit": True,
                      "requestId": request_id, "environment": {"MUXPILOT_PROJECT_ID": store.project_id},
                      "muxpilot": {"projectId": store.project_id, "owner": owner,
                                   "generation": generation, "operationId": operation_id}}
    store.mark_dispatched(operation_id, owner, generation)
    try:
        store.assert_lease(owner, generation)
        # The Muxdeck receiver holds authority_guard across the actual effect.
        # Holding the same SQLite writer lock here would deadlock its receiver.
        created = launch_session(client, launch_payload, workspace=workspace_id)
        _validate_identity(created)
    except BaseException as error:
        # A receipt can have been lost after tmux creation. Never blindly retry
        # with a new request ID, even if an exception looked like a transport error.
        with contextlib.suppress(Exception):
            store.mark_uncertain(operation_id, type(error).__name__, owner, generation)
        raise
    receipt = _main_receipt(config, store, operation_id, workspace_id, handoff, created)
    store.complete_operation(operation_id, receipt, owner, generation)
    store.put_mapping("main_session", "main", receipt, owner, generation)
    return receipt


def ensure_project_workspace(config: Any, store: Any, owner: str, generation: int,
                             name: str, main_session: str | None = None,
                             *, client: Any = None) -> dict[str, Any]:
    """Create/reuse navigation and private dynamic worker configuration.

    The first worker creates the nonempty epic group. The coordinator remains
    outside that group. An uncertain workspace create cannot be retried blindly.
    """
    public_url = _public_url(getattr(config, "muxdeck_public_url", None) or config.muxdeck_url)
    client = client or ControlClient(config.muxdeck_url, config.muxdeck_token_file)
    store.assert_lease(owner, generation)
    mapping = store.get_mapping("muxdeck_workspace", "project")
    if mapping:
        workspace_id = mapping["payload"]["workspace_id"]
        workspace = client.request("GET", "/api/workspaces/" + quote(workspace_id, safe=""))["workspace"]
    else:
        operation_id = str(uuid.uuid5(uuid.UUID(store.project_id), "workspace-create"))
        intent = {"name": name, "main_session": main_session}
        operation = store.prepare_operation(operation_id, "workspace.create", intent, owner, generation)
        if operation["state"] == "confirmed":
            workspace = operation["receipt"]["workspace"]
        else:
            receiver_receipt = _receiver_receipt(store, operation_id)
            if receiver_receipt is not None and operation["state"] in {"prepared", "dispatched", "uncertain"}:
                workspace = receiver_receipt.get("workspace")
                if not isinstance(workspace, dict) or not isinstance(workspace.get("id"), str):
                    raise ResourceConflict("confirmed workspace receipt is missing its identity")
                store.reconcile_operation(operation_id, "confirmed", owner, generation, receipt={"workspace": workspace})
            elif operation["state"] != "prepared":
                raise ExecutionConflict("workspace creation outcome must be reconciled")
            else:
                workspace = None
        if operation["state"] == "prepared" and workspace is None:
            store.mark_dispatched(operation_id, owner, generation)
            try:
                response = client.request("POST", "/api/workspaces",
                                          {"name": name, "tabs": [main_session] if main_session else [],
                                           "activeSession": main_session,
                                           "muxpilot": {"projectId": store.project_id, "owner": owner,
                                                        "generation": generation, "operationId": operation_id}})
                workspace = response["workspace"]
            except Exception as error:
                with contextlib.suppress(Exception):
                    store.mark_uncertain(operation_id, type(error).__name__, owner, generation)
                raise
            store.complete_operation(operation_id, {"workspace": workspace}, owner, generation)
        workspace_id = workspace["id"]
        store.put_mapping("muxdeck_workspace", "project", {"workspace_id": workspace_id}, owner, generation)
    epic_mapping = store.get_mapping("epic", "main")
    epic_id = epic_mapping["payload"].get("issue_id") if epic_mapping else None
    group_id = "epic-" + epic_id[:8] if epic_id else "workers-" + store.project_id[:8]
    configuration_path = Path(config.state_root) / store.project_id / "worker.json"
    runtime_config = {"state_root": str(config.state_root), "project_id": store.project_id,
                      "coordinator_owner": owner, "generation": generation,
                      "muxdeck_url": config.muxdeck_url, "token_file": str(config.muxdeck_token_file),
                      "muxdeck_public_url": getattr(config, "muxdeck_public_url", None),
                      "workspace_id": workspace_id, "group_id": group_id,
                      "epic_id": epic_id, "group_name": name,
                      "provider": "codex", "helper_policy": "disable_multi_agent"}
    backend_mapping = store.get_mapping("project", "multica")
    if backend_mapping and backend_mapping["payload"].get("backend_generation") is not None:
        runtime_config["backend_generation"] = backend_mapping["payload"]["backend_generation"]
    _json_write(configuration_path, runtime_config)
    return {"workspace_id": workspace_id, "group_id": group_id, "worker_config_path": str(configuration_path),
            "workspace_url": public_url + "/?workspace=" + quote(workspace_id, safe=""),
            "group_state": "created_on_first_worker"}
