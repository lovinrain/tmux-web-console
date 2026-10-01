"""Machine-readable, identity-safe HTTP client for the Muxdeck control API."""
from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import re
import stat
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

IDENTITY_FIELDS = ("sessionId", "sessionCreated", "serverStarted", "serverPid")
PANE_FIELDS = (*IDENTITY_FIELDS, "paneId", "panePid")
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class ControlError(Exception):
    """A diagnostic safe to display without reflecting a server response body."""


class LaunchFailure(ControlError):
    def __init__(self, request_id: str, error: ControlError) -> None:
        self.request_id = request_id
        super().__init__(f"launch failed: {error}; requestId={request_id}; "
                         "check receipt/inventory before retrying with the same request ID")


class PartialSuccess(ControlError):
    def __init__(self, created: dict[str, Any], error: ControlError) -> None:
        self.created = created
        super().__init__(f"session created, but workspace placement failed: {error}; "
                         "do not repeat launch; use the session receipt to repair placement")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


def is_loopback_url(url: str) -> bool:
    host = urlsplit(url).hostname
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def _safe_path(path: str, *, api: bool = False) -> None:
    decoded = unquote(path)
    if (any(ord(char) < 33 or ord(char) == 127 for char in path)
            or any(ord(char) < 32 or ord(char) == 127 for char in decoded)
            or "\\" in decoded or "//" in decoded
            or any(part in {".", ".."} for part in decoded.split("/"))
            or (api and not path.startswith("/api/"))):
        raise ControlError("invalid API path" if api else "invalid server base path")


class ControlClient:
    """No automatic retries; credentials are loaded only on the first request."""

    def __init__(self, url: str, token_file: str | Path, *, timeout: float = 10) -> None:
        try:
            parts = urlsplit(url)
            valid = (parts.scheme in {"http", "https"} and bool(parts.hostname)
                     and not parts.username and not parts.password
                     and not parts.query and not parts.fragment)
            _ = parts.port
        except ValueError:
            valid = False
        if not valid or any(char.isspace() for char in url):
            raise ControlError("server URL must be an HTTP(S) origin with an optional base path")
        if parts.scheme == "http" and not is_loopback_url(url):
            raise ControlError("HTTP control requires loopback; use HTTPS for a remote server")
        _safe_path(parts.path)
        if not math.isfinite(timeout) or timeout <= 0:
            raise ControlError("request timeout must be positive and finite")
        self.url = url.rstrip("/")
        self.token_file = Path(token_file).expanduser()
        self.timeout = timeout
        self._token: str | None = None
        # Do not send local credentials through ambient HTTP proxy configuration.
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def _load_token(self) -> str:
        if self._token is not None:
            return self._token
        try:
            descriptor = os.open(self.token_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as handle:
                metadata = os.fstat(handle.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                        or metadata.st_mode & 0o077):
                    raise ControlError("control token file must be owner-only and owned by the current user")
                raw = handle.read(4097)
            token = raw.decode("ascii").strip()
            if len(raw) > 4096 or not token or not re.fullmatch(r"[A-Za-z0-9_\-]{32,128}", token):
                raise ControlError("invalid control token file")
        except (OSError, UnicodeError) as error:
            raise ControlError("cannot read a private control token file") from error
        self._token = token
        return token

    def request(self, method: str, path: str,
                payload: dict[str, Any] | None = None) -> dict[str, Any]:
        method = method.upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise ControlError("unsupported HTTP method")
        try:
            parts = urlsplit(path)
        except ValueError as error:
            raise ControlError("invalid API path") from error
        if parts.scheme or parts.netloc or parts.fragment:
            raise ControlError("API path must stay relative to the configured server")
        _safe_path(parts.path, api=True)
        if any(ord(char) < 33 or ord(char) == 127 for char in path):
            raise ControlError("invalid API path")
        headers = {"Authorization": "Bearer " + self._load_token(), "Accept": "application/json"}
        data = None
        if payload is not None:
            if not isinstance(payload, dict):
                raise ControlError("JSON request must be an object")
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                if response.status == 204:
                    return {}
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            error.close()
            if 300 <= error.code < 400:
                raise ControlError(f"HTTP {error.code}: redirects are refused") from error
            uncertainty = "; delivery may be uncertain; no retry was attempted" if error.code >= 500 else ""
            raise ControlError(f"HTTP {error.code}: control request failed{uncertainty}") from error
        except (URLError, OSError, TimeoutError) as error:
            raise ControlError("control request failed; delivery may be uncertain; no retry was attempted") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ControlError("control response exceeds the size limit")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ControlError("control response is not JSON") from error
        if not isinstance(result, dict):
            raise ControlError("control response must be a JSON object")
        return result


def _json_object(value: str) -> dict[str, Any]:
    try:
        text = (sys.stdin.read() if value == "-" else Path(value[1:]).read_text()
                if value.startswith("@") else value)
        result = json.loads(text)
    except (OSError, ValueError, RecursionError) as error:
        raise ControlError("invalid JSON object or unreadable JSON file") from error
    if not isinstance(result, dict):
        raise ControlError("JSON must be an object")
    return result


def _segment(value: str) -> str:
    return quote(value, safe="")


def _session_record(client: ControlClient, name: str) -> dict[str, Any]:
    inventory = client.request("GET", "/api/sessions")
    for session in inventory.get("sessions", []):
        if isinstance(session, dict) and session.get("name") == name:
            return session
    raise ControlError("session not found in the current inventory")


def _record_identity(record: dict[str, Any], pane_id: str | None = None) -> dict[str, Any]:
    identity = {"sessionId": record.get("id"), "sessionCreated": record.get("created"),
                "serverStarted": record.get("serverStarted"), "serverPid": record.get("serverPid")}
    selected = pane_id or record.get("activePaneId")
    panes = record.get("panes", [])
    pane = next((item for item in panes if item.get("id") == selected), None)
    if pane is None and selected is None and panes:
        pane = panes[0]
    if pane is None:
        raise ControlError("pane not found in the current session")
    identity.update(paneId=pane.get("id"), panePid=pane.get("panePid"))
    return _validate_identity(identity)


def _validate_identity(identity: dict[str, Any], *, pane: bool = True) -> dict[str, Any]:
    fields = PANE_FIELDS if pane else IDENTITY_FIELDS
    result = {field: identity.get(field) for field in fields}
    if not isinstance(result["sessionId"], str) or not re.fullmatch(r"\$\d+", result["sessionId"]):
        raise ControlError("session identity is missing or invalid")
    for key in ("sessionCreated", "serverStarted", "serverPid", *(("panePid",) if pane else ())):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ControlError("session identity is missing or invalid")
    if pane and (not isinstance(result["paneId"], str)
                 or not re.fullmatch(r"%\d+", result["paneId"])):
        raise ControlError("pane identity is missing or invalid")
    return result


def _identity(client: ControlClient, args: argparse.Namespace, *, pane: bool = True) -> dict[str, Any]:
    if args.identity:
        supplied = _json_object(args.identity)
        nested_identity = supplied.get("identity")
        identity_source = nested_identity if isinstance(nested_identity, dict) else supplied
        identity = _validate_identity(identity_source, pane=pane)
        receipt_session = supplied.get("session", args.name)
        if isinstance(receipt_session, dict):
            receipt_session = receipt_session.get("name")
        if receipt_session != args.name:
            raise ControlError("receipt belongs to a different session")
        if args.pane and identity.get("paneId") != args.pane:
            raise ControlError("pane does not match the supplied identity")
        return identity
    record = _session_record(client, args.name)
    if not pane:
        return _validate_identity({"sessionId": record.get("id"),
                                  "sessionCreated": record.get("created"),
                                  "serverStarted": record.get("serverStarted"),
                                  "serverPid": record.get("serverPid")}, pane=False)
    return _record_identity(record, args.pane)


def _workspace(client: ControlClient, workspace_id: str) -> dict[str, Any]:
    result = client.request("GET", "/api/workspaces/" + _segment(workspace_id))
    workspace = result.get("workspace")
    if not isinstance(workspace, dict):
        raise ControlError("workspace response is missing its record")
    return workspace


def _cas(workspace: dict[str, Any], revision: int | None = None) -> dict[str, Any]:
    return {"sessionRevision": workspace["sessionRevision"] if revision is None else revision,
            "expectedUpdatedAt": workspace["updatedAt"]}


def _group_order(tabs: list[str], groups: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    """Keep group members contiguous, preserving unrelated tab and group order."""
    groups = [group for group in groups if group["tabs"]]
    positions = {tab: index for index, tab in enumerate(tabs)}
    for group in groups:
        group["tabs"] = sorted(dict.fromkeys(group["tabs"]), key=positions.__getitem__)
    membership = {tab: group for group in groups for tab in group["tabs"]}
    emitted: set[str] = set()
    ordered: list[str] = []
    ordered_groups: list[dict[str, Any]] = []
    for tab in tabs:
        member_group = membership.get(tab)
        if member_group is None:
            ordered.append(tab)
        elif member_group["id"] not in emitted:
            emitted.add(member_group["id"])
            ordered.extend(member_group["tabs"])
            ordered_groups.append(member_group)
    return ordered, ordered_groups


def _placement_changes(workspace: dict[str, Any], name: str,
                       parent: str | None, group_id: str | None) -> dict[str, Any]:
    tabs = list(workspace["tabs"])
    if parent is not None and parent not in tabs:
        raise ControlError("parent must already belong to the destination workspace")
    groups = [dict(group, tabs=list(group["tabs"])) for group in workspace.get("groups", [])]
    if parent is not None:
        parent_group = next((group["id"] for group in groups if parent in group["tabs"]), None)
        if group_id is not None and group_id != parent_group:
            raise ControlError("a nested session must use its parent's group")
        group_id = parent_group
    group = next((group for group in groups if group["id"] == group_id), None)
    if group_id is not None and group is None:
        raise ControlError("group does not exist in the destination workspace")
    if name not in tabs:
        tabs.append(name)
    changes: dict[str, Any] = {"tabs": tabs}
    if parent is not None:
        parents = dict(workspace.get("parents", {}))
        parents[name] = parent
        changes["parents"] = parents
    if group is not None:
        for candidate in groups:
            candidate["tabs"] = [tab for tab in candidate["tabs"] if tab != name]
        group["tabs"].append(name)
        changes["tabs"], changes["groups"] = _group_order(tabs, groups)
    return changes


def launch_session(client: ControlClient, payload: dict[str, Any], *, workspace: str | None = None,
                   parent: str | None = None, group: str | None = None) -> dict[str, Any]:
    if (parent is not None or group is not None) and workspace is None:
        raise ControlError("parent and group require a workspace")
    before = _workspace(client, workspace) if workspace else None
    if before is not None:
        _placement_changes(before, "", parent, group)  # Validate placement before launching.
    request_id = payload.get("requestId", uuid.uuid4().hex)
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
        raise ControlError("request ID must contain 1-128 letters, digits, '_' or '-'")
    payload = {**payload, "requestId": request_id}
    try:
        created = client.request("POST", "/api/sessions", payload)
    except ControlError as error:
        raise LaunchFailure(payload["requestId"], error) from error
    created = {**created, "requestId": payload["requestId"]}
    if before is None:
        return created
    assert workspace is not None
    try:
        # One update with both rename revision and workspace timestamp prevents lost edits.
        changes = _placement_changes(before, created["session"], parent, group)
        placed = client.request("PATCH", "/api/workspaces/" + _segment(workspace),
                                {**changes, **_cas(before)})
    except ControlError as error:
        raise PartialSuccess(created, error) from error
    return {**created, "workspace": placed["workspace"]}


def _environment(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        key, separator, text = value.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or "\0" in text:
            raise ControlError("environment entries must be KEY=VALUE with valid variable names")
        result[key] = text
    return result


def _command(args: argparse.Namespace) -> list[str]:
    return args.command[1:] if args.command[:1] == ["--"] else args.command


def _session_command(client: ControlClient, args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    action = args.action
    if action == "list":
        return client.request("GET", "/api/sessions"), 0
    if action == "get":
        record = _session_record(client, args.name)
        return {"session": record, "identity": _record_identity(record, args.pane)}, 0
    if action == "launch":
        command = _command(args)
        if (args.mode == "command") != bool(command):
            raise ControlError("command mode requires literal argv after --; other modes take no command")
        payload: dict[str, Any] = {"launchMode": args.mode}
        for value, key in ((args.name, "name"), (args.cwd, "directory"),
                           (args.request_id, "requestId")):
            if value is not None:
                payload[key] = value
        if command:
            payload["command"] = command
        environment = _environment(args.env)
        if environment:
            payload["environment"] = environment
        if args.remain is not None or args.mode == "command":
            payload["remainOnExit"] = args.remain if args.remain is not None else True
        return launch_session(client, payload, workspace=args.workspace, parent=args.parent, group=args.group), 0
    identity = _identity(client, args, pane=action != "terminate" and not
                         (action == "cancel" and args.policy == "terminate"))
    path = "/api/sessions/" + _segment(args.name)
    if action == "terminate" or (action == "cancel" and args.policy == "terminate"):
        return client.request("DELETE", path, identity), 0
    if action == "capture":
        return client.request("GET", path + "/capture?" + urlencode({**identity, "lines": args.lines})), 0
    if action in {"input", "keys", "cancel"}:
        if action == "input":
            if args.stdin and args.text is not None:
                raise ControlError("choose text or stdin, not both")
            if args.identity == "-" and args.text is None:
                raise ControlError("stdin cannot supply both an identity receipt and input text")
            text = args.text if args.text is not None else sys.stdin.read()
            if ("\n" in text or "\r" in text) and not args.allow_multiline:
                raise ControlError("multiline input requires --allow-multiline; newlines may execute shell commands")
            payload = {**identity, "text": text, "submit": args.submit,
                       "allowMultiline": args.allow_multiline}
        else:
            payload = {**identity, "keys": ["C-c"] if action == "cancel" else args.keys}
        return client.request("POST", path + "/input", payload), 0
    if not math.isfinite(args.interval) or args.interval <= 0 or not math.isfinite(args.wait_timeout) or args.wait_timeout < 0:
        raise ControlError("wait interval must be positive and timeout nonnegative, both finite")
    deadline = time.monotonic() + args.wait_timeout
    while True:
        record = _session_record(client, args.name)
        current = _record_identity(record, identity["paneId"])
        if current != identity:
            raise ControlError("session or pane identity changed while waiting")
        pane = next(pane for pane in record["panes"] if pane["id"] == identity["paneId"])
        if pane.get("dead") is True:
            status = pane.get("exitStatus")
            if isinstance(status, bool) or not isinstance(status, int) or status < 0:
                raise ControlError("pane is dead but its actual exit status is unavailable")
            return {"session": args.name, **identity, "dead": True, "exitStatus": status}, min(status, 255)
        if time.monotonic() >= deadline:
            return {"session": args.name, **identity, "dead": False, "timedOut": True}, 124
        time.sleep(min(args.interval, max(0, deadline - time.monotonic())))


def _workspace_command(client: ControlClient, args: argparse.Namespace) -> dict[str, Any]:
    if args.action == "list":
        return client.request("GET", "/api/workspaces")
    if args.action == "create":
        return client.request("POST", "/api/workspaces", {"name": args.name, "tabs": args.sessions,
                              "activeSession": args.active or (args.sessions[0] if args.sessions else None)})
    workspace = _workspace(client, args.workspace)
    path = "/api/workspaces/" + _segment(args.workspace)
    if args.action == "get":
        return {"workspace": workspace}
    if args.action in {"add", "remove"}:
        revision = workspace["sessionRevision"] if args.revision is None else args.revision
        return client.request("POST" if args.action == "add" else "DELETE", path + "/sessions",
                              {"sessions": args.sessions, "sessionRevision": revision})
    if args.action == "parent":
        if args.detach == bool(args.parent):
            raise ControlError("provide a parent session or --detach")
        if args.child not in workspace["tabs"] or (args.parent and args.parent not in workspace["tabs"]):
            raise ControlError("child and parent must belong to the workspace")
        parents = dict(workspace.get("parents", {}))
        if args.detach:
            parents.pop(args.child, None)
        else:
            parents[args.child] = args.parent
        return client.request("PATCH", path, {"parents": parents, **_cas(workspace, args.revision)})
    groups = [dict(group, tabs=list(group["tabs"])) for group in workspace.get("groups", [])]
    if args.group_action == "list":
        return {"groups": groups, "sessionRevision": workspace["sessionRevision"]}
    if args.group_action == "create":
        if any(session not in workspace["tabs"] for session in args.sessions):
            raise ControlError("group sessions must belong to the workspace")
        new_group = {"id": args.id or uuid.uuid4().hex, "name": args.name,
                     "color": args.color, "collapsed": False, "tabs": args.sessions}
        if any(group["id"] == new_group["id"] for group in groups):
            raise ControlError("group ID already exists in the workspace")
        for candidate in groups:
            candidate["tabs"] = [tab for tab in candidate["tabs"] if tab not in args.sessions]
        groups.append(new_group)
    else:
        group = next((group for group in groups if group["id"] == args.group), None)
        if group is None:
            raise ControlError("group not found in the workspace")
        if args.group_action == "delete":
            groups.remove(group)
        elif args.group_action == "add":
            if any(session not in workspace["tabs"] for session in args.sessions):
                raise ControlError("group sessions must belong to the workspace")
            for candidate in groups:
                candidate["tabs"] = [tab for tab in candidate["tabs"] if tab not in args.sessions]
            group["tabs"].extend(dict.fromkeys(args.sessions))
        else:
            group["tabs"] = [tab for tab in group["tabs"] if tab not in args.sessions]
    tabs, groups = _group_order(list(workspace["tabs"]), groups)
    return client.request("PATCH", path, {"tabs": tabs, "groups": groups, **_cas(workspace, args.revision)})


def _add_placement(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--name")
    parser.add_argument("--cwd", help="absolute directory on the Muxdeck server")
    parser.add_argument("--request-id", help="stable unique ID for detecting duplicate launches")
    parser.add_argument("--env", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--workspace", help="destination saved workspace ID")
    parser.add_argument("--parent", help="parent session in that workspace")
    parser.add_argument("--group", help="existing group ID in that workspace")
    parser.add_argument("command", nargs=argparse.REMAINDER, metavar="ARGV")


def _capture_lines(value: str) -> int:
    try:
        lines = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("lines must be an integer from 1 to 2000") from error
    if not 1 <= lines <= 2000:
        raise argparse.ArgumentTypeError("lines must be an integer from 1 to 2000")
    return lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="muxdeckctl", description=__doc__)
    parser.add_argument("--url", default=os.environ.get("MUXDECK_URL", "http://127.0.0.1:7683/mux"))
    parser.add_argument("--token-file", default=os.environ.get("MUXDECK_CONTROL_TOKEN_FILE", "~/.config/muxdeck/control-token"))
    parser.add_argument("--timeout", type=float, default=10, help="HTTP timeout in seconds")
    commands = parser.add_subparsers(dest="resource", required=True)
    commands.add_parser("capabilities")
    api = commands.add_parser("api", help="call any relative /api/ endpoint without retries")
    api.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    api.add_argument("path")
    api.add_argument("--json", dest="json_payload", help="JSON object, @file, or - for stdin")
    execution = commands.add_parser("exec", help="run a same-host stdio agent in tmux (stdout stays protocol-clean)")
    _add_placement(execution)
    sessions = commands.add_parser("sessions").add_subparsers(dest="action", required=True)
    sessions.add_parser("list")
    launch = sessions.add_parser("launch")
    launch.add_argument("--mode", "--launch-mode", choices=["default", "shell", "command"], default="default")
    launch.add_argument("--remain", "--remain-on-exit", dest="remain", action=argparse.BooleanOptionalAction, default=None)
    _add_placement(launch)
    for action in ("get", "capture", "input", "keys", "terminate", "wait", "cancel"):
        command = sessions.add_parser(action)
        command.add_argument("name")
        command.add_argument("--pane", help="pane ID (defaults to the active pane)")
        command.add_argument("--identity", help="expected identity receipt JSON, @file, or -")
        if action == "capture":
            command.add_argument("--lines", type=_capture_lines, default=200, metavar="1..2000")
        elif action == "input":
            command.add_argument("text", nargs="?")
            command.add_argument("--stdin", action="store_true", help="read literal text from stdin")
            command.add_argument("--submit", action="store_true", help="send Enter after literal text")
            command.add_argument("--allow-multiline", action="store_true", help="allow newlines/CR; these can execute shell commands")
        elif action == "keys":
            command.add_argument("keys", nargs="+", help="explicit tmux key names, e.g. C-c")
        elif action == "wait":
            command.add_argument("--timeout", dest="wait_timeout", type=float, default=300)
            command.add_argument("--interval", type=float, default=0.25)
        elif action == "cancel":
            command.add_argument("--policy", choices=["interrupt", "terminate"], default="interrupt")
    workspaces = commands.add_parser("workspaces").add_subparsers(dest="action", required=True)
    workspaces.add_parser("list")
    create = workspaces.add_parser("create")
    create.add_argument("name")
    create.add_argument("sessions", nargs="*")
    create.add_argument("--active")
    for action in ("get", "add", "remove", "parent"):
        command = workspaces.add_parser(action)
        command.add_argument("workspace")
        if action != "get":
            command.add_argument("--revision", type=int, help="expected session rename revision")
        if action in {"add", "remove"}:
            command.add_argument("sessions", nargs="+")
        elif action == "parent":
            command.add_argument("child")
            command.add_argument("parent", nargs="?")
            command.add_argument("--detach", action="store_true")
    groups = workspaces.add_parser("group").add_subparsers(dest="group_action", required=True)
    for action in ("list", "create", "add", "remove", "delete"):
        command = groups.add_parser(action)
        command.add_argument("workspace")
        if action != "list":
            command.add_argument("--revision", type=int)
        if action == "create":
            command.add_argument("name")
            command.add_argument("sessions", nargs="+")
            command.add_argument("--id")
            command.add_argument("--color", default="blue")
        elif action != "list":
            command.add_argument("group")
            if action != "delete":
                command.add_argument("sessions", nargs="+")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "project":
        from muxpilot.cli import main as project_main
        return project_main(arguments[1:])
    args = build_parser().parse_args(arguments)
    try:
        if args.resource == "exec":
            from . import stdio_bridge
            command = _command(args)
            if not command:
                raise ControlError("exec requires literal argv after --")
            if stdio_bridge.is_lightweight_probe(command):
                return stdio_bridge.run(command, api=None, cwd=args.cwd or os.getcwd(),
                                        environment={**os.environ, **_environment(args.env)}, launch_options={})
        client = ControlClient(args.url, args.token_file, timeout=args.timeout)
        if args.resource == "exec":
            if not is_loopback_url(args.url):
                raise ControlError("exec requires a same-host loopback Muxdeck server")
            options = {key: value for key, value in {"name": args.name, "requestId": args.request_id}.items() if value is not None}
            def placed_api(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
                if method == "POST" and path == "/api/sessions":
                    assert payload is not None
                    return launch_session(client, payload, workspace=args.workspace, parent=args.parent, group=args.group)
                return client.request(method, path, payload)
            return stdio_bridge.run(command, api=placed_api, cwd=args.cwd or os.getcwd(),
                                    environment={**os.environ, **_environment(args.env)}, launch_options=options)
        status = 0
        if args.resource == "capabilities":
            result = client.request("GET", "/api/capabilities")
        elif args.resource == "api":
            result = client.request(args.method, args.path, _json_object(args.json_payload) if args.json_payload else None)
        elif args.resource == "sessions":
            result, status = _session_command(client, args)
        else:
            result = _workspace_command(client, args)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return status
    except PartialSuccess as error:
        if args.resource != "exec":
            print(json.dumps({"partialSuccess": True, "created": error.created, "placement": "failed"}, ensure_ascii=False))
        else:
            print("muxdeckctl: created session receipt: " + json.dumps(error.created, ensure_ascii=False), file=sys.stderr)
        print("muxdeckctl: " + str(error), file=sys.stderr)
        return 1
    except ControlError as error:
        print("muxdeckctl: " + str(error), file=sys.stderr)
        return 1
    except RuntimeError:
        print("muxdeckctl: stdio bridge failed; inspect the local runner and provider configuration", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("muxdeckctl: interrupted; no implicit remote cancellation", file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, TypeError):
        print("muxdeckctl: invalid request or incompatible control response", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
