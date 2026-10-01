"""Authenticated, fenced Multica HTTP adapter. No automatic network retries."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from tmux_console.control_cli import is_loopback_url

from .config import private_read


class MulticaError(RuntimeError):
    def __init__(
        self, message: str, *, uncertain: bool = False, status: int | None = None
    ):
        self.uncertain = uncertain
        self.status = status
        super().__init__(message)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


class MulticaClient:
    def __init__(
        self,
        url: str,
        token_file: Path | None = None,
        *,
        token: str | None = None,
        workspace_id: str | None = None,
        generation: int | None = None,
        timeout: float = 10,
    ):
        parts = urlsplit(url)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or parts.path not in {"", "/"}
            or any(char.isspace() for char in url)
        ):
            raise MulticaError("Multica URL must be an HTTP(S) origin")
        if parts.scheme == "http" and not is_loopback_url(url):
            raise MulticaError("unencrypted Multica HTTP requires loopback")
        if not math.isfinite(timeout) or timeout <= 0:
            raise MulticaError("HTTP timeout must be positive and finite")
        self.url, self.token_file, self.token = url.rstrip("/"), token_file, token
        self.workspace_id, self.generation, self.timeout = (
            workspace_id,
            generation,
            timeout,
        )
        self.opener = build_opener(ProxyHandler({}), _NoRedirect())

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> Any:
        if (
            not path.startswith("/api/")
            or urlsplit(path).netloc
            or ".." in path.split("/")
            or any(ord(char) < 33 for char in path)
        ):
            raise MulticaError("invalid relative API path")
        token = self.token or (
            private_read(self.token_file, maximum=4096).strip()
            if self.token_file
            else None
        )
        headers = {"Accept": "application/json"}
        if token:
            if any(ord(char) < 33 or ord(char) > 126 for char in token):
                raise MulticaError("invalid private Multica credential")
            headers["Authorization"] = "Bearer " + token
        if self.workspace_id:
            headers["X-Workspace-ID"] = self.workspace_id
        if self.generation is not None:
            headers["X-Muxpilot-Generation"] = str(self.generation)
        data = (
            json.dumps(payload, allow_nan=False).encode()
            if payload is not None
            else None
        )
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            with self.opener.open(
                Request(self.url + path, data=data, headers=headers, method=method),
                timeout=self.timeout,
            ) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if response.status == 204:
                    return {}
        except HTTPError as error:
            status = error.code
            error.close()
            raise MulticaError(
                f"Multica HTTP {status}; response body omitted",
                uncertain=status >= 500,
                status=status,
            ) from error
        except (URLError, OSError, TimeoutError) as error:
            raise MulticaError(
                "Multica unavailable; mutation outcome may be uncertain", uncertain=True
            ) from error
        if len(raw) > 16 * 1024 * 1024:
            raise MulticaError(
                "Multica response exceeds size limit", uncertain=method != "GET"
            )
        try:
            return json.loads(raw)
        except (UnicodeError, ValueError) as error:
            raise MulticaError(
                "Multica response is not JSON", uncertain=method != "GET"
            ) from error

    def capabilities(self) -> dict[str, Any]:
        result = self.request("GET", "/api/muxpilot/capabilities")
        required = {
            "coordinator-fence-v1",
            "operation-receipts-v1",
            "staged-dispatch-v1",
            "durable-events-v1",
            "exact-run-control-v1",
            "task-terminal-links-v1",
        }
        if (
            not isinstance(result, dict)
            or result.get("protocol") != "muxpilot-v1"
            or not required.issubset(set(result.get("capabilities", [])))
        ):
            raise MulticaError("incompatible Multica Muxpilot capability schema")
        return result

    def lease(
        self,
        project_id: str,
        operation_id: str,
        *,
        expected_generation: int | None,
        worker_limit: int,
        runtime_profile_id: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "operation_id": operation_id,
            "expected_generation": expected_generation,
            "worker_limit": worker_limit,
        }
        if runtime_profile_id:
            payload["runtime_profile_id"] = runtime_profile_id
        return self.request("POST", self.project_path(project_id) + "/lease", payload)  # type: ignore[no-any-return]

    @staticmethod
    def project_path(project_id: str) -> str:
        import uuid

        identifier = str(uuid.UUID(project_id))
        return "/api/muxpilot/projects/" + quote(identifier, safe="")

    def command(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request(
            "POST", self.project_path(project_id) + "/commands", payload
        )  # type: ignore[no-any-return]

    def snapshot(self, project_id: str) -> dict[str, Any]:
        return self.request("GET", self.project_path(project_id) + "/snapshot")  # type: ignore[no-any-return]

    def events(self, project_id: str, after: int) -> dict[str, Any]:
        return self.request(
            "GET",
            self.project_path(project_id)
            + "/events?"
            + urlencode({"after": after, "limit": 100}),
        )  # type: ignore[no-any-return]

    def operation(self, project_id: str, operation_id: str) -> dict[str, Any]:
        return self.request(
            "GET",
            self.project_path(project_id)
            + "/operations/"
            + quote(operation_id, safe=""),
        )  # type: ignore[no-any-return]
