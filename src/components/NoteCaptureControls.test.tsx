import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommonNotebook, getSessionNotebook, getWorkspaceNotebook } from "../api";
import { saveNoteCapture, type NoteCapture } from "../noteCaptures";
import { cropCapture, type TerminalCaptureSnapshot } from "../terminalCapture";
import type { Session } from "../types";
import type { LiveTerminalHandle } from "./LiveTerminal";
import { NoteCaptureControls } from "./NoteCaptureControls";

vi.mock("../api", () => ({ getCommonNotebook: vi.fn(), getSessionNotebook: vi.fn(), getWorkspaceNotebook: vi.fn() }));
vi.mock("../noteCaptures", async (importOriginal) => ({
  ...await importOriginal<typeof import("../noteCaptures")>(), saveNoteCapture: vi.fn(),
}));
vi.mock("../terminalCapture", () => ({ cropCapture: vi.fn() }));

const session = { name: "alpha", id: "$1", created: 100, serverStarted: 90, serverPid: 42 } as Session;
const pages = [{ id: "main", name: "Page 1", content: "Existing note" }, { id: "handoff", name: "Handoff", content: "Do not overwrite" }];
const snapshot = {
  canvas: { toDataURL: () => "data:image/png;base64,aW1hZ2U=" }, width: 800, height: 400,
  cols: 80, rows: 24, lines: ["original terminal text"], textForArea: () => "original terminal text",
} as unknown as TerminalCaptureSnapshot;
const capture = vi.fn<LiveTerminalHandle["capture"]>();
const terminal = { current: { capture } as unknown as LiveTerminalHandle };
const saved = { id: "a".repeat(32) } as NoteCapture;

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  for (const get of [getCommonNotebook, getSessionNotebook, getWorkspaceNotebook]) vi.mocked(get).mockResolvedValue({ pages });
  capture.mockResolvedValue(snapshot);
  vi.mocked(cropCapture).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  vi.mocked(saveNoteCapture).mockResolvedValue(saved);
});

describe("NoteCaptureControls", () => {
  it("saves selected text to the chosen scope and page without replacing notebook text", async () => {
    render(<NoteCaptureControls session={session} workspaceId="workspace-1" terminal={terminal} selectedText="selected text" />);
    fireEvent.click(screen.getByRole("button", { name: "Add selected text to note" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Capture note scope" }), { target: { value: "workspace" } });
    await waitFor(() => expect(getWorkspaceNotebook).toHaveBeenCalledWith("workspace-1", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Capture note page" })).toHaveValue("main"));
    fireEvent.change(screen.getByRole("combobox", { name: "Capture note page" }), { target: { value: "handoff" } });
    fireEvent.click(screen.getByRole("button", { name: "Add text to note" }));
    await waitFor(() => expect(saveNoteCapture).toHaveBeenCalledWith(
      { scope: "workspace", target: "workspace-1", pageId: "handoff" }, session, "selected text", undefined, expect.any(String),
    ));
    expect(pages[1].content).toBe("Do not overwrite");
    expect(capture).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Saved to workspace note");
  });

  it("keeps dialog keyboard focus away from the live terminal and restores it on cancel", async () => {
    render(<NoteCaptureControls session={session} workspaceId={null} terminal={terminal} selectedText="text" />);
    const trigger = screen.getByRole("button", { name: "Add selected text to note" });
    trigger.focus(); fireEvent.click(trigger);
    const first = screen.getByRole("combobox", { name: "Capture format" });
    await waitFor(() => expect(first).toHaveFocus());
    const outside = document.createElement("input"); document.body.append(outside);
    outside.focus();
    expect(first).toHaveFocus();
    outside.remove();
    const last = screen.getByRole("button", { name: "Add text to note" });
    await waitFor(() => expect(last).toBeEnabled());
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("saves a frozen screenshot with its original text and reuses the upload ID on retry", async () => {
    vi.mocked(saveNoteCapture).mockRejectedValueOnce(new Error("Connection interrupted"));
    render(<NoteCaptureControls session={session} workspaceId={null} terminal={terminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture to notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Capture visible pane" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Capture format" }), { target: { value: "both" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture visible pane" }));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(saveNoteCapture).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveNoteCapture).mock.calls[0]).toEqual(vi.mocked(saveNoteCapture).mock.calls[1]);
    expect(vi.mocked(saveNoteCapture).mock.calls[0].slice(0, 4)).toEqual([
      { scope: "session", target: "alpha", pageId: "main" }, session, "original terminal text", expect.any(Blob),
    ]);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("cancels an old crop when switching sessions without closing a new capture", async () => {
    let resolveCrop!: (image: Blob) => void;
    vi.mocked(cropCapture).mockReturnValueOnce(new Promise((resolve) => { resolveCrop = resolve; }));
    const view = render(<NoteCaptureControls session={session} workspaceId={null} terminal={terminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture to notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Capture visible pane" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Capture visible pane" }));
    view.rerender(<NoteCaptureControls session={{ ...session, name: "beta", id: "$2" }} workspaceId={null} terminal={terminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture to notes" }));
    await act(async () => { resolveCrop(new Blob(["old image"])); });
    expect(saveNoteCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Capture to notes" })).toBeInTheDocument();
  });
});
