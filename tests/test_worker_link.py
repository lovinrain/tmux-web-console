from dataclasses import replace

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.app import SCROLLBACK_KEY, SESSION_REGISTRY_KEY, create_app
from tmux_console.tmux import HistoryCapture, Pane, Session, TmuxClient


class WorkerTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="unused-tmux")
        pane = Pane(id="%1", index=0, window_index=0, window_name="main", window_active=True,
                    active=True, command="bridge", path="/tmp", title="worker", width=80, height=24,
                    history_size=0, history_limit=2000, alternate_on=False, dead=False,
                    activity=100, process_pid=12345)
        self.original = Session(name="worker", id="$1", created=100, windows=1, attached=0,
                                server_started=90, server_pid=321, panes=[pane])
        self.sessions = [self.original]
        self.lines = ["original worker output"]
        self.after_capture = None

    async def list_sessions(self):
        return self.sessions

    async def capture_history_slice(self, pane, start, end):
        result = HistoryCapture(pane, list(self.lines))
        if self.after_capture:
            self.after_capture()
        return result


IDENTITY = {"sessionId": "$1", "sessionCreated": "100", "serverStarted": "90",
            "serverPid": "321", "paneId": "%1", "panePid": "12345"}


def client_for(tmux):
    return TestClient(TestServer(create_app(tmux=tmux, base_path="/mux")))


@pytest.mark.asyncio
async def test_worker_link_follows_rename_and_retains_original_history_after_name_reuse():
    tmux = WorkerTmux()
    async with client_for(tmux) as client:
        live = await client.get("/mux/api/worker-terminal", params=IDENTITY)
        assert live.status == 200
        original = await live.json()
        assert original["state"] == "live"
        assert original["text"] == "original worker output"
        tmux.sessions = [replace(tmux.original, name="renamed-worker")]
        renamed = await (await client.get("/mux/api/worker-terminal", params=IDENTITY)).json()
        assert renamed["session"] == "renamed-worker"
        assert renamed["historyId"] == original["historyId"]
        # A reused tmux ID and name after server restart are different incarnations.
        tmux.sessions = [replace(tmux.original, created=200, server_started=190, server_pid=999,
                                 panes=[replace(tmux.original.panes[0], process_pid=55555)])]
        tmux.lines = ["replacement must never appear"]
        ended = await (await client.get("/mux/api/worker-terminal", params={
            **IDENTITY, "historyId": original["historyId"],
        })).json()
        assert ended["state"] == "ended"
        assert ended["text"] == "original worker output"
        assert ended["session"] == "renamed-worker"


@pytest.mark.asyncio
async def test_respawned_pane_is_stale_and_never_selects_another_archived_pane():
    tmux = WorkerTmux()
    async with client_for(tmux) as client:
        original = await (await client.get("/mux/api/worker-terminal", params=IDENTITY)).json()
        replacement_pane = replace(tmux.original.panes[0], process_pid=77777)
        tmux.sessions = [replace(tmux.original, panes=[replacement_pane])]
        client.app[SCROLLBACK_KEY].save(original["historyId"], tmux.sessions[0], replacement_pane,
                                       ["replacement"], ["replacement"])
        stale = await (await client.get("/mux/api/worker-terminal", params=IDENTITY)).json()
        assert stale["state"] == "stale"
        assert stale["text"] == "original worker output"


@pytest.mark.asyncio
async def test_worker_link_rejects_cross_identity_history_and_capture_race():
    tmux = WorkerTmux()
    async with client_for(tmux) as client:
        history_id = client.app[SESSION_REGISTRY_KEY].observe_history(replace(tmux.original, id="$2"))
        wrong = await client.get("/mux/api/worker-terminal", params={**IDENTITY, "historyId": history_id})
        assert wrong.status == 409
        tmux.after_capture = lambda: setattr(tmux, "sessions", [replace(
            tmux.original, panes=[replace(tmux.original.panes[0], process_pid=77777)],
        )])
        race = await client.get("/mux/api/worker-terminal", params=IDENTITY)
        assert race.status == 409
        assert client.app[SCROLLBACK_KEY].read(
            client.app[SESSION_REGISTRY_KEY].history_for_identity("$1", 100, 90, 321)["id"],
        )["lines"] == []


@pytest.mark.asyncio
async def test_worker_link_missing_and_malformed_identity_do_not_fall_back_to_name():
    tmux = WorkerTmux()
    async with client_for(tmux) as client:
        missing = await (await client.get("/mux/api/worker-terminal", params={**IDENTITY, "serverPid": "999"})).json()
        assert missing["state"] == "missing" and missing["text"] == ""
        for query in ({"session": "worker"}, {**IDENTITY, "panePid": "0"}, {**IDENTITY, "session": "worker"}):
            assert (await client.get("/mux/api/worker-terminal", params=query)).status == 400
        assert (await client.get("/mux/api/worker-terminal", params=[
            *IDENTITY.items(), ("paneId", "%2"),
        ])).status == 400


@pytest.mark.asyncio
async def test_worker_link_keeps_browser_auth_and_read_only_control_scope(tmp_path):
    from tmux_console.auth import AuthStore, provision_auth_file

    auth_path = tmp_path / "auth.json"
    provision_auth_file(auth_path, "worker-viewer", "a-strong-test-password")
    control_path = tmp_path / "control-token"
    control_path.write_text("c" * 64)
    control_path.chmod(0o600)
    callback_path = tmp_path / "callback-token"
    callback_path.write_text("b" * 64)
    callback_path.chmod(0o600)
    app = create_app(tmux=WorkerTmux(), base_path="/mux", auth=AuthStore(auth_path),
                     auth_mode="server", control_token_file=control_path, callback_token_file=callback_path)
    async with TestClient(TestServer(app)) as client:
        route = "/mux/api/worker-terminal"
        assert (await client.get(route, params=IDENTITY)).status == 401
        assert (await client.get(route, params=IDENTITY, headers={"Authorization": "Bearer " + "b" * 64})).status == 403
        headers = {"Authorization": "Bearer " + "c" * 64}
        assert (await client.get(route, params=IDENTITY, headers=headers)).status == 200
        assert (await client.post(route, params=IDENTITY, headers=headers)).status == 403
