"""Control CLI contracts without touching live tmux or launching coding agents."""
from __future__ import annotations

import copy
import io
import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from tmux_console import control_cli as cli

IDENTITY = {"sessionId": "$1", "sessionCreated": 101, "serverStarted": 90,
            "serverPid": 1000, "paneId": "%2", "panePid": 1001}
RECEIPT = {"session": "worker", **IDENTITY, "launchMode": "command"}
SESSION = {"name": "worker", "id": "$1", "created": 101,
           "serverStarted": 90, "serverPid": 1000, "activePaneId": "%2",
           "agentState": "completed", "panes": [{"id": "%2", "panePid": 1001,
           "dead": False, "exitStatus": None}]}
WORKSPACE = {"id": "project", "name": "Project", "tabs": ["controller", "other"],
             "parents": {}, "groups": [{"id": "epic", "name": "Epic", "color": "blue",
             "collapsed": False, "tabs": ["controller"]}],
             "sessionRevision": 7, "updatedAt": 123, "activeSession": "controller"}


class FakeClient:
    def __init__(self, replies):
        self.replies = deque(replies)
        self.calls = []

    def request(self, method, path, payload=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        response = self.replies.popleft()
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


@pytest.fixture
def http_server(tmp_path):
    requests = []
    replies = deque()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            size = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(size)
            requests.append((self.command, self.path, dict(self.headers), json.loads(body) if body else None))
            status, payload, headers = replies.popleft()
            raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        do_POST = do_GET
        do_PATCH = do_GET
        do_DELETE = do_GET

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    token = tmp_path / "token"
    token.write_text("private_control_token_0123456789abcdef\n")
    token.chmod(0o600)
    try:
        yield SimpleNamespace(url=f"http://127.0.0.1:{server.server_port}/mux",
                              token=token, replies=replies, requests=requests)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def run_fake(monkeypatch, argv, responses):
    client = FakeClient(responses)
    monkeypatch.setattr(cli, "ControlClient", lambda *args, **kwargs: client)
    return cli.main(argv), client


def test_transport_preserves_base_path_auth_and_literal_json(http_server):
    http_server.replies.append((201, RECEIPT, {}))
    payload = {"command": ["tool", "literal $(id)", "a;b", "雪"], "launchMode": "command"}
    client = cli.ControlClient(http_server.url, http_server.token)
    assert client.request("POST", "/api/sessions", payload) == RECEIPT
    method, path, headers, received = http_server.requests[0]
    assert (method, path, received) == ("POST", "/mux/api/sessions", payload)
    assert headers["Authorization"] == "Bearer private_control_token_0123456789abcdef"
    assert headers["Content-Type"] == "application/json"


def test_redirect_is_never_followed_or_response_body_disclosed(http_server):
    http_server.replies.append((302, {"error": "SECRET_BODY"}, {"Location": http_server.url + "/evil"}))
    client = cli.ControlClient(http_server.url, http_server.token)
    with pytest.raises(cli.ControlError, match="redirects are refused") as error:
        client.request("POST", "/api/sessions", {"name": "worker"})
    assert "SECRET_BODY" not in str(error.value)
    assert len(http_server.requests) == 1


def test_http_failure_is_not_retried_or_body_disclosed(http_server, capsys):
    http_server.replies.append((503, {"error": "private_control_token SECRET_BODY", "delivery": "uncertain"}, {}))
    assert cli.main(["--url", http_server.url, "--token-file", str(http_server.token),
                     "api", "POST", "/api/sessions/worker/input", "--json", '{"text":"hi"}']) == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert "HTTP 503" in output.err
    assert "private_control_token" not in output.err and "SECRET_BODY" not in output.err
    assert len(http_server.requests) == 1


@pytest.mark.parametrize("url", ["http://example.com/mux", "https://user:pass@example.com/mux",
    "file:///tmp/foo", "https://example.com/mux?secret=foo", "https://example.com/#frag",
    "http://127.0.0.1/mux/../evil", "http://127.0.0.1/mux/%2e%2e/evil",
    "http://127.0.0.1:bad/mux", "http://127.0.0.1/mux\\evil"])
def test_unsafe_server_urls_rejected_before_credentials(url, tmp_path):
    with pytest.raises(cli.ControlError):
        cli.ControlClient(url, tmp_path / "missing")


@pytest.mark.parametrize("path", ["https://evil.example/api/sessions", "//evil.example/api/sessions",
    "/api/../login", "/api/%2e%2e/login", "/login", "/api%2Fsessions", "/api/sessions#fragment",
    "/api/sessions\\evil", "/api//sessions"])
def test_api_path_cannot_escape_prefix(path, tmp_path):
    client = cli.ControlClient("http://127.0.0.1/mux", tmp_path / "missing")
    with pytest.raises(cli.ControlError, match="path"):
        client.request("GET", path)


def test_private_credentials_checked_lazily(tmp_path):
    token = tmp_path / "token"
    client = cli.ControlClient("http://127.0.0.1/mux", token)
    token.write_text("private_control_token_0123456789abcdef")
    token.chmod(0o644)
    with pytest.raises(cli.ControlError, match="owner-only"):
        client._load_token()
    token.chmod(0o600)
    link = tmp_path / "link"
    link.symlink_to(token)
    with pytest.raises(cli.ControlError, match="private control token"):
        cli.ControlClient("http://127.0.0.1/mux", link)._load_token()
    token.write_text("bad\nheader")
    with pytest.raises(cli.ControlError, match="invalid control token"):
        client._load_token()


def test_launch_literal_argv_auto_request_id_and_json_receipt(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--mode", "command",
        "--name", "worker", "--cwd", "/tmp", "--env", "MODEL=a=b", "--", "tool", "$(id)", "a;b"], [RECEIPT])
    assert status == 0
    payload = client.calls[0][2]
    assert {key: value for key, value in payload.items() if key != "requestId"} == {
        "launchMode": "command", "name": "worker", "directory": "/tmp", "environment": {"MODEL": "a=b"},
        "command": ["tool", "$(id)", "a;b"], "remainOnExit": True}
    assert len(payload["requestId"]) == 32
    assert json.loads(capsys.readouterr().out)["requestId"] == payload["requestId"]


def test_launch_error_exposes_generated_retry_key_without_relaunch(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--mode", "shell"],
                              [cli.ControlError("delivery may be uncertain")])
    assert status == 1 and len(client.calls) == 1
    output = capsys.readouterr()
    assert client.calls[0][2]["requestId"] in output.err
    assert output.out == ""


def test_launch_placement_uses_timestamp_and_revision_and_contiguous_group(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--mode", "command", "--request-id", "run-1",
        "--workspace", "project", "--parent", "controller", "--group", "epic", "--", "tool"],
        [{"workspace": WORKSPACE}, RECEIPT, {"workspace": WORKSPACE}])
    assert status == 0
    assert [method for method, _, _ in client.calls] == ["GET", "POST", "PATCH"]
    patch = client.calls[-1][2]
    assert patch["sessionRevision"] == 7 and patch["expectedUpdatedAt"] == 123
    assert patch["tabs"] == ["controller", "worker", "other"]
    assert patch["parents"] == {"worker": "controller"}
    assert patch["groups"][0]["tabs"] == ["controller", "worker"]
    assert json.loads(capsys.readouterr().out)["requestId"] == "run-1"


def test_bad_placement_rejected_before_launch(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--workspace", "project", "--group", "missing"],
                              [{"workspace": WORKSPACE}])
    assert status == 1 and [call[0] for call in client.calls] == ["GET"]
    assert "group does not exist" in capsys.readouterr().err


def test_partial_placement_outputs_created_receipt_without_retry(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--workspace", "project"],
                              [{"workspace": WORKSPACE}, RECEIPT, cli.ControlError("HTTP 409")])
    assert status == 1 and len(client.calls) == 3
    output = capsys.readouterr()
    assert json.loads(output.out)["created"]["paneId"] == "%2"
    assert json.loads(output.out)["partialSuccess"] is True
    assert "do not repeat launch" in output.err


@pytest.mark.parametrize("submit", [False, True])
def test_input_is_literal_and_enter_is_opt_in(monkeypatch, capsys, submit):
    argv = ["sessions", "input", "worker", "a\nb;$(id)", "--allow-multiline"] + (["--submit"] if submit else [])
    status, client = run_fake(monkeypatch, argv, [{"sessions": [SESSION]}, {"ok": True}])
    assert status == 0
    assert client.calls[-1] == ("POST", "/api/sessions/worker/input", {**IDENTITY, "text": "a\nb;$(id)", "submit": submit, "allowMultiline": True})
    assert json.loads(capsys.readouterr().out) == {"ok": True}


def test_stdin_input_and_original_receipt_bypass_inventory(monkeypatch, capsys, tmp_path):
    receipt = tmp_path / "receipt.json"
    receipt.write_text(json.dumps(RECEIPT))
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("literal\nmessage"))
    status, client = run_fake(monkeypatch, ["sessions", "input", "worker", "--identity", "@" + str(receipt), "--stdin", "--allow-multiline"], [{"ok": True}])
    assert status == 0 and len(client.calls) == 1
    assert client.calls[0][2] == {**IDENTITY, "text": "literal\nmessage", "submit": False, "allowMultiline": True}
    capsys.readouterr()


def test_capture_uses_full_pane_identity_query(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "capture", "worker", "--lines", "80"],
                              [{"sessions": [SESSION]}, {"text": "out"}])
    assert status == 0
    query = parse_qs(urlsplit(client.calls[-1][1]).query)
    assert query == {**{key: [str(value)] for key, value in IDENTITY.items()}, "lines": ["80"]}
    capsys.readouterr()


@pytest.mark.parametrize("policy", ["interrupt", "terminate"])
def test_cancel_policy_explicit_and_scoped(monkeypatch, capsys, policy):
    status, client = run_fake(monkeypatch, ["sessions", "cancel", "worker", "--policy", policy],
                              [{"sessions": [SESSION]}, {"ok": True}])
    assert status == 0
    if policy == "interrupt":
        assert client.calls[-1] == ("POST", "/api/sessions/worker/input", {**IDENTITY, "keys": ["C-c"]})
    else:
        assert client.calls[-1] == ("DELETE", "/api/sessions/worker", {key: IDENTITY[key] for key in cli.IDENTITY_FIELDS})
    capsys.readouterr()


def test_wait_uses_actual_pane_exit_status_not_agent_heuristic(monkeypatch, capsys):
    dead = copy.deepcopy(SESSION)
    dead["panes"][0].update(dead=True, exitStatus=42)
    status, client = run_fake(monkeypatch, ["sessions", "wait", "worker", "--interval", "0.001"],
                              [{"sessions": [SESSION]}, {"sessions": [SESSION]}, {"sessions": [dead]}])
    assert status == 42 and len(client.calls) == 3
    assert json.loads(capsys.readouterr().out)["exitStatus"] == 42


def test_wait_times_out_without_sending_cancel(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "wait", "worker", "--timeout", "0"],
                              [{"sessions": [SESSION]}, {"sessions": [SESSION]}])
    assert status == 124 and all(call[0] == "GET" for call in client.calls)
    assert json.loads(capsys.readouterr().out)["timedOut"] is True


def test_wait_never_follows_reused_session_identity(monkeypatch, capsys):
    changed = copy.deepcopy(SESSION)
    changed["created"] += 1
    status, client = run_fake(monkeypatch, ["sessions", "wait", "worker"],
                              [{"sessions": [SESSION]}, {"sessions": [changed]}])
    assert status == 1 and len(client.calls) == 2
    output = capsys.readouterr()
    assert output.out == "" and "identity changed" in output.err


def test_dead_without_status_is_uncertain_not_success(monkeypatch, capsys):
    dead = copy.deepcopy(SESSION)
    dead["panes"][0]["dead"] = True
    status, _ = run_fake(monkeypatch, ["sessions", "wait", "worker"],
                         [{"sessions": [SESSION]}, {"sessions": [dead]}])
    assert status == 1
    assert "exit status is unavailable" in capsys.readouterr().err


def test_parent_preserves_mapping_and_uses_both_cas_guards(monkeypatch, capsys):
    workspace = copy.deepcopy(WORKSPACE)
    workspace["parents"] = {"other": "controller"}
    status, client = run_fake(monkeypatch, ["workspaces", "parent", "project", "other", "--detach", "--revision", "6"],
                              [{"workspace": workspace}, {"workspace": workspace}])
    assert status == 0
    assert client.calls[-1][2] == {"parents": {}, "sessionRevision": 6, "expectedUpdatedAt": 123}
    capsys.readouterr()


def test_workspace_add_is_atomic_addition_not_replacement(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["workspaces", "add", "project", "worker"],
                              [{"workspace": WORKSPACE}, {"workspace": WORKSPACE}])
    assert status == 0
    assert client.calls[-1] == ("POST", "/api/workspaces/project/sessions", {"sessions": ["worker"], "sessionRevision": 7})
    capsys.readouterr()


def test_group_remove_reorders_hole_and_preserves_coverage(monkeypatch, capsys):
    workspace = copy.deepcopy(WORKSPACE)
    workspace["tabs"] = ["controller", "middle", "other"]
    workspace["groups"][0]["tabs"] = workspace["tabs"][:]
    status, client = run_fake(monkeypatch, ["workspaces", "group", "remove", "project", "epic", "middle"],
                              [{"workspace": workspace}, {"workspace": workspace}])
    assert status == 0
    assert client.calls[-1][2]["tabs"] == ["controller", "other", "middle"]
    assert client.calls[-1][2]["groups"][0]["tabs"] == ["controller", "other"]
    assert client.calls[-1][2]["expectedUpdatedAt"] == 123
    capsys.readouterr()


def test_exec_probe_needs_no_credentials_or_api(monkeypatch):
    import tmux_console

    fake_bridge = SimpleNamespace(is_lightweight_probe=lambda command: command == ["provider", "--version"],
                                  run=lambda command, **kwargs: 17 if kwargs["api"] is None else 1)
    monkeypatch.setitem(__import__("sys").modules, "tmux_console.stdio_bridge", fake_bridge)
    monkeypatch.setattr(tmux_console, "stdio_bridge", fake_bridge, raising=False)
    monkeypatch.setattr(cli, "ControlClient", lambda *args, **kwargs: pytest.fail("probe loaded API client"))
    assert cli.main(["--token-file", "/missing", "exec", "--", "provider", "--version"]) == 17


def test_generic_api_payload_from_stdin_covers_callbacks(monkeypatch, capsys):
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO('{"workspaceId":"project","text":"hello"}'))
    status, client = run_fake(monkeypatch, ["api", "POST", "/api/callback-messages", "--json", "-"], [{"message": {"id": "msg-1"}}])
    assert status == 0
    assert client.calls == [("POST", "/api/callback-messages", {"workspaceId": "project", "text": "hello"})]
    assert json.loads(capsys.readouterr().out)["message"]["id"] == "msg-1"


def test_no_content_is_success_for_termination(http_server, capsys):
    http_server.replies.append((204, b"", {}))
    assert cli.main(["--url", http_server.url, "--token-file", str(http_server.token),
                     "sessions", "terminate", "worker", "--identity", json.dumps(RECEIPT)]) == 0
    assert capsys.readouterr().out == "{}\n"
    assert http_server.requests[0][0] == "DELETE"


def test_exec_preserves_ambient_environment_and_explicit_overrides(monkeypatch):
    import tmux_console
    calls = []
    fake_bridge = SimpleNamespace(is_lightweight_probe=lambda command: True,
                                  run=lambda command, **kwargs: calls.append(kwargs) or 0)
    monkeypatch.setitem(__import__("sys").modules, "tmux_console.stdio_bridge", fake_bridge)
    monkeypatch.setattr(tmux_console, "stdio_bridge", fake_bridge, raising=False)
    monkeypatch.setenv("MUXDECK_TEST_PROVIDER_SECRET", "inherited-secret")
    monkeypatch.setenv("MUXDECK_TEST_OVERRIDE", "ambient")
    assert cli.main(["exec", "--env", "MUXDECK_TEST_OVERRIDE=explicit", "--", "provider", "--version"]) == 0
    assert calls[0]["environment"]["MUXDECK_TEST_PROVIDER_SECRET"] == "inherited-secret"
    assert calls[0]["environment"]["MUXDECK_TEST_OVERRIDE"] == "explicit"
    assert calls[0]["environment"]["PATH"]


def test_bridge_runtime_failure_is_diagnostic_without_traceback(monkeypatch, capsys):
    import tmux_console
    def fail(*args, **kwargs):
        raise RuntimeError("secret provider configuration")
    fake_bridge = SimpleNamespace(is_lightweight_probe=lambda command: True, run=fail)
    monkeypatch.setitem(__import__("sys").modules, "tmux_console.stdio_bridge", fake_bridge)
    monkeypatch.setattr(tmux_console, "stdio_bridge", fake_bridge, raising=False)
    assert cli.main(["exec", "--", "provider", "--version"]) == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert "stdio bridge failed" in output.err
    assert "secret provider" not in output.err and "Traceback" not in output.err


@pytest.mark.parametrize("text", ["first\nsecond", "first\rsecond"])
def test_multiline_input_requires_explicit_opt_in_before_mutation(monkeypatch, capsys, text):
    status, client = run_fake(monkeypatch, ["sessions", "input", "worker", text], [{"sessions": [SESSION]}])
    assert status == 1 and len(client.calls) == 1 and client.calls[0][0] == "GET"
    assert "--allow-multiline" in capsys.readouterr().err


def test_group_create_requires_members_before_any_api(monkeypatch):
    monkeypatch.setattr(cli, "ControlClient", lambda *args, **kwargs: pytest.fail("invalid group contacted server"))
    with pytest.raises(SystemExit) as error:
        cli.main(["workspaces", "group", "create", "project", "Epic"])
    assert error.value.code == 2


def test_group_creation_moves_members_from_existing_group(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["workspaces", "group", "create", "project", "New epic", "controller", "--id", "new"],
                              [{"workspace": WORKSPACE}, {"workspace": WORKSPACE}])
    assert status == 0
    assert client.calls[-1][2]["groups"] == [{"id": "new", "name": "New epic", "color": "blue", "collapsed": False, "tabs": ["controller"]}]
    capsys.readouterr()


def test_identity_can_use_get_receipt_and_does_not_retarget(monkeypatch, capsys):
    receipt = {"session": SESSION, "identity": IDENTITY}
    status, client = run_fake(monkeypatch, ["sessions", "keys", "worker", "C-c", "--identity", json.dumps(receipt)], [{"ok": True}])
    assert status == 0 and len(client.calls) == 1
    assert client.calls[-1][2] == {**IDENTITY, "keys": ["C-c"]}
    capsys.readouterr()


def test_invalid_request_id_is_not_reflected_or_sent(monkeypatch, capsys):
    status, client = run_fake(monkeypatch, ["sessions", "launch", "--request-id", "bad\nsecret"], [])
    assert status == 1 and client.calls == []
    output = capsys.readouterr()
    assert "secret" not in output.err and "request ID must contain" in output.err
def test_project_namespace_forwards_without_loading_global_control_token(monkeypatch):
    from muxpilot import cli as project_cli

    received = []
    monkeypatch.setattr(project_cli, "main", lambda argv: received.append(argv) or 7)
    assert cli.main(["project", "status", "project-id"]) == 7
    assert received == [["status", "project-id"]]
