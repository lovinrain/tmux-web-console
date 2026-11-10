import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_NOTIFICATION_STORAGE_KEY, CALLBACK_NOTIFICATION_DISMISS_PREFIX,
  CALLBACK_NOTIFICATION_MUTE_PREFIX,
  CALLBACK_NOTIFICATION_WORKSPACE_PREFIX,
  CALLBACK_NOTIFICATION_DISMISS_RETENTION, MAX_CALLBACK_NOTIFICATION_DISMISSALS,
  type CallbackNotificationInput,
} from "./callbackNotifications";
import { useCallbackNotifications } from "./useCallbackNotifications";
import { sessionReadyIdentity } from "./sessionReadyAttention";
import type { Session } from "./types";

const base: Omit<CallbackNotificationInput, "scope"> & { workspaceKey: string; sessionsLoaded: boolean } = {
  sessions: [], workspaceKey: "one", workspaceSessionNames: ["worker"], workspaceCallbackSessions: [],
  workspaceName: "Launch room", callbacksLoaded: true, sessionsLoaded: true,
  snapshot: { callbackSessions: [], globalCallbackSessions: [], workspaceCallbacks: [], sessionRevision: 0 },
};
const worker: Session = {
  name: "worker", id: "$1", created: 1, serverStarted: 1, serverPid: 1, windows: 1, attached: 0, activity: 1,
  activePaneId: null, agentState: "working", agentStateChangedAt: 10, agentStateReason: "fixture",
  customTitle: "Release check", tags: [], starred: false, ignored: false, queuedMessageCount: 0, panes: [],
};
const live: typeof base = { ...base, sessions: [worker] };
const identity = sessionReadyIdentity(worker);
const muteKey = (id: string) => `${CALLBACK_NOTIFICATION_MUTE_PREFIX}${encodeURIComponent(id)}`;
function reports(...sequences: number[]) {
  return { ...base.snapshot, callbackMessages: sequences.map((sequence) => ({
    id: `report-${sequence}`, sequence, sessionName: "worker", message: "Complete", agentType: "codex", cwd: "/tmp",
    requestId: null, tmuxSessionId: null, tmuxPaneId: null, host: null, createdAt: sequence, reviewedAt: null,
  })) };
}
const dismissalKey = (id: string) => `${CALLBACK_NOTIFICATION_DISMISS_PREFIX}${encodeURIComponent(id)}`;
beforeEach(() => window.localStorage.clear());

describe("callback notification preferences", () => {
  it("inherits globally, overrides each saved workspace independently, and restores inheritance without replay", () => {
    const initial = { ...live, workspaceId: "one" };
    const first = renderHook(useCallbackNotifications, { initialProps: initial });
    expect(first.result.current.workspaceScope).toBeNull();
    act(() => first.result.current.setWorkspaceScope("workspace"));
    expect(first.result.current.scope).toBe("off");
    expect(first.result.current.effectiveScope).toBe("workspace");
    first.rerender({ ...initial, snapshot: reports(1) });
    expect(first.result.current.notifications).toHaveLength(1);
    first.rerender({ ...initial, workspaceId: "two", workspaceKey: "two", snapshot: reports(1) });
    expect(first.result.current.effectiveScope).toBe("off");
    expect(first.result.current.notifications).toEqual([]);
    act(() => first.result.current.setWorkspaceScope("off"));
    act(() => first.result.current.setScope("all"));
    expect(first.result.current.effectiveScope).toBe("off");
    first.rerender({ ...initial, snapshot: reports(1, 2) });
    expect(first.result.current.effectiveScope).toBe("workspace");
    act(() => first.result.current.setWorkspaceScope(null));
    expect(first.result.current.effectiveScope).toBe("all");
    expect(first.result.current.workspaceScope).toBeNull();
    expect(localStorage.getItem(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + "one")).toBeNull();
    first.unmount();
    const restored = renderHook(useCallbackNotifications, { initialProps: { ...initial, workspaceId: "two" } });
    expect(restored.result.current.scope).toBe("all");
    expect(restored.result.current.effectiveScope).toBe("off");
    expect(restored.result.current.notifications).toEqual([]);
  });

  it("shares workspace preferences across tabs, preserves independent workspace writes, and refreshes missed updates", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const first = renderHook(useCallbackNotifications, { initialProps: { ...live, workspaceId: "one" } });
    const second = renderHook(useCallbackNotifications, { initialProps: { ...live, workspaceId: "two", workspaceKey: "two" } });
    act(() => first.result.current.setWorkspaceScope("off"));
    act(() => second.result.current.setWorkspaceScope("watched"));
    const key = CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + "one";
    expect(localStorage.getItem(key)).toBe("off");
    expect(localStorage.getItem(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + "two")).toBe("watched");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "off" })));
    expect(first.result.current.effectiveScope).toBe("off");
    expect(second.result.current.effectiveScope).toBe("watched");
    act(() => {
      localStorage.setItem(key, "workspace");
      window.dispatchEvent(new Event("focus"));
    });
    expect(first.result.current.effectiveScope).toBe("workspace");
    act(() => {
      localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
    });
    expect(first.result.current.effectiveScope).toBe("all");
    expect(second.result.current.effectiveScope).toBe("watched");
  });

  it("ignores malformed workspace preferences and keeps failed-to-persist choices for the active page", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    localStorage.setItem(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + "one", "invalid");
    localStorage.setItem(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + "%bad", "off");
    const { result } = renderHook(useCallbackNotifications, { initialProps: { ...live, workspaceId: "one" } });
    expect(result.current.workspaceScope).toBeNull();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    act(() => result.current.setWorkspaceScope("off"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.effectiveScope).toBe("off");
    write.mockRestore();
    act(() => result.current.setWorkspaceScope(null));
    expect(result.current.effectiveScope).toBe("all");
  });

  it("mutes a session across future reports and reloads, then re-enables only future events", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const first = renderHook(useCallbackNotifications, { initialProps: live });
    first.rerender({ ...live, snapshot: reports(1) });
    expect(first.result.current.notifications).toMatchObject([{ sessionIdentity: identity }]);
    act(() => first.result.current.muteSession(identity));
    expect(first.result.current.notifications).toEqual([]);
    expect(localStorage.getItem(muteKey(identity))).toBe("1");
    expect(first.result.current.mutedSessions).toEqual([{ identity, sessionName: "worker", title: "Release check" }]);
    first.rerender({ ...live, snapshot: reports(1, 2) });
    expect(first.result.current.notifications).toEqual([]);
    expect(first.result.current.mutedSessions).toHaveLength(1);
    first.unmount();

    const pending: typeof base = { ...base, sessionsLoaded: false, snapshot: reports(1, 2) };
    const restored = renderHook(useCallbackNotifications, { initialProps: pending });
    expect(localStorage.getItem(muteKey(identity))).toBe("1");
    restored.rerender({ ...live, snapshot: reports(1, 2) });
    expect(restored.result.current.mutedSessions).toHaveLength(1);
    expect(restored.result.current.notifications).toEqual([]);
    act(() => restored.result.current.unmuteSession(identity));
    expect(restored.result.current.mutedSessions).toEqual([]);
    expect(restored.result.current.notifications).toEqual([]);
    expect(localStorage.getItem(muteKey(identity))).toBeNull();
    restored.rerender({ ...live, snapshot: reports(1, 2, 3) });
    expect(restored.result.current.notifications).toMatchObject([{ id: "message:report-3" }]);
  });

  it("keeps a renamed session muted and retires the mute when its native identity is replaced", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    localStorage.setItem(muteKey(identity), "1");
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: live });
    const renamed = { ...worker, name: "renamed", customTitle: "Renamed task", agentState: "waiting_human" as const,
      agentStateChangedAt: 11 };
    rerender({ ...live, sessions: [renamed] });
    expect(result.current.mutedSessions).toEqual([{ identity, sessionName: "renamed", title: "Renamed task" }]);
    expect(result.current.notifications).toEqual([]);
    const replacement = { ...renamed, created: 2, agentState: "working" as const, agentStateChangedAt: 12 };
    rerender({ ...live, sessions: [replacement] });
    expect(result.current.mutedSessions).toEqual([]);
    expect(localStorage.getItem(muteKey(identity))).toBeNull();
    expect(result.current.notifications).toEqual([]);
    rerender({ ...live, sessions: [{ ...replacement, agentState: "waiting_human", agentStateChangedAt: 13 }] });
    expect(result.current.notifications).toMatchObject([{ kind: "ready", sessionIdentity: sessionReadyIdentity(replacement) }]);
  });

  it("removes closed sessions only after a confirmed inventory, preserving unrelated preferences", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    localStorage.setItem(muteKey(identity), "1");
    localStorage.setItem("unrelated-preference", "keep");
    const pending: typeof base = { ...base, sessionsLoaded: false };
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: pending });
    expect(localStorage.getItem(muteKey(identity))).toBe("1");
    rerender(live);
    expect(result.current.mutedSessions).toHaveLength(1);
    rerender(base);
    expect(result.current.mutedSessions).toEqual([]);
    expect(result.current.notifications).toEqual([]);
    expect(localStorage.getItem(muteKey(identity))).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
    act(() => result.current.muteSession(identity));
    expect(localStorage.getItem(muteKey(identity))).toBeNull();

    localStorage.setItem(muteKey(identity), "1");
    const empty = renderHook(useCallbackNotifications, { initialProps: base });
    expect(empty.result.current.mutedSessions).toEqual([]);
    expect(localStorage.getItem(muteKey(identity))).toBeNull();
  });

  it("shares independent concurrent session mutes, re-enabling, and missed updates between workspace tabs", () => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    const other = { ...worker, name: "other", id: "$2" };
    const otherIdentity = sessionReadyIdentity(other);
    const input: typeof base = { ...live, sessions: [worker, other] };
    const first = renderHook(useCallbackNotifications, { initialProps: input });
    const second = renderHook(useCallbackNotifications, { initialProps: { ...input, workspaceKey: "two" } });
    first.rerender({ ...input, snapshot: reports(1) });
    second.rerender({ ...input, workspaceKey: "two", snapshot: reports(1) });
    act(() => first.result.current.muteSession(identity));
    act(() => second.result.current.muteSession(otherIdentity));
    const key = muteKey(identity);
    expect(localStorage.getItem(key)).toBe("1");
    expect(localStorage.getItem(muteKey(otherIdentity))).toBe("1");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "1" })));
    expect(first.result.current.mutedSessions).toHaveLength(2);
    expect(second.result.current.mutedSessions).toHaveLength(2);
    expect(second.result.current.notifications).toEqual([]);
    act(() => first.result.current.unmuteSession(identity));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: "0", oldValue: "1" })));
    expect(second.result.current.mutedSessions.map((session) => session.identity)).toEqual([otherIdentity]);
    second.rerender({ ...input, workspaceKey: "two", snapshot: reports(1, 2) });
    expect(second.result.current.notifications).toMatchObject([{ id: "message:report-2" }]);
    act(() => {
      localStorage.setItem(key, "1");
      window.dispatchEvent(new Event("focus"));
    });
    expect(second.result.current.mutedSessions).toHaveLength(2);
    expect(second.result.current.notifications).toEqual([]);
  });

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

  it.each([
    { action: "closed-session cleanup", newValue: null, expectEnding: false },
    { action: "explicit re-enabling", newValue: "0", expectEnding: true },
  ])("distinguishes $action before another workspace receives the ended inventory", ({ newValue, expectEnding }) => {
    localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, "all");
    localStorage.setItem(muteKey(identity), "1");
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: live });
    act(() => {
      localStorage.removeItem(muteKey(identity));
      window.dispatchEvent(new StorageEvent("storage", { key: muteKey(identity), oldValue: "1", newValue }));
    });
    expect(result.current.mutedSessions).toEqual([]);
    rerender(base);
    expect(result.current.notifications).toEqual(expectEnding
      ? [expect.objectContaining({ kind: "ended", sessionIdentity: identity })] : []);
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
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    const { result, rerender } = renderHook(useCallbackNotifications, { initialProps: live });
    act(() => result.current.setScope("all"));
    rerender({ ...live, snapshot: reports(1) });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.scope).toBe("all");
    act(() => result.current.muteSession(identity));
    rerender({ ...live, snapshot: reports(1, 2) });
    expect(result.current.notifications).toEqual([]);
    act(() => result.current.unmuteSession(identity));
    rerender({ ...live, snapshot: reports(1, 2, 3) });
    expect(result.current.notifications).toMatchObject([{ id: "message:report-3" }]);
    read.mockRestore(); write.mockRestore(); remove.mockRestore();
  });
});
