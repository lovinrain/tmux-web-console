import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommonNote,
  getCommonNotebook,
  getSessionNote,
  getSessionNotebook,
  getWorkspaceNote,
  getWorkspaceNotebook,
  replaceCommonNote,
  replaceCommonNotebook,
  replaceSessionNote,
  replaceSessionNotebook,
  replaceWorkspaceNote,
  replaceWorkspaceNotebook,
  type ScopedNoteNotebook,
} from "../api";
import { renderWithTheme } from "../test-utils";
import {
  DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
  DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
  MIN_SCOPED_NOTE_WINDOW_HEIGHT,
  MIN_SCOPED_NOTE_WINDOW_WIDTH,
  SCOPED_NOTE_DEFAULT_SIZE_STORAGE_KEY,
  SCOPED_NOTE_WINDOW_STORAGE_PREFIX,
  ScopedStickyNotes,
} from "./ScopedStickyNotes";

vi.mock("../api", () => ({
  getCommonNote: vi.fn(),
  getCommonNotebook: vi.fn(),
  getSessionNote: vi.fn(),
  getSessionNotebook: vi.fn(),
  getWorkspaceNote: vi.fn(),
  getWorkspaceNotebook: vi.fn(),
  replaceCommonNote: vi.fn(),
  replaceCommonNotebook: vi.fn(),
  replaceSessionNote: vi.fn(),
  replaceSessionNotebook: vi.fn(),
  replaceWorkspaceNote: vi.fn(),
  replaceWorkspaceNotebook: vi.fn(),
}));

function notebook(content: string): ScopedNoteNotebook {
  return { pages: [{ id: "main", name: "Page 1", content }] };
}

function withFirstPageContent(
  value: ScopedNoteNotebook,
  content: string,
): ScopedNoteNotebook {
  return {
    pages: value.pages.map((page, index) => (
      index === 0 ? { ...page, content } : page
    )),
  };
}

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
    "scoped-note-resizing-top-left",
    "scoped-note-resizing-top-right",
    "scoped-note-resizing-bottom-left",
    "scoped-note-resizing-bottom-right",
  );
  vi.mocked(getCommonNote).mockResolvedValue("Shared checklist");
  vi.mocked(getWorkspaceNote).mockResolvedValue("Workspace plan");
  vi.mocked(getSessionNote).mockResolvedValue("Session handoff");
  vi.mocked(replaceCommonNote).mockImplementation(async (note) => note);
  vi.mocked(replaceWorkspaceNote).mockImplementation(async (_workspaceId, note) => note);
  vi.mocked(replaceSessionNote).mockImplementation(async (_sessionName, note) => note);
  vi.mocked(getCommonNotebook).mockImplementation(async (signal) => (
    notebook(await vi.mocked(getCommonNote)(signal))
  ));
  vi.mocked(getWorkspaceNotebook).mockImplementation(async (workspaceId, signal) => (
    notebook(await vi.mocked(getWorkspaceNote)(workspaceId, signal))
  ));
  vi.mocked(getSessionNotebook).mockImplementation(async (sessionName, signal) => (
    notebook(await vi.mocked(getSessionNote)(sessionName, signal))
  ));
  vi.mocked(replaceCommonNotebook).mockImplementation(async (value) => (
    withFirstPageContent(
      value,
      await vi.mocked(replaceCommonNote)(value.pages[0].content),
    )
  ));
  vi.mocked(replaceWorkspaceNotebook).mockImplementation(async (workspaceId, value) => (
    withFirstPageContent(
      value,
      await vi.mocked(replaceWorkspaceNote)(workspaceId, value.pages[0].content),
    )
  ));
  vi.mocked(replaceSessionNotebook).mockImplementation(async (sessionName, value) => (
    withFirstPageContent(
      value,
      await vi.mocked(replaceSessionNote)(sessionName, value.pages[0].content),
    )
  ));
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

  it("adds, names, navigates, and lists notebook pages without a text limit", async () => {
    await renderLoadedNotes();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const editor = screen.getByRole("dialog", { name: "Common" });
    const textarea = within(editor).getByRole("textbox", { name: "Note" });
    expect(textarea).not.toHaveAttribute("maxlength");
    expect(within(editor).getByLabelText("Page 1 of 1")).toHaveTextContent("1 / 1");

    fireEvent.click(within(editor).getByRole("button", { name: "Add note page" }));
    expect(within(editor).getByLabelText("Page 2 of 2")).toHaveTextContent("2 / 2");
    const pageName = within(editor).getByRole("textbox", { name: "Page name" });
    act(() => vi.advanceTimersByTime(0));
    expect(pageName).toHaveFocus();
    expect((pageName as HTMLInputElement).selectionStart).toBe(0);
    expect((pageName as HTMLInputElement).selectionEnd).toBe("Page 2".length);
    fireEvent.change(pageName, { target: { value: "Runbook" } });
    fireEvent.blur(pageName);
    fireEvent.change(textarea, { target: { value: "A".repeat(12_000) } });

    const pageList = within(editor).getByRole("complementary", {
      name: "Notebook pages",
    });
    expect(within(pageList).getByRole("button", { name: /Runbook/ }))
      .toHaveAttribute("aria-current", "page");
    act(() => vi.advanceTimersByTime(650));
    await flushPromises();
    expect(replaceCommonNotebook).toHaveBeenLastCalledWith({
      pages: [
        { id: "main", name: "Page 1", content: "Shared checklist" },
        expect.objectContaining({ name: "Runbook", content: "A".repeat(12_000) }),
      ],
    });

    fireEvent.click(within(editor).getByRole("button", { name: "Previous note page" }));
    expect(textarea).toHaveValue("Shared checklist");
    expect(within(editor).getByLabelText("Page 1 of 2")).toHaveTextContent("1 / 2");
    expect(JSON.parse(window.localStorage.getItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
    ) || "null")).toMatchObject({
      selectedPageId: "main",
      sidebarOpen: true,
    });
  });

  it.each([false, true])("shows the first page and sidebar on opening (restored=%s)", async (restored) => {
    const pages = [
      { id: "plan", name: "Project plan", content: "Keep the original pad" },
      { id: "details", name: "Handoff", content: "Find this separate page" },
    ];
    vi.mocked(getCommonNotebook).mockResolvedValue({ pages });
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
      JSON.stringify({ open: restored, selectedPageId: "details", sidebarOpen: false }),
    );
    const view = render(
      <ScopedStickyNotes sessionName="agent-one" workspaceId="workspace-one" workspaceName="Launch room" />,
    );
    if (!restored) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Edit common note" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    }
    const editor = await screen.findByRole("dialog", { name: "Common" });
    const sidebar = within(editor).getByRole("complementary", { name: "Notebook pages" });
    expect(within(editor).getByRole("textbox", { name: "Page name" })).toHaveValue("Project plan");
    expect(within(editor).getByRole("textbox", { name: "Note" })).toHaveValue("Keep the original pad");
    expect(within(sidebar).getByRole("button", { name: /Project plan/ })).toHaveAttribute("aria-current", "page");
    expect(within(editor).getByRole("button", { name: "Hide page sidebar" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(within(sidebar).getByRole("button", { name: /Handoff/ }));
    view.rerender(
      <ScopedStickyNotes sessionName="agent-one" workspaceId="workspace-one" workspaceName="Renamed workspace" />,
    );
    expect(within(editor).getByRole("textbox", { name: "Note" })).toHaveValue("Find this separate page");
    fireEvent.click(within(editor).getByRole("button", { name: "Hide page sidebar" }));
    expect(within(editor).queryByRole("complementary", { name: "Notebook pages" })).not.toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Show page sidebar" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Common" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const reopened = screen.getByRole("dialog", { name: "Common" });
    expect(within(reopened).getByRole("complementary", { name: "Notebook pages" })).toBeVisible();
    expect(within(reopened).getByRole("textbox", { name: "Note" })).toHaveValue("Keep the original pad");
    expect(replaceCommonNotebook).not.toHaveBeenCalled();
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
      name: "Resize common note window from bottom right corner",
    });
    for (const corner of ["top left", "top right", "bottom left"]) {
      expect(within(editor).getByRole("button", {
        name: `Resize common note window from ${corner} corner`,
      })).toBeInTheDocument();
    }
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
      name: "Resize common note window from bottom right corner",
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

  it("expands a preset away from viewport edges and remembers the note layout", async () => {
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 900);
    vi.mocked(getCommonNotebook).mockResolvedValue({
      pages: [
        { id: "main", name: "Page 1", content: "Shared checklist" },
        { id: "handoff", name: "Handoff", content: "Keep this selected page" },
      ],
    });
    const storageKey = workspaceWindowStorageKey("workspace-one", "common:common");
    window.localStorage.setItem(storageKey, JSON.stringify({
      position: { x: 750, y: 450 },
      size: { width: 430, height: 430 },
    }));
    await renderLoadedNotes();
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const editor = screen.getByRole("dialog", { name: "Common" });
    fireEvent.click(within(editor).getByRole("button", { name: "Next note page" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Pin common note" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Resize note to Large" }));

    expect(editor).toHaveStyle({ width: "860px", height: "720px" });
    expect(Number.parseFloat(editor.style.left) + 860).toBeLessThanOrEqual(1188);
    expect(Number.parseFloat(editor.style.top) + 720).toBeLessThanOrEqual(888);
    expect(within(editor).getByRole("textbox", { name: "Note" }))
      .toHaveValue("Keep this selected page");
    expect(within(editor).getByRole("combobox", { name: "Default note opening size" }))
      .toHaveValue("remember");
    expect(JSON.parse(window.localStorage.getItem(storageKey) || "null"))
      .toMatchObject({
        pinned: true,
        selectedPageId: "handoff",
        sidebarOpen: true,
        size: { width: 860, height: 720 },
      });
    expect(replaceCommonNotebook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Hide common note" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    expect(screen.getByRole("dialog", { name: "Common" }))
      .toHaveStyle({ width: "860px", height: "720px" });
  });

  it("shares the chosen default across scopes and uses it when reopening saved notes", async () => {
    const commonStorageKey = workspaceWindowStorageKey("workspace-one", "common:common");
    window.localStorage.setItem(commonStorageKey, JSON.stringify({
      size: { width: 300, height: 250 },
    }));
    await renderLoadedNotes();
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const commonEditor = screen.getByRole("dialog", { name: "Common" });
    expect(commonEditor).toHaveStyle({ width: "300px", height: "250px" });
    fireEvent.change(within(commonEditor).getByRole("combobox", {
      name: "Default note opening size",
    }), { target: { value: "medium" } });

    expect(window.localStorage.getItem(SCOPED_NOTE_DEFAULT_SIZE_STORAGE_KEY)).toBe("medium");
    expect(commonEditor).toHaveStyle({ width: "300px", height: "250px" });
    for (const [scope, title] of [["workspace", "Launch room"], ["session", "agent-one"]]) {
      fireEvent.click(screen.getByRole("button", { name: `Edit ${scope} note` }));
      const editor = screen.getByRole("dialog", { name: title });
      expect(editor).toHaveStyle({ width: "640px", height: "560px" });
      expect(within(editor).getByRole("combobox", { name: "Default note opening size" }))
        .toHaveValue("medium");
    }

    fireEvent.click(screen.getByRole("button", { name: "Hide common note" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const reopened = screen.getByRole("dialog", { name: "Common" });
    expect(reopened).toHaveStyle({ width: "640px", height: "560px" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Resize note to Small" }));
    expect(reopened).toHaveStyle({ width: "430px", height: "430px" });
    fireEvent.keyDown(within(reopened).getByRole("button", {
      name: "Resize common note window from bottom right corner",
    }), { key: "Enter" });
    expect(reopened).toHaveStyle({ width: "640px", height: "560px" });
  });

  it("restores an already-open layout before applying the configured default on a new open", async () => {
    window.localStorage.setItem(SCOPED_NOTE_DEFAULT_SIZE_STORAGE_KEY, "medium");
    window.localStorage.setItem(
      workspaceWindowStorageKey("workspace-one", "common:common"),
      JSON.stringify({
        open: true,
        pinned: true,
        position: { x: 90, y: 110 },
        size: { width: 300, height: 250 },
      }),
    );
    renderWithTheme(
      <ScopedStickyNotes
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
      />,
    );
    const restored = await screen.findByRole("dialog", { name: "Common" });
    expect(restored).toHaveClass("pinned");
    expect(restored).toHaveStyle({
      left: "90px", top: "110px", width: "300px", height: "250px",
    });
    expect(within(restored).getByRole("combobox", { name: "Default note opening size" }))
      .toHaveValue("medium");

    fireEvent.click(screen.getByRole("button", { name: "Hide common note" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    expect(screen.getByRole("dialog", { name: "Common" }))
      .toHaveStyle({ width: "640px", height: "560px" });
  });

  it("syncs defaults from another tab and fits large notes into a smaller viewport", async () => {
    vi.stubGlobal("innerWidth", 700);
    vi.stubGlobal("innerHeight", 550);
    await renderLoadedNotes();
    fireEvent.click(screen.getByRole("button", { name: "Edit common note" }));
    const commonEditor = screen.getByRole("dialog", { name: "Common" });
    window.localStorage.setItem(SCOPED_NOTE_DEFAULT_SIZE_STORAGE_KEY, "large");
    fireEvent(window, new StorageEvent("storage", {
      key: SCOPED_NOTE_DEFAULT_SIZE_STORAGE_KEY,
      newValue: "large",
    }));
    expect(within(commonEditor).getByRole("combobox", { name: "Default note opening size" }))
      .toHaveValue("large");
    expect(commonEditor).toHaveStyle({ width: "430px", height: "430px" });

    fireEvent.click(screen.getByRole("button", { name: "Edit session note" }));
    const sessionEditor = screen.getByRole("dialog", { name: "agent-one" });
    expect(sessionEditor).toHaveStyle({
      left: "12px", top: "12px", width: "676px", height: "526px",
    });
    fireEvent.click(within(commonEditor).getByRole("button", { name: "Resize note to Large" }));
    expect(commonEditor).toHaveStyle({
      left: "12px", top: "12px", width: "676px", height: "526px",
    });
  });

  it("anchors the opposite corner when a note is resized from the top-left", async () => {
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
    const storageKey = workspaceWindowStorageKey("workspace-one", "common:common");
    const initial = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    const initialRight = initial.position.x + DEFAULT_SCOPED_NOTE_WINDOW_WIDTH;
    const initialBottom = initial.position.y + DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT;
    const handle = within(editor).getByRole("button", {
      name: "Resize common note window from top left corner",
    });

    fireEvent.pointerDown(handle, {
      pointerId: 12,
      button: 0,
      clientX: initial.position.x,
      clientY: initial.position.y,
    });
    fireEvent.pointerMove(window, {
      pointerId: 12,
      clientX: initial.position.x + 100,
      clientY: initial.position.y + 80,
    });
    expect(document.documentElement).toHaveClass("scoped-note-resizing-top-left");
    expect(editor).toHaveStyle({ width: "330px", height: "350px" });
    expect(Number.parseFloat(editor.style.left) + 330).toBe(initialRight);
    expect(Number.parseFloat(editor.style.top) + 350).toBe(initialBottom);
    fireEvent.pointerUp(window, {
      pointerId: 12,
      clientX: initial.position.x + 100,
      clientY: initial.position.y + 80,
    });

    const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    expect(saved.position).toEqual({
      x: initial.position.x + 100,
      y: initial.position.y + 80,
    });
    expect(saved.size).toEqual({ width: 330, height: 350 });
    expect(document.documentElement).not.toHaveClass("scoped-note-resizing");
    expect(document.documentElement).not.toHaveClass("scoped-note-resizing-top-left");
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
