import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeSharedEventStream } from "./sharedEventStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  close(): void {
    this.closed = true;
  }
}

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  private closed = false;

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of [...peers]) {
      if (peer === this || peer.closed) continue;
      peer.onmessage?.(new MessageEvent("message", { data }));
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

class FakeLockManager {
  private queues = new Map<string, Array<() => void>>();
  private active = new Set<string>();

  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const run = () => {
        if (options.signal?.aborted) {
          this.next(name);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        this.active.add(name);
        callback().then(resolve, reject).finally(() => {
          this.active.delete(name);
          this.next(name);
        });
      };

      if (!this.active.has(name)) {
        run();
        return;
      }

      const queue = this.queues.get(name) ?? [];
      const entry = () => run();
      queue.push(entry);
      this.queues.set(name, queue);
      options.signal?.addEventListener("abort", () => {
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        }
      }, { once: true });
    });
  }

  private next(name: string): void {
    const queue = this.queues.get(name);
    const nextEntry = queue?.shift();
    if (nextEntry) nextEntry();
  }
}

describe("subscribeSharedEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    FakeBroadcastChannel.channels.clear();
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares a single EventSource across tabs, replays latest snapshot, and fails over cleanly", async () => {
    const lockManager = new FakeLockManager();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: lockManager,
    });

    // Simulate Tab 1 (leader)
    const tab1Events: string[] = [];
    const tab1Statuses: string[] = [];
    const stopTab1 = subscribeSharedEventStream(
      "/mux/api/sessions/stream",
      "sessions",
      "failed",
      {
        onEvent: (data) => tab1Events.push(data),
        onStatus: (status) => tab1Statuses.push(status),
      },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const firstSource = FakeEventSource.instances[0]!;
    firstSource.onopen?.();
    firstSource.emit("sessions", '{"sessions":["alpha"]}');
    expect(tab1Events).toEqual(['{"sessions":["alpha"]}']);
    expect(tab1Statuses).toEqual(["connecting", "open"]);

    // Simulate a separate module instance / Tab 2 via a fresh import with resetModules
    vi.resetModules();
    const { subscribeSharedEventStream: subscribeTab2 } = await import("./sharedEventStream");
    const tab2Events: string[] = [];
    const tab2Statuses: string[] = [];
    const stopTab2 = subscribeTab2(
      "/mux/api/sessions/stream",
      "sessions",
      "failed",
      {
        onEvent: (data) => tab2Events.push(data),
        onStatus: (status) => tab2Statuses.push(status),
      },
    );

    // Tab 2 reuses Tab 1's single HTTP/1.1 EventSource and immediately gets the replay!
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(tab2Events).toEqual(['{"sessions":["alpha"]}']);
    expect(tab2Statuses).toEqual(["connecting", "open"]);

    // Live updates broadcast to both tabs over the single connection.
    firstSource.emit("sessions", '{"sessions":["alpha","beta"]}');
    expect(tab1Events).toHaveLength(2);
    expect(tab2Events).toEqual([
      '{"sessions":["alpha"]}',
      '{"sessions":["alpha","beta"]}',
    ]);

    // When Tab 1 closes, Tab 2 automatically acquires the Web Lock and opens a new EventSource.
    stopTab1();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSource.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);

    const secondSource = FakeEventSource.instances[1]!;
    secondSource.onopen?.();
    secondSource.emit("sessions", '{"sessions":["gamma"]}');
    expect(tab2Events.at(-1)).toBe('{"sessions":["gamma"]}');

    stopTab2();
    await Promise.resolve();
    expect(secondSource.closed).toBe(true);

    Reflect.deleteProperty(navigator, "locks");
  });
});
