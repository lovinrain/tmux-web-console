from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, call

import pytest

from tmux_console.agent_transcripts import AgentTranscriptReader, TranscriptChangedError
from tmux_console.submitted_messages import (
    SubmittedMessageStore,
    SubmittedMessageStoreUnavailable,
)

CODEX_ID = "11111111-1111-4111-8111-111111111111"
CLAUDE_ID = "22222222-2222-4222-8222-222222222222"
OTHER_ID = "33333333-3333-4333-8333-333333333333"


def reference(agent="codex", identifier=CODEX_ID):
    return {"agentType": agent, "agentSessionId": identifier}


def codex(text, timestamp=1000, identifier=CODEX_ID):
    return {"session_id": identifier, "ts": timestamp, "text": text}


def claude(text, pasted=None, timestamp=1000000):
    return {"sessionId": CLAUDE_ID, "timestamp": timestamp, "display": text, "pastedContents": pasted or {}}


def write_history(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


@pytest.fixture
def archive(tmp_path):
    paths = {agent: tmp_path / agent / "history.jsonl" for agent in ("codex", "claude")}
    store = SubmittedMessageStore(tmp_path / "archive.sqlite3", history_paths=paths)
    yield store, paths
    store.close()


def test_backfills_only_known_conversations_and_keeps_intentional_repeats(archive):
    store, paths = archive
    records = [codex("  Final edited prompt\n第二行  "), codex("again"), codex("again"), codex("unrelated", identifier=OTHER_ID)]
    write_history(paths["codex"], records)
    refs = [reference()]
    store.sync(refs)
    store.sync(refs)
    page = store.list_messages(refs)
    assert [item["text"] for item in page["messages"]] == ["again", "again", "  Final edited prompt\n第二行  "]
    assert all(item["complete"] for item in page["messages"])
    # A newly identified conversation is backfilled even if the file did not change.
    other = reference(identifier=OTHER_ID)
    store.sync([*refs, other])
    assert [item["text"] for item in store.list_messages([other])["messages"]] == ["unrelated"]


def test_rotation_and_restart_do_not_erase_or_duplicate_saved_input(archive):
    store, paths = archive
    refs = [reference()]
    write_history(paths["codex"], [codex("older"), codex("retained", 1001)])
    store.sync(refs)
    paths["codex"].rename(paths["codex"].with_suffix(".old"))
    write_history(paths["codex"], [codex("retained", 1001), codex("new", 1002)])
    store.sync(refs)
    store.close()
    paths["codex"].unlink()
    reopened = SubmittedMessageStore(store.path, history_paths=paths)
    try:
        reopened.sync(refs)
        page = reopened.list_messages(refs)
        assert [item["text"] for item in page["messages"]] == ["new", "retained", "older"]
        assert page["sources"] == [{"agentType": "codex", "status": "missing"}]
        assert store.path.stat().st_mode & 0o777 == 0o600
    finally:
        reopened.close()


def test_claude_preserves_final_edits_and_expands_inline_and_cached_pastes(archive):
    store, paths = archive
    cache = paths["claude"].parent / "paste-cache"
    cache.mkdir(parents=True)
    digest = "abcdef0123456789"
    (cache / f"{digest}.txt").write_text("cached\nlarge paste", encoding="utf-8")
    records = [claude("Edited before [Pasted text #1 +2 lines]\nand after [Pasted text #2]", {
        "1": {"id": 1, "type": "text", "content": "inline\npaste"},
        "2": {"id": 2, "type": "text", "contentHash": digest},
    })]
    write_history(paths["claude"], records)
    refs = [reference("claude", CLAUDE_ID)]
    store.sync(refs)
    entry = store.list_messages(refs)["messages"][0]
    assert entry["text"] == "Edited before inline\npaste\nand after cached\nlarge paste"
    assert entry["submittedAt"] == 1000000
    assert entry["complete"]
    (cache / f"{digest}.txt").unlink()
    store.sync(refs)
    assert store.list_messages(refs)["messages"] == [entry]


def test_missing_paste_can_be_filled_later_without_duplicate_messages(archive):
    store, paths = archive
    digest = "abcdef0123456789"
    write_history(paths["claude"], [claude("fix [Pasted text #1]", {
        "1": {"id": 1, "type": "text", "contentHash": digest},
    })])
    refs = [reference("claude", CLAUDE_ID)]
    store.sync(refs)
    entry = store.list_messages(refs)["messages"][0]
    assert not entry["complete"]
    cache = paths["claude"].parent / "paste-cache"
    cache.mkdir()
    (cache / f"{digest}.txt").write_text("the final issue", encoding="utf-8")
    store.sync(refs)
    result = store.list_messages(refs)["messages"]
    assert len(result) == 1
    assert result[0]["id"] == entry["id"]
    assert result[0]["text"] == "fix the final issue"
    assert result[0]["complete"]


def test_cache_references_cannot_escape_and_attachments_are_marked(archive, tmp_path):
    store, paths = archive
    (tmp_path / "private.txt").write_text("must not be read")
    cache = paths["claude"].parent / "paste-cache"
    cache.mkdir(parents=True)
    (cache / "abcdef0123456789.txt").symlink_to(tmp_path / "private.txt")
    write_history(paths["claude"], [claude("[Pasted text #1] [Pasted text #2] [Image #3]", {
        "1": {"type": "text", "contentHash": "../../private"},
        "2": {"type": "text", "contentHash": "abcdef0123456789"},
        "3": {"type": "image", "content": "image-bytes"},
    })])
    refs = [reference("claude", CLAUDE_ID)]
    store.sync(refs)
    entry = store.list_messages(refs)["messages"][0]
    assert entry["text"] == "[Pasted text #1] [Pasted text #2] [Image #3]"
    assert not entry["complete"]


def test_pagination_stays_stable_while_new_messages_arrive_and_searches_all_input(archive):
    store, paths = archive
    refs = [reference()]
    records = [codex(f"message {index}") for index in range(5)]
    write_history(paths["codex"], records)
    store.sync(refs)
    first = store.list_messages(refs, limit=2)
    write_history(paths["codex"], [*records, codex("newest")])
    store.sync(refs)
    second = store.list_messages(refs, limit=2, before=first["nextCursor"])
    third = store.list_messages(refs, limit=2, before=second["nextCursor"])
    assert [item["text"] for page in (first, second, third) for item in page["messages"]] == [f"message {index}" for index in reversed(range(5))]
    assert third["nextCursor"] is None
    assert [item["text"] for item in store.list_messages(refs, query="MESSAGE 0")["messages"]] == ["message 0"]


def test_partial_writes_and_malformed_records_do_not_lose_later_submissions(archive):
    store, paths = archive
    refs = [reference()]
    write_history(paths["codex"], [codex("valid"), codex("bad timestamp", 10**1000), codex("bad unicode \ud800")])
    with paths["codex"].open("ab") as source:
        source.write(b'invalid json\n' + json.dumps(codex("appending", 1001)).encode()[:-1])
    store.sync(refs)
    assert [item["text"] for item in store.list_messages(refs)["messages"]] == ["valid"]
    with paths["codex"].open("ab") as source:
        source.write(b'}\n')
    store.sync(refs)
    page = store.list_messages(refs)
    assert [item["text"] for item in page["messages"]] == ["appending", "valid"]
    assert page["sources"][0]["status"] == "partial"


def test_concurrent_refreshes_do_not_duplicate_messages(archive):
    store, paths = archive
    refs = [reference()]
    write_history(paths["codex"], [codex(f"message {index}") for index in range(30)])
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(lambda _: store.sync(refs), range(8)))
    assert len(store.list_messages(refs)["messages"]) == 30


def native_prompt(source_id, text, **fields):
    return {
        "id": f"display:{source_id}", "sourceId": source_id, "text": text,
        "timestamp": 1_767_225_600_000, "kind": "prompt", "role": "user", **fields,
    }


def native_page(*messages, cursor=None, partial=False):
    return {"messages": list(messages), "status": "available", "nextCursor": cursor, "partial": partial}


@pytest.mark.parametrize(("agent", "identifier"), [
    ("pi", "Pi_history-A"), ("omp", "OMP_history-A"), ("opencode", "ses_" + "aZ" * 13),
    ("agy", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
])
def test_native_archive_keeps_distinct_submissions_and_exact_conversation_ids(archive, agent, identifier):
    store, paths = archive
    refs = [reference(agent, identifier)]
    reader = Mock(spec=AgentTranscriptReader)
    reader.native_source_signature.return_value = (1,)
    reader.read_native_prompts.return_value = native_page(
        native_prompt("first", "  full prompt\n第二行  "),
        native_prompt("repeat", "  full prompt\n第二行  "),
        native_prompt("attachment", "draft", sourceText="Final text\n\n[Attachments]", complete=False),
        native_prompt("system", "Generated context", kind="context"),
        native_prompt("assistant", "Assistant output", role="assistant", kind="response"),
    )
    store.sync_native(refs, reader)
    store.sync_native(refs, reader)
    reader.read_native_prompts.assert_called_once_with(agent, identifier, cursor=None, limit=100)
    expected = store.list_messages(refs)
    assert [entry["text"] for entry in expected["messages"]] == [
        "Final text\n\n[Attachments]", "  full prompt\n第二行  ", "  full prompt\n第二行  ",
    ]
    assert [entry["complete"] for entry in expected["messages"]] == [False, True, True]
    assert {entry["submittedAt"] for entry in expected["messages"]} == {1_767_225_600_000}
    assert {entry["agentSessionId"] for entry in expected["messages"]} == {identifier}
    assert expected["sources"] == [{"agentType": agent, "status": "available"}]
    if agent != "agy":
        assert store.list_messages([reference(agent, identifier.lower())])["messages"] == []

    reader.native_source_signature.return_value = (2,)
    reader.read_native_prompts.return_value = native_page(
        native_prompt("first", "  full prompt\n第二行  ", id="changed display position"),
        native_prompt("repeat", "  full prompt\n第二行  ", id="changed display position again"),
        native_prompt("attachment", "Final text with restored content", complete=True),
    )
    store.sync_native(refs, reader)
    updated = store.list_messages(refs)["messages"]
    assert [entry["id"] for entry in updated] == [entry["id"] for entry in expected["messages"]]
    assert updated[0]["text"] == "Final text with restored content"
    assert all(entry["complete"] for entry in updated)

    store.close()
    reader.native_source_signature.return_value = None
    reopened = SubmittedMessageStore(store.path, history_paths=paths)
    try:
        reopened.sync_native(refs, reader)
        assert reopened.list_messages(refs) == {
            "messages": updated, "nextCursor": None,
            "sources": [{"agentType": agent, "status": "missing"}],
        }
    finally:
        reopened.close()


def test_native_archive_resumes_pages_and_retries_replaced_sources(archive, monkeypatch):
    monkeypatch.setattr("tmux_console.submitted_messages.MAX_NATIVE_PAGES_PER_SYNC", 1)
    store, _ = archive
    refs = [reference("pi", "Pi_history-A")]
    reader = Mock(spec=AgentTranscriptReader)
    reader.native_source_signature.return_value = (1,)
    reader.read_native_prompts.side_effect = [
        native_page(native_prompt("first", "First input"), cursor="next"),
        native_page(native_prompt("second", "Second input"), cursor="later"),
        TranscriptChangedError(),
        native_page(native_prompt("third", "New input"), partial=True),
    ]
    store.sync_native(refs, reader)
    assert store.list_messages(refs)["sources"] == [{"agentType": "pi", "status": "partial"}]
    store.sync_native(refs, reader)
    reader.native_source_signature.return_value = (2,)
    store.sync_native(refs, reader)
    assert [entry["text"] for entry in store.list_messages(refs)["messages"]] == ["Second input", "First input"]
    store.sync_native(refs, reader)
    store.sync_native(refs, reader)
    assert reader.read_native_prompts.call_args_list == [
        call("pi", "Pi_history-A", cursor=cursor, limit=100)
        for cursor in (None, "next", "later", None)
    ]
    saved = store.list_messages(refs)
    assert [entry["text"] for entry in saved["messages"]] == ["New input", "Second input", "First input"]
    assert saved["sources"] == [{"agentType": "pi", "status": "partial"}]


def test_native_archive_reports_source_status_for_the_requested_conversations(archive):
    store, _ = archive
    present, missing, unreadable = [
        reference("omp", identifier) for identifier in ("present", "missing", "unreadable")
    ]
    reader = Mock(spec=AgentTranscriptReader)
    reader.native_source_signature.return_value = (1,)
    reader.read_native_prompts.side_effect = [
        {"status": "missing"},
        native_page(),
        {"status": "unreadable"},
        native_page(),
    ]
    store.sync_native([present, missing, unreadable], reader)
    assert store.list_messages([present, missing])["sources"] == [{"agentType": "omp", "status": "partial"}]
    assert store.list_messages([present])["sources"] == [{"agentType": "omp", "status": "available"}]
    assert store.list_messages([missing])["sources"] == [{"agentType": "omp", "status": "missing"}]
    assert store.list_messages([unreadable])["sources"] == [{"agentType": "omp", "status": "unreadable"}]
    store.sync_native([present, missing, unreadable], reader)
    assert reader.read_native_prompts.call_count == 4
    assert store.list_messages([unreadable])["sources"] == [{"agentType": "omp", "status": "available"}]


def test_unavailable_archive_preserves_existing_file_and_reports_failure(tmp_path):
    path = tmp_path / "archive.sqlite3"
    path.write_bytes(b"not a database")
    store = SubmittedMessageStore(path, history_paths={})
    with pytest.raises(SubmittedMessageStoreUnavailable):
        store.list_messages([])
    with pytest.raises(SubmittedMessageStoreUnavailable):
        store.sync([])
    assert path.read_bytes() == b"not a database"


@pytest.mark.parametrize("options", [
    {"before": "invalid"}, {"before": "1:9223372036854775808"}, {"limit": 0}, {"limit": 201}, {"query": "x" * 257},
])
def test_rejects_invalid_pagination_and_search(archive, options):
    with pytest.raises(ValueError):
        archive[0].list_messages([reference()], **options)
