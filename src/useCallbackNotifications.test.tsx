import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_NOTIFICATION_STORAGE_KEY, type CallbackNotificationInput } from "./callbackNotifications";
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
