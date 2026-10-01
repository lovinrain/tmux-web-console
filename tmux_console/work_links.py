"""Native session work links. Provider access and refresh belong to the agent.

Metadata/notes and status reports have independent optimistic revisions. Nothing
in this module opens a link, runs access instructions, or contacts a provider.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

PROVIDERS = ("github", "jira", "google_docs")
STATUS_TONES = ("neutral", "info", "success", "warning", "danger")
MAX_LINKS_PER_SESSION = 32
MAX_NOTES = 32_000
MAX_INSTRUCTIONS = 8_000
MAX_STATUS_SUMMARY = 8_000
UNAVAILABLE = "work links are unavailable; repair the configured work-links database"
LOGGER = logging.getLogger("muxdeck.work_links")


class WorkLinksUnavailable(OSError):
    pass


class WorkLinkNotFound(KeyError):
    pass


class WorkLinkConflict(ValueError):
    pass


class WorkLinksDisabled(WorkLinkConflict):
    pass


def default_work_links_path(registry_path: Path) -> Path:
    return Path(os.environ.get(
        "MUXDECK_WORK_LINKS_FILE", str(registry_path.with_name("work-links.sqlite3")),
    )).expanduser()


def object_fields(value: Any, allowed: set[str], required: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("request must be an object")
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"unknown field: {min(str(key) for key in unknown)}")
    missing = (required or set()) - set(value)
    if missing:
        raise ValueError(f"{min(missing)} is required")
    return value


def text_field(value: Any, name: str, maximum: int, *, multiline: bool = False, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{name} must be text with at most {maximum} characters")
    if any((ord(char) < 32 and not (multiline and char in "\n\r\t"))
           or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(f"{name} contains control characters")
    result = value if multiline else value.strip()
    if required and not result:
        raise ValueError(f"{name} cannot be empty")
    return result


def revision_field(value: Any, name: str = "expectedRevision") -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def link_url(value: Any) -> str:
    url = text_field(value, "url", 2048, required=True)
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in {"https", "http"} and parsed.hostname
                 and not parsed.username and not parsed.password and "@" not in parsed.netloc)
        _ = parsed.port
    except ValueError:
        valid = False
    if not valid or any(char.isspace() or char == "\\" for char in url):
        raise ValueError("url must be an absolute HTTP(S) link without credentials or whitespace")
    return url


def default_label(provider: str, url: str) -> str:
    if provider == "google_docs":
        return "Google Doc"
    path = unquote(urlsplit(url).path)
    if provider == "github":
        match = re.search(r"/pull/(\d+)(?:/|$)", path)
        return f"PR #{match[1]}" if match else "GitHub PR"
    match = re.search(r"/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:/|$)", path)
    return match[1] if match else "Jira ticket"


def default_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "providers": {
            provider: {"enabled": True, "refreshEnabled": False,
                       "refreshIntervalSeconds": 300, "instructions": ""}
            for provider in PROVIDERS
        },
    }


def validate_config_patch(current: dict[str, Any], patch: Any) -> dict[str, Any]:
    object_fields(patch, {"enabled", "providers"})
    result = copy.deepcopy(current)
    if "enabled" in patch:
        if type(patch["enabled"]) is not bool:
            raise ValueError("enabled must be a boolean")
        result["enabled"] = patch["enabled"]
    if "providers" in patch:
        providers = object_fields(patch["providers"], set(PROVIDERS))
        for provider, changes in providers.items():
            object_fields(changes, {"enabled", "refreshEnabled", "refreshIntervalSeconds", "instructions"})
            for field, value in changes.items():
                if field in {"enabled", "refreshEnabled"}:
                    if type(value) is not bool:
                        raise ValueError(f"{field} must be a boolean")
                elif field == "refreshIntervalSeconds":
                    if type(value) is not int or not 30 <= value <= 86400:
                        raise ValueError("refreshIntervalSeconds must be an integer from 30 to 86400")
                else:
                    value = text_field(value, "instructions", MAX_INSTRUCTIONS, multiline=True)
                result["providers"][provider][field] = value
    return result


class WorkLinkStore:
    def __init__(self, path: Path, *, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self._clock = clock
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        self._summary_cache: dict[str, Any] | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._connection = sqlite3.connect(path, timeout=5)
            self._connection.row_factory = sqlite3.Row
            connection = self._connection
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise sqlite3.DatabaseError("unsupported work-links schema")
            with connection:
                connection.execute("""CREATE TABLE IF NOT EXISTS settings (
                    id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL,
                    revision INTEGER NOT NULL, change_revision INTEGER NOT NULL
                )""")
                connection.execute("INSERT OR IGNORE INTO settings VALUES (1, ?, 0, 0)",
                                   (json.dumps(default_config()),))
                connection.execute("""CREATE TABLE IF NOT EXISTS links (
                    id TEXT PRIMARY KEY, history_id TEXT NOT NULL, provider TEXT NOT NULL,
                    url TEXT NOT NULL, metadata TEXT NOT NULL, revision INTEGER NOT NULL,
                    status TEXT, status_revision INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    status_updated_at INTEGER,
                    UNIQUE(history_id, provider, url)
                )""")
                connection.execute("CREATE INDEX IF NOT EXISTS links_history ON links(history_id, created_at)")
                connection.execute("PRAGMA user_version=1")
            os.chmod(path, 0o600)
            self.config()
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            LOGGER.exception("Unable to load work links")
            self.close()

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    @contextmanager
    def _database(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            if self._connection is None:
                raise WorkLinksUnavailable(UNAVAILABLE)
            try:
                with self._connection:
                    yield self._connection
            except sqlite3.Error as error:
                raise WorkLinksUnavailable(UNAVAILABLE) from error

    def config(self) -> dict[str, Any]:
        with self._database() as connection:
            row = connection.execute("SELECT config, revision FROM settings WHERE id=1").fetchone()
            try:
                raw = json.loads(row["config"])
                object_fields(raw, {"enabled", "providers"}, {"enabled", "providers"})
                if set(raw["providers"]) != set(PROVIDERS):
                    raise ValueError("missing provider settings")
                config = validate_config_patch(default_config(), raw)
                return {**config, "revision": row["revision"]}
            except (ValueError, TypeError, KeyError) as error:
                raise WorkLinksUnavailable(UNAVAILABLE) from error

    def _changed(self, connection: sqlite3.Connection) -> None:
        connection.execute("UPDATE settings SET change_revision=change_revision+1 WHERE id=1")
        self._summary_cache = None

    def update_config(self, payload: Any) -> dict[str, Any]:
        object_fields(payload, {"enabled", "providers", "expectedRevision"}, {"expectedRevision"})
        expected = revision_field(payload["expectedRevision"])
        with self._database() as connection:
            current = self.config()
            if expected != current.pop("revision"):
                raise WorkLinkConflict("configuration changed; read it again before saving")
            updated = validate_config_patch(current, {k: v for k, v in payload.items() if k != "expectedRevision"})
            connection.execute("UPDATE settings SET config=?, revision=revision+1 WHERE id=1", (json.dumps(updated),))
            self._changed(connection)
        return self.config()

    def _require_enabled(self, provider: str, *, refresh: bool = False) -> None:
        config = self.config()
        if not config["enabled"] or not config["providers"][provider]["enabled"]:
            raise WorkLinksDisabled(f"{provider} work links are disabled in configuration")
        if refresh and not config["providers"][provider]["refreshEnabled"]:
            raise WorkLinksDisabled(f"{provider} status refresh is disabled in configuration")

    @staticmethod
    def _record(row: sqlite3.Row) -> dict[str, Any]:
        try:
            return {"id": row["id"], "historyId": row["history_id"],
                    "provider": row["provider"], "url": row["url"],
                    **json.loads(row["metadata"]), "revision": row["revision"],
                    "status": json.loads(row["status"]) if row["status"] else None,
                    "statusRevision": row["status_revision"],
                    "createdAt": row["created_at"], "updatedAt": row["updated_at"],
                    "statusUpdatedAt": row["status_updated_at"]}
        except (TypeError, ValueError) as error:
            raise WorkLinksUnavailable(UNAVAILABLE) from error

    def get(self, link_id: str) -> dict[str, Any]:
        with self._database() as connection:
            row = connection.execute("SELECT * FROM links WHERE id=?", (link_id,)).fetchone()
            if row is None:
                raise WorkLinkNotFound("work link not found")
            return self._record(row)

    def list(self, history_id: str) -> list[dict[str, Any]]:
        with self._database() as connection:
            return [self._record(row) for row in connection.execute(
                "SELECT * FROM links WHERE history_id=? ORDER BY created_at, id", (history_id,),
            )]

    def create(self, history_id: str, payload: Any) -> tuple[dict[str, Any], bool]:
        object_fields(payload, {"provider", "url", "label", "title", "notes", "instructions"}, {"provider", "url"})
        provider = payload["provider"]
        if provider not in PROVIDERS:
            raise ValueError("provider must be github, jira, or google_docs")
        url = link_url(payload["url"])
        metadata = {"label": default_label(provider, url), "title": "", "notes": "", "instructions": ""}
        metadata.update(self._metadata_patch(payload, create=True))
        with self._database() as connection:
            self._require_enabled(provider)
            existing = connection.execute("SELECT * FROM links WHERE history_id=? AND provider=? AND url=?",
                                          (history_id, provider, url)).fetchone()
            if existing is not None:
                return self._record(existing), False
            count = connection.execute("SELECT count(*) FROM links WHERE history_id=?", (history_id,)).fetchone()[0]
            if count >= MAX_LINKS_PER_SESSION:
                raise WorkLinkConflict(f"a session can have at most {MAX_LINKS_PER_SESSION} work links")
            link_id, now = str(uuid.uuid4()), int(self._clock())
            connection.execute("INSERT INTO links VALUES (?, ?, ?, ?, ?, 1, NULL, 0, ?, ?, NULL)",
                               (link_id, history_id, provider, url, json.dumps(metadata), now, now))
            self._changed(connection)
        return self.get(link_id), True

    @staticmethod
    def _metadata_patch(payload: dict[str, Any], *, create: bool = False) -> dict[str, str]:
        changes = {}
        for field, maximum in (("label", 80), ("title", 240), ("notes", MAX_NOTES), ("instructions", MAX_INSTRUCTIONS)):
            if field in payload:
                changes[field] = text_field(payload[field], field, maximum,
                                           multiline=field in {"notes", "instructions"}, required=field == "label")
        if not create and "url" in payload:
            changes["url"] = link_url(payload["url"])
        return changes

    def update(self, link_id: str, payload: Any) -> dict[str, Any]:
        object_fields(payload, {"expectedRevision", "url", "label", "title", "notes", "instructions"}, {"expectedRevision"})
        expected = revision_field(payload["expectedRevision"])
        changes = self._metadata_patch(payload)
        with self._database() as connection:
            current = self.get(link_id)
            self._require_enabled(current["provider"])
            if expected != current["revision"]:
                raise WorkLinkConflict("link or notes changed; read the link again before saving")
            url = changes.pop("url", current["url"])
            duplicate = connection.execute("SELECT id FROM links WHERE history_id=? AND provider=? AND url=? AND id<>?",
                                           (current["historyId"], current["provider"], url, link_id)).fetchone()
            if duplicate:
                raise WorkLinkConflict("this URL is already linked to the session")
            metadata = {field: changes.get(field, current[field]) for field in ("label", "title", "notes", "instructions")}
            connection.execute("UPDATE links SET url=?, metadata=?, revision=revision+1, updated_at=? WHERE id=?",
                               (url, json.dumps(metadata), int(self._clock()), link_id))
            if url != current["url"]:
                # Reports for the old target cannot describe the replacement URL.
                connection.execute("UPDATE links SET status=NULL, status_updated_at=NULL, status_revision=status_revision+1 WHERE id=?", (link_id,))
            self._changed(connection)
        return self.get(link_id)

    def report_status(self, link_id: str, payload: Any) -> dict[str, Any]:
        object_fields(payload, {"expectedStatusRevision", "status"}, {"expectedStatusRevision", "status"})
        expected = revision_field(payload["expectedStatusRevision"], "expectedStatusRevision")
        raw = object_fields(payload["status"], {"state", "tone", "summary", "reportedBy"}, {"state"})
        status = {"state": text_field(raw["state"], "state", 80, required=True),
                  "tone": raw.get("tone", "neutral"),
                  "summary": text_field(raw.get("summary", ""), "summary", MAX_STATUS_SUMMARY, multiline=True),
                  "reportedBy": text_field(raw.get("reportedBy", ""), "reportedBy", 120)}
        if status["tone"] not in STATUS_TONES:
            raise ValueError("invalid status tone")
        with self._database() as connection:
            current = self.get(link_id)
            self._require_enabled(current["provider"], refresh=True)
            if expected != current["statusRevision"]:
                raise WorkLinkConflict("status changed; read it again before reporting")
            connection.execute("UPDATE links SET status=?, status_revision=status_revision+1, status_updated_at=? WHERE id=?",
                               (json.dumps(status), int(self._clock()), link_id))
            self._changed(connection)
        return self.get(link_id)

    def delete(self, link_id: str, expected: Any) -> None:
        expected = revision_field(expected)
        with self._database() as connection:
            current = self.get(link_id)
            self._require_enabled(current["provider"])
            if expected != current["revision"]:
                raise WorkLinkConflict("link changed; read it again before removing")
            connection.execute("DELETE FROM links WHERE id=?", (link_id,))
            self._changed(connection)

    def summary_snapshot(self) -> dict[str, Any]:
        with self._database() as connection:
            if self._summary_cache is None:
                config = self.config()
                summaries: dict[str, list[dict[str, Any]]] = {}
                if config["enabled"]:
                    for row in connection.execute("SELECT * FROM links ORDER BY created_at, id"):
                        if not config["providers"][row["provider"]]["enabled"]:
                            continue
                        link = self._record(row)
                        summary = {key: link[key] for key in ("id", "provider", "url", "label", "title", "statusUpdatedAt")}
                        summary["status"] = ({"state": link["status"]["state"], "tone": link["status"]["tone"]}
                                             if link["status"] else None)
                        summaries.setdefault(link["historyId"], []).append(summary)
                self._summary_cache = {
                    "enabled": config["enabled"],
                    "revision": connection.execute("SELECT change_revision FROM settings WHERE id=1").fetchone()[0],
                    "sessions": summaries,
                }
            return copy.deepcopy(self._summary_cache)


def work_link_capabilities(store: WorkLinkStore, prefix: str) -> dict[str, Any]:
    return {
        "available": True, "config": store.config(), "refreshOwner": "agent",
        "serverFetchesProviders": False, "persistent": True,
        "configurationEndpoint": f"{prefix}/api/work-links/config",
        "contextEndpoint": f"{prefix}/api/work-links/context",
        "documentation": "docs/WORK_LINKS.md",
        "providers": list(PROVIDERS), "statusTones": list(STATUS_TONES),
        "limits": {"linksPerSession": MAX_LINKS_PER_SESSION, "notesCharacters": MAX_NOTES,
                   "instructionsCharacters": MAX_INSTRUCTIONS, "statusSummaryCharacters": MAX_STATUS_SUMMARY},
    }
