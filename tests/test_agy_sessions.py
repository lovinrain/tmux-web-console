from __future__ import annotations

import sqlite3
from contextlib import closing

import pytest

from tmux_console.agy_sessions import agy_revision, locate_agy_db, read_agy_records

ID = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
CREATED_AT = 1_767_225_600_123


def varint(number):
    data = bytearray()
    while number >= 128:
        data.append((number & 127) | 128)
        number >>= 7
    data.append(number)
    return bytes(data)


def field(number, value):
    if isinstance(value, int):
        return varint(number << 3) + varint(value)
    if isinstance(value, str):
        value = value.encode("utf-8")
    return varint(number << 3 | 2) + varint(len(value)) + value


def step(idx, step_type, number, value, *, source=4, metadata=b"", step_format=0):
    timestamp = field(1, CREATED_AT // 1000) + field(2, 123_000_000)
    metadata = field(1, timestamp) + field(3, source) + metadata
    payload = field(1, step_type) + field(4, 3) + field(5, metadata) + field(number, value)
    return idx, step_type, 3, metadata, payload, step_format


def database(root, records=(), identifier=ID):
    path = root / "conversations" / f"{ID}.db"
    path.parent.mkdir(exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT);
            CREATE TABLE steps (
                idx INTEGER PRIMARY KEY,
                step_type INTEGER NOT NULL,
                status INTEGER NOT NULL,
                metadata BLOB,
                step_payload BLOB,
                step_format INTEGER NOT NULL
            );
        """)
        db.execute("INSERT INTO trajectory_meta VALUES (?, ?)", (OTHER, identifier))
        db.executemany("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)", records)
    return path


def test_agy_reads_visible_entries_from_the_ordered_native_steps(tmp_path):
    call = field(2, "read_file") + field(3, '{"path":"README.md"}')
    records = [
        step(18, 15, 20, field(8, "Edited answer") + field(1, "Original answer") + field(3, "private thought")),
        step(17, 132, 140, field(2, field(1, "Sample tool result")), metadata=field(4, call)),
        step(15, 101, 114, field(1, "internal housekeeping")),
        step(13, 15, 20, field(1, "I will check the README.") + field(7, call)),
        step(10, 14, 19, field(2, "My real input")),
        step(9, 14, 19, field(2, "system generated input"), source=5),
        step(21, 17, 24, field(3, field(1, "Visible failure") + field(3, "private failure detail")) + field(5, 1)),
        step(23, 17, 24, field(3, field(1, "private failure"))),
    ]
    path = database(tmp_path, records)
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        assert agy_revision(db, ID)
        rows = list(read_agy_records(db, ID, offset=0, limit=20, max_record_bytes=4096))
        assert len(rows) == len(records)
        assert not any(partial for _, _, partial in rows)
        messages = [message for entries, _, _ in rows for message in entries]
        assert [(entry["role"], entry["kind"], entry["text"]) for entry in messages] == [
            ("user", "prompt", "My real input"),
            ("assistant", "progress", "I will check the README."),
            ("tool", "tool", 'Tool: read_file\n{"path":"README.md"}\n\nSample tool result'),
            ("assistant", "response", "Edited answer"),
            ("assistant", "context", "Visible failure"),
        ]
        assert {message["timestamp"] for message in messages} == {CREATED_AT}
        assert list(read_agy_records(db, ID, offset=4, limit=2, max_record_bytes=4096)) == rows[4:6]


def test_agy_requires_the_recorded_conversation_identity(tmp_path):
    path = database(tmp_path, identifier=OTHER)
    assert locate_agy_db(tmp_path, ID) == path
    assert locate_agy_db(tmp_path, OTHER) is None
    assert locate_agy_db(tmp_path, f"../{ID}") is None
    with closing(sqlite3.connect(path)) as db:
        assert agy_revision(db, ID) is None
        assert list(read_agy_records(db, ID, offset=0, limit=10, max_record_bytes=4096)) == []
        db.execute("INSERT INTO trajectory_meta VALUES (?, ?)", (ID, ID))
        assert agy_revision(db, ID) is None


def test_agy_refuses_linked_native_storage(tmp_path):
    path = database(tmp_path)
    previous = path.with_suffix(".original")
    path.rename(previous)
    path.symlink_to(previous)
    with pytest.raises(OSError, match="linked Antigravity transcript"):
        locate_agy_db(tmp_path, ID)


def test_agy_reads_past_unreadable_or_oversized_steps(tmp_path):
    path = database(tmp_path, [
        step(0, 14, 19, field(2, "x" * 4096)),
        (1, 14, 3, b"", b"\x80", 0),
        step(2, 14, 19, field(2, "Unknown format"), step_format=1),
        step(3, 14, 19, field(3, field(1, "Older ")) + field(3, field(1, "input")) + field(9, b"media"), source=0),
    ])
    with closing(sqlite3.connect(path)) as db:
        rows = list(read_agy_records(db, ID, offset=0, limit=4, max_record_bytes=256))
    assert rows[0] == ([], 0, True)
    assert rows[1] == ([], 1, True)
    assert rows[2][0] == [] and rows[2][2]
    assert rows[3][0][0]["text"] == "Older input\n\n[Attachments]"
    assert not rows[3][2]


def test_agy_revision_and_records_include_committed_wal_updates(tmp_path):
    path = database(tmp_path)
    with closing(sqlite3.connect(path)) as writer:
        assert writer.execute("PRAGMA journal_mode = WAL").fetchone()[0] == "wal"
        for text in ("One answer", "New answer"):
            record = step(0, 15, 20, field(1, text))
            with writer:
                writer.execute("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?, ?, ?)", record)
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as reader:
                reader.execute("BEGIN")
                revision = agy_revision(reader, ID)
                entries, _, partial = next(read_agy_records(reader, ID, offset=0, limit=1, max_record_bytes=4096))
                assert entries[0]["text"] == text
                assert not partial
                if text == "One answer":
                    first_revision = revision
                else:
                    assert revision != first_revision
