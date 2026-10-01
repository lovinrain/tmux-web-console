"""JSON tools for an installed coordinator; also available as muxdeckctl project."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import Config, ConfigurationError


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="muxpilot", description="Private project tools (alias: muxdeckctl project)"
    )
    result.add_argument("--config", type=Path)
    result.add_argument("--state-root", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    commands.add_parser("list")
    restore = commands.add_parser("restore")
    restore.add_argument("--backup", required=True)
    restore.add_argument("--destination", required=True)
    start = commands.add_parser("start")
    start.add_argument("--repo", required=True)
    start.add_argument("--goal", required=True)
    start.add_argument("--name")
    start.add_argument("--owner")
    start.add_argument("--main-session")
    start.add_argument("--main-conversation")
    start.add_argument("--delivery", choices=("commit", "pr"))
    main_parser = commands.add_parser("main")
    main_parser.add_argument("--repo", required=True)
    main_parser.add_argument("--goal", required=True)
    main_parser.add_argument("--owner")
    main_parser.add_argument(
        "--model", help="main model request; defaults to the installed main model"
    )
    main_parser.add_argument("--command-json", type=json.loads)
    for command in (
        "status",
        "agents",
        "plan",
        "activate",
        "hold",
        "stop",
        "control",
        "steer",
        "resume",
        "events",
        "await",
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
        "remap",
        "recovery",
    ):
        child = commands.add_parser(command)
        child.add_argument(
            "project", help="project UUID, canonical repository, or unique name"
        )
        if command == "plan":
            child.add_argument("--file", type=Path, required=True)
        elif command == "activate":
            child.add_argument("--stage", type=int, required=True)
            child.add_argument("--base")
        elif command in {"hold", "stop"}:
            child.add_argument("--off", action="store_true")
        elif command in {"control", "steer"}:
            child.add_argument("--task")
            child.add_argument("--run")
            child.add_argument(
                "--action",
                choices=(
                    "inspect",
                    "instruction",
                    "supplement",
                    "interrupt",
                    "cancel",
                    "continue",
                ),
                default="supplement",
            )
            child.add_argument("--message", default="")
        elif command == "resume":
            child.add_argument("--owner")
            child.add_argument("--takeover", action="store_true")
            child.add_argument("--main-session")
            child.add_argument("--main-conversation")
        elif command in {"events", "await"}:
            child.add_argument("--after", type=int, default=0)
            child.add_argument(
                "--wait", type=float, default=30 if command == "await" else 0
            )
        elif command == "decision":
            child.add_argument("--message", required=True)
            child.add_argument("--ack", type=int, default=0)
        elif command in {"audit", "backup"}:
            child.add_argument("--destination", type=Path, required=command == "backup")
        elif command == "integrate":
            child.add_argument("--commit", required=True)
            child.add_argument("--base")
        elif command == "close":
            child.add_argument("--evidence", type=Path, required=True)
        elif command == "accept":
            child.add_argument("--issue", required=True)
            child.add_argument("--evidence", type=Path, required=True)
        elif command == "remap":
            child.add_argument("--repo", required=True)
            child.add_argument("--reason", required=True)
        elif command == "recovery":
            child.add_argument("--export", type=Path)
        elif command == "operation":
            child.add_argument("--kind", required=True)
            child.add_argument("--payload", type=Path, required=True)
            child.add_argument("--operation-id", required=True)
            child.add_argument("--receipt", type=Path)
        if command in {
            "plan",
            "activate",
            "hold",
            "stop",
            "control",
            "steer",
            "integrate",
            "accept",
        }:
            child.add_argument("--operation-id")
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = list(argv if argv is not None else sys.argv[1:])
    # Optional descriptive namespace, including the muxdeckctl alias.
    index = 0
    while index < len(arguments):
        if arguments[index] in {"--config", "--state-root"}:
            index += 2
        elif arguments[index].startswith(("--config=", "--state-root=")):
            index += 1
        else:
            break
    if index < len(arguments) and arguments[index] == "project":
        arguments.pop(index)
    args = parser().parse_args(arguments)
    try:
        if os.environ.get("MUXPILOT_ROLE") == "worker":
            raise ConfigurationError(
                "worker contexts cannot acquire coordinator or operator credentials; report through the daemon task channel"
            )
        config = Config.load(args.config)
        if args.state_root:
            config = replace(
                config,
                state_root=args.state_root.expanduser().absolute(),
                socket_path=args.state_root.expanduser().absolute() / "projectd.sock",
            )
            # Daemon receives the same concrete configuration even without a config file.
            from dataclasses import asdict

            from .config import private_write

            generated = config.state_root / "service-config.json"
            private_write(
                generated,
                json.dumps(
                    {
                        key: str(value) if isinstance(value, Path) else value
                        for key, value in asdict(config).items()
                    }
                ),
            )
            args.config = generated
        payload: dict[str, Any] = {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
            if key not in {"command", "config", "state_root"} and value is not None
        }
        action = {"await": "events", "stop": "hold", "steer": "control"}.get(
            args.command, args.command
        )
        if args.command in {"hold", "stop"}:
            payload["held"] = not payload.pop("off")
        if action == "plan":
            payload["plan"] = json.loads(Path(payload.pop("file")).read_text())
        if action in {"close", "accept"}:
            payload["evidence"] = json.loads(Path(payload["evidence"]).read_text())
        if action == "operation":
            payload["payload"] = json.loads(Path(payload["payload"]).read_text())
            if payload.get("receipt"):
                payload["receipt"] = json.loads(Path(payload["receipt"]).read_text())
        if action == "start":
            payload["main_pane"] = os.environ.get("TMUX_PANE")
            # Copilot CLI exposes its own session ID to the shell tools of that
            # conversation; binding it lets recovery name this exact main.
            if not payload.get("main_conversation") and os.environ.get(
                "COPILOT_AGENT_SESSION_ID"
            ):
                payload["main_conversation"] = os.environ["COPILOT_AGENT_SESSION_ID"]
        from .service import ensure_service, request

        ensure_service(config.socket_path, args.config)
        from .project import credential_for

        if action not in {"doctor", "health", "ping"}:
            payload["_credential"] = credential_for(
                config, action, payload.get("project")
            )
        result = request(
            config.socket_path,
            action,
            payload,
            timeout=40 if action == "events" else 90,
        )
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    except (ConfigurationError, OSError, ValueError, RuntimeError) as error:
        print(
            json.dumps({"ok": False, "error": str(error)}, sort_keys=True),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
