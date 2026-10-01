from __future__ import annotations

import os
import sqlite3

import pytest

from tmux_console.work_links import (
    MAX_LINKS_PER_SESSION,
    WorkLinkConflict,
    WorkLinkNotFound,
    WorkLinksDisabled,
    WorkLinkStore,
    WorkLinksUnavailable,
)


@pytest.fixture
def store(tmp_path):
    value = WorkLinkStore(tmp_path / "work-links.sqlite3", clock=lambda: 123)
    yield value
    value.close()


def enable_refresh(store, provider="github"):
    return store.update_config({"expectedRevision": store.config()["revision"],
                                "providers": {provider: {"refreshEnabled": True}}})


def link(store, **extra):
    return store.create("history-a", {"provider": "github", "url": "https://git.corp.example/team/repo/pull/42", **extra})[0]


def test_enterprise_links_notes_and_instructions_persist_with_private_permissions(store):
    record = link(store, notes="Keep the migration decision.", instructions="Use the corporate MCP for this host.")
    assert record["label"] == "PR #42"
    assert record["status"] is None
    store.update_config({"expectedRevision": 0, "providers": {"jira": {
        "instructions": "Use Jira MCP on the VPN; keep account selection explicit.", "enabled": False,
    }}})
    assert os.stat(store.path).st_mode & 0o777 == 0o600
    with sqlite3.connect(store.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
    reopened = WorkLinkStore(store.path)
    try:
        assert reopened.get(record["id"]) == record
        assert reopened.config()["providers"]["jira"]["enabled"] is False
        assert "VPN" in reopened.config()["providers"]["jira"]["instructions"]
    finally:
        reopened.close()


def test_status_and_notes_have_independent_revisions_and_lost_updates_are_rejected(store):
    record = link(store, notes="original")
    enable_refresh(store)
    reported = store.report_status(record["id"], {"expectedStatusRevision": 0, "status": {
        "state": "Changes requested", "tone": "warning", "summary": "CI passing; one review unresolved", "reportedBy": "worker",
    }})
    updated = store.update(record["id"], {"expectedRevision": record["revision"], "notes": "human decision"})
    assert updated["status"] == reported["status"]
    assert updated["notes"] == "human decision"
    assert updated["statusUpdatedAt"] == 123
    with pytest.raises(WorkLinkConflict, match="notes changed"):
        store.update(record["id"], {"expectedRevision": 1, "notes": "stale writer"})
    with pytest.raises(WorkLinkConflict, match="status changed"):
        store.report_status(record["id"], {"expectedStatusRevision": 0, "status": {"state": "Open"}})
    assert store.get(record["id"])["notes"] == "human decision"


def test_url_change_clears_old_status_and_fences_in_flight_report(store):
    record = link(store)
    enable_refresh(store)
    store.report_status(record["id"], {"expectedStatusRevision": 0, "status": {"state": "Merged"}})
    changed = store.update(record["id"], {"expectedRevision": 1, "url": "https://another.example/repo/pull/9"})
    assert changed["status"] is None
    assert changed["statusUpdatedAt"] is None
    with pytest.raises(WorkLinkConflict):
        store.report_status(record["id"], {"expectedStatusRevision": 1, "status": {"state": "Merged"}})


def test_disabling_refresh_preserves_reports_and_notes_while_blocking_new_reports(store):
    record = link(store, notes="retained")
    with pytest.raises(WorkLinksDisabled, match="refresh is disabled"):
        store.report_status(record["id"], {"expectedStatusRevision": 0, "status": {"state": "Open"}})
    assert store.update(record["id"], {"expectedRevision": 1, "notes": "still editable"})["notes"] == "still editable"
    enable_refresh(store)
    store.report_status(record["id"], {"expectedStatusRevision": 0, "status": {"state": "In review"}})
    store.update_config({"expectedRevision": 1, "providers": {"github": {"refreshEnabled": False}}})
    with pytest.raises(WorkLinksDisabled):
        store.report_status(record["id"], {"expectedStatusRevision": 1, "status": {"state": "Done"}})
    assert store.get(record["id"])["status"]["state"] == "In review"
    assert store.get(record["id"])["notes"] == "still editable"


@pytest.mark.parametrize("disabled", [{"enabled": False}, {"providers": {"github": {"enabled": False}}}])
def test_provider_and_global_switches_hide_badges_and_gate_mutation_without_deleting(store, disabled):
    record = link(store)
    assert store.summary_snapshot()["sessions"]["history-a"][0]["id"] == record["id"]
    store.update_config({"expectedRevision": 0, **disabled})
    assert store.summary_snapshot()["sessions"] == {}
    assert store.list("history-a")[0]["id"] == record["id"]
    with pytest.raises(WorkLinksDisabled):
        link(store, url="https://github.example/o/r/pull/7")
    with pytest.raises(WorkLinksDisabled):
        store.update(record["id"], {"expectedRevision": 1, "notes": "new"})
    with pytest.raises(WorkLinksDisabled):
        store.delete(record["id"], 1)
    store.update_config({"expectedRevision": 1, "enabled": True, "providers": {"github": {"enabled": True}}})
    assert store.summary_snapshot()["sessions"]["history-a"][0]["id"] == record["id"]


def test_create_retry_never_overwrites_notes_and_session_associations_are_separate(store):
    record = link(store, notes="important")
    duplicate, created = store.create("history-a", {"provider": "github", "url": record["url"], "notes": "retry"})
    assert not created and duplicate == record
    other, created = store.create("history-b", {"provider": "github", "url": record["url"]})
    assert created and other["id"] != record["id"]
    with pytest.raises(WorkLinkConflict):
        store.delete(record["id"], 0)
    store.delete(record["id"], 1)
    with pytest.raises(WorkLinkNotFound):
        store.get(record["id"])
    assert store.list("history-b") == [other]


def test_stale_configuration_never_replaces_new_instructions(store):
    store.update_config({"expectedRevision": 0, "providers": {"github": {"instructions": "Use work account"}}})
    with pytest.raises(WorkLinkConflict):
        store.update_config({"expectedRevision": 0, "providers": {"jira": {"enabled": False}}})
    assert store.config()["providers"]["github"]["instructions"] == "Use work account"


@pytest.mark.parametrize("url", ["javascript:alert(1)", "//git.example/r", "file:///tmp/r", "https://user:secret@git.example/r",
                                  "https://git.example/a b", "https://git.example\\@other/r", "https://git.example:bad/r", "https:///r"])
def test_invalid_urls_never_enter_badges(store, url):
    with pytest.raises(ValueError):
        link(store, url=url)
    assert store.list("history-a") == []


@pytest.mark.parametrize("payload", [
    {"provider": "gitlab"}, {"label": ""}, {"notes": "x" * 32001}, {"instructions": "x" * 8001},
    {"title": "a\x00b"}, {"title": "\ud800"}, {"notes": []}, {"status": {"state": "Done"}},
])
def test_metadata_validation_is_bounded_and_status_cannot_bypass_refresh_policy(store, payload):
    with pytest.raises((ValueError, TypeError)):
        link(store, **payload)


@pytest.mark.parametrize("patch", [
    {"enabled": 1}, {"providers": {"gitlab": {}}}, {"providers": {"github": {"refreshEnabled": "yes"}}},
    {"providers": {"github": {"refreshIntervalSeconds": 0}}},
    {"providers": {"github": {"refreshIntervalSeconds": True}}}, {"providers": []}, {"poll": True},
])
def test_bad_config_patch_is_atomic(store, patch):
    before = store.config()
    with pytest.raises((ValueError, TypeError)):
        store.update_config({"expectedRevision": 0, **patch})
    assert store.config() == before


def test_capacity_and_jira_label_on_private_host(store):
    for number in range(MAX_LINKS_PER_SESSION):
        record = store.create("history-a", {"provider": "jira", "url": f"https://tickets.internal/jira/browse/OPS-{number}"})[0]
        assert record["label"] == f"OPS-{number}"
    with pytest.raises(WorkLinkConflict, match="at most"):
        link(store)


def test_unreadable_future_database_is_preserved(tmp_path):
    path = tmp_path / "future.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=99")
    before = path.read_bytes()
    store = WorkLinkStore(path)
    with pytest.raises(WorkLinksUnavailable):
        store.config()
    assert path.read_bytes() == before
