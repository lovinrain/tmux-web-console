from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
from pathlib import Path


LOGGER = logging.getLogger("muxdeck.metadata")
MAX_TITLE_LENGTH = 80


def default_titles_path() -> Path:
    configured = os.environ.get("MUXDECK_TITLES_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "session-titles.json"


def normalize_title(value: str) -> str | None:
    title = value.strip()
    if not title:
        return None
    if len(title) > MAX_TITLE_LENGTH:
        raise ValueError(f"title must be {MAX_TITLE_LENGTH} characters or fewer")
    if any(ord(character) < 32 or ord(character) == 127 for character in title):
        raise ValueError("title cannot contain control characters")
    return title


class SessionTitleStore:
    def __init__(self, path: Path | None = None):
        self.path = path or default_titles_path()
        self._lock = threading.RLock()
        self._titles, self._starred, self._ignored = self._load()

    def _load(self) -> tuple[dict[str, str], set[str], set[str]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}, set(), set()
        except (OSError, json.JSONDecodeError) as error:
            LOGGER.warning("Unable to read session titles from %s: %s", self.path, error)
            return {}, set(), set()

        records = payload.get("titles", {}) if isinstance(payload, dict) else {}
        if not isinstance(records, dict):
            records = {}
        titles: dict[str, str] = {}
        for name, title in records.items():
            if not isinstance(name, str) or not isinstance(title, str):
                continue
            try:
                normalized = normalize_title(title)
            except ValueError:
                continue
            if normalized is not None:
                titles[name] = normalized
        starred_records = payload.get("starred", []) if isinstance(payload, dict) else []
        starred = (
            {name for name in starred_records if isinstance(name, str) and name}
            if isinstance(starred_records, list)
            else set()
        )
        ignored_records = payload.get("ignored", []) if isinstance(payload, dict) else []
        ignored = (
            {name for name in ignored_records if isinstance(name, str) and name}
            if isinstance(ignored_records, list)
            else set()
        )
        # Never silently hide a starred session if a hand-edited file overlaps.
        ignored.difference_update(starred)
        return titles, starred, ignored

    def get_title(self, session_name: str) -> str | None:
        with self._lock:
            return self._titles.get(session_name)

    def is_starred(self, session_name: str) -> bool:
        with self._lock:
            return session_name in self._starred

    def is_ignored(self, session_name: str) -> bool:
        with self._lock:
            return session_name in self._ignored

    def set_title(self, session_name: str, value: str) -> str | None:
        title = normalize_title(value)
        with self._lock:
            titles = self._titles.copy()
            if title is None:
                titles.pop(session_name, None)
            else:
                titles[session_name] = title
            self._persist(titles, self._starred, self._ignored)
            self._titles = titles
        return title

    def set_starred(self, session_name: str, starred: bool) -> bool:
        with self._lock:
            starred_sessions = self._starred.copy()
            ignored_sessions = self._ignored.copy()
            if starred:
                starred_sessions.add(session_name)
                ignored_sessions.discard(session_name)
            else:
                starred_sessions.discard(session_name)
            self._persist(self._titles, starred_sessions, ignored_sessions)
            self._starred = starred_sessions
            self._ignored = ignored_sessions
        return starred

    def set_ignored(self, session_name: str, ignored: bool) -> bool:
        with self._lock:
            ignored_sessions = self._ignored.copy()
            starred_sessions = self._starred.copy()
            if ignored:
                ignored_sessions.add(session_name)
                starred_sessions.discard(session_name)
            else:
                ignored_sessions.discard(session_name)
            self._persist(self._titles, starred_sessions, ignored_sessions)
            self._starred = starred_sessions
            self._ignored = ignored_sessions
        return ignored

    def rename_session(self, current_name: str, new_name: str) -> None:
        if current_name == new_name:
            raise ValueError("new session name must differ from current session name")

        with self._lock:
            titles = self._titles.copy()
            title = titles.pop(current_name, None)
            titles.pop(new_name, None)
            if title is not None:
                titles[new_name] = title

            starred = self._starred.copy()
            was_starred = current_name in starred
            starred.discard(current_name)
            starred.discard(new_name)
            if was_starred:
                starred.add(new_name)

            ignored = self._ignored.copy()
            was_ignored = current_name in ignored
            ignored.discard(current_name)
            ignored.discard(new_name)
            if was_ignored and not was_starred:
                ignored.add(new_name)

            self._persist(titles, starred, ignored)
            self._titles = titles
            self._starred = starred
            self._ignored = ignored

    def _persist(
        self, titles: dict[str, str], starred: set[str], ignored: set[str]
    ) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(
                    {
                        "version": 3,
                        "titles": titles,
                        "starred": sorted(starred),
                        "ignored": sorted(ignored),
                    },
                    handle,
                    indent=2,
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
