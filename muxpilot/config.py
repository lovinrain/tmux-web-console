"""Explicit local configuration, with credentials referenced by private files."""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any


class ConfigurationError(ValueError):
    pass


PROVIDERS = frozenset({"codex", "copilot"})


def private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = path.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o077
    ):
        raise ConfigurationError(
            "state directory must be private and owned by the current user"
        )
    return path


def private_read(path: Path, *, maximum: int = 1024 * 1024) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
        ):
            raise ConfigurationError("credential/configuration file must be owner-only")
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ConfigurationError("private configuration exceeds size limit")
    return data.decode("utf-8")


def private_write(path: Path, data: str) -> None:
    private_directory(path.parent)
    import uuid

    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
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


@dataclass(frozen=True)
class Config:
    state_root: Path
    socket_path: Path
    multica_url: str = "http://127.0.0.1:7331"
    multica_ui_url: str | None = None
    multica_token_file: Path | None = None
    multica_workspace_id: str | None = None
    multica_workspace_slug: str | None = None
    multica_project_id: str | None = None
    runtime_profile_id: str | None = None
    daemon_id: str | None = None
    qualification_file: Path | None = None
    muxdeck_url: str = "http://127.0.0.1:7683/mux"
    muxdeck_public_url: str | None = None
    muxdeck_token_file: Path | None = None
    worker_limit: int = 3
    lease_seconds: int = 300
    worker_provider: str = "codex"
    main_provider: str = "codex"
    main_model: str | None = None
    main_executable: str | None = None
    main_args: tuple[str, ...] = ()

    @classmethod
    def load(cls, path: str | Path | None = None) -> Config:
        state = (
            Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
            / "muxdeck/projects"
        )
        source = (
            Path(path).expanduser()
            if path
            else Path(
                os.environ.get(
                    "MUXPILOT_CONFIG", str(Path.home() / ".config/muxpilot/config.json")
                )
            )
        )
        values: dict[str, Any] = (
            json.loads(private_read(source)) if source.exists() else {}
        )
        if not isinstance(values, dict):
            raise ConfigurationError("configuration must be a JSON object")
        unknown = set(values) - {field.name for field in fields(cls)}
        if unknown:
            raise ConfigurationError(
                "unknown configuration fields: " + ", ".join(sorted(unknown))
            )
        values.setdefault("state_root", state)
        values.setdefault("socket_path", Path(values["state_root"]) / "projectd.sock")
        for name in (
            "state_root",
            "socket_path",
            "multica_token_file",
            "muxdeck_token_file",
            "qualification_file",
        ):
            if values.get(name) is not None:
                values[name] = Path(values[name]).expanduser().absolute()
        for name in ("worker_limit", "lease_seconds"):
            value = values.get(name, getattr(cls, name))
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ConfigurationError(name + " must be a positive integer")
        for name in ("worker_provider", "main_provider"):
            if values.get(name, getattr(cls, name)) not in PROVIDERS:
                raise ConfigurationError(name + " must be one of: " + ", ".join(sorted(PROVIDERS)))
        model = values.get("main_model")
        if model is not None and (not isinstance(model, str) or not model.strip() or "\0" in model):
            raise ConfigurationError("main_model must be a nonempty model name")
        executable = values.get("main_executable")
        if executable is not None and (not isinstance(executable, str) or not Path(executable).is_absolute()):
            raise ConfigurationError("main_executable must be an absolute path")
        arguments = values.get("main_args", ())
        if not isinstance(arguments, (list, tuple)) or not all(
            isinstance(argument, str) and argument and "\0" not in argument for argument in arguments
        ):
            raise ConfigurationError("main_args must be a list of nonempty strings")
        values["main_args"] = tuple(arguments)
        return cls(**values)
