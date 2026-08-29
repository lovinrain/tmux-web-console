from __future__ import annotations

import stat

import pytest

from tmux_console.uploads import (
    MAX_IMAGE_UPLOAD_BYTES,
    ImageUploadStorageFullError,
    ImageUploadStore,
    default_uploads_path,
)

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"muxdeck-image"


def test_upload_store_writes_detected_image_to_private_session_directory(tmp_path):
    root = tmp_path / "upload root"
    store = ImageUploadStore(
        root,
        clock=lambda: 1_700_000_000,
        token_factory=lambda: "abc123",
    )

    uploaded = store.save("work/session #1", "../Screen Shot 01.svg", PNG_BYTES)

    assert uploaded.original_name == "Screen Shot 01.svg"
    assert uploaded.content_type == "image/png"
    assert uploaded.size == len(PNG_BYTES)
    assert uploaded.path.read_bytes() == PNG_BYTES
    assert uploaded.path.suffix == ".png"
    assert uploaded.path.parent.parent == root.resolve()
    assert "work-session-1-" in uploaded.path.parent.name
    assert "Screen-Shot-01" in uploaded.path.name
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(uploaded.path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(uploaded.path.stat().st_mode) == 0o600
    assert uploaded.to_dict() == {
        "name": "Screen Shot 01.svg",
        "path": str(uploaded.path),
        "terminalText": f"'{uploaded.path}'",
        "contentType": "image/png",
        "size": len(PNG_BYTES),
    }


@pytest.mark.parametrize(
    ("data", "content_type", "suffix"),
    [
        (b"\xff\xd8\xff" + b"jpeg", "image/jpeg", ".jpg"),
        (b"GIF89a" + b"gif", "image/gif", ".gif"),
        (b"RIFF\x04\x00\x00\x00WEBPdata", "image/webp", ".webp"),
    ],
)
def test_upload_store_detects_supported_image_formats(
    tmp_path,
    data,
    content_type,
    suffix,
):
    uploaded = ImageUploadStore(tmp_path).save("agent", "wrong.txt", data)

    assert uploaded.content_type == content_type
    assert uploaded.path.suffix == suffix


@pytest.mark.parametrize(
    ("name", "data", "message"),
    [
        ("", PNG_BYTES, "filename is required"),
        ("bad\nname.png", PNG_BYTES, "control characters"),
        ("empty.png", b"", "cannot be empty"),
        ("vector.svg", b"<svg></svg>", "PNG, JPEG, GIF, or WebP"),
    ],
)
def test_upload_store_rejects_invalid_files(tmp_path, name, data, message):
    with pytest.raises(ValueError, match=message):
        ImageUploadStore(tmp_path).save("agent", name, data)


def test_upload_store_enforces_per_file_and_directory_limits(tmp_path):
    store = ImageUploadStore(tmp_path / "per-file")
    with pytest.raises(ValueError, match="12 MiB or smaller"):
        store.save(
            "agent",
            "too-large.png",
            b"\x89PNG\r\n\x1a\n" + b"x" * MAX_IMAGE_UPLOAD_BYTES,
        )

    capped = ImageUploadStore(tmp_path / "capacity", max_total_bytes=len(PNG_BYTES))
    capped.save("agent", "first.png", PNG_BYTES)
    with pytest.raises(ImageUploadStorageFullError, match="storage is full"):
        capped.save("agent", "second.png", PNG_BYTES)


def test_default_uploads_path_honors_environment(tmp_path, monkeypatch):
    configured = tmp_path / "configured images"
    monkeypatch.setenv("MUXDECK_UPLOADS_DIR", str(configured))

    assert default_uploads_path() == configured
