from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger("muxdeck.snippets")
MAX_SNIPPET_ID_LENGTH = 128
MAX_SNIPPET_NAME_LENGTH = 120
MAX_SNIPPET_TEXT_LENGTH = 65_536
MAX_SNIPPET_TREE_DEPTH = 12
MAX_SNIPPET_TREE_NODES = 2_000
MAX_SNIPPET_TREE_BYTES = 900_000
MAX_SNIPPET_REVISION = (1 << 53) - 1
SNIPPET_STORE_UNAVAILABLE_MESSAGE = (
    "snippet storage is unavailable; inspect and repair the configured snippets "
    "file, then restart Muxdeck"
)


def default_snippets_path() -> Path:
    configured = os.environ.get("MUXDECK_SNIPPETS_FILE")
    if configured:
        return Path(configured).expanduser()
    state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state_root / "muxdeck" / "snippets.json"


def _validate_unicode(value: str, field: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must contain valid Unicode") from error


def _validate_id(value: object, path: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{path}.id must be a string")
    if not value.strip():
        raise ValueError(f"{path}.id cannot be blank")
    if len(value) > MAX_SNIPPET_ID_LENGTH:
        raise ValueError(
            f"{path}.id must be {MAX_SNIPPET_ID_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f"{path}.id cannot contain control characters")
    _validate_unicode(value, f"{path}.id")
    return value


def _normalize_name(value: object, path: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{path}.name must be a string")
    name = value.strip()
    if not name:
        raise ValueError(f"{path}.name cannot be blank")
    if len(name) > MAX_SNIPPET_NAME_LENGTH:
        raise ValueError(
            f"{path}.name must be {MAX_SNIPPET_NAME_LENGTH} characters or fewer"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise ValueError(f"{path}.name cannot contain control characters")
    _validate_unicode(name, f"{path}.name")
    return name


def _validate_text(value: object, path: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{path}.text must be a string")
    if not value.strip():
        raise ValueError(f"{path}.text cannot be blank")
    if len(value) > MAX_SNIPPET_TEXT_LENGTH:
        raise ValueError(
            f"{path}.text must be {MAX_SNIPPET_TEXT_LENGTH} characters or fewer"
        )
    _validate_unicode(value, f"{path}.text")
    return value


def _validate_revision(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("revision must be an integer")
    if value < 0:
        raise ValueError("revision cannot be negative")
    if value > MAX_SNIPPET_REVISION:
        raise ValueError(f"revision cannot exceed {MAX_SNIPPET_REVISION}")
    return value


@dataclass(frozen=True)
class Snippet:
    id: str
    name: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "snippet",
            "name": self.name,
            "text": self.text,
        }


@dataclass(frozen=True)
class SnippetFolder:
    id: str
    name: str
    children: tuple[SnippetNode, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "folder",
            "name": self.name,
            "children": [child.to_dict() for child in self.children],
        }


SnippetNode = Snippet | SnippetFolder


class SnippetRevisionConflict(LookupError):
    def __init__(self, expected_revision: int, current_revision: int) -> None:
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            "snippet tree changed; "
            f"expected revision {expected_revision}, current revision is {current_revision}"
        )


class SnippetStoreUnavailable(RuntimeError):
    pass


class _SnippetDirectorySyncError(OSError):
    pass


class _TreeValidator:
    def __init__(self) -> None:
        self._ids: set[str] = set()
        self._node_count = 0

    def validate(self, tree: object) -> tuple[SnippetNode, ...]:
        if not isinstance(tree, list):
            raise ValueError("tree must be an array")
        nodes = tuple(
            self._node(node, depth=1, path=f"tree[{index}]")
            for index, node in enumerate(tree)
        )
        serialized = [node.to_dict() for node in nodes]
        size = len(
            json.dumps(
                serialized,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        if size > MAX_SNIPPET_TREE_BYTES:
            raise ValueError(
                f"tree must be {MAX_SNIPPET_TREE_BYTES} UTF-8 bytes or fewer"
            )
        return nodes

    def _node(self, value: object, *, depth: int, path: str) -> SnippetNode:
        if depth > MAX_SNIPPET_TREE_DEPTH:
            raise ValueError(
                f"tree cannot be deeper than {MAX_SNIPPET_TREE_DEPTH} levels"
            )
        if not isinstance(value, dict):
            raise ValueError(f"{path} must be an object")

        node_type = value.get("type")
        if node_type == "folder":
            expected_fields = {"id", "type", "name", "children"}
        elif node_type == "snippet":
            expected_fields = {"id", "type", "name", "text"}
        else:
            raise ValueError(f"{path}.type must be 'folder' or 'snippet'")
        self._validate_fields(value, expected_fields, path)

        self._node_count += 1
        if self._node_count > MAX_SNIPPET_TREE_NODES:
            raise ValueError(
                f"tree cannot contain more than {MAX_SNIPPET_TREE_NODES} nodes"
            )

        node_id = _validate_id(value["id"], path)
        if node_id in self._ids:
            raise ValueError(f"duplicate snippet node id: {node_id}")
        self._ids.add(node_id)
        name = _normalize_name(value["name"], path)

        if node_type == "snippet":
            return Snippet(
                id=node_id,
                name=name,
                text=_validate_text(value["text"], path),
            )

        children = value["children"]
        if not isinstance(children, list):
            raise ValueError(f"{path}.children must be an array")
        return SnippetFolder(
            id=node_id,
            name=name,
            children=tuple(
                self._node(
                    child,
                    depth=depth + 1,
                    path=f"{path}.children[{index}]",
                )
                for index, child in enumerate(children)
            ),
        )

    @staticmethod
    def _validate_fields(
        value: dict[object, object], expected: set[str], path: str
    ) -> None:
        actual = set(value)
        actual_strings = {field for field in actual if isinstance(field, str)}
        missing = sorted(expected - actual_strings)
        if missing:
            raise ValueError(f"{path} is missing field: {missing[0]}")
        unknown = sorted(str(field) for field in actual - expected)
        if unknown:
            raise ValueError(f"{path} has unknown field: {unknown[0]}")


class SnippetStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_snippets_path()
        self._lock = threading.RLock()
        self._load_error: str | None = None
        self._revision, self._tree = self._load()

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._ensure_available()
            return self._serialize(self._revision, self._tree)

    def replace_tree(
        self, tree: object, *, expected_revision: int
    ) -> dict[str, Any]:
        with self._lock:
            self._ensure_available()
        expected_revision = _validate_revision(expected_revision)
        validated = _TreeValidator().validate(tree)

        with self._lock:
            self._ensure_available()
            if expected_revision != self._revision:
                raise SnippetRevisionConflict(expected_revision, self._revision)
            if self._revision == MAX_SNIPPET_REVISION:
                raise ValueError("revision has reached the maximum safe value")
            next_revision = self._revision + 1
            try:
                self._persist(next_revision, validated)
            except _SnippetDirectorySyncError:
                # The rename already committed, so memory must match the file even
                # though the caller is told durability could not be confirmed.
                self._tree = validated
                self._revision = next_revision
                raise
            self._tree = validated
            self._revision = next_revision
            return self._serialize(self._revision, self._tree)

    def _load(self) -> tuple[int, tuple[SnippetNode, ...]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("document must be an object")
            version = payload.get("version")
            if isinstance(version, bool) or version != 1:
                raise ValueError("unsupported document version")
            revision = _validate_revision(payload.get("revision"))
            tree = _TreeValidator().validate(payload.get("tree"))
        except FileNotFoundError as error:
            if not self.path.is_symlink():
                return 0, ()
            self._record_load_error(error)
            return 0, ()
        except (OSError, ValueError, RecursionError) as error:
            self._record_load_error(error)
            return 0, ()
        return revision, tree

    def _record_load_error(self, error: BaseException) -> None:
        self._load_error = f"{type(error).__name__}: {error}"
        LOGGER.error(
            "Snippet storage is unavailable because %s could not be loaded: %s. "
            "Refusing reads and writes until Muxdeck restarts with a valid file.",
            self.path,
            error,
        )

    def _ensure_available(self) -> None:
        if self._load_error is not None:
            raise SnippetStoreUnavailable(SNIPPET_STORE_UNAVAILABLE_MESSAGE)

    @staticmethod
    def _serialize(
        revision: int, tree: tuple[SnippetNode, ...]
    ) -> dict[str, Any]:
        return {
            "revision": revision,
            "tree": [node.to_dict() for node in tree],
        }

    def _persist(self, revision: int, tree: tuple[SnippetNode, ...]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        directory_fd: int | None = None
        try:
            directory_fd = os.open(
                self.path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
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
                        "version": 1,
                        **self._serialize(revision, tree),
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                os.fsync(directory_fd)
            except OSError as error:
                raise _SnippetDirectorySyncError(
                    f"unable to sync snippet state directory: {error}"
                ) from error
        finally:
            if directory_fd is not None:
                with contextlib.suppress(OSError):
                    os.close(directory_fd)
            if temporary is not None:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
