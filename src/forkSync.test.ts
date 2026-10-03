import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForkSyncPeer,
  forkSyncGroupFromSearch,
  independentForkHref,
  isForkSyncSnapshot,
  readForkSyncSnapshot,
  searchWithForkSyncGroup,
  type ForkSyncSelection,
  type ForkSyncSnapshot,
  type ForkSyncTransport,
} from "./forkSync";

const session = (sessionName: string): ForkSyncSelection => ({
  workspaceId: "work", tabs: ["alpha", "beta", "gamma"], view: { kind: "session", sessionName },
});

const panel: ForkSyncSelection = {
  workspaceId: null, tabs: ["alpha", "beta"],
  view: {
    kind: "panes", activePaneId: "right",
    layout: {
      id: "pair", name: "Pair", root: {
        id: "split", kind: "split", direction: "horizontal", ratio: 0.5,
        first: { id: "left", kind: "pane", session: "alpha" },
        second: { id: "right", kind: "pane", session: "beta" },
      },
    },
  },
};

class TabTransport implements ForkSyncTransport {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn(() => { this.closed = true; });
  closed = false;
  constructor(readonly group: string, private bus: TabBus) {}
  postMessage = vi.fn((message: unknown) => {
    for (const other of this.bus.tabs) {
      if (other !== this && other.group === this.group && !other.closed) {
        this.bus.queue.push(() => other.onmessage?.({ data: structuredClone(message) } as MessageEvent));
      }
    }
  });
}

class TabBus {
  tabs: TabTransport[] = [];
  queue: Array<() => void> = [];
  channel(group = "linked"): TabTransport {
    const transport = new TabTransport(group, this);
    this.tabs.push(transport);
    return transport;
  }
  flush(): void {
    let deliveries = 0;
    while (this.queue.length) {
      if (++deliveries > 100) throw new Error("Selection messages are looping");
      this.queue.shift()!();
    }
  }
}

beforeEach(() => localStorage.clear());

describe("Fork-sync peers", () => {
  it("shares selections in both directions without echoing a received selection", () => {
    const bus = new TabBus();
    const leftChanged = vi.fn();
    const rightChanged = vi.fn();
    const leftChannel = bus.channel();
    const rightChannel = bus.channel();
    const left = new ForkSyncPeer("linked", "left", leftChannel, localStorage, leftChanged);
    const right = new ForkSyncPeer("linked", "right", rightChannel, localStorage, rightChanged);
    left.select(session("alpha"));
    bus.flush();
    expect(rightChanged).toHaveBeenLastCalledWith(session("alpha"));
    const calls = rightChannel.postMessage.mock.calls.length;
    right.select(session("alpha"));
    expect(rightChannel.postMessage).toHaveBeenCalledTimes(calls);
    right.select(session("beta"));
    bus.flush();
    expect(leftChanged).toHaveBeenLastCalledWith(session("beta"));
    expect(left.snapshot?.selection).toEqual(right.snapshot?.selection);
  });

  it("converges on simultaneous selections and rejects delayed older messages", () => {
    const bus = new TabBus();
    const left = new ForkSyncPeer("linked", "a", bus.channel(), null, vi.fn());
    const right = new ForkSyncPeer("linked", "z", bus.channel(), null, vi.fn());
    left.select(session("alpha"));
    const stale = left.snapshot;
    right.select(session("beta"));
    bus.flush();
    expect(left.snapshot).toEqual(right.snapshot);
    expect(left.snapshot?.selection.view).toEqual(session("beta").view);
    left.select(session("gamma"));
    bus.flush();
    bus.tabs[0].onmessage?.({ data: { type: "selection", snapshot: stale } } as MessageEvent);
    expect(left.snapshot?.sequence).toBe(2);
    expect(left.snapshot).toEqual(right.snapshot);
  });

  it("restores the latest selection from cache after all peers close", () => {
    const bus = new TabBus();
    const old = new ForkSyncPeer("linked", "old", bus.channel(), localStorage, vi.fn());
    old.select(session("alpha"));
    old.select(session("beta"));
    old.close();
    const changed = vi.fn();
    const reopened = new ForkSyncPeer("linked", "reopened", bus.channel(), localStorage, changed);
    reopened.connect();
    expect(changed).toHaveBeenCalledExactlyOnceWith(session("beta"));
    expect(reopened.snapshot?.selection).toEqual(session("beta"));
  });

  it("bootstraps from a live peer when storage is unavailable and isolates other groups", () => {
    const bus = new TabBus();
    const changed = vi.fn();
    const unrelated = vi.fn();
    const source = new ForkSyncPeer("linked", "source", bus.channel(), null, vi.fn());
    source.select(session("beta"));
    const follower = new ForkSyncPeer("linked", "follower", bus.channel(), null, changed);
    new ForkSyncPeer("separate", "other", bus.channel("separate"), null, unrelated).connect();
    follower.connect();
    bus.flush();
    expect(changed).toHaveBeenLastCalledWith(session("beta"));
    expect(unrelated).not.toHaveBeenCalled();
  });

  it("shares a temporary panel definition and its selected pane", () => {
    const bus = new TabBus();
    const changed = vi.fn();
    const source = new ForkSyncPeer("linked", "source", bus.channel(), null, vi.fn());
    const follower = new ForkSyncPeer("linked", "follower", bus.channel(), null, changed);
    source.select(panel);
    bus.flush();
    expect(changed).toHaveBeenLastCalledWith(panel);
    expect(follower.snapshot?.selection).toEqual(panel);
  });

  it("leaves saved panel contents to the server stream while sharing pane selection", () => {
    const bus = new TabBus();
    const channel = bus.channel();
    const peer = new ForkSyncPeer("linked", "source", channel, null, vi.fn());
    const saved = { ...panel, workspaceId: "work" };
    peer.select(saved);
    if (saved.view.kind !== "panes") throw new Error("Expected a panel fixture");
    const renamed = { ...saved, view: { ...saved.view, layout: { ...saved.view.layout, name: "Renamed" } } };
    peer.select(renamed);
    expect(channel.postMessage).toHaveBeenCalledOnce();
    peer.select({ ...renamed, view: { ...renamed.view, activePaneId: "left" } });
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
  });

  it("closes once and stops sending or receiving after unlink", () => {
    const bus = new TabBus();
    const channel = bus.channel();
    const changed = vi.fn();
    const peer = new ForkSyncPeer("linked", "left", channel, null, changed);
    peer.close();
    peer.close();
    peer.select(session("alpha"));
    peer.requestSelection();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(channel.postMessage).not.toHaveBeenCalled();
    expect(channel.onmessage).toBeNull();
  });
});

describe("Fork-sync URL and message validation", () => {
  const snapshot: ForkSyncSnapshot = { version: 1, sequence: 1, sender: "sender", updatedAt: Date.now(), selection: panel };

  it("preserves workspace parameters and removes the group from independent forks", () => {
    const search = searchWithForkSyncGroup("?workspace=work&tab=alpha&tab=beta", "pair");
    expect(forkSyncGroupFromSearch(search)).toBe("pair");
    expect(new URLSearchParams(search).getAll("tab")).toEqual(["alpha", "beta"]);
    expect(independentForkHref(`http://localhost/mux/panes/pair${search}`))
      .toBe("http://localhost/mux/panes/pair?workspace=work&tab=alpha&tab=beta");
    const ordinary = "http://localhost/mux/session/a?tab=a%20b";
    expect(independentForkHref(ordinary)).toBe(ordinary);
    expect(forkSyncGroupFromSearch("?fork-sync=../../other")).toBeNull();
  });

  it.each([
    null, { ...snapshot, version: 2 }, { ...snapshot, sequence: -1 },
    { ...snapshot, selection: { ...session("absent") } },
    { ...snapshot, selection: { ...panel, view: { ...panel.view, activePaneId: "absent" } } },
    { ...snapshot, selection: { ...panel, view: { kind: "panes", layout: { id: "bad", name: "Bad", root: {} }, activePaneId: null } } },
  ])("discards malformed or unsupported snapshots (%#)", (invalid) => {
    expect(isForkSyncSnapshot(invalid)).toBe(false);
  });

  it("accepts valid panels and ignores expired or malformed cache entries", () => {
    expect(isForkSyncSnapshot(snapshot)).toBe(true);
    localStorage.setItem("muxdeck-fork-sync:old", JSON.stringify({ ...snapshot, updatedAt: Date.now() - 25 * 60 * 60 * 1_000 }));
    localStorage.setItem("muxdeck-fork-sync:broken", "not json");
    expect(readForkSyncSnapshot("old", localStorage)).toBeNull();
    expect(readForkSyncSnapshot("broken", localStorage)).toBeNull();
  });
});
