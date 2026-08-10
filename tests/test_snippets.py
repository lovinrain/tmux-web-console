from __future__ import annotations

import json
import os
import stat
from concurrent.futures import ThreadPoolExecutor

import pytest

from tmux_console.snippets import (
    MAX_SNIPPET_ID_LENGTH,
    MAX_SNIPPET_NAME_LENGTH,
    MAX_SNIPPET_REVISION,
    MAX_SNIPPET_TEXT_LENGTH,
    MAX_SNIPPET_TREE_DEPTH,
    MAX_SNIPPET_TREE_NODES,
    SNIPPET_STORE_UNAVAILABLE_MESSAGE,
    SnippetRevisionConflict,
    SnippetStore,
    SnippetStoreUnavailable,
    default_snippets_path,
)


def snippet(
    node_id: str, name: str | None = None, text: str = "run the checks"
) -> dict[str, object]:
    return {
        "id": node_id,
        "type": "snippet",
        "name": name or node_id,
        "text": text,
    }


def folder(
    node_id: str, children: list[dict[str, object]], name: str | None = None
) -> dict[str, object]:
    return {
        "id": node_id,
        "type": "folder",
        "name": name or node_id,
        "children": children,
    }


def test_snippet_tree_persists_hierarchy_order_text_and_revision(tmp_path):
    path = tmp_path / "snippets.json"
    store = SnippetStore(path)
    tree = [
        folder(
            "deploy",
            [
                snippet("status", " Status ", "git status\n"),
                folder(
                    "checks",
                    [snippet("unicode", "Unicode", "echo '你好'\n")],
                    " Checks ",
                ),
            ],
            " Deployment ",
        ),
        snippet("standalone", "Standalone", "  preserve whitespace  \n"),
    ]

    assert store.get_snapshot() == {"revision": 0, "tree": []}
    saved = store.replace_tree(tree, expected_revision=0)

    assert saved["revision"] == 1
    assert saved["tree"][0]["name"] == "Deployment"
    assert saved["tree"][0]["children"][0]["name"] == "Status"
    assert saved["tree"][1]["text"] == "  preserve whitespace  \n"
    assert SnippetStore(path).get_snapshot() == saved

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {"version": 1, **saved}
    assert list(tmp_path.glob(".snippets.json.*.tmp")) == []

    reordered = [saved["tree"][1], saved["tree"][0]]
    updated = store.replace_tree(reordered, expected_revision=1)
    assert updated["revision"] == 2
    assert [node["id"] for node in updated["tree"]] == ["standalone", "deploy"]


def test_stale_revision_cannot_overwrite_a_newer_tree(tmp_path):
    store = SnippetStore(tmp_path / "snippets.json")
    current = store.replace_tree([snippet("current")], expected_revision=0)

    with pytest.raises(SnippetRevisionConflict) as caught:
        store.replace_tree([snippet("stale")], expected_revision=0)

    assert caught.value.expected_revision == 0
    assert caught.value.current_revision == 1
    assert store.get_snapshot() == current


def test_revision_is_limited_to_javascript_safe_integers(tmp_path):
    path = tmp_path / "snippets.json"
    payload = {"version": 1, "revision": MAX_SNIPPET_REVISION, "tree": []}
    path.write_text(json.dumps(payload), encoding="utf-8")
    store = SnippetStore(path)

    assert store.get_snapshot() == {
        "revision": MAX_SNIPPET_REVISION,
        "tree": [],
    }
    with pytest.raises(ValueError, match="maximum safe value"):
        store.replace_tree(
            [snippet("overflow")], expected_revision=MAX_SNIPPET_REVISION
        )
    assert json.loads(path.read_text(encoding="utf-8")) == payload

    with pytest.raises(ValueError, match=f"cannot exceed {MAX_SNIPPET_REVISION}"):
        SnippetStore(tmp_path / "empty.json").replace_tree(
            [], expected_revision=MAX_SNIPPET_REVISION + 1
        )


def test_concurrent_writers_with_one_revision_have_exactly_one_winner(tmp_path):
    path = tmp_path / "snippets.json"
    store = SnippetStore(path)

    def replace(node_id: str) -> str:
        try:
            store.replace_tree([snippet(node_id)], expected_revision=0)
        except SnippetRevisionConflict:
            return "conflict"
        return "saved"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(replace, ["alpha", "beta"]))

    assert sorted(outcomes) == ["conflict", "saved"]
    snapshot = store.get_snapshot()
    assert snapshot["revision"] == 1
    assert snapshot["tree"][0]["id"] in {"alpha", "beta"}
    assert SnippetStore(path).get_snapshot() == snapshot


def test_failed_persistence_does_not_change_memory_or_revision(tmp_path, monkeypatch):
    store = SnippetStore(tmp_path / "snippets.json")

    def fail_persist(_revision, _tree):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist", fail_persist)
    with pytest.raises(OSError, match="disk full"):
        store.replace_tree([snippet("not-saved")], expected_revision=0)

    assert store.get_snapshot() == {"revision": 0, "tree": []}


def test_persistence_fsyncs_file_then_parent_directory(tmp_path, monkeypatch):
    store = SnippetStore(tmp_path / "snippets.json")
    real_fsync = os.fsync
    synced: list[str] = []

    def record_fsync(file_descriptor):
        kind = (
            "directory"
            if stat.S_ISDIR(os.fstat(file_descriptor).st_mode)
            else "file"
        )
        synced.append(kind)
        real_fsync(file_descriptor)

    monkeypatch.setattr(os, "fsync", record_fsync)
    store.replace_tree([snippet("saved")], expected_revision=0)

    assert synced == ["file", "directory"]


def test_directory_fsync_failure_keeps_memory_consistent_with_replaced_file(
    tmp_path, monkeypatch
):
    path = tmp_path / "snippets.json"
    store = SnippetStore(path)
    real_fsync = os.fsync

    def fail_directory_fsync(file_descriptor):
        if stat.S_ISDIR(os.fstat(file_descriptor).st_mode):
            raise OSError("directory sync failed")
        real_fsync(file_descriptor)

    monkeypatch.setattr(os, "fsync", fail_directory_fsync)
    with pytest.raises(OSError, match="directory sync failed"):
        store.replace_tree([snippet("committed")], expected_revision=0)

    expected = {"revision": 1, "tree": [snippet("committed")]}
    assert store.get_snapshot() == expected
    assert SnippetStore(path).get_snapshot() == expected


@pytest.mark.parametrize(
    ("tree", "error"),
    [
        ({}, "tree must be an array"),
        (["node"], "tree[0] must be an object"),
        ([{"id": "x", "name": "X", "text": "x"}], "tree[0].type"),
        ([snippet("x") | {"extra": True}], "unknown field: extra"),
        ([{"id": "x", "type": "folder", "name": "X"}], "missing field"),
        ([snippet("x") | {"children": []}], "unknown field: children"),
        ([folder("x", [], name=" \n ")], "name cannot be blank"),
        ([snippet("x", text=" \n\t")], "text cannot be blank"),
        ([snippet("bad\nid")], "id cannot contain control"),
        ([snippet("x", name="bad\tname")], "name cannot contain control"),
        (
            [folder("same", [snippet("same")])],
            "duplicate snippet node id: same",
        ),
    ],
)
def test_tree_shape_and_value_validation(tree, error, tmp_path):
    with pytest.raises(ValueError) as caught:
        SnippetStore(tmp_path / "snippets.json").replace_tree(
            tree, expected_revision=0
        )
    assert error in str(caught.value)


@pytest.mark.parametrize(
    ("tree", "error"),
    [
        ([snippet("x" * (MAX_SNIPPET_ID_LENGTH + 1))], "id must be 128"),
        (
            [snippet("x", name="x" * (MAX_SNIPPET_NAME_LENGTH + 1))],
            "name must be 120",
        ),
        (
            [snippet("x", text="x" * (MAX_SNIPPET_TEXT_LENGTH + 1))],
            "text must be 65536",
        ),
    ],
)
def test_per_field_size_limits(tree, error, tmp_path):
    with pytest.raises(ValueError, match=error):
        SnippetStore(tmp_path / "snippets.json").replace_tree(
            tree, expected_revision=0
        )


def test_tree_depth_node_count_and_total_size_limits(tmp_path):
    def nested(depth: int) -> dict[str, object]:
        node = snippet(f"node-{depth}")
        for level in range(depth - 1, 0, -1):
            node = folder(f"node-{level}", [node])
        return node

    SnippetStore(tmp_path / "depth-ok.json").replace_tree(
        [nested(MAX_SNIPPET_TREE_DEPTH)], expected_revision=0
    )
    with pytest.raises(ValueError, match="cannot be deeper"):
        SnippetStore(tmp_path / "too-deep.json").replace_tree(
            [nested(MAX_SNIPPET_TREE_DEPTH + 1)], expected_revision=0
        )

    too_many = [snippet(f"node-{index}") for index in range(MAX_SNIPPET_TREE_NODES + 1)]
    with pytest.raises(ValueError, match="cannot contain more than"):
        SnippetStore(tmp_path / "too-many.json").replace_tree(
            too_many, expected_revision=0
        )

    too_large = [
        snippet(f"large-{index}", text="x" * MAX_SNIPPET_TEXT_LENGTH)
        for index in range(14)
    ]
    with pytest.raises(ValueError, match="UTF-8 bytes or fewer"):
        SnippetStore(tmp_path / "too-large.json").replace_tree(
            too_large, expected_revision=0
        )


def test_invalid_persisted_tree_fails_closed_without_rewriting_file(tmp_path):
    path = tmp_path / "snippets.json"
    original = json.dumps(
        {
            "version": 1,
            "revision": 9,
            "tree": [snippet("duplicate"), snippet("duplicate")],
        }
    )
    path.write_text(original, encoding="utf-8")

    store = SnippetStore(path)
    with pytest.raises(
        SnippetStoreUnavailable, match="snippet storage is unavailable"
    ):
        store.get_snapshot()
    with pytest.raises(SnippetStoreUnavailable):
        store.replace_tree([snippet("replacement")], expected_revision=0)
    assert path.read_text(encoding="utf-8") == original


@pytest.mark.parametrize(
    "contents",
    [
        b"not JSON",
        b"\xff\xfe",
        json.dumps({"version": True, "revision": 0, "tree": []}).encode(),
        json.dumps(
            {
                "version": 1,
                "revision": MAX_SNIPPET_REVISION + 1,
                "tree": [],
            }
        ).encode(),
        b'{"version":1,"revision":' + (b"9" * 5_000) + b',"tree":[]}',
        b'{"version":1,"revision":0,"tree":'
        + (b"[" * 10_000)
        + b"0"
        + (b"]" * 10_000)
        + b"}",
    ],
)
def test_unreadable_or_unsupported_persisted_documents_fail_closed(
    contents, tmp_path
):
    path = tmp_path / "snippets.json"
    path.write_bytes(contents)

    store = SnippetStore(path)
    with pytest.raises(SnippetStoreUnavailable) as caught:
        store.get_snapshot()
    assert str(caught.value) == SNIPPET_STORE_UNAVAILABLE_MESSAGE
    with pytest.raises(SnippetStoreUnavailable):
        store.replace_tree([snippet("replacement")], expected_revision=0)
    assert path.read_bytes() == contents


def test_existing_unreadable_state_path_fails_closed(tmp_path):
    path = tmp_path / "snippets.json"
    path.mkdir()

    store = SnippetStore(path)

    with pytest.raises(SnippetStoreUnavailable):
        store.get_snapshot()
    with pytest.raises(SnippetStoreUnavailable):
        store.replace_tree([snippet("replacement")], expected_revision=0)
    assert path.is_dir()


def test_broken_state_symlink_fails_closed_instead_of_becoming_a_new_file(tmp_path):
    path = tmp_path / "snippets.json"
    path.symlink_to(tmp_path / "missing-target.json")

    store = SnippetStore(path)

    with pytest.raises(SnippetStoreUnavailable):
        store.get_snapshot()
    with pytest.raises(SnippetStoreUnavailable):
        store.replace_tree([snippet("replacement")], expected_revision=0)
    assert path.is_symlink()


def test_default_path_honors_snippets_environment_variable(tmp_path, monkeypatch):
    configured = tmp_path / "nested" / "custom.json"
    monkeypatch.setenv("MUXDECK_SNIPPETS_FILE", str(configured))

    assert default_snippets_path() == configured
    store = SnippetStore()
    store.replace_tree([snippet("saved")], expected_revision=0)
    assert configured.is_file()
