import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessions, subscribeToSessions, type RecoverableSession,
  type SessionInventorySnapshot, type SessionStreamOptions,
} from "./api";
import { subscribeToSessionInventory } from "./sessionInventory";
import type { Session } from "./types";

vi.mock("./api", () => ({ listSessions: vi.fn(), subscribeToSessions: vi.fn() }));
let stream: SessionStreamOptions;
let stopStream: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  stopStream = vi.fn();
  vi.mocked(subscribeToSessions).mockReset().mockImplementation((options) => {
    stream = options;
    return stopStream;
  });
});
afterEach(() => vi.useRealTimers());

const sessions = (name: string) => [{ name }] as Session[];
const inventory = (names: string[], revision: number, epoch = "server-one") => (
  Object.defineProperty(names.map((name) => ({ name })), "inventoryVersion", {
    value: { epoch, revision },
  }) as SessionInventorySnapshot
);

describe("shared inventory transport", () => {
  it.each(["snapshot", "error"])("ignores a late legacy HTTP %s after a stream frame", async (outcome) => {
    let resolve!: (value: Session[]) => void;
    let reject!: (error: Error) => void;
    vi.mocked(listSessions).mockReturnValue(new Promise((yes, no) => {
      resolve = yes; reject = no;
    }));
    const onSessions = vi.fn(), onError = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions, onError });
    stream.onSessions(sessions("new"));
    if (outcome === "snapshot") resolve(sessions("old"));
    else reject(new Error("late failure"));
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledOnce();
    expect(onSessions.mock.calls[0][0][0].name).toBe("new");
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(listSessions).toHaveBeenCalledOnce();
    stop();
  });

  it("shows a fresh Copy HTTP inventory after a cached stream replay", async () => {
    let finish!: (value: Session[]) => void;
    vi.mocked(listSessions).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions });
    const cached = inventory(["source"], 4);
    const created = inventory(["source", "source_1"], 5);
    stream.onSessions(cached);
    finish(created);
    await Promise.resolve();
    expect(onSessions.mock.calls.map(([value]) => value)).toEqual([cached, created]);
    stream.onSessions(cached);
    stream.onSessions(created);
    expect(onSessions).toHaveBeenCalledTimes(2);
    stop();
  });

  it.each([4, 5])("keeps streamed read markers when HTTP revision %i arrives late", async (revision) => {
    let finish!: (value: Session[]) => void;
    vi.mocked(listSessions).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions });
    const checked = inventory(["source"], 5);
    checked[0].readyAttention = { latestReadyEvent: 2, lastCheckedEvent: 2 };
    stream.onSessions(checked);
    finish(inventory(["source"], revision));
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledExactlyOnceWith(checked);
    const unread = inventory(["source"], 6);
    unread[0].readyAttention = { latestReadyEvent: 3, lastCheckedEvent: 2 };
    stream.onSessions(unread);
    expect(onSessions).toHaveBeenLastCalledWith(unread);
    stop();
  });

  it("ignores a cached stream older than the HTTP inventory already displayed", async () => {
    const current = inventory(["source", "source_1"], 5);
    vi.mocked(listSessions).mockResolvedValue(current);
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions });
    await Promise.resolve();
    stream.onSessions(inventory(["source"], 4));
    expect(onSessions).toHaveBeenCalledExactlyOnceWith(current);
    stop();
  });

  it("accepts a restarted stream epoch and rejects old in-flight HTTP", async () => {
    let finish!: (value: Session[]) => void;
    vi.mocked(listSessions).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions });
    stream.onSessions(inventory(["source"], 50));
    stream.onStatus?.("error");
    const restarted = inventory(["source", "source_1"], 1, "server-two");
    stream.onSessions(restarted);
    finish(inventory(["source"], 51));
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledTimes(2);
    expect(onSessions).toHaveBeenLastCalledWith(restarted);
    stop();
  });

  it("polls during a stream failure and stops when streaming resumes", async () => {
    const onMode = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions: vi.fn(), onMode });
    stream.onStatus?.("error");
    stream.onStatus?.("error");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listSessions).toHaveBeenCalledTimes(3);
    stream.onSessions(sessions("resumed"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(onMode.mock.calls.map(([mode]) => mode)).toEqual(["connecting", "polling", "live"]);
    stop();
  });

  it("keeps polling on unsupported browsers and rejects an older poll reply", async () => {
    vi.mocked(subscribeToSessions).mockImplementation(() => { throw new Error("unsupported"); });
    let finish!: (value: Session[]) => void;
    vi.mocked(listSessions)
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(sessions("new"));
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions, pollInterval: 4000 });
    await vi.advanceTimersByTimeAsync(4000);
    finish(sessions("old"));
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledOnce();
    expect(onSessions.mock.calls[0][0][0].name).toBe("new");
    stop();
  });

  it("retains recovery metadata on stream snapshots without changing the sessions array", async () => {
    const onSessions = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions });
    await Promise.resolve();
    const next = sessions("live");
    const recovery: RecoverableSession[] = [{
      id: "history", name: "ended", directory: "/tmp", agentType: null,
      agentSessionId: null, firstSeenAt: 1, lastSeenAt: 2, directoryAvailable: true,
    }];
    stream.onSessions(next, recovery);
    expect(onSessions).toHaveBeenLastCalledWith(next);
    expect((next as Session[] & { recoverableSessions: unknown }).recoverableSessions).toBe(recovery);
    expect(Object.keys(next)).toEqual(["0"]);
    stop();
  });

  it("closes the stream, aborts polling, and ignores callbacks after disposal", async () => {
    let finish!: (value: Session[]) => void;
    vi.mocked(listSessions).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onSessions = vi.fn(), onError = vi.fn();
    const stop = subscribeToSessionInventory({ onSessions, onError });
    const signal = vi.mocked(listSessions).mock.calls[0][0]!;
    stream.onStatus?.("error");
    stop();
    finish(sessions("late"));
    stream.onSessions(sessions("also late"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    expect(stopStream).toHaveBeenCalledOnce();
    expect(onSessions).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(listSessions).toHaveBeenCalledOnce();
  });
});
