from __future__ import annotations

import hashlib
import shutil
import sqlite3
import stat
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backup_scrollback.py"


def backup(source, output):
    return subprocess.run([sys.executable, SCRIPT, source, output], capture_output=True, text=True, check=False)


@pytest.mark.skipif(shutil.which("zstd") is None, reason="Compressed backups require zstd")
def test_snapshot_includes_uncheckpointed_rows_and_verifies_restored_bytes(tmp_path):
    source = tmp_path / "live scrollback.sqlite3"
    archive = tmp_path / "snapshot.sqlite3.zst"
    restored = tmp_path / "restored.sqlite3"
    with closing(sqlite3.connect(source)) as live:
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("PRAGMA wal_autocheckpoint=0")
        live.execute("CREATE TABLE scrollback (output TEXT)")
        live.execute("INSERT INTO scrollback VALUES ('latest pane output')")
        live.commit()
        result = backup(source, archive)
        assert result.returncode == 0, result.stderr

    with restored.open("wb") as stream:
        subprocess.run(["zstd", "-qdc", "--", archive], stdout=stream, check=True)
    assert result.stdout.strip() == hashlib.sha256(restored.read_bytes()).hexdigest()
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    with closing(sqlite3.connect(restored)) as db:
        assert db.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert db.execute("SELECT output FROM scrollback").fetchall() == [("latest pane output",)]


def test_refuses_unrelated_database_and_existing_archive(tmp_path):
    source = tmp_path / "unrelated.sqlite3"
    archive = tmp_path / "snapshot.sqlite3.zst"
    with closing(sqlite3.connect(source)) as db:
        db.execute("CREATE TABLE unrelated (id INTEGER)")
    result = backup(source, archive)
    assert result.returncode != 0
    assert "integrity check" in result.stderr
    assert not archive.exists()

    archive.write_bytes(b"existing backup")
    result = backup(source, archive)
    assert result.returncode != 0
    assert archive.read_bytes() == b"existing backup"
