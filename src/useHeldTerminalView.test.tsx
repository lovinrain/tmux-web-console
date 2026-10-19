import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTerminalHandle } from "./components/LiveTerminal";
import type { TerminalCaptureSnapshot } from "./terminalCapture";
import { useHeldTerminalView } from "./useHeldTerminalView";

const createUrl = vi.fn(() => "blob:held-view");
const revokeUrl = vi.fn();
const NativeURL = URL;

function capture(): TerminalCaptureSnapshot {
  return { canvas: { toBlob: (callback: BlobCallback) => callback(new Blob(["image"], { type: "image/png" })) } as HTMLCanvasElement,
    width: 800, height: 600, cols: 80, rows: 24, lines: ["Earlier output"], textForArea: () => "Earlier output" };
}

function setup() {
  const target = { capture: vi.fn(async () => capture()), navigateHistory: vi.fn(() => true), submit: vi.fn(async () => true) };
  const terminal = { current: target as unknown as LiveTerminalHandle | null };
  const hook = renderHook(({ context, enabled }) => useHeldTerminalView(terminal, context, enabled), {
    initialProps: { context: "session-1:pane-1", enabled: true },
  });
  return { ...hook, target, terminal };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", class extends NativeURL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("useHeldTerminalView", () => {
  it("captures once before sending, reuses the original image for more questions, and releases it", async () => {
    const { result, target } = setup();
    await act(async () => { expect(await result.current.submitKeepingView("first question", "enter")).toBe(true); });
    expect(target.capture).toHaveBeenCalledOnce();
    expect(target.capture.mock.invocationCallOrder[0]).toBeLessThan(target.submit.mock.invocationCallOrder[0]);
    expect(target.navigateHistory).toHaveBeenCalledWith("exit", false);
    expect(target.navigateHistory.mock.invocationCallOrder[0]).toBeLessThan(target.submit.mock.invocationCallOrder[0]);
    const original = result.current.snapshot;
    expect(original?.url).toBe("blob:held-view");
    await act(async () => { expect(await result.current.submitKeepingView("second question", "enter")).toBe(true); });
    expect(result.current.snapshot).toBe(original);
    expect(target.capture).toHaveBeenCalledOnce();
    expect(target.submit.mock.calls).toEqual([["first question", "enter"], ["second question", "enter"]]);
    act(() => result.current.release());
    expect(result.current.snapshot).toBeNull();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:held-view");
  });

  it("does not send when capture fails", async () => {
    const { result, target } = setup();
    target.capture.mockRejectedValue(new Error("Hidden terminal"));
    await act(async () => { expect(await result.current.submitKeepingView("keep my draft", "enter")).toBe(false); });
    expect(target.submit).not.toHaveBeenCalled();
    expect(result.current.error).toContain("Nothing was sent");
    expect(result.current.snapshot).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("discards a completed snapshot when the native source changes", async () => {
    const { result, rerender } = setup();
    await act(async () => { await result.current.submitKeepingView("question", "enter"); });
    expect(result.current.snapshot).not.toBeNull();
    rerender({ context: "session-1:pane-2", enabled: true });
    expect(result.current.snapshot).toBeNull();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:held-view");
  });

  it("cancels a capture across a source switch even if the user returns to the original session", async () => {
    const { result, target, rerender } = setup();
    let finishCapture!: (value: TerminalCaptureSnapshot) => void;
    target.capture.mockImplementation(() => new Promise((resolve) => { finishCapture = resolve; }));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.submitKeepingView("do not send elsewhere", "enter"); });
    rerender({ context: "session-2:pane-2", enabled: true });
    rerender({ context: "session-1:pane-1", enabled: true });
    await act(async () => { finishCapture(capture()); expect(await sending).toBe(false); });
    expect(target.submit).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("keeps the snapshot on an unconfirmed send and rejects disconnected submissions", async () => {
    const { result, target, rerender } = setup();
    target.submit.mockResolvedValue(false);
    await act(async () => { expect(await result.current.submitKeepingView("uncertain", "enter")).toBe(false); });
    expect(result.current.snapshot?.url).toBe("blob:held-view");
    expect(target.submit).toHaveBeenCalledOnce();
    rerender({ context: "session-1:pane-1", enabled: false });
    await act(async () => { expect(await result.current.submitKeepingView("offline", "enter")).toBe(false); });
    expect(target.submit).toHaveBeenCalledOnce();
    expect(result.current.snapshot?.url).toBe("blob:held-view");
  });

  it("releases the image and cancels sending when unmounted before the capture frame commits", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const { result, target, unmount } = setup();
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.submitKeepingView("cancel on close", "enter"); });
    await waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { for (const frame of frames) frame(0); expect(await sending).toBe(false); });
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:held-view");
    expect(target.submit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
