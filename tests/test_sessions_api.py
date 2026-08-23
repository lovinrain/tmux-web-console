from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Literal
from urllib.parse import quote

import pytest
from aiohttp import ClientResponse
from aiohttp.test_utils import TestClient, TestServer

from tmux_console import app as app_module
from tmux_console.app import (
    SESSION_RENAME_LOCK_KEY,
    SESSION_SNAPSHOTS_KEY,
    SESSION_STREAM_BROKER_KEY,
    SessionSnapshotBuilder,
    create_app,
)
from tmux_console.messages import SessionMessageStore
from tmux_console.metadata import SessionTitleStore
from tmux_console.status import AgentState, AgentStateDetector
from tmux_console.tmux import (
    CreatedSession,
    Session,
    TmuxClient,
    TmuxError,
    TmuxRenameUnverifiedError,
    TmuxSessionIdentityChangedError,
    TmuxSessionNotFoundError,
)
from tmux_console.workspaces import WorkspaceStore

SESSION_CREATED = 1_700_000_000
SERVER_STARTED = 1_699_999_900
SERVER_PID = 4242


def termination_payload(
    session_id: object = "$1",
    session_created: object = SESSION_CREATED,
    server_started: object = SERVER_STARTED,
    server_pid: object = SERVER_PID,
) -> dict[str, object]:
    return {
        "sessionId": session_id,
        "sessionCreated": session_created,
        "serverStarted": server_started,
        "serverPid": server_pid,
    }


def make_session(name: str = "agent-one") -> Session:
    return Session(
        name=name,
        id="$1",
        windows=1,
        attached=0,
        created=SESSION_CREATED,
        server_started=SERVER_STARTED,
        server_pid=SERVER_PID,
        activity=1_700_000_100,
    )


def make_recreated_session(name: str = "agent-one") -> Session:
    session = make_session(name)
    session.id = "$2"
    return session


class FakeTmux(TmuxClient):
    def __init__(
        self, snapshots: list[list[Session] | TmuxError], delay: float = 0
    ) -> None:
        self._snapshots = iter(snapshots)
        self._last_snapshot: list[Session] = []
        self._delay = delay
        self.list_calls = 0
        self.active_calls = 0
        self.max_active_calls = 0

    async def list_sessions(self) -> list[Session]:
        self.list_calls += 1
        self.active_calls += 1
        self.max_active_calls = max(self.max_active_calls, self.active_calls)
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
            try:
                snapshot = next(self._snapshots)
            except StopIteration:
                pass
            else:
                if isinstance(snapshot, TmuxError):
                    raise snapshot
                self._last_snapshot = snapshot
            return list(self._last_snapshot)
        finally:
            self.active_calls -= 1


class CreatingFakeTmux(FakeTmux):
    def __init__(self, result: CreatedSession | TmuxError) -> None:
        super().__init__([[]])
        self.result = result
        self.create_calls: list[str | None] = []
        self.create_theme_calls: list[str | None] = []

    async def create_session(
        self, requested_name: str | None = None, theme: str | None = None
    ) -> CreatedSession:
        self.create_calls.append(requested_name)
        self.create_theme_calls.append(theme)
        if isinstance(self.result, TmuxError):
            raise self.result
        return self.result


class CopyingFakeTmux(FakeTmux):
    def __init__(self, result: CreatedSession | Exception) -> None:
        super().__init__([[]])
        self.result = result
        self.copy_calls: list[tuple[str, str, str | None]] = []

    async def copy_session(
        self,
        source_name: str,
        source_id: str,
        theme: str | None = None,
    ) -> CreatedSession:
        self.copy_calls.append((source_name, source_id, theme))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class TerminatingFakeTmux(FakeTmux):
    def __init__(
        self,
        sessions: list[Session] | TmuxError,
        result: TmuxError | None = None,
    ) -> None:
        super().__init__([sessions])
        self.result = result
        self.terminate_calls: list[tuple[str, int, int, int]] = []

    async def terminate_session(
        self,
        session_id: str,
        session_created: int,
        server_started: int,
        server_pid: int,
    ) -> None:
        self.terminate_calls.append(
            (session_id, session_created, server_started, server_pid)
        )
        if self.result is not None:
            raise self.result


class RenamingFakeTmux(FakeTmux):
    def __init__(
        self,
        sessions: list[Session] | TmuxError,
        result: str | TmuxError | None = None,
    ) -> None:
        super().__init__([sessions])
        self.result = result
        self.rename_calls: list[tuple[str, str]] = []
        self.rename_session_ids: list[str | None] = []

    async def rename_session(
        self,
        current_name: str,
        new_name: str,
        *,
        session_id: str | None = None,
    ) -> str:
        self.rename_calls.append((current_name, new_name))
        self.rename_session_ids.append(session_id)
        if isinstance(self.result, TmuxError):
            raise self.result
        return self.result or new_name


class ObservableLock(asyncio.Lock):
    def __init__(self) -> None:
        super().__init__()
        self.waiting = asyncio.Event()

    async def acquire(self) -> Literal[True]:
        if self.locked():
            self.waiting.set()
        return await super().acquire()


class OverlappingRenamingFakeTmux(TmuxClient):
    def __init__(self, sessions: list[Session]) -> None:
        self._sessions = {session.name: session for session in sessions}
        self.list_calls = 0
        self.rename_calls: list[tuple[str, str]] = []
        self.first_tmux_mutated = asyncio.Event()
        self.release_first_rename = asyncio.Event()

    async def list_sessions(self) -> list[Session]:
        self.list_calls += 1
        return list(self._sessions.values())

    async def rename_session(
        self,
        current_name: str,
        new_name: str,
        *,
        session_id: str | None = None,
    ) -> str:
        del session_id
        self.rename_calls.append((current_name, new_name))
        if current_name not in self._sessions:
            raise TmuxError(f"tmux session not found: {current_name}")
        if new_name in self._sessions:
            raise TmuxError(f"duplicate session: {new_name}")

        session = self._sessions.pop(current_name)
        session.name = new_name
        self._sessions[new_name] = session
        if current_name == "A":
            self.first_tmux_mutated.set()
            await self.release_first_rename.wait()
        return new_name


class FakeAgentStateDetector(AgentStateDetector):
    def __init__(self, snapshots: list[dict[str, AgentState]]) -> None:
        self._snapshots = iter(snapshots)
        self._last_snapshot: dict[str, AgentState] = {}

    async def detect_sessions(
        self, tmux: TmuxClient, sessions: list[Session]
    ) -> dict[str, AgentState]:
        del tmux
        try:
            self._last_snapshot = next(self._snapshots)
        except StopIteration:
            pass
        return {session.name: self._last_snapshot[session.name] for session in sessions}


def sequence_clock(*values: float) -> Callable[[], float]:
    iterator = iter(values)
    return lambda: next(iterator)


async def read_sse_record(response: ClientResponse) -> str:
    record = await asyncio.wait_for(response.content.readuntil(b"\n\n"), timeout=1)
    return record.decode("utf-8")


async def wait_until(predicate: Callable[[], bool], timeout: float = 1) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition was not met before timeout")
        await asyncio.sleep(0.005)


def event_payload(record: str) -> dict:
    lines = record.rstrip().splitlines()
    assert lines[0] == "event: sessions"
    assert lines[1].startswith("data: ")
    return json.loads(lines[1].removeprefix("data: "))


@pytest.mark.asyncio
async def test_create_session_api_returns_created_native_name():
    tmux = CreatingFakeTmux(CreatedSession("muxdeck-abc123def456", "$12"))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post("/api/sessions", json={})

        assert response.status == 201
        assert await response.json() == {
            "session": "muxdeck-abc123def456",
            "sessionId": "$12",
        }
        assert tmux.create_calls == [None]
        assert tmux.create_theme_calls == [None]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_create_session_api_preserves_a_requested_native_name():
    requested_name = "  work/name #1  "
    tmux = CreatingFakeTmux(CreatedSession(requested_name, "$13"))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post("/api/sessions", json={"name": requested_name})

        assert response.status == 201
        assert await response.json() == {
            "session": requested_name,
            "sessionId": "$13",
        }
        assert tmux.create_calls == [requested_name]
        assert tmux.create_theme_calls == [None]
    finally:
        await client.close()


@pytest.mark.parametrize(("theme", "session_id"), [("dark", "$14"), ("light", "$15")])
@pytest.mark.asyncio
async def test_create_session_api_passes_the_requested_theme(
    theme: str, session_id: str
):
    tmux = CreatingFakeTmux(CreatedSession("themed-work", session_id))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post(
            "/api/sessions", json={"name": "themed-work", "theme": theme}
        )

        assert response.status == 201
        assert await response.json() == {
            "session": "themed-work",
            "sessionId": session_id,
        }
        assert tmux.create_calls == ["themed-work"]
        assert tmux.create_theme_calls == [theme]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_create_session_api_rejects_invalid_bodies_and_fields():
    tmux = CreatingFakeTmux(CreatedSession("unused", "$14"))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()

        malformed = await client.post(
            "/api/sessions",
            data="{",
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status == 400
        assert await malformed.json() == {"error": "request body must be JSON"}

        non_object = await client.post("/api/sessions", json=[])
        assert non_object.status == 400
        assert await non_object.json() == {"error": "request body must be an object"}

        unknown = await client.post(
            "/api/sessions", json={"name": "work", "launch": "shell"}
        )
        assert unknown.status == 400
        assert await unknown.json() == {"error": "unknown field: launch"}

        for value in (None, 7, True, []):
            wrong_type = await client.post("/api/sessions", json={"name": value})
            assert wrong_type.status == 400
            assert await wrong_type.json() == {"error": "name must be a string"}

        for value in (None, 7, True, []):
            wrong_type = await client.post("/api/sessions", json={"theme": value})
            assert wrong_type.status == 400
            assert await wrong_type.json() == {"error": "theme must be a string"}

        for theme in ("", "auto", "Dark", "groknight"):
            invalid_theme = await client.post("/api/sessions", json={"theme": theme})
            assert invalid_theme.status == 400
            assert await invalid_theme.json() == {
                "error": "theme must be dark or light"
            }

        invalid_names = {
            "": "session name is required",
            "   ": "session name is required",
            "bad:name": "session name cannot contain ':' or '.'",
            "bad.name": "session name cannot contain ':' or '.'",
            "bad\\name": "session name cannot contain '\\'",
            "bad;": "session name cannot end with ';'",
            "line\nbreak": "session name cannot contain control characters",
            "left\u2028right": "session name cannot contain Unicode line separators",
            "\ud800": "session name contains invalid Unicode",
            "x" * 257: "session name must be 256 characters or fewer",
        }
        for name, message in invalid_names.items():
            invalid = await client.post("/api/sessions", json={"name": name})
            assert invalid.status == 400
            assert await invalid.json() == {"error": message}

        assert tmux.create_calls == []
        assert tmux.create_theme_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_create_session_api_reports_tmux_failures_as_unavailable():
    tmux = CreatingFakeTmux(TmuxError("permission denied", returncode=1))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post("/api/sessions", json={})

        assert response.status == 503
        assert await response.json() == {"error": "permission denied"}
        assert tmux.create_calls == [None]
        assert tmux.create_theme_calls == [None]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_create_session_api_reports_an_atomic_name_conflict():
    tmux = CreatingFakeTmux(TmuxError("duplicate session: existing", returncode=1))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post("/api/sessions", json={"name": "existing"})

        assert response.status == 409
        assert await response.json() == {"error": "duplicate session: existing"}
        assert tmux.create_calls == ["existing"]
        assert tmux.create_theme_calls == [None]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_copy_session_api_preserves_the_source_identity_and_theme():
    source_name = "work/name #1"
    tmux = CopyingFakeTmux(CreatedSession(f"{source_name}_2", "$18"))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post(
            f"/api/sessions/{quote(source_name, safe='')}/copy",
            json={"sessionId": "$7", "theme": "light"},
        )

        assert response.status == 201
        assert await response.json() == {
            "session": f"{source_name}_2",
            "sessionId": "$18",
        }
        assert tmux.copy_calls == [(source_name, "$7", "light")]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_copy_session_api_rejects_invalid_bodies_without_calling_tmux():
    tmux = CopyingFakeTmux(CreatedSession("unused_1", "$18"))
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        malformed = await client.post(
            "/api/sessions/work/copy",
            data="{",
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status == 400
        assert await malformed.json() == {"error": "request body must be JSON"}

        for body, message in [
            ([], "request body must be an object"),
            ({}, "sessionId is required"),
            ({"sessionId": 7}, "sessionId must be a string"),
            ({"sessionId": "7"}, "invalid tmux session id"),
            ({"sessionId": "$7", "theme": "auto"}, "theme must be dark or light"),
            ({"sessionId": "$7", "extra": True}, "unknown field: extra"),
        ]:
            response = await client.post("/api/sessions/work/copy", json=body)
            assert response.status == 400
            assert await response.json() == {"error": message}

        assert tmux.copy_calls == []
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (TmuxSessionNotFoundError("tmux session not found: work"), 404),
        (
            TmuxSessionIdentityChangedError("tmux session identity changed"),
            409,
        ),
        (TmuxError("permission denied", returncode=1), 503),
    ],
)
@pytest.mark.asyncio
async def test_copy_session_api_maps_tmux_failures(error: Exception, status: int):
    tmux = CopyingFakeTmux(error)
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.post(
            "/api/sessions/work/copy",
            json={"sessionId": "$7"},
        )

        assert response.status == status
        assert await response.json() == {"error": str(error)}
        assert tmux.copy_calls == [("work", "$7", None)]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_uses_the_exact_stable_id():
    session_name = "agent one"
    tmux = TerminatingFakeTmux([make_session(session_name)])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            f"/api/sessions/{quote(session_name, safe='')}",
            json=termination_payload(),
        )

        assert response.status == 204
        assert await response.read() == b""
        assert tmux.terminate_calls == [
            ("$1", SESSION_CREATED, SERVER_STARTED, SERVER_PID)
        ]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_validates_the_exact_payload_and_path():
    tmux = TerminatingFakeTmux([make_session("agent-one")])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        malformed = await client.delete(
            "/api/sessions/agent-one",
            data="{",
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status == 400
        assert await malformed.json() == {"error": "request body must be JSON"}

        invalid_payloads = [
            ([], "request body must be an object"),
            ({}, "sessionId is required"),
            ({"sessionId": "$1"}, "sessionCreated is required"),
            (
                {"sessionId": "$1", "sessionCreated": SESSION_CREATED},
                "serverStarted is required",
            ),
            (
                {
                    "sessionId": "$1",
                    "sessionCreated": SESSION_CREATED,
                    "serverStarted": SERVER_STARTED,
                },
                "serverPid is required",
            ),
            (
                {
                    **termination_payload(),
                    "force": True,
                },
                "unknown field: force",
            ),
            (
                termination_payload(session_id=1),
                "sessionId must be a string",
            ),
        ]
        for payload, message in invalid_payloads:
            response = await client.delete(
                "/api/sessions/agent-one", json=payload
            )
            assert response.status == 400
            assert await response.json() == {"error": message}

        for session_id in ("", "7", "$", "$7x", " $$7"):
            response = await client.delete(
                "/api/sessions/agent-one",
                json=termination_payload(session_id=session_id),
            )
            assert response.status == 400
            assert await response.json() == {"error": "invalid tmux session id"}

        for session_created in (None, True, 0, -1, 1.5, "1700000000"):
            response = await client.delete(
                "/api/sessions/agent-one",
                json=termination_payload(session_created=session_created),
            )
            assert response.status == 400
            assert await response.json() == {
                "error": "sessionCreated must be a positive integer"
            }

        for server_started in (None, True, 0, -1, 1.5, "1699999900"):
            response = await client.delete(
                "/api/sessions/agent-one",
                json=termination_payload(server_started=server_started),
            )
            assert response.status == 400
            assert await response.json() == {
                "error": "serverStarted must be a positive integer"
            }

        for server_pid in (None, True, 0, -1, 1.5, "4242"):
            response = await client.delete(
                "/api/sessions/agent-one",
                json=termination_payload(server_pid=server_pid),
            )
            assert response.status == 400
            assert await response.json() == {
                "error": "serverPid must be a positive integer"
            }

        invalid_path = await client.delete(
            "/api/sessions/invalid.name",
            json=termination_payload(),
        )
        assert invalid_path.status == 400
        assert await invalid_path.json() == {
            "error": "session name cannot contain ':' or '.'"
        }
        assert tmux.terminate_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_accepts_an_already_absent_target():
    tmux = TerminatingFakeTmux([make_recreated_session("other")])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/missing",
            json=termination_payload(),
        )

        assert response.status == 204
        assert await response.read() == b""
        assert tmux.terminate_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_rejects_the_exact_identity_under_a_new_name():
    tmux = TerminatingFakeTmux([make_session("renamed-agent")])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/old-name",
            json=termination_payload(),
        )

        assert response.status == 409
        assert await response.json() == {
            "error": "tmux session identity changed; refresh before terminating it"
        }
        assert tmux.terminate_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_rejects_a_recreated_same_name_session():
    tmux = TerminatingFakeTmux([make_recreated_session("agent-one")])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/agent-one",
            json=termination_payload(),
        )

        assert response.status == 409
        assert await response.json() == {
            "error": (
                "tmux session identity changed; refresh before terminating it"
            )
        }
        assert tmux.terminate_calls == []
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("created", SESSION_CREATED + 1),
        ("server_started", SERVER_STARTED + 1),
        ("server_pid", SERVER_PID + 1),
    ],
)
@pytest.mark.asyncio
async def test_terminate_session_api_rejects_each_reused_identity_component(
    field: str,
    replacement: int,
):
    recreated = make_session("agent-one")
    setattr(recreated, field, replacement)
    tmux = TerminatingFakeTmux([recreated])
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/agent-one",
            json=termination_payload(),
        )

        assert response.status == 409
        assert await response.json() == {
            "error": "tmux session identity changed; refresh before terminating it"
        }
        assert tmux.terminate_calls == []
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("sessions", "terminate_error", "message", "expected_calls"),
    [
        (TmuxError("inventory unavailable"), None, "inventory unavailable", []),
        (
            [make_session("agent-one")],
            TmuxError("kill denied", returncode=1),
            "kill denied",
            [("$1", SESSION_CREATED, SERVER_STARTED, SERVER_PID)],
        ),
    ],
)
@pytest.mark.asyncio
async def test_terminate_session_api_reports_tmux_failures_as_unavailable(
    sessions: list[Session] | TmuxError,
    terminate_error: TmuxError | None,
    message: str,
    expected_calls: list[tuple[str, int, int, int]],
):
    tmux = TerminatingFakeTmux(sessions, terminate_error)
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/agent-one", json=termination_payload()
        )

        assert response.status == 503
        assert await response.json() == {"error": message}
        assert tmux.terminate_calls == expected_calls
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_terminate_session_api_reports_an_atomic_identity_race_as_conflict():
    tmux = TerminatingFakeTmux(
        [make_session("agent-one")],
        TmuxSessionIdentityChangedError(
            "tmux session identity changed; refresh before terminating it"
        ),
    )
    client = TestClient(TestServer(create_app(tmux=tmux, base_path="")))

    try:
        await client.start_server()
        response = await client.delete(
            "/api/sessions/agent-one",
            json=termination_payload(),
        )

        assert response.status == 409
        assert await response.json() == {
            "error": "tmux session identity changed; refresh before terminating it"
        }
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("starred", "ignored"),
    [(True, False), (False, True)],
)
@pytest.mark.asyncio
async def test_terminate_session_api_preserves_persistent_session_state(
    tmp_path, starred: bool, ignored: bool
):
    session_name = "agent-one"
    tmux = TerminatingFakeTmux([make_session(session_name)])
    titles_path = tmp_path / "titles.json"
    messages_path = tmp_path / "messages.json"
    workspaces_path = tmp_path / "workspaces.json"
    titles = SessionTitleStore(titles_path)
    messages = SessionMessageStore(
        messages_path,
        clock=lambda: 1_700_000_000,
        id_factory=lambda: "message-id",
    )
    workspaces = WorkspaceStore(
        workspaces_path,
        clock=lambda: 1_700_000_000,
        id_factory=lambda: "workspace-id",
    )
    titles.set_title(session_name, "Human alias")
    titles.set_starred(session_name, starred)
    titles.set_ignored(session_name, ignored)
    titles.set_tags(session_name, ["work", "background"])
    memo = messages.add_message(session_name, "Keep this scratch", state="note")
    workspace = workspaces.create_workspace(
        name="Release room",
        tabs=[session_name],
        active_session=session_name,
    )
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                messages=messages,
                workspaces=workspaces,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.delete(
            f"/api/sessions/{session_name}", json=termination_payload()
        )

        assert response.status == 204
        reloaded_titles = SessionTitleStore(titles_path)
        assert reloaded_titles.get_title(session_name) == "Human alias"
        assert reloaded_titles.is_starred(session_name) is starred
        assert reloaded_titles.is_ignored(session_name) is ignored
        assert reloaded_titles.get_tags(session_name) == ["work", "background"]
        assert SessionMessageStore(messages_path).list_messages(session_name) == [memo]
        assert WorkspaceStore(workspaces_path).get_workspace("workspace-id") == workspace
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_renames_tmux_and_migrates_persistent_state(tmp_path):
    old_name = "agent-old"
    new_name = "agent-new"
    tmux = RenamingFakeTmux([make_session(old_name)])
    titles_path = tmp_path / "titles.json"
    messages_path = tmp_path / "messages.json"
    workspaces_path = tmp_path / "workspaces.json"
    titles = SessionTitleStore(titles_path)
    messages = SessionMessageStore(messages_path, id_factory=lambda: "message-id")
    titles.set_title(old_name, "Human alias")
    titles.set_ignored(old_name, True)
    titles.set_tags(old_name, ["work", "urgent"])
    titles.set_title(new_name, "Stale alias")
    titles.set_starred(new_name, True)
    titles.set_tags(new_name, ["blocked"])
    old_message = messages.add_message(old_name, "Continue the task")
    messages.add_message(new_name, "Stale queue")
    workspaces = WorkspaceStore(
        workspaces_path,
        clock=lambda: 1_700_000_000,
        id_factory=lambda: "workspace-id",
    )
    saved_workspace = workspaces.create_workspace(
        name="Project",
        tabs=[old_name, "other", new_name],
        groups=[
            {
                "id": "primary",
                "name": "Primary",
                "color": "blue",
                "collapsed": False,
                "tabs": [old_name, "other"],
            }
        ],
        active_session=old_name,
    )
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                messages=messages,
                workspaces=workspaces,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name", json={"session": old_name, "name": new_name}
        )

        assert response.status == 200
        assert await response.json() == {
            "previousSession": old_name,
            "session": new_name,
        }
        assert tmux.rename_calls == [(old_name, new_name)]
        assert tmux.rename_session_ids == ["$1"]

        reloaded_titles = SessionTitleStore(titles_path)
        assert reloaded_titles.get_title(old_name) is None
        assert reloaded_titles.is_ignored(old_name) is False
        assert reloaded_titles.get_title(new_name) == "Human alias"
        assert reloaded_titles.is_ignored(new_name) is True
        assert reloaded_titles.is_starred(new_name) is False
        assert reloaded_titles.get_tags(old_name) == []
        assert reloaded_titles.get_tags(new_name) == ["work", "urgent"]
        reloaded_messages = SessionMessageStore(messages_path)
        assert reloaded_messages.list_messages(old_name) == []
        assert reloaded_messages.list_messages(new_name) == [old_message]
        reloaded_workspace = WorkspaceStore(workspaces_path).get_workspace(
            "workspace-id"
        )
        assert reloaded_workspace["tabs"] == [new_name, "other"]
        assert reloaded_workspace["groups"] == [
            {
                "id": "primary",
                "name": "Primary",
                "color": "blue",
                "collapsed": False,
                "tabs": [new_name, "other"],
            }
        ]
        assert reloaded_workspace["activeSession"] == new_name
        assert reloaded_workspace["lastActiveAt"] == saved_workspace["lastActiveAt"]
        assert reloaded_workspace["updatedAt"] > saved_workspace["updatedAt"]
        assert reloaded_workspace["sessionRevision"] == 1

        stale_activity = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": [old_name, "other"],
                "activeSession": old_name,
                "sessionRevision": saved_workspace["sessionRevision"],
            },
        )
        assert stale_activity.status == 409
        assert "reload the workspace" in (await stale_activity.json())["error"]
        assert workspaces.get_workspace("workspace-id") == reloaded_workspace

        current_activity = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": [new_name, "ended-but-preserved"],
                "activeSession": "ended-but-preserved",
                "sessionRevision": reloaded_workspace["sessionRevision"],
            },
        )
        assert current_activity.status == 200
        current_workspace = (await current_activity.json())["workspace"]
        assert current_workspace["tabs"] == [new_name, "ended-but-preserved"]
        assert current_workspace["groups"][0]["tabs"] == [new_name]
        assert current_workspace["activeSession"] == "ended-but-preserved"
        assert current_workspace["sessionRevision"] == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_invalidates_a_stale_removed_tab_snapshot(tmp_path):
    old_name = "agent-old"
    new_name = "agent-new"
    workspaces = WorkspaceStore(
        tmp_path / "workspaces.json",
        clock=lambda: 1_700_000_000,
        id_factory=lambda: "workspace-id",
    )
    created = workspaces.create_workspace(
        name="Project",
        tabs=[old_name, "keep"],
        active_session=old_name,
    )
    current_before_rename = workspaces.record_activity(
        "workspace-id",
        tabs=["keep"],
        active_session="keep",
        session_revision=created["sessionRevision"],
    )
    client = TestClient(
        TestServer(
            create_app(
                tmux=RenamingFakeTmux([make_session(old_name)]),
                workspaces=workspaces,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        renamed = await client.put(
            "/api/session-name", json={"session": old_name, "name": new_name}
        )
        assert renamed.status == 200
        after_rename = workspaces.get_workspace("workspace-id")
        assert after_rename["tabs"] == ["keep"]
        assert after_rename["sessionRevision"] == 1

        stale_activity = await client.post(
            "/api/workspaces/workspace-id/activity",
            json={
                "tabs": [old_name, "keep"],
                "activeSession": old_name,
                "sessionRevision": current_before_rename["sessionRevision"],
            },
        )
        assert stale_activity.status == 409
        assert workspaces.get_workspace("workspace-id") == after_rename
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_uses_the_verified_native_result(tmp_path):
    old_name = "agent-old"
    actual_name = "tmux-result"
    tmux = RenamingFakeTmux([make_session(old_name)], result=actual_name)
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_title(old_name, "Human alias")
    client = TestClient(TestServer(create_app(tmux=tmux, titles=titles, base_path="")))

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name",
            json={"session": old_name, "name": "requested-name"},
        )

        assert response.status == 200
        assert await response.json() == {
            "previousSession": old_name,
            "session": actual_name,
            "warnings": ["tmux returned a different session name than requested"],
        }
        assert titles.get_title(old_name) is None
        assert titles.get_title(actual_name) == "Human alias"
        assert tmux.rename_session_ids == ["$1"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_migrates_state_when_verification_fails(tmp_path):
    old_name = "agent-old"
    new_name = "agent-new"
    verification_error = TmuxError("verification timed out")
    tmux = RenamingFakeTmux(
        [make_session(old_name)],
        result=TmuxRenameUnverifiedError(new_name, verification_error),
    )
    titles_path = tmp_path / "titles.json"
    messages_path = tmp_path / "messages.json"
    titles = SessionTitleStore(titles_path)
    titles.set_title(old_name, "Human alias")
    titles.set_ignored(old_name, True)
    messages = SessionMessageStore(messages_path, id_factory=lambda: "message-id")
    queued_message = messages.add_message(old_name, "Keep moving")
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                messages=messages,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name", json={"session": old_name, "name": new_name}
        )

        assert response.status == 200
        assert await response.json() == {
            "previousSession": old_name,
            "session": new_name,
            "warnings": [
                "tmux rename succeeded but its final session name could not be verified"
            ],
        }
        assert tmux.rename_session_ids == ["$1"]

        reloaded_titles = SessionTitleStore(titles_path)
        assert reloaded_titles.get_title(old_name) is None
        assert reloaded_titles.is_ignored(old_name) is False
        assert reloaded_titles.get_title(new_name) == "Human alias"
        assert reloaded_titles.is_ignored(new_name) is True
        reloaded_messages = SessionMessageStore(messages_path)
        assert reloaded_messages.list_messages(old_name) == []
        assert reloaded_messages.list_messages(new_name) == [queued_message]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_overlapping_session_renames_keep_each_sessions_persistent_state(tmp_path):
    session_a = make_session("A")
    session_c = make_recreated_session("C")
    tmux = OverlappingRenamingFakeTmux([session_a, session_c])
    titles_path = tmp_path / "titles.json"
    messages_path = tmp_path / "messages.json"
    titles = SessionTitleStore(titles_path)
    titles.set_title("A", "Alias A")
    titles.set_starred("A", True)
    titles.set_title("C", "Alias C")
    titles.set_ignored("C", True)
    message_ids = iter(("message-a", "message-c"))
    messages = SessionMessageStore(
        messages_path, id_factory=lambda: next(message_ids)
    )
    message_a = messages.add_message("A", "Prompt A")
    message_c = messages.add_message("C", "Prompt C")
    application = create_app(
        tmux=tmux,
        titles=titles,
        messages=messages,
        base_path="",
    )
    rename_lock = ObservableLock()
    application[SESSION_RENAME_LOCK_KEY] = rename_lock
    client = TestClient(TestServer(application))
    first_request: asyncio.Task[ClientResponse] | None = None
    second_request: asyncio.Task[ClientResponse] | None = None

    try:
        await client.start_server()
        first_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "A", "name": "B"})
        )
        await asyncio.wait_for(tmux.first_tmux_mutated.wait(), timeout=1)

        second_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "C", "name": "A"})
        )
        await asyncio.wait_for(rename_lock.waiting.wait(), timeout=1)

        # C -> A cannot preflight against tmux until A -> B finishes migrating.
        assert tmux.list_calls == 1
        assert tmux.rename_calls == [("A", "B")]
        tmux.release_first_rename.set()

        first_response, second_response = await asyncio.gather(
            first_request, second_request
        )
        assert first_response.status == 200
        assert await first_response.json() == {
            "previousSession": "A",
            "session": "B",
        }
        assert second_response.status == 200
        assert await second_response.json() == {
            "previousSession": "C",
            "session": "A",
        }
        assert tmux.rename_calls == [("A", "B"), ("C", "A")]

        reloaded_titles = SessionTitleStore(titles_path)
        assert reloaded_titles.get_title("B") == "Alias A"
        assert reloaded_titles.is_starred("B") is True
        assert reloaded_titles.is_ignored("B") is False
        assert reloaded_titles.get_title("A") == "Alias C"
        assert reloaded_titles.is_ignored("A") is True
        assert reloaded_titles.is_starred("A") is False
        assert reloaded_titles.get_title("C") is None

        reloaded_messages = SessionMessageStore(messages_path)
        assert reloaded_messages.list_messages("B") == [message_a]
        assert reloaded_messages.list_messages("A") == [message_c]
        assert reloaded_messages.list_messages("C") == []
    finally:
        tmux.release_first_rename.set()
        pending_requests = [
            request
            for request in (first_request, second_request)
            if request is not None and not request.done()
        ]
        if pending_requests:
            await asyncio.gather(*pending_requests, return_exceptions=True)
        await client.close()


@pytest.mark.parametrize(
    ("mutation", "endpoint", "payload"),
    [
        (
            "title",
            "/api/session-title",
            {"session": "A", "title": "Stale alias"},
        ),
        (
            "starred",
            "/api/session-star",
            {"session": "A", "starred": False},
        ),
        (
            "ignored",
            "/api/session-ignored",
            {"session": "A", "ignored": False},
        ),
        (
            "tags",
            "/api/session-tags",
            {"session": "A", "tags": ["urgent"]},
        ),
        (
            "details",
            "/api/session-details",
            {"session": "A", "title": "Stale alias", "tags": ["urgent"]},
        ),
    ],
)
@pytest.mark.asyncio
async def test_session_metadata_writes_wait_for_rename_and_reject_stale_name(
    tmp_path, mutation: str, endpoint: str, payload: dict[str, object]
):
    tmux = OverlappingRenamingFakeTmux([make_session("A")])
    titles_path = tmp_path / "titles.json"
    titles = SessionTitleStore(titles_path)
    if mutation == "title":
        titles.set_title("A", "Alias A")
    elif mutation == "starred":
        titles.set_starred("A", True)
    elif mutation == "ignored":
        titles.set_ignored("A", True)
    elif mutation == "details":
        titles.set_details("A", "Alias A", ["work"])
    else:
        titles.set_tags("A", ["work"])

    application = create_app(tmux=tmux, titles=titles, base_path="")
    rename_lock = ObservableLock()
    application[SESSION_RENAME_LOCK_KEY] = rename_lock
    client = TestClient(TestServer(application))
    rename_request: asyncio.Task[ClientResponse] | None = None
    writer_request: asyncio.Task[ClientResponse] | None = None

    try:
        await client.start_server()
        rename_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "A", "name": "B"})
        )
        await asyncio.wait_for(tmux.first_tmux_mutated.wait(), timeout=1)

        writer_request = asyncio.create_task(client.put(endpoint, json=payload))
        await asyncio.wait_for(rename_lock.waiting.wait(), timeout=1)

        # The stale writer cannot touch A while its metadata is still migrating.
        if mutation == "title":
            assert titles.get_title("A") == "Alias A"
        elif mutation == "starred":
            assert titles.is_starred("A") is True
        elif mutation == "ignored":
            assert titles.is_ignored("A") is True
        elif mutation == "details":
            assert titles.get_title("A") == "Alias A"
            assert titles.get_tags("A") == ["work"]
        else:
            assert titles.get_tags("A") == ["work"]
        assert titles.get_title("B") is None
        assert titles.is_starred("B") is False
        assert titles.is_ignored("B") is False
        assert titles.get_tags("B") == []

        tmux.release_first_rename.set()
        rename_response, writer_response = await asyncio.gather(
            rename_request, writer_request
        )

        assert rename_response.status == 200
        assert writer_response.status == 404
        assert await writer_response.json() == {
            "error": "tmux session not found: A"
        }

        reloaded = SessionTitleStore(titles_path)
        assert reloaded.get_title("A") is None
        assert reloaded.is_starred("A") is False
        assert reloaded.is_ignored("A") is False
        if mutation == "title":
            assert reloaded.get_title("B") == "Alias A"
        elif mutation == "starred":
            assert reloaded.is_starred("B") is True
        elif mutation == "ignored":
            assert reloaded.is_ignored("B") is True
        elif mutation == "details":
            assert reloaded.get_title("B") == "Alias A"
            assert reloaded.get_tags("B") == ["work"]
        else:
            assert reloaded.get_tags("B") == ["work"]
    finally:
        tmux.release_first_rename.set()
        pending_requests = [
            request
            for request in (rename_request, writer_request)
            if request is not None and not request.done()
        ]
        if pending_requests:
            await asyncio.gather(*pending_requests, return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
async def test_session_snapshot_waits_for_metadata_migration_during_rename(tmp_path):
    tmux = OverlappingRenamingFakeTmux([make_session("A")])
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_tags("A", ["work", "urgent"])
    application = create_app(
        tmux=tmux,
        titles=titles,
        agent_states=FakeAgentStateDetector(
            [{"B": AgentState("working", "renamed session is active")}]
        ),
        base_path="",
    )
    client = TestClient(TestServer(application))
    rename_request: asyncio.Task[ClientResponse] | None = None
    snapshot_request: asyncio.Task[ClientResponse] | None = None

    try:
        await client.start_server()
        rename_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "A", "name": "B"})
        )
        await asyncio.wait_for(tmux.first_tmux_mutated.wait(), timeout=1)

        snapshot_request = asyncio.create_task(client.get("/api/sessions"))
        await asyncio.sleep(0.01)
        assert snapshot_request.done() is False

        tmux.release_first_rename.set()
        rename_response, snapshot_response = await asyncio.gather(
            rename_request, snapshot_request
        )

        assert rename_response.status == 200
        assert snapshot_response.status == 200
        snapshot = await snapshot_response.json()
        assert snapshot["sessions"][0]["name"] == "B"
        assert snapshot["sessions"][0]["tags"] == ["work", "urgent"]
    finally:
        tmux.release_first_rename.set()
        pending_requests = [
            request
            for request in (rename_request, snapshot_request)
            if request is not None and not request.done()
        ]
        if pending_requests:
            await asyncio.gather(*pending_requests, return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
async def test_new_name_metadata_write_waits_until_rename_migration_finishes(tmp_path):
    tmux = OverlappingRenamingFakeTmux([make_session("A")])
    titles_path = tmp_path / "titles.json"
    titles = SessionTitleStore(titles_path)
    titles.set_title("A", "Alias A")
    application = create_app(
        tmux=tmux,
        titles=titles,
        messages=SessionMessageStore(tmp_path / "messages.json"),
        base_path="",
    )
    rename_lock = ObservableLock()
    application[SESSION_RENAME_LOCK_KEY] = rename_lock
    client = TestClient(TestServer(application))
    rename_request: asyncio.Task[ClientResponse] | None = None
    writer_request: asyncio.Task[ClientResponse] | None = None

    try:
        await client.start_server()
        rename_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "A", "name": "B"})
        )
        await asyncio.wait_for(tmux.first_tmux_mutated.wait(), timeout=1)

        writer_request = asyncio.create_task(
            client.put(
                "/api/session-title",
                json={"session": "B", "title": "Updated alias"},
            )
        )
        await asyncio.wait_for(rename_lock.waiting.wait(), timeout=1)

        assert writer_request.done() is False
        assert titles.get_title("A") == "Alias A"
        assert titles.get_title("B") is None

        tmux.release_first_rename.set()
        rename_response, writer_response = await asyncio.gather(
            rename_request, writer_request
        )

        assert rename_response.status == 200
        assert writer_response.status == 200
        assert await writer_response.json() == {
            "session": "B",
            "customTitle": "Updated alias",
        }
        reloaded = SessionTitleStore(titles_path)
        assert reloaded.get_title("A") is None
        assert reloaded.get_title("B") == "Updated alias"
    finally:
        tmux.release_first_rename.set()
        pending_requests = [
            request
            for request in (rename_request, writer_request)
            if request is not None and not request.done()
        ]
        if pending_requests:
            await asyncio.gather(*pending_requests, return_exceptions=True)
        await client.close()


@pytest.mark.parametrize("mutation", ["add", "update", "delete"])
@pytest.mark.asyncio
async def test_session_message_writes_wait_for_rename_and_reject_stale_name(
    tmp_path, mutation: str
):
    tmux = OverlappingRenamingFakeTmux([make_session("A")])
    messages_path = tmp_path / "messages.json"
    message_ids = iter(("message-a", "stale-message"))
    messages = SessionMessageStore(
        messages_path, id_factory=lambda: next(message_ids)
    )
    original_message = messages.add_message("A", "Prompt A")
    application = create_app(tmux=tmux, messages=messages, base_path="")
    rename_lock = ObservableLock()
    application[SESSION_RENAME_LOCK_KEY] = rename_lock
    client = TestClient(TestServer(application))
    rename_request: asyncio.Task[ClientResponse] | None = None
    writer_request: asyncio.Task[ClientResponse] | None = None

    try:
        await client.start_server()
        rename_request = asyncio.create_task(
            client.put("/api/session-name", json={"session": "A", "name": "B"})
        )
        await asyncio.wait_for(tmux.first_tmux_mutated.wait(), timeout=1)

        collection = "/api/sessions/A/messages"
        if mutation == "add":
            writer_request = asyncio.create_task(
                client.post(collection, json={"text": "Stale prompt"})
            )
        elif mutation == "update":
            writer_request = asyncio.create_task(
                client.patch(
                    f"{collection}/{original_message['id']}",
                    json={"text": "Stale edit"},
                )
            )
        else:
            writer_request = asyncio.create_task(
                client.delete(f"{collection}/{original_message['id']}")
            )
        await asyncio.wait_for(rename_lock.waiting.wait(), timeout=1)

        assert messages.list_messages("A") == [original_message]
        assert messages.list_messages("B") == []

        tmux.release_first_rename.set()
        rename_response, writer_response = await asyncio.gather(
            rename_request, writer_request
        )

        assert rename_response.status == 200
        assert writer_response.status == 404
        assert await writer_response.json() == {
            "error": "tmux session not found: A"
        }

        reloaded = SessionMessageStore(messages_path)
        assert reloaded.list_messages("A") == []
        assert reloaded.list_messages("B") == [original_message]
    finally:
        tmux.release_first_rename.set()
        pending_requests = [
            request
            for request in (rename_request, writer_request)
            if request is not None and not request.done()
        ]
        if pending_requests:
            await asyncio.gather(*pending_requests, return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_validates_exact_payload_and_native_name(tmp_path):
    tmux = RenamingFakeTmux([make_session("agent-old")])
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=SessionTitleStore(tmp_path / "titles.json"),
                messages=SessionMessageStore(tmp_path / "messages.json"),
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        malformed = await client.put(
            "/api/session-name",
            data="{",
            headers={"Content-Type": "application/json"},
        )
        assert malformed.status == 400
        assert await malformed.json() == {"error": "request body must be JSON"}

        invalid_requests = [
            ([], "request body must be an object"),
            ({"session": "agent-old"}, "name is required"),
            (
                {"session": "agent-old", "name": "agent-new", "extra": True},
                "unknown field: extra",
            ),
            ({"session": 7, "name": "agent-new"}, "session must be a string"),
            ({"session": "agent-old", "name": 7}, "name must be a string"),
            ({"session": "agent-old", "name": "   "}, "session name is required"),
            (
                {"session": "agent-old", "name": "invalid:name"},
                "session name cannot contain ':' or '.'",
            ),
            (
                {"session": "agent-old", "name": "invalid.name"},
                "session name cannot contain ':' or '.'",
            ),
            (
                {"session": "agent-old", "name": "trailing;"},
                "session name cannot end with ';'",
            ),
            (
                {"session": "agent-old", "name": "line\nbreak"},
                "session name cannot contain control characters",
            ),
            (
                {"session": "agent-old", "name": "x" * 257},
                "session name must be 256 characters or fewer",
            ),
            (
                {"session": "agent-old", "name": "agent-old"},
                "new session name must differ from current session name",
            ),
        ]
        for payload, error in invalid_requests:
            response = await client.put("/api/session-name", json=payload)
            assert response.status == 400
            assert await response.json() == {"error": error}

        assert tmux.rename_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_rejects_missing_or_existing_sessions(tmp_path):
    old_session = make_session("agent-old")
    new_session = make_session("agent-new")
    tmux = RenamingFakeTmux([old_session, new_session])
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=SessionTitleStore(tmp_path / "titles.json"),
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        missing = await client.put(
            "/api/session-name", json={"session": "missing", "name": "available"}
        )
        assert missing.status == 404
        assert await missing.json() == {"error": "tmux session not found: missing"}

        conflict = await client.put(
            "/api/session-name",
            json={"session": "agent-old", "name": "agent-new"},
        )
        assert conflict.status == 409
        assert await conflict.json() == {
            "error": "tmux session already exists: agent-new"
        }
        assert tmux.rename_calls == []
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("tmux_error", "status"),
    [
        ("rename denied", 503),
        ("duplicate session: agent-new", 409),
        ("can't find session: agent-old", 404),
    ],
)
@pytest.mark.asyncio
async def test_rename_session_api_reports_tmux_failure_without_migrating_state(
    tmp_path, tmux_error: str, status: int
):
    old_name = "agent-old"
    tmux = RenamingFakeTmux(
        [make_session(old_name)], TmuxError(tmux_error, returncode=1)
    )
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_title(old_name, "Keep me")
    client = TestClient(TestServer(create_app(tmux=tmux, titles=titles, base_path="")))

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name",
            json={"session": old_name, "name": "agent-new"},
        )

        assert response.status == status
        assert await response.json() == {"error": tmux_error}
        assert titles.get_title(old_name) == "Keep me"
        assert titles.get_title("agent-new") is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_returns_success_when_metadata_migration_fails(
    tmp_path, monkeypatch
):
    old_name = "agent-old"
    new_name = "agent-new"
    tmux = RenamingFakeTmux([make_session(old_name)])
    titles = SessionTitleStore(tmp_path / "titles.json")
    messages = SessionMessageStore(
        tmp_path / "messages.json", id_factory=lambda: "message-id"
    )
    message = messages.add_message(old_name, "Keep moving")

    def fail_metadata_migration(_current_name: str, _new_name: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(titles, "rename_session", fail_metadata_migration)
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                messages=messages,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name", json={"session": old_name, "name": new_name}
        )

        assert response.status == 200
        assert await response.json() == {
            "previousSession": old_name,
            "session": new_name,
            "warnings": ["unable to migrate session metadata"],
        }
        assert tmux.rename_calls == [(old_name, new_name)]
        assert messages.list_messages(old_name) == []
        assert messages.list_messages(new_name) == [message]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_rename_session_api_returns_success_when_message_migration_fails(
    tmp_path, monkeypatch
):
    old_name = "agent-old"
    new_name = "agent-new"
    tmux = RenamingFakeTmux([make_session(old_name)])
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_title(old_name, "Human alias")
    titles.set_starred(old_name, True)
    messages = SessionMessageStore(
        tmp_path / "messages.json", id_factory=lambda: "message-id"
    )
    old_message = messages.add_message(old_name, "Keep moving")

    def fail_message_migration(_current_name: str, _new_name: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(messages, "rename_session", fail_message_migration)
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                messages=messages,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-name", json={"session": old_name, "name": new_name}
        )

        assert response.status == 200
        assert await response.json() == {
            "previousSession": old_name,
            "session": new_name,
            "warnings": ["unable to migrate memo entries"],
        }
        assert tmux.rename_calls == [(old_name, new_name)]
        assert titles.get_title(old_name) is None
        assert titles.get_title(new_name) == "Human alias"
        assert titles.is_starred(new_name) is True
        assert messages.list_messages(old_name) == [old_message]
        assert messages.list_messages(new_name) == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_api_tracks_state_changes_and_prunes_absent_sessions(tmp_path):
    session = make_session()
    tmux = FakeTmux([[session], [session], [session], [], [session]])
    detector = FakeAgentStateDetector(
        [
            {session.name: AgentState("working", "first observation")},
            {session.name: AgentState("working", "same state, new reason")},
            {session.name: AgentState("waiting_human", "needs input")},
            {},
            {session.name: AgentState("waiting_human", "seen again")},
        ]
    )
    titles = SessionTitleStore(tmp_path / "titles.json")
    application = create_app(
        tmux=tmux,
        titles=titles,
        agent_states=detector,
        base_path="",
    )
    application[SESSION_SNAPSHOTS_KEY] = SessionSnapshotBuilder(
        tmux,
        titles,
        detector,
        clock=sequence_clock(100.9, 200.1, 300.8, 400.2, 500.7),
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        first = (await (await client.get("/api/sessions")).json())["sessions"][0]
        unchanged = (await (await client.get("/api/sessions")).json())["sessions"][0]
        changed = (await (await client.get("/api/sessions")).json())["sessions"][0]
        absent = await (await client.get("/api/sessions")).json()
        reappeared = (await (await client.get("/api/sessions")).json())["sessions"][0]

        assert first["agentStateChangedAt"] == 100
        assert isinstance(first["agentStateChangedAt"], int)
        assert unchanged["agentState"] == "working"
        assert unchanged["agentStateReason"] == "same state, new reason"
        assert unchanged["agentStateChangedAt"] == 100
        assert changed["agentState"] == "waiting_human"
        assert changed["agentStateChangedAt"] == 300
        assert absent == {"sessions": []}
        assert reappeared["agentStateChangedAt"] == 500
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_snapshot_builder_serializes_concurrent_samples(tmp_path):
    session = make_session()
    tmux = FakeTmux([[session]], delay=0.02)
    detector = FakeAgentStateDetector([{session.name: AgentState("working", "active")}])
    builder = SessionSnapshotBuilder(
        tmux,
        SessionTitleStore(tmp_path / "titles.json"),
        detector,
        clock=lambda: 100,
    )

    await asyncio.gather(builder.build(), builder.build())

    assert tmux.list_calls == 2
    assert tmux.max_active_calls == 1


@pytest.mark.asyncio
async def test_session_snapshot_builder_resets_timestamp_for_recreated_session(
    tmp_path,
):
    original = make_session()
    recreated = make_recreated_session()
    tmux = FakeTmux([[original], [recreated]])
    detector = FakeAgentStateDetector(
        [
            {original.name: AgentState("working", "active")},
            {recreated.name: AgentState("working", "still active")},
        ]
    )
    builder = SessionSnapshotBuilder(
        tmux,
        SessionTitleStore(tmp_path / "titles.json"),
        detector,
        clock=sequence_clock(100, 200),
    )

    first = (await builder.build())["sessions"][0]
    second = (await builder.build())["sessions"][0]

    assert first["agentStateChangedAt"] == 100
    assert second["agentStateChangedAt"] == 200


@pytest.mark.asyncio
async def test_session_ignored_api_persists_and_updates_session_payload(tmp_path):
    session = make_session("ignored-session")
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("other", "long-running process")}]
    )
    metadata_path = tmp_path / "titles.json"
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(metadata_path),
        agent_states=detector,
        base_path="",
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        listed = await (await client.get("/api/sessions")).json()
        assert listed["sessions"][0]["ignored"] is False

        response = await client.put(
            "/api/session-star",
            json={"session": session.name, "starred": True},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "starred": True,
            "ignored": False,
        }

        response = await client.put(
            "/api/session-ignored",
            json={"session": session.name, "ignored": True},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "starred": False,
            "ignored": True,
        }
        assert SessionTitleStore(metadata_path).is_ignored(session.name) is True
        assert SessionTitleStore(metadata_path).is_starred(session.name) is False

        listed = await (await client.get("/api/sessions")).json()
        assert listed["sessions"][0]["ignored"] is True
        assert listed["sessions"][0]["starred"] is False

        response = await client.put(
            "/api/session-star",
            json={"session": session.name, "starred": True},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "starred": True,
            "ignored": False,
        }
        assert SessionTitleStore(metadata_path).is_ignored(session.name) is False

        response = await client.put(
            "/api/session-ignored",
            json={"session": session.name, "ignored": False},
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "starred": True,
            "ignored": False,
        }
        assert SessionTitleStore(metadata_path).is_ignored(session.name) is False
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_ignored_api_validates_payload_and_existing_session(tmp_path):
    session = make_session()
    application = create_app(
        tmux=FakeTmux([[session]]),
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=FakeAgentStateDetector(
            [{session.name: AgentState("working", "active")}]
        ),
        base_path="",
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()

        response = await client.put(
            "/api/session-ignored", json={"session": session.name, "ignored": "yes"}
        )
        assert response.status == 400
        assert await response.json() == {"error": "ignored must be a boolean"}

        response = await client.put(
            "/api/session-ignored", json={"session": "missing", "ignored": True}
        )
        assert response.status == 404
        assert await response.json() == {"error": "tmux session not found: missing"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_tags_api_replaces_persistent_tags_and_updates_session_payload(
    tmp_path,
):
    session = make_session("tagged-work")
    metadata_path = tmp_path / "titles.json"
    client = TestClient(
        TestServer(
            create_app(
                tmux=FakeTmux([[session]]),
                titles=SessionTitleStore(metadata_path),
                agent_states=FakeAgentStateDetector(
                    [{session.name: AgentState("working", "active")}]
                ),
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        listed = await (await client.get("/api/sessions")).json()
        assert listed["sessions"][0]["tags"] == []

        response = await client.put(
            "/api/session-tags",
            json={
                "session": session.name,
                "tags": ["background", "work", "review", "work"],
            },
        )
        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "tags": ["work", "review", "background"],
        }
        assert SessionTitleStore(metadata_path).get_tags(session.name) == [
            "work",
            "review",
            "background",
        ]

        listed = await (await client.get("/api/sessions")).json()
        assert listed["sessions"][0]["tags"] == [
            "work",
            "review",
            "background",
        ]

        response = await client.put(
            "/api/session-tags", json={"session": session.name, "tags": []}
        )
        assert response.status == 200
        assert await response.json() == {"session": session.name, "tags": []}
        assert SessionTitleStore(metadata_path).get_tags(session.name) == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_details_api_updates_title_and_tags_in_one_persist(tmp_path):
    session = make_session("details-work")
    metadata_path = tmp_path / "titles.json"
    titles = SessionTitleStore(metadata_path)
    client = TestClient(
        TestServer(
            create_app(tmux=FakeTmux([[session]]), titles=titles, base_path="")
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-details",
            json={
                "session": session.name,
                "title": "  Release review  ",
                "tags": ["urgent", "work", "urgent"],
            },
        )

        assert response.status == 200
        assert await response.json() == {
            "session": session.name,
            "customTitle": "Release review",
            "tags": ["work", "urgent"],
        }
        reloaded = SessionTitleStore(metadata_path)
        assert reloaded.get_title(session.name) == "Release review"
        assert reloaded.get_tags(session.name) == ["work", "urgent"]
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"tags": []}, "session is required"),
        ({"session": "agent-one"}, "tags is required"),
        ({"session": 7, "tags": []}, "session must be a string"),
        ({"session": "agent-one", "tags": "work"}, "tags must be an array"),
        (
            {"session": "agent-one", "tags": ["work", 7]},
            "tags must contain only strings",
        ),
        (
            {"session": "agent-one", "tags": ["invented"]},
            "unknown session tag: invented",
        ),
        (
            {"session": "agent-one", "tags": [], "extra": True},
            "unknown field: extra",
        ),
    ],
)
@pytest.mark.asyncio
async def test_session_tags_api_validates_exact_payload(
    tmp_path, payload: object, message: str
):
    session = make_session()
    titles = SessionTitleStore(tmp_path / "titles.json")
    client = TestClient(
        TestServer(create_app(tmux=FakeTmux([[session]]), titles=titles, base_path=""))
    )

    try:
        await client.start_server()
        response = await client.put("/api/session-tags", json=payload)
        assert response.status == 400
        assert await response.json() == {"error": message}
        assert titles.get_tags(session.name) == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_tags_api_rejects_missing_session_without_persisting(tmp_path):
    metadata_path = tmp_path / "titles.json"
    titles = SessionTitleStore(metadata_path)
    client = TestClient(
        TestServer(create_app(tmux=FakeTmux([[]]), titles=titles, base_path=""))
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-tags",
            json={"session": "missing", "tags": ["work"]},
        )
        assert response.status == 404
        assert await response.json() == {"error": "tmux session not found: missing"}
        assert titles.get_tags("missing") == []
        assert metadata_path.exists() is False
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_tags_api_reports_tmux_inventory_failure_as_unavailable(tmp_path):
    titles = SessionTitleStore(tmp_path / "titles.json")
    client = TestClient(
        TestServer(
            create_app(
                tmux=FakeTmux([TmuxError("tmux inventory unavailable")]),
                titles=titles,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-tags",
            json={"session": "agent-one", "tags": ["work"]},
        )

        assert response.status == 503
        assert await response.json() == {"error": "tmux inventory unavailable"}
        assert titles.get_tags("agent-one") == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_session_tags_api_reports_storage_failure_without_mutating_state(
    tmp_path, monkeypatch
):
    session = make_session()
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_tags(session.name, ["work"])

    def fail_persist(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(titles, "_persist", fail_persist)
    client = TestClient(
        TestServer(
            create_app(tmux=FakeTmux([[session]]), titles=titles, base_path="")
        )
    )

    try:
        await client.start_server()
        response = await client.put(
            "/api/session-tags",
            json={"session": session.name, "tags": ["urgent"]},
        )
        assert response.status == 500
        assert await response.json() == {"error": "unable to save session tags"}
        assert titles.get_tags(session.name) == ["work"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_stream_shares_one_sampler_across_clients_and_stops_last(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.2)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 0.01)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector([{session.name: AgentState("working", "active")}])
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    broker = application[SESSION_STREAM_BROKER_KEY]
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        first_response, second_response = await asyncio.gather(
            client.get("/api/sessions/stream"),
            client.get("/api/sessions/stream"),
        )
        first, second = await asyncio.gather(
            read_sse_record(first_response),
            read_sse_record(second_response),
        )

        assert event_payload(first) == event_payload(second)
        assert tmux.list_calls == 1
        assert broker.subscriber_count == 2
        sampler = broker.sampler_task
        assert sampler is not None
        assert not sampler.done()

        first_response.close()
        await wait_until(lambda: broker.subscriber_count == 1)
        assert broker.sampler_task is sampler
        assert not sampler.done()

        second_response.close()
        await wait_until(lambda: broker.subscriber_count == 0)
        assert broker.sampler_task is None
        assert sampler.done()
        calls_after_disconnect = tmux.list_calls
        await asyncio.sleep(0.03)
        assert tmux.list_calls == calls_after_disconnect
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_stream_recovers_after_tmux_error(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 1)
    session = make_session()
    tmux = FakeTmux([TmuxError("temporary tmux failure"), [session]])
    detector = FakeAgentStateDetector(
        [{session.name: AgentState("waiting_human", "needs input")}]
    )
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    client = TestClient(TestServer(application))

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        payload = event_payload(await read_sse_record(response))
        assert response.status == 200
        assert payload["sessions"][0]["agentState"] == "waiting_human"
        assert tmux.list_calls >= 2
        response.close()
        await wait_until(
            lambda: application[SESSION_STREAM_BROKER_KEY].sampler_task is None
        )
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_application_cleanup_cancels_active_session_sampler(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 10)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 10)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector([{session.name: AgentState("working", "active")}])
    application = create_app(
        tmux=tmux,
        titles=SessionTitleStore(tmp_path / "titles.json"),
        agent_states=detector,
        base_path="",
    )
    broker = application[SESSION_STREAM_BROKER_KEY]
    client = TestClient(TestServer(application))
    await client.start_server()
    response = await client.get("/api/sessions/stream")
    event_payload(await read_sse_record(response))
    sampler = broker.sampler_task
    assert sampler is not None

    await client.close()

    assert broker.closed
    assert broker.subscriber_count == 0
    assert broker.sampler_task is None
    assert sampler.done()
    assert not any(
        task.get_name() == "muxdeck-session-sampler" and not task.done()
        for task in asyncio.all_tasks()
    )


@pytest.mark.asyncio
async def test_sessions_stream_sends_initial_and_changed_snapshots(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 1)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector(
        [
            {session.name: AgentState("working", "active")},
            {session.name: AgentState("waiting_human", "needs input")},
        ]
    )
    titles = SessionTitleStore(tmp_path / "titles.json")
    titles.set_tags(session.name, ["review", "urgent"])
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=titles,
                agent_states=detector,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        assert response.status == 200
        assert response.headers["Content-Type"].startswith("text/event-stream")
        assert response.headers["Cache-Control"] == "no-cache, no-transform"
        assert response.headers["X-Accel-Buffering"] == "no"

        initial = event_payload(await read_sse_record(response))
        changed = event_payload(await read_sse_record(response))
        assert initial["sessions"][0]["agentState"] == "working"
        assert initial["sessions"][0]["tags"] == ["review", "urgent"]
        assert changed["sessions"][0]["agentState"] == "waiting_human"
        assert changed["sessions"][0]["tags"] == ["review", "urgent"]
        assert (
            changed["sessions"][0]["agentStateChangedAt"]
            >= initial["sessions"][0]["agentStateChangedAt"]
        )
        response.close()
        await asyncio.sleep(0.03)
        calls_after_disconnect = tmux.list_calls
        await asyncio.sleep(0.03)
        assert tmux.list_calls == calls_after_disconnect
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_sessions_stream_suppresses_unchanged_events_and_heartbeats(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(app_module, "SESSION_STREAM_SAMPLE_SECONDS", 0.01)
    monkeypatch.setattr(app_module, "SESSION_STREAM_HEARTBEAT_SECONDS", 0.04)
    session = make_session()
    tmux = FakeTmux([[session]])
    detector = FakeAgentStateDetector([{session.name: AgentState("working", "active")}])
    client = TestClient(
        TestServer(
            create_app(
                tmux=tmux,
                titles=SessionTitleStore(tmp_path / "titles.json"),
                agent_states=detector,
                base_path="",
            )
        )
    )

    try:
        await client.start_server()
        response = await client.get("/api/sessions/stream")

        event_payload(await read_sse_record(response))
        heartbeat = await read_sse_record(response)
        assert heartbeat == ": heartbeat\n\n"
        assert tmux.list_calls >= 2
        response.close()
    finally:
        await client.close()
