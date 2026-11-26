"""Locate recorded Pi and Oh My Pi sessions by their exact native IDs."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, BinaryIO

_SESSION_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_MAX_SESSION_ID_LENGTH = 256
_MAX_LOOKUP_ENTRIES = 50_000


def valid_pi_session_id(identifier: str) -> bool:
    return (
        isinstance(identifier, str)
        and len(identifier) <= _MAX_SESSION_ID_LENGTH
        and _SESSION_ID.fullmatch(identifier) is not None
    )


def pi_session_header(record: object, identifier: str) -> bool:
    return (
        isinstance(record, dict)
        and record.get("type") == "session"
        and valid_pi_session_id(identifier)
        and record.get("id") == identifier
    )


def read_pi_session_header(source: BinaryIO, *, allow_title: bool = False) -> dict[str, Any] | None:
    """Read the identity row, allowing OMP's optional title reservation."""
    try:
        for index in range(2 if allow_title else 1):
            line = source.readline(65_537)
            if not line.endswith(b"\n") or len(line) > 65_536:
                return None
            record = json.loads(line)
            if not isinstance(record, dict):
                return None
            if index == 0 and allow_title and record.get("type") == "title" and record.get("v") == 1:
                continue
            return record if record.get("type") == "session" else None
    except (ValueError, RecursionError):
        return None
    return None


def locate_pi_session(root: Path, identifier: str) -> Path | None:
    """Search the configured session root and its project directories.

    A custom root can store journals directly. Default roots have one directory
    per project. Matching the entire ID after the timestamp avoids treating
    an underscore in a custom ID as part of the filename separator.
    """
    if not valid_pi_session_id(identifier):
        return None

    filename_tail = f"{identifier}.jsonl"
    pending = [root]
    found = None
    visited = 0
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > _MAX_LOOKUP_ENTRIES:
                        return None
                    if directory == root and entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    elif (
                        entry.name.partition("_")[2] == filename_tail
                        and entry.is_file(follow_symlinks=False)
                    ):
                        if found is not None:
                            return None
                        found = Path(entry.path)
    except FileNotFoundError:
        # A concurrent move can hide another candidate. Retry on the next read.
        return None
    return found
