from __future__ import annotations

import codecs
import errno
import mimetypes
import os
import shlex
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MAX_DIRECTORY_ENTRIES = 1_000
MAX_PREVIEW_BYTES = 1 * 1024 * 1024
MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024
MAX_FILE_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_FILE_NAME_BYTES = 255
MAX_RELATIVE_PATH_LENGTH = 4_096
MAX_RELATIVE_PATH_PARTS = 128
MAX_TEXT_WRITE_BYTES = 1 * 1024 * 1024
# Every content byte can become a six-byte \uXXXX escape, so the JSON body
# that carries a maximum-size edit needs headroom over the content cap.
MAX_TEXT_WRITE_BODY_BYTES = 6 * MAX_TEXT_WRITE_BYTES + 4096
MAX_COPY_BYTES = 256 * 1024 * 1024
MAX_RECURSIVE_DELETE_ENTRIES = 20_000

NEW_DIRECTORY_MODE = 0o700
NEW_FILE_MODE = 0o600

ENTRY_KINDS = ("directory", "file")

# The browser starts at the live pane working directory but may be pointed
# anywhere inside this boundary. It exists so an operator can narrow the reach
# of the whole feature in one place; the default allows the same files the tmux
# owner could already read and write from the shell.
DEFAULT_BROWSE_BOUNDARY = "/"

# True where shutil walks a tree with openat()-style calls, which is also the
# condition for its dir_fd parameter being usable.
RMTREE_IS_FD_RELATIVE = shutil.rmtree.avoids_symlink_attacks


class FileBrowserPathOutsideRootError(PermissionError):
    pass


class FileBrowserUnsupportedFileError(ValueError):
    pass


class FileBrowserUnsupportedImageError(ValueError):
    pass


class FileBrowserImageTooLargeError(ValueError):
    pass


class FileBrowserContentTooLargeError(ValueError):
    """A file body exceeds the limit for the requested operation."""


class FileBrowserDestinationExistsError(FileExistsError):
    pass


class FileBrowserDirectoryNotEmptyError(OSError):
    pass


class FileBrowserPartialDeleteError(OSError):
    """A recursive delete removed some entries before failing."""


class FileBrowserConflictError(ValueError):
    """The stored file changed since the client read it."""


@dataclass(frozen=True)
class FileBrowserDownload:
    path: Path
    name: str


@dataclass(frozen=True)
class FileBrowserImagePreview:
    path: Path
    name: str
    media_type: str


def resolve_browse_boundary(configured: str | None = None) -> Path:
    """Validate the configured limit on how far the browser may be pointed.

    Called once at startup so a misconfigured boundary fails the process rather
    than silently widening or narrowing what the browser can reach.
    """
    value = configured if configured is not None else os.environ.get(
        "MUXDECK_FILE_BROWSER_ROOT",
        DEFAULT_BROWSE_BOUNDARY,
    )
    if not isinstance(value, str) or not value.strip():
        raise ValueError("file browser root must be a non-empty absolute path")
    candidate = Path(value.strip()).expanduser()
    if not candidate.is_absolute():
        raise ValueError("file browser root must be an absolute path")
    resolved = candidate.resolve(strict=True)
    if not stat.S_ISDIR(resolved.stat().st_mode):
        raise NotADirectoryError("file browser root is not a directory")
    return resolved


def resolve_browse_root(value: str, boundary: Path) -> Path:
    """Validate a caller-supplied absolute directory to browse."""
    if not isinstance(value, str):
        raise TypeError("root must be a string")
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("root is required")
    if "\x00" in trimmed:
        raise ValueError("root cannot contain a null byte")
    if len(trimmed) > MAX_RELATIVE_PATH_LENGTH:
        raise ValueError("root is too long")
    candidate = Path(trimmed).expanduser()
    if not candidate.is_absolute():
        raise ValueError("root must be an absolute path")
    # Decided before the strict resolve below: letting the filesystem answer
    # first makes the differing errors for missing, not-a-directory, and
    # unreadable map out the structure of everything past the boundary.
    # realpath follows symlinks as far as they exist and never raises, so a
    # path that leaves the boundary only by traversing a link inside it is
    # caught here too, and no resolved outside path reaches the error text.
    if not _is_within(boundary, Path(os.path.realpath(candidate, strict=False))):
        raise FileBrowserPathOutsideRootError(
            "that directory is outside the browsable area"
        )
    try:
        resolved = candidate.resolve(strict=True)
    except RuntimeError as error:
        raise FileBrowserPathOutsideRootError(
            "root cannot be resolved safely"
        ) from error
    if not _is_within(boundary, resolved):
        raise FileBrowserPathOutsideRootError(
            "that directory is outside the browsable area"
        )
    if not stat.S_ISDIR(resolved.stat().st_mode):
        raise NotADirectoryError("root is not a directory")
    return resolved


def browsable_parent(root_path: str, boundary: Path) -> str | None:
    """The directory above ``root_path``, when the boundary still contains it."""
    display_root = Path(root_path)
    parent = display_root.parent
    if parent == display_root:
        return None
    try:
        resolved_parent = parent.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not _is_within(boundary, resolved_parent):
        return None
    return str(parent)


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
        raise ValueError("path cannot navigate outside the directory being browsed")
    if any(len(part.encode("utf-8")) > MAX_FILE_NAME_BYTES for part in path.parts):
        raise ValueError(
            f"each path component must be {MAX_FILE_NAME_BYTES} UTF-8 bytes or fewer"
        )
    return path.parts


def _is_within(root: Path, target: Path) -> bool:
    return target == root or root in target.parents


def _resolve_root(
    root_path: str,
    boundary: Path | None,
) -> tuple[Path, Path]:
    display_root = Path(root_path)
    if not display_root.is_absolute():
        raise ValueError("the directory being browsed must be absolute")
    try:
        resolved_root = display_root.resolve(strict=True)
    except RuntimeError as error:
        raise FileBrowserPathOutsideRootError(
            "the directory being browsed cannot be resolved safely"
        ) from error
    # Re-checked here, on the same resolution the operation goes on to use.
    # Validating the root once at the edge and re-resolving it later leaves a
    # window in which the directory can be swapped for a symlink pointing out
    # of the boundary; it also let a pane working directory outside the
    # boundary be browsed without ever being checked at all.
    if boundary is not None and not _is_within(boundary, resolved_root):
        raise FileBrowserPathOutsideRootError(
            "that directory is outside the browsable area"
        )
    if not stat.S_ISDIR(resolved_root.stat().st_mode):
        raise NotADirectoryError("the directory being browsed is not a directory")
    return display_root, resolved_root


def _resolve_target(
    root_path: str,
    relative_path: str,
    boundary: Path | None,
) -> tuple[Path, Path, Path, tuple[str, ...]]:
    display_root, resolved_root = _resolve_root(root_path, boundary)
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


def _resolve_parent(
    root_path: str,
    relative_path: str,
    boundary: Path | None,
) -> tuple[Path, Path, Path, tuple[str, ...]]:
    """Resolve the parent directory of ``relative_path`` without following its
    final component.

    Renames, deletes, and writes must act on the named entry itself rather than
    on whatever a symlink points at, so the last component stays unresolved and
    every operation runs against the parent directory descriptor.
    """
    parts = _relative_parts(relative_path)
    if not parts:
        raise ValueError("path must name an entry inside the directory being browsed")
    display_root, resolved_root = _resolve_root(root_path, boundary)
    try:
        resolved_parent = resolved_root.joinpath(*parts[:-1]).resolve(strict=True)
    except RuntimeError as error:
        raise FileBrowserPathOutsideRootError(
            "path cannot be resolved safely"
        ) from error
    if not _is_within(resolved_root, resolved_parent):
        raise FileBrowserPathOutsideRootError(
            "path resolves outside the pane working directory"
        )
    if not stat.S_ISDIR(resolved_parent.stat().st_mode):
        raise NotADirectoryError("path is not inside a directory")
    return display_root, resolved_root, resolved_parent, parts


def _relative_text(parts: tuple[str, ...]) -> str:
    return "/".join(parts)


def _path_payload(display_root: Path, parts: tuple[str, ...]) -> dict[str, str]:
    display_path = display_root.joinpath(*parts)
    return {
        "path": _relative_text(parts),
        "absolutePath": str(display_path),
        "terminalText": shlex.quote(str(display_path)),
    }


def _preserved_mode(entry_stat: os.stat_result) -> int:
    """Permission bits to reuse for a file this process creates.

    setuid, setgid, and the sticky bit are dropped: the new inode is owned by
    the server's user, so copying those bits from the source would hand a local
    attacker an executable running as that user.
    """
    return stat.S_IMODE(entry_stat.st_mode) & 0o777


def _stat_kind(mode: int) -> str:
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    return "other"


def _entry_payload(
    display_root: Path,
    parts: tuple[str, ...],
    *,
    kind: str,
    size: int | None,
    modified: float | None,
    symlink: bool,
    accessible: bool = True,
) -> dict[str, object]:
    name = parts[-1] if parts else ""
    return {
        "name": name,
        "kind": kind,
        "size": size,
        "modified": modified,
        "hidden": name.startswith("."),
        "symlink": symlink,
        "accessible": accessible,
        **_path_payload(display_root, parts),
    }


def _stat_entry_payload(
    display_root: Path,
    parts: tuple[str, ...],
    entry_stat: os.stat_result,
    *,
    symlink: bool = False,
) -> dict[str, object]:
    kind = _stat_kind(entry_stat.st_mode)
    return _entry_payload(
        display_root,
        parts,
        kind=kind,
        size=entry_stat.st_size if kind == "file" else None,
        modified=entry_stat.st_mtime,
        symlink=symlink,
    )


def _open_directory(target: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    return os.open(target, flags)


def _raster_image_media_type(target: Path) -> str | None:
    with target.open("rb") as handle:
        header = handle.read(64)

    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if (
        len(header) >= 12
        and header.startswith(b"RIFF")
        and header[8:12] == b"WEBP"
    ):
        return "image/webp"
    if header.startswith(b"BM"):
        return "image/bmp"
    if header.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if len(header) >= 16 and header[4:8] == b"ftyp":
        brands = {header[8:12]}
        brands.update(
            header[offset : offset + 4]
            for offset in range(16, len(header) - 3, 4)
        )
        if brands & {b"avif", b"avis"}:
            return "image/avif"
    return None


def _entry_name(value: str, label: str = "filename") -> str:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a string")
    if not value:
        raise ValueError(f"{label} is required")
    if value in {".", ".."}:
        raise ValueError(f"{label} must name a file")
    if "/" in value or "\\" in value:
        raise ValueError(f"{label} cannot contain path separators")
    if "\x00" in value or any(
        ord(character) < 32 or ord(character) == 127 for character in value
    ):
        raise ValueError(f"{label} cannot contain control characters")
    if len(value.encode("utf-8")) > MAX_FILE_NAME_BYTES:
        raise ValueError(
            f"{label} must be {MAX_FILE_NAME_BYTES} UTF-8 bytes or fewer"
        )
    return value


# Retained for callers and tests that predate the shared new-entry validator.
_upload_name = _entry_name


@dataclass(frozen=True)
class _TreeCount:
    """How many entries a subtree holds, and how much of it could be read."""

    total: int
    capped: bool
    incomplete: bool

    def describe(self) -> str:
        entries = f"{self.total:,} entr{'y' if self.total == 1 else 'ies'}"
        if self.capped:
            return f"more than {self.total - 1:,} entries"
        return f"at least {entries}" if self.incomplete else entries


def _count_tree_entries(target: Path, limit: int) -> _TreeCount:
    """Count entries below ``target``, stopping once ``limit`` is exceeded.

    Directories that cannot be read are reported through ``incomplete`` rather
    than silently lowering the total, so a caller never treats an unreadable
    subtree as an exact measurement.
    """
    total = 0
    incomplete = False
    pending = [target]
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as scanner:
                for child in scanner:
                    total += 1
                    if total > limit:
                        return _TreeCount(total, True, incomplete)
                    try:
                        if child.is_dir(follow_symlinks=False):
                            pending.append(Path(child.path))
                    except OSError:
                        incomplete = True
        except OSError:
            incomplete = True
    return _TreeCount(total, False, incomplete)


def _remove_tree(
    name: str,
    target: Path,
    directory_descriptor: int,
    expected_entries: int,
) -> None:
    """Delete a directory tree, preferring the descriptor-relative walk.

    Passing the already-validated parent descriptor keeps the traversal off the
    path namespace, so a directory component swapped for a symlink after
    validation cannot redirect the delete.

    A failure is only reported as a partial delete when something was actually
    removed. A tree that could not be touched at all re-raises the original
    error, so the caller still gets its accurate status and message instead of
    being sent to hunt for damage that never happened.
    """
    try:
        if RMTREE_IS_FD_RELATIVE:
            shutil.rmtree(name, dir_fd=directory_descriptor)
        else:
            shutil.rmtree(target)
    except OSError as error:
        if not target.exists():
            raise
        remaining = _count_tree_entries(target, expected_entries)
        if not remaining.capped and remaining.total >= expected_entries:
            raise
        raise FileBrowserPartialDeleteError(
            "the folder was only partly deleted; some entries could not be "
            "removed. Reload the folder to see what is left."
        ) from error


def _directory_is_empty(target: Path) -> bool:
    with os.scandir(target) as scanner:
        return next(scanner, None) is None


def list_directory(
    root_path: str,
    relative_path: str = "",
    *,
    boundary: Path | None,
) -> dict[str, object]:
    display_root, resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
        boundary,
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
            _entry_payload(
                display_root,
                child_parts,
                kind=kind,
                size=size,
                modified=modified,
                symlink=is_symlink,
                accessible=accessible,
            )
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
        # Describes the root itself, not the folder currently shown, so the
        # caller knows whether stepping above this root is permitted at all.
        "rootParent": (
            browsable_parent(str(display_root), boundary)
            if boundary is not None
            else None
        ),
    }


def preview_file(
    root_path: str,
    relative_path: str,
    *,
    boundary: Path | None,
) -> dict[str, object]:
    display_root, resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
        boundary,
    )
    target_stat = target.stat()
    if stat.S_ISDIR(target_stat.st_mode):
        raise IsADirectoryError("path is a directory")
    if not stat.S_ISREG(target_stat.st_mode):
        raise FileBrowserUnsupportedFileError("path is not a regular file")

    image_media_type = _raster_image_media_type(target)
    if image_media_type is not None:
        return {
            "root": str(display_root),
            **_path_payload(display_root, parts),
            "name": target.name,
            "kind": "image",
            "mediaType": image_media_type,
            "size": target_stat.st_size,
            "modified": target_stat.st_mtime,
            "truncated": target_stat.st_size > MAX_IMAGE_PREVIEW_BYTES,
            "previewBytes": min(target_stat.st_size, MAX_IMAGE_PREVIEW_BYTES),
            "content": None,
            "editable": False,
        }

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

    # `target` is fully resolved, so its own is_symlink() is always False; the
    # unresolved path is what tells us whether saving would be refused.
    is_symlink = resolved_root.joinpath(*parts).is_symlink()
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
        "editable": kind == "text" and not truncated and not is_symlink,
    }


def resolve_file_download(
    root_path: str,
    relative_path: str,
    *,
    boundary: Path | None,
) -> FileBrowserDownload:
    _display_root, _resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
        boundary,
    )
    target_stat = target.stat()
    if stat.S_ISDIR(target_stat.st_mode):
        raise IsADirectoryError("path is a directory")
    if not stat.S_ISREG(target_stat.st_mode):
        raise FileBrowserUnsupportedFileError("path is not a regular file")
    return FileBrowserDownload(path=target, name=parts[-1])


def resolve_file_image_preview(
    root_path: str,
    relative_path: str,
    *,
    boundary: Path | None,
) -> FileBrowserImagePreview:
    _display_root, _resolved_root, target, parts = _resolve_target(
        root_path,
        relative_path,
        boundary,
    )
    target_stat = target.stat()
    if stat.S_ISDIR(target_stat.st_mode):
        raise IsADirectoryError("path is a directory")
    if not stat.S_ISREG(target_stat.st_mode):
        raise FileBrowserUnsupportedFileError("path is not a regular file")

    media_type = _raster_image_media_type(target)
    if media_type is None:
        raise FileBrowserUnsupportedImageError(
            "path is not a supported raster image"
        )
    if target_stat.st_size > MAX_IMAGE_PREVIEW_BYTES:
        raise FileBrowserImageTooLargeError(
            "image exceeds the 25 MiB inline preview limit"
        )
    return FileBrowserImagePreview(
        path=target,
        name=parts[-1],
        media_type=media_type,
    )


def upload_file(
    root_path: str,
    relative_directory: str,
    filename: str,
    content: bytes,
    *,
    boundary: Path | None,
) -> dict[str, object]:
    if not isinstance(content, bytes):
        raise TypeError("file content must be bytes")
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        raise ValueError(
            f"file must be {MAX_FILE_UPLOAD_BYTES // (1024 * 1024)} MiB or smaller"
        )
    filename = _entry_name(filename)
    display_root, _resolved_root, target, directory_parts = _resolve_target(
        root_path,
        relative_directory,
        boundary,
    )
    if not stat.S_ISDIR(target.stat().st_mode):
        raise NotADirectoryError("upload destination is not a directory")

    file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    file_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_descriptor = _open_directory(target)
    try:
        try:
            descriptor = os.open(
                filename,
                file_flags,
                NEW_FILE_MODE,
                dir_fd=directory_descriptor,
            )
        except FileExistsError as error:
            raise FileBrowserDestinationExistsError(
                "a file or directory with this name already exists"
            ) from error

        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fchmod(output.fileno(), NEW_FILE_MODE)
                os.fsync(output.fileno())
                uploaded_stat = os.fstat(output.fileno())
        except BaseException:
            try:
                os.unlink(filename, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
            raise
    finally:
        os.close(directory_descriptor)

    return _stat_entry_payload(
        display_root,
        (*directory_parts, filename),
        uploaded_stat,
    )


def create_entry(
    root_path: str,
    relative_directory: str,
    name: str,
    kind: str = "directory",
    *,
    boundary: Path | None,
) -> dict[str, object]:
    """Create an empty directory or regular file inside the pane working tree."""
    if kind not in ENTRY_KINDS:
        raise ValueError("kind must be directory or file")
    name = _entry_name(name, "name")
    display_root, _resolved_root, target, directory_parts = _resolve_target(
        root_path,
        relative_directory,
        boundary,
    )
    if not stat.S_ISDIR(target.stat().st_mode):
        raise NotADirectoryError("destination is not a directory")

    directory_descriptor = _open_directory(target)
    try:
        if kind == "directory":
            try:
                os.mkdir(name, NEW_DIRECTORY_MODE, dir_fd=directory_descriptor)
            except FileExistsError as error:
                raise FileBrowserDestinationExistsError(
                    "a file or directory with this name already exists"
                ) from error
            try:
                os.chmod(
                    name,
                    NEW_DIRECTORY_MODE,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
                created_stat = os.stat(
                    name,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
            except BaseException:
                try:
                    os.rmdir(name, dir_fd=directory_descriptor)
                except OSError:
                    pass
                raise
        else:
            file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            file_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(
                    name,
                    file_flags,
                    NEW_FILE_MODE,
                    dir_fd=directory_descriptor,
                )
            except FileExistsError as error:
                raise FileBrowserDestinationExistsError(
                    "a file or directory with this name already exists"
                ) from error
            try:
                os.fchmod(descriptor, NEW_FILE_MODE)
                created_stat = os.fstat(descriptor)
            except BaseException:
                try:
                    os.unlink(name, dir_fd=directory_descriptor)
                except OSError:
                    pass
                raise
            finally:
                os.close(descriptor)
    finally:
        os.close(directory_descriptor)

    return _stat_entry_payload(
        display_root,
        (*directory_parts, name),
        created_stat,
    )


def _resolve_move_destination(
    root_path: str,
    destination_path: str,
    boundary: Path | None,
) -> tuple[Path, Path, tuple[str, ...]]:
    parts = _relative_parts(destination_path)
    if not parts:
        raise ValueError("destination must name an entry inside the pane working directory")
    _entry_name(parts[-1], "destination name")
    _display_root, resolved_root, resolved_parent, _parts = _resolve_parent(
        root_path,
        destination_path,
        boundary,
    )
    return resolved_root, resolved_parent, parts


def move_entry(
    root_path: str,
    relative_path: str,
    destination_path: str,
    *,
    boundary: Path | None,
) -> dict[str, object]:
    """Rename or move one entry to another location inside the same root."""
    display_root, resolved_root, source_parent, source_parts = _resolve_parent(
        root_path,
        relative_path,
        boundary,
    )
    _dest_root, destination_parent, destination_parts = _resolve_move_destination(
        root_path,
        destination_path,
        boundary,
    )
    source_name = source_parts[-1]
    destination_name = destination_parts[-1]

    source_path = source_parent / source_name
    source_stat = os.lstat(source_path)
    destination_target = destination_parent / destination_name
    if source_path == destination_target:
        raise ValueError("destination matches the current path")
    if stat.S_ISDIR(source_stat.st_mode) and _is_within(
        source_path,
        destination_parent,
    ):
        raise ValueError("a folder cannot be moved inside itself")
    if not _is_within(resolved_root, destination_target):
        raise FileBrowserPathOutsideRootError(
            "destination resolves outside the pane working directory"
        )

    source_descriptor = _open_directory(source_parent)
    try:
        destination_descriptor = (
            source_descriptor
            if destination_parent == source_parent
            else _open_directory(destination_parent)
        )
        try:
            # POSIX rename replaces an existing destination, so the name is
            # checked first. The remaining window is small and only spans the
            # caller's own working tree.
            try:
                os.lstat(destination_name, dir_fd=destination_descriptor)
            except FileNotFoundError:
                pass
            else:
                raise FileBrowserDestinationExistsError(
                    "a file or directory with this name already exists"
                )
            try:
                os.rename(
                    source_name,
                    destination_name,
                    src_dir_fd=source_descriptor,
                    dst_dir_fd=destination_descriptor,
                )
            except OSError as error:
                if error.errno == errno.EXDEV:
                    raise ValueError(
                        "cannot move across filesystems from the browser"
                    ) from error
                raise
            moved_stat = os.lstat(
                destination_name,
                dir_fd=destination_descriptor,
            )
        finally:
            if destination_descriptor != source_descriptor:
                os.close(destination_descriptor)
    finally:
        os.close(source_descriptor)

    if not stat.S_ISLNK(moved_stat.st_mode):
        return _stat_entry_payload(display_root, destination_parts, moved_stat)

    # A moved symlink is described the way the listing describes it: only a
    # target that resolves back inside the root may be stat()ed, so a rename can
    # never report the size, type, or mtime of a file outside the pane tree.
    target_stat: os.stat_result | None = None
    try:
        resolved_target = destination_target.resolve(strict=True)
        if _is_within(resolved_root, resolved_target):
            target_stat = resolved_target.stat()
    except (OSError, RuntimeError):
        target_stat = None
    if target_stat is None:
        return _entry_payload(
            display_root,
            destination_parts,
            kind="other",
            size=None,
            modified=None,
            symlink=True,
            accessible=False,
        )
    return _stat_entry_payload(
        display_root,
        destination_parts,
        target_stat,
        symlink=True,
    )


def copy_entry(
    root_path: str,
    relative_path: str,
    destination_path: str,
    *,
    boundary: Path | None,
) -> dict[str, object]:
    """Duplicate one regular file to another name inside the same root."""
    display_root, resolved_root, source_parent, source_parts = _resolve_parent(
        root_path,
        relative_path,
        boundary,
    )
    _dest_root, destination_parent, destination_parts = _resolve_move_destination(
        root_path,
        destination_path,
        boundary,
    )
    source_path = source_parent / source_parts[-1]
    destination_target = destination_parent / destination_parts[-1]
    if not _is_within(resolved_root, destination_target):
        raise FileBrowserPathOutsideRootError(
            "destination resolves outside the pane working directory"
        )
    if source_path == destination_target:
        raise ValueError("destination matches the current path")

    file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    file_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    source_parent_descriptor = _open_directory(source_parent)
    try:
        # Inspected through the descriptor the read below also uses.
        source_stat = os.lstat(source_parts[-1], dir_fd=source_parent_descriptor)
        if stat.S_ISDIR(source_stat.st_mode):
            raise IsADirectoryError("folders cannot be duplicated from the browser")
        if not stat.S_ISREG(source_stat.st_mode):
            raise FileBrowserUnsupportedFileError(
                "only regular files can be duplicated"
            )
        if source_stat.st_size > MAX_COPY_BYTES:
            raise FileBrowserContentTooLargeError(
                f"file must be {MAX_COPY_BYTES // (1024 * 1024)} MiB or smaller to duplicate"
            )

        mode = _preserved_mode(source_stat)
        destination_descriptor = _open_directory(destination_parent)
        try:
            try:
                descriptor = os.open(
                    destination_parts[-1],
                    file_flags,
                    mode,
                    dir_fd=destination_descriptor,
                )
            except FileExistsError as error:
                raise FileBrowserDestinationExistsError(
                    "a file or directory with this name already exists"
                ) from error
            try:
                # Opened relative to the validated parent and without following
                # links, so a symlink swapped in after the lstat above cannot
                # redirect the read outside the root.
                source_flags = os.O_RDONLY
                source_flags |= getattr(os, "O_CLOEXEC", 0)
                source_flags |= getattr(os, "O_NOFOLLOW", 0)
                try:
                    source_descriptor = os.open(
                        source_parts[-1],
                        source_flags,
                        dir_fd=source_parent_descriptor,
                    )
                except OSError as error:
                    # O_NOFOLLOW reports ELOOP when the name became a symlink
                    # after the stat above. Answering "too long or cannot be
                    # resolved" would describe the wrong problem entirely.
                    if error.errno != errno.ELOOP:
                        raise
                    raise FileBrowserUnsupportedFileError(
                        "only regular files can be duplicated"
                    ) from error
                with os.fdopen(source_descriptor, "rb") as source, os.fdopen(
                    descriptor,
                    "wb",
                ) as output:
                    shutil.copyfileobj(source, output, 256 * 1024)
                    output.flush()
                    os.fchmod(output.fileno(), mode)
                    os.fsync(output.fileno())
                    copied_stat = os.fstat(output.fileno())
            except BaseException:
                try:
                    os.unlink(destination_parts[-1], dir_fd=destination_descriptor)
                except OSError:
                    pass
                raise
        finally:
            os.close(destination_descriptor)
    finally:
        os.close(source_parent_descriptor)

    return _stat_entry_payload(display_root, destination_parts, copied_stat)


def delete_entry(
    root_path: str,
    relative_path: str,
    *,
    recursive: bool = False,
    boundary: Path | None,
) -> dict[str, object]:
    """Remove one file, symlink, or directory inside the browsed tree."""
    display_root, _resolved_root, parent, parts = _resolve_parent(
        root_path,
        relative_path,
        boundary,
    )
    name = parts[-1]
    target = parent / name
    removed_entries = 0

    directory_descriptor = _open_directory(parent)
    try:
        # Taken through the descriptor so the entry inspected here is the one
        # the removal below acts on, even if a parent were swapped in between.
        entry_stat = os.lstat(name, dir_fd=directory_descriptor)
        is_directory = stat.S_ISDIR(entry_stat.st_mode)
        if not is_directory:
            os.unlink(name, dir_fd=directory_descriptor)
        elif _directory_is_empty(target):
            os.rmdir(name, dir_fd=directory_descriptor)
        elif not recursive:
            counted = _count_tree_entries(target, MAX_RECURSIVE_DELETE_ENTRIES)
            raise FileBrowserDirectoryNotEmptyError(
                f"folder is not empty and holds {counted.describe()}"
            )
        else:
            counted = _count_tree_entries(target, MAX_RECURSIVE_DELETE_ENTRIES)
            if counted.capped:
                raise ValueError(
                    "folder holds too many entries to delete from the browser; "
                    f"the limit is {MAX_RECURSIVE_DELETE_ENTRIES:,}"
                )
            _remove_tree(name, target, directory_descriptor, counted.total)
            removed_entries = counted.total
    finally:
        os.close(directory_descriptor)

    return {
        **_path_payload(display_root, parts),
        "name": name,
        "kind": _stat_kind(entry_stat.st_mode),
        "symlink": stat.S_ISLNK(entry_stat.st_mode),
        "removedEntries": removed_entries,
    }


def write_text_file(
    root_path: str,
    relative_path: str,
    content: str,
    *,
    expected_modified: float | None = None,
    boundary: Path | None,
) -> dict[str, object]:
    """Replace the contents of one existing regular file atomically."""
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_TEXT_WRITE_BYTES:
        raise FileBrowserContentTooLargeError(
            f"file must be {MAX_TEXT_WRITE_BYTES // (1024 * 1024)} MiB or smaller to save"
        )

    display_root, _resolved_root, parent, parts = _resolve_parent(
        root_path,
        relative_path,
        boundary,
    )
    name = parts[-1]
    file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    file_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_descriptor = _open_directory(parent)
    try:
        # Inspected through the descriptor the rename below also uses, so the
        # file these checks accept is the file that gets replaced.
        target_stat = os.lstat(name, dir_fd=directory_descriptor)
        if stat.S_ISDIR(target_stat.st_mode):
            raise IsADirectoryError("path is a directory")
        if stat.S_ISLNK(target_stat.st_mode):
            raise FileBrowserUnsupportedFileError(
                "symlinked files cannot be edited from the browser"
            )
        if not stat.S_ISREG(target_stat.st_mode):
            raise FileBrowserUnsupportedFileError("path is not a regular file")
        if (
            expected_modified is not None
            and round(target_stat.st_mtime, 3) != round(expected_modified, 3)
        ):
            raise FileBrowserConflictError(
                "the file changed on disk since it was opened; reload before saving"
            )

        mode = _preserved_mode(target_stat)
        temporary_name: str | None = None
        for attempt in range(10):
            candidate = f".{name}.muxdeck-{os.getpid()}-{attempt}.tmp"
            if len(candidate.encode("utf-8")) > MAX_FILE_NAME_BYTES:
                candidate = f".muxdeck-{os.getpid()}-{attempt}.tmp"
            try:
                descriptor = os.open(
                    candidate,
                    file_flags,
                    mode,
                    dir_fd=directory_descriptor,
                )
            except FileExistsError:
                continue
            temporary_name = candidate
            break
        if temporary_name is None:
            raise OSError("unable to allocate a temporary file for the save")

        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(encoded)
                output.flush()
                os.fchmod(output.fileno(), mode)
                os.fsync(output.fileno())
            os.rename(
                temporary_name,
                name,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
            )
        except BaseException:
            try:
                os.unlink(temporary_name, dir_fd=directory_descriptor)
            except OSError:
                pass
            raise
        os.fsync(directory_descriptor)
        saved_stat = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
    finally:
        os.close(directory_descriptor)

    payload = _stat_entry_payload(display_root, parts, saved_stat)
    payload["root"] = str(display_root)
    return payload
