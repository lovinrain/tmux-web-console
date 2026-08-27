import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommonNote,
  getSessionNote,
  getWorkspaceNote,
  replaceCommonNote,
  replaceSessionNote,
  replaceWorkspaceNote,
} from "../api";
import { renderWithTheme } from "../test-utils";
import {
  DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
  DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
  MIN_SCOPED_NOTE_WINDOW_HEIGHT,
  MIN_SCOPED_NOTE_WINDOW_WIDTH,
  SCOPED_NOTE_WINDOW_STORAGE_PREFIX,
  ScopedStickyNotes,
} from "./ScopedStickyNotes";

vi.mock("../api", () => ({
  getCommonNote: vi.fn(),
  getSessionNote: vi.fn(),
  getWorkspaceNote: vi.fn(),
  replaceCommonNote: vi.fn(),
  replaceSessionNote: vi.fn(),
  replaceWorkspaceNote: vi.fn(),
}));

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function workspaceWindowStorageKey(workspaceId: string, editorKey: string): string {
  return `${SCOPED_NOTE_WINDOW_STORAGE_PREFIX}workspace:${workspaceId}:${editorKey}`;
}

async function renderLoadedNotes(
  props: {
    sessionName?: string;
    workspaceId?: string | null;
    workspaceName?: string | null;
  } = {},
) {
  const view = renderWithTheme(
    <ScopedStickyNotes
      sessionName={props.sessionName ?? "agent-one"}
      workspaceId={props.workspaceId === undefined ? "workspace-one" : props.workspaceId}
      workspaceName={props.workspaceName === undefined ? "Launch room" : props.workspaceName}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Edit common note" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit session note" })).toBeEnabled();
  });
  return view;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
  window.localStorage.clear();
  document.body.style.overflow = "";
  document.documentElement.classList.remove(
    "scoped-note-moving",
    "scoped-note-resizing",
  );
  vi.mocked(getCommonNote).mockResolvedValue("Shared checklist");
  vi.mocked(getWorkspaceNote).mockResolvedValue("Workspace plan");
  vi.mocked(getSessionNote).mockResolvedValue("Session handoff");
  vi.mocked(replaceCommonNote).mockImplementation(async (note) => note);
  vi.mocked(replaceWorkspaceNote).mockImplementation(async (_workspaceId, note) => note);
  vi.mocked(replaceSessionNote).mockImplementation(async (_sessionName, note) => note);
});

describe("ScopedStickyNotes", () => {
  it("loads common, workspace, and session cards in scope order", async () => {
    await renderLoadedNotes();

    expect(getCommonNote).toHaveBeenCalledOnce();
    expect(getWorkspaceNote).toHaveBeenCalledWith(
      "workspace-one",
      expect.any(AbortSignal),
    );
    expect(getSessionNote).toHaveBeenCalledWith(
      "agent-one",
      expect.any(AbortSignal),
    );

    const notes = screen.getByRole("region", { name: "Sticky notes" });
    const cards = within(notes).getAllByRole("button");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit common note",
      "Edit workspace note",
      "Edit session note",
    ]);
    expect(cards[0]).toHaveTextContent("Shared checklist");
    expect(cards[1]).toHaveTextContent("Workspace plan");
    expect(cards[2]).toHaveTextContent("Session handoff");
  });

  it("keeps common and session notes available in a temporary workspace", async () => {
    await renderLoadedNotes({ workspaceId: null, workspaceName: null });

    expect(getWorkspaceNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add workspace note" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Add workspace note" }))
      .toHaveAttribute("title", "Save workspace first");
    expect(screen.getByRole("button", { name: "Edit common note" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit session note" })).toBeEnabled();
  });

  it("debounces saves and serializes writes so the newest draft wins", async () => {
    const firstSave = deferred<string>();
    const secondSave = deferred<string>();
    vi.mocked(replaceWorkspaceNote)
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    await renderLoadedNotes();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Edit workspace note" }));
    const editor = screen.getByRole("dialog", { name: "Launch room" });
    const textarea = within(editor).getByRole("textbox", { name: "Note" });
    expect(textarea).toHaveFocus();
    fireEvent.change(textarea, { target: { value: "First draft" } });
    act(() => vi.advanceTimersByTime(649));
    expect(replaceWorkspaceNote).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(replaceWorkspaceNote).toHaveBeenCalledTimes(1);
    expect(replaceWorkspaceNote).toHaveBeenLastCalledWith(
      "workspace-one",
      "First draft",
    );

    fireEvent.change(textarea, { target: { value: "Final draft" } });
    act(() => vi.advanceTimersByTime(650));
    await flushPromises();
    expect(replaceWorkspaceNote).toHaveBeenCalledTimes(1);

    firstSave.resolve("First draft");
    await flushPromises();
    expect(replaceWorkspaceNote).toHaveBeenCalledTimes(2);
    expect(replaceWorkspaceNote).toHaveBeenLastCalledWith(
      "workspace-one",
      "Final draft",
    );
    expect(within(editor).getByRole("status")).toHaveTextContent("Saving...");

    secondSave.resolve("Final draft");
    await flushPromises();
    expect(within(editor).getByRole("status")).toHaveTextContent("Saved");
    expect(textarea).toHaveValue("Final draft");
  });

  it("flushes the current draft before closing and clears a saved note", async () => {
    await renderLoadedNotes();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    let editor = screen.getByRole("dialog", { name: "Common" });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Close now" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await flushPromises();
    expect(replaceCommonNote).toHaveBeenCalledOnce();
    expect(replaceCommonNote).toHaveBeenCalledWith("Close now");
    expect(screen.queryByRole("dialog", { name: "Common" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit common note" }))
      .toHaveTextContent("Close now");
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null")).toMatchObject({ open: false, pinned: false });

    fireEvent.click(screen.getByRole("button", { name: "Edit session note" }));
    editor = screen.getByRole("dialog", { name: "agent-one" });
    fireEvent.click(within(editor).getByRole("button", { name: "Clear" }));
    expect(within(editor).getByRole("textbox", { name: "Note" })).toHaveValue("");
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await flushPromises();
    expect(replaceSessionNote).toHaveBeenCalledWith("agent-one", "");
    expect(screen.getByRole("button", { name: "Add session note" }))
      .toHaveTextContent("Add note");
  });

  it("keeps a failed draft open and retries it without losing text", async () => {
    vi.mocked(replaceSessionNote)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce("Recover me");
    await renderLoadedNotes();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Edit session note" }));
    const editor = screen.getByRole("dialog", { name: "agent-one" });
    const textarea = within(editor).getByRole("textbox", { name: "Note" });
    fireEvent.change(textarea, { target: { value: "Recover me" } });
    act(() => vi.advanceTimersByTime(650));
    await flushPromises();

    expect(within(editor).getByRole("status")).toHaveTextContent("disk full");
    expect(textarea).toHaveValue("Recover me");
    fireEvent.click(within(editor).getByRole("button", { name: "Retry" }));
    await flushPromises();
    expect(replaceSessionNote).toHaveBeenCalledTimes(2);
    expect(within(editor).getByRole("status")).toHaveTextContent("Saved");
    expect(textarea).toHaveValue("Recover me");
  });

  it("ignores a stale session-note response after the active session changes", async () => {
    const oldRequest = deferred<string>();
    vi.mocked(getSessionNote)
      .mockImplementationOnce(() => oldRequest.promise)
      .mockResolvedValueOnce("New session note");
    const view = renderWithTheme(
      <ScopedStickyNotes
        sessionName="agent-old"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-new"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit session note" }))
        .toHaveTextContent("New session note");
    });
    oldRequest.resolve("Stale session note");
    await flushPromises();
    expect(screen.getByRole("button", { name: "Edit session note" }))
      .toHaveTextContent("New session note");
  });

  it("opens directly as a floating window and toggles it from the note button", async () => {
    await renderLoadedNotes();

    const openButton = screen.getByRole("button", { name: "Edit common note" });
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openButton);

    const editor = screen.getByRole("dialog", { name: "Common" });
    expect(editor).toHaveClass("floating");
    expect(editor).not.toHaveClass("modal");
    expect(editor).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".scoped-note-backdrop")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(within(editor).queryByRole("button", { name: "Float common note" }))
      .not.toBeInTheDocument();
    expect(within(editor).queryByRole("button", { name: "Dock common note" }))
      .not.toBeInTheDocument();

    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Save this draft while toggling" },
    });
    const hideButton = screen.getByRole("button", { name: "Hide common note" });
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(hideButton);
    await flushPromises();

    expect(screen.queryByRole("dialog", { name: "Common" })).not.toBeInTheDocument();
    expect(replaceCommonNote).toHaveBeenCalledWith("Save this draft while toggling");
    expect(screen.getByRole("button", { name: "Edit common note" }))
      .toHaveAttribute("aria-expanded", "false");

    const preference = JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null");
    expect(preference).toMatchObject({ open: false, floating: true, pinned: false });

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    expect(screen.getByRole("dialog", { name: "Common" })).toHaveClass("floating");
    expect(screen.getByRole("textbox", { name: "Note" }))
      .toHaveValue("Save this draft while toggling");
  });

  it("keeps pinned common and workspace windows across session switches", async () => {
    const view = render(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit common note" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Edit workspace note" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin common note" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit workspace note" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin workspace note" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null")).toMatchObject({ open: true, floating: true, pinned: true });
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "workspace:workspace-one"),
    ) || "null")).toMatchObject({ open: true, floating: true, pinned: true });

    vi.mocked(getSessionNote).mockResolvedValueOnce("Second session note");
    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit session note" }))
        .toHaveTextContent("Second session note");
    });
    expect(screen.getByRole("dialog", { name: "Common" })).toHaveClass("pinned");
    expect(screen.getByRole("dialog", { name: "Launch room" })).toHaveClass("pinned");
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
  });

  it("closes unpinned and session-scoped windows when the active session changes", async () => {
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "session:agent-one"),
      JSON.stringify({
        open: true,
        floating: true,
        pinned: true,
        position: { x: 180, y: 140 },
      }),
    );
    const view = render(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "agent-one" })).toHaveClass("pinned");
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "agent-one" }))
        .not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Common" }))
        .not.toBeInTheDocument();
    });
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null")).toMatchObject({ open: false, pinned: false });
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "session:agent-one"),
    ) || "null")).toMatchObject({ open: true, pinned: true });

    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "agent-one" })).toHaveClass("pinned");
    });
    expect(screen.queryByRole("dialog", { name: "Common" }))
      .not.toBeInTheDocument();
  });

  it("isolates each workspace arrangement and restores all open windows on return", async () => {
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
      JSON.stringify({
        open: true,
        floating: true,
        pinned: true,
        position: { x: 90, y: 110 },
      }),
    );
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "workspace:workspace-one"),
      JSON.stringify({
        open: true,
        floating: true,
        pinned: true,
        position: { x: 210, y: 160 },
      }),
    );
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "session:agent-one"),
      JSON.stringify({
        open: true,
        floating: true,
        pinned: false,
        position: { x: 320, y: 210 },
      }),
    );
    const view = render(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Common" })).toHaveStyle({
        left: "90px",
        top: "110px",
      });
      expect(screen.getByRole("dialog", { name: "Launch room" })).toHaveClass("pinned");
      expect(screen.getByRole("dialog", { name: "agent-one" })).toHaveClass("floating");
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(3);
    expect(document.body.style.overflow).toBe("");

    vi.mocked(getWorkspaceNote).mockResolvedValueOnce("Different workspace plan");
    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-two"
        workspaceId="workspace-two"
        workspaceName="Incident room"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit workspace note" }))
        .toHaveTextContent("Different workspace plan");
    });
    expect(screen.queryByRole("dialog", { name: "Common" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Launch room" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "agent-one" }))
      .not.toBeInTheDocument();

    vi.mocked(getWorkspaceNote).mockResolvedValueOnce("Workspace plan restored");
    view.rerender(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Common" })).toHaveClass("pinned");
      expect(screen.getByRole("dialog", { name: "Launch room" })).toHaveClass("pinned");
      expect(screen.getByRole("dialog", { name: "agent-one" })).not.toHaveClass("pinned");
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(3);
  });

  it("migrates an existing pinned preference into the active workspace", async () => {
    window.localStorage.setItem(
      "muxdeck.scoped-note-window.v1:common:common",
      JSON.stringify({
        floating: true,
        pinned: true,
        position: { x: 125, y: 145 },
      }),
    );

    await renderLoadedNotes();

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Common" })).toHaveClass("pinned");
    });
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null")).toMatchObject({
      open: true,
      floating: true,
      pinned: true,
      position: { x: 125, y: 145 },
      size: {
        width: DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
        height: DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
      },
    });
  });

  it("moves floating notes with pointer input and persists the final position", async () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    await renderLoadedNotes();

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const editor = screen.getByRole("dialog", { name: "Common" });
    const titleStrip = within(editor).getByLabelText("Move common note window");
    expect(titleStrip.tagName).toBe("HEADER");
    expect(within(editor).queryByRole("button", { name: /Move common note/ }))
      .not.toBeInTheDocument();
    const storageKey = workspaceWindowStorageKey("workspace-one", "common:common");
    const initial = JSON.parse(window.localStorage.getItem(storageKey) || "null");

    fireEvent.pointerDown(within(editor).getByRole("button", { name: "Pin common note" }), {
      pointerId: 6,
      button: 0,
      clientX: initial.position.x + 300,
      clientY: initial.position.y + 18,
    });
    expect(document.documentElement).not.toHaveClass("scoped-note-moving");

    fireEvent.pointerDown(titleStrip, {
      pointerId: 7,
      button: 0,
      clientX: initial.position.x + 20,
      clientY: initial.position.y + 18,
    });
    expect(document.documentElement).toHaveClass("scoped-note-moving");
    fireEvent.pointerMove(window, {
      pointerId: 7,
      clientX: initial.position.x - 60,
      clientY: initial.position.y + 88,
    });
    fireEvent.pointerUp(window, {
      pointerId: 7,
      clientX: initial.position.x - 60,
      clientY: initial.position.y + 88,
    });

    const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    expect(saved.position).toEqual({
      x: initial.position.x - 80,
      y: initial.position.y + 70,
    });
    expect(editor).toHaveStyle({
      left: `${saved.position.x}px`,
      top: `${saved.position.y}px`,
    });
    expect(document.documentElement).not.toHaveClass("scoped-note-moving");
  });

  it("resizes floating notes smaller and restores the workspace-specific size", async () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    await renderLoadedNotes();

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const editor = screen.getByRole("dialog", { name: "Common" });
    const handle = within(editor).getByRole("button", {
      name: "Resize common note window",
    });
    expect(editor).toHaveStyle({
      width: `${DEFAULT_SCOPED_NOTE_WINDOW_WIDTH}px`,
      height: `${DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT}px`,
    });

    fireEvent.pointerDown(handle, {
      pointerId: 9,
      button: 0,
      clientX: 600,
      clientY: 600,
    });
    expect(document.documentElement).toHaveClass("scoped-note-resizing");
    fireEvent.pointerMove(window, {
      pointerId: 9,
      clientX: 430,
      clientY: 410,
    });
    fireEvent.pointerUp(window, {
      pointerId: 9,
      clientX: 430,
      clientY: 410,
    });

    expect(editor).toHaveStyle({ width: "260px", height: "240px" });
    expect(document.documentElement).not.toHaveClass("scoped-note-resizing");
    const storageKey = workspaceWindowStorageKey("workspace-one", "common:common");
    expect(JSON.parse(window.localStorage.getItem(storageKey) || "null").size)
      .toEqual({ width: 260, height: 240 });

    fireEvent.click(screen.getByRole("button", { name: "Hide common note" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const restored = screen.getByRole("dialog", { name: "Common" });
    expect(restored).toHaveStyle({ width: "260px", height: "240px" });

    const restoredHandle = within(restored).getByRole("button", {
      name: "Resize common note window",
    });
    fireEvent.keyDown(restoredHandle, { key: "Home" });
    expect(restored).toHaveStyle({
      width: `${MIN_SCOPED_NOTE_WINDOW_WIDTH}px`,
      height: `${MIN_SCOPED_NOTE_WINDOW_HEIGHT}px`,
    });
    fireEvent.keyDown(restoredHandle, { key: "Enter" });
    expect(restored).toHaveStyle({
      width: `${DEFAULT_SCOPED_NOTE_WINDOW_WIDTH}px`,
      height: `${DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT}px`,
    });
  });

  it("does not render saved floating windows in the compact mobile view", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
      JSON.stringify({
        open: true,
        floating: true,
        pinned: true,
        position: { x: 90, y: 110 },
      }),
    );

    await renderLoadedNotes();

    expect(screen.queryByRole("dialog", { name: "Common" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });
});
