import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./types";
import { SESSION_READY_ATTENTION_STORAGE_KEY, checkSessionReadyAttention, parseSessionReadyAttention } from "./sessionReadyAttention";
import { useSessionReadyAttention } from "./useSessionReadyAttention";
import { updateSessionAttention } from "./api";

vi.mock("./api", () => ({ updateSessionAttention: vi.fn() }));

const working: Session = {
  name: "alpha", id: "$1", created: 1, serverStarted: 2, serverPid: 3,
  windows: 1, attached: 0, activity: 1, activePaneId: "%1", agentState: "working",
  agentStateChangedAt: 10, agentStateReason: "fixture", customTitle: null, tags: [],
  starred: false, ignored: false, queuedMessageCount: 0, panes: [],
};
const ready: Session = { ...working, agentState: "waiting_human", agentStateChangedAt: 20 };

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(updateSessionAttention).mockReset();
});
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

const shared = (latestReadyEvent: number, lastCheckedEvent: number): Session => ({
  ...ready, readyAttention: { latestReadyEvent, lastCheckedEvent },
});

describe("shared ready attention", () => {
  it("uses shared acknowledgements instead of another laptop's stale local unread history", () => {
    const local = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [working] },
    });
    local.rerender({ sessions: [ready] });
    expect(local.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    local.unmount();
    const authoritative = renderHook(() => useSessionReadyAttention([shared(3, 3)]));
    expect(authoritative.result.current.uncheckedReadySessions.size).toBe(0);
    expect(updateSessionAttention).not.toHaveBeenCalled();
  });

  it("receives both read and unread changes through session snapshots without a local storage event", () => {
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [shared(1, 0)] },
    });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    hook.rerender({ sessions: [shared(1, 1)] });
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    hook.rerender({ sessions: [shared(2, 1)] });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    hook.rerender({ sessions: [shared(1, 0)] });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
  });

  it("keeps a newer completion unread when an older read request completes late", async () => {
    let finish!: (value: { latestReadyEvent: number; lastCheckedEvent: number }) => void;
    vi.mocked(updateSessionAttention).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [shared(1, 0)] },
    });
    act(() => hook.result.current.checkSessionReady("alpha"));
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    await waitFor(() => expect(updateSessionAttention).toHaveBeenCalledWith(shared(1, 0), "read", 1));
    hook.rerender({ sessions: [shared(2, 0)] });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    await act(async () => finish({ latestReadyEvent: 2, lastCheckedEvent: 1 }));
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
  });

  it("retains a successful check when an older inventory response arrives afterwards", async () => {
    vi.mocked(updateSessionAttention).mockResolvedValue({ latestReadyEvent: 1, lastCheckedEvent: 1 });
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [shared(1, 0)] },
    });
    await act(async () => hook.result.current.checkSessionReady("alpha"));
    hook.rerender({ sessions: [shared(1, 0)] });
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    hook.rerender({ sessions: [shared(2, 1)] });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
  });

  it("serializes a manual mark followed immediately by a visit and acknowledges its own mark", async () => {
    let finish!: (value: { latestReadyEvent: number; lastCheckedEvent: number }) => void;
    vi.mocked(updateSessionAttention)
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ latestReadyEvent: 1, lastCheckedEvent: 1 });
    const live = shared(0, 0);
    const hook = renderHook(() => useSessionReadyAttention([live]));
    act(() => hook.result.current.markSessionUnread("alpha"));
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    act(() => hook.result.current.checkSessionReady("alpha"));
    await waitFor(() => expect(updateSessionAttention).toHaveBeenCalledTimes(1));
    await act(async () => finish({ latestReadyEvent: 1, lastCheckedEvent: 0 }));
    expect(updateSessionAttention).toHaveBeenNthCalledWith(2, live, "read", 1);
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
  });

  it.each(["read", "unread"] as const)("rolls back a failed %s write to shared state", async (action) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(updateSessionAttention).mockRejectedValue(new Error("offline"));
    const live = shared(1, action === "read" ? 0 : 1);
    const hook = renderHook(() => useSessionReadyAttention([live]));
    await act(async () => {
      if (action === "read") hook.result.current.checkSessionReady("alpha");
      else hook.result.current.markSessionUnread("alpha");
    });
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(action === "read");
  });

  it("keeps a new manual unread intent when an earlier read is still pending", async () => {
    let finish!: (value: { latestReadyEvent: number; lastCheckedEvent: number }) => void;
    vi.mocked(updateSessionAttention)
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ latestReadyEvent: 2, lastCheckedEvent: 1 });
    const live = shared(1, 0);
    const hook = renderHook(() => useSessionReadyAttention([live]));
    act(() => hook.result.current.checkSessionReady("alpha"));
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    act(() => hook.result.current.markSessionUnread("alpha"));
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
    await waitFor(() => expect(updateSessionAttention).toHaveBeenCalledTimes(1));
    await act(async () => finish({ latestReadyEvent: 1, lastCheckedEvent: 1 }));
    expect(updateSessionAttention).toHaveBeenNthCalledWith(2, live, "unread", 1);
    expect(hook.result.current.uncheckedReadySessions.has("alpha")).toBe(true);
  });

  it("follows shared state across rename and isolates a recreated session", () => {
    const hook = renderHook(({ sessions }) => useSessionReadyAttention(sessions), {
      initialProps: { sessions: [shared(1, 0)] },
    });
    hook.rerender({ sessions: [{ ...shared(1, 1), name: "renamed" }] });
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
    hook.rerender({ sessions: [{ ...shared(0, 0), id: "$2" }] });
    expect(hook.result.current.uncheckedReadySessions.size).toBe(0);
  });
});
