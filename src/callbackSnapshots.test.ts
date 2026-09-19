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
});
