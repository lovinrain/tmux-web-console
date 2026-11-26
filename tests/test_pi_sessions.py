from __future__ import annotations

from pathlib import Path

import pytest

from tmux_console import pi_sessions
from tmux_console.pi_sessions import locate_pi_session, pi_session_header, valid_pi_session_id
from tmux_console.transcript_formats import pi_submitted_message, visible_messages

SESSION_ID = "Team_Run.01"
STAMP = "2026-11-26T20-53-51-388Z"
PROMPT_AT = 1_795_726_431_594


def journal(directory: Path, identifier: str = SESSION_ID) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / f"{STAMP}_{identifier}.jsonl"
    file.touch()
    return file


def message(role, content, **fields):
    return {"type": "message", "message": {"role": role, "content": content, "timestamp": PROMPT_AT, **fields}}


@pytest.mark.parametrize("identifier", ["", "-leading", "a-", "../outside", "bad/id", "a\n", "a" * 257])
def test_invalid_native_session_ids_are_rejected(identifier):
    assert not valid_pi_session_id(identifier)
    assert not pi_session_header({"type": "session", "id": identifier}, identifier)


def test_native_session_id_preserves_case_and_full_filename_match(tmp_path):
    root = tmp_path / "sessions"
    transcript = journal(root / "--tmp-project--")
    journal(root / "--tmp-other--", f"Other_{SESSION_ID}")
    header = {"type": "session", "version": 3, "id": SESSION_ID, "cwd": "/tmp/project"}
    assert valid_pi_session_id(SESSION_ID)
    assert locate_pi_session(root, SESSION_ID) == transcript
    assert locate_pi_session(root, SESSION_ID.lower()) is None
    assert pi_session_header(header, SESSION_ID)
    assert not pi_session_header(header, SESSION_ID.lower())
    assert not pi_session_header({"type": "title", "id": SESSION_ID}, SESSION_ID)


def test_lookup_ignores_nested_and_symlinked_journals_and_rejects_ambiguity(tmp_path):
    root = tmp_path / "sessions"
    source = journal(root)
    journal(root / "--tmp-project--" / "subagent")
    outside = journal(tmp_path / "outside")
    (root / "linked-directory").symlink_to(outside.parent, target_is_directory=True)
    copied = root / "copy"
    copied.mkdir()
    link = copied / outside.name
    link.symlink_to(outside)
    assert locate_pi_session(root, SESSION_ID) == source
    link.unlink()
    journal(copied)
    assert locate_pi_session(root, SESSION_ID) is None


def test_lookup_rejects_a_match_if_the_bounded_scan_cannot_finish(tmp_path, monkeypatch):
    journal(tmp_path)
    (tmp_path / "unrelated.txt").touch()
    monkeypatch.setattr(pi_sessions, "_MAX_LOOKUP_ENTRIES", 1)
    assert locate_pi_session(tmp_path, SESSION_ID) is None


@pytest.mark.parametrize("agent", ["pi", "omp"])
def test_visible_text_and_tools_use_native_roles_and_completion(agent):
    progress = message("assistant", [
        {"type": "thinking", "thinking": "Hidden reasoning"},
        {"type": "text", "text": "Checking files"},
        {"type": "toolCall", "id": "call-1", "name": "read", "arguments": {"path": "example"}},
    ], stopReason="toolUse")
    result = message("toolResult", [{"type": "text", "text": "Contents"}], toolCallId="call-1")
    answer = message("assistant", [{"type": "text", "text": "Finished"}], stopReason="stop")
    incomplete = message("assistant", [{"type": "text", "text": "Partial"}], stopReason="aborted")
    direct_shell = message("bashExecution", None, command="echo probe", output="probe")
    rendered = [
        (entry["kind"], entry["text"], entry["timestamp"])
        for record in [progress, result, answer, incomplete, direct_shell]
        for entry in visible_messages(agent, record)
    ]
    assert rendered == [
        ("progress", "Checking files", PROMPT_AT),
        ("tool", 'Tool: read\n{"path": "example"}', PROMPT_AT),
        ("tool", "Contents", PROMPT_AT),
        ("response", "Finished", PROMPT_AT),
        ("progress", "Partial", PROMPT_AT),
        ("tool", "Tool: bash\necho probe\n\nprobe", PROMPT_AT),
    ]
    assert not visible_messages(agent, message("system", "Internal instructions"))
    assert not visible_messages(agent, message("custom", "Hidden extension state", display=False))


@pytest.mark.parametrize("provenance", [{"synthetic": True}, {"attribution": "agent"}])
def test_generated_omp_input_stays_in_context_and_out_of_submitted_history(provenance):
    injected = message("user", "Background notice", **provenance)
    assert [entry["kind"] for entry in visible_messages("omp", injected)] == ["context"]
    assert pi_submitted_message(injected) is None


def test_submitted_records_keep_repeats_and_mark_attachments_incomplete():
    prompt = [
        {"type": "text", "text": "Here is the screenshot"},
        {"type": "image", "data": "bytes"},
    ]
    first = {"id": "aa", **message("user", prompt, attribution="user")}
    second = {"id": "bb", **message("user", prompt, attribution="user")}
    assert [pi_submitted_message(record) for record in [first, second]] == [
        ("Here is the screenshot\n\n[Image attachment]", PROMPT_AT, False),
        ("Here is the screenshot\n\n[Image attachment]", PROMPT_AT, False),
    ]
    assert pi_submitted_message(message("user", "Only text")) == ("Only text", PROMPT_AT, True)
