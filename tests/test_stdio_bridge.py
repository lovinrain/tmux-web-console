from __future__ import annotations

import codecs
import io
import json
import os
import select
import signal
import stat
import subprocess
import sys
import threading
import time
from itertools import product
from pathlib import Path
from types import SimpleNamespace

import pytest

from tmux_console import stdio_runner
from tmux_console.stdio_bridge import is_lightweight_probe, run


def test_output_observer_retains_delivered_bytes_without_replacing_protocol(tmp_path, launch_api):
    observed = {"stdout": bytearray(), "stderr": bytearray()}
    output, errors = io.BytesIO(), io.BytesIO()
    status = run([sys.executable, "-c", "import sys; sys.stdout.buffer.write(bytes(range(256))); sys.stderr.buffer.write(b'problem')"],
                 api=launch_api, cwd=str(tmp_path), environment=dict(os.environ), stdin=io.BytesIO(),
                 stdout=output, stderr=errors,
                 output_observer=lambda kind, content: observed[kind].extend(content))
    assert status == 0
    assert output.getvalue() == bytes(observed["stdout"]) == bytes(range(256))
    assert errors.getvalue() == bytes(observed["stderr"]) == b"problem"


def test_output_observer_failure_is_explicit_and_disconnects_owned_runner(tmp_path, launch_api):
    def observe(kind, content):
        raise OSError("required evidence unavailable")

    with pytest.raises(OSError, match="evidence unavailable"):
        run([sys.executable, "-c", "import time; print('ready',flush=True); time.sleep(30)"],
            api=launch_api, cwd=str(tmp_path), environment=dict(os.environ), stdin=io.BytesIO(),
            stdout=io.BytesIO(), stderr=io.BytesIO(), output_observer=observe)
    launch_api.processes[0].wait(timeout=5)


def test_mirror_secret_redactor_covers_every_chunk_boundary_with_bounded_pending():
    secret = b"known-credential-sentinel"
    for boundary in range(len(secret) + 1):
        redactor = stdio_runner.StreamingRedactor((secret,))
        captured = redactor.feed(b"before " + secret[:boundary])
        assert len(redactor.pending) < len(secret)
        captured += redactor.feed(secret[boundary:] + b" after\n")
        captured += redactor.feed(b"", final=True)
        assert captured == b"before [REDACTED] after\n"
        assert redactor.redacted and redactor.pending == b""


@pytest.mark.parametrize("secrets", [(b"abcabc",), (b"abab",), (b"aba", b"abab"), (b"abc", b"abcabc")])
def test_mirror_redactor_preserves_whole_stream_semantics_for_overlapping_secrets(secrets):
    streams = [b"prefix " + secret * 3 + b" suffix" for secret in secrets]
    streams.extend(bytes(values) for size in range(7) for values in product(b"abc", repeat=size))
    for stream in streams:
        for boundary in range(len(stream) + 1):
            redactor = stdio_runner.StreamingRedactor(secrets)
            assert redactor.pattern is not None
            expected = redactor.pattern.sub(b"[REDACTED]", stream)
            captured = redactor.feed(stream[:boundary]) + redactor.feed(stream[boundary:]) + redactor.feed(b"", final=True)
            assert captured == expected, (stream, boundary)
            assert not any(secret in captured for secret in secrets), (stream, boundary)
        redactor = stdio_runner.StreamingRedactor(secrets)
        byte_chunks = b"".join(redactor.feed(bytes([value])) for value in stream) + redactor.feed(b"", final=True)
        assert byte_chunks == expected


def test_private_mirror_redaction_values_never_replace_provider_protocol(tmp_path, launch_api):
    secret = b"private-mirror-credential"
    output = io.BytesIO()
    assert run([sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
               api=launch_api, cwd=str(tmp_path), environment=dict(os.environ), stdin=io.BytesIO(secret),
               stdout=output, stderr=io.BytesIO(), mirror_secrets=(secret,)) == 0
    assert output.getvalue() == secret
    assert secret not in json.dumps(launch_api.requests).encode()


def test_mirror_redactor_refuses_unbounded_secret_configuration():
    with pytest.raises(stdio_runner.BridgeError, match="supported bounds"):
        stdio_runner.StreamingRedactor((b"x" * (stdio_runner.MAX_MIRROR_SECRET_BYTES + 1),))


class LocalLaunchAPI:
    """Exercise the real rendezvous/runner without contacting a tmux server."""

    def __init__(self, terminal_output=subprocess.DEVNULL) -> None:
        self.terminal_output = terminal_output
        self.requests: list[tuple[str, str, dict]] = []
        self.processes: list[subprocess.Popen] = []
        self.stderr: list[bytearray] = []
        self.readers: list[threading.Thread] = []
        self.rendezvous_modes: list[tuple[int, int]] = []
        self.runner_environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"TMUX", "TMUX_PANE"}
        }

    def __call__(self, method: str, path: str, payload: dict | None = None) -> dict:
        assert method == "POST"
        assert path == "/api/sessions"
        assert payload is not None
        assert payload["launchMode"] == "command"
        assert payload["remainOnExit"] is True
        command = payload["command"]
        assert isinstance(command, list)
        rendezvous = Path(command[-1])
        self.rendezvous_modes.append(
            (
                stat.S_IMODE(rendezvous.parent.stat().st_mode),
                stat.S_IMODE(rendezvous.stat().st_mode),
            )
        )
        self.requests.append((method, path, dict(payload)))
        process = subprocess.Popen(
            command,
            cwd=payload["directory"],
            stdout=self.terminal_output,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env=self.runner_environment,
        )
        self.processes.append(process)
        captured = bytearray()
        self.stderr.append(captured)

        def drain() -> None:
            assert process.stderr is not None
            while chunk := process.stderr.read(65536):
                captured.extend(chunk)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        self.readers.append(reader)
        return {"sessionName": "bridge-test", "sessionId": "$42", "paneId": "%42"}

    def close(self) -> None:
        for process in self.processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        for reader in self.readers:
            reader.join(timeout=3)
        for process in self.processes:
            if process.stderr is not None:
                process.stderr.close()


@pytest.fixture
def launch_api():
    api = LocalLaunchAPI()
    try:
        yield api
    finally:
        api.close()


def test_binary_streams_are_exact_and_stdin_eof_reaches_provider(tmp_path, launch_api):
    source = bytes(range(256)) * 4097
    expected_stderr = bytes(reversed(range(256))) * 4097
    provider = (
        "import os,sys; data=sys.stdin.buffer.read(); "
        "sys.stdout.buffer.write(data[::-1]); sys.stdout.buffer.flush(); "
        "sys.stderr.buffer.write(bytes(reversed(range(256)))*4097); "
        "sys.stderr.buffer.flush()"
    )
    output, errors = io.BytesIO(), io.BytesIO()

    result = run(
        [sys.executable, "-c", provider],
        api=launch_api,
        cwd=str(tmp_path),
        environment=dict(os.environ),
        launch_options={"name": "binary-agent", "workspaceId": "workspace-test"},
        stdin=io.BytesIO(source),
        stdout=output,
        stderr=errors,
    )

    assert result == 0
    assert output.getvalue() == source[::-1]
    assert errors.getvalue() == expected_stderr
    assert len(launch_api.requests) == 1
    payload = launch_api.requests[0][2]
    assert payload["name"] == "binary-agent"
    assert payload["workspaceId"] == "workspace-test"


def test_provider_receives_cwd_environment_and_literal_argv(tmp_path, launch_api):
    argument = "spaces 'quotes' $HOME $(never-run) ; newline\n雪"
    provider = (
        "import json,os,sys; print(json.dumps({"
        "'cwd':os.getcwd(),'argv':sys.argv[1:],"
        "'environment':os.environ['MUXDECK_BRIDGE_TEST']}))"
    )
    output = io.BytesIO()

    assert (
        run(
            [sys.executable, "-c", provider, argument],
            api=launch_api,
            cwd=str(tmp_path),
            environment={**os.environ, "MUXDECK_BRIDGE_TEST": "literal environment ✓"},
            launch_options={},
            stdin=io.BytesIO(),
            stdout=output,
            stderr=io.BytesIO(),
        )
        == 0
    )

    assert json.loads(output.getvalue()) == {
        "cwd": str(tmp_path),
        "argv": [argument],
        "environment": "literal environment ✓",
    }


def test_stale_caller_tmux_identity_is_removed_when_runner_has_no_pane(
    tmp_path, launch_api
):
    provider = "import json,os; print(json.dumps({key:os.environ.get(key) for key in ['TMUX','TMUX_PANE','CODEX_HOME']}))"
    output = io.BytesIO()

    assert (
        run(
            [sys.executable, "-c", provider],
            api=launch_api,
            cwd=str(tmp_path),
            environment={
                **os.environ,
                "TMUX": "/stale/socket,123,0",
                "TMUX_PANE": "%999",
                "CODEX_HOME": "/task/provider-home",
            },
            launch_options={},
            stdin=io.BytesIO(),
            stdout=output,
            stderr=io.BytesIO(),
        )
        == 0
    )

    assert json.loads(output.getvalue()) == {
        "TMUX": None,
        "TMUX_PANE": None,
        "CODEX_HOME": "/task/provider-home",
    }


def test_nonzero_provider_exit_is_returned(tmp_path, launch_api):
    output, errors = io.BytesIO(), io.BytesIO()
    result = run(
        [
            sys.executable,
            "-c",
            "import sys; print('result'); print('failure',file=sys.stderr); sys.exit(23)",
        ],
        api=launch_api,
        cwd=str(tmp_path),
        environment=dict(os.environ),
        launch_options={},
        stdin=io.BytesIO(),
        stdout=output,
        stderr=errors,
    )

    assert result == 23
    assert output.getvalue() == b"result\n"
    assert errors.getvalue() == b"failure\n"


def test_provider_can_close_stdin_and_continue_work_with_input_in_flight(
    tmp_path, launch_api
):
    provider = (
        "import os,sys,time\n"
        "os.close(0)\n"
        "print('stdin closed',flush=True)\n"
        "time.sleep(0.15)\n"
        "print('work completed',flush=True)\n"
        "sys.exit(17)\n"
    )
    output = io.BytesIO()

    assert (
        run(
            [sys.executable, "-c", provider],
            api=launch_api,
            cwd=str(tmp_path),
            environment=dict(os.environ),
            launch_options={},
            stdin=io.BytesIO(b"unconsumed input" * 100000),
            stdout=output,
            stderr=io.BytesIO(),
        )
        == 17
    )

    assert output.getvalue() == b"stdin closed\nwork completed\n"


def _readline_with_deadline(stream, timeout: float = 5) -> bytes:
    deadline = time.monotonic() + timeout
    output = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select(
            [stream], [], [], max(0, deadline - time.monotonic())
        )
        if not ready:
            break
        byte = os.read(stream.fileno(), 1)
        if not byte:
            raise AssertionError(
                f"Protocol stdout closed before a line: {bytes(output)!r}"
            )
        output.extend(byte)
        if byte == b"\n":
            return bytes(output)
    raise AssertionError(f"Timed out awaiting a protocol response: {bytes(output)!r}")


def test_json_rpc_responses_arrive_before_stdin_eof(tmp_path, launch_api):
    provider = (
        "import json,sys\n"
        "for line in sys.stdin:\n"
        " request=json.loads(line)\n"
        " print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':request['params']}),flush=True)\n"
    )
    input_read, input_write = os.pipe()
    output_read, output_write = os.pipe()
    source = os.fdopen(input_read, "rb", buffering=0)
    destination = os.fdopen(output_write, "wb", buffering=0)
    requests = os.fdopen(input_write, "wb", buffering=0)
    responses = os.fdopen(output_read, "rb", buffering=0)
    results: list[int | BaseException] = []

    def bridge() -> None:
        try:
            results.append(
                run(
                    [sys.executable, "-c", provider],
                    api=launch_api,
                    cwd=str(tmp_path),
                    environment=dict(os.environ),
                    launch_options={},
                    stdin=source,
                    stdout=destination,
                    stderr=io.BytesIO(),
                )
            )
        except BaseException as error:  # noqa: BLE001 - transfer worker failure to the asserting thread
            results.append(error)

    controller = threading.Thread(target=bridge, daemon=True)
    controller.start()
    try:
        for request_id, params in [
            (1, {"prompt": "first"}),
            (2, {"steer": "follow-up ✓"}),
        ]:
            request = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "work",
                "params": params,
            }
            requests.write(json.dumps(request).encode() + b"\n")
            assert json.loads(_readline_with_deadline(responses)) == {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": params,
            }
        requests.close()
        controller.join(timeout=5)
        assert not controller.is_alive(), (
            "Bridge did not finish after provider stdin EOF"
        )
        assert results == [0]
    finally:
        requests.close()
        controller.join(timeout=5)
        source.close()
        destination.close()
        responses.close()


def test_provider_exit_finishes_without_waiting_for_caller_stdin_eof(
    tmp_path, launch_api
):
    input_read, input_write = os.pipe()
    source = os.fdopen(input_read, "rb", buffering=0)
    requests = os.fdopen(input_write, "wb", buffering=0)
    output = io.BytesIO()
    results: list[int | BaseException] = []

    def bridge() -> None:
        try:
            results.append(
                run(
                    [
                        sys.executable,
                        "-c",
                        "import sys; print('finished',flush=True); sys.exit(19)",
                    ],
                    api=launch_api,
                    cwd=str(tmp_path),
                    environment=dict(os.environ),
                    launch_options={},
                    stdin=source,
                    stdout=output,
                    stderr=io.BytesIO(),
                )
            )
        except BaseException as error:  # noqa: BLE001 - transfer worker failure to the asserting thread
            results.append(error)

    controller = threading.Thread(target=bridge, daemon=True)
    controller.start()
    try:
        controller.join(timeout=5)
        assert not controller.is_alive(), (
            "Bridge waited for caller EOF after provider exited"
        )
        assert not requests.closed
        assert results == [19]
        assert output.getvalue() == b"finished\n"
    finally:
        requests.close()
        controller.join(timeout=5)
        source.close()


def test_slow_stdout_consumer_receives_all_output_after_provider_exit(
    tmp_path, launch_api
):
    marker = tmp_path / "finished-provider"
    expected = bytes(range(256)) * 8193
    provider = (
        "import os,sys\n"
        "sys.stdout.buffer.write(bytes(range(256))*8193)\n"
        "sys.stdout.buffer.flush()\n"
        "with open(sys.argv[1],'w') as marker: marker.write(str(os.getpid()))\n"
    )
    output_read, output_write = os.pipe()
    responses = os.fdopen(output_read, "rb", buffering=0)
    destination = os.fdopen(output_write, "wb", buffering=0)
    results: list[int | BaseException] = []

    def bridge() -> None:
        try:
            results.append(
                run(
                    [sys.executable, "-c", provider, str(marker)],
                    api=launch_api,
                    cwd=str(tmp_path),
                    environment=dict(os.environ),
                    launch_options={},
                    stdin=io.BytesIO(),
                    stdout=destination,
                    stderr=io.BytesIO(),
                )
            )
        except BaseException as error:  # noqa: BLE001 - transfer worker failure to the asserting thread
            results.append(error)

    controller = threading.Thread(target=bridge, daemon=True)
    controller.start()
    received = bytearray()
    try:
        # The caller deliberately stops consuming protocol stdout beyond the
        # process-group cleanup grace period. Buffered output remains owed.
        time.sleep(3)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            ready, _, _ = select.select([responses], [], [], 0.1)
            if ready:
                received.extend(os.read(responses.fileno(), 65536))
            elif not controller.is_alive():
                break
        controller.join(timeout=5)
        assert not controller.is_alive(), (
            "Bridge did not drain output after its consumer resumed"
        )
        assert results == [0]
        assert marker.exists(), "Provider never finished producing its output"
        assert bytes(received) == expected
    finally:
        responses.close()
        controller.join(timeout=5)
        destination.close()


def test_rendezvous_directory_and_socket_are_private_and_removed(tmp_path, launch_api):
    assert (
        run(
            [sys.executable, "-c", "pass"],
            api=launch_api,
            cwd=str(tmp_path),
            environment=dict(os.environ),
            launch_options={},
            stdin=io.BytesIO(),
            stdout=io.BytesIO(),
            stderr=io.BytesIO(),
        )
        == 0
    )

    assert launch_api.rendezvous_modes == [(0o700, 0o600)]
    rendezvous = Path(launch_api.requests[0][2]["command"][-1])
    assert not rendezvous.exists()
    assert not rendezvous.parent.exists()


@pytest.mark.parametrize("flag", ["--version", "-V", "--help", "-h"])
def test_lightweight_probe_requires_exactly_one_probe_argument(flag):
    assert is_lightweight_probe(["provider", flag])
    assert not is_lightweight_probe(["provider", "app-server", flag])
    assert not is_lightweight_probe(["provider", flag, "--model", "example"])
    assert not is_lightweight_probe(["provider"])


@pytest.mark.parametrize("flag", ["--version", "-V", "--help", "-h"])
def test_lightweight_probe_allows_only_qualified_helper_gate_around_probe(flag):
    assert is_lightweight_probe(["provider", "--disable", "multi_agent", flag])
    assert is_lightweight_probe(["provider", flag, "--disable", "multi_agent"])
    assert is_lightweight_probe(["provider", "--disable=multi_agent", flag])
    assert not is_lightweight_probe(["provider", "--disable", "multi_agent", "app-server", flag])
    assert not is_lightweight_probe(["provider", "--disable", "multi_agent", "exec", flag])
    assert not is_lightweight_probe(["provider", "--disable", "other_feature", flag])
    assert not is_lightweight_probe(["provider", "--disable", "multi_agent", flag, "--model", "example"])
    assert not is_lightweight_probe(["provider", "--disable", "multi_agent", flag, "--version"])
    assert not is_lightweight_probe(["provider", "--disable", "multi_agent"])


def test_version_probe_bypasses_api_and_preserves_exit_code_and_streams(tmp_path):
    provider = tmp_path / "provider"
    provider.write_text(
        f"#!{sys.executable}\nimport sys\n"
        "print('provider version 1')\nprint('probe warning', file=sys.stderr)\nsys.exit(7)\n"
    )
    provider.chmod(0o700)

    def unexpected_api(*args, **kwargs):
        raise AssertionError(
            "A discovery probe must not create a persistent agent session"
        )

    with (
        (tmp_path / "stdout").open("w+b") as output,
        (tmp_path / "stderr").open("w+b") as errors,
        open(os.devnull, "rb") as source,
    ):
        assert (
            run(
                [str(provider), "--version"],
                api=unexpected_api,
                cwd=str(tmp_path),
                environment=dict(os.environ),
                launch_options={},
                stdin=source,
                stdout=output,
                stderr=errors,
            )
            == 7
        )
        output.seek(0)
        errors.seek(0)
        assert output.read() == b"provider version 1\n"
        assert errors.read() == b"probe warning\n"


def _process_is_running(pid: int) -> bool:
    try:
        status = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return False
    return status.rsplit(")", 1)[1].split()[0] != "Z"


def _await_condition(condition, message: str, timeout: float = 8) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError(message)


@pytest.mark.skipif(
    not Path("/proc/self/stat").exists(),
    reason="Process-tree assertions require Linux /proc",
)
@pytest.mark.parametrize(
    "signal_target,owner_signal,backpressure,detached_grandchild",
    [
        ("controller", signal.SIGTERM, False, False),
        ("controller", signal.SIGKILL, False, False),
        ("controller", signal.SIGTERM, True, False),
        ("runner", signal.SIGTERM, False, False),
        ("controller", signal.SIGKILL, False, True),
    ],
    ids=[
        "sigterm-blocked-stdin",
        "sigkill-blocked-stdin",
        "sigterm-full-input-window",
        "runner-sigterm",
        "sigkill-escaped-grandchild",
    ],
)
def test_owner_death_cleans_provider_and_grandchild_while_stdin_is_blocked(
    tmp_path,
    signal_target,
    owner_signal,
    backpressure,
    detached_grandchild,
):
    child_pids = tmp_path / "provider-pids.json"
    runner_pid = tmp_path / "runner-pid"
    rendezvous_path = tmp_path / "rendezvous-path"
    provider_code = (
        "import json,os,signal,subprocess,sys,time\n"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
        "child=subprocess.Popen([sys.executable,'-c',"
        "'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)'],"
        f"start_new_session={detached_grandchild!r})\n"
        "with open(sys.argv[1]+'.tmp','w') as marker: json.dump([os.getpid(),child.pid],marker)\n"
        "os.replace(sys.argv[1]+'.tmp',sys.argv[1])\n"
        "print('ready',flush=True)\n"
        "time.sleep(120)\n"
    )
    controller_code = (
        "import os,subprocess,sys\n"
        "from pathlib import Path\n"
        "from tmux_console.stdio_bridge import run\n"
        "def api(method,path,payload=None):\n"
        " runner=subprocess.Popen(payload['command'],cwd=payload['directory'],"
        "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,"
        "env={key:value for key,value in os.environ.items() if key not in {'TMUX','TMUX_PANE'}})\n"
        " Path(sys.argv[2]).write_text(str(runner.pid))\n"
        " Path(sys.argv[3]).write_text(payload['command'][-1])\n"
        " return {'sessionName':'test','sessionId':'$42','paneId':'%42'}\n"
        f"sys.exit(run([sys.executable,'-c',{provider_code!r},sys.argv[1]],"
        "api=api,cwd=os.getcwd(),environment=dict(os.environ),launch_options={}))\n"
    )
    controller = subprocess.Popen(
        [
            sys.executable,
            "-c",
            controller_code,
            str(child_pids),
            str(runner_pid),
            str(rendezvous_path),
        ],
        cwd=Path(__file__).parents[1],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    provider_pids: list[int] = []
    writer = None
    input_written = [0]
    writing_finished = threading.Event()

    def fill_input() -> None:
        assert controller.stdin is not None
        try:
            while input_written[0] < 2 * 1024 * 1024:
                input_written[0] += os.write(controller.stdin.fileno(), b"x" * 32768)
        except (BrokenPipeError, OSError):
            pass
        finally:
            writing_finished.set()

    try:
        _await_condition(
            lambda: child_pids.exists() and child_pids.stat().st_size > 0,
            "Provider did not start and publish its process tree",
        )
        provider_pids = json.loads(child_pids.read_text())
        assert all(_process_is_running(pid) for pid in provider_pids)
        assert controller.stdout is not None
        assert _readline_with_deadline(controller.stdout) == b"ready\n"
        if backpressure:
            writer = threading.Thread(target=fill_input, daemon=True)
            writer.start()
            _await_condition(
                lambda: input_written[0] >= 256 * 1024,
                "Controller did not accept enough input to fill its flow-control window",
            )
            assert not writing_finished.is_set(), (
                "A provider refusing stdin must exert backpressure"
            )
        if signal_target == "runner":
            os.kill(int(runner_pid.read_text()), owner_signal)
        else:
            controller.send_signal(owner_signal)
        controller.wait(timeout=8)
        assert controller.returncode != 0
        _await_condition(
            lambda: all(not _process_is_running(pid) for pid in provider_pids),
            f"Provider process tree survived {signal_target} signal {owner_signal}",
        )
        _await_condition(
            lambda: not _process_is_running(int(runner_pid.read_text())),
            "Runner survived its disconnected controller",
        )
        rendezvous = Path(rendezvous_path.read_text())
        assert not rendezvous.exists()
        assert not rendezvous.parent.exists(), (
            "Controller death left an orphaned rendezvous directory"
        )
    finally:
        if controller.poll() is None:
            controller.kill()
            controller.wait(timeout=5)
        if writer is not None:
            writer.join(timeout=3)
        if not provider_pids and child_pids.exists():
            provider_pids = json.loads(child_pids.read_text())
        cleanup_pids = provider_pids + (
            [int(runner_pid.read_text())] if runner_pid.exists() else []
        )
        for pid in cleanup_pids:
            if _process_is_running(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for stream in (controller.stdin, controller.stdout, controller.stderr):
            if stream is not None:
                stream.close()


def test_terminal_mirror_filters_control_sequences_and_preserves_utf8(monkeypatch):
    writes = []

    def capture(descriptor, payload):
        writes.append((descriptor, payload))
        return len(payload)

    monkeypatch.setattr(stdio_runner.os, "write", capture)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    stdio_runner._mirror(
        "plain 雪\tline\n\r\x1b\x00\x01\x08\x7f\u009b\u009d".encode(), decoder
    )

    assert writes == [(1, "plain 雪\tline\n\r�������".encode())]


def test_signal_group_skips_already_reaped_process(monkeypatch):
    process = SimpleNamespace(pid=123456, returncode=0)

    def unexpected_signal(*args):
        pytest.fail("A reaped provider PID must not be used to signal a process group")

    # Even if a later child reused that numeric PID, the original Popen's exit
    # status fences process-group signaling before consulting the OS again.
    monkeypatch.setattr(stdio_runner.os, "waitid", lambda *args: None)
    monkeypatch.setattr(stdio_runner.os, "killpg", unexpected_signal)

    stdio_runner._signal_group(process, signal.SIGTERM)


@pytest.mark.parametrize("mirror_format", [None, "codex-app-server-v1"])
def test_qualified_codex_mirror_changes_only_display_after_redaction(tmp_path, mirror_format):
    secret = b"synthetic-private-mirror-token"
    opaque = "opaque-reasoning-correlation-" * 200
    records = [
        {"method": "turn/started", "params": {}},
        {"method": "item/started", "params": {"item": {"type": "reasoning", "id": opaque}}},
        {"method": "thread/tokenUsage/updated", "params": {"tokenUsage": {"count": 9999}}},
        {"method": "item/agentMessage/delta", "params": {"itemId": "visible", "delta": "Checking API " + secret.decode() + " 雪\n"}},
        {"method": "turn/completed", "params": {"turn": {"status": "interrupted"}}},
    ]
    wire = b"".join((json.dumps(record, ensure_ascii=False) + "\n").encode() for record in records)
    output, observed = io.BytesIO(), bytearray()
    mirror_path = tmp_path / "terminal-mirror.txt"
    with mirror_path.open("w+b") as terminal:
        api = LocalLaunchAPI(terminal_output=terminal)
        try:
            status = run([sys.executable, "-c", "import sys; data=sys.stdin.buffer.read(); [sys.stdout.buffer.write(data[i:i+31]) for i in range(0,len(data),31)]"],
                api=api, cwd=str(tmp_path), environment=dict(os.environ), stdin=io.BytesIO(wire),
                stdout=output, stderr=io.BytesIO(), mirror_secrets=(secret,), mirror_format=mirror_format,
                output_observer=lambda kind, content: observed.extend(content) if kind == "stdout" else None)
            assert status == 0
        finally:
            api.close()
        terminal.seek(0)
        visible = terminal.read()
    assert output.getvalue() == bytes(observed) == wire
    assert secret not in visible
    assert b"[REDACTED]" in visible
    if mirror_format:
        assert "[Agent] Checking API [REDACTED] 雪".encode() in visible
        assert b"[Turn] Interrupted." in visible
        assert b"opaque-reasoning-correlation" not in visible
        assert b"tokenUsage" not in visible
    else:
        assert b"opaque-reasoning-correlation" in visible
        assert b"tokenUsage" in visible


@pytest.mark.parametrize(
    "case",
    [
        "unicode-escaped",
        "ascii-escaped",
        "joined-deltas",
        "interleaved-items",
        "json-delimiters",
        "escaped-surrogate",
    ],
)
def test_codex_rendered_credentials_are_redacted_after_unescaping_and_delta_join(
    tmp_path, case
):
    secret = {
        "unicode-escaped": "føø-private-🔒",
        "json-delimiters": '", "delta": "',
    }.get(case, "synthetic-joined-credential")
    parts = (
        [secret[:13], secret[13:]]
        if case in {"joined-deltas", "interleaved-items"}
        else [secret]
    )
    records = [
        {
            "method": "item/agentMessage/delta",
            "params": {"itemId": "same-message", "delta": part},
        }
        for part in parts
    ]
    if case == "escaped-surrogate":
        records[0]["params"]["delta"] += chr(0xD800)
    if case == "interleaved-items":
        records.insert(
            1,
            {
                "method": "warning",
                "params": {"message": "Checking second contribution"},
            },
        )
        records.insert(
            2,
            {
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "other-message",
                    "delta": "Other visible contribution",
                },
            },
        )
    wire = b"".join(
        (json.dumps(record, ensure_ascii=True) + "\n").encode() for record in records
    )
    if case in {"ascii-escaped", "escaped-surrogate"}:
        escaped = "".join(
            "\\u" + format(ord(character), "04x") for character in secret
        ).encode()
        wire = wire.replace(secret.encode(), escaped)
    if case == "json-delimiters":
        # A byte filter before JSON parsing would replace real quoted delimiters
        # and discard the whole record, even though its text was safely escaped.
        assert secret.encode() in wire
    else:
        # Only decoding/joining notifications reconstructs the credential.
        assert secret.encode() not in wire
    output, observed = io.BytesIO(), bytearray()
    path = tmp_path / "private-readable-mirror.txt"
    with path.open("w+b") as terminal:
        api = LocalLaunchAPI(terminal_output=terminal)
        try:
            assert (
                run(
                    [
                        sys.executable,
                        "-c",
                        "import sys; data=sys.stdin.buffer.read(); [sys.stdout.buffer.write(data[i:i+17]) for i in range(0,len(data),17)]",
                    ],
                    api=api,
                    cwd=str(tmp_path),
                    environment=dict(os.environ),
                    stdin=io.BytesIO(wire),
                    stdout=output,
                    stderr=io.BytesIO(),
                    mirror_secrets=(secret.encode(),),
                    mirror_format="codex-app-server-v1",
                    output_observer=lambda kind, content: (
                        observed.extend(content) if kind == "stdout" else None
                    ),
                )
                == 0
            )
        finally:
            api.close()
        terminal.seek(0)
        visible = terminal.read()
    assert output.getvalue() == bytes(observed) == wire
    assert secret.encode() not in visible
    assert b"[Agent] [REDACTED]" in visible
    if case == "escaped-surrogate":
        assert b"[Agent] [REDACTED]?" in visible
    if case == "interleaved-items":
        assert parts[0].encode() not in visible and parts[1].encode() not in visible
        assert b"Checking second contribution" in visible
        assert b"Other visible contribution" in visible
