import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistorySnapshot, listSubmittedMessages, loadSavedScrollback, loadAgentTranscript } from "../api";
import type { HistoryPage, Pane } from "../types";
import {
  DEFAULT_HISTORY_PANEL_WIDTH,
  HISTORY_PANEL_MOBILE_BREAKPOINT,
  HistoryPanel,
  MIN_HISTORY_PANEL_WIDTH,
} from "./HistoryPanel";

vi.mock("../api", () => ({
  createHistorySnapshot: vi.fn(),
  loadHistoryPage: vi.fn(),
  listSubmittedMessages: vi.fn(),
  loadSavedScrollback: vi.fn(),
  loadAgentTranscript: vi.fn(),
}));

const DESKTOP_VIEWPORT_WIDTH = 1200;
const DESKTOP_MAX_PANEL_WIDTH = DESKTOP_VIEWPORT_WIDTH;
const originalInnerWidth = window.innerWidth;

function pane(): Pane {
  return {
    id: "%7",
    index: 0,
    window_index: 0,
    window_name: "main",
    window_active: true,
    active: true,
    command: "bash",
    path: "/work",
    title: "shell",
    width: 100,
    height: 30,
    history_size: 20,
    history_limit: 2000,
    alternate_on: false,
    dead: false,
    activity: 1,
  };
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function panelWidth(): string {
  return screen
    .getByRole("dialog", { name: "Tmux pane history" })
    .style.getPropertyValue("--history-panel-width");
}

interface PointerOptions {
  pointerId: number;
  clientX: number;
  pointerType?: string;
  button?: number;
}

function dispatchPointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  {
    pointerId,
    clientX,
    pointerType = "mouse",
    button = 0,
  }: PointerOptions,
) {
  // jsdom has no PointerEvent constructor, but React receives pointer fields
  // from a MouseEvent dispatched under the corresponding pointer event name.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    clientX,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  fireEvent(target, event);
}

function renderPanel({
  preferredWidth = DEFAULT_HISTORY_PANEL_WIDTH,
  onPreferredWidthChange = vi.fn(),
}: {
  preferredWidth?: number;
  onPreferredWidthChange?: (width: number) => void;
} = {}) {
  render(
    <HistoryPanel
      pane={pane()}
      onClose={vi.fn()}
      preferredWidth={preferredWidth}
      onPreferredWidthChange={onPreferredWidthChange}
    />,
  );
  return {
    handle: screen.getByRole("separator", { name: "Resize scrollback panel" }),
    onPreferredWidthChange,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
  // Resizing does not depend on a completed history request. Keeping this
  // pending avoids unrelated async state updates in these focused tests.
  vi.mocked(createHistorySnapshot).mockReturnValue(
    new Promise<HistoryPage>(() => undefined),
  );
});

afterEach(() => {
  setViewportWidth(originalInnerWidth);
  document.documentElement.classList.remove("history-resizing");
});

describe("HistoryPanel", () => {
  it("navigates recorded output and submitted input without changing the scrollback snapshot", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue({ sources: [], selectedSource: null, status: "unidentified", messages: [], nextCursor: null, partial: false, notice: "No conversation ID recorded." });
    vi.mocked(listSubmittedMessages).mockResolvedValue({ messages: [], nextCursor: null, sources: [] });
    vi.mocked(loadSavedScrollback).mockResolvedValue({
      part: "beginning", lines: ["Saved opening"], panes: [], selectedPane: null,
      capturedAt: 100, firstCapturedAt: 100, sessionCreatedAt: 90, limited: false,
      lineLimit: 2000, byteLimit: 1048576,
    });
    render(<HistoryPanel pane={pane()} sessionName="agent" sessionIdentity="$1:1:1:1" onClose={vi.fn()} />);
    const scrollback = screen.getByRole("tab", { name: "Scrollback" });
    fireEvent.keyDown(scrollback, { key: "ArrowRight" });
    const beginning = screen.getByRole("tab", { name: "Recorded output" });
    expect(beginning).toHaveFocus();
    expect(beginning).toHaveAttribute("aria-selected", "true");
    await screen.findByText("Saved opening");
    expect(loadSavedScrollback).toHaveBeenCalledWith({ paneId: "%7", identity: "$1:1:1:1" }, "beginning", null, expect.any(AbortSignal));
    fireEvent.keyDown(beginning, { key: "ArrowRight" });
    const submitted = screen.getByRole("tab", { name: "Submitted messages" });
    expect(submitted).toHaveFocus();
    expect(submitted).toHaveAttribute("aria-selected", "true");
    await screen.findByText(/No Claude Code or Codex conversation ID/);
    expect(listSubmittedMessages).toHaveBeenCalledWith({ sessionName: "agent", identity: "$1:1:1:1" }, "", null, expect.any(AbortSignal));
    fireEvent.keyDown(submitted, { key: "ArrowRight" });
    const transcript = screen.getByRole("tab", { name: "Transcript" });
    expect(transcript).toHaveFocus();
    expect(transcript).toHaveAttribute("aria-selected", "true");
    await screen.findByText("No conversation ID recorded.");
    fireEvent.keyDown(transcript, { key: "ArrowRight" });
    expect(scrollback).toHaveFocus();
    expect(scrollback).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(scrollback, { key: "ArrowLeft" });
    expect(transcript).toHaveFocus();
    fireEvent.keyDown(transcript, { key: "ArrowLeft" });
    expect(submitted).toHaveFocus();
    fireEvent.keyDown(submitted, { key: "Home" });
    expect(transcript).toHaveFocus();
    fireEvent.keyDown(transcript, { key: "End" });
    expect(submitted).toHaveFocus();
    expect(createHistorySnapshot).toHaveBeenCalledTimes(1);
  });

  it("opens a Codex transcript first and offers terminal history when it is unavailable", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue({ sources: [], selectedSource: null, status: "missing", messages: [], nextCursor: null, partial: false, notice: "The local transcript was not found." });
    render(<HistoryPanel pane={{ ...pane(), command: "codex" }} sessionIdentity="$1:1:1:1" onClose={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    await screen.findByText("The local transcript was not found.");
    expect(createHistorySnapshot).not.toHaveBeenCalled();
    expect(loadAgentTranscript).toHaveBeenCalledWith({ paneId: "%7", identity: "$1:1:1:1" }, null, null, expect.any(AbortSignal), "conversation");
    fireEvent.click(screen.getByRole("button", { name: "Terminal scrollback" }));
    expect(createHistorySnapshot).toHaveBeenCalledWith("%7");
  });

  it.each(["codex", "claude", "copilot", "cursor-agent", "grok"])("keeps the %s transcript distinct from recorded terminal output", async (command) => {
    vi.mocked(loadAgentTranscript).mockResolvedValue({
      sources: [], selectedSource: null, status: "available", nextCursor: null, partial: false, notice: null,
      messages: [{ id: "first", role: "user", kind: "prompt", text: "Actual original prompt", timestamp: null, truncated: false }],
    });
    vi.mocked(loadSavedScrollback).mockResolvedValue({
      part: "beginning", lines: ["Earlier messages are available — press ctrl+t to view the full transcript"],
      panes: [], selectedPane: null, capturedAt: 100, firstCapturedAt: 100, sessionCreatedAt: 1,
      limited: false, lineLimit: 2000, byteLimit: 1048576,
    });
    render(<HistoryPanel pane={{ ...pane(), command }} onClose={vi.fn()} />);
    await screen.findByText("Actual original prompt");
    expect(screen.queryByRole("tab", { name: /Conversation beginning|Saved beginning/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/Earlier messages are available/)).not.toBeInTheDocument();
    expect(loadSavedScrollback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recorded terminal output" }));
    await screen.findByText(/Earlier messages are available/);
    expect(screen.getByRole("tab", { name: "Recorded output" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Read the transcript" }));
    await screen.findByText("Actual original prompt");
    expect(screen.queryByText(/Earlier messages are available/)).not.toBeInTheDocument();
  });

  it("contains focus and keyboard events, closes on Escape, and restores the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const leakedKey = vi.fn();
    window.addEventListener("keydown", leakedKey);
    const view = render(<HistoryPanel pane={pane()} onClose={onClose} />);
    try {
      const close = screen.getByRole("button", { name: "Close history" });
      const last = screen.getByRole("button", { name: "Back to live" });
      const first = screen.getByRole("separator", { name: "Resize scrollback panel" });
      expect(close).toHaveFocus();
      opener.focus();
      expect(close).toHaveFocus();
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(first).toHaveFocus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: "x" });
      fireEvent.keyDown(last, { key: "Escape", isComposing: true });
      expect(onClose).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(last, { key: "Escape" })).toBe(false);
      expect(onClose).toHaveBeenCalledOnce();
      expect(leakedKey).not.toHaveBeenCalled();
      view.unmount();
      expect(opener).toHaveFocus();
      fireEvent.keyDown(opener, { key: "x" });
      expect(leakedKey).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      window.removeEventListener("keydown", leakedKey);
      opener.remove();
    }
  });

  it("exposes the initial width and desktop bounds through the separator", () => {
    const { handle, onPreferredWidthChange } = renderPanel({ preferredWidth: 704 });

    expect(panelWidth()).toBe("704px");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", String(MIN_HISTORY_PANEL_WIDTH));
    expect(handle).toHaveAttribute("aria-valuemax", String(DESKTOP_MAX_PANEL_WIDTH));
    expect(handle).toHaveAttribute("aria-valuenow", "704");
    expect(handle).toHaveAttribute("aria-valuetext", "704 pixels wide");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).not.toHaveAttribute("aria-hidden");
    expect(onPreferredWidthChange).not.toHaveBeenCalled();
    expect(createHistorySnapshot).toHaveBeenCalledWith("%7");
  });

  it("resizes, clamps, and resets from the keyboard", () => {
    const onPreferredWidthChange = vi.fn();
    const { handle } = renderPanel({ onPreferredWidthChange });

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panelWidth()).toBe("696px");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panelWidth()).toBe("680px");

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(panelWidth()).toBe("744px");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(panelWidth()).toBe("680px");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(panelWidth()).toBe(`${MIN_HISTORY_PANEL_WIDTH}px`);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panelWidth()).toBe(`${MIN_HISTORY_PANEL_WIDTH}px`);

    fireEvent.keyDown(handle, { key: "End" });
    expect(panelWidth()).toBe(`${DESKTOP_MAX_PANEL_WIDTH}px`);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panelWidth()).toBe(`${DESKTOP_MAX_PANEL_WIDTH}px`);

    fireEvent.keyDown(handle, { key: "Enter" });
    expect(panelWidth()).toBe(`${DEFAULT_HISTORY_PANEL_WIDTH}px`);
    expect(onPreferredWidthChange.mock.calls.map(([width]) => width)).toEqual([
      696,
      680,
      744,
      680,
      MIN_HISTORY_PANEL_WIDTH,
      MIN_HISTORY_PANEL_WIDTH,
      DESKTOP_MAX_PANEL_WIDTH,
      DESKTOP_MAX_PANEL_WIDTH,
      DEFAULT_HISTORY_PANEL_WIDTH,
    ]);
  });

  it("fits to width presets and restores the previous custom width without recapturing", () => {
    const { handle, onPreferredWidthChange } = renderPanel({ preferredWidth: 704 });
    const restore = screen.getByRole("button", { name: "Restore previous width" });
    expect(restore).toBeDisabled();
    for (const percent of [50, 75, 100]) {
      const button = screen.getByRole("button", { name: `${percent}% width` });
      fireEvent.click(button);
      expect(panelWidth()).toBe(`${DESKTOP_VIEWPORT_WIDTH * percent / 100}px`);
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(onPreferredWidthChange).toHaveBeenLastCalledWith(DESKTOP_VIEWPORT_WIDTH * percent / 100);
    }
    fireEvent.click(restore);
    expect(panelWidth()).toBe("704px");
    expect(onPreferredWidthChange).toHaveBeenLastCalledWith(704);
    expect(restore).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "100% width" }));
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panelWidth()).toBe("1184px");
    expect(screen.getByRole("button", { name: "100% width" })).toHaveAttribute("aria-pressed", "false");
    expect(restore).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "50% width" }));
    fireEvent.click(restore);
    expect(panelWidth()).toBe("1184px");
    expect(createHistorySnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps half-width readable on a narrow desktop and clamps restore after a viewport change", () => {
    renderPanel({ preferredWidth: 1000 });
    fireEvent.click(screen.getByRole("button", { name: "100% width" }));
    setViewportWidth(700);
    fireEvent(window, new Event("resize"));
    fireEvent.click(screen.getByRole("button", { name: "50% width" }));
    expect(panelWidth()).toBe(`${MIN_HISTORY_PANEL_WIDTH}px`);
    fireEvent.click(screen.getByRole("button", { name: "Restore previous width" }));
    expect(panelWidth()).toBe("700px");
  });

  it("drags wider and narrower, ignores other pointers, and clamps both bounds", () => {
    const onPreferredWidthChange = vi.fn();
    const { handle } = renderPanel({ onPreferredWidthChange });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(handle, {
      setPointerCapture,
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture,
    });

    dispatchPointer(handle, "pointerdown", { pointerId: 7, clientX: 520 });
    expect(handle).toHaveFocus();
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(document.documentElement).toHaveClass("history-resizing");

    dispatchPointer(handle, "pointermove", { pointerId: 8, clientX: 420 });
    expect(panelWidth()).toBe("680px");
    dispatchPointer(handle, "pointermove", { pointerId: 7, clientX: 420 });
    expect(panelWidth()).toBe("780px");
    dispatchPointer(handle, "pointerup", { pointerId: 8, clientX: 420 });
    expect(onPreferredWidthChange).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("history-resizing");
    dispatchPointer(handle, "pointerup", { pointerId: 7, clientX: 420 });
    expect(onPreferredWidthChange).toHaveBeenLastCalledWith(780);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(document.documentElement).not.toHaveClass("history-resizing");

    dispatchPointer(handle, "pointerdown", { pointerId: 9, clientX: 420 });
    dispatchPointer(handle, "pointermove", { pointerId: 9, clientX: 1000 });
    expect(panelWidth()).toBe(`${MIN_HISTORY_PANEL_WIDTH}px`);
    dispatchPointer(handle, "pointerup", { pointerId: 9, clientX: 1000 });
    expect(onPreferredWidthChange).toHaveBeenLastCalledWith(MIN_HISTORY_PANEL_WIDTH);

    dispatchPointer(handle, "pointerdown", { pointerId: 10, clientX: 500 });
    dispatchPointer(handle, "pointermove", { pointerId: 10, clientX: -1000 });
    expect(panelWidth()).toBe(`${DESKTOP_MAX_PANEL_WIDTH}px`);
    dispatchPointer(handle, "pointerup", { pointerId: 10, clientX: -1000 });
    expect(onPreferredWidthChange).toHaveBeenLastCalledWith(DESKTOP_MAX_PANEL_WIDTH);
  });

  it("cancels a drag without committing and restores the preferred width", () => {
    const onPreferredWidthChange = vi.fn();
    const { handle } = renderPanel({ preferredWidth: 720, onPreferredWidthChange });
    const releasePointerCapture = vi.fn();
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture,
    });

    dispatchPointer(handle, "pointerdown", { pointerId: 4, clientX: 500 });
    dispatchPointer(handle, "pointermove", { pointerId: 4, clientX: 350 });
    expect(panelWidth()).toBe("870px");

    dispatchPointer(handle, "pointercancel", { pointerId: 3, clientX: 350 });
    expect(panelWidth()).toBe("870px");
    expect(document.documentElement).toHaveClass("history-resizing");

    dispatchPointer(handle, "pointercancel", { pointerId: 4, clientX: 350 });
    expect(panelWidth()).toBe("720px");
    expect(onPreferredWidthChange).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
    expect(document.documentElement).not.toHaveClass("history-resizing");
  });

  it("removes the resize handle from keyboard and assistive-tech use on mobile", () => {
    const onPreferredWidthChange = vi.fn();
    const { handle } = renderPanel({ onPreferredWidthChange });

    setViewportWidth(HISTORY_PANEL_MOBILE_BREAKPOINT);
    fireEvent(window, new Event("resize"));

    expect(handle).toHaveAttribute("aria-hidden", "true");
    expect(handle).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("group", { name: "History window width" })).not.toBeInTheDocument();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    dispatchPointer(handle, "pointerdown", { pointerId: 2, clientX: 300 });
    expect(onPreferredWidthChange).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("history-resizing");
  });
});
