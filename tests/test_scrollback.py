from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReferenceDetector
from tmux_console.app import SCROLLBACK_KEY, SESSION_REGISTRY_KEY, create_app
from tmux_console.auth import AuthStore, provision_auth_file
from tmux_console.scrollback import (
    MAX_SAVED_BYTES,
    MAX_SAVED_LINES,
    ScrollbackRecorder,
    ScrollbackStore,
    ScrollbackStoreUnavailable,
    session_identity,
)
from tmux_console.session_registry import SessionRegistry
from tmux_console.submitted_messages import SubmittedMessageStore
from tmux_console.tmux import (
    CreatedSession,
    HistoryCapture,
    Pane,
    Session,
    TmuxClient,
    TmuxSessionIdentityChangedError,
)


def session_fixture():
    pane = Pane(
        id="%1", index=0, window_index=0, window_name="main", window_active=True,
        active=True, command="bash", path="/tmp", title="shell", width=80, height=24,
        history_size=0, history_limit=2000, alternate_on=False, dead=False,
        activity=100, process_pid=12345,
    )
    return Session(name="work", id="$1", created=100, windows=1, attached=0,
                   server_started=90, server_pid=321, panes=[pane])


@pytest.fixture
def archive(tmp_path):
    store = ScrollbackStore(tmp_path / "scrollback.sqlite3")
    session = session_fixture()
    yield store, session, session.panes[0]
    store.close()


def test_opening_extends_then_survives_redraw_clear_and_restart(archive):
    store, session, pane = archive
    store.save("history", session, pane, ["Welcome", "$ "], ["Welcome", "$ "], captured_at=110)
    opening = ["Welcome", "$ first command", "First result"]
    store.save("history", session, pane, opening, opening, captured_at=115)
    assert store.read("history")["lines"] == opening
    assert store.read("history")["capturedAt"] == 115
    store.save("history", session, pane, ["New full screen"], ["New full screen"], captured_at=120)
    store.save("history", session, pane, [""], [""], captured_at=125)
    store.close()
    restarted = ScrollbackStore(store.path)
    try:
        # Even after restart, content that happens to extend the old opening
        # must not undo the earlier redraw's sealing decision.
        restarted.save("history", session, pane, [*opening, "later"], ["Latest result"], captured_at=130)
        saved = restarted.read("history")
        assert saved["lines"] == opening
        assert saved["firstCapturedAt"] == 110
        assert saved["capturedAt"] == 115
        recent = restarted.read("history", part="recent")
        assert recent["lines"] == ["Latest result"]
        assert recent["capturedAt"] == 130
        assert store.path.stat().st_mode & 0o777 == 0o600
    finally:
        restarted.close()


def test_blank_screen_does_not_start_or_erase_recording(archive):
    store, session, pane = archive
    store.save("history", session, pane, ["", " "], [], captured_at=101)
    assert store.read("history")["firstCapturedAt"] is None
    store.save("history", session, pane, ["first output"], ["last output"], captured_at=110)
    store.save("history", session, pane, [], [], captured_at=120)
    assert store.read("history")["firstCapturedAt"] == 110
    assert store.read("history", part="recent")["lines"] == ["last output"]
    assert store.read("history", part="recent")["capturedAt"] == 110


def test_rolling_output_retains_both_ends_with_bounded_storage(archive):
    store, session, pane = archive
    output = [f"row {index}" for index in range(MAX_SAVED_LINES * 3)]
    store.save("history", session, pane, output, output)
    assert store.read("history")["lines"] == output[:MAX_SAVED_LINES]
    assert store.read("history", part="recent")["lines"] == output[-MAX_SAVED_LINES:]
    assert store.read("history")["limited"]
    assert store.read("history", part="recent")["limited"]
    store.save("history", session, pane, output[100:], ["newest"])
    assert store.read("history")["lines"] == output[:MAX_SAVED_LINES]
    assert store.read("history", part="recent")["lines"] == ["newest"]


@pytest.mark.parametrize("part", ["beginning", "recent"])
def test_long_unicode_rows_respect_byte_limit_without_broken_characters(archive, part):
    store, session, pane = archive
    text = "START " + "🎉" * MAX_SAVED_BYTES + " END"
    store.save("history", session, pane, [text], [text])
    saved = store.read("history", part=part)
    retained = "\n".join(saved["lines"])
    assert len(retained.encode("utf-8")) <= MAX_SAVED_BYTES
    assert "�" not in retained
    assert retained.startswith("START ") if part == "beginning" else retained.endswith(" END")
    assert saved["limited"]


def test_history_and_pane_incarnations_are_separate_and_selectable(archive):
    store, session, pane = archive
    store.save("history", session, pane, ["original"], ["original"], captured_at=110)
    respawned = replace(pane, process_pid=23456)
    store.save("history", session, respawned, ["respawn"], ["respawn"], captured_at=120)
    store.save("replacement", session, pane, ["new session"], ["new session"])
    result = store.read("history")
    assert len(result["panes"]) == 2
    assert result["lines"] == ["original"]
    assert store.read("history", record_id=result["panes"][1]["id"])["lines"] == ["respawn"]
    assert store.read("history", pane=respawned)["lines"] == ["respawn"]
    with pytest.raises(ValueError, match="does not belong"):
        store.read("replacement", record_id=result["panes"][0]["id"])


@pytest.mark.parametrize("future_schema", [False, True])
def test_unavailable_database_is_preserved_and_explicit(tmp_path, future_schema):
    path = tmp_path / "broken.sqlite3"
    if future_schema:
        with sqlite3.connect(path) as connection:
            connection.execute("PRAGMA user_version = 999")
    else:
        path.write_bytes(b"not a database")
    original = path.read_bytes()
    store = ScrollbackStore(path)
    with pytest.raises(ScrollbackStoreUnavailable):
        store.read("history")
    assert path.read_bytes() == original


class FakeTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="must-not-run-tmux")
        self.session = session_fixture()
        self.lines = ["Opening output"]
        self.calls = []
        self.after_capture = None
        self.delay = 0
        self.active = 0
        self.max_active = 0

    async def list_sessions(self):
        return [self.session] if self.session else []

    async def capture_history_slice(self, pane, start, end):
        self.calls.append((pane.id, start, end))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            result = HistoryCapture(pane, list(self.lines))
            if self.after_capture:
                self.after_capture()
            return result
        finally:
            self.active -= 1

    async def create_session(self, requested_name=None, theme=None, *, start_directory=None):
        original = session_fixture()
        self.session = replace(original, id="$2", created=200,
                               panes=[replace(original.panes[0], process_pid=22222)])
        return CreatedSession(name=self.session.name, id=self.session.id, directory="/tmp")

    async def terminate_session(self, *identity):
        assert identity == (self.session.id, self.session.created, self.session.server_started, self.session.server_pid)
        self.session = None


class NoReferences(AgentReferenceDetector):
    async def detect_sessions(self, sessions):
        return {}


@pytest.fixture
def recorder(archive, tmp_path):
    store, _, _ = archive
    registry = SessionRegistry(tmp_path / "sessions.sqlite3")
    tmux = FakeTmux()
    result = ScrollbackRecorder(tmux, registry, store)
    yield result, tmux, registry, store
    registry.close()


async def test_recorder_bounds_capture_ranges_and_skips_unchanged_or_sealed_openings(recorder, monkeypatch):
    recorder, tmux, registry, store = recorder
    tmux.session.panes = [replace(tmux.session.panes[0], history_size=10000)]
    await recorder.sample(await tmux.list_sessions())
    assert tmux.calls == [("%1", -1976, 23), ("%1", -10000, -8001)]
    await recorder.sample(await tmux.list_sessions())
    assert len(tmux.calls) == 2
    # Periodically refresh even if tmux's activity timestamp is unchanged.
    monkeypatch.setattr("tmux_console.scrollback.UNCHANGED_CAPTURE_SECONDS", 0)
    tmux.lines = ["Recent output"]
    await recorder.sample(await tmux.list_sessions())
    assert tmux.calls[2:] == [("%1", -1976, 23)]
    history_id = registry.observe_history(tmux.session)
    assert store.read(history_id)["lines"] == ["Opening output"]
    assert store.read(history_id, part="recent")["lines"] == ["Recent output"]


async def test_recorder_retries_an_empty_new_pane_until_output_arrives(recorder):
    recorder, tmux, registry, store = recorder
    tmux.lines = ["", " "]
    await recorder.sample([tmux.session])
    tmux.lines = ["First output in the same activity second"]
    await recorder.sample([tmux.session])
    assert len(tmux.calls) == 2
    assert store.read(registry.observe_history(tmux.session))["lines"] == tmux.lines


@pytest.mark.parametrize("change", ["server", "respawn", "move", "disappear"])
async def test_recorder_fences_output_against_changes_during_capture(recorder, change):
    recorder, tmux, registry, store = recorder
    original = tmux.session
    history_id = registry.observe_history(original)

    def change_identity():
        if change == "server":
            tmux.session = replace(original, server_started=200, server_pid=654)
        elif change == "respawn":
            tmux.session = replace(original, panes=[replace(original.panes[0], process_pid=54321)])
        elif change == "move":
            tmux.session = replace(original, id="$2", created=200)
        else:
            tmux.session = None

    tmux.after_capture = change_identity
    with pytest.raises(TmuxSessionIdentityChangedError):
        await recorder.capture_pane("%1", session_identity(original))
    assert store.read(history_id)["panes"] == []


async def test_recorder_serializes_refreshes_limits_concurrency_and_cancels_cleanly(recorder):
    recorder, tmux, registry, store = recorder
    tmux.session.panes = [replace(tmux.session.panes[0], id=f"%{index}") for index in range(8)]
    tmux.delay = 0.01
    await asyncio.gather(recorder.sample([tmux.session]), recorder.sample([tmux.session]))
    assert tmux.max_active == 3
    assert len(tmux.calls) == 8
    history_id = registry.observe_history(tmux.session)
    assert len(store.read(history_id)["panes"]) == 8
    tmux.delay = 100
    task = asyncio.create_task(recorder.sample([tmux.session], force=True))
    while not tmux.active:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert tmux.active == 0
    tmux.delay = 0
    await recorder.sample([tmux.session], force=True)


async def test_live_and_ended_api_survive_rename_and_do_not_mix_reused_names(tmp_path):
    tmux = FakeTmux()
    app = create_app(tmux=tmux, agent_references=NoReferences(), base_path="/mux")
    async with TestClient(TestServer(app)) as client:
        path = "/mux/api/panes/%251/saved-scrollback"
        original = tmux.session
        response = await client.get(path, params={"identity": session_identity(original)})
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert (await response.json())["lines"] == ["Opening output"]
        history_id = app[SESSION_REGISTRY_KEY].observe_history(original)
        tmux.session = replace(original, name="renamed")
        tmux.lines = ["Recent output"]
        assert (await (await client.get(path + "?part=recent")).json())["lines"] == tmux.lines
        tmux.lines = ["Final output since the previous capture"]
        response = await client.delete("/mux/api/sessions/renamed", json={
            "sessionId": original.id, "sessionCreated": original.created,
            "serverStarted": original.server_started, "serverPid": original.server_pid,
        })
        assert response.status == 204
        assert tmux.session is None
        historical = f"/mux/api/session-history/{history_id}/saved-scrollback"
        assert (await (await client.get(historical)).json())["lines"] == ["Opening output"]
        assert (await (await client.get(historical + "?part=recent")).json())["lines"] == ["Final output since the previous capture"]
        tmux.session = replace(original, id="$2", created=200)
        tmux.lines = ["New incarnation"]
        assert (await client.get(path, params={"identity": session_identity(original)})).status == 409
        assert (await (await client.get(path)).json())["lines"] == ["New incarnation"]
        assert (await (await client.get(historical)).json())["lines"] == ["Opening output"]


async def test_background_recording_and_new_session_wake_need_no_browser(monkeypatch):
    monkeypatch.setattr("tmux_console.app.SUBMITTED_MESSAGE_POLL_SECONDS", 0.01)
    tmux = FakeTmux()
    app = create_app(tmux=tmux, agent_references=NoReferences(), base_path="")
    async with TestClient(TestServer(app)) as client:
        history_id = app[SESSION_REGISTRY_KEY].observe_history(tmux.session)

        async def saved(history_id):
            while not app[SCROLLBACK_KEY].read(history_id)["lines"]:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(saved(history_id), 2)
        # A new session wakes the worker even with a very long poll interval.
        monkeypatch.setattr("tmux_console.app.SUBMITTED_MESSAGE_POLL_SECONDS", 1000)
        tmux.session = None
        await asyncio.sleep(0.05)
        tmux.lines = ["Newly created"]
        response = await client.post("/api/sessions", json={})
        assert response.status == 201
        history_id = app[SESSION_REGISTRY_KEY].observe_history(tmux.session)

        async def fresh_saved():
            while app[SCROLLBACK_KEY].read(history_id, pane=tmux.session.panes[0])["lines"] != tmux.lines:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(fresh_saved(), 2)


async def test_api_validation_auth_and_unavailable_storage(tmp_path):
    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "test-user", "saved-output-test-password")
    token = "scrollback-test-" + "a" * 40
    token_path = tmp_path / "callback-token"
    token_path.write_text(token)
    token_path.chmod(0o600)
    app = create_app(
        tmux=FakeTmux(), agent_references=NoReferences(), base_path="/mux",
        auth=AuthStore(auth_path), auth_mode="server", auth_cookie_secure=False,
        callback_token_file=token_path,
    )
    path = "/mux/api/panes/%251/saved-scrollback"
    async with TestClient(TestServer(app)) as client:
        for protected in (path, "/mux/api/session-history/id/saved-scrollback"):
            assert (await client.get(protected)).status == 401
            assert (await client.get(protected, headers={"Authorization": f"Bearer {token}"})).status == 403
        assert (await client.post("/mux/api/auth/login", json={
            "username": "test-user", "password": "saved-output-test-password",
        })).status == 200
        assert (await client.get(path)).status == 200
        for params in ({"part": "all"}, {"pane": "other"}, {"path": "/etc/passwd"}):
            assert (await client.get(path, params=params)).status == 400
        assert (await client.get("/mux/api/session-history/missing/saved-scrollback")).status == 404
        assert (await client.get("/mux/api/panes/%25999/saved-scrollback")).status == 404
        app[SCROLLBACK_KEY].close()
        assert (await client.get(path)).status == 503
        original = session_fixture()
        response = await client.delete("/mux/api/sessions/work", json={
            "sessionId": original.id, "sessionCreated": original.created,
            "serverStarted": original.server_started, "serverPid": original.server_pid,
        })
        assert response.status == 204  # A failed final capture cannot block termination.


def test_output_limits_do_not_trim_submitted_input(archive, tmp_path):
    store, session, pane = archive
    agent_id = "11111111-1111-4111-8111-111111111111"
    source = tmp_path / "native-input.jsonl"
    source.write_text("".join(json.dumps({"session_id": agent_id, "ts": index + 100,
                                         "text": f"request {index}"}) + "\n" for index in range(75)))
    inputs = SubmittedMessageStore(tmp_path / "inputs.sqlite3", history_paths={"codex": source})
    try:
        refs = [{"agentType": "codex", "agentSessionId": agent_id}]
        inputs.sync(refs)
        output = ["output"] * (MAX_SAVED_LINES * 3)
        store.save("history", session, pane, output, output)
        source.unlink()
        inputs.sync(refs)
        assert len(inputs.list_messages(refs, limit=100)["messages"]) == 75
        assert inputs.list_messages(refs, query="request 37")["messages"][0]["text"] == "request 37"
    finally:
        inputs.close()
