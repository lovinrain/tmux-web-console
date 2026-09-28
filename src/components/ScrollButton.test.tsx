import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollButton } from "./ScrollButton";

function pointer(target: HTMLElement | Window | Document, type: string, options: PointerEventInit = {}) {
  fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, ...options }), {
    pointerId: options.pointerId ?? 1, isPrimary: options.isPrimary ?? true,
  }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("ScrollButton", () => {
  it("scrolls immediately, repeats only after a hold, and avoids a release click", () => {
    const onActivate = vi.fn();
    render(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown");
    expect(onActivate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(349));
    expect(onActivate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(301));
    expect(onActivate).toHaveBeenCalledTimes(5);
    pointer(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onActivate).toHaveBeenCalledTimes(5);
    // Keyboard/assistive clicks and subsequent short taps still work normally.
    fireEvent.click(button, { detail: 0 });
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    expect(onActivate).toHaveBeenCalledTimes(7);
  });

  it.each(["release outside", "cancel", "leave", "capture loss", "blur", "hidden page", "keyboard", "outside move"])(
    "stops on %s and does not resume without a new press", (reason) => {
      const onActivate = vi.fn();
      render(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
      const button = screen.getByRole("button");
      pointer(button, "pointerdown");
      act(() => vi.advanceTimersByTime(450));
      if (reason === "release outside") pointer(window, "pointerup");
      if (reason === "cancel") pointer(window, "pointercancel");
      if (reason === "leave") pointer(button, "pointerout");
      if (reason === "capture loss") pointer(button, "lostpointercapture");
      if (reason === "blur") fireEvent(window, new Event("blur"));
      if (reason === "keyboard") fireEvent.keyDown(window, { key: "Escape" });
      if (reason === "outside move") pointer(window, "pointermove", { clientX: 200, clientY: 200 });
      if (reason === "hidden page") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        fireEvent(document, new Event("visibilitychange"));
      }
      const count = onActivate.mock.calls.length;
      act(() => vi.advanceTimersByTime(1000));
      expect(onActivate).toHaveBeenCalledTimes(count);
      pointer(button, "pointerup");
      fireEvent.click(button, { detail: 1 });
      expect(onActivate).toHaveBeenCalledTimes(count);
    },
  );

  it.each(["disabled", "context", "hidden", "unmount"])("cancels a held control when %s changes", (change) => {
    const onActivate = vi.fn();
    const view = render(<ScrollButton onActivate={onActivate} repeatContext="one">Up</ScrollButton>);
    pointer(screen.getByRole("button"), "pointerdown");
    if (change === "unmount") view.unmount();
    else view.rerender(<ScrollButton onActivate={onActivate} disabled={change === "disabled"}
      repeatContext={change === "context" ? "two" : "one"} hidden={change === "hidden"}>Up</ScrollButton>);
    act(() => vi.advanceTimersByTime(1000));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("waits for pending native requests and never queues work after release", async () => {
    let resolve!: (value: boolean) => void;
    const onActivate = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const view = render(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown");
    view.rerender(<ScrollButton onActivate={onActivate} busy>Up</ScrollButton>);
    expect(button).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(onActivate).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    view.rerender(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(onActivate).toHaveBeenCalledTimes(2);
    pointer(window, "pointerup");
    await act(async () => resolve(true));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("stops after a rejected action and leaves non-scroll keys as single clicks", async () => {
    const onActivate = vi.fn(async () => false);
    const view = render(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
    pointer(screen.getByRole("button"), "pointerdown");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(onActivate).toHaveBeenCalledTimes(1);
    view.rerender(<ScrollButton onActivate={onActivate} repeat={false}>Enter</ScrollButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(onActivate).toHaveBeenCalledTimes(1);
    pointer(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("ignores secondary pointers and right clicks", () => {
    const onActivate = vi.fn();
    render(<ScrollButton onActivate={onActivate}>Up</ScrollButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown", { button: 2 });
    pointer(button, "pointerdown", { isPrimary: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
