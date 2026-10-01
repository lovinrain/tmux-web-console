"""Private, same-UID operation gateway for Muxpilot.

The service hosts the project controller; it owns no tmux sessions, provider
processes or scheduling loop. Stopping it therefore leaves those lifetimes
alone. A socket connection carries exactly one bounded JSON request/response.
"""

from __future__ import annotations

import argparse
import asyncio
import errno
import fcntl
import hashlib
import inspect
import json
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any, Self

from muxpilot import __version__
from muxpilot.store import (
    ConflictError,
    CursorGapError,
    IntegrityError,
    LeaseError,
    StoreError,
)

SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
REQUEST_TIMEOUT = 35.0
MAX_CONNECTIONS = 32
_ACTION = re.compile(r"[a-z][a-z0-9_.-]{0,79}\Z")
_PACKAGE_ROOT = Path(__file__).parent.parent


def _package_identity() -> str:
    """Hash both shipped runtime packages, including imported Muxdeck clients."""
    digest = hashlib.sha256()
    for package in ("muxpilot", "tmux_console"):
        for source in sorted((_PACKAGE_ROOT / package).rglob("*.py")):
            digest.update(str(source.relative_to(_PACKAGE_ROOT)).encode())
            digest.update(b"\0")
            digest.update(source.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()


def _configuration_identity(
    config_path: str | Path | None = None, *, config: Any = None
) -> dict[str, Any]:
    from muxpilot.config import Config, private_read

    config = Config.load(config_path) if config is None else config
    source = (
        Path(config_path).expanduser().absolute()
        if config_path is not None
        else Path(
            os.environ.get(
                "MUXPILOT_CONFIG", str(Path.home() / ".config/muxpilot/config.json")
            )
        )
        .expanduser()
        .absolute()
    )
    contents = private_read(source) if source.exists() else ""
    file_mode = stat.S_IMODE(source.lstat().st_mode) if source.exists() else None
    identity = {
        "schema_version": 1,
        "source": str(source),
        "file_mode": file_mode,
        "content_hash": hashlib.sha256(contents.encode()).hexdigest(),
        "resolved": asdict(config),
    }
    digest = hashlib.sha256(
        json.dumps(identity, sort_keys=True, default=str).encode()
    ).hexdigest()
    return {"schema_version": 1, "file_mode": file_mode, "fingerprint": digest}


def _check_health(status: Any, config_path: str | Path | None) -> dict[str, Any]:
    if (
        not isinstance(status, dict)
        or status.get("service") != "muxdeck-projectd"
        or status.get("schema_version") != SCHEMA_VERSION
    ):
        raise ServiceError(
            "Existing service has incompatible capabilities", "schema_mismatch"
        )
    if (
        status.get("package_version") != __version__
        or status.get("build_id") != _package_identity()
    ):
        raise ServiceError(
            "Project service code changed; restart only muxpilot/projectd after preserving active workers",
            "service_version_mismatch",
        )
    if status.get("configuration") is not None and status[
        "configuration"
    ] != _configuration_identity(config_path):
        raise ServiceError(
            "Project service configuration changed; restart only muxpilot/projectd to load it",
            "configuration_mismatch",
        )
    return status


class ServiceError(RuntimeError):
    """A safe, structured transport or service failure."""

    def __init__(self, message: str, code: str = "service_error") -> None:
        super().__init__(message)
        self.code = code


def _private_directory(path: Path) -> None:
    path = path.absolute()
    for ancestor in reversed((path, *path.parents)):
        if ancestor.is_symlink():
            raise ServiceError(
                "Service directory cannot use symbolic links", "unsafe_path"
            )
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ServiceError(
            "Service directory must be owned by this UID and mode 0700", "unsafe_path"
        )


def _private_file(path: Path) -> int:
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        os.close(fd)
        raise ServiceError(
            "Service file must be owned by this UID and mode 0600", "unsafe_path"
        )
    return fd


def _socket_identity(path: Path) -> tuple[int, int]:
    info = path.lstat()
    if (
        not stat.S_ISSOCK(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise ServiceError(
            "Service socket must be owned by this UID and mode 0600", "unsafe_path"
        )
    return info.st_dev, info.st_ino


def _peer_uid(sock: Any) -> int:
    if not hasattr(socket, "SO_PEERCRED"):
        raise ServiceError(
            "Same-UID Unix peer checks require Linux SO_PEERCRED",
            "unsupported_platform",
        )
    _, uid, _ = struct.unpack(
        "3i",
        sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")),
    )
    return uid


def _decode_request(raw: bytes) -> tuple[str, dict[str, Any]]:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ServiceError("Request exceeds size limit", "request_too_large")
    try:

        def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            value: dict[str, Any] = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("Duplicate JSON object keys")
                value[key] = item
            return value

        def reject_constant(value: str) -> Any:
            raise ValueError("Non-finite JSON numbers are not supported")

        envelope = json.loads(
            raw, object_pairs_hook=object_pairs, parse_constant=reject_constant
        )
    except (ValueError, UnicodeError) as exc:
        raise ServiceError(
            "Request must contain valid JSON", "invalid_request"
        ) from exc
    if not isinstance(envelope, dict) or set(envelope) != {
        "schema_version",
        "action",
        "payload",
    }:
        raise ServiceError("Invalid request envelope", "invalid_request")
    if (
        type(envelope["schema_version"]) is not int
        or envelope["schema_version"] != SCHEMA_VERSION
    ):
        raise ServiceError("Unsupported request schema version", "schema_mismatch")
    action, payload = envelope["action"], envelope["payload"]
    if (
        not isinstance(action, str)
        or not _ACTION.fullmatch(action)
        or not isinstance(payload, dict)
    ):
        raise ServiceError("Action and payload have invalid types", "invalid_request")
    return action, payload


def _encode(value: Any, limit: int) -> bytes:
    raw = json.dumps(value, separators=(",", ":"), allow_nan=False).encode() + b"\n"
    if len(raw) > limit:
        raise ServiceError("Message exceeds size limit", "message_too_large")
    return raw


def _error_text(error: Exception, payload: dict[str, Any]) -> str:
    message = str(error)

    def redact(value: Any) -> None:
        nonlocal message
        if isinstance(value, dict):
            for key, item in value.items():
                if (
                    re.search(
                        r"token|password|authorization|credential|secret|api.?key",
                        str(key),
                        re.IGNORECASE,
                    )
                    and isinstance(item, str)
                    and item
                ):
                    message = message.replace(item, "[redacted]")
                else:
                    redact(item)
        elif isinstance(value, list):
            for item in value:
                redact(item)

    redact(payload)
    return message[:1024]


def request(
    socket_path: str | Path,
    action: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = REQUEST_TIMEOUT,
) -> Any:
    """Send one operation; transport errors never retry a possibly effected action."""
    path = Path(socket_path).absolute()
    _private_directory(path.parent)
    _socket_identity(path)
    raw = _encode(
        {
            "schema_version": SCHEMA_VERSION,
            "action": action,
            "payload": payload if payload is not None else {},
        },
        MAX_REQUEST_BYTES,
    )
    _decode_request(raw)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(path))
        if _peer_uid(connection) != os.getuid():
            raise ServiceError("Service peer UID does not match", "unauthorized_peer")
        connection.sendall(raw)
        response = bytearray()
        while b"\n" not in response:
            block = connection.recv(min(65536, MAX_RESPONSE_BYTES + 1 - len(response)))
            if not block:
                raise ServiceError(
                    "Service disconnected before its receipt; reconcile the operation",
                    "uncertain_transport",
                )
            response.extend(block)
            if len(response) > MAX_RESPONSE_BYTES:
                raise ServiceError(
                    "Service response exceeds size limit", "response_too_large"
                )
    try:
        envelope = json.loads(response.partition(b"\n")[0])
    except (ValueError, UnicodeError) as exc:
        raise ServiceError(
            "Invalid service response; reconcile the operation", "uncertain_transport"
        ) from exc
    if not isinstance(envelope, dict) or type(envelope.get("ok")) is not bool:
        raise ServiceError("Invalid service response envelope", "uncertain_transport")
    if not envelope["ok"]:
        raise ServiceError(
            str(envelope.get("error", "Service rejected request")),
            str(envelope.get("code", "rejected")),
        )
    return envelope.get("result")


class ProjectService:
    """Exclusive socket host for a deterministic controller dispatcher."""

    def __init__(
        self,
        socket_path: str | Path,
        dispatcher: Callable[[str, dict[str, Any]], Any],
        *,
        request_timeout: float = REQUEST_TIMEOUT,
        configuration: dict[str, Any] | None = None,
    ) -> None:
        self.socket_path = Path(socket_path).absolute()
        self.dispatcher = dispatcher
        self.request_timeout = request_timeout
        self.instance_id = str(uuid.uuid4())
        self.configuration = configuration
        self.build_id = _package_identity()
        self._server: asyncio.AbstractServer | None = None
        self._lock_fd: int | None = None
        self._socket_inode: tuple[int, int] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._stopping = False

    async def start(self) -> None:
        if self._server is not None or self._lock_fd is not None:
            raise ServiceError(
                "This project service is already started", "already_running"
            )
        self._stopping = False
        _private_directory(self.socket_path.parent)
        if not hasattr(socket, "SO_PEERCRED"):
            raise ServiceError(
                "Project service requires Linux SO_PEERCRED", "unsupported_platform"
            )
        lock = self.socket_path.with_name(self.socket_path.name + ".lock")
        self._lock_fd = _private_file(lock)
        listener: socket.socket | None = None
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise ServiceError(
                "A project service already owns this socket", "already_running"
            ) from exc
        try:
            if self.socket_path.exists() or self.socket_path.is_symlink():
                identity = _socket_identity(self.socket_path)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.5)
                    try:
                        probe.connect(str(self.socket_path))
                    except OSError as exc:
                        if exc.errno != errno.ECONNREFUSED:
                            raise ServiceError(
                                "Existing socket ownership is uncertain",
                                "ownership_uncertain",
                            ) from exc
                    else:
                        raise ServiceError(
                            "A live listener already owns this socket",
                            "already_running",
                        )
                if _socket_identity(self.socket_path) != identity:
                    raise ServiceError(
                        "Socket changed during recovery", "ownership_uncertain"
                    )
                self.socket_path.unlink()
            # Bind with private permissions from its first instant, independent
            # of the invoking process's umask; service.main is single-threaded.
            mask = os.umask(0o177)
            try:
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                listener.bind(str(self.socket_path))
            finally:
                os.umask(mask)
            listener.setblocking(False)
            self._socket_inode = _socket_identity(self.socket_path)
            self._server = await asyncio.start_unix_server(
                self._accept, sock=listener, limit=MAX_REQUEST_BYTES + 1
            )
        except BaseException:
            if listener is not None and self._server is None:
                listener.close()
            await self.stop()
            raise

    def _accept(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if self._stopping or len(self._tasks) >= MAX_CONNECTIONS:
            writer.close()
            return
        task = asyncio.create_task(self._serve(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        payload: dict[str, Any] = {}
        try:
            if _peer_uid(writer.get_extra_info("socket")) != os.getuid():
                raise ServiceError(
                    "Client peer UID does not match", "unauthorized_peer"
                )
            try:
                raw = await asyncio.wait_for(
                    reader.readline(), timeout=self.request_timeout
                )
            except ValueError as exc:
                raise ServiceError(
                    "Request exceeds size limit", "request_too_large"
                ) from exc
            if not raw.endswith(b"\n"):
                raise ServiceError("Request must end with a newline", "invalid_request")
            action, payload = _decode_request(raw)
            if action == "service.health":
                result = {
                    "service": "muxdeck-projectd",
                    "schema_version": SCHEMA_VERSION,
                    "pid": os.getpid(),
                    "uid": os.getuid(),
                    "instance_id": self.instance_id,
                    "package_version": __version__,
                    "build_id": self.build_id,
                    "configuration": self.configuration,
                }
            else:
                if inspect.iscoroutinefunction(self.dispatcher):
                    result = await self.dispatcher(action, payload)
                else:
                    result = await asyncio.to_thread(self.dispatcher, action, payload)
                    if inspect.isawaitable(result):
                        result = await result
            response = _encode({"ok": True, "result": result}, MAX_RESPONSE_BYTES)
        except ServiceError as exc:
            response = _encode(
                {"ok": False, "code": exc.code, "error": _error_text(exc, payload)},
                MAX_RESPONSE_BYTES,
            )
        except (PermissionError, ValueError, KeyError) as exc:
            # Controller validation failures should name the failing contract;
            # internal errors stay generic and never echo request/token values.
            response = _encode(
                {
                    "ok": False,
                    "code": getattr(
                        exc,
                        "code",
                        "unauthorized"
                        if isinstance(exc, PermissionError)
                        else "rejected",
                    ),
                    "error": _error_text(exc, payload),
                },
                MAX_RESPONSE_BYTES,
            )
        except StoreError as exc:
            code = "store_error"
            if isinstance(exc, LeaseError):
                code = "stale_generation"
            elif isinstance(exc, ConflictError):
                code = "conflict"
            elif isinstance(exc, CursorGapError):
                code = "cursor_gap"
            elif isinstance(exc, IntegrityError):
                code = "integrity_error"
            response = _encode(
                {"ok": False, "code": code, "error": _error_text(exc, payload)},
                MAX_RESPONSE_BYTES,
            )
        except TimeoutError:
            response = _encode(
                {
                    "ok": False,
                    "code": "request_timeout",
                    "error": "Timed out waiting for a complete request",
                },
                MAX_RESPONSE_BYTES,
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 -- keep internal details out of the private API.
            response = _encode(
                {
                    "ok": False,
                    "code": "internal_error",
                    "error": "Operation failed; inspect local receipts before retrying",
                },
                MAX_RESPONSE_BYTES,
            )
        try:
            writer.write(response)
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def stop(self) -> None:
        """Stop only this listener; active operation threads finish before exit."""
        self._stopping = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        # Do not cancel dispatched operations: a missing receipt must not release
        # the execution fence while the remote side effect is still outstanding.
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._socket_inode is not None:
            try:
                if _socket_identity(self.socket_path) == self._socket_inode:
                    self.socket_path.unlink()
            except (FileNotFoundError, ServiceError):
                # A replaced/modified socket is not ours to remove, but it must
                # not prevent releasing the old listener's process lock.
                pass
            self._socket_inode = None
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.stop()


def ensure_service(
    socket_path: str | Path,
    config_path: str | Path | None = None,
    *,
    timeout: float = 5.0,
) -> dict[str, Any]:
    """Reuse a healthy owner or bootstrap an independently owned local daemon.

    Ownership uncertainty fails closed. No action or worker launch is retried,
    and no existing process is stopped. Parent exit does not stop projectd.
    """
    path = Path(socket_path).absolute()
    _private_directory(path.parent)
    boot_fd = _private_file(path.with_name(path.name + ".bootstrap.lock"))
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(boot_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ServiceError(
                        "Another startup is still in progress", "startup_timeout"
                    )
                time.sleep(0.05)
        try:
            status = request(path, "service.health", timeout=min(1.0, timeout))
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        else:
            status = _check_health(status, config_path)
            return {**status, "reused": True}
        # -P: the caller's working directory (often a repository) must not
        # shadow the installed package on sys.path.
        command = [sys.executable, "-P", "-m", "muxpilot.service", "--socket", str(path)]
        if config_path is not None:
            command.extend(["--config", str(Path(config_path).absolute())])
        log_fd = _private_file(path.with_name(path.name + ".log"))
        os.lseek(log_fd, 0, os.SEEK_END)
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log_fd,
                stderr=log_fd,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            os.close(log_fd)
        while time.monotonic() < deadline:
            try:
                status = request(path, "service.health", timeout=0.2)
            except (FileNotFoundError, ConnectionRefusedError):
                if process.poll() is not None:
                    raise ServiceError(
                        "Project service failed startup; inspect its private log",
                        "startup_failed",
                    )
                time.sleep(0.05)
                continue
            status = _check_health(status, config_path)
            return {**status, "reused": status.get("pid") != process.pid}
        raise ServiceError(
            "Project service startup timed out; inspect its private log",
            "startup_timeout",
        )
    finally:
        os.close(boot_fd)


async def _run(
    socket_path: Path, controller: Any, configuration: dict[str, Any]
) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    async with ProjectService(
        socket_path, controller.dispatch, configuration=configuration
    ):
        await stop.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Muxpilot private project operation service"
    )
    parser.add_argument("--config", type=Path)
    parser.add_argument("--socket", type=Path)
    args = parser.parse_args(argv)
    try:
        from muxpilot.config import Config
        from muxpilot.project import ProjectController

        config = Config.load(args.config)
        asyncio.run(
            _run(
                args.socket or config.socket_path,
                ProjectController(config),
                _configuration_identity(args.config, config=config),
            )
        )
    except (ServiceError, OSError, ValueError) as exc:
        print(f"muxdeck-projectd: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
