import argparse
import importlib.util
import io
import json
import subprocess
import threading
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "muxdeck_callback", Path(__file__).parents[1] / "scripts" / "muxdeck_callback.py"
)
assert SPEC and SPEC.loader
client_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client_module)


def post_args(**overrides):
    values = {"session": None, "cwd": None, "agent": "codex", "request_id": None}
    return argparse.Namespace(**{**values, **overrides})


def fake_tmux(monkeypatch, *, pane_pid="42", cwd="/task/path"):
    monkeypatch.setenv("TMUX_PANE", "%7")
    monkeypatch.setenv("TMUX", "/tmp/tmux,private/default,88,3")
    monkeypatch.setattr(client_module, "process_ancestors", lambda pid: {999, 42, 1})
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        assert kwargs["timeout"] == 5
        return subprocess.CompletedProcess(
            command, 0, stdout=f"real-session\t$3\t%7\t{pane_pid}\t{cwd}\n"
        )

    monkeypatch.setattr(client_module.subprocess, "run", run)
    return commands


def test_metadata_uses_verified_native_tmux_name_and_exact_socket(monkeypatch):
    commands = fake_tmux(monkeypatch)
    payload = client_module.build_payload(
        post_args(), "Done: unicode ✓\n$(not a command)"
    )
    assert payload["sessionName"] == "real-session"
    assert payload["tmuxSessionId"] == "$3"
    assert payload["tmuxPaneId"] == "%7"
    assert payload["cwd"] == "/task/path"
    assert payload["agentType"] == "codex"
    assert payload["message"] == "Done: unicode ✓\n$(not a command)"
    uuid.UUID(payload["requestId"])
    assert commands[0][:7] == [
        "tmux",
        "-S",
        "/tmp/tmux,private/default",
        "display-message",
        "-p",
        "-t",
        "%7",
    ]


def test_stale_tmux_environment_is_rejected(monkeypatch):
    fake_tmux(monkeypatch, pane_pid="1234")
    with pytest.raises(client_module.CallbackError, match="stale environment"):
        client_module.build_payload(post_args(), "Done")


def test_missing_tmux_requires_explicit_session_and_directory(monkeypatch):
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.delenv("TMUX_PANE", raising=False)
    with pytest.raises(client_module.CallbackError, match="No verifiable tmux"):
        client_module.build_payload(post_args(session="known-session"), "Done")
    payload = client_module.build_payload(
        post_args(session="known-session", cwd="/verified/task", agent="claude"), "Done"
    )
    assert payload["sessionName"] == "known-session"
    assert payload["cwd"] == "/verified/task"
    assert payload["agentType"] == "claude"
    assert "tmuxSessionId" not in payload
    assert "tmuxPaneId" not in payload


def test_overrides_never_attach_another_sessions_ids(monkeypatch):
    commands = fake_tmux(monkeypatch)
    payload = client_module.build_payload(
        post_args(session="other", cwd="/elsewhere"), "Done"
    )
    assert "tmuxSessionId" not in payload
    assert commands == []
    with pytest.raises(
        client_module.CallbackError, match="differs from the current pane"
    ):
        client_module.build_payload(post_args(session="other"), "Done")


def test_verified_cwd_override_retains_current_pane_identity(monkeypatch):
    fake_tmux(monkeypatch)
    payload = client_module.build_payload(post_args(cwd="/task/subdirectory"), "Done")
    assert payload["cwd"] == "/task/subdirectory"
    assert payload["tmuxPaneId"] == "%7"


def test_process_ancestry_handles_parentheses_in_names(monkeypatch):
    stats = {
        "/proc/30/stat": "30 (agent ) worker) S 20 30 30",
        "/proc/20/stat": "20 (bash) S 1 20 20",
        "/proc/1/stat": "1 (init) S 0 1 1",
    }
    monkeypatch.setattr(Path, "read_text", lambda path: stats[str(path)])
    assert client_module.process_ancestors(30) == {30, 20, 1}


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/callbacks",
        "https://user:password@example.com/x",
        "https://example.com/x?secret=y",
        "https://example.com/x#fragment",
    ],
)
def test_remote_plaintext_and_credential_urls_are_rejected(url):
    with pytest.raises(client_module.CallbackError, match="HTTPS URL"):
        client_module.validate_url(url)


def test_token_file_requires_private_permissions_and_error_hides_contents(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("test-secret-value-that-is-over-32-characters\n")
    token_file.chmod(0o644)
    with pytest.raises(client_module.CallbackError, match="chmod 600") as error:
        client_module.read_token(str(token_file))
    assert "test-secret-value" not in str(error.value)
    token_file.chmod(0o600)
    assert (
        client_module.read_token(str(token_file))
        == "test-secret-value-that-is-over-32-characters"
    )


def test_post_preserves_message_and_request_id_across_retries(monkeypatch):
    client = client_module.Client(client_module.DEFAULT_URL, "private-token")
    calls = []
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)
    payload = {
        "message": "literal `code`\n$(not a command) ✓",
        "requestId": str(uuid.uuid4()),
    }

    def open_request(request, **kwargs):
        calls.append(request)
        if len(calls) == 1:
            raise urllib.error.URLError("transient network error")
        return io.BytesIO(
            json.dumps({"callback": payload, "duplicate": False}).encode()
        )

    monkeypatch.setattr(client.opener, "open", open_request)
    assert client.request("POST", payload=payload)["callback"] == payload
    assert len(calls) == 2
    assert calls[0].data == calls[1].data
    assert json.loads(calls[0].data) == payload
    assert calls[0].get_header("Authorization") == "Bearer private-token"
    assert b"private-token" not in calls[0].data
    assert calls[0].get_header("Content-type") == "application/json"


def test_http_auth_failure_not_retried_or_echoed(monkeypatch):
    client = client_module.Client(client_module.DEFAULT_URL, "private-token")
    calls = []

    def open_request(request, **kwargs):
        calls.append(request)
        raise urllib.error.HTTPError(
            request.full_url, 401, "private-token", {}, io.BytesIO(b"private-token")
        )

    monkeypatch.setattr(client.opener, "open", open_request)
    with pytest.raises(client_module.CallbackError, match="HTTP 401") as error:
        client.request("GET")
    assert "private-token" not in str(error.value)
    assert len(calls) == 1


def test_cross_origin_redirect_never_receives_bearer_token():
    received = []

    class Destination(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    destination = ThreadingHTTPServer(("127.0.0.1", 0), Destination)

    class Redirect(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header(
                "Location", f"http://127.0.0.1:{destination.server_port}/capture"
            )
            self.end_headers()

        def log_message(self, *args):
            pass

    source = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True)
        for server in (source, destination)
    ]
    for thread in threads:
        thread.start()
    try:
        client = client_module.Client(
            f"http://127.0.0.1:{source.server_port}/callbacks", "private-token"
        )
        with pytest.raises(client_module.CallbackError, match="Redirects are refused"):
            client.request("GET")
        assert received == []
    finally:
        for server in (source, destination):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)


def test_list_all_pages_preserves_query_and_collects_records():
    class FakeClient:
        def __init__(self):
            self.calls = []

        def request(self, method, suffix):
            self.calls.append((method, suffix))
            if len(self.calls) == 1:
                return {
                    "messages": [{"id": "one"}],
                    "nextAfter": 23,
                    "revision": 7,
                }
            return {"messages": [{"id": "two"}], "nextAfter": None, "revision": 7}

    client = FakeClient()
    result = client_module.list_messages(
        client, argparse.Namespace(status="all", limit=1, after=None, all_pages=True)
    )
    assert [message["id"] for message in result["messages"]] == ["one", "two"]
    assert result["nextAfter"] is None
    assert client.calls == [
        ("GET", "?status=all&limit=1"),
        ("GET", "?status=all&limit=1&after=23"),
    ]


@pytest.mark.parametrize("cursor", [True, "12", 0, 4, -1, 2**63])
def test_invalid_or_non_increasing_cursors_are_rejected(cursor):
    class FakeClient:
        def request(self, *args):
            return {"messages": [{"id": "one"}], "nextAfter": cursor, "revision": 7}

    with pytest.raises(client_module.CallbackError, match="pagination cursor"):
        client_module.list_messages(
            FakeClient(),
            argparse.Namespace(status="all", limit=1, after=4, all_pages=True),
        )


@pytest.mark.parametrize(
    "result",
    [
        {},
        {"callback": {}},
        {"callback": {"id": "one", "message": "ok"}, "duplicate": False},
    ],
)
def test_invalid_delivery_receipts_are_rejected(result):
    with pytest.raises(client_module.CallbackError, match="receipt"):
        client_module.validate_receipt(result, request_id="expected-id")


def test_delivery_receipt_confirms_request_and_review_identity():
    client_module.validate_receipt(
        {
            "callback": {"id": "one", "message": "done", "requestId": "request-1"},
            "duplicate": False,
        },
        request_id="request-1",
    )
    client_module.validate_receipt(
        {"callback": {"id": "one", "message": "done", "reviewedAt": 1234}},
        reviewed_id="one",
    )
    with pytest.raises(client_module.CallbackError, match="review"):
        client_module.validate_receipt(
            {"callback": {"id": "other", "message": "done", "reviewedAt": 1234}},
            reviewed_id="one",
        )


def test_dry_run_does_not_load_token_or_send_request(monkeypatch, capsys):
    monkeypatch.setattr(client_module.sys, "stdin", io.StringIO("Callback ✓\n"))
    monkeypatch.setattr(
        client_module,
        "read_token",
        lambda filename: pytest.fail("dry run loaded a token"),
    )
    assert (
        client_module.main(
            [
                "post",
                "--agent",
                "codex",
                "--session",
                "verified",
                "--cwd",
                "/task",
                "--dry-run",
            ]
        )
        == 0
    )
    output = capsys.readouterr()
    assert json.loads(output.out)["message"] == "Callback ✓\n"
    assert output.err == ""


def test_uncertain_post_outputs_stable_request_id_and_safe_error(
    monkeypatch, tmp_path, capsys
):
    request_id = str(uuid.uuid4())
    message = tmp_path / "message"
    message.write_text("Literal $(not a command)\n")
    monkeypatch.setattr(client_module, "read_token", lambda filename: "private-token")

    def fail_request(*args, **kwargs):
        raise client_module.CallbackError("Endpoint unreachable.")

    monkeypatch.setattr(client_module.Client, "request", fail_request)
    result = client_module.main(
        [
            "post",
            "--agent",
            "codex",
            "--session",
            "known",
            "--cwd",
            "/task",
            "--message-file",
            str(message),
            "--request-id",
            request_id,
        ]
    )
    assert result == 1
    output = capsys.readouterr()
    assert request_id in output.err
    assert "--request-id " + request_id in output.err
    assert "private-token" not in output.err
    assert output.out == ""
