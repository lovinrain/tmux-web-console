from __future__ import annotations

import io
import os
import sqlite3
from dataclasses import replace

import pytest
from PIL import Image

from tmux_console.note_captures import (
    NoteCaptureConflict,
    NoteCaptureNotFound,
    NoteCaptureStorageFull,
    NoteCaptureStore,
    NoteCapturesUnavailable,
    normalize_image,
)
from tmux_console.tmux import Session


def png():
    output = io.BytesIO()
    Image.new("RGB", (80, 24), (30, 60, 40)).save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def captures(tmp_path):
    now = [1_790_000_000.0]
    store = NoteCaptureStore(tmp_path / "captures.sqlite3", clock=lambda: now[0])
    source = Session("alpha", "$1", 1, 0, 100, server_started=90, server_pid=42)
    yield store, source, now
    store.close()


def add(store, source, number=1, scope="session", target="alpha", **kwargs):
    return store.create(identifier=f"{number:032x}", source=source, scope=scope, target=target,
                        target_identity=source.identity if scope == "session" else "", page_id="main", **kwargs)


def test_captures_are_atomic_persistent_and_do_not_replace_existing_notes(captures):
    store, source, _ = captures
    first = add(store, source, image=png(), text="exact text\n  code")
    second = add(store, source, 2, text="another browser's capture")
    assert len(store.list("session", "alpha", "main")) == 2
    assert store.get(first["id"])["text"] == "exact text\n  code"
    assert store.get(second["id"])["imageBytes"] == 0
    path = store.image_path(first["id"])
    assert path.stat().st_mode & 0o777 == 0o600
    assert store.image_directory.stat().st_mode & 0o777 == 0o700
    store.close()
    reopened = NoteCaptureStore(store.path)
    try:
        assert len(reopened.list()) == 2
        assert reopened.get(first["id"])["text"] == first["text"]
    finally:
        reopened.close()


def test_retry_deduplication_conflicts_and_storage_limit_free_real_files(captures):
    store, source, _ = captures
    store.max_bytes = len(normalize_image(png()))
    first = add(store, source, image=png(), text="keep text")
    assert add(store, source, image=png(), text="keep text")["id"] == first["id"]
    with pytest.raises(NoteCaptureConflict):
        add(store, source, image=png(), text="different request")
    with pytest.raises(NoteCaptureStorageFull):
        add(store, source, 2, image=png())
    assert store.summary()["warning"] == "critical"
    path = store.image_path(first["id"])
    freed = store.delete(first["id"], image_only=True)
    assert freed == first["imageBytes"]
    assert not path.exists()
    assert store.summary()["usedBytes"] == 0
    assert store.get(first["id"])["text"] == "keep text"
    assert store.get(first["id"])["imageExpiredAt"] is not None


@pytest.mark.parametrize("scope,target", [("session", "alpha"), ("workspace", "workspace-1"), ("common", "common")])
def test_ended_source_expiry_warns_then_removes_images_but_keeps_text(captures, scope, target):
    store, source, now = captures
    first = add(store, source, scope=scope, target=target, image=png(), text="retained original text")
    references = {(scope, target): {"main"}}
    store.reconcile([source], references)
    assert store.get(first["id"])["sourceEndedAt"] is None
    store.reconcile([], references)
    ended = store.get(first["id"])
    assert ended["expiresAt"] == now[0] + 7 * 86400
    assert store.summary()["endedImageCount"] == 1
    assert store.summary()["warning"] == "warning"
    now[0] += 7 * 86400 - 1
    assert store.reconcile([], references) == 0
    now[0] += 1
    assert store.reconcile([], references) == first["imageBytes"]
    assert store.get(first["id"])["text"] == "retained original text"
    assert store.summary()["usedBytes"] == 0
    assert not list(store.image_directory.iterdir())


def test_keep_protects_expiry_and_bulk_cleanup_is_checked_atomically(captures):
    store, source, now = captures
    first = add(store, source, image=png())
    second = add(store, source, 2, image=png())
    kept = store.update(second["id"], 0, kept=True)
    references = {("session", "alpha"): {"main"}}
    store.reconcile([], references)
    with pytest.raises(NoteCaptureConflict):
        store.delete_ended_images([first["id"], second["id"]])
    assert store.get(first["id"])["imageBytes"] > 0
    now[0] += 8 * 86400
    store.reconcile([], references)
    assert store.get(first["id"])["imageBytes"] == 0
    assert store.get(kept["id"])["imageBytes"] > 0
    assert store.get(kept["id"])["expiresAt"] is None


def test_full_identity_detects_reused_name_and_follows_native_rename(captures):
    store, source, _ = captures
    first = add(store, source, image=png())
    renamed = replace(source, name="renamed")
    store.reconcile([renamed], {("session", "renamed"): {"main"}})
    current = store.get(first["id"])
    assert current["target"] == current["sourceSession"] == "renamed"
    replacement = replace(renamed, id="$2", created=101)
    store.reconcile([replacement], {("session", "renamed"): {"main"}})
    assert store.get(first["id"])["sourceEndedAt"] is not None


def test_external_rename_preserves_captures_when_the_notebook_has_not_moved(captures):
    store, source, _ = captures
    first = store.create(identifier="a" * 32, scope="session", target="alpha", page_id="handoff",
                         source=source, target_identity=source.identity, image=png())
    renamed = replace(source, name="renamed")
    store.reconcile([renamed], {("session", "alpha"): {"main", "handoff"}, ("session", "renamed"): {"main"}})
    current = store.get(first["id"])
    assert current["imageBytes"] > 0
    assert current["target"] == "alpha"
    assert current["sourceSession"] == "renamed"
    assert current["sourceEndedAt"] is None


def test_removed_page_discards_captures_and_unknown_reference_snapshot_is_safe(captures):
    store, source, _ = captures
    first = add(store, source, image=png(), text="page contents")
    assert store.reconcile([source], {}) == 0
    assert store.get(first["id"])["imageBytes"] > 0
    store.reconcile([source], {("session", "alpha"): set()})
    assert store.list() == []
    assert store.summary()["usedBytes"] == 0
    with pytest.raises(NoteCaptureNotFound):
        store.get(first["id"])


def test_stale_edits_fail_instead_of_overwriting_other_browsers(captures):
    store, source, _ = captures
    first = add(store, source, text="initial")
    store.update(first["id"], first["revision"], text="other browser")
    with pytest.raises(NoteCaptureConflict):
        store.update(first["id"], first["revision"], text="stale edit")
    assert store.get(first["id"])["text"] == "other browser"


def test_reference_snapshot_cannot_remove_concurrently_added_or_moved_captures(captures):
    store, source, _ = captures
    first = add(store, source, image=png())
    snapshot = {first["id"]: first["revision"]}
    store.update(first["id"], 0, scope="session", target="alpha", pageId="new-page")
    second = store.create(identifier="b" * 32, scope="session", target="alpha", page_id="new-page",
                          source=source, image=png())
    store.reconcile([source], {("session", "alpha"): {"main"}}, reference_revisions=snapshot)
    assert store.get(first["id"])["imageBytes"] > 0
    assert store.get(second["id"])["imageBytes"] > 0


def test_orphan_files_count_against_quota_and_have_reference_checked_grace(captures):
    store, source, now = captures
    orphan = store.image_directory / ("f" * 32 + ".png")
    orphan.write_bytes(normalize_image(png()))
    os.utime(orphan, (now[0], now[0]))
    store.max_bytes = orphan.stat().st_size
    assert store.summary()["unreferencedBytes"] == orphan.stat().st_size
    with pytest.raises(NoteCaptureStorageFull):
        add(store, source, image=png())
    store.reconcile([source], {})
    assert orphan.exists()
    now[0] += 3600
    assert store.reconcile([source], {}) > 0
    assert not orphan.exists()
    assert store.summary()["usedBytes"] == 0


@pytest.mark.parametrize("data", [b"", b"not an image", b"<svg></svg>", b"x" * (8 * 1024 * 1024 + 1)])
def test_invalid_images_are_rejected(data):
    with pytest.raises(ValueError):
        normalize_image(data)


def test_database_schema_is_preserved_when_a_future_version_is_found(tmp_path):
    path = tmp_path / "captures.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=99")
    store = NoteCaptureStore(path)
    with pytest.raises(NoteCapturesUnavailable):
        store.list()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 99


def test_unicode_usage_keys_and_transparent_images(captures):
    store, source, _ = captures
    output = io.BytesIO()
    Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(output, "PNG")
    first = add(store, source, scope="workspace", target="项目", image=output.getvalue())
    assert store.summary()["targets"]['["workspace","项目"]']["images"] == 1
    with Image.open(store.image_path(first["id"])) as image:
        assert image.getpixel((0, 0))[3] == 0


def test_moving_to_a_full_page_is_rejected_without_losing_capture(captures):
    store, source, _ = captures
    first = add(store, source, scope="common", target="common", text="move me")
    for number in range(2, 258):
        add(store, source, number, text="existing capture")
    with pytest.raises(NoteCaptureStorageFull):
        store.update(first["id"], 0, scope="session", target="alpha", pageId="main")
    assert store.get(first["id"])["scope"] == "common"
