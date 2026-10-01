"""Transparent local provider-protocol transport through a Muxdeck tmux pane."""

from __future__ import annotations

import base64
import contextlib
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .stdio_runner import (
    CHUNK,
    GRACE_SECONDS,
    INPUT_WINDOW,
    INTEGER,
    QUEUE_LIMIT,
    BridgeError,
    Wire,
    same_user,
)


def is_lightweight_probe(command: list[str]) -> bool:
    """Exact help/version probes delegate locally without creating a tmux pane."""
    return len(command) == 2 and command[1] in {"--version", "-V", "--help", "-h"}


def _binary(stream):
    return getattr(stream, "buffer", stream)


def _descriptor(stream):
    try:
        return stream.fileno()
    except (AttributeError, OSError, ValueError):
        return None


def _relay(connection, stdin, stdout, stderr, output_observer=None) -> int:
    wire = Wire(connection)
    input_descriptor = _descriptor(stdin)
    output_streams = {b"O": stdout, b"D": stderr}
    output_descriptors = {
        kind: _descriptor(stream) for kind, stream in output_streams.items()
    }
    pending_outputs = {b"O": bytearray(), b"D": bytearray()}
    outstanding_input = 0
    input_eof = False
    result = None
    caught_signal = None
    signal_sent_at = None
    previous_handlers = {}
    previous_blocking = {}

    def interrupt(number, _frame):
        nonlocal caught_signal
        caught_signal = number

    try:
        # Nonblocking file descriptors keep cancellation responsive even while
        # the provider refuses stdin or its caller stops consuming output.
        for descriptor in {input_descriptor, *output_descriptors.values()} - {None}:
            previous_blocking[descriptor] = os.get_blocking(descriptor)
            os.set_blocking(descriptor, False)
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            try:
                previous_handlers[number] = signal.signal(number, interrupt)
            except ValueError:  # An injected test can run outside the main thread.
                break
        while True:
            if caught_signal is not None and signal_sent_at is None:
                wire.queue(b"S", INTEGER.pack(caught_signal))
                signal_sent_at = time.monotonic()
                input_eof = True
            if (
                signal_sent_at is not None
                and time.monotonic() - signal_sent_at > GRACE_SECONDS + 2
            ):
                assert caught_signal is not None
                return 128 + caught_signal
            for kind, descriptor in output_descriptors.items():
                if descriptor is None and pending_outputs[kind]:
                    delivered = bytes(pending_outputs[kind])
                    output_streams[kind].write(delivered)
                    output_streams[kind].flush()
                    if output_observer is not None:
                        output_observer("stdout" if kind == b"O" else "stderr", delivered)
                    pending_outputs[kind].clear()
            if result is not None and not any(pending_outputs.values()):
                return result if result >= 0 else 128 - result
            if wire.closed and result is None:
                raise BridgeError(
                    "Muxdeck stdio runner disconnected before reporting its exit status"
                )
            can_read_input = (
                not input_eof
                and result is None
                and not wire.closed
                and outstanding_input < INPUT_WINDOW
                and len(wire.outgoing) < QUEUE_LIMIT
            )
            if can_read_input and input_descriptor is None:
                payload = stdin.read(min(CHUNK, INPUT_WINDOW - outstanding_input))
                if payload:
                    wire.queue(b"I", payload)
                    outstanding_input += len(payload)
                else:
                    wire.queue(b"E")
                    input_eof = True
            with selectors.SelectSelector() as selector:
                events = (
                    selectors.EVENT_WRITE if wire.outgoing and not wire.closed else 0
                )
                if (
                    not wire.closed
                    and sum(len(value) for value in pending_outputs.values())
                    < QUEUE_LIMIT
                ):
                    events |= selectors.EVENT_READ
                if events:
                    selector.register(connection, events, "socket")
                if can_read_input and input_descriptor is not None:
                    selector.register(input_descriptor, selectors.EVENT_READ, "stdin")
                for kind, descriptor in output_descriptors.items():
                    # stdout and stderr occasionally share a descriptor.
                    if (
                        descriptor is not None
                        and pending_outputs[kind]
                        and descriptor not in selector.get_map()
                    ):
                        selector.register(descriptor, selectors.EVENT_WRITE, kind)
                for key, mask in selector.select(0.1):
                    if key.data == "socket":
                        if mask & selectors.EVENT_READ:
                            for kind, payload in wire.read():
                                if kind in pending_outputs:
                                    pending_outputs[kind].extend(payload)
                                elif kind == b"A" and len(payload) == INTEGER.size:
                                    outstanding_input -= INTEGER.unpack(payload)[0]
                                    if outstanding_input < 0:
                                        raise BridgeError(
                                            "invalid stdio bridge input acknowledgement"
                                        )
                                elif kind == b"X" and len(payload) == INTEGER.size:
                                    result = INTEGER.unpack(payload)[0]
                                    wire.outgoing.clear()
                                elif kind == b"B" and not payload:
                                    input_eof = True
                                elif kind == b"F":
                                    raise BridgeError(
                                        payload.decode("utf-8", errors="replace")
                                    )
                                else:
                                    raise BridgeError("unexpected stdio runner frame")
                        if (
                            mask & selectors.EVENT_WRITE
                            and result is None
                            and not wire.closed
                        ):
                            wire.flush()
                    elif key.data == "stdin":
                        try:
                            payload = os.read(
                                key.fd, min(CHUNK, INPUT_WINDOW - outstanding_input)
                            )
                        except BlockingIOError:
                            continue
                        if payload:
                            wire.queue(b"I", payload)
                            outstanding_input += len(payload)
                        else:
                            wire.queue(b"E")
                            input_eof = True
                    else:
                        try:
                            count = os.write(key.fd, pending_outputs[key.data])
                        except BlockingIOError:
                            continue
                        if output_observer is not None:
                            output_observer("stdout" if key.data == b"O" else "stderr", bytes(pending_outputs[key.data][:count]))
                        del pending_outputs[key.data][:count]
    finally:
        for descriptor, blocking in previous_blocking.items():
            with contextlib.suppress(OSError):
                os.set_blocking(descriptor, blocking)
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def run(
    command: list[str],
    *,
    api=None,
    cwd: str,
    environment: dict[str, str],
    launch_options: dict | None = None,
    stdin=None,
    stdout=None,
    stderr=None,
    output_observer=None,
    mirror_secrets: tuple[bytes, ...] = (),
) -> int:
    """Run a provider with unmodified binary stdio and caller argv/env/cwd.

    The API callable has ``(method, path, payload)`` arguments. It can perform
    workspace placement before returning the creation receipt. The service must
    share this host, OS user, and installed package path with the controller.
    """
    if not command or not all(
        isinstance(arg, str) and "\0" not in arg for arg in command
    ):
        raise BridgeError("a valid provider command is required")
    stdin = _binary(sys.stdin if stdin is None else stdin)
    stdout = _binary(sys.stdout if stdout is None else stdout)
    stderr = _binary(sys.stderr if stderr is None else stderr)
    if is_lightweight_probe(command):
        status = subprocess.call(
            command, cwd=cwd, env=environment, stdin=stdin, stdout=stdout, stderr=stderr
        )
        return status if status >= 0 else 128 - status
    if api is None:
        raise BridgeError("Muxdeck API access is required for a provider execution")
    if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
        raise BridgeError(
            "Muxdeck stdio exec requires a platform with waitid(WNOWAIT) process ownership"
        )
    request = getattr(api, "request", api)
    with tempfile.TemporaryDirectory(prefix="muxdeck-stdio-") as directory:
        os.chmod(directory, 0o700)
        path = str(Path(directory) / "relay.sock")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(path)
            os.chmod(path, 0o600)
            listener.listen(1)
            listener.settimeout(15)
            payload = {
                **(launch_options or {}),
                "launchMode": "command",
                "directory": cwd,
                "command": [
                    sys.executable,
                    str(Path(__file__).with_name("stdio_runner.py").resolve()),
                    path,
                ],
                "remainOnExit": True,
            }
            request("POST", "/api/sessions", payload)
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                raise BridgeError(
                    "Muxdeck stdio runner did not connect; exec requires the service on the same host and OS user"
                ) from None
            with connection:
                if not same_user(connection):
                    raise BridgeError(
                        "Muxdeck stdio runner belongs to a different OS user"
                    )
                config = json.dumps(
                    {"command": command, "cwd": cwd, "environment": environment,
                     "mirror_secrets_base64": [base64.b64encode(value).decode() for value in mirror_secrets]},
                    ensure_ascii=True,
                ).encode()
                # Send the private launch config before switching to the data
                # pump. It never enters API payloads, tmux argv, or diagnostics.
                connection.settimeout(15)
                from .stdio_runner import FRAME_LIMIT, HEADER

                if len(config) > FRAME_LIMIT:
                    raise BridgeError("Muxdeck stdio launch configuration is too large")
                connection.sendall(HEADER.pack(b"C", len(config)) + config)
                return _relay(connection, stdin, stdout, stderr, output_observer)
