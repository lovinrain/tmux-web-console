from __future__ import annotations

import codecs
import mimetypes
import shlex
import stat
from pathlib import Path, PurePosixPath

MAX_DIRECTORY_ENTRIES = 1_000
MAX_PREVIEW_BYTES = 1 * 1024 * 1024
MAX_RELATIVE_PATH_LENGTH = 4_096
MAX_RELATIVE_PATH_PARTS = 128


class FileBrowserPathOutsideRootError(PermissionError):
    pass


class FileBrowserUnsupportedFileError(ValueError):
    pass


def _relative_parts(value: str) -> tuple[str, ...]:
    if not isinstance(value, str):
        raise TypeError("path must be a string")
    if len(value) > MAX_RELATIVE_PATH_LENGTH:
        raise ValueError("path is too long")
    if "\x00" in value:
        raise ValueError("path cannot contain a null byte")
    if value in {"", "."}:
        return ()

    path = PurePosixPath(value)
    if path.is_absolute():
        raise ValueError("path must be relative to the pane working directory")
    if len(path.parts) > MAX_RELATIVE_PATH_PARTS:
        raise ValueError("path has too many components")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("path cannot navigate outside the pane working directory")
    return path.parts


def _is_within(root: Path, target: Path) -> bool:
    return target == root or root in target.parents


def _resolve_root(root_path: str) -> tuple[Path, Path]:
    display_root = Path(root_path)
    if not display_root.is_absolute():
        raise ValueError("pane working directory must be absolute")
    try:
        resolved_root = display_root.resolve(strict=True)
    except RuntimeError as error:
        raise FileBrowserPathOutsideRootError(
            "pane working directory cannot be resolved safely"
        ) from error
    if not stat.S_ISDIR(resolved_root.stat().st_mode):
        raise NotADirectoryError("pane working directory is not a directory")
    return display_root, resolved_root


def _resolve_target(
    root_path: str,
    relative_path: str,
) -> tuple[Path, Path, Path, tuple[str, ...]]:
    display_root, resolved_root = _resolve_root(root_path)
    parts = _relative_parts(relative_path)
    try:
        resolved_target = resolved_root.joinpath(*parts).resolve(strict=True)
    except RuntimeError as error:
        raise FileBrowserPathOutsideRootError(
            "path cannot be resolved safely"
        ) from error
    if not _is_within(resolved_root, resolved_target):
        raise FileBrowserPathOutsideRootError(
            "path resolves outside the pane working directory"
        )
    return display_root, resolved_root, resolved_target, parts


def _relative_text(parts: tuple[str, ...]) -> str:
    return "/".join(parts)


def _path_payload(display_root: Path, parts: tuple[str, ...]) -> dict[str, str]:
    display_path = display_root.joinpath(*parts)
    return {
        "path": _relative_text(parts),
        "absolutePath": str(display_path),
        "terminalText": shlex.quote(str(display_path)),
    }


def list_directory(root_path: str, relative_path: str = "") -> dict[str, object]:
    display_root, resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
    )
    if not stat.S_ISDIR(target.stat().st_mode):
        raise NotADirectoryError("path is not a directory")

    entries: list[dict[str, object]] = []
    truncated = False
    for child in target.iterdir():
        if len(entries) >= MAX_DIRECTORY_ENTRIES:
            truncated = True
            break

        child_parts = (*parts, child.name)
        is_symlink = child.is_symlink()
        accessible = True
        kind = "other"
        size: int | None = None
        modified: float | None = None
        try:
            resolved_child = child.resolve(strict=True)
            if not _is_within(resolved_root, resolved_child):
                accessible = False
            else:
                child_stat = resolved_child.stat()
                modified = child_stat.st_mtime
                if stat.S_ISDIR(child_stat.st_mode):
                    kind = "directory"
                elif stat.S_ISREG(child_stat.st_mode):
                    kind = "file"
                    size = child_stat.st_size
                else:
                    accessible = False
        except (OSError, RuntimeError):
            accessible = False

        entries.append(
            {
                "name": child.name,
                "kind": kind,
                "size": size,
                "modified": modified,
                "hidden": child.name.startswith("."),
                "symlink": is_symlink,
                "accessible": accessible,
                **_path_payload(display_root, child_parts),
            }
        )

    entries.sort(
        key=lambda entry: (
            entry["kind"] != "directory",
            str(entry["name"]).casefold(),
            str(entry["name"]),
        )
    )
    return {
        "root": str(display_root),
        **_path_payload(display_root, parts),
        "entries": entries,
        "truncated": truncated,
        "limit": MAX_DIRECTORY_ENTRIES,
    }


def preview_file(root_path: str, relative_path: str) -> dict[str, object]:
    display_root, _resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
    )
    target_stat = target.stat()
    if stat.S_ISDIR(target_stat.st_mode):
        raise IsADirectoryError("path is a directory")
    if not stat.S_ISREG(target_stat.st_mode):
        raise FileBrowserUnsupportedFileError("path is not a regular file")

    with target.open("rb") as handle:
        content = handle.read(MAX_PREVIEW_BYTES + 1)
    truncated = len(content) > MAX_PREVIEW_BYTES
    preview_bytes = content[:MAX_PREVIEW_BYTES]
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"

    text: str | None = None
    kind = "binary"
    if b"\x00" not in preview_bytes:
        try:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
            text = decoder.decode(preview_bytes, final=not truncated)
        except UnicodeDecodeError:
            pass
        else:
            kind = "text"

    return {
        "root": str(display_root),
        **_path_payload(display_root, parts),
        "name": target.name,
        "kind": kind,
        "mediaType": media_type,
        "size": target_stat.st_size,
        "modified": target_stat.st_mtime,
        "truncated": truncated,
        "previewBytes": len(preview_bytes),
        "content": text,
    }
