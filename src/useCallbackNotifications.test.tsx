import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_NOTIFICATION_STORAGE_KEY, CALLBACK_NOTIFICATION_DISMISS_PREFIX,
  CALLBACK_NOTIFICATION_DISMISS_RETENTION, MAX_CALLBACK_NOTIFICATION_DISMISSALS,
  type CallbackNotificationInput,
} from "./callbackNotifications";
import { useCallbackNotifications } from "./useCallbackNotifications";

const base: Omit<CallbackNotificationInput, "scope"> & { workspaceKey: string } = {
  sessions: [], workspaceKey: "one", workspaceSessionNames: ["worker"], workspaceCallbackSessions: [],
  workspaceName: "Launch room", callbacksLoaded: true,
  snapshot: { callbackSessions: [], globalCallbackSessions: [], workspaceCallbacks: [], sessionRevision: 0 },
};
function reports(...sequences: number[]) {
  return { ...base.snapshot, callbackMessages: sequences.map((sequence) => ({
    id: `report-${sequence}`, sequence, sessionName: "worker", message: "Complete", agentType: "codex", cwd: "/tmp",
    requestId: null, tmuxSessionId: null, tmuxPaneId: null, host: null, createdAt: sequence, reviewedAt: null,
  })) };
}
const dismissalKey = (id: string) => `${CALLBACK_NOTIFICATION_DISMISS_PREFIX}${encodeURIComponent(id)}`;
beforeEach(() => window.localStorage.clear());

describe("callback notification preferences", () => {
  it("defaults to Off, persists the chosen scope, and dismisses without reviewing callbacks", () => {
    const { result, rerender, unmount } = renderHook(useCallbackNotifications, { initialProps: base });
    expect(result.current.scope).toBe("off");
    act(() => result.current.setScope("workspace"));
    expect(localStorage.getItem(CALLBACK_NOTIFICATION_STORAGE_KEY)).toBe("workspace");
    rerender({ ...base, snapshot: reports(1) });
    expect(result.current.notifications).toHaveLength(1);
    act(() => result.current.dismiss("message:report-1"));
    expect(result.current.notifications).toEqual([]);
    rerender({ ...base, snapshot: reports(1) });
    expect(result.current.notifications).toEqual([]);
    unmount();
    const restored = renderHook(useCallbackNotifications, { initialProps: { ...base, snapshot: reports(1) } });
    expect(restored.result.current.scope).toBe("workspace");
    expect(restored.result.current.notifications).toEqual([]);
  });

  it("shares scope changes between browser tabs, clearing visible notifications when disabled", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: base });
    rerender({ ...base, snapshot: reports(1) });
    expect(result.current.notifications).toHaveLength(1);
    act(() => {
      localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "off");
      window.dispatchEvent(new StorageEvent("storage", { key: CALLBACK_NOTIFICATION_STORAGE_KEY, newValue: "off" }));
    });
    expect(result.current.scope).toBe("off");
    expect(result.current.notifications).toEqual([]);
  });

  it("shares a manual dismissal with another workspace and suppresses delivery arriving after the close", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const first = renderHook(useCallbackNotifications, { initialProps: base });
    const second = renderHook(useCallbackNotifications, { initialProps: { ...base, workspaceKey: "two" } });
    first.rerender({ ...base, snapshot: reports(1) });
    second.rerender({ ...base, workspaceKey: "two", snapshot: reports(1) });
    expect(second.result.current.notifications).toHaveLength(1);
    act(() => first.result.current.dismiss("message:report-1"));
    const key = dismissalKey("message:report-1");
    expect(localStorage.getItem(key)).toBeTruthy();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key) })));
    expect(second.result.current.notifications).toEqual([]);
    const delayed = renderHook(useCallbackNotifications, { initialProps: base });
    delayed.rerender({ ...base, snapshot: reports(1) });
    expect(delayed.result.current.notifications).toEqual([]);
    second.rerender({ ...base, workspaceKey: "two", snapshot: reports(1, 2) });
    expect(second.result.current.notifications).toMatchObject([{ id: "message:report-2" }]);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key) })));
    expect(second.result.current.notifications).toMatchObject([{ id: "message:report-2" }]);
  });

  it("uses durable independent dismissal keys, bounds retention, and preserves unrelated browser preferences", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    localStorage.setItem("unrelated-preference", "keep");
    const now = Date.now();
    localStorage.setItem(dismissalKey("expired"), String(now - CALLBACK_NOTIFICATION_DISMISS_RETENTION - 1));
    for (let index = 0; index < MAX_CALLBACK_NOTIFICATION_DISMISSALS; index += 1) {
      localStorage.setItem(dismissalKey(`older-${index}`), String(now - 1_000 - index));
    }
    const { result } = renderHook(useCallbackNotifications, { initialProps: base });
    act(() => result.current.dismiss("message:report-1"));
    act(() => result.current.dismiss("message:report-2"));
    expect(localStorage.getItem(dismissalKey("message:report-1"))).toBeTruthy();
    expect(localStorage.getItem(dismissalKey("message:report-2"))).toBeTruthy();
    expect(localStorage.getItem(dismissalKey("expired"))).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key?.startsWith(CALLBACK_NOTIFICATION_DISMISS_PREFIX))).toHaveLength(MAX_CALLBACK_NOTIFICATION_DISMISSALS);
  });

  it("keeps automatic expiry local and catches missed dismissals when a workspace regains focus", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const first = renderHook(useCallbackNotifications, { initialProps: base });
    const second = renderHook(useCallbackNotifications, { initialProps: base });
    first.rerender({ ...base, snapshot: reports(1) });
    second.rerender({ ...base, snapshot: reports(1) });
    act(() => first.result.current.expire("message:report-1"));
    expect(second.result.current.notifications).toHaveLength(1);
    expect(localStorage.getItem(dismissalKey("message:report-1"))).toBeNull();
    act(() => {
      localStorage.setItem(dismissalKey("message:report-1"), String(Date.now()));
      window.dispatchEvent(new Event("focus"));
    });
    expect(second.result.current.notifications).toEqual([]);
  });

  it("keeps preferences usable when browser storage is blocked", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: base });
    act(() => result.current.setScope("all"));
    rerender({ ...base, snapshot: reports(1) });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.scope).toBe("all");
    read.mockRestore(); write.mockRestore();
  });
});
