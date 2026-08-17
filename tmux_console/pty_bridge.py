from __future__ import annotations

import asyncio
import contextlib
import errno
import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
from collections.abc import Sequence


def clamp_size(cols: int, rows: int) -> tuple[int, int]:
    return max(20, min(cols, 500)), max(5, min(rows, 200))


def set_window_size(fd: int, cols: int, rows: int) -> None:
    cols, rows = clamp_size(cols, rows)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class PtyBridge:
    READ_SIZE = 64 * 1024
    MAX_PENDING_CHUNKS = 256

    def __init__(self, master_fd: int, process: subprocess.Popen[bytes]):
        self.master_fd = master_fd
        self.process = process
        self.loop = asyncio.get_running_loop()
        self.output: asyncio.Queue[bytes | None] = asyncio.Queue(self.MAX_PENDING_CHUNKS)
        self.closed = False
        self._poll_task = asyncio.create_task(self._poll_process())
        self.loop.add_reader(self.master_fd, self._read_ready)

    @property
    def client_pid(self) -> int:
        return self.process.pid

    @classmethod
    async def attach(
        cls,
        tmux_command: Sequence[str],
        session_target: str,
        cols: int,
        rows: int,
        ignore_size: bool = False,
    ) -> "PtyBridge":
        master_fd, slave_fd = pty.openpty()
        set_window_size(slave_fd, cols, rows)
        args = list(build_attach_args(tmux_command, session_target, ignore_size))

        env = os.environ.copy()
        env.pop("TMUX", None)
        env.pop("TMUX_PANE", None)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        try:
            process = subprocess.Popen(
                args,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
                env=env,
                start_new_session=True,
            )
        except Exception:
            os.close(master_fd)
            os.close(slave_fd)
            raise
        finally:
            with contextlib.suppress(OSError):
                os.close(slave_fd)

        os.set_blocking(master_fd, False)
        return cls(master_fd, process)

    def _read_ready(self) -> None:
        if self.closed:
            return
        try:
            data = os.read(self.master_fd, self.READ_SIZE)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno not in (errno.EIO, errno.EBADF):
                self._finish()
            else:
                self._finish()
            return

        if not data:
            self._finish()
            return
        try:
            self.output.put_nowait(data)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self.output.get_nowait()
            self._finish()

    async def _poll_process(self) -> None:
        while not self.closed and self.process.poll() is None:
            await asyncio.sleep(0.2)
        self._finish()

    def _finish(self) -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib.suppress(Exception):
            self.loop.remove_reader(self.master_fd)
        if self.output.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.output.get_nowait()
        self.output.put_nowait(None)

    async def read(self) -> bytes | None:
        return await self.output.get()

    async def write(self, data: bytes) -> bool:
        if self.closed:
            return False
        view = memoryview(data)
        while view and not self.closed:
            try:
                written = os.write(self.master_fd, view)
            except InterruptedError:
                await asyncio.sleep(0)
            except BlockingIOError:
                await asyncio.sleep(0.005)
            except OSError:
                self._finish()
                return False
            else:
                if written <= 0:
                    self._finish()
                    return False
                view = view[written:]
        return not view

    def resize(self, cols: int, rows: int) -> None:
        if not self.closed:
            set_window_size(self.master_fd, cols, rows)

    async def close(self) -> None:
        if not self.closed:
            self._finish()

        if self.process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGHUP)
            for _ in range(10):
                if self.process.poll() is not None:
                    break
                await asyncio.sleep(0.02)
            if self.process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(self.process.pid, signal.SIGTERM)

        with contextlib.suppress(OSError):
            os.close(self.master_fd)
        if self._poll_task is not asyncio.current_task():
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task


def build_attach_args(
    tmux_command: Sequence[str], session_target: str, ignore_size: bool = False
) -> Sequence[str]:
    flags = "active-pane,ignore-size" if ignore_size else "active-pane"
    return [*tmux_command, "attach-session", "-E", "-f", flags, "-t", session_target]
