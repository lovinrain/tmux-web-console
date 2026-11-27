#!/usr/bin/env python3
"""Take and verify an opt-in compressed SQLite scrollback snapshot."""

from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_digest(path: Path, *, zstd: str = "zstd") -> str:
    digest = hashlib.sha256()
    with subprocess.Popen([zstd, "-qdc", "--", str(path)], stdout=subprocess.PIPE) as process:
        assert process.stdout is not None
        while chunk := process.stdout.read(1024 * 1024):
            digest.update(chunk)
        if process.wait() != 0:
            raise ValueError(f"Could not decompress {path}")
    return digest.hexdigest()


def compress_verified(source: Path, output: Path, *, zstd: str = "zstd") -> str:
    """Publish a private archive only after checking its restored bytes."""
    if output.suffix != ".zst":
        raise ValueError("The archive path must end in .zst")
    if os.path.lexists(output):
        raise FileExistsError(output)
    digest = sha256(source)
    with TemporaryDirectory(prefix=".scrollback-", dir=output.parent) as temp:
        archive = Path(temp) / "snapshot.zst"
        with archive.open("wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            subprocess.run([zstd, "-qc", "--", str(source)], stdout=stream, check=True)
            stream.flush()
            os.fsync(stream.fileno())
        if archive_digest(archive, zstd=zstd) != digest:
            raise ValueError("The archive does not restore to the original bytes")
        os.link(archive, output)
        directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    return digest


def backup_scrollback(source: Path, output: Path) -> str:
    source = source.resolve(strict=True)
    if not source.is_file():
        raise ValueError("The source must be a scrollback database file")
    if os.path.lexists(output):
        raise FileExistsError(output)
    with TemporaryDirectory(prefix=".scrollback-", dir=output.parent) as temp:
        snapshot = Path(temp) / "snapshot.sqlite3"
        with (
            closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as live,
            closing(sqlite3.connect(snapshot)) as backup,
        ):
            live.backup(backup, pages=512)
            table = backup.execute(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'scrollback'"
            ).fetchone()
            if table is None or backup.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise ValueError("The snapshot did not pass the scrollback integrity check")
        return compress_verified(snapshot, output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Configured scrollback database")
    parser.add_argument("output", type=Path, help="New .zst file in a private backup directory")
    args = parser.parse_args()
    try:
        print(backup_scrollback(args.source, args.output))
    except (OSError, ValueError, sqlite3.Error, subprocess.CalledProcessError) as error:
        print(f"Scrollback backup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
