"""Private, same-user stdio relay launched by tmux; runnable by absolute path.

Provider protocol streams use pipes, never terminal capture or terminal input.
The tmux pane receives a best-effort readable mirror, not the wire protocol.
"""

from __future__ import annotations

import codecs
import contextlib
import ctypes
import fcntl
import json
import os
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import time

CHUNK = 65536
INPUT_WINDOW = 262144
QUEUE_LIMIT = 1048576
FRAME_LIMIT = 8388608
HEADER = struct.Struct("!cI")
INTEGER = struct.Struct("!i")
GRACE_SECONDS = 2.0


class BridgeError(RuntimeError):
    pass


class Wire:
    """Bounded binary framing. Each connection has one reader and writer."""

    def __init__(self, connection: socket.socket):
        self.connection = connection
        connection.setblocking(False)
        self.incoming = bytearray()
        self.outgoing = bytearray()
        self.closed = False

    def queue(self, kind: bytes, payload: bytes = b"") -> None:
        if len(payload) > FRAME_LIMIT:
            raise BridgeError("stdio bridge frame is too large")
        self.outgoing.extend(HEADER.pack(kind, len(payload)))
        self.outgoing.extend(payload)

    def flush(self) -> None:
        if self.outgoing:
            try:
                count = self.connection.send(self.outgoing)
            except BlockingIOError:
                return
            del self.outgoing[:count]

    def read(self) -> list[tuple[bytes, bytes]]:
        try:
            data = self.connection.recv(CHUNK)
        except BlockingIOError:
            return []
        if not data:
            self.closed = True
            if self.incoming:
                raise BridgeError("stdio bridge closed during a frame")
            return []
        self.incoming.extend(data)
        frames = []
        while len(self.incoming) >= HEADER.size:
            kind, length = HEADER.unpack_from(self.incoming)
            if length > FRAME_LIMIT:
                raise BridgeError("stdio bridge frame is too large")
            end = HEADER.size + length
            if len(self.incoming) < end:
                break
            frames.append((kind, bytes(self.incoming[HEADER.size : end])))
            del self.incoming[:end]
        return frames


def same_user(connection: socket.socket) -> bool:
    if hasattr(socket, "SO_PEERCRED"):
        _, uid, _ = struct.unpack(
            "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        )
        return uid == os.geteuid()
    if hasattr(connection, "getpeereid"):
        return connection.getpeereid()[0] == os.geteuid()
    return True  # Directory and socket permissions remain the trust boundary.


def _signal_group(process: subprocess.Popen, number: int) -> None:
    if process.returncode is not None:
        return
    # Keep the leader waitable until cleanup. Its reserved PID prevents the
    # process-group identifier from being recycled during output backpressure.
    try:
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, number)


def _exit_status(process: subprocess.Popen) -> int | None:
    if process.returncode is not None:
        return process.returncode
    result = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if result is None:
        return None
    return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status


def _subreaper() -> bool:
    if not sys.platform.startswith("linux"):
        return False
    try:
        return ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    except (OSError, AttributeError):
        return False


def _linux_identity(pid: int) -> tuple[int, int, str] | None:
    try:
        with open(f"/proc/{pid}/stat") as stream:
            fields = stream.read().rsplit(")", 1)[1].split()
        return int(fields[1]), int(fields[19]), fields[0]
    except (OSError, ValueError, IndexError):
        return None


def _descendants() -> dict[int, int]:
    if not sys.platform.startswith("linux"):
        return {}
    records = {}
    with contextlib.suppress(OSError):
        for entry in os.scandir("/proc"):
            if entry.name.isdigit():
                identity = _linux_identity(int(entry.name))
                if identity is not None:
                    records[int(entry.name)] = identity
    parents = {os.getpid()}
    owned: dict[int, int] = {}
    while True:
        additions = {
            pid
            for pid, record in records.items()
            if record[0] in parents and pid not in parents
        }
        if not additions:
            return owned
        parents.update(additions)
        owned.update(
            {pid: records[pid][1] for pid in additions if records[pid][2] != "Z"}
        )


def _signal_descendants(number: int) -> None:
    # Linux subreaper adoption retains ownership even if a tool calls setsid
    # and its original parent exits. Validate identities before each signal.
    for pid, started in _descendants().items():
        descriptor = None
        try:
            if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
                descriptor = os.pidfd_open(pid)
            identity = _linux_identity(pid)
            if identity is None or identity[1] != started:
                continue
            if descriptor is not None:
                signal.pidfd_send_signal(descriptor, number)
            else:
                os.kill(pid, number)
        except ProcessLookupError:
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)


def _signal_owned(process: subprocess.Popen, number: int) -> None:
    _signal_group(process, number)
    _signal_descendants(number)


def _reap_adopted() -> None:
    with contextlib.suppress(ChildProcessError):
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass


def _cleanup(process: subprocess.Popen) -> None:
    # Always signal the group: the leader can have exited with descendants alive.
    _signal_owned(process, signal.SIGTERM)
    deadline = time.monotonic() + GRACE_SECONDS
    while time.monotonic() < deadline:
        if _exit_status(process) is not None and not _descendants():
            break
        time.sleep(0.02)
    _signal_owned(process, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=GRACE_SECONDS)
    _reap_adopted()
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            stream.close()


def _launch(payload: bytes) -> subprocess.Popen:
    try:
        config = json.loads(payload)
        command, directory, environment = (
            config["command"],
            config["cwd"],
            config["environment"],
        )
        if (
            not isinstance(command, list)
            or not command
            or any(not isinstance(arg, str) or "\0" in arg for arg in command)
        ):
            raise ValueError
        if (
            not command[0]
            or not isinstance(directory, str)
            or not os.path.isabs(directory)
        ):
            raise ValueError
        if not isinstance(environment, dict) or any(
            not isinstance(key, str)
            or not key
            or "=" in key
            or "\0" in key
            or not isinstance(value, str)
            or "\0" in value
            for key, value in environment.items()
        ):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise BridgeError("invalid stdio bridge launch configuration") from None
    # Location variables describe this new pane, even when the controller was
    # launched from another tmux session. Provider homes/tokens remain exact.
    for key in ("TMUX", "TMUX_PANE"):
        if key in os.environ:
            environment[key] = os.environ[key]
        else:
            environment.pop(key, None)
    return subprocess.Popen(
        command,
        cwd=directory,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        bufsize=0,
    )


def _mirror(payload: bytes, decoder) -> None:
    text = decoder.decode(payload)
    # Protocol bytes stay untouched on the wire. Keep the terminal mirror readable
    # and prevent escape/control sequences from becoming terminal instructions.
    text = "".join(
        char
        if char in "\n\r\t" or ord(char) >= 32 and not 127 <= ord(char) <= 159
        else "�"
        for char in text
    )
    with contextlib.suppress(OSError):
        os.write(1, text.encode("utf-8"))


def _pane_ownership(owned: bool) -> None:
    pane = os.environ.get("TMUX_PANE", "")
    tmux_environment = os.environ.get("TMUX", "")
    if not re.fullmatch(r"%\d+", pane) or not tmux_environment:
        return
    socket_path = tmux_environment.rsplit(",", 2)[0]
    prefix = ["tmux", "-S", socket_path]
    commands = [
        ["select-pane", "-d" if owned else "-e", "-t", pane],
        [
            "set-option",
            "-p",
            "-t",
            pane,
            "@muxdeck_input_owner",
            "stdio" if owned else "",
        ],
    ]
    for command in commands:
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            subprocess.run(
                prefix + command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )


def serve(connection: socket.socket) -> int:
    wire = Wire(connection)
    process = None
    pending_input = bytearray()
    input_acknowledgement = 0
    input_eof = False
    input_open = True
    outputs: dict[int, bytes] = {}
    decoders = {
        b"O": codecs.getincrementaldecoder("utf-8")("replace"),
        b"D": codecs.getincrementaldecoder("utf-8")("replace"),
    }
    terminating_at = None
    escalation_sent = False
    child_exited_at = None
    configuration_deadline = time.monotonic() + 15
    result_queued = False
    drain_budget: dict[int, int] | None = None
    caught_signal = None
    previous_handlers = {}

    def interrupt(number, _frame):
        nonlocal caught_signal
        caught_signal = number

    try:
        if sys.platform.startswith("linux") and not _subreaper():
            raise BridgeError("Linux provider ownership could not be established")
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous_handlers[number] = signal.signal(number, interrupt)
        with contextlib.suppress(OSError):
            os.set_blocking(1, False)
        while True:
            if wire.closed:
                return 1
            if process is None and time.monotonic() > configuration_deadline:
                raise BridgeError("stdio bridge launch configuration timed out")
            if caught_signal is not None:
                if process is None:
                    return 128 + caught_signal
                _signal_owned(process, caught_signal)
                terminating_at = terminating_at or time.monotonic()
                caught_signal = None
            if process is not None:
                status = _exit_status(process)
                if status is not None and child_exited_at is None:
                    child_exited_at = time.monotonic()
                    # Tools must not survive their owner's final exit.
                    _signal_owned(process, signal.SIGTERM)
                if (
                    terminating_at is not None
                    and time.monotonic() - terminating_at >= GRACE_SECONDS
                    and not escalation_sent
                ):
                    _signal_owned(process, signal.SIGKILL)
                    escalation_sent = True
                if (
                    child_exited_at is not None
                    and time.monotonic() - child_exited_at >= GRACE_SECONDS
                    and drain_budget is None
                ):
                    _signal_owned(process, signal.SIGKILL)
                    # Preserve exactly the buffered pipe backlog even when the
                    # caller reads slowly. A lingering inherited writer cannot
                    # extend the provider's run indefinitely.
                    drain_budget = {}
                    for descriptor in list(outputs):
                        try:
                            available = struct.unpack(
                                "i",
                                fcntl.ioctl(
                                    descriptor, termios.FIONREAD, struct.pack("i", 0)
                                ),
                            )[0]
                        except OSError:
                            available = CHUNK
                        drain_budget[descriptor] = available
                        if not available:
                            outputs.pop(descriptor)
                if status is not None and not outputs and not result_queued:
                    wire.queue(b"X", INTEGER.pack(status))
                    result_queued = True
                if result_queued and not wire.outgoing:
                    assert status is not None
                    return status if status >= 0 else 128 - status
            if input_acknowledgement and len(wire.outgoing) < QUEUE_LIMIT - 16:
                wire.queue(b"A", INTEGER.pack(input_acknowledgement))
                input_acknowledgement = 0
            with selectors.DefaultSelector() as selector:
                selector.register(
                    connection,
                    selectors.EVENT_READ
                    | (selectors.EVENT_WRITE if wire.outgoing else 0),
                    "socket",
                )
                if len(wire.outgoing) < QUEUE_LIMIT - CHUNK - HEADER.size:
                    for descriptor, kind in outputs.items():
                        selector.register(descriptor, selectors.EVENT_READ, kind)
                if process is not None and input_open and pending_input:
                    assert process.stdin is not None
                    selector.register(
                        process.stdin.fileno(), selectors.EVENT_WRITE, "stdin"
                    )
                for key, mask in selector.select(0.1):
                    if key.data == "socket":
                        if mask & selectors.EVENT_WRITE:
                            wire.flush()
                        if mask & selectors.EVENT_READ:
                            for kind, payload in wire.read():
                                if kind == b"C" and process is None:
                                    _pane_ownership(True)
                                    process = _launch(payload)
                                    assert process.stdin is not None
                                    assert process.stdout is not None
                                    assert process.stderr is not None
                                    for stream in (
                                        process.stdin,
                                        process.stdout,
                                        process.stderr,
                                    ):
                                        os.set_blocking(stream.fileno(), False)
                                    outputs = {
                                        process.stdout.fileno(): b"O",
                                        process.stderr.fileno(): b"D",
                                    }
                                elif kind == b"I" and process is not None:
                                    if input_eof or not input_open:
                                        input_acknowledgement += len(payload)
                                    elif (
                                        len(pending_input) + len(payload) > INPUT_WINDOW
                                    ):
                                        raise BridgeError(
                                            "stdio bridge input window exceeded"
                                        )
                                    else:
                                        pending_input.extend(payload)
                                elif (
                                    kind == b"E" and process is not None and not payload
                                ):
                                    input_eof = True
                                elif (
                                    kind == b"S"
                                    and process is not None
                                    and len(payload) == INTEGER.size
                                ):
                                    number = INTEGER.unpack(payload)[0]
                                    if number not in {
                                        signal.SIGINT,
                                        signal.SIGTERM,
                                        signal.SIGHUP,
                                    }:
                                        raise BridgeError("invalid stdio bridge signal")
                                    _signal_owned(process, number)
                                    terminating_at = terminating_at or time.monotonic()
                                else:
                                    raise BridgeError("unexpected stdio bridge frame")
                    elif key.data == "stdin":
                        try:
                            count = os.write(key.fd, pending_input)
                        except BrokenPipeError:
                            count = len(pending_input)
                            input_eof = True
                            wire.queue(b"B")
                        except BlockingIOError:
                            continue
                        del pending_input[:count]
                        input_acknowledgement += count
                    else:
                        try:
                            limit = (
                                CHUNK
                                if drain_budget is None
                                else min(CHUNK, drain_budget[key.fd])
                            )
                            payload = os.read(key.fd, limit)
                        except BlockingIOError:
                            continue
                        if payload:
                            wire.queue(key.data, payload)
                            _mirror(payload, decoders[key.data])
                            if drain_budget is not None:
                                drain_budget[key.fd] -= len(payload)
                                if not drain_budget[key.fd]:
                                    outputs.pop(key.fd, None)
                        else:
                            outputs.pop(key.fd, None)
            if process is not None and input_open and input_eof and not pending_input:
                assert process.stdin is not None
                process.stdin.close()
                input_open = False
    except (OSError, BridgeError) as error:
        # Configuration/env/argv values never enter diagnostics.
        with contextlib.suppress(OSError):
            wire.queue(
                b"F", ("Muxdeck stdio bridge failed: " + type(error).__name__).encode()
            )
            deadline = time.monotonic() + 1
            while wire.outgoing and time.monotonic() < deadline:
                wire.flush()
                time.sleep(0.01)
        return 1
    finally:
        if process is not None:
            _cleanup(process)
        _pane_ownership(False)
        connection.close()
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
        return 1
    path = sys.argv[1]
    endpoint = None
    verified_rendezvous = False
    try:
        directory = os.stat(os.path.dirname(path), follow_symlinks=False)
        endpoint = os.stat(path, follow_symlinks=False)
        if (
            directory.st_uid != os.geteuid()
            or directory.st_mode & 0o077
            or not stat.S_ISDIR(directory.st_mode)
        ):
            return 1
        if (
            endpoint.st_uid != os.geteuid()
            or endpoint.st_mode & 0o077
            or not stat.S_ISSOCK(endpoint.st_mode)
        ):
            return 1
        verified_rendezvous = True
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(15)
        connection.connect(path)
        if not same_user(connection):
            connection.close()
            return 1
        return serve(connection)
    except OSError:
        return 1
    finally:
        # The controller can die with SIGKILL, which bypasses TemporaryDirectory
        # cleanup. Only remove the verified private rendezvous we connected to.
        if (
            verified_rendezvous
            and endpoint is not None
            and os.path.basename(os.path.dirname(path)).startswith("muxdeck-stdio-")
        ):
            with contextlib.suppress(OSError):
                current = os.stat(path, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (
                    endpoint.st_dev,
                    endpoint.st_ino,
                ):
                    os.unlink(path)
                    os.rmdir(os.path.dirname(path))


if __name__ == "__main__":
    raise SystemExit(main())
