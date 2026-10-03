import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./types";
import { SESSION_READY_ATTENTION_STORAGE_KEY, checkSessionReadyAttention, parseSessionReadyAttention } from "./sessionReadyAttention";
import { useSessionReadyAttention } from "./useSessionReadyAttention";

const working: Session = {
  name: "alpha", id: "$1", created: 1, serverStarted: 2, serverPid: 3,
  windows: 1, attached: 0, activity: 1, activePaneId: "%1", agentState: "working",
  agentStateChangedAt: 10, agentStateReason: "fixture", customTitle: null, tags: [],
  starred: false, ignored: false, queuedMessageCount: 0, panes: [],
};
const ready: Session = { ...working, agentState: "waiting_human", agentStateChangedAt: 20 };

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("browser-local ready attention", () => {
  it("keeps a manual unread mark through inventory refresh and reload until an explicit visit", () => {
    const first = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [working] },
    });
    act(() => first.result.current.markSessionUnread("alpha"));
    first.rerender({ sessions: [{ ...working }] });
    expect(first.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    first.unmount();

    const reloaded = renderHook(() => useSessionReadyAttention([working]));
    expect(reloaded.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    act(() => reloaded.result.current.checkSessionReady("alpha"));
    expect(reloaded.result.current.uncheckedReadySessions.size).toBe(0);
    const stored = localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY);
    act(() => reloaded.result.current.markSessionUnread("missing"));
    expect(localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY)).toBe(stored);
  });

  it("restores unchecked events across reload and acknowledges only on an explicit visit", () => {
    const first = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [working] },
    });
    first.rerender({ sessions: [ready] });
    expect(first.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    first.unmount();

    const reloaded = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [] as Session[] },
    });
    reloaded.rerender({ sessions: [ready] });
    expect(reloaded.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    act(() => reloaded.result.current.checkSessionReady("alpha"));
    expect(reloaded.result.current.uncheckedReadySessions.size).toBe(0);
    reloaded.unmount();

    const checked = renderHook(() => useSessionReadyAttention([ready]));
    expect(checked.result.current.uncheckedReadySessions.size).toBe(0);
  });

  it("shares checks with other pages and repairs a stale storage write after a newer event", () => {
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [working] },
    });
    hook.rerender({ sessions: [ready] });
    const older = checkSessionReadyAttention(parseSessionReadyAttention(
      localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY),
    ), ready);
    const send = (raw: string) => act(() => {
      localStorage.setItem(SESSION_READY_ATTENTION_STORAGE_KEY, raw);
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_READY_ATTENTION_STORAGE_KEY, newValue: raw }));
    });
    send(JSON.stringify(older));
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    hook.rerender({ sessions: [{ ...working, agentStateChangedAt: 30 }] });
    const newerReady = { ...ready, agentStateChangedAt: 40 };
    hook.rerender({ sessions: [newerReady] });
    send(JSON.stringify(older));
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    hook.unmount();
    const reloaded = renderHook(() => useSessionReadyAttention([newerReady]));
    expect(reloaded.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
  });

  it("continues to track and check events when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [working] },
    });
    hook.rerender({ sessions: [ready] });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    act(() => hook.result.current.checkSessionReady("alpha"));
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    act(() => hook.result.current.markSessionUnread("alpha"));
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    act(() => hook.result.current.checkSessionReady("alpha"));
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
  });
});
