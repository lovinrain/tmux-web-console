"""Common native transcript roots and conversation IDs."""
from __future__ import annotations

import os
import re
from pathlib import Path

from .opencode_sessions import valid_opencode_session_id
from .pi_sessions import valid_pi_session_id

UUID_PATTERN = re.compile(
    r"(?<![0-9a-f])"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(?![0-9a-f])",
    re.IGNORECASE,
)
EXTENDED_TRANSCRIPT_AGENTS = frozenset({"pi", "omp", "opencode", "agy"})


def default_extended_transcript_roots() -> dict[str, Path]:
    home = Path.home()
    data = os.environ.get("XDG_DATA_HOME")
    defaults = {
        "pi": home / ".pi" / "agent" / "sessions",
        "omp": home / ".omp" / "agent" / "sessions",
        "opencode": (Path(data) if data else home / ".local" / "share") / "opencode",
        "agy": home / ".gemini" / "antigravity-cli",
    }
    return {
        agent: Path(os.environ.get(f"MUXDECK_{agent.upper()}_TRANSCRIPTS_DIR", root))
        for agent, root in defaults.items()
    }


def normalize_agent_session_id(agent: str | None, identifier: object) -> str | None:
    if not isinstance(identifier, str):
        return None
    if agent in {"pi", "omp"}:
        return identifier if valid_pi_session_id(identifier) else None
    if agent == "opencode":
        return identifier if valid_opencode_session_id(identifier) else None
    return identifier.lower() if UUID_PATTERN.fullmatch(identifier) else None
