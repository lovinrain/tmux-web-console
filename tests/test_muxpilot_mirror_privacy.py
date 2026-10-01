"""Credential privacy at the real tmux mirror and retained-history boundary."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

from test_muxpilot_e2e import LocalStack, wait_until
from test_muxpilot_e2e import (
    local_stack as local_stack,  # noqa: PLC0414 - pytest fixture export
)
from test_muxpilot_e2e import (
    repository as repository,  # noqa: PLC0414 - pytest fixture export
)

from muxpilot.runtime import ExecutionContext, ProviderBridge, WorkerAllocator
from muxpilot.store import JournalStore
from tmux_console.control_cli import ControlClient


def test_known_credentials_never_enter_native_pane_or_retained_history(
    repository: Path, local_stack: LocalStack,
) -> None:
    stack = local_stack
    state = stack.root / "projects"
    project = str(uuid.uuid4())
    with JournalStore(state, project, repository) as journal:
        lease = journal.acquire_lease("mirror-privacy-main", ttl=600)
    allocation = WorkerAllocator(state).allocate(project, "privacy", "privacy-run", repository)
    context = ExecutionContext(
        state_root=str(state), project_id=project, task_id="privacy", run_id="privacy-run",
        execution_id=str(uuid.uuid4()), coordinator_owner=lease["owner"],
        generation=lease["generation"], worktree=allocation.worktree,
        muxdeck_url=stack.url, token_file=str(stack.token_file),
    )
    api_secret = "fixture-api-credential-" + uuid.uuid4().hex
    control_secret = stack.token_file.read_text().strip()
    output, errors = io.BytesIO(), io.BytesIO()
    provider_program = """
import json, os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
values = [os.environ['FAKE_API_KEY'], json.loads(sys.stdin.buffer.read())['echo']]
assert 'MUXDECK_CONTROL_TOKEN_FILE' not in os.environ
for index, value in enumerate(values):
    secret = value.encode()
    split = len(secret) // 2
    for descriptor, prefix in ((1, b'out:'), (2, b'err:')):
        os.write(descriptor, prefix + secret[:split])
    (root / ('split-ready-' + str(index))).touch()
    while not (root / ('split-release-' + str(index))).exists():
        time.sleep(0.01)
    for descriptor in (1, 2):
        os.write(descriptor, secret[split:] + b'\\n')
os.write(1, b'out-eof')
os.write(2, b'err-eof')
"""
    client = ControlClient(stack.url, stack.token_file)
    environment = dict(os.environ, FAKE_API_KEY=api_secret,
                       MUXDECK_CONTROL_TOKEN_FILE=str(stack.token_file))
    bridge = ProviderBridge(context, client=client)
    with ThreadPoolExecutor(max_workers=1) as executor:
        execution = executor.submit(
            bridge.run, [sys.executable, "-B", "-c", provider_program, str(stack.root)],
            stdin=io.BytesIO(json.dumps({"echo": control_secret}).encode()),
            stdout=output, stderr=errors, environment=environment,
        )
        try:
            for index, secret in enumerate((api_secret, control_secret)):
                wait_until((stack.root / f"split-ready-{index}").exists)
                binding = json.loads((context.directory / "session.json").read_text())
                pane = binding["identity"]["paneId"]
                capture = subprocess.check_output(
                    [*stack.tmux, "capture-pane", "-p", "-t", pane, "-S", "-200"], text=True,
                )
                # The prefix must remain private while the rest of the value has
                # not arrived; absence of the whole value alone would be weak.
                assert secret[:len(secret) // 2] not in capture
                (stack.root / f"split-release-{index}").touch()
            assert execution.result(timeout=10) == 0
        finally:
            for index in range(2):
                (stack.root / f"split-release-{index}").touch()

    assert output.getvalue() == (
        f"out:{api_secret}\nout:{control_secret}\nout-eof".encode()
    )
    assert errors.getvalue() == (
        f"err:{api_secret}\nerr:{control_secret}\nerr-eof".encode()
    )

    def completed_mirror() -> str | None:
        captured = subprocess.check_output(
            [*stack.tmux, "capture-pane", "-p", "-t", pane, "-S", "-200"], text=True,
        )
        return captured if "out-eof" in captured and "err-eof" in captured else None

    captured = wait_until(completed_mirror)
    assert captured.count("[REDACTED]") == 4
    for secret in (api_secret, control_secret):
        assert secret not in captured
    def browser_get(path: str) -> dict:
        # History is a browser route; the isolated fixture is explicitly
        # unauthenticated and the control token cannot authorize browser routes.
        with urlopen(stack.url + path, timeout=5) as response:
            return json.load(response)

    saved = browser_get(f"/api/panes/{quote(pane, safe='')}/saved-scrollback?part=recent")
    assert "[REDACTED]" in json.dumps(saved)
    history_id = binding["history_reference"]
    assert history_id
    session_id = binding["identity"]["sessionId"]
    subprocess.run([*stack.tmux, "kill-session", "-t", session_id], check=True)
    retained = browser_get(f"/api/session-history/{history_id}/saved-scrollback?part=recent")
    retained_json = json.dumps(retained)
    assert "[REDACTED]" in retained_json and "out-eof" in retained_json
    artifacts = b"".join(
        (context.directory / name).read_bytes()
        for name in ("stdout.bin", "stderr.bin", "transcript.jsonl")
    )
    for secret in (api_secret, control_secret):
        assert secret not in json.dumps(saved)
        assert secret not in retained_json
        assert secret.encode() not in artifacts
