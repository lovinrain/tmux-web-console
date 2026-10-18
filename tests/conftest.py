from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def test_frontend_assets(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Keep API assets separate from both Vite output and test file fixtures."""
    dist = tmp_path_factory.mktemp("test-frontend")
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Muxdeck test frontend</title>")
    return dist


@pytest.fixture(autouse=True)
def isolate_frontend_assets(monkeypatch: pytest.MonkeyPatch, test_frontend_assets: Path) -> None:
    """API tests must not race Vite replacing the checkout's dist/assets."""
    monkeypatch.setattr("tmux_console.app.DIST", test_frontend_assets)


@pytest.fixture(autouse=True)
def isolate_default_state_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Keep stores created implicitly by API tests away from live user state."""
    state_dir = tmp_path / "default-state"
    monkeypatch.setenv("MUXDECK_TITLES_FILE", str(state_dir / "session-titles.json"))
    monkeypatch.setenv(
        "MUXDECK_MESSAGES_FILE", str(state_dir / "session-messages.json")
    )
    monkeypatch.setenv("MUXDECK_SNIPPETS_FILE", str(state_dir / "snippets.json"))
    monkeypatch.setenv("MUXDECK_WORKSPACES_FILE", str(state_dir / "workspaces.json"))
    monkeypatch.setenv("MUXDECK_CALLBACKS_FILE", str(state_dir / "callbacks.sqlite3"))
    monkeypatch.setenv(
        "MUXDECK_SESSION_REGISTRY_FILE", str(state_dir / "sessions.sqlite3")
    )
    monkeypatch.setenv("MUXDECK_UPLOADS_DIR", str(state_dir / "uploads"))
    monkeypatch.setenv("MUXDECK_SUBMITTED_MESSAGES_FILE", str(state_dir / "submitted-messages.sqlite3"))
    monkeypatch.setenv("MUXDECK_SCROLLBACK_FILE", str(state_dir / "scrollback.sqlite3"))
    monkeypatch.setenv("MUXDECK_LAUNCH_REQUESTS_FILE", str(state_dir / "launch-requests.sqlite3"))
    monkeypatch.setenv("MUXDECK_WORK_LINKS_FILE", str(state_dir / "work-links.sqlite3"))
    monkeypatch.setenv("MUXDECK_NOTE_CAPTURES_FILE", str(state_dir / "note-captures.sqlite3"))
    monkeypatch.setenv("MUXDECK_NOTE_IMAGES_DIR", str(state_dir / "note-images"))
    monkeypatch.delenv("MUXDECK_NOTE_IMAGE_RETENTION_DAYS", raising=False)
    monkeypatch.delenv("MUXDECK_NOTE_IMAGES_MAX_BYTES", raising=False)
    monkeypatch.setenv("MUXDECK_CODEX_HISTORY_FILE", str(state_dir / "codex-history.jsonl"))
    monkeypatch.setenv("MUXDECK_CLAUDE_HISTORY_FILE", str(state_dir / "claude-history.jsonl"))
    for agent in ("CODEX", "CLAUDE", "COPILOT", "CURSOR", "GROK"):
        monkeypatch.setenv(f"MUXDECK_{agent}_TRANSCRIPTS_DIR", str(state_dir / "transcripts" / agent.lower()))
    monkeypatch.delenv("MUXDECK_AUTH_FILE", raising=False)
    monkeypatch.delenv("MUXDECK_AUTH_MODE", raising=False)
    monkeypatch.delenv("MUXDECK_AUTH_COOKIE_SECURE", raising=False)
    monkeypatch.delenv("MUXDECK_CALLBACK_TOKEN_FILE", raising=False)
    monkeypatch.delenv("MUXDECK_CONTROL_TOKEN_FILE", raising=False)
