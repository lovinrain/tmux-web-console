from tmux_console.history import SnapshotStore
from tmux_console.tmux import HistoryCapture, Pane


def sample_pane() -> Pane:
    return Pane(
        id="%42",
        index=0,
        window_index=0,
        window_name="codex",
        window_active=True,
        active=True,
        command="codex",
        path="/work",
        title="Task",
        width=100,
        height=30,
        history_size=480,
        history_limit=2000,
        alternate_on=False,
        dead=False,
        activity=1700000000,
    )


def test_snapshot_pages_are_stable_and_oldest_page_ends_at_zero():
    store = SnapshotStore()
    snapshot = store.create(HistoryCapture(sample_pane(), [f"line-{i}" for i in range(525)]))

    newest = snapshot.page(before=None, limit=200)
    older = snapshot.page(before=newest["nextCursor"], limit=200)
    oldest = snapshot.page(before=older["nextCursor"], limit=200)

    assert newest["lines"][0] == "line-325"
    assert older["lines"][0] == "line-125"
    assert oldest["lines"][0] == "line-0"
    assert oldest["nextCursor"] is None
    assert newest["historySize"] == 480


def test_snapshot_store_evicts_oldest_item():
    store = SnapshotStore(max_items=1)
    first = store.create(HistoryCapture(sample_pane(), ["one"]))
    second = store.create(HistoryCapture(sample_pane(), ["two"]))

    assert store.get(first.id) is None
    assert store.get(second.id) is second

