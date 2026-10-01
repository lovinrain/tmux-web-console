"""Read-only worker navigation by immutable native tmux incarnation."""

from __future__ import annotations

from typing import Any

from .scrollback import ScrollbackRecorder, ScrollbackStore, session_identity
from .session_registry import SessionRegistry
from .tmux import TmuxClient, TmuxSessionIdentityChangedError


async def resolve_worker_terminal(
    tmux: TmuxClient, registry: SessionRegistry, recorder: ScrollbackRecorder,
    scrollback: ScrollbackStore, identity: dict[str, Any], *, history_id: str | None = None,
) -> dict[str, Any]:
    expected = tuple(identity[field] for field in (
        "session_id", "session_created", "server_started", "server_pid",
    ))
    sessions = await tmux.list_sessions()  # Failure is never treated as an ended worker.
    session = next((item for item in sessions if (
        item.id, item.created, item.server_started, item.server_pid,
    ) == expected), None)
    record = registry.history_for_identity(*expected)
    if history_id is not None:
        supplied = registry.get_history(history_id)
        if tuple(supplied[field] for field in (
            "tmux_id", "created", "server_started", "server_pid",
        )) != expected:
            raise TmuxSessionIdentityChangedError("history belongs to another session incarnation")
        record = supplied
    if session is not None:
        history_id = registry.observe_history(session)
        display_name = session.name
    elif record is not None:
        history_id = record["id"]
        display_name = record["name"]
    else:
        return {"state": "missing", "session": None, "historyId": None,
                "text": "", "limited": False, "capturedAt": None}

    pane_identity = (identity["pane_id"], identity["pane_pid"])
    pane = next((item for item in session.panes if (item.id, item.process_pid) == pane_identity), None) if session else None
    state = "ended" if session is None else "stale" if pane is None else "ended" if pane.dead else "live"
    if pane is not None:
        assert session is not None
        saved = await recorder.sample([session], force=True, pane_ids={pane.id})
        if (session_identity(session), pane.id, pane.process_pid) not in saved:
            raise TmuxSessionIdentityChangedError("worker pane changed during capture; refresh the view")
    # The archived pane PID is checked even after session/pane removal or respawn.
    # An arbitrary first pane in the same history record is never a fallback.
    history = scrollback.read(history_id, part="recent", pane_identity=pane_identity)
    return {"state": state, "session": display_name,
            "historyId": history_id, "text": "\n".join(history["lines"]),
            "limited": history["limited"], "capturedAt": history["capturedAt"]}
