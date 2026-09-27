from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tmux_console.agent_reference import AgentReference, AgentReferenceDetector
from tmux_console.agent_transcripts import AgentTranscriptReader, TranscriptChangedError
from tmux_console.app import SESSION_REGISTRY_KEY, create_app
from tmux_console.scrollback import session_identity
from tmux_console.tmux import Pane, Session, TmuxClient

ID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


def references(agent="codex", identifier=ID):
    return [{"agentType": agent, "agentSessionId": identifier}]


def codex_message(text, role="user"):
    return {"type": "response_item", "timestamp": "2026-09-26T12:00:00Z", "payload": {
        "type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
    }}


def write_native(root, agent, records, identifier=ID):
    root = Path(root)
    if agent == "codex":
        path = root / "sessions/2026/09/26" / f"rollout-2026-09-26T12-00-00-{identifier}.jsonl"
        records = [{"type": "session_meta", "payload": {"id": identifier}}, *records]
    elif agent == "claude":
        path = root / "-same-work-directory" / f"{identifier}.jsonl"
    elif agent == "copilot":
        path = root / identifier / "events.jsonl"
        records = [{"type": "session.start", "data": {"sessionId": identifier}}, *records]
    elif agent == "grok":
        path = root / "%2Fsame-work-directory" / identifier / "chat_history.jsonl"
    else:
        path = root / "project-hash" / identifier / "store.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.executescript("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);")
            blobs = [json.dumps(item).encode() for item in records]
            ids = [hashlib.sha256(item).hexdigest() for item in blobs]
            # Deliberately reverse storage order and keep an abandoned branch.
            for key, data in reversed(list(zip(ids, blobs, strict=True))):
                connection.execute("INSERT OR IGNORE INTO blobs VALUES (?, ?)", (key, data))
            connection.execute("INSERT INTO blobs VALUES (?, ?)", ("f" * 64, b'{"role":"user","content":"abandoned branch"}'))
            data = b"".join(b"\x0a\x20" + bytes.fromhex(key) for key in ids)
            key = hashlib.sha256(data).hexdigest()
            connection.execute("INSERT INTO blobs VALUES (?, ?)", (key, data))
            meta = json.dumps({"agentId": identifier, "latestRootBlobId": key}).encode().hex()
            connection.execute("INSERT INTO meta VALUES ('0', ?)", (meta,))
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records))
    return path


NATIVE_RECORDS = {
    "codex": [
        codex_message("internal instructions", "developer"),
        codex_message("First request"),
        {"type": "event_msg", "payload": {"type": "user_message", "message": "First request"}},
        {"type": "response_item", "payload": {"type": "reasoning", "encrypted_content": "secret reasoning"}},
        {"type": "response_item", "payload": {"type": "function_call_output", "output": "Tool output"}},
        codex_message("The answer", "assistant"),
    ],
    "claude": [
        {"type": "user", "sessionId": ID, "message": {"role": "user", "content": "First request"}},
        {"type": "assistant", "sessionId": ID, "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "secret reasoning"}]}},
        {"type": "user", "sessionId": ID, "message": {"role": "user", "content": [{"type": "tool_result", "content": "Tool output"}]}},
        {"type": "assistant", "sessionId": ID, "message": {"role": "assistant", "content": [{"type": "text", "text": "The answer"}]}},
        {"type": "user", "sessionId": OTHER, "message": {"role": "user", "content": "different conversation"}},
    ],
    "copilot": [
        {"type": "system.message", "data": {"role": "system", "content": "internal instructions"}},
        {"type": "user.message", "data": {"content": "First request"}},
        {"type": "tool.execution_complete", "data": {"result": {"content": "Tool output"}}},
        {"type": "assistant.message", "data": {"content": "The answer"}},
    ],
    "cursor": [
        {"role": "system", "content": "internal instructions"},
        {"role": "user", "content": "generated context", "providerOptions": {"cursor": {"requestContextCompleteness": {}}}},
        {"role": "user", "content": [{"type": "text", "text": "First request"}]},
        {"role": "tool", "content": [{"type": "text", "text": "Tool output"}]},
        {"role": "assistant", "content": [{"type": "reasoning", "text": "secret reasoning"}, {"type": "text", "text": "The answer"}]},
    ],
    "grok": [
        {"type": "system", "content": "internal instructions"},
        {"type": "user", "content": [{"type": "text", "text": "First request"}]},
        {"type": "tool_result", "content": "Tool output"},
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "secret reasoning"}]},
        {"type": "assistant", "content": "The answer"},
    ],
}


@pytest.mark.parametrize("agent", NATIVE_RECORDS)
def test_native_conversation_order_filters_context_and_duplicate_events(tmp_path, agent):
    path = write_native(tmp_path, agent, NATIVE_RECORDS[agent])
    original = path.read_bytes()
    reader = AgentTranscriptReader(roots={agent: tmp_path})
    result = reader.read(references(agent), limit=2)
    assert result["status"] == "available"
    messages = list(result["messages"])
    while result["nextCursor"]:
        result = reader.read(references(agent), cursor=result["nextCursor"], limit=2)
        messages += result["messages"]
    assert [item["text"] for item in messages] == ["First request", "Tool output", "The answer"]
    assert [item["role"] for item in messages] == ["user", "tool", "assistant"]
    assert len({item["id"] for item in messages}) == 3
    assert path.read_bytes() == original


def test_jsonl_pagination_is_bound_to_id_and_snapshot_while_agent_appends(tmp_path):
    path = write_native(tmp_path, "codex", [codex_message("first"), codex_message("second")])
    reader = AgentTranscriptReader(roots={"codex": tmp_path})
    first = reader.read(references(), limit=1)
    with path.open("a") as output:
        output.write(json.dumps(codex_message("new third message")) + "\n")
    second = reader.read(references(), cursor=first["nextCursor"], limit=1)
    assert [item["text"] for item in second["messages"]] == ["second"]
    assert second["nextCursor"] is None
    assert len(reader.read(references())["messages"]) == 3
    write_native(tmp_path, "codex", [codex_message("other")], OTHER)
    with pytest.raises(ValueError, match="invalid transcript cursor"):
        reader.read(references(identifier=OTHER), cursor=first["nextCursor"])
    path.rename(path.with_suffix(".previous"))
    write_native(tmp_path, "codex", [codex_message("replacement")])
    with pytest.raises(TranscriptChangedError):
        reader.read(references(), cursor=first["nextCursor"])


def test_cursor_pagination_follows_original_root_during_new_turn(tmp_path):
    path = write_native(tmp_path, "cursor", [{"role": "user", "content": "first"}, {"role": "assistant", "content": "second"}])
    reader = AgentTranscriptReader(roots={"cursor": tmp_path})
    first = reader.read(references("cursor"), limit=1)
    with sqlite3.connect(path) as connection:
        # Native metadata may advance; the previous content-addressed root is immutable.
        connection.execute("UPDATE meta SET value = ? WHERE key = '0'", (json.dumps({"agentId": ID, "latestRootBlobId": "a" * 64}).encode().hex(),))
    second = reader.read(references("cursor"), cursor=first["nextCursor"])
    assert [item["text"] for item in second["messages"]] == ["second"]
    with sqlite3.connect(path) as connection:
        connection.execute("INSERT INTO blobs VALUES (?, ?)", ("a" * 64, "unsupported text root"))
    assert reader.read(references("cursor"))["status"] == "unsupported"


def test_large_malformed_and_unfinished_lines_do_not_block_later_messages(tmp_path, monkeypatch):
    monkeypatch.setattr("tmux_console.agent_transcripts.MAX_RECORD_BYTES", 512)
    monkeypatch.setattr("tmux_console.agent_transcripts.MAX_SCAN_BYTES", 1024)
    path = write_native(tmp_path, "codex", [codex_message("before"), codex_message("x" * 4000), codex_message("after")])
    with path.open("ab") as output:
        output.write(b'not-json\n{"type":')
    reader = AgentTranscriptReader(roots={"codex": tmp_path})
    cursor = None
    texts = []
    partial = False
    for _ in range(20):
        result = reader.read(references(), cursor=cursor)
        texts += [item["text"] for item in result["messages"]]
        partial |= result["partial"]
        cursor = result["nextCursor"]
        if cursor is None:
            break
    assert cursor is None
    assert texts == ["before", "after"]
    assert partial


def test_record_count_and_message_size_limits_allow_continuation(tmp_path, monkeypatch):
    monkeypatch.setattr("tmux_console.agent_transcripts.MAX_RECORDS_PER_PAGE", 2)
    monkeypatch.setattr("tmux_console.transcript_formats.MAX_MESSAGE_BYTES", 10)
    write_native(tmp_path, "codex", [{"type": "event_msg", "payload": {"type": "token_count"}}, codex_message("🎉" * 30)])
    reader = AgentTranscriptReader(roots={"codex": tmp_path})
    first = reader.read(references())
    assert first["messages"] == [] and first["nextCursor"]
    second = reader.read(references(), cursor=first["nextCursor"])
    assert second["messages"][0]["text"] == "🎉🎉"
    assert second["messages"][0]["truncated"]


def test_source_availability_and_symlinks_never_fall_back_to_another_chat(tmp_path):
    native = tmp_path / "native"
    reader = AgentTranscriptReader(roots={"codex": native})
    assert reader.read(references())["status"] == "missing"
    assert reader.read(references(identifier=None))["status"] == "unidentified"
    assert reader.read(references("unknown"))["status"] == "unsupported"
    secret = write_native(tmp_path / "outside", "codex", [codex_message("outside transcript")])
    linked = native / "sessions"
    linked.parent.mkdir(parents=True)
    linked.symlink_to(secret.parents[3], target_is_directory=True)
    assert reader.read(references())["messages"] == []
    with pytest.raises(ValueError, match="does not belong"):
        reader.read(references(), selected=f"codex:{OTHER}")


def test_codex_archive_and_header_identity(tmp_path):
    path = write_native(tmp_path, "codex", [codex_message("archived")])
    archived = tmp_path / "archived_sessions" / path.name
    archived.parent.mkdir()
    path.rename(archived)
    reader = AgentTranscriptReader(roots={"codex": tmp_path})
    assert reader.read(references())["messages"][0]["text"] == "archived"
    data = archived.read_text().replace(ID, OTHER)
    archived.write_text(data)
    result = reader.read(references())
    assert result["status"] == "unsupported" and result["messages"] == []


class TranscriptTmux(TmuxClient):
    def __init__(self):
        super().__init__(binary="must-not-run-tmux")
        pane = Pane(id="%1", index=0, window_index=0, window_name="main", window_active=True,
                    active=True, command="codex", path="/tmp", title="codex", width=80, height=24,
                    history_size=0, history_limit=2000, alternate_on=True, dead=False, activity=100, process_pid=123)
        self.session = Session(name="work", id="$1", created=100, windows=1, attached=0,
                               server_started=90, server_pid=321, panes=[pane, replace(pane, id="%2", active=False, process_pid=456)])

    async def list_sessions(self):
        return [self.session] if self.session else []


class References(AgentReferenceDetector):
    def __init__(self):
        super().__init__()
        self.identifiers = {"%1": ID, "%2": OTHER}
        self.requested = []

    async def detect_pane(self, pane, *, refresh=False):
        self.requested.append((pane.id, refresh))
        return AgentReference("codex", self.identifiers.get(pane.id))


async def test_live_pane_scoping_history_rename_and_name_reuse(tmp_path):
    write_native(tmp_path, "codex", [codex_message("original conversation")])
    write_native(tmp_path, "codex", [codex_message("second pane")], OTHER)
    tmux, detector = TranscriptTmux(), References()
    app = create_app(tmux=tmux, agent_references=detector,
                     agent_transcripts=AgentTranscriptReader(roots={"codex": tmp_path}), base_path="/mux")
    async with TestClient(TestServer(app)) as client:
        old_session = tmux.session
        path = "/mux/api/panes/%252/agent-transcript"
        response = await client.get(path, params={"identity": session_identity(old_session)})
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert (await response.json())["messages"][0]["text"] == "second pane"
        assert ("%2", True) in detector.requested
        history_id = app[SESSION_REGISTRY_KEY].observe_history(old_session, AgentReference("codex", ID))
        tmux.session = replace(old_session, name="renamed")
        assert (await client.get(path)).status == 200
        history = f"/mux/api/session-history/{history_id}/agent-transcript"
        detector.identifiers["%2"] = None
        assert (await (await client.get(path)).json())["status"] == "unidentified"
        tmux.session = None
        historical = await (await client.get(history, params={"source": f"codex:{ID}"})).json()
        assert historical["messages"][0]["text"] == "original conversation"
        tmux.session = replace(old_session, id="$2", created=200)
        assert (await client.get(path, params={"identity": session_identity(old_session)})).status == 409
        assert (await client.get(history, params={"source": f"codex:{ID}"})).status == 200


async def test_api_query_validation_and_identity_change_during_read(tmp_path):
    write_native(tmp_path, "codex", [codex_message("private")])
    tmux = TranscriptTmux()

    class ReplacedPaneReader(AgentTranscriptReader):
        def read(self, *args, **kwargs):
            result = super().read(*args, **kwargs)
            tmux.session = replace(tmux.session, panes=[replace(tmux.session.panes[0], process_pid=789)])
            return result

    app = create_app(tmux=tmux, agent_references=References(),
                     agent_transcripts=ReplacedPaneReader(roots={"codex": tmp_path}), base_path="")
    async with TestClient(TestServer(app)) as client:
        path = "/api/panes/%251/agent-transcript"
        for params in ({"path": "/etc/passwd"}, {"limit": "0"}, {"limit": "101"}, {"cursor": "not-a-cursor"}, {"source": f"codex:{OTHER}"}):
            assert (await client.get(path, params=params)).status == 400
        assert (await client.get("/api/session-history/missing/agent-transcript")).status == 404
        assert (await client.get("/api/panes/%25999/agent-transcript")).status == 404
        assert (await client.get(path)).status == 409
