import importlib.util
import io
import json
import subprocess
import threading
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

SPEC = importlib.util.spec_from_file_location(
    "check_deployment", Path(__file__).parents[1] / "scripts" / "check_deployment.py"
)
assert SPEC and SPEC.loader
checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checks)


def baseline():
    return {
        "version": 1,
        "capturedAt": "2026-09-27T02:00:00+00:00",
        "bootId": "boot",
        "service": "muxdeck.service",
        "mainPid": 50,
        "appDir": "/app",
        "origin": "http://127.0.0.1:7683",
        "basePath": "/mux",
        "authMode": "server",
        "trustedOrigins": ["https://console.example.test"],
        "tmux": "42\t/tmp/tmux/default\t123",
        "panes": ["$1\t%1\t100\tcodex\t0"],
    }


def fake_service(
    monkeypatch, *, kill_mode="process", group="/system.slice/tmux.scope", panes=None
):
    calls = []
    environment = (
        b"PATH=/usr/bin\0MUXDECK_AUTH_MODE=server\0MUXDECK_TMUX_SOCKET=owned\0"
        b"TMUX=/wrong/socket,1,1\0TMUX_PANE=%999\0PRIVATE_TOKEN=do-not-report\0"
    )
    monkeypatch.setattr(Path, "stat", lambda path: SimpleNamespace(st_uid=1000))
    monkeypatch.setattr(checks.os, "geteuid", lambda: 1000)
    monkeypatch.setattr(Path, "read_bytes", lambda path: environment)
    monkeypatch.setattr(
        Path,
        "read_text",
        lambda path: f"0::{group}\n" if str(path).endswith("cgroup") else "boot",
    )

    def run(args, **kwargs):
        calls.append((args, kwargs))
        if args[0] == "systemctl":
            return (
                "Id=muxdeck.service\nMainPID=50\nActiveState=active\n"
                f"KillMode={kill_mode}\nControlGroup=/system.slice/muxdeck.service\n"
                "WorkingDirectory=/app"
            )
        assert args[:3] == ["tmux", "-L", "owned"]
        assert "TMUX" not in kwargs["env"]
        assert "TMUX_PANE" not in kwargs["env"]
        if args[3] == "display-message":
            return "42\t/tmp/tmux/owned\t123"
        assert args[3] == "list-panes"
        return "$1\t%1\t100\tcodex\t0" if panes is None else panes

    monkeypatch.setattr(checks, "command", run)
    return calls


def test_snapshot_uses_service_socket_without_exposing_environment(monkeypatch):
    calls = fake_service(monkeypatch)
    current = checks.snapshot("muxdeck.service")
    assert len(calls) == 3
    assert current["tmux"] == "42\t/tmp/tmux/owned\t123"
    assert current["panes"] == baseline()["panes"]
    assert "do-not-report" not in json.dumps(current)
    assert "PRIVATE_TOKEN" not in json.dumps(current)


@pytest.mark.parametrize(
    "overrides,message",
    [
        ({"kill_mode": "control-group"}, "KillMode"),
        ({"group": "/system.slice/muxdeck.service"}, "cgroup"),
        ({"group": "/system.slice/muxdeck.service/nested"}, "cgroup"),
        ({"panes": ""}, "No tmux panes"),
    ],
)
def test_snapshot_rejects_unsafe_restart_or_wrong_socket(
    monkeypatch, overrides, message
):
    fake_service(monkeypatch, **overrides)
    with pytest.raises(checks.CheckError, match=message):
        checks.snapshot("muxdeck.service")


@pytest.mark.parametrize(
    "key", ["bootId", "service", "origin", "basePath", "authMode", "tmux", "panes"]
)
def test_changed_deployment_identity_is_rejected(key):
    before = baseline()
    after = deepcopy(before)
    after[key] = "changed"
    with pytest.raises(checks.CheckError, match=key):
        checks.compare(before, after)
    after = {**before, "mainPid": 999, "appDir": "/new-release"}
    checks.compare(before, after)


@pytest.mark.parametrize("mode", ["server", "basic", "none"])
def test_http_checks_use_the_configured_authentication_contract(monkeypatch, mode):
    current = {**baseline(), "authMode": mode}
    seen = []

    def request(url, headers=None):
        path = url.removeprefix(current["origin"])
        seen.append((path, headers))
        if mode == "none":
            return 200, {}
        if mode == "basic":
            return 401, {"WWW-Authenticate": 'Basic realm="Muxdeck"'}
        if path == "/mux/login":
            return 200, {}
        if path == "/mux/":
            return 303, {"Location": "/mux/login?next=%2Fmux%2F"}
        return 401, {}

    monkeypatch.setattr(checks, "http_status", request)
    result = checks.check_http(current, current["origin"], "/mux/assets/app.js")
    assert result["asset"] == (200 if mode == "none" else 401)
    assert ("/mux/", {"Accept": "text/html", "Sec-Fetch-Mode": "navigate"}) in seen


@pytest.mark.parametrize(
    "mode,status,headers",
    [("server", 200, {}), ("basic", 401, {}), ("none", 401, {})],
)
def test_unexpected_authentication_results_fail(monkeypatch, mode, status, headers):
    monkeypatch.setattr(checks, "http_status", lambda *args: (status, headers))
    with pytest.raises(checks.CheckError):
        checks.check_http(
            {**baseline(), "authMode": mode}, "http://127.0.0.1", "/mux/assets/app.js"
        )


def test_http_redirects_are_observed_without_following_them():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(303)
            self.send_header("Location", "/login")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, headers = checks.http_status(
            f"http://127.0.0.1:{server.server_port}/mux/"
        )
        assert status == 303
        assert headers["Location"] == "/login"
        assert requests == ["/mux/"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_command_timeout_is_bounded_and_does_not_echo_private_output(monkeypatch):
    def run(args, **kwargs):
        assert kwargs["timeout"] == 8
        raise subprocess.TimeoutExpired(args, 8, output="private-token")

    monkeypatch.setattr(checks.subprocess, "run", run)
    with pytest.raises(checks.CheckError, match="exceeded 8s") as error:
        checks.command(["systemctl", "show", "muxdeck.service"])
    assert "private-token" not in str(error.value)


def test_http_errors_close_the_response_without_reading_private_body(monkeypatch):
    body = io.BytesIO(b"private-output")

    class Opener:
        def open(self, request, **kwargs):
            assert kwargs["timeout"] == 5
            assert request.get_header("Authorization") is None
            raise HTTPError(request.full_url, 401, "denied", {}, body)

    monkeypatch.setattr(checks, "build_opener", lambda *args: Opener())
    assert checks.http_status("http://127.0.0.1:7683/mux/api/health")[0] == 401
    assert body.closed


def test_frontend_requires_matching_base_and_staged_bytes(tmp_path):
    current = {**baseline(), "appDir": str(tmp_path / "app")}
    installed = tmp_path / "app/dist"
    staged = tmp_path / "stage"
    for directory in (installed, staged):
        (directory / "assets").mkdir(parents=True)
        (directory / "index.html").write_text(
            '<script src="/mux/assets/app.js"></script>'
        )
        (directory / "assets/app.js").write_text("reviewed build")
    assert checks.frontend(current, staged) == "/mux/assets/app.js"
    (installed / "assets/app.js").write_text("stale build")
    with pytest.raises(checks.CheckError, match="differs"):
        checks.frontend(current, staged)
    with pytest.raises(checks.CheckError, match="separate"):
        checks.frontend(current, installed)
    with pytest.raises(checks.CheckError, match="base path"):
        checks.frontend({**current, "basePath": "/wrong"})


def test_systemd_timeout_is_separate_from_application_errors(monkeypatch):
    monkeypatch.setattr(
        checks, "command", lambda args: "State 'stop-sigterm' timed out. Killing."
    )
    assert checks.journal("muxdeck.service", baseline()["capturedAt"]) == {
        "applicationErrors": 0,
        "oldProcessStopReachedTimeout": True,
    }
    monkeypatch.setattr(checks, "command", lambda args: "ERROR:muxdeck:private-output")
    with pytest.raises(checks.CheckError, match="1 application") as error:
        checks.journal("muxdeck.service", baseline()["capturedAt"])
    assert "private-output" not in str(error.value)


def setup_verifier(monkeypatch, tmp_path):
    before = tmp_path / "before.json"
    before.write_text(json.dumps(baseline()))
    monkeypatch.setattr(checks, "snapshot", lambda service: baseline())
    monkeypatch.setattr(checks, "frontend", lambda *args: "/mux/assets/app.js")
    monkeypatch.setattr(checks, "check_http", lambda *args: {"asset": 401})
    monkeypatch.setattr(checks, "http_status", lambda *args: (403, {}))
    monkeypatch.setattr(checks, "journal", lambda *args: {"applicationErrors": 0})
    return [
        "verify",
        "--baseline",
        str(before),
        "--output-dir",
        str(tmp_path / "report"),
    ]


def test_verify_writes_private_timed_report_and_progress(monkeypatch, tmp_path, capsys):
    args = setup_verifier(monkeypatch, tmp_path)
    assert checks.main(args) == 0
    report = tmp_path / "report"
    result = json.loads((report / "verification.json").read_text())
    assert result["passed"]
    assert result["checks"]["panesPreserved"] == 1
    assert len(result["phases"]) == 4
    assert all(phase["passed"] and phase["seconds"] >= 0 for phase in result["phases"])
    assert report.stat().st_mode & 0o777 == 0o700
    for path in report.iterdir():
        assert path.stat().st_mode & 0o777 == 0o600
    assert "Result: PASS" in (report / "report.md").read_text()
    assert "Check local HTTP" in capsys.readouterr().out
    assert checks.main(args) == 1  # Existing evidence is retained, not replaced.
    assert json.loads((report / "verification.json").read_text()) == result


def test_failure_is_reported_without_credentials_or_fake_success(monkeypatch, tmp_path):
    args = setup_verifier(monkeypatch, tmp_path)
    monkeypatch.setattr(checks, "snapshot", lambda service: {**baseline(), "panes": []})
    assert checks.main(args) == 1
    result = json.loads((tmp_path / "report/verification.json").read_text())
    assert not result["passed"]
    assert len(result["phases"]) == 1
    assert not result["phases"][0]["passed"]
    assert "panes changed" in result["error"]
    assert "Result: FAIL" in (tmp_path / "report/report.md").read_text()


def test_snapshot_refuses_to_overwrite_existing_file_or_symlink(tmp_path):
    original = tmp_path / "original"
    original.write_text("keep")
    alias = tmp_path / "alias"
    alias.symlink_to(original)
    for path in (original, alias):
        with pytest.raises(FileExistsError):
            checks.private_write(path, "overwrite")
    assert original.read_text() == "keep"
