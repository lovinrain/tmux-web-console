#!/usr/bin/env python3
"""Post and read persistent Muxdeck callbacks using Python's standard library."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

DEFAULT_URL = "https://la.99818888.xyz/mux/api/callback-messages"
DEFAULT_TOKEN_FILE = "~/.config/muxdeck/callback-token"
# Up to 200 records with 16,384-character messages, including JSON's escaped
# surrogate pairs and the bounded metadata fields.
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class CallbackError(Exception):
    """An actionable error whose message is safe to print without credentials."""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # urllib can carry Authorization to another origin. Never follow redirects.
        return None


def process_ancestors(pid: int) -> set[int]:
    """Return this Linux process and its ancestors without trusting environment."""
    ancestors: set[int] = set()
    while pid > 0 and pid not in ancestors:
        ancestors.add(pid)
        try:
            # The process name in parentheses may itself contain spaces or ')'.
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            pid = int(fields[1])
        except (OSError, ValueError, IndexError) as exc:
            raise CallbackError(
                "Cannot verify tmux process ancestry on this host."
            ) from exc
    return ancestors


def detect_tmux() -> dict[str, str]:
    pane = os.environ.get("TMUX_PANE", "")
    tmux_env = os.environ.get("TMUX", "")
    if not re.fullmatch(r"%\d+", pane) or not tmux_env:
        raise CallbackError(
            "No verifiable tmux environment. Run from the task's tmux pane, "
            "or provide both --session and --cwd using verified values."
        )
    parts = tmux_env.rsplit(",", 2)
    if len(parts) != 3 or not parts[0] or not all(part.isdigit() for part in parts[1:]):
        raise CallbackError(
            "Invalid TMUX environment; cannot identify its server socket."
        )
    # tmux escapes other control separators (e.g. U+001F) as octal text.
    # Tabs are emitted literally; the API disallows tabs in metadata fields.
    separator = "\t"
    fields = ["session_name", "session_id", "pane_id", "pane_pid", "pane_current_path"]
    command = [
        "tmux",
        "-S",
        parts[0],
        "display-message",
        "-p",
        "-t",
        pane,
        separator.join("#{" + field + "}" for field in fields),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, check=True, timeout=5
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise CallbackError(
            "Could not query the current tmux pane; no callback was sent."
        ) from exc
    values = result.stdout.rstrip("\n").split(separator)
    if len(values) != len(fields):
        raise CallbackError("tmux returned incomplete pane metadata.")
    name, session_id, actual_pane, pane_pid, cwd = values
    if (
        not name
        or not re.fullmatch(r"\$\d+", session_id)
        or actual_pane != pane
        or not pane_pid.isdigit()
    ):
        raise CallbackError("tmux returned invalid session or pane metadata.")
    if int(pane_pid) not in process_ancestors(os.getpid()):
        raise CallbackError(
            "TMUX_PANE belongs to a different process tree (stale environment). "
            "Run in the correct pane, or provide verified --session and --cwd."
        )
    if not os.path.isabs(cwd):
        raise CallbackError(
            "tmux did not report an absolute working directory; provide --cwd."
        )
    return {
        "sessionName": name,
        "tmuxSessionId": session_id,
        "tmuxPaneId": pane,
        "cwd": cwd,
    }


def build_payload(args: argparse.Namespace, message: str) -> dict[str, str]:
    if not message.strip():
        raise CallbackError("A nonempty callback message is required.")
    if args.cwd and not os.path.isabs(args.cwd):
        raise CallbackError("--cwd must be an absolute path.")
    if args.session is not None and not args.session.strip():
        raise CallbackError("--session must be a verified, nonempty tmux session name.")
    if args.session is not None and args.cwd:
        # An explicit target can be another session. Do not attach IDs from this pane.
        metadata = {"sessionName": args.session, "cwd": args.cwd}
    else:
        metadata = detect_tmux()
        if args.session is not None and args.session != metadata["sessionName"]:
            raise CallbackError(
                "--session differs from the current pane; also provide its verified --cwd."
            )
        if args.cwd:
            metadata["cwd"] = args.cwd
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", args.agent):
        raise CallbackError(
            "--agent must be a lowercase agent name, such as codex or claude."
        )
    try:
        request_id = (
            str(uuid.UUID(args.request_id)) if args.request_id else str(uuid.uuid4())
        )
    except ValueError as exc:
        raise CallbackError("--request-id must be a UUID.") from exc
    return {
        **metadata,
        "message": message,
        "agentType": args.agent,
        "requestId": request_id,
        "host": socket.gethostname(),
    }


def read_token(filename: str) -> str:
    path = Path(filename).expanduser()
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_mode & 0o077
                or info.st_uid != os.geteuid()
                or info.st_size > 130
            ):
                raise CallbackError(
                    "Callback token file must be private (chmod 600), owned by the current user, and a regular file."
                )
            token = stream.read(256).strip().decode("ascii")
    except (OSError, UnicodeError) as exc:
        raise CallbackError(
            "Cannot read the callback token file; ask the Muxdeck owner to provision it."
        ) from exc
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise CallbackError(
            "Callback token file is empty or malformed; ask the owner to provision it."
        )
    return token


def validate_url(url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(url)
        local = parsed.hostname == "localhost"
        if parsed.hostname and not local:
            try:
                local = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                pass
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.port == 0
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and local))
        ):
            raise ValueError
    except ValueError as exc:
        raise CallbackError(
            "Endpoint must be an HTTPS URL (HTTP is allowed only on loopback), without credentials/query/fragment."
        ) from exc
    return url.rstrip("/")


class Client:
    def __init__(self, url: str, token: str, attempts: int = 3, timeout: float = 15):
        self.url = validate_url(url)
        self.token = token
        self.attempts = attempts
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirects())

    def request(
        self, method: str, suffix: str = "", payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        body = (
            None
            if payload is None
            else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        )
        headers = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        for attempt in range(self.attempts):
            request = urllib.request.Request(
                self.url + suffix, data=body, headers=headers, method=method
            )
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise CallbackError("Callback response was too large.")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise CallbackError(
                        "Callback endpoint did not return a valid JSON object."
                    )
                return result
            except urllib.error.HTTPError as exc:
                status = exc.code
                exc.close()
                retry = status in (429, 500, 502, 503, 504)
                detail = (
                    " Check the provisioned callback token."
                    if status in (401, 403)
                    else ""
                )
                if 300 <= status < 400:
                    detail = " Redirects are refused to protect the callback token; check the endpoint URL."
                error = CallbackError(
                    f"Callback endpoint returned HTTP {status}.{detail}"
                )
            except (urllib.error.URLError, TimeoutError, OSError):
                retry = True
                error = CallbackError(
                    "Cannot reach the callback endpoint (network, TLS, or timeout error)."
                )
            except (ValueError, UnicodeError) as exc:
                raise CallbackError(
                    "Callback endpoint did not return a valid JSON object."
                ) from exc
            if not retry or attempt + 1 == self.attempts:
                raise error
            time.sleep(min(2**attempt, 4))
        raise CallbackError("No callback request attempts were configured.")


def list_messages(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    after = args.after or 0
    all_messages: list[Any] = []
    while True:
        query: dict[str, Any] = {"status": args.status, "limit": args.limit}
        if after:
            query["after"] = after
        result = client.request("GET", "?" + urllib.parse.urlencode(query))
        if not isinstance(result.get("messages"), list):
            raise CallbackError(
                "Callback listing response is missing its messages array."
            )
        if not args.all_pages:
            return result
        all_messages.extend(result["messages"])
        next_after = result.get("nextAfter")
        if next_after is None:
            return {**result, "messages": all_messages}
        if (
            isinstance(next_after, bool)
            or not isinstance(next_after, int)
            or not after < next_after <= 2**63 - 1
        ):
            raise CallbackError(
                "Callback endpoint returned an invalid or non-increasing pagination cursor."
            )
        after = next_after


def pagination_cursor(value: str) -> int:
    try:
        number = int(value)
        if not 0 <= number <= 2**63 - 1:
            raise ValueError
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "cursor must be a nonnegative 64-bit integer"
        ) from exc
    return number


def validate_receipt(
    result: dict[str, Any],
    *,
    request_id: str | None = None,
    reviewed_id: str | None = None,
) -> None:
    callback = result.get("callback")
    if (
        not isinstance(callback, dict)
        or not isinstance(callback.get("id"), str)
        or not callback["id"]
        or not isinstance(callback.get("message"), str)
        or not callback["message"].strip()
    ):
        raise CallbackError(
            "Callback endpoint did not return a valid callback receipt."
        )
    if request_id is not None and (
        callback.get("requestId") != request_id
        or not isinstance(result.get("duplicate"), bool)
    ):
        raise CallbackError("Callback receipt did not confirm this request ID.")
    if reviewed_id is not None and (
        callback["id"] != reviewed_id or callback.get("reviewedAt") is None
    ):
        raise CallbackError("Callback receipt did not confirm the requested review.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--url", default=DEFAULT_URL, help="callback collection endpoint"
    )
    common.add_argument(
        "--token-file",
        default=os.environ.get("MUXDECK_CALLBACK_TOKEN_FILE", DEFAULT_TOKEN_FILE),
    )
    post = commands.add_parser(
        "post", parents=[common], help="post a completion message"
    )
    post.add_argument(
        "--agent",
        required=True,
        help="explicit agent type: codex, claude, cursor, grok, etc.",
    )
    post.add_argument(
        "--message-file",
        default="-",
        help="UTF-8 message file; default '-' reads stdin",
    )
    post.add_argument("--session", help="verified tmux session name override")
    post.add_argument("--cwd", help="verified absolute working directory override")
    post.add_argument(
        "--request-id", help="reuse the UUID from a previous uncertain attempt"
    )
    post.add_argument(
        "--dry-run",
        action="store_true",
        help="print payload without loading credentials or sending",
    )
    listing = commands.add_parser(
        "list", parents=[common], help="fetch callback messages as JSON"
    )
    listing.add_argument(
        "--status", choices=("pending", "reviewed", "all"), default="pending"
    )
    listing.add_argument(
        "--after", type=pagination_cursor, help="sequence cursor from nextAfter"
    )
    listing.add_argument(
        "--limit", type=int, choices=range(1, 201), default=100, metavar="1..200"
    )
    listing.add_argument(
        "--all-pages", action="store_true", help="fetch all pages into one JSON result"
    )
    review = commands.add_parser(
        "review", parents=[common], help="mark a callback reviewed; keep its history"
    )
    review.add_argument("id", help="callback record ID")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        payload = None
        if args.command == "post":
            try:
                message = (
                    sys.stdin.read()
                    if args.message_file == "-"
                    else Path(args.message_file).read_text(encoding="utf-8")
                )
            except (OSError, UnicodeError) as exc:
                raise CallbackError(
                    "Cannot read the UTF-8 callback message file."
                ) from exc
            payload = build_payload(args, message)
            if args.dry_run:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
                return 0
            print("Callback requestId: " + payload["requestId"], file=sys.stderr)
        client = Client(args.url, read_token(args.token_file))
        if args.command == "post":
            result = client.request("POST", payload=payload)
            validate_receipt(result, request_id=payload["requestId"])
        elif args.command == "list":
            result = list_messages(client, args)
        else:
            if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.id):
                raise CallbackError("Invalid callback ID.")
            result = client.request("POST", "/" + args.id + "/review", {})
            validate_receipt(result, reviewed_id=args.id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except CallbackError as exc:
        print("Callback error: " + str(exc), file=sys.stderr)
        if args.command == "post" and payload is not None and not args.dry_run:
            print(
                "If receipt is uncertain, retry the same message with --request-id "
                + payload["requestId"],
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
