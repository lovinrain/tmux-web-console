from __future__ import annotations

import os
from pathlib import Path

import pytest

from tmux_console.file_browser import (
    FileBrowserContentTooLargeError,
    FileBrowserHtmlPreview,
    FileBrowserPathOutsideRootError,
    FileBrowserUnsupportedFileError,
)
from tmux_console.html_preview import (
    MAX_PREVIEW_ASSET_BYTES,
    MAX_PREVIEW_CODE_BYTES,
    MAX_PREVIEW_MEDIA_BYTES,
    HtmlPreviewGrantStore,
    resolve_html_preview_asset,
)


def issue(store: HtmlPreviewGrantStore, document: Path, *, name: str | None = None):
    return store.issue(
        FileBrowserHtmlPreview(path=document, name=name or document.name),
        session_name="reports",
        session_id="$4",
        session_created=1700000000,
        server_started=1699999999,
        server_pid=12345,
        pane_id="%8",
    )


@pytest.fixture
def document(tmp_path):
    report = tmp_path / "report.html"
    report.write_text("<!doctype html><p>Report</p>", encoding="utf-8")
    return report


def test_grants_capture_identity_and_are_unique_directory_capabilities(document):
    store = HtmlPreviewGrantStore()
    first = issue(store, document)
    second = issue(store, document)
    assert first.token != second.token
    assert len(first.token) == 43  # 32 random bytes in unpadded URL-safe base64.
    assert first.root == document.parent.resolve()
    assert first.document_path == document.resolve()
    assert first.document_name == "report.html"
    assert first.session_name == "reports"
    assert first.session_id == "$4"
    assert first.session_created == 1700000000
    assert first.server_started == 1699999999
    assert first.server_pid == 12345
    assert first.pane_id == "%8"
    assert store.get(first.token) is first
    assert store.get("unknown") is None
    store.revoke(first.token)
    assert store.get(first.token) is None
    assert store.get(second.token) is second


def test_grants_expire_without_reads_extending_their_lifetime(document):
    now = [20.0]
    store = HtmlPreviewGrantStore(ttl_seconds=60, clock=lambda: now[0])
    grant = issue(store, document)
    now[0] = 79.9
    assert store.get(grant.token) is grant
    now[0] = 80
    assert store.get(grant.token) is None


def test_grant_capacity_evicts_oldest_and_reaps_expired_grants(document):
    now = [1.0]
    store = HtmlPreviewGrantStore(ttl_seconds=60, max_grants=2, clock=lambda: now[0])
    oldest = issue(store, document)
    now[0] += 1
    next_oldest = issue(store, document)
    assert store.get(oldest.token) is oldest  # Reads do not reorder eviction.
    newest = issue(store, document)
    assert store.get(oldest.token) is None
    assert store.get(next_oldest.token) is next_oldest
    assert store.get(newest.token) is newest
    now[0] = 62
    replacement = issue(store, document)
    assert store.get(next_oldest.token) is None
    assert store.get(newest.token) is None
    assert store.get(replacement.token) is replacement


@pytest.mark.parametrize("ttl", [0, -1, float("inf"), float("nan")])
def test_invalid_grant_lifetime_is_rejected(ttl):
    with pytest.raises(ValueError):
        HtmlPreviewGrantStore(ttl_seconds=ttl)


@pytest.mark.parametrize("capacity", [0, -1, True, 1.5])
def test_invalid_grant_capacity_is_rejected(capacity):
    with pytest.raises(ValueError):
        HtmlPreviewGrantStore(max_grants=capacity)


@pytest.mark.parametrize(
    ("suffix", "media_type", "is_html"),
    [
        (".html", "text/html", True),
        (".HTM", "text/html", True),
        (".js", "text/javascript", False),
        (".mjs", "text/javascript", False),
        (".css", "text/css", False),
        (".json", "application/json", False),
        (".map", "application/json", False),
        (".png", "image/png", False),
        (".jpg", "image/jpeg", False),
        (".jpeg", "image/jpeg", False),
        (".gif", "image/gif", False),
        (".webp", "image/webp", False),
        (".avif", "image/avif", False),
        (".ico", "image/x-icon", False),
        (".svg", "image/svg+xml", False),
        (".woff", "font/woff", False),
        (".woff2", "font/woff2", False),
        (".ttf", "font/ttf", False),
        (".otf", "font/otf", False),
        (".wasm", "application/wasm", False),
        (".mp3", "audio/mpeg", False),
        (".mp4", "video/mp4", False),
        (".webm", "video/webm", False),
        (".ogg", "audio/ogg", False),
        (".wav", "audio/wav", False),
    ],
)
def test_relative_assets_have_explicit_mime_types(document, suffix, media_type, is_html):
    nested = document.parent / "assets"
    nested.mkdir()
    asset = nested / ("file" + suffix)
    asset.write_bytes(b"content")
    grant = issue(HtmlPreviewGrantStore(), document)
    result = resolve_html_preview_asset(grant, f"assets/{asset.name}")
    assert result.path == asset
    assert result.name == asset.name
    assert result.media_type == media_type
    assert result.is_html is is_html


@pytest.mark.parametrize("name", ["source.py", "app.ts", "config.yaml", "README", "keys.pem", "data.txt", "report.html.bak"])
def test_non_web_assets_are_not_exposed(document, name):
    (document.parent / name).write_text("secret", encoding="utf-8")
    grant = issue(HtmlPreviewGrantStore(), document)
    with pytest.raises(FileBrowserUnsupportedFileError):
        resolve_html_preview_asset(grant, name)


@pytest.mark.parametrize("relative_path", [".env", ".private/data.json", "../outside.html", "assets/../../outside.html", "assets/./app.js", "assets/.hidden.js"])
def test_hidden_paths_and_traversal_are_rejected(document, relative_path):
    grant = issue(HtmlPreviewGrantStore(), document)
    with pytest.raises(FileBrowserPathOutsideRootError):
        resolve_html_preview_asset(grant, relative_path)


@pytest.mark.parametrize("relative_path", ["", "/report.html", "assets\\app.js", "a\x00.js"])
def test_invalid_relative_paths_are_rejected(document, relative_path):
    grant = issue(HtmlPreviewGrantStore(), document)
    with pytest.raises(ValueError):
        resolve_html_preview_asset(grant, relative_path)


def test_outside_symlinks_and_hidden_or_unsupported_symlink_targets_are_rejected(document):
    outside = document.parent.parent / "outside.js"
    outside.write_text("secret", encoding="utf-8")
    (document.parent / "escape.js").symlink_to(outside)
    hidden = document.parent / ".private"
    hidden.mkdir()
    (hidden / "data.json").write_text("{}", encoding="utf-8")
    (document.parent / "hidden.json").symlink_to(hidden / "data.json")
    (document.parent / "config.yaml").write_text("secret", encoding="utf-8")
    (document.parent / "disguised.json").symlink_to(document.parent / "config.yaml")
    grant = issue(HtmlPreviewGrantStore(), document)
    for name in ["escape.js", "hidden.json"]:
        with pytest.raises(FileBrowserPathOutsideRootError):
            resolve_html_preview_asset(grant, name)
    with pytest.raises(FileBrowserUnsupportedFileError):
        resolve_html_preview_asset(grant, "disguised.json")


def test_contained_web_asset_symlinks_and_document_aliases_work(document):
    asset = document.parent / "source.js"
    asset.write_text("window.loaded = true", encoding="utf-8")
    (document.parent / "alias.js").symlink_to(asset)
    grant = issue(HtmlPreviewGrantStore(), document, name="friendly.html")
    assert grant.document_name == "friendly.html"
    assert resolve_html_preview_asset(grant, "friendly.html").path == document
    assert resolve_html_preview_asset(grant, "alias.js").path == asset


def test_directories_and_nonregular_files_are_not_preview_assets(document):
    (document.parent / "folder.js").mkdir()
    os.mkfifo(document.parent / "pipe.js")
    grant = issue(HtmlPreviewGrantStore(), document)
    with pytest.raises(IsADirectoryError):
        resolve_html_preview_asset(grant, "folder.js")
    with pytest.raises(FileBrowserUnsupportedFileError):
        resolve_html_preview_asset(grant, "pipe.js")


@pytest.mark.parametrize(
    ("suffix", "limit"),
    [(".html", MAX_PREVIEW_CODE_BYTES), (".js", MAX_PREVIEW_CODE_BYTES),
     (".mjs", MAX_PREVIEW_CODE_BYTES), (".css", MAX_PREVIEW_CODE_BYTES),
     (".json", MAX_PREVIEW_CODE_BYTES), (".png", MAX_PREVIEW_ASSET_BYTES),
     (".wasm", MAX_PREVIEW_ASSET_BYTES), (".mp4", MAX_PREVIEW_MEDIA_BYTES)],
)
def test_assets_have_bounded_sizes(document, suffix, limit):
    grant = issue(HtmlPreviewGrantStore(), document)
    asset = document.parent / ("large" + suffix)
    with asset.open("wb") as output:
        output.truncate(limit)
    assert resolve_html_preview_asset(grant, asset.name).path == asset
    with asset.open("ab") as output:
        output.write(b"x")
    with pytest.raises(FileBrowserContentTooLargeError):
        resolve_html_preview_asset(grant, asset.name)


@pytest.mark.parametrize("replacement", ["symlink", "directory"])
def test_replacing_the_granted_root_revokes_file_access(tmp_path, replacement):
    root = tmp_path / "reports"
    root.mkdir()
    document = root / "index.html"
    document.write_text("report", encoding="utf-8")
    grant = issue(HtmlPreviewGrantStore(), document)
    root.rename(tmp_path / "original")
    if replacement == "symlink":
        root.symlink_to(tmp_path / "original", target_is_directory=True)
    else:
        root.mkdir()
        (root / "index.html").write_text("new report", encoding="utf-8")
    with pytest.raises(FileBrowserPathOutsideRootError):
        resolve_html_preview_asset(grant, "index.html")


def test_replacing_an_ancestor_with_a_symlink_cannot_widen_the_root(tmp_path):
    ancestor = tmp_path / "ancestor"
    root = ancestor / "reports"
    root.mkdir(parents=True)
    document = root / "index.html"
    document.write_text("report", encoding="utf-8")
    grant = issue(HtmlPreviewGrantStore(), document)
    ancestor.rename(tmp_path / "moved")
    ancestor.symlink_to(tmp_path / "moved", target_is_directory=True)
    with pytest.raises(FileBrowserPathOutsideRootError):
        resolve_html_preview_asset(grant, "index.html")


def test_new_store_cannot_reuse_grants_from_previous_process(document):
    grant = issue(HtmlPreviewGrantStore(), document)
    assert HtmlPreviewGrantStore().get(grant.token) is None


def test_document_swapped_to_an_outside_symlink_cannot_widen_a_new_grant(document):
    outside = document.parent.parent / "outside.html"
    outside.write_text("outside", encoding="utf-8")
    document.unlink()
    document.symlink_to(outside)
    with pytest.raises(FileBrowserPathOutsideRootError):
        issue(HtmlPreviewGrantStore(), document)


def test_asset_aliases_do_not_loosen_target_size_limits(document):
    source = document.parent / "large.js"
    with source.open("wb") as output:
        output.truncate(MAX_PREVIEW_CODE_BYTES + 1)
    (document.parent / "large.png").symlink_to(source)
    grant = issue(HtmlPreviewGrantStore(), document)
    with pytest.raises(FileBrowserContentTooLargeError):
        resolve_html_preview_asset(grant, "large.png")
