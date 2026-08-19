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
SESSION_METADATA_SCHEMA_VERSION = 4
SESSION_METADATA_UNAVAILABLE_MESSAGE = (
    "session metadata is unavailable; repair the configured metadata file and restart Muxdeck"
)
SESSION_TAGS = (
    "work",
    "review",
    "research",
    "urgent",
    "blocked",
    "background",
)
SESSION_TAG_SET = frozenset(SESSION_TAGS)


class SessionMetadataUnavailable(OSError):
    pass


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


def normalize_tags(value: object) -> list[str]:
    if not isinstance(value, list):
        raise TypeError("tags must be an array")
    if any(not isinstance(tag, str) for tag in value):
        raise TypeError("tags must contain only strings")
    unknown = sorted(set(value) - SESSION_TAG_SET)
    if unknown:
        raise ValueError(f"unknown session tag: {unknown[0]}")
    selected = set(value)
    return [tag for tag in SESSION_TAGS if tag in selected]


class SessionTitleStore:
    def __init__(self, path: Path | None = None):
        self.path = path or default_titles_path()
        self._lock = threading.RLock()
        self._load_error: str | None = None
        self._titles, self._starred, self._ignored, self._tags = self._load()

    def _load(
        self,
    ) -> tuple[dict[str, str], set[str], set[str], dict[str, set[str]]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}, set(), set(), {}
        except (OSError, json.JSONDecodeError) as error:
            self._record_load_error(error)
            return {}, set(), set(), {}

        if not isinstance(payload, dict):
            self._record_load_error(TypeError("document must be an object"))
            return {}, set(), set(), {}
        version = payload.get("version")
        if (
            isinstance(version, bool)
            or not isinstance(version, int)
            or version < 1
            or version > SESSION_METADATA_SCHEMA_VERSION
        ):
            self._record_load_error(ValueError("unsupported document version"))
            return {}, set(), set(), {}

        validation_errors: list[str] = []
        records = payload.get("titles", {})
        if not isinstance(records, dict):
            validation_errors.append("titles must be an object")
            records = {}
        titles: dict[str, str] = {}
        for name, title in records.items():
            if not isinstance(name, str) or not name or not isinstance(title, str):
                validation_errors.append(
                    "titles must map non-empty string names to strings"
                )
                continue
            try:
                normalized = normalize_title(title)
            except ValueError:
                validation_errors.append("titles contain an invalid title")
                continue
            if normalized is not None:
                titles[name] = normalized
            else:
                validation_errors.append("titles cannot contain blank titles")
        starred_records = payload.get("starred", [])
        if not isinstance(starred_records, list):
            validation_errors.append("starred must be an array")
            starred_records = []
        if any(not isinstance(name, str) or not name for name in starred_records):
            validation_errors.append("starred must contain non-empty strings")
        starred = {
            name for name in starred_records if isinstance(name, str) and name
        }
        ignored_records = payload.get("ignored", [])
        if not isinstance(ignored_records, list):
            validation_errors.append("ignored must be an array")
            ignored_records = []
        if any(not isinstance(name, str) or not name for name in ignored_records):
            validation_errors.append("ignored must contain non-empty strings")
        ignored = {
            name for name in ignored_records if isinstance(name, str) and name
        }
        # Never silently hide a starred session if a hand-edited file overlaps.
        ignored.difference_update(starred)
        tag_records = payload.get("tags", {})
        tags: dict[str, set[str]] = {}
        if not isinstance(tag_records, dict):
            validation_errors.append("tags must be an object")
        else:
            for name, values in tag_records.items():
                if not isinstance(name, str) or not name or not isinstance(values, list):
                    validation_errors.append(
                        "tags must map non-empty string names to arrays"
                    )
                    continue
                if any(
                    not isinstance(value, str) or value not in SESSION_TAG_SET
                    for value in values
                ):
                    validation_errors.append(
                        "tags must contain only predefined tag strings"
                    )
                normalized_tags = {
                    value
                    for value in values
                    if isinstance(value, str) and value in SESSION_TAG_SET
                }
                if normalized_tags:
                    tags[name] = normalized_tags
        if validation_errors:
            self._record_load_error(ValueError("; ".join(dict.fromkeys(validation_errors))))
        return titles, starred, ignored, tags

    def _record_load_error(self, error: BaseException) -> None:
        self._load_error = f"{type(error).__name__}: {error}"
        LOGGER.error(
            "Session metadata writes are disabled because %s could not be loaded: %s. "
            "Repair the file and restart Muxdeck before accepting more writes.",
            self.path,
            error,
        )

    def _ensure_available(self) -> None:
        if self._load_error is not None:
            raise SessionMetadataUnavailable(SESSION_METADATA_UNAVAILABLE_MESSAGE)

    def get_title(self, session_name: str) -> str | None:
        with self._lock:
            return self._titles.get(session_name)

    def is_starred(self, session_name: str) -> bool:
        with self._lock:
            return session_name in self._starred

    def is_ignored(self, session_name: str) -> bool:
        with self._lock:
            return session_name in self._ignored

    def get_tags(self, session_name: str) -> list[str]:
        with self._lock:
            tags = self._tags.get(session_name, set())
            return [tag for tag in SESSION_TAGS if tag in tags]

    def set_title(self, session_name: str, value: str) -> str | None:
        title = normalize_title(value)
        with self._lock:
            titles = self._titles.copy()
            if title is None:
                titles.pop(session_name, None)
            else:
                titles[session_name] = title
            self._persist(titles, self._starred, self._ignored, self._tags)
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
            self._persist(
                self._titles, starred_sessions, ignored_sessions, self._tags
            )
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
            self._persist(
                self._titles, starred_sessions, ignored_sessions, self._tags
            )
            self._starred = starred_sessions
            self._ignored = ignored_sessions
        return ignored

    def set_tags(self, session_name: str, values: list[str]) -> list[str]:
        normalized_list = normalize_tags(values)
        normalized = set(normalized_list)
        with self._lock:
            tags = {name: stored.copy() for name, stored in self._tags.items()}
            if normalized:
                tags[session_name] = normalized
            else:
                tags.pop(session_name, None)
            self._persist(self._titles, self._starred, self._ignored, tags)
            self._tags = tags
        return normalized_list

    def set_details(
        self, session_name: str, title_value: str, tag_values: list[str]
    ) -> tuple[str | None, list[str]]:
        title = normalize_title(title_value)
        tag_list = normalize_tags(tag_values)
        normalized_tags = set(tag_list)
        with self._lock:
            titles = self._titles.copy()
            tags = {name: stored.copy() for name, stored in self._tags.items()}
            if title is None:
                titles.pop(session_name, None)
            else:
                titles[session_name] = title
            if normalized_tags:
                tags[session_name] = normalized_tags
            else:
                tags.pop(session_name, None)
            self._persist(titles, self._starred, self._ignored, tags)
            self._titles = titles
            self._tags = tags
        return title, tag_list

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

            tags = {name: stored.copy() for name, stored in self._tags.items()}
            previous_tags = tags.pop(current_name, None)
            tags.pop(new_name, None)
            if previous_tags:
                tags[new_name] = previous_tags

            self._persist(titles, starred, ignored, tags)
            self._titles = titles
            self._starred = starred
            self._ignored = ignored
            self._tags = tags

    def _persist(
        self,
        titles: dict[str, str],
        starred: set[str],
        ignored: set[str],
        tags: dict[str, set[str]],
    ) -> None:
        self._ensure_available()
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
                        "version": SESSION_METADATA_SCHEMA_VERSION,
                        "titles": titles,
                        "starred": sorted(starred),
                        "ignored": sorted(ignored),
                        "tags": {
                            name: [tag for tag in SESSION_TAGS if tag in values]
                            for name, values in sorted(tags.items())
                            if values
                        },
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
