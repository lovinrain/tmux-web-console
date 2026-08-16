import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistorySnapshot } from "../api";
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
}));

const DESKTOP_VIEWPORT_WIDTH = 1200;
const DESKTOP_MAX_PANEL_WIDTH = DESKTOP_VIEWPORT_WIDTH - 48;
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

describe("HistoryPanel resizing", () => {
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
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    dispatchPointer(handle, "pointerdown", { pointerId: 2, clientX: 300 });
    expect(onPreferredWidthChange).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("history-resizing");
  });
});
