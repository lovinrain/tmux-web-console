import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CallbackNotificationSettings } from "./CallbackNotificationSettings";
import { CallbackNotifications } from "./CallbackNotifications";
import { CALLBACK_NOTIFICATION_DURATION, type CallbackNotification, type CallbackNotificationScope,
  type MutedCallbackSession } from "../callbackNotifications";

const item: CallbackNotification = {
  id: "report-one", sessionName: "worker", sessionIdentity: '["$1",1,1,1]', title: "Release check", kind: "message",
  label: "New callback", detail: "Completed the deployment checks. <img src=x onerror=alert(1)>", workspace: "Launch room",
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("callback notification controls", () => {
  it("lists muted sessions and re-enables an individual session while leaving the menu open", () => {
    function Settings() {
      const [muted, setMuted] = useState<MutedCallbackSession[]>([
        { identity: item.sessionIdentity!, sessionName: "worker", title: "Release check" },
        { identity: "other", sessionName: "other", title: "other" },
      ]);
      return <CallbackNotificationSettings scope="all" onChange={vi.fn()} mutedSessions={muted}
        onUnmuteSession={(identity) => setMuted((current) => current.filter((session) => session.identity !== identity))} />;
    }
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Callback notifications" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Release check");
    fireEvent.click(screen.getByRole("button", { name: "Re-enable notifications for worker" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Re-enable notifications for worker" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-enable notifications for other" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /^All sessions/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Re-enable notifications for other" }));
    expect(screen.getByText("No muted sessions.")).toBeVisible();
  });

  it("mutes live sessions with a separate action and omits it for ended or unbound reports", () => {
    const mute = vi.fn();
    const dismiss = vi.fn();
    const expire = vi.fn();
    render(<CallbackNotifications items={[item, { ...item, id: "ended", kind: "ended", label: "Session ended" },
      { ...item, id: "unbound", sessionName: "absent", sessionIdentity: null }]}
      onDismiss={dismiss} onExpire={expire} onMuteSession={mute} />);
    expect(screen.getAllByRole("button", { name: /^Mute notifications from/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Mute notifications from worker" }));
    expect(mute).toHaveBeenCalledExactlyOnceWith(item.sessionIdentity);
    expect(dismiss).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("opens from the bell, changes scope, and closes with Escape while restoring focus", () => {
    function Settings() {
      const [scope, setScope] = useState<CallbackNotificationScope>("off");
      return <CallbackNotificationSettings scope={scope} onChange={setScope} />;
    }
    render(<Settings />);
    const bell = screen.getByRole("button", { name: "Callback notifications" });
    expect(bell).toHaveAttribute("data-enabled", "false");
    fireEvent.click(bell);
    expect(screen.getByRole("radio", { name: /^Off/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("radio", { name: /^This workspace/ }));
    expect(bell).toHaveAttribute("data-enabled", "true");
    expect(bell).toHaveAttribute("aria-description", "Notifications: This workspace");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
    fireEvent.click(bell);
    expect(screen.getByRole("radio", { name: /^This workspace/ })).toBeChecked();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows literal reports and fades after eight seconds without consuming time while hovered or focused", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const expire = vi.fn();
    render(<CallbackNotifications items={[item]} onDismiss={dismiss} onExpire={expire} onMuteSession={vi.fn()} />);
    const toast = screen.getByRole("article", { name: "worker: New callback" });
    expect(toast).toHaveTextContent("Release check");
    expect(toast).toHaveTextContent("Launch room");
    expect(toast).toHaveTextContent(item.detail);
    expect(toast.querySelector("img")).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(20_000));
    expect(dismiss).not.toHaveBeenCalled();
    const close = screen.getByRole("button", { name: "Dismiss notification from worker" });
    fireEvent.focus(close);
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(20_000));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.blur(close, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(CALLBACK_NOTIFICATION_DURATION - 3_000 - 250));
    expect(toast).toHaveClass("leaving");
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(expire).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("pauses while the browser tab is hidden and supports click or keyboard dismissal", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(<CallbackNotifications items={[item]} onDismiss={dismiss} onExpire={vi.fn()} onMuteSession={vi.fn()} />);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(60_000));
    expect(dismiss).not.toHaveBeenCalled();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(screen.getByRole("article"));
    expect(dismiss).toHaveBeenLastCalledWith(item.id);
    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss notification from worker" }), { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
