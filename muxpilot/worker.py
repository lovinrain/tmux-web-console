"""Executable wrapper selected as a Multica custom provider runtime.

The daemon supplies fresh execution IDs and retains ownership of stdin/stdout.
No prompts, diagnostic JSON, or launch receipts enter provider stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from pathlib import Path

from tmux_console.stdio_bridge import is_lightweight_probe

from .runtime import ExecutionContext, ProviderBridge, RuntimeErrorBase
from .store import JournalStore, StoreError


def load_context(config_path: str | None = None, *, environment: dict[str, str] | None = None) -> ExecutionContext:
    environment = dict(os.environ if environment is None else environment)
    path = config_path or environment.get("MUXPILOT_CONFIG")
    configuration = {}
    if path:
        source = Path(path).expanduser()
        if source.is_symlink() or not source.is_file() or stat.S_IMODE(source.stat().st_mode) & 0o077:
            raise ValueError("worker configuration must be a private regular file")
        configuration = json.loads(source.read_text())
        if not isinstance(configuration, dict):
            raise ValueError("worker configuration must be a JSON object")
    # A profile can share one installation config. Its daemon-stamped project
    # identity selects private per-project placement/owner data, never a worker
    # supplied arbitrary credential path.
    project_id = environment.get("MUXPILOT_PROJECT_ID")
    if project_id:
        from .runtime import _uuid
        project_id = _uuid(project_id, "project_id")
        if configuration.get("project_id") not in {None, project_id}:
            raise ValueError("runtime profile belongs to another project")
        root = environment.get("MUXPILOT_STATE_ROOT") or configuration.get("state_root")
        if root:
            project_config = Path(root).expanduser() / project_id / "worker.json"
            if project_config.exists():
                if project_config.is_symlink() or stat.S_IMODE(project_config.stat().st_mode) & 0o077:
                    raise ValueError("project runtime configuration must be private")
                dynamic = json.loads(project_config.read_text())
                if not isinstance(dynamic, dict) or dynamic.get("project_id") != project_id:
                    raise ValueError("project runtime configuration identity mismatch")
                configuration.update(dynamic)
    task_attempt = environment.get("MUXPILOT_TASK_ID")
    daemon_generation = int(environment["MUXPILOT_GENERATION"]) if environment.get("MUXPILOT_GENERATION") else None
    backend_generation = configuration.get("backend_generation")
    if backend_generation is not None and daemon_generation != backend_generation:
        raise ValueError("daemon execution belongs to another backend coordinator generation")
    aliases = {
        "state_root": environment.get("MUXPILOT_STATE_ROOT"),
        "project_id": environment.get("MUXPILOT_PROJECT_ID"),
        "task_id": environment.get("MUXPILOT_ISSUE_ID") or task_attempt,
        "run_id": environment.get("MUXPILOT_RUN_ID") or task_attempt,
        "execution_id": environment.get("MUXPILOT_EXECUTION_ID"),
        "coordinator_owner": environment.get("MUXPILOT_OWNER"),
        "generation": daemon_generation if backend_generation is None else None,
        "worktree": environment.get("MUXPILOT_WORKTREE"),
        "muxdeck_url": environment.get("MUXDECK_URL"),
        "muxdeck_public_url": environment.get("MUXDECK_PUBLIC_URL"),
        "token_file": environment.get("MUXDECK_CONTROL_TOKEN_FILE"),
        "workspace_id": environment.get("MUXPILOT_WORKSPACE_ID"),
        "group_id": environment.get("MUXPILOT_GROUP_ID"),
    }
    for key, value in aliases.items():
        if value:
            configuration[key] = value
    if "muxdeck_token_file" in configuration and "token_file" not in configuration:
        configuration["token_file"] = configuration["muxdeck_token_file"]
    configuration.setdefault("worktree", os.getcwd())
    configuration.setdefault("state_root", str(Path(environment.get("XDG_STATE_HOME", "~/.local/state")).expanduser() / "muxdeck" / "projects"))
    fields = ExecutionContext.__dataclass_fields__
    return ExecutionContext(**{key: value for key, value in configuration.items() if key in fields})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Multica-owned provider stdio through a visible Muxdeck terminal")
    parser.add_argument("--config", help="private runtime profile JSON")
    parser.add_argument("--provider", help="absolute real provider executable; provider arguments follow --")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if args.provider:
        command = [args.provider, *command]
    if not command:
        parser.error("a provider executable and literal argument vector are required")
    # Provider discovery is independent of task/execution configuration.
    if is_lightweight_probe(command):
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"MUXPILOT_CONFIG", "MUXDECK_CONTROL_TOKEN_FILE", "MUXPILOT_COORDINATOR_TOKEN_FILE"}}
        status = subprocess.call(command, env=environment)
        return status if status >= 0 else 128 - status
    try:
        context = load_context(args.config)
        secrets = tuple(value for key, value in os.environ.items()
                        if re.search(r"(?:TOKEN|SECRET|PASSWORD|API_KEY)$", key, re.IGNORECASE) and len(value) >= 4)
        if context.token_file:
            secrets += (Path(context.token_file).read_text().strip(),)
        journal = JournalStore(context.state_root, context.project_id, secret_values=secrets)

        def observe(kind: str, payload: dict) -> None:
            if any(payload.get(key) != getattr(context, key) for key in ("project_id", "task_id", "run_id", "execution_id")):
                raise ValueError("execution observation has an inconsistent association")
            event_id = str(uuid.uuid5(uuid.UUID(context.execution_id), kind))
            journal.append_event(kind, payload, actor="runtime:" + context.execution_id,
                                 event_id=event_id, generation=context.generation,
                                 operation_id=context.execution_id, task_id=context.task_id,
                                 run_id=context.run_id, source="runtime", source_event_id=event_id)

        return ProviderBridge(context, event_callback=observe, secret_values=secrets).run(command, stdin=sys.stdin.buffer,
                                           stdout=sys.stdout.buffer, stderr=sys.stderr.buffer)
    except (RuntimeErrorBase, StoreError, ValueError, TypeError, OSError) as error:
        # Do not print tokens, config, command, or environment in diagnostics.
        print(f"muxpilot-worker: {type(error).__name__}; inspect the private execution receipt", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
