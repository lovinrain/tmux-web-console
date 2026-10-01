#!/usr/bin/env python3
"""Install the local Muxpilot CLI binding and Codex skill without starting services."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

MARKER = "muxpilot-local-installation-v1"


class InstallationError(ValueError):
    """A target cannot be installed without damaging an existing installation."""


def absolute(value: str | Path) -> Path:
    return Path(value).expanduser().absolute()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment):
        raise argparse.ArgumentTypeError("use an HTTP(S) endpoint without credentials, query or fragment")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise argparse.ArgumentTypeError("HTTP credentials require loopback; use HTTPS for another host")
    return value.rstrip("/")


def positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def service_unit(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_@.:-]+(?:-[A-Za-z0-9_@.:-]+)*\.service", value) or "tmux" in value.lower():
        raise argparse.ArgumentTypeError("use the exact installed Multica .service unit name; tmux is excluded")
    return value


def read_regular(path: Path, *, private: bool = False) -> bytes:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise InstallationError(f"expected a regular file owned by this user: {path}")
        if private and metadata.st_mode & 0o077:
            raise InstallationError(f"expected owner-only permissions: {path}")
        if metadata.st_size > 1024 * 1024:
            raise InstallationError(f"installation file is too large: {path}")
        return stream.read()


def check_directory(path: Path, *, private: bool = False) -> None:
    if not path.exists() and not path.is_symlink():
        return
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise InstallationError(f"expected a directory owned by this user: {path}")
    if private and metadata.st_mode & 0o077:
        raise InstallationError(f"expected a private directory (0700): {path}")


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    descriptor, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temporary.unlink(missing_ok=True)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]), help="validated Muxdeck release directory")
    value.add_argument("--python", help="Python 3.11+ with this release's dependencies; defaults to its .venv/bin/python")
    value.add_argument("--bin-dir", default=str(Path.home() / ".local/bin"))
    value.add_argument("--skills-dir", default=str(Path.home() / ".agents/skills"), help="Codex user skills directory")
    value.add_argument("--legacy-skills-dir", help="optional second skill directory for older local catalogs")
    value.add_argument("--config", default=str(Path.home() / ".config/muxpilot/config.json"))
    value.add_argument("--state-root", default=str(Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "muxdeck/projects"))
    value.add_argument("--socket-path", help="private projectd Unix socket; defaults to STATE_ROOT/projectd.sock")
    value.add_argument("--multica-url", type=endpoint, default="http://127.0.0.1:7331")
    value.add_argument("--multica-ui-url", type=endpoint, help="protected browser URL for the existing Multica board")
    value.add_argument("--multica-token-file", help="existing private human PAT file used only for coordinator bootstrap")
    value.add_argument("--multica-workspace-id")
    value.add_argument("--multica-workspace-slug", help="existing workspace URL slug, used for browser links")
    value.add_argument("--multica-project-id", help="reuse an existing project when explicitly configured")
    value.add_argument("--runtime-profile-id", help="approved Multica custom runtime profile for visible isolated workers")
    value.add_argument("--daemon-id", help="Multica daemon with shared local worktree access")
    value.add_argument("--qualification-file", help="existing private record of the actual authorized provider smoke; never generated by installation")
    value.add_argument("--muxdeck-url", type=endpoint, default="http://127.0.0.1:7683/mux")
    value.add_argument("--muxdeck-public-url", type=endpoint, help="existing protected browser URL for Muxdeck terminal links")
    value.add_argument("--muxdeck-token-file", help="existing private Muxdeck control token file")
    value.add_argument("--worker-limit", type=positive, default=3)
    value.add_argument("--lease-seconds", type=positive, default=300)
    value.add_argument("--main-model", default="gpt-6.1-sol", help="explicit main launcher model; availability is checked separately")
    value.add_argument("--service-manager", choices=("system", "user"), help="systemd scope for configured Multica dependencies; defaults to system or the preserved installation scope")
    for dependency in ("api", "web", "daemon"):
        value.add_argument(f"--multica-{dependency}-service", type=service_unit, help=f"existing owned Multica {dependency} service; main may start it when inactive")
    value.add_argument("--reuse-config", action="store_true", help="keep an existing private configuration; endpoint options are ignored")
    value.add_argument("--replace", action="store_true", help="upgrade only unedited files recorded by this installer")
    value.add_argument("--dry-run", action="store_true", help="print the exact inventory without writing or starting anything")
    return value


def install(args: argparse.Namespace) -> dict[str, object]:
    repo = absolute(args.repo).resolve()
    for source in ("skills/muxpilot/SKILL.md", "docs/muxpilot/USER_GUIDE.md", "docs/muxpilot/OPERATIONS.md", "AGENT_DEPLOYMENT_GUIDE.md", "muxpilot/__main__.py"):
        if not (repo / source).is_file():
            raise InstallationError(f"release is missing {source}")
    configured_python = absolute(args.python) if args.python else repo / ".venv/bin/python"
    if not configured_python.is_file() or not os.access(configured_python, os.X_OK):
        raise InstallationError("provide --python for a working Python 3.11+ environment with the release dependencies")
    probe = subprocess.run([str(configured_python), "-c", "import sys, aiohttp; assert sys.version_info >= (3, 11)"], capture_output=True, timeout=10, check=False)
    if probe.returncode:
        raise InstallationError("selected Python needs version 3.11+ and the release's aiohttp dependency")
    config = absolute(args.config)
    state = absolute(args.state_root)
    bin_dir = absolute(args.bin_dir)
    skill_roots = [absolute(args.skills_dir)]
    if args.legacy_skills_dir:
        legacy = absolute(args.legacy_skills_dir)
        if legacy not in skill_roots:
            skill_roots.append(legacy)
    for directory in [bin_dir, *skill_roots]:
        check_directory(directory)
    check_directory(config.parent, private=True)
    check_directory(state, private=True)
    for root in skill_roots:
        check_directory(root / "muxpilot", private=True)
        check_directory(root / "muxpilot/references", private=True)
    manifest_path = skill_roots[0] / "muxpilot/.muxpilot-installation.json"
    previous: dict[str, object] = {}
    if manifest_path.exists() or manifest_path.is_symlink():
        previous = json.loads(read_regular(manifest_path, private=True))
        if not isinstance(previous, dict) or previous.get("installer") != MARKER:
            raise InstallationError("existing skill has no valid Muxpilot installation manifest")
    previous_files = previous.get("files", {})
    if not isinstance(previous_files, dict):
        raise InstallationError("invalid installation file inventory")

    values = {
        "state_root": str(state),
        "socket_path": str(absolute(args.socket_path)) if args.socket_path else str(state / "projectd.sock"),
        "multica_url": args.multica_url,
        "multica_ui_url": args.multica_ui_url,
        "multica_token_file": str(absolute(args.multica_token_file)) if args.multica_token_file else None,
        "multica_workspace_id": args.multica_workspace_id,
        "multica_workspace_slug": args.multica_workspace_slug,
        "multica_project_id": args.multica_project_id,
        "runtime_profile_id": args.runtime_profile_id,
        "daemon_id": args.daemon_id,
        "qualification_file": str(absolute(args.qualification_file)) if args.qualification_file else None,
        "muxdeck_url": args.muxdeck_url,
        "muxdeck_public_url": args.muxdeck_public_url,
        "muxdeck_token_file": str(absolute(args.muxdeck_token_file)) if args.muxdeck_token_file else None,
        "worker_limit": args.worker_limit,
        "lease_seconds": args.lease_seconds,
    }
    if args.reuse_config:
        values = json.loads(read_regular(config, private=True))
        if not isinstance(values, dict):
            raise InstallationError("existing configuration must be a JSON object")
        allowed = {
            "state_root", "socket_path", "multica_url", "multica_token_file",
            "multica_workspace_id", "multica_project_id", "muxdeck_url",
            "muxdeck_token_file", "worker_limit", "lease_seconds", "multica_ui_url",
            "multica_workspace_slug", "runtime_profile_id", "daemon_id",
            "qualification_file", "muxdeck_public_url",
        }
        if set(values) - allowed:
            raise InstallationError("existing configuration contains unsupported fields")
        for field in ("multica_url", "multica_ui_url", "muxdeck_url", "muxdeck_public_url"):
            if values.get(field):
                endpoint(str(values[field]))
        for field in ("worker_limit", "lease_seconds"):
            if field in values and (type(values[field]) is not int or values[field] <= 0):
                raise InstallationError(f"{field} must be a positive integer")
    effective_state = absolute(str(values.get("state_root", state)))
    effective_socket = absolute(str(values.get("socket_path", effective_state / "projectd.sock")))
    check_directory(effective_state, private=True)
    check_directory(effective_socket.parent, private=True)
    for field in ("multica_token_file", "muxdeck_token_file", "qualification_file"):
        if values.get(field):
            # Validate metadata without reading or displaying the credential value.
            token = absolute(str(values[field]))
            metadata = token.lstat()
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or metadata.st_mode & 0o077 or not 0 < metadata.st_size <= 65536):
                raise InstallationError(f"{field} must reference an existing nonempty private regular file")

    command = bin_dir / "muxpilot"
    binding = (
        "\n\n## Installation binding\n\n"
        f"Installed command: `{shlex.quote(str(command))}`. Its private configuration is\n"
        f"`{config}`; the wrapper passes it automatically. Use this absolute command\n"
        "when the shell PATH does not include its directory.\n\n"
        f"Validated source release: `{repo}`. Main launcher model preference:\n"
        f"`{args.main_model}`; this is a request, not proof of account/model support.\n\n"
        "Read [the user guide](references/USER_GUIDE.md) for human-facing usage,\n"
        "[operations](references/OPERATIONS.md) for setup/recovery, and\n"
        "[the full deployment runbook](references/AGENT_DEPLOYMENT_GUIDE.md) before\n"
        "installation, migration, service, archive, upgrade, or rollback work.\n"
    )
    managed_services = {
        dependency: getattr(args, f"multica_{dependency}_service")
        for dependency in ("api", "web", "daemon")
        if getattr(args, f"multica_{dependency}_service")
    }
    if args.reuse_config:
        retained_commands = previous.get("managed_service_commands", {})
        if not isinstance(retained_commands, dict):
            raise InstallationError("invalid managed-service inventory")
        for dependency in ("api", "web", "daemon"):
            retained = retained_commands.get(dependency)
            if dependency not in managed_services and isinstance(retained, dict) and retained.get("unit"):
                managed_services[dependency] = service_unit(str(retained["unit"]))
    manager_scope = args.service_manager or (previous.get("service_manager") if args.reuse_config else None) or "system"
    if not isinstance(manager_scope, str) or manager_scope not in {"system", "user"}:
        raise InstallationError("invalid retained service-manager scope")
    startup_commands = {}
    if managed_services:
        manager = "systemctl --user" if manager_scope == "user" else "systemctl"
        binding += (
            "\n### Configured local dependency bootstrap\n\n"
            "These are the installed Multica dependencies for this workflow. Read the\n"
            "operations and full deployment guides before service action. On an\n"
            "availability failure, check the exact unit, reuse it when active, and\n"
            "start it when loaded but inactive. Then recheck `muxpilot doctor`.\n"
            "Do not stop/restart these units or touch other services during bootstrap.\n\n"
            "| Dependency | Status | Start when inactive |\n"
            "| --- | --- | --- |\n"
        )
        for dependency, unit in managed_services.items():
            status_command = f"{manager} is-active --quiet {shlex.quote(unit)}"
            start_command = f"{manager} start {shlex.quote(unit)}"
            binding += f"| Multica {dependency} | `{status_command}` | `{start_command}` |\n"
            startup_commands[dependency] = {"unit": unit, "status": status_command, "start": start_command}
    launcher = (
        "#!/bin/sh\n"
        f"# {MARKER}\n"
        f"export PYTHONPATH={shlex.quote(str(repo))}\n"
        f"exec {shlex.quote(str(configured_python))} -m muxpilot --config {shlex.quote(str(config))} \"$@\"\n"
    )
    files: dict[Path, tuple[bytes, int]] = {command: (launcher.encode(), 0o700)}
    if not args.reuse_config:
        files[config] = ((json.dumps(values, indent=2) + "\n").encode(), 0o600)
    for root in skill_roots:
        files[root / "muxpilot/SKILL.md"] = ((repo / "skills/muxpilot/SKILL.md").read_text().replace(
            "read [the operator guide](../../docs/muxpilot/OPERATIONS.md) from this repository.",
            "read [the operator guide](references/OPERATIONS.md)."
        ).encode() + binding.encode(), 0o600)
        for source in ("docs/muxpilot/USER_GUIDE.md", "docs/muxpilot/OPERATIONS.md", "AGENT_DEPLOYMENT_GUIDE.md"):
            data = (repo / source).read_bytes()
            if source.endswith("OPERATIONS.md"):
                data = data.replace(b"../../AGENT_DEPLOYMENT_GUIDE.md", b"AGENT_DEPLOYMENT_GUIDE.md")
            files[root / "muxpilot/references" / Path(source).name] = (data, 0o600)

    changed: list[str] = []
    unchanged: list[str] = []
    for path, (content, _mode) in files.items():
        if path.exists() or path.is_symlink():
            existing = read_regular(path, private=True)
            if existing == content and stat.S_IMODE(path.stat().st_mode) == _mode:
                unchanged.append(str(path))
                continue
            if not args.replace or previous_files.get(str(path)) != digest(existing):
                raise InstallationError(f"refusing to replace unmanaged or edited file: {path}")
        changed.append(str(path))
    manifest = {
        "installer": MARKER,
        "repo": str(repo),
        "python": str(configured_python),
        "config": str(config),
        "main_model": args.main_model,
        "receiver_environment_required": {"MUXPILOT_STATE_ROOT": str(effective_state)},
        "provider_qualification_record_configured": bool(values.get("qualification_file")),
        "managed_service_commands": startup_commands,
        "service_manager": manager_scope,
        "files": {str(path): digest(data) for path, (data, _mode) in files.items()},
    }
    if args.reuse_config and str(config) in previous_files:
        manifest["files"][str(config)] = previous_files[str(config)]
    if not args.dry_run:
        directories = {path.parent for path in [*files, manifest_path]}
        directories.update({effective_state, effective_socket.parent})
        for directory in sorted(directories, key=lambda path: len(path.parts)):
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        for path, (data, mode) in files.items():
            if str(path) in changed:
                atomic_write(path, data, mode)
        atomic_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode(), 0o600)
    return {
        "dry_run": args.dry_run,
        "command": str(command),
        "config": str(config),
        "skills": [str(root / "muxpilot/SKILL.md") for root in skill_roots],
        "changed": changed,
        "unchanged": unchanged,
        "services_started": False,
        "provider_runs_started": False,
        "next_check": f"{shlex.quote(str(command))} doctor",
        "main_model": args.main_model,
        "receiver_environment_required": {"MUXPILOT_STATE_ROOT": str(effective_state)},
        "provider_qualification_record_configured": bool(values.get("qualification_file")),
        "managed_service_commands": startup_commands,
        "next_prompt": "Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR when it is tested.",
        "skill_loading": "Codex discovers installed user skills; if Muxpilot is absent from the current session, start a new session. Installation does not inject tools into a running conversation.",
        "configuration_ready_for_check": bool(values.get("multica_token_file") and values.get("multica_workspace_id") and values.get("muxdeck_token_file") and values.get("runtime_profile_id") and values.get("daemon_id")),
    }


def main() -> int:
    args = parser().parse_args()
    try:
        result = install(args)
    except (InstallationError, OSError, ValueError, argparse.ArgumentTypeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error), "installed": False}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
