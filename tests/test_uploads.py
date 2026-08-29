from __future__ import annotations

import stat

import pytest

from tmux_console.uploads import (
    MAX_ATTACHMENT_UPLOAD_BYTES,
    AttachmentStorageFullError,
    AttachmentStore,
    default_attachments_path,
)

FILE_BYTES = b"muxdeck arbitrary attachment\x00data"


def test_attachment_store_writes_arbitrary_file_to_private_session_directory(tmp_path):
    root = tmp_path / "upload root"
    store = AttachmentStore(
        root,
        clock=lambda: 1_700_000_000,
        token_factory=lambda: "abc123",
    )

    uploaded = store.save(
        "work/session #1",
        "../Build Report.final.LOG",
        FILE_BYTES,
        "text/plain; charset=utf-8",
    )

    assert uploaded.original_name == "Build Report.final.LOG"
    assert uploaded.content_type == "text/plain"
    assert uploaded.size == len(FILE_BYTES)
    assert uploaded.path.read_bytes() == FILE_BYTES
    assert uploaded.path.name.endswith("-Build-Report.final.LOG")
    assert uploaded.path.parent.parent == root.resolve()
    assert "work-session-1-" in uploaded.path.parent.name
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(uploaded.path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(uploaded.path.stat().st_mode) == 0o600
    assert uploaded.to_dict() == {
        "name": "Build Report.final.LOG",
        "path": str(uploaded.path),
        "terminalText": f"'{uploaded.path}'",
        "contentType": "text/plain",
        "size": len(FILE_BYTES),
    }


@pytest.mark.parametrize(
    ("name", "data", "provided", "content_type"),
    [
        ("context.json", b'{"ok": true}', None, "application/json"),
        ("drawing.svg", b"<svg></svg>", "image/svg+xml", "image/svg+xml"),
        ("archive.unknown", b"\x00\xffarchive", "bad value", "application/octet-stream"),
    ],
)
def test_attachment_store_accepts_any_file_type(
    tmp_path,
    name,
    data,
    provided,
    content_type,
):
    uploaded = AttachmentStore(tmp_path).save("agent", name, data, provided)

    assert uploaded.content_type == content_type
    assert uploaded.path.read_bytes() == data
    assert uploaded.path.name.endswith(f"-{name}")


@pytest.mark.parametrize(
    ("name", "data", "message"),
    [
        ("", FILE_BYTES, "filename is required"),
        ("bad\nname.txt", FILE_BYTES, "control characters"),
        ("empty.txt", b"", "cannot be empty"),
    ],
)
def test_attachment_store_rejects_invalid_files(tmp_path, name, data, message):
    with pytest.raises(ValueError, match=message):
        AttachmentStore(tmp_path).save("agent", name, data)


def test_attachment_store_enforces_per_file_and_directory_limits(tmp_path):
    store = AttachmentStore(tmp_path / "per-file")
    with pytest.raises(ValueError, match="12 MiB or smaller"):
        store.save(
            "agent",
            "too-large.bin",
            b"x" * (MAX_ATTACHMENT_UPLOAD_BYTES + 1),
        )

    capped = AttachmentStore(tmp_path / "capacity", max_total_bytes=len(FILE_BYTES))
    capped.save("agent", "first.bin", FILE_BYTES)
    with pytest.raises(AttachmentStorageFullError, match="storage is full"):
        capped.save("agent", "second.bin", FILE_BYTES)


def test_default_attachments_path_honors_existing_uploads_environment(tmp_path, monkeypatch):
    configured = tmp_path / "configured attachments"
    monkeypatch.setenv("MUXDECK_UPLOADS_DIR", str(configured))

    assert default_attachments_path() == configured
