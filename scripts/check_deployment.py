#!/usr/bin/env python3
"""Read-only deployment checks with bounded waits and private, timed reports."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

COMMAND_TIMEOUT = 8
HTTP_TIMEOUT = 5


class CheckError(Exception):
    """A failure description that contains no credentials or terminal output."""

    def __init__(self, message, *, comparison=None):
        super().__init__(message)
        self.comparison = comparison


def require(condition, message):
    if not condition:
        raise CheckError(message)


def command(args, *, env=None):
    try:
        return subprocess.run(
            args,
            env=env,
            capture_output=True,
            text=True,
            check=True,
            timeout=COMMAND_TIMEOUT,
        ).stdout.strip()
    except subprocess.TimeoutExpired as error:
        raise CheckError(f"{Path(args[0]).name} exceeded {COMMAND_TIMEOUT}s") from error
    except (OSError, subprocess.CalledProcessError) as error:
        # Command stderr may contain private service configuration.
        raise CheckError(
            f"{Path(args[0]).name} failed; inspect it privately"
        ) from error


def snapshot(service):
    require(
        bool(re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", service)),
        "Invalid service name",
    )
    properties = command(
        [
            "systemctl",
            "show",
            service,
            "--no-pager",
            "--property=Id,MainPID,ActiveState,KillMode,ControlGroup,WorkingDirectory",
        ]
    )
    facts = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
    require(facts.get("ActiveState") == "active", "Muxdeck service is not active")
    require(
        facts.get("KillMode") == "process", "KillMode must be process before deployment"
    )
    pid = int(facts.get("MainPID", "0"))
    require(pid > 0, "Muxdeck has no running main process")
    process = Path(f"/proc/{pid}")
    require(
        process.stat().st_uid == os.geteuid(),
        "Run this check as the Muxdeck service user",
    )
    env = dict(
        os.fsdecode(entry).split("=", 1)
        for entry in (process / "environ").read_bytes().split(b"\0")
        if b"=" in entry
    )
    # Use the service's environment and socket, never the invoking agent's TMUX.
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    tmux = [env.get("TMUX_BIN", "tmux")]
    if env.get("MUXDECK_TMUX_SOCKET"):
        tmux += ["-L", env["MUXDECK_TMUX_SOCKET"]]
    identity = command(
        tmux + ["display-message", "-p", "#{pid}\t#{socket_path}\t#{start_time}"],
        env=env,
    )
    fields = identity.split("\t")
    require(
        len(fields) == 3 and fields[0].isdigit() and bool(fields[1]),
        "Incomplete tmux identity",
    )
    group = facts.get("ControlGroup", "")
    require(bool(group) and group != "/", "Missing Muxdeck cgroup")
    tmux_groups = Path(f"/proc/{fields[0]}/cgroup").read_text().splitlines()
    require(bool(tmux_groups), "Missing tmux cgroup")
    require(
        not any(
            line.split(":", 2)[-1] == group
            or line.split(":", 2)[-1].startswith(group + "/")
            for line in tmux_groups
        ),
        "tmux belongs to the Muxdeck cgroup; deployment must stop for review",
    )
    panes = sorted(
        command(
            tmux
            + [
                "list-panes",
                "-a",
                "-F",
                "#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}",
            ],
            env=env,
        ).splitlines()
    )
    require(bool(panes), "No tmux panes found; verify the intended owner and socket")
    pane_records(panes, "snapshot")
    mode = env.get("MUXDECK_AUTH_MODE")
    require(mode in {"server", "basic", "none"}, "Set an explicit MUXDECK_AUTH_MODE")
    host = env.get("MUXDECK_HOST", "127.0.0.1")
    require(ipaddress.ip_address(host).is_loopback, "Muxdeck must bind to loopback")
    port = int(env.get("MUXDECK_PORT", "7683"))
    require(0 < port < 65536, "Invalid Muxdeck port")
    base = env.get("MUXDECK_BASE_PATH", "/mux").rstrip("/")
    require(
        not base or bool(re.fullmatch(r"/[A-Za-z0-9_/-]+", base)), "Invalid base path"
    )
    return {
        "version": 1,
        "capturedAt": datetime.now(UTC).isoformat(),
        "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "service": facts["Id"],
        "mainPid": pid,
        "appDir": facts["WorkingDirectory"],
        "origin": f"http://{'[' + host + ']' if ':' in host else host}:{port}",
        "basePath": base,
        "authMode": mode,
        "trustedOrigins": env.get("MUXDECK_TRUSTED_ORIGINS", "").split(","),
        "tmux": identity,
        "panes": panes,
    }


def pane_records(panes, label):
    require(
        isinstance(panes, list) and (bool(panes) or label == "current"),
        f"Invalid {label} panes",
    )
    records = {}
    linked_identities = {}
    for row in panes:
        require(isinstance(row, str), f"Malformed {label} panes")
        fields = row.split("\t")
        require(len(fields) == 5, f"Incomplete {label} panes")
        session, pane, pid, foreground, dead = fields
        require(
            bool(re.fullmatch(r"\$[0-9]+", session))
            and bool(re.fullmatch(r"%[0-9]+", pane))
            and bool(re.fullmatch(r"[0-9]+", pid))
            and int(pid) > 0
            and bool(foreground)
            and not any(ord(char) < 32 or ord(char) == 127 for char in foreground)
            and dead in {"0", "1"},
            f"Malformed {label} panes",
        )
        key = (session, pane)
        # Linked windows can share one pane across sessions, but each pair must
        # occur only once. Never let duplicate rows overwrite an identity.
        require(key not in records, f"Duplicate {label} panes")
        identity = (int(pid), dead)
        require(
            pane not in linked_identities or linked_identities[pane] == identity,
            f"Inconsistent linked {label} panes",
        )
        linked_identities[pane] = identity
        records[key] = {
            "sessionId": session,
            "paneId": pane,
            "panePid": int(pid),
            "command": foreground,
            "dead": dead == "1",
        }
    return records


def compare(before, after, *, allow_added_panes=False, allow_command_changes=False):
    original = pane_records(before["panes"], "baseline")
    current = pane_records(after["panes"], "current")
    added = [current[key] for key in sorted(current.keys() - original.keys())]
    removed = [original[key] for key in sorted(original.keys() - current.keys())]
    changed = []
    commands = []
    for key in sorted(original.keys() & current.keys()):
        old, new = original[key], current[key]
        identity = {"sessionId": key[0], "paneId": key[1]}
        if (old["panePid"], old["dead"]) != (new["panePid"], new["dead"]):
            changed.append(
                {
                    **identity,
                    "beforePanePid": old["panePid"],
                    "afterPanePid": new["panePid"],
                    "beforeDead": old["dead"],
                    "afterDead": new["dead"],
                }
            )
        if old["command"] != new["command"]:
            commands.append(
                {
                    **identity,
                    "beforeCommand": old["command"],
                    "afterCommand": new["command"],
                }
            )
    identity_changes = [
        key
        for key in ("bootId", "service", "origin", "basePath", "authMode", "tmux")
        if before[key] != after[key]
    ]
    comparison = {
        "baselineCount": len(original),
        "currentCount": len(current),
        "preservedCount": len(original) - len(removed) - len(changed),
        "addedCount": len(added),
        "removedCount": len(removed),
        "identityChangedCount": len(changed),
        "commandChangedCount": len(commands),
        "addedPanes": added,
        "removedPanes": removed,
        "identityChangedPanes": changed,
        "commandChanges": commands,
        "identityFieldsChanged": identity_changes,
        "allowAddedPanes": allow_added_panes,
        "allowCommandChanges": allow_command_changes,
    }
    failures = [f"{key} changed since the baseline" for key in identity_changes]
    if removed or changed:
        failures.append(
            "panes changed: original panes were removed, moved, respawned, or changed dead/alive state"
        )
    if added and not allow_added_panes:
        failures.append(
            "panes changed: added panes require reviewed --allow-added-panes"
        )
    if commands and not allow_command_changes:
        failures.append(
            "panes changed: foreground commands require reviewed --allow-command-changes"
        )
    if failures:
        raise CheckError(
            "; ".join(failures) + "; review before accepting deployment",
            comparison=comparison,
        )
    return comparison


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_status(url, headers=None):
    # Do not follow login redirects into a misleading 200, or inherit proxy credentials.
    opener = build_opener(ProxyHandler({}), NoRedirects())
    try:
        with opener.open(
            Request(url, headers=headers or {}), timeout=HTTP_TIMEOUT
        ) as response:
            return response.status, response.headers
    except HTTPError as error:
        with error:
            return error.code, error.headers
    except (OSError, URLError) as error:
        raise CheckError(f"HTTP check failed or exceeded {HTTP_TIMEOUT}s") from error


def check_http(current, origin, asset):
    base, mode = current["basePath"], current["authMode"]
    protected = 200 if mode == "none" else 401
    checks = [("health", base + "/api/health", protected, {})]
    checks.append(("asset", asset, protected, {}))
    checks.append(
        (
            "navigation",
            base + "/",
            {"server": 303, "basic": 401, "none": 200}[mode],
            {"Accept": "text/html", "Sec-Fetch-Mode": "navigate"},
        )
    )
    if mode == "server":
        checks.append(("login", base + "/login", 200, {}))
    results = {}
    for name, path, expected, headers in checks:
        status, response_headers = http_status(origin + path, headers)
        require(
            status == expected, f"{name}: expected HTTP {expected}, received {status}"
        )
        if mode == "basic" and status == 401:
            require(
                response_headers.get("WWW-Authenticate", "").startswith("Basic "),
                "Missing Basic challenge",
            )
        if name == "navigation" and mode == "server":
            require(
                response_headers.get("Location", "").split("?", 1)[0]
                == base + "/login",
                "Browser navigation did not redirect to Muxdeck login",
            )
        results[name] = status
    return results


def frontend(current, expected_dist=None):
    dist = Path(current["appDir"]) / "dist"
    index = (dist / "index.html").read_text()
    prefix = current["basePath"] + "/assets/"
    assets = [
        path
        for path in re.findall(r"(?:src|href)=[\"\']([^\"\']+)[\"\']", index)
        if path.startswith(prefix)
    ]
    require(bool(assets), "Built index has no assets for the configured base path")
    for asset in assets:
        relative = Path(asset.removeprefix(current["basePath"] + "/"))
        require(
            ".." not in relative.parts and (dist / relative).is_file(),
            "Built asset is missing or invalid",
        )
    if expected_dist is not None:
        expected = Path(expected_dist)
        require(
            expected.resolve() != dist.resolve(),
            "Expected build must be a separate staged directory",
        )
        require((expected / "index.html").is_file(), "Staged build has no index.html")
        for source in expected.rglob("*"):
            if source.is_file():
                installed = dist / source.relative_to(expected)
                require(
                    installed.is_file()
                    and hashlib.sha256(installed.read_bytes()).digest()
                    == hashlib.sha256(source.read_bytes()).digest(),
                    "Installed frontend differs from the staged build",
                )
    return assets[0]


def journal(service, since):
    # Validate the timestamp; report counts only, never journal text or terminal content.
    datetime.fromisoformat(since)
    logs = command(
        ["journalctl", "--unit", service, "--since", since, "--no-pager", "-o", "cat"]
    )
    errors = sum(
        bool(
            re.search(
                r"Traceback \(most recent call last\)|\bERROR[: ]|WARNING:muxdeck", line
            )
        )
        for line in logs.splitlines()
    )
    timeout = "stop-sigterm" in logs and "timed out" in logs
    require(
        errors == 0,
        f"{errors} application error/warning lines; inspect the journal privately",
    )
    return {"applicationErrors": errors, "oldProcessStopReachedTimeout": timeout}


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Refuse overwrites, including symlinks; retain earlier evidence.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)


class Report:
    def __init__(self):
        self.started = time.monotonic()
        self.data = {
            "checkedAt": datetime.now(UTC).isoformat(),
            "passed": False,
            "phases": [],
            "checks": {},
        }

    @contextmanager
    def phase(self, name):
        start = time.monotonic()
        print(f"[{start - self.started:.2f}s] {name}…", flush=True)
        phase = {"name": name, "passed": False}
        try:
            yield
            phase["passed"] = True
        finally:
            phase["seconds"] = round(time.monotonic() - start, 3)
            self.data["phases"].append(phase)
            state = "OK" if phase["passed"] else "FAILED"
            print(f"  {state} ({phase['seconds']:.3f}s)", flush=True)

    def save(self, directory):
        self.data["seconds"] = round(time.monotonic() - self.started, 3)
        private_write(
            directory / "verification.json", json.dumps(self.data, indent=2) + "\n"
        )
        lines = [
            "# Muxdeck deployment checks",
            "",
            f"Result: {'PASS' if self.data['passed'] else 'FAIL'}",
            f"Elapsed: {self.data['seconds']:.3f}s",
            "",
            "| Phase | Result | Seconds |",
            "| --- | --- | ---: |",
        ]
        lines += [
            f"| {p['name']} | {'PASS' if p['passed'] else 'FAIL'} | {p['seconds']:.3f} |"
            for p in self.data["phases"]
        ]
        lines += ["", "```json", json.dumps(self.data["checks"], indent=2), "```", ""]
        if "error" in self.data:
            lines += [self.data["error"], ""]
        if self.data["checks"].get("journal", {}).get("oldProcessStopReachedTimeout"):
            lines += [
                "The old web process reached its stop timeout; investigate graceful shutdown separately.",
                "",
            ]
        lines += [
            "These are read-only smoke checks. Authenticated browser behavior, state migrations,",
            "backups, CI, and task-specific checks remain separate evidence.",
            "",
        ]
        private_write(directory / "report.md", "\n".join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    before = sub.add_parser(
        "snapshot", help="Record service and pane identities before deployment"
    )
    before.add_argument("--service", default="muxdeck.service")
    before.add_argument("--output", type=Path, required=True)
    after = sub.add_parser(
        "verify", help="Compare a baseline and check the deployed service"
    )
    after.add_argument("--baseline", type=Path, required=True)
    after.add_argument("--output-dir", type=Path, required=True)
    after.add_argument("--public-origin", action="append", default=[])
    after.add_argument("--expected-dist", type=Path)
    after.add_argument(
        "--allow-added-panes",
        action="store_true",
        help="Accept added panes after reviewing user activity; all original pane identities must remain unchanged",
    )
    after.add_argument(
        "--allow-command-changes",
        action="store_true",
        help="Accept foreground command changes after reviewing user activity; original pane PIDs and dead/alive flags must remain unchanged",
    )
    args = parser.parse_args(argv)
    report = Report()
    directory = None
    try:
        if args.action == "snapshot":
            with report.phase("Record service and tmux identities"):
                current = snapshot(args.service)
                private_write(args.output, json.dumps(current, indent=2) + "\n")
            print(f"Baseline saved: {len(current['panes'])} panes", flush=True)
            return 0
        args.output_dir.mkdir(parents=True, mode=0o700)
        directory = args.output_dir
        with report.phase("Compare service and tmux identities"):
            baseline = json.loads(args.baseline.read_text())
            require(isinstance(baseline, dict), "Baseline must contain an object")
            require(baseline.get("version") == 1, "Unsupported baseline version")
            current = snapshot(baseline["service"])
            comparison = compare(
                baseline,
                current,
                allow_added_panes=args.allow_added_panes,
                allow_command_changes=args.allow_command_changes,
            )
            report.data["checks"]["paneComparison"] = comparison
            report.data["checks"]["panesPreserved"] = comparison["preservedCount"]
            report.data["checks"]["mainPid"] = current["mainPid"]
        with report.phase("Check installed frontend"):
            asset = frontend(current, args.expected_dist)
            report.data["checks"]["stagedFrontendCompared"] = (
                args.expected_dist is not None
            )
        with report.phase("Check local HTTP and authentication"):
            report.data["checks"]["local"] = check_http(
                current, current["origin"], asset
            )
            status, _ = http_status(
                current["origin"] + current["basePath"] + "/api/health",
                {"Host": "untrusted.invalid"},
            )
            require(
                status == 403, f"Untrusted Host: expected HTTP 403, received {status}"
            )
            report.data["checks"]["untrustedHost"] = status
        for number, origin in enumerate(args.public_origin, 1):
            with report.phase(f"Check external HTTP and authentication ({number})"):
                parsed = urlsplit(origin)
                require(
                    parsed.scheme == "https"
                    and bool(parsed.hostname)
                    and not parsed.username
                    and not parsed.password
                    and not parsed.path
                    and not parsed.query
                    and not parsed.fragment,
                    "Public origin must be HTTPS without credentials, path, query, or fragment",
                )
                require(
                    origin in current["trustedOrigins"],
                    "Public origin is not configured in Muxdeck",
                )
                report.data["checks"][f"external{number}"] = check_http(
                    current, origin, asset
                )
        with report.phase("Check application journal"):
            report.data["checks"]["journal"] = journal(
                current["service"], baseline["capturedAt"]
            )
        report.data["passed"] = True
    except (CheckError, OSError, ValueError, KeyError, TypeError) as error:
        if isinstance(error, CheckError) and error.comparison is not None:
            report.data["checks"]["paneComparison"] = error.comparison
        message = (
            str(error)
            if isinstance(error, CheckError)
            else f"{type(error).__name__}: check service access and evidence paths privately"
        )
        report.data["error"] = message
        print(f"FAILED: {message}", flush=True)
    finally:
        if directory is not None:
            report.save(directory)
            status = "PASS" if report.data["passed"] else "FAIL"
            print(
                f"{status}: {report.data['seconds']:.3f}s total; report: {directory / 'report.md'}",
                flush=True,
            )
    return 0 if report.data["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
