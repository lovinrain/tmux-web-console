from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_default_state_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Keep stores created implicitly by API tests away from live user state."""
    state_dir = tmp_path / "default-state"
    monkeypatch.setenv("MUXDECK_TITLES_FILE", str(state_dir / "session-titles.json"))
    monkeypatch.setenv("MUXDECK_MESSAGES_FILE", str(state_dir / "session-messages.json"))
    monkeypatch.setenv("MUXDECK_SNIPPETS_FILE", str(state_dir / "snippets.json"))
    monkeypatch.setenv("MUXDECK_WORKSPACES_FILE", str(state_dir / "workspaces.json"))
    monkeypatch.setenv("MUXDECK_UPLOADS_DIR", str(state_dir / "uploads"))
