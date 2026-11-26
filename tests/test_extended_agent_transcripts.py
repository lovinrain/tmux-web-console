from __future__ import annotations

import json
import sqlite3
from contextlib import closing

import pytest
import test_opencode_sessions as opencode
from test_agy_sessions import ID as AGY_ID
from test_agy_sessions import database, field, step

from tmux_console.agent_sources import (
    default_extended_transcript_roots,
    normalize_agent_session_id,
)
from tmux_console.agent_transcripts import AgentTranscriptReader, TranscriptChangedError

native_db = opencode.native_db


def references(agent, identifier):
    return [{"agentType": agent, "agentSessionId": identifier}]


def test_native_roots_and_uuid_normalization(tmp_path, monkeypatch):
    xdg_root = tmp_path / "xdg"
    configured_root = tmp_path / "omp"
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_root))
    monkeypatch.delenv("MUXDECK_OPENCODE_TRANSCRIPTS_DIR", raising=False)
    monkeypatch.setenv("MUXDECK_OMP_TRANSCRIPTS_DIR", str(configured_root))
    roots = default_extended_transcript_roots()
    assert roots["opencode"] == xdg_root / "opencode"
    assert roots["omp"] == configured_root
    identifier = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
    assert normalize_agent_session_id("agy", identifier) == identifier.lower()


@pytest.mark.parametrize("agent", ["pi", "omp"])
def test_pi_and_omp_exact_native_journals_and_submissions(tmp_path, monkeypatch, agent):
    monkeypatch.setattr("tmux_console.transcript_formats.MAX_MESSAGE_BYTES", 16)
    identifier = "Project_Session"
    project = tmp_path / "project"
    project.mkdir()
    path = project / f"2026-11-26T20-53-51-388Z_{identifier}.jsonl"
    header = {"type": "session", "id": identifier}
    prompt = "Here is the attached file"
    rows = ([{"type": "title", "v": 1, "title": "Project title"}] if agent == "omp" else []) + [
        header,
        {"type": "message", "id": "m1", "message": {
            "role": "user", "timestamp": 1_767_225_600_123, "content": prompt,
        }},
        {"type": "message", "id": "generated", "message": {
            "role": "user", "timestamp": 1_767_225_600_124, "content": "Generated input", "synthetic": True,
        }},
        {"type": "message", "id": "m2", "message": {
            "role": "user", "timestamp": 1_767_225_600_125,
            "content": [{"type": "text", "text": prompt}, {"type": "file"}],
        }},
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    reader = AgentTranscriptReader(roots={agent: tmp_path})
    assert reader.accepts_native_reference(agent, identifier)
    assert not reader.accepts_native_reference(agent, identifier.lower())
    assert reader.read(references(agent, identifier.lower()))["status"] == "missing"
    public = reader.read(references(agent, identifier), view="conversation")
    assert [message["kind"] for message in public["messages"]] == ["prompt", "prompt"]
    assert all(message["truncated"] for message in public["messages"])

    first = reader.read_native_prompts(agent, identifier, limit=1)
    assert first["messages"][0]["sourceId"] == "m1"
    assert first["messages"][0]["text"] == prompt
    assert first["messages"][0]["complete"]
    with path.open("a") as source:
        source.write(json.dumps(rows[-1] | {"id": "m3"}) + "\n")
    second = reader.read_native_prompts(agent, identifier, cursor=first["nextCursor"])
    assert [message["sourceId"] for message in second["messages"]] == ["m2"]
    assert second["messages"][0]["text"].startswith(prompt)
    assert not second["messages"][0]["complete"]
    with pytest.raises(ValueError, match="invalid transcript cursor"):
        reader.read(references(agent, identifier), cursor=first["nextCursor"])
    changed = path.read_text().replace(json.dumps(header), json.dumps(header | {"id": "Wrong"}))
    path.write_text(changed)
    assert not reader.accepts_native_reference(agent, identifier)
    assert reader.read(references(agent, identifier))["status"] == "unsupported"


def test_opencode_continuations_keep_split_entries_and_ignore_other_conversations(native_db):
    root, db, tables = native_db
    db.execute("PRAGMA journal_mode = WAL")
    identifier = opencode.ID
    with db:
        opencode.add_session(db, tables[0], identifier, "/project", "Current")
        opencode.add_session(db, tables[0], opencode.OTHER, "/project", "Other")
        opencode.add_message(db, tables, 1, "user", {"text": "Question"})
        opencode.add_message(db, tables, 2, "assistant", {"finish": "tool-calls"},
                    {"type": "text", "text": "Checking"},
                    {"type": "tool", "name": "read", "state": {"output": "Result"}})
        opencode.add_message(db, tables, 3, "assistant", {"finish": "stop"},
                    {"type": "text", "text": "Final answer"})
    reader = AgentTranscriptReader(roots={"opencode": root})
    source = references("opencode", identifier)
    assert reader.accepts_native_reference("opencode", identifier)
    assert not reader.accepts_native_reference("opencode", identifier.lower())
    assert reader.read(references("opencode", identifier.lower()))["status"] == "missing"

    first = reader.read(source, limit=1)
    assert [message["kind"] for message in first["messages"]] == ["prompt"]
    assert {"sourceId", "sourceText", "complete"}.isdisjoint(first["messages"][0])
    private = reader.read_native_prompts("opencode", identifier)
    assert [entry["sourceId"] for entry in private["messages"]] == [f"{identifier}-1"]
    assert private["messages"][0]["complete"]
    second = reader.read(source, cursor=first["nextCursor"], limit=1)
    assert [message["kind"] for message in second["messages"]] == ["progress"]
    with db:
        opencode.add_message(db, tables, 1, "user", {"text": "Unrelated"}, identifier=opencode.OTHER)
    third = reader.read(source, cursor=second["nextCursor"])
    assert [message["kind"] for message in third["messages"]] == ["tool", "response"]
    assert third["nextCursor"] is None
    ids = {message["id"] for page in [first, second, third] for message in page["messages"]}
    assert len(ids) == 4

    with db:
        db.execute(f"UPDATE {tables[2]} SET time_updated = time_updated + 1 WHERE session_id = ?", (identifier,))
    with pytest.raises(TranscriptChangedError):
        reader.read(source, cursor=second["nextCursor"])


def test_agy_wal_revisions_detect_same_size_edits_to_earlier_steps(tmp_path):
    identifier = AGY_ID
    prompt = step(3, 14, 19, field(2, "Question"))
    reply = step(5, 15, 20, field(8, "Answer"))
    path = database(tmp_path, [prompt, reply])
    reader = AgentTranscriptReader(roots={"agy": tmp_path})
    source = references("agy", identifier)
    assert reader.accepts_native_reference("agy", identifier)
    with closing(sqlite3.connect(path)) as writer:
        writer.execute("PRAGMA journal_mode = WAL")
        signature = reader.native_source_signature("agy", identifier)
        first = reader.read(source, limit=1)
        assert [message["text"] for message in first["messages"]] == ["Question"]
        second = reader.read(source, cursor=first["nextCursor"])
        assert [message["text"] for message in second["messages"]] == ["Answer"]
        assert second["nextCursor"] is None
        edited = step(3, 14, 19, field(2, "Revision"))
        with writer:
            writer.execute("UPDATE steps SET step_payload = ? WHERE idx = ?", (edited[4], edited[0]))
        assert reader.native_source_signature("agy", identifier) != signature
        with pytest.raises(TranscriptChangedError):
            reader.read(source, cursor=first["nextCursor"])
        assert reader.read(source, limit=1)["messages"][0]["text"] == "Revision"
