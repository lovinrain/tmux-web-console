import { describe, expect, it } from "vitest";
import type { CallbackMessage, GlobalCallbackSnapshot } from "./api";
import { mergeCallbackSnapshot } from "./callbackSnapshots";

const message: CallbackMessage = {
  id: "done-1", sequence: 1, message: "All checks passed.", sessionName: "agent",
  agentType: "codex", cwd: "/work/project", requestId: null, tmuxSessionId: "$7",
  tmuxPaneId: "%8", host: "host", createdAt: 1_800_000_000, reviewedAt: null,
};

function snapshot(overrides: Partial<GlobalCallbackSnapshot> = {}): GlobalCallbackSnapshot {
  return {
    callbackSessions: [], globalCallbackSessions: [], workspaceCallbacks: [],
    sessionRevision: 10, callbackMessageRevision: 0, callbackMessages: [], ...overrides,
  };
}

describe("mergeCallbackSnapshot", () => {
  it("accepts new messages from a response with older session membership", () => {
    const result = mergeCallbackSnapshot(
      snapshot({ globalCallbackSessions: ["manual"], callbackSessions: ["manual"] }),
      snapshot({ sessionRevision: 9, callbackMessageRevision: 1, callbackMessages: [message] }),
    );
    expect(result.sessionRevision).toBe(10);
    expect(result.callbackMessages).toEqual([message]);
    expect(result.callbackSessions).toEqual(["manual", "agent"]);
  });

  it("keeps reviewed messages removed when a stale fetch has newer session membership", () => {
    const result = mergeCallbackSnapshot(
      snapshot({ callbackMessageRevision: 2 }),
      snapshot({
        sessionRevision: 11, callbackMessageRevision: 1, callbackMessages: [message],
        callbackSessions: ["agent", "manual"], globalCallbackSessions: ["manual"],
      }),
    );
    expect(result.sessionRevision).toBe(11);
    expect(result.callbackMessageRevision).toBe(2);
    expect(result.callbackMessages).toEqual([]);
    expect(result.callbackSessions).toEqual(["manual"]);
  });

  it("deduplicates messages with manual and workspace markers without erasing those markers", () => {
    const current = snapshot({
      globalCallbackSessions: ["manual"],
      workspaceCallbacks: [{ workspaceId: "ws", workspaceName: "Main", sessions: ["agent"] }],
      callbackMessageRevision: 1, callbackMessages: [message, { ...message, id: "done-2" }],
    });
    const added = mergeCallbackSnapshot(snapshot(), current);
    expect(added.callbackSessions).toEqual(["manual", "agent"]);
    const reviewed = mergeCallbackSnapshot(added, { ...current, callbackMessages: [], callbackMessageRevision: 2 });
    expect(reviewed.callbackSessions).toEqual(["manual", "agent"]);
  });

  it("preserves message state across responses from an older server", () => {
    const result = mergeCallbackSnapshot(snapshot({ callbackMessageRevision: 1, callbackMessages: [message] }), {
      callbackSessions: ["manual"], globalCallbackSessions: ["manual"], workspaceCallbacks: [], sessionRevision: 11,
    });
    expect(result.callbackMessageRevision).toBe(1);
    expect(result.callbackSessions).toEqual(["manual", "agent"]);
  });

  it("accepts a newer receipt despite older session membership", () => {
    const result = mergeCallbackSnapshot(
      snapshot({
        globalCallbackSessions: ["manual"], callbackSessions: ["manual"],
        latestCallbackAtBySession: { manual: 100 },
      }),
      snapshot({
        sessionRevision: 9, callbackMessageRevision: 1, callbackMessages: [message],
        latestCallbackAtBySession: { manual: 200, agent: message.createdAt },
      }),
    );
    expect(result.callbackSessions).toEqual(["manual", "agent"]);
    expect(result.latestCallbackAtBySession).toEqual({ manual: 200, agent: message.createdAt });
  });

  it("does not regress receipt times when a stale message response updates membership", () => {
    const result = mergeCallbackSnapshot(
      snapshot({
        callbackMessageRevision: 2, globalCallbackSessions: ["manual"],
        callbackSessions: ["manual"], latestCallbackAtBySession: { manual: 200 },
      }),
      snapshot({
        sessionRevision: 11, callbackMessageRevision: 1,
        globalCallbackSessions: ["manual", "new"], callbackSessions: ["manual", "new"],
        latestCallbackAtBySession: { manual: 100, new: 50 },
      }),
    );
    expect(result.callbackMessageRevision).toBe(2);
    expect(result.callbackSessions).toEqual(["manual", "new"]);
    expect(result.latestCallbackAtBySession).toEqual({ manual: 200, new: 50 });
  });

  it("preserves reviewed receipt history when an older server omits the timestamp map", () => {
    const result = mergeCallbackSnapshot(
      snapshot({
        globalCallbackSessions: ["agent"], callbackSessions: ["agent"],
        callbackMessageRevision: 1, callbackMessages: [message],
        latestCallbackAtBySession: { agent: message.createdAt },
      }),
      snapshot({
        sessionRevision: 11, globalCallbackSessions: ["agent"], callbackSessions: ["agent"],
        callbackMessageRevision: 2,
      }),
    );
    expect(result.callbackMessages).toEqual([]);
    expect(result.latestCallbackAtBySession).toEqual({ agent: message.createdAt });
  });

  it("remembers legacy message receipts after review while a workspace still watches the session", () => {
    const watched = {
      workspaceCallbacks: [{ workspaceId: "ws", workspaceName: "Main", sessions: ["agent"] }],
      callbackSessions: ["agent"],
    };
    const received = mergeCallbackSnapshot(snapshot(watched), snapshot({
      ...watched, callbackMessageRevision: 1, callbackMessages: [message],
    }));
    const reviewed = mergeCallbackSnapshot(received, snapshot({
      ...watched, callbackMessageRevision: 2,
    }));
    expect(reviewed.callbackMessages).toEqual([]);
    expect(reviewed.latestCallbackAtBySession).toEqual({ agent: message.createdAt });
  });

  it("removes history for sessions outside the effective queue without resurrecting stale entries", () => {
    const result = mergeCallbackSnapshot(
      snapshot({
        sessionRevision: 11, callbackMessageRevision: 2,
        globalCallbackSessions: ["manual"], callbackSessions: ["manual"],
        latestCallbackAtBySession: { manual: 100, removed: 200 },
      }),
      snapshot({
        globalCallbackSessions: ["manual", "removed"], callbackSessions: ["manual", "removed", "agent"],
        callbackMessageRevision: 1, callbackMessages: [message],
        latestCallbackAtBySession: { removed: 200, agent: message.createdAt },
      }),
    );
    expect(result.callbackSessions).toEqual(["manual"]);
    expect(result.latestCallbackAtBySession).toEqual({ manual: 100 });
  });

  it("merges history even when neither response includes a message revision", () => {
    const legacy = {
      globalCallbackSessions: ["manual"], callbackSessions: ["manual"], workspaceCallbacks: [],
    };
    const result = mergeCallbackSnapshot({
      ...legacy, sessionRevision: 10, latestCallbackAtBySession: { manual: 200 },
    }, { ...legacy, sessionRevision: 11 });
    expect(result.sessionRevision).toBe(11);
    expect(result.latestCallbackAtBySession).toEqual({ manual: 200 });
  });

  it("handles object-property session names and ignores inherited timestamp entries", () => {
    const names = ["__proto__", "constructor", "toString", "inherited"];
    const incomingTimes = Object.create({ inherited: 999 }) as Record<string, number>;
    Object.defineProperty(incomingTimes, "__proto__", { value: 200, enumerable: true });
    const result = mergeCallbackSnapshot(
      snapshot({
        globalCallbackSessions: names, callbackSessions: names,
        latestCallbackAtBySession: Object.fromEntries([["__proto__", 100], ["constructor", 150]]),
      }),
      snapshot({ globalCallbackSessions: names, callbackSessions: names, latestCallbackAtBySession: incomingTimes }),
    );
    expect(result.latestCallbackAtBySession).toEqual({ ["__proto__"]: 200, constructor: 150 });
    expect(Object.hasOwn(result.latestCallbackAtBySession!, "inherited")).toBe(false);
    expect(Object.hasOwn(result.latestCallbackAtBySession!, "toString")).toBe(false);
    expect(Object.getPrototypeOf(result.latestCallbackAtBySession)).toBe(Object.prototype);
  });
});
