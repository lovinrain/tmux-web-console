from __future__ import annotations

import asyncio
from urllib.parse import quote

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import LAUNCH_REQUESTS_KEY, create_app
from tmux_console.auth import AuthConfigurationError, AuthStore, provision_auth_file
from tmux_console.launch_requests import LaunchRequestUnavailableError
from tmux_console.tmux import (
    MAX_PANE_INPUT_BYTES,
    CreatedSession,
    TmuxClient,
    TmuxError,
    TmuxInputDeliveryUncertainError,
    TmuxPaneInputUnavailableError,
    TmuxSessionIdentityChangedError,
    TmuxSessionNotFoundError,
)

IDENTITY = {
    "sessionId": "$12", "sessionCreated": 1_700_000_000,
    "serverStarted": 1_699_999_900, "serverPid": 4242,
    "paneId": "%23", "panePid": 31337,
}
CONTROL_TOKEN = "control-secret-" + "a" * 40
CALLBACK_TOKEN = "callback-secret-" + "b" * 40


class OrchestrationTmux(TmuxClient):
    def __init__(self, *, error=None, delay=0):
        super().__init__(binary="unused-tmux")
        self.error = error
        self.delay = delay
        self.launches = []
        self.inputs = []
        self.captures = []

    async def list_sessions(self):
        return []

    async def create_session(self, name=None, **kwargs):
        self.launches.append((name, kwargs))
        await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return CreatedSession(
            name or "generated-agent", "$12", directory=kwargs.get("start_directory"),
            pane_id="%23", pane_pid=31337, session_created=1_700_000_000,
            server_started=1_699_999_900, server_pid=4242,
            launch_mode=kwargs.get("launch_mode", "default"),
        )

    async def send_pane_input(self, session, **kwargs):
        self.inputs.append((session, kwargs))
        if self.error is not None:
            raise self.error
        return {**IDENTITY, "session": session, "delivery": "delivered", "submitted": kwargs["submit"]}

    async def capture_pane(self, session, **kwargs):
        self.captures.append((session, kwargs))
        if self.error is not None:
            raise self.error
        return {
            **IDENTITY, "session": session, "text": "agent output", "lines": ["agent output"],
            "alternateOn": True, "limited": False, "exitStatus": None,
        }


def client_for(tmux, **kwargs):
    return TestClient(TestServer(create_app(tmux=tmux, base_path="/mux", **kwargs)))


def private_token(path, token):
    path.write_text(token + "\n", encoding="ascii")
    path.chmod(0o600)
    return path


@pytest.mark.asyncio
async def test_command_launch_returns_complete_identity_and_literal_arguments(tmp_path):
    tmux = OrchestrationTmux()
    arguments = ["agent-cli", "a b", "$(touch /tmp/never)", ";", "#(false)"]
    async with client_for(tmux) as client:
        response = await client.post("/mux/api/sessions", json={
            "name": "task-agent", "directory": str(tmp_path), "launchMode": "command",
            "command": arguments, "environment": {"TASK_ID": "task-42"},
        })
        assert response.status == 201
        receipt = await response.json()
    assert receipt == {
        **IDENTITY, "session": "task-agent", "launchMode": "command",
        "identity": "$12:1700000000:1699999900:4242",
    }
    assert tmux.launches == [("task-agent", {
        "theme": None, "start_directory": str(tmp_path), "launch_mode": "command",
        "command": arguments, "environment": {"TASK_ID": "task-42"}, "remain_on_exit": True,
    })]


@pytest.mark.parametrize("fields", [
    {"launchMode": "unknown"}, {"launchMode": None},
    {"launchMode": "command"}, {"launchMode": "command", "command": []},
    {"launchMode": "command", "command": "agent"},
    {"launchMode": "command", "command": ["agent", 2]},
    {"launchMode": "command", "command": ["agent", "nul\0"]},
    {"launchMode": "shell", "command": ["agent"]},
    {"environment": None}, {"environment": {"BAD=NAME": "value"}},
    {"environment": {"TMUX_PANE": "%1"}}, {"environment": {"TOKEN": 7}},
    {"remainOnExit": None}, {"remainOnExit": "true"},
    {"requestId": ""}, {"requestId": "request/id"}, {"requestId": None},
])
@pytest.mark.asyncio
async def test_launch_rejects_invalid_options_before_dispatch(fields):
    tmux = OrchestrationTmux()
    async with client_for(tmux) as client:
        response = await client.post("/mux/api/sessions", json=fields)
        assert response.status == 400
    assert not tmux.launches


@pytest.mark.asyncio
async def test_duplicate_concurrent_launch_waits_for_same_receipt():
    tmux = OrchestrationTmux(delay=0.02)
    request = {"name": "agent", "launchMode": "shell", "requestId": "launch-1"}
    async with client_for(tmux) as client:
        responses = await asyncio.gather(*(
            client.post("/mux/api/sessions", json=request) for _ in range(2)
        ))
        assert sorted(response.status for response in responses) == [200, 201]
        receipts = [await response.json() for response in responses]
        assert sum(receipt.get("duplicate", False) for receipt in receipts) == 1
        changed = await client.post("/mux/api/sessions", json={**request, "name": "other"})
        assert changed.status == 409
    assert len(tmux.launches) == 1
    assert receipts[0]["sessionId"] == receipts[1]["sessionId"]


@pytest.mark.asyncio
async def test_launch_request_receipt_survives_server_restart():
    request = {"name": "agent", "launchMode": "command", "command": ["agent"], "requestId": "launch-2"}
    first = OrchestrationTmux()
    async with client_for(first) as client:
        response = await client.post("/mux/api/sessions", json=request)
        assert response.status == 201
        receipt = await response.json()
    second = OrchestrationTmux()
    async with client_for(second) as client:
        response = await client.post("/mux/api/sessions", json=request)
        assert response.status == 200
        assert await response.json() == {**receipt, "duplicate": True}
    assert len(first.launches) == 1
    assert not second.launches


@pytest.mark.asyncio
async def test_completed_launch_replays_after_working_directory_is_removed(tmp_path):
    directory = tmp_path / "finished-worktree"
    directory.mkdir()
    tmux = OrchestrationTmux()
    request = {"directory": str(directory), "launchMode": "shell", "requestId": "removed-worktree"}
    async with client_for(tmux) as client:
        first = await client.post("/mux/api/sessions", json=request)
        assert first.status == 201
        directory.rmdir()
        repeated = await client.post("/mux/api/sessions", json=request)
        assert repeated.status == 200
        assert (await repeated.json())["duplicate"] is True
    assert len(tmux.launches) == 1


@pytest.mark.asyncio
async def test_empty_directory_and_omitted_directory_never_share_launch_fingerprint():
    tmux = OrchestrationTmux()
    async with client_for(tmux) as client:
        default = await client.post("/mux/api/sessions", json={"requestId": "default-directory"})
        assert default.status == 201
        invalid_retry = await client.post("/mux/api/sessions", json={
            "requestId": "default-directory", "directory": "",
        })
        assert invalid_retry.status == 409
        invalid_first = await client.post("/mux/api/sessions", json={
            "requestId": "invalid-directory", "directory": "",
        })
        assert invalid_first.status == 400
        different_retry = await client.post("/mux/api/sessions", json={"requestId": "invalid-directory"})
        assert different_retry.status == 409
        wrong_type = await client.post("/mux/api/sessions", json={
            "requestId": "bad-type", "directory": None,
        })
        assert wrong_type.status == 400
        corrected_type = await client.post("/mux/api/sessions", json={"requestId": "bad-type"})
        assert corrected_type.status == 201
    assert len(tmux.launches) == 2


@pytest.mark.parametrize("error", [
    TmuxError("tmux command timed out"), TmuxError("tmux did not return the created session id"),
])
@pytest.mark.asyncio
async def test_uncertain_launch_is_not_reissued_with_same_request_id(error):
    tmux = OrchestrationTmux(error=error)
    request = {"launchMode": "shell", "requestId": "uncertain-launch"}
    async with client_for(tmux) as client:
        first = await client.post("/mux/api/sessions", json=request)
        assert first.status == 503
        assert (await first.json())["retryable"] is False
        repeated = await client.post("/mux/api/sessions", json=request)
        assert repeated.status == 409
        assert "uncertain" in (await repeated.json())["error"]
    assert len(tmux.launches) == 1


@pytest.mark.asyncio
async def test_duplicate_native_name_failure_is_replayed_without_new_launch():
    tmux = OrchestrationTmux(error=TmuxError("duplicate session: agent", 1))
    request = {"name": "agent", "requestId": "duplicate-native"}
    async with client_for(tmux) as client:
        for _ in range(2):
            response = await client.post("/mux/api/sessions", json=request)
            assert response.status == 409
            assert await response.json() == {"error": "duplicate session: agent"}
    assert len(tmux.launches) == 1


@pytest.mark.asyncio
async def test_failed_receipt_persistence_reports_created_session_and_blocks_relaunch(monkeypatch):
    tmux = OrchestrationTmux()
    client = client_for(tmux)
    def fail_complete(*_args):
        raise LaunchRequestUnavailableError("unavailable")
    monkeypatch.setattr(client.server.app[LAUNCH_REQUESTS_KEY], "complete", fail_complete)
    request = {"launchMode": "shell", "requestId": "receipt-failure"}
    async with client:
        first = await client.post("/mux/api/sessions", json=request)
        assert first.status == 201
        receipt = await first.json()
        assert receipt["sessionId"] == "$12"
        assert "do not relaunch" in receipt["warnings"][-1]
        repeated = await client.post("/mux/api/sessions", json=request)
        assert repeated.status == 409
    assert len(tmux.launches) == 1


@pytest.mark.asyncio
async def test_input_and_capture_target_requested_pane_without_attaching():
    tmux = OrchestrationTmux()
    name = "agent with/slash {braces}"
    route = "/mux/api/sessions/" + quote(name, safe="")
    async with client_for(tmux) as client:
        response = await client.post(route + "/input", json={**IDENTITY, "text": "next task", "submit": True})
        assert response.status == 200
        assert (await response.json())["delivery"] == "delivered"
        assert response.headers["Cache-Control"] == "no-store"
        captured = await client.get(route + "/capture", params={**IDENTITY, "lines": 40})
        assert captured.status == 200
        assert (await captured.json())["text"] == "agent output"
    assert tmux.inputs == [(name, {
        "session_id": "$12", "session_created": 1_700_000_000,
        "server_started": 1_699_999_900, "server_pid": 4242, "pane_id": "%23", "pane_pid": 31337,
        "text": "next task", "keys": None, "submit": True,
        "allow_multiline": False,
    })]
    assert tmux.captures[0][1]["lines"] == 40


@pytest.mark.parametrize("field", list(IDENTITY))
@pytest.mark.asyncio
async def test_pane_control_requires_each_identity_component(field):
    tmux = OrchestrationTmux()
    incomplete = {key: value for key, value in IDENTITY.items() if key != field}
    async with client_for(tmux) as client:
        posted = await client.post("/mux/api/sessions/agent/input", json={**incomplete, "keys": ["C-c"]})
        captured = await client.get("/mux/api/sessions/agent/capture", params=incomplete)
        assert posted.status == captured.status == 400
    assert not tmux.inputs and not tmux.captures


@pytest.mark.parametrize("fields", [
    {}, {"text": "task", "keys": ["Enter"]}, {"text": None},
    {"text": "task", "submit": 1}, {"text": "escape\x1b"},
    {"text": "\ud800"}, {"text": "x" * (MAX_PANE_INPUT_BYTES + 1)},
    {"keys": []}, {"keys": ["run-shell"]}, {"keys": ["C-c"], "submit": True},
    {"keys": ["C-c"], "requestId": "not-supported"},
    {"text": "task", "panePid": True}, {"text": "task", "paneId": "%not-a-pane"},
    {"text": "first\nsecond"}, {"text": "first\rsecond"},
    {"text": "task", "allowMultiline": "true"},
])
@pytest.mark.asyncio
async def test_input_rejects_invalid_content_without_dispatch(fields):
    tmux = OrchestrationTmux()
    async with client_for(tmux) as client:
        response = await client.post("/mux/api/sessions/agent/input", json={**IDENTITY, **fields})
        assert response.status == 400
    assert not tmux.inputs


@pytest.mark.asyncio
async def test_input_accepts_multiline_only_with_explicit_opt_in():
    tmux = OrchestrationTmux()
    async with client_for(tmux) as client:
        response = await client.post("/mux/api/sessions/agent/input", json={
            **IDENTITY, "text": "first\nsecond", "allowMultiline": True,
        })
        assert response.status == 200
    assert tmux.inputs[0][1]["allow_multiline"] is True
    assert tmux.inputs[0][1]["submit"] is False


@pytest.mark.parametrize("query", [
    {"lines": "0"}, {"lines": "2001"}, {"lines": "1.5"}, {"lines": "-1"},
    {"unknown": "field"}, {"sessionCreated": "true"}, {"panePid": "0"},
])
@pytest.mark.asyncio
async def test_capture_rejects_invalid_limits_or_identity(query):
    tmux = OrchestrationTmux()
    async with client_for(tmux) as client:
        response = await client.get("/mux/api/sessions/agent/capture", params={**IDENTITY, **query})
        assert response.status == 400
        duplicate = await client.get("/mux/api/sessions/agent/capture", params=[
            *IDENTITY.items(), ("lines", "5"), ("lines", "10"),
        ])
        assert duplicate.status == 400
    assert not tmux.captures


@pytest.mark.parametrize(("error", "status"), [
    (TmuxSessionNotFoundError("vanished"), 404),
    (TmuxSessionIdentityChangedError("replaced"), 409),
    (TmuxPaneInputUnavailableError("copy mode"), 409),
    (TmuxError("tmux command timed out"), 503),
    (TmuxInputDeliveryUncertainError("text pasted but Enter was refused"), 503),
])
@pytest.mark.asyncio
async def test_input_failures_report_conflicts_or_uncertain_delivery(error, status):
    tmux = OrchestrationTmux(error=error)
    async with client_for(tmux) as client:
        response = await client.post("/mux/api/sessions/agent/input", json={**IDENTITY, "keys": ["C-c"]})
        assert response.status == status
        if status == 503:
            assert await response.json() == {
                "error": str(error), "delivery": "uncertain", "retryable": False,
            }
    assert len(tmux.inputs) == 1


@pytest.mark.asyncio
async def test_control_bearer_supports_launch_and_workspace_but_preserves_other_auth_scopes(tmp_path):
    control_path = private_token(tmp_path / "control.token", CONTROL_TOKEN)
    callback_path = private_token(tmp_path / "callback.token", CALLBACK_TOKEN)
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "user", "password-for-test")
    tmux = OrchestrationTmux()
    headers = {"Authorization": f"Bearer {CONTROL_TOKEN}"}
    async with client_for(tmux, control_token_file=control_path, callback_token_file=callback_path,
                          auth=AuthStore(auth_path), auth_mode="server", auth_cookie_secure=False) as client:
        launch = await client.post("/mux/api/sessions", json={"launchMode": "shell"}, headers=headers)
        assert launch.status == 201
        workspace = await client.post("/mux/api/workspaces", json={
            "name": "Epic", "tabs": ["generated-agent"], "activeSession": "generated-agent",
        }, headers=headers)
        assert workspace.status == 201
        capture = await client.get("/mux/api/sessions/agent/capture", params=IDENTITY, headers=headers)
        assert capture.status == 200
        for path in ("/mux/api/auth/session", "/mux/account", "/mux/api/sessions/agent/files", "/mux/ws/terminal"):
            response = await client.get(path, headers=headers)
            assert response.status == 403
        callback_control = await client.post("/mux/api/sessions/agent/input", json={
            **IDENTITY, "text": "forbidden",
        }, headers={"Authorization": f"Bearer {CALLBACK_TOKEN}"})
        assert callback_control.status == 403
        untrusted = await client.post("/mux/api/sessions", json={}, headers={**headers, "Origin": "https://evil.invalid"})
        assert untrusted.status == 403
        hostile_host = await client.get("/mux/api/capabilities", headers={**headers, "Host": "evil.invalid"})
        assert hostile_host.status == 403
        control_path.write_text("rotated-token-" + "c" * 40)
        revoked = await client.get("/mux/api/capabilities", headers=headers)
        assert revoked.status == 401
    assert not tmux.inputs


def test_identical_callback_and_control_secrets_fail_startup(tmp_path):
    control_path = private_token(tmp_path / "control.token", CONTROL_TOKEN)
    callback_path = private_token(tmp_path / "callback.token", CONTROL_TOKEN)
    with pytest.raises(AuthConfigurationError, match="must be different"):
        create_app(control_token_file=control_path, callback_token_file=callback_path)


@pytest.mark.asyncio
async def test_rotation_cannot_escalate_callback_token_to_control(tmp_path):
    control_path = private_token(tmp_path / "control.token", CONTROL_TOKEN)
    callback_path = private_token(tmp_path / "callback.token", CALLBACK_TOKEN)
    tmux = OrchestrationTmux()
    async with client_for(tmux, control_token_file=control_path, callback_token_file=callback_path) as client:
        control_path.write_text(CALLBACK_TOKEN)
        response = await client.post("/mux/api/sessions", json={}, headers={
            "Authorization": f"Bearer {CALLBACK_TOKEN}",
        })
        assert response.status == 401
    assert not tmux.launches


@pytest.mark.asyncio
async def test_control_authenticated_session_stream_rechecks_rotated_token(tmp_path):
    control_path = private_token(tmp_path / "control.token", CONTROL_TOKEN)
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "user", "password-for-test")
    async with client_for(OrchestrationTmux(), control_token_file=control_path,
                          auth=AuthStore(auth_path), auth_mode="server") as client:
        response = await client.get("/mux/api/sessions/stream", headers={
            "Authorization": f"Bearer {CONTROL_TOKEN}",
        })
        try:
            assert response.status == 200
            first = await asyncio.wait_for(response.content.readuntil(b"\n\n"), 2)
            assert first.startswith(b"event: sessions\n")
            control_path.write_text("rotated-token-" + "c" * 40)
            revoked = await asyncio.wait_for(response.content.readuntil(b"\n\n"), 2)
            assert revoked == b'event: auth\ndata: {"authenticated":false}\n\n'
        finally:
            response.close()
