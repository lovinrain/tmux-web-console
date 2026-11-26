from __future__ import annotations

import json
import sqlite3
from contextlib import closing

import pytest

from tmux_console.opencode_sessions import (
    locate_opencode_db,
    opencode_revision,
    opencode_session_for_pane,
    read_opencode_records,
    valid_opencode_session_id,
)

ID = "ses_1234567890AbCdEfGhIjKlMnOp"
OTHER = "ses_0987654321AbCdEfGhIjKlMnOp"
TIMESTAMP = 1795726472000


@pytest.fixture(params=["v1", "v2"])
def native_db(tmp_path, request):
    root = tmp_path / "opencode"
    root.mkdir()
    with closing(sqlite3.connect(root / "opencode.db")) as db:
        if request.param == "v1":
            tables = ("session", "message", "part")
            db.executescript("""
                CREATE TABLE session (
                    id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER
                );
                CREATE TABLE message (
                    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
                    time_created INTEGER, time_updated INTEGER, data TEXT
                );
            """)
        else:
            tables = ("session_v2", "session_message", "session_part")
            db.executescript("""
                CREATE TABLE session_v2 (
                    id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER
                );
                CREATE TABLE session_message (
                    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
                    time_created INTEGER, time_updated INTEGER, data TEXT
                );
                CREATE TABLE session_part (
                    message_id TEXT, session_id TEXT, ordinal INTEGER,
                    time_created INTEGER, time_updated INTEGER, data TEXT
                );
            """)
        yield root, db, tables


def add_session(db, table, identifier, cwd, title):
    db.execute(f"INSERT INTO {table} VALUES (?, ?, ?, ?, ?)", (identifier, cwd, title, TIMESTAMP, TIMESTAMP))


def add_message(db, tables, seq, role, data, *parts, identifier=ID):
    _, messages, part_table = tables
    timestamp = TIMESTAMP + seq
    message_id = f"{identifier}-{seq}"
    if messages == "message":
        data = {"role": role, **data} if isinstance(data, dict) else data
        columns = [message_id, identifier, timestamp, timestamp]
    else:
        columns = [message_id, identifier, role, seq, timestamp, timestamp]
    raw = json.dumps(data) if isinstance(data, dict) else data
    values = (*columns, raw)
    db.execute(f"INSERT INTO {messages} VALUES ({', '.join('?' for _ in values)})", values)
    for ordinal, part in enumerate(parts):
        if part_table == "part":
            part_columns = [f"{message_id}-{ordinal}", message_id, identifier]
        else:
            part_columns = [message_id, identifier, ordinal]
        db.execute(
            f"INSERT INTO {part_table} VALUES (?, ?, ?, ?, ?, ?)",
            (*part_columns, timestamp + ordinal, timestamp + ordinal, json.dumps(part)),
        )


def flatten(records):
    return [entry for entries, _, _ in records for entry in entries]


def test_exact_case_sensitive_identifier_and_unambiguous_terminal_title(native_db):
    root, db, tables = native_db
    session = tables[0]
    assert valid_opencode_session_id(ID)
    for invalid in ("ses_123", ID + "-", ID + "\n", ID.replace("ses_", "SES_", 1)):
        assert not valid_opencode_session_id(invalid)
    add_session(db, session, ID, "/work", "Fixture title")
    add_session(db, session, OTHER, "/other", "Fixture title")
    db.commit()

    assert opencode_session_for_pane(root, "/work", "OC | Fixture title") == ID
    assert opencode_session_for_pane(root, "/work", "OC | fixture title") is None
    assert opencode_session_for_pane(root, "/work", "Fixture title") is None
    assert opencode_session_for_pane(root, "/work", "OpenCode") is None
    assert opencode_session_for_pane(root, "/unknown", "OC | Fixture title") is None
    assert opencode_revision(db, ID.lower()) is None

    db.execute(f"UPDATE {session} SET directory = '/work' WHERE id = ?", (OTHER,))
    db.commit()
    assert opencode_session_for_pane(root, "/work", "OC | Fixture title") is None


def test_terminal_title_truncation_tracks_layout_and_utf16_width(native_db):
    root, db, tables = native_db
    session = tables[0]
    title_prefix = "A" * 34 + "🧪b"
    suffix = "..." if session == "session" else "…"
    add_session(db, session, ID, "/work", title_prefix + "cdefg")
    db.commit()
    assert opencode_session_for_pane(root, "/work", "OC | " + title_prefix + suffix) == ID

    add_session(db, session, OTHER, "/work", title_prefix + "uvwxy")
    db.commit()
    assert opencode_session_for_pane(root, "/work", "OC | " + title_prefix + suffix) is None


def test_transcripts_filter_generated_content_and_distinguish_activity(native_db):
    _, db, tables = native_db
    add_session(db, tables[0], ID, "/work", "Selected conversation")
    add_session(db, tables[0], OTHER, "/work", "Independent conversation")
    add_message(db, tables, 6, "assistant", {"finish": "stop"}, {"type": "text", "text": "Final answer"})
    add_message(db, tables, 5, "assistant", {"time": {"created": TIMESTAMP}}, {
        "type": "text", "text": "Still streaming",
    })
    add_message(db, tables, 4, "assistant", {"finish": "tool-calls"}, {
        "type": "text", "text": "Progress",
    }, {
        "type": "reasoning", "text": "Hidden model reasoning",
    }, {
        "type": "tool", "name" if tables[0] == "session_v2" else "tool": "read",
        "state": {"input": {"path": "fixture.txt"}, "output": "Tool output"},
    })
    if tables[0] == "session":
        add_message(db, tables, 1, "user", {}, {
            "type": "text", "text": "generated context", "synthetic": True,
        }, {
            "type": "text", "text": "  Prompt with indentation",
        }, {
            "type": "text", "text": "ignored", "ignored": True,
        })
    else:
        add_message(db, tables, 2, "synthetic", {"text": "generated context"})
        add_message(db, tables, 1, "user", {"text": "  Prompt with indentation"})
    add_message(db, tables, 0, "user", {"text": "Other conversation"}, identifier=OTHER)

    all_entries = flatten(read_opencode_records(db, ID, offset=0, limit=10, max_record_bytes=8192))
    assert [(entry["kind"], entry["text"]) for entry in all_entries] == [
        ("prompt", "  Prompt with indentation"),
        ("progress", "Progress"),
        ("tool", 'Tool: read\n{"path": "fixture.txt"}\nTool output'),
        ("progress", "Still streaming"),
        ("response", "Final answer"),
    ]
    assert all_entries[0]["timestamp"] == TIMESTAMP + 1
    assert flatten(read_opencode_records(db, ID, offset=1, limit=1, max_record_bytes=8192)) == (
        all_entries[1:3] if tables[0] == "session" else []
    )


def test_record_budget_skips_large_parts_and_malformed_messages(native_db):
    _, db, tables = native_db
    add_session(db, tables[0], ID, "/work", "Selected conversation")
    add_message(db, tables, 1, "assistant", "{")
    add_message(db, tables, 2, "assistant", {"finish": "stop"}, {
        "type": "tool", "state": {"output": "🧪" * 1024},
    }, {"type": "text", "text": "Readable reply"})
    records = list(read_opencode_records(db, ID, offset=0, limit=2, max_record_bytes=300))
    assert [partial for _, _, partial in records] == [True, True]
    assert all(size <= 300 for _, size, _ in records)
    assert [entry["text"] for entry in flatten(records)] == ["Readable reply"]


def test_revision_changes_with_parts_and_ignores_other_conversations(native_db):
    _, db, tables = native_db
    add_session(db, tables[0], ID, "/work", "Selected conversation")
    add_session(db, tables[0], OTHER, "/work", "Independent conversation")
    add_message(db, tables, 1, "assistant", {}, {"type": "text", "text": "First reply"})
    add_message(db, tables, 5, "assistant", {}, {"type": "text", "text": "Newest reply"})
    original = opencode_revision(db, ID)
    add_message(db, tables, 6, "assistant", {}, {"type": "text", "text": "Other reply"}, identifier=OTHER)
    assert opencode_revision(db, ID) == original

    db.execute(
        f"UPDATE {tables[2]} SET time_updated = time_updated + 1 WHERE message_id = ?",
        (f"{ID}-1",),
    )
    assert opencode_revision(db, ID) != original


def test_database_confines_native_file_and_sqlite_companions(tmp_path):
    root = tmp_path / "opencode"
    root.mkdir()
    db = root / "opencode.db"
    assert locate_opencode_db(root) is None
    db.touch()
    assert locate_opencode_db(root) == db
    link = tmp_path / "data-link"
    link.symlink_to(root)
    assert locate_opencode_db(link) == db

    wal = root / "opencode.db-wal"
    wal.symlink_to(tmp_path / "outside")
    with pytest.raises(OSError, match="companion"):
        locate_opencode_db(root)
    wal.unlink()
    db.unlink()
    db.symlink_to(tmp_path / "outside")
    with pytest.raises(OSError, match="not a regular file"):
        locate_opencode_db(root)


def test_partial_schema_is_unsupported():
    with closing(sqlite3.connect(":memory:")) as db:
        db.executescript("CREATE TABLE session(id); CREATE TABLE message(id); CREATE TABLE part(id);")
        with pytest.raises(ValueError, match="format is not supported"):
            opencode_revision(db, ID)
