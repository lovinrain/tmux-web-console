import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgetUndoNotifications, type ForgetUndoNotification } from "./ForgetUndoNotifications";

function notification(overrides: Partial<ForgetUndoNotification> = {}): ForgetUndoNotification {
  return {
    id: "token-one",
    name: "missing-work",
    expiresAt: Date.now() + 30_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ForgetUndoNotifications", () => {
  it("offers Undo and removes the notification after exactly 30 seconds", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    render(<ForgetUndoNotifications items={[notification()]} onUndo={onUndo} onExpire={onExpire} />);

    expect(screen.getByRole("region", { name: "Forgotten sessions" })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("30s")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Undo forgetting missing-work" }));
    expect(onUndo).toHaveBeenCalledWith("token-one");

    act(() => vi.advanceTimersByTime(29_999));
    expect(screen.getByRole("button", { name: "Undo forgetting missing-work" })).toBeEnabled();
    expect(screen.getByText("1s")).toBeInTheDocument();
    expect(onExpire).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("button", { name: "Undo forgetting missing-work" })).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("token-one");
  });

  it("keeps separate deadlines and actions when several sessions are forgotten", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    const first = notification();
    const { rerender } = render(
      <ForgetUndoNotifications items={[first]} onUndo={onUndo} onExpire={onExpire} />,
    );
    act(() => vi.advanceTimersByTime(10_000));
    const second = notification({ id: "token-two", name: "another-work" });
    rerender(<ForgetUndoNotifications items={[first, second]} onUndo={onUndo} onExpire={onExpire} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo forgetting another-work" }));
    expect(onUndo).toHaveBeenCalledExactlyOnceWith("token-two");
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.queryByRole("button", { name: "Undo forgetting missing-work" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo forgetting another-work" })).toBeEnabled();
    expect(screen.getByText("10s")).toBeInTheDocument();
    expect(onExpire.mock.calls).toEqual([["token-one"]]);

    act(() => vi.advanceTimersByTime(10_000));
    expect(onExpire.mock.calls).toEqual([["token-one"], ["token-two"]]);
  });

  it("disables a pending undo and allows retrying errors until the original deadline", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    const item = notification();
    const { rerender } = render(
      <ForgetUndoNotifications items={[{ ...item, busy: true }]} onUndo={onUndo} onExpire={onExpire} />,
    );
    const button = screen.getByRole("button", { name: "Undo forgetting missing-work" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Restoring…");
    fireEvent.click(button);
    expect(onUndo).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5_000));
    rerender(
      <ForgetUndoNotifications
        items={[{ ...item, error: "Connection lost. Try again." }]}
        onUndo={onUndo}
        onExpire={onExpire}
      />,
    );
    expect(screen.getByText("Connection lost. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo forgetting missing-work" }));
    expect(onUndo).toHaveBeenCalledExactlyOnceWith("token-one");
    act(() => vi.advanceTimersByTime(25_000));
    expect(screen.queryByText("Connection lost. Try again.")).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("token-one");
  });

  it("expires a background-tab notification immediately when focus returns", () => {
    const onExpire = vi.fn();
    render(<ForgetUndoNotifications items={[notification()]} onUndo={vi.fn()} onExpire={onExpire} />);
    act(() => {
      vi.setSystemTime(Date.now() + 35_000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("token-one");
  });

  it("never sends Undo after the deadline even if a suspended timer has not ticked", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    render(<ForgetUndoNotifications items={[notification()]} onUndo={onUndo} onExpire={onExpire} />);
    vi.setSystemTime(Date.now() + 30_000);
    fireEvent.click(screen.getByRole("button", { name: "Undo forgetting missing-work" }));

    expect(onUndo).not.toHaveBeenCalled();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("token-one");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("expires an already expired item once under Strict Mode and cleans up timers", () => {
    const onExpire = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <ForgetUndoNotifications
          items={[notification({ expiresAt: Date.now() })]}
          onUndo={vi.fn()}
          onExpire={onExpire}
        />
      </StrictMode>,
    );
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("token-one");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
