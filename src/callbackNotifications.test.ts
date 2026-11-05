import { describe, expect, it } from "vitest";
import type { CallbackMessage, GlobalCallbackSnapshot } from "./api";
import type { Session } from "./types";
import {
  initialCallbackNotificationObservation,
  observeCallbackNotifications,
  parseCallbackNotificationScope,
  type CallbackNotificationInput,
  type CallbackNotificationScope,
} from "./callbackNotifications";

function session(name = "worker", agentState: Session["agentState"] = "working", changedAt = 10): Session {
  return {
    name, agentState, agentStateChangedAt: changedAt, id: `$${name}`, created: 1,
    serverStarted: 1, serverPid: 1, windows: 1, attached: 0, activity: 1, activePaneId: null,
    agentStateReason: "fixture", customTitle: null, tags: [], starred: false, ignored: false,
    queuedMessageCount: 0, panes: [],
  };
}
function message(sequence: number, sessionName = "worker", overrides: Partial<CallbackMessage> = {}): CallbackMessage {
  return {
    id: `report-${sequence}`, sequence, sessionName, message: "The work is complete.", agentType: "codex",
    cwd: "/tmp", requestId: null, tmuxSessionId: null, tmuxPaneId: null, host: null,
    createdAt: sequence, reviewedAt: null, ...overrides,
  };
}
function input(overrides: Partial<CallbackNotificationInput> = {}): CallbackNotificationInput {
  return {
    sessions: [session()], scope: "all", callbacksLoaded: true, workspaceSessionNames: ["worker"],
    workspaceCallbackSessions: [], workspaceName: "Launch room",
    snapshot: { callbackSessions: [], globalCallbackSessions: [], workspaceCallbacks: [], sessionRevision: 0 },
    ...overrides,
  };
}
function watch() {
  let state = initialCallbackNotificationObservation();
  return (next: CallbackNotificationInput) => {
    const result = observeCallbackNotifications(state, next);
    state = result.observation;
    return result.notifications;
  };
}

describe("callback notification events", () => {
  it("keeps initial history silent and never replays on enable, scope changes, review, or reconnect", () => {
    const observe = watch();
    const snapshot: GlobalCallbackSnapshot = { ...input().snapshot, callbackMessages: [message(1)] };
    expect(observe(input({ sessions: [], callbacksLoaded: false }))).toEqual([]);
    expect(observe(input({ scope: "off", snapshot }))).toEqual([]);
    const finished = [session("worker", "waiting_human", 11)];
    expect(observe(input({ scope: "off", sessions: finished, snapshot }))).toEqual([]);
    for (const scope of ["watched", "workspace", "all"] as const) {
      expect(observe(input({ scope, sessions: finished, snapshot }))).toEqual([]);
    }
    const newer = { ...snapshot, callbackMessages: [message(1), message(2)] };
    expect(observe(input({ sessions: finished, snapshot: newer }))).toMatchObject([{ id: "message:report-2" }]);
    expect(observe(input({ sessions: finished, snapshot: newer }))).toEqual([]);
    expect(observe(input({ sessions: finished, snapshot: { ...snapshot, callbackMessages: [] } }))).toEqual([]);
    expect(observe(input({ sessions: finished, snapshot }))).toEqual([]);
  });

  it.each<CallbackNotificationScope>(["off", "watched", "workspace", "all"])("selects events for the %s scope", (scope) => {
    const observe = watch();
    const names = ["local", "watched", "unwatched", "temporary"];
    const snapshot = {
      ...input().snapshot,
      callbackSessions: ["watched"],
      workspaceCallbacks: [{ workspaceId: "other", workspaceName: "Other room", sessions: ["watched"] }],
    };
    const context = { scope, snapshot, workspaceSessionNames: ["local"], workspaceCallbackSessions: ["temporary"] };
    observe(input({ ...context, sessions: names.map((name) => session(name)) }));
    const events = observe(input({ ...context, sessions: names.map((name) => session(name, "waiting_human", 11)) }));
    const expected = { off: [], watched: ["watched", "temporary"], workspace: ["local", "temporary"], all: names };
    expect(events.map((event) => event.sessionName)).toEqual(expected[scope]);
    if (scope === "all") expect(events.find((event) => event.sessionName === "watched")?.workspace).toBe("Other room");
  });

  it("notifies about new reports from unwatched or ended sessions and coalesces their latest report with readiness", () => {
    const observe = watch();
    observe(input({ scope: "watched" }));
    const events = observe(input({
      scope: "watched", sessions: [session("worker", "waiting_human", 11)],
      snapshot: { ...input().snapshot, callbackMessages: [message(1), message(2), message(3, "ended")] },
    }));
    expect(events).toMatchObject([
      { sessionName: "worker", kind: "message", id: "message:report-2" },
      { sessionName: "ended", kind: "message", id: "message:report-3" },
    ]);
  });

  it("arms through uncertain states, ignores stale state updates, and reports running commands returning to a shell", () => {
    const observe = watch();
    observe(input());
    expect(observe(input({ sessions: [session("worker", "unknown", 11)] }))).toEqual([]);
    expect(observe(input({ sessions: [session("worker", "waiting_command", 12)] }))).toEqual([]);
    expect(observe(input({ sessions: [session("worker", "waiting_human", 13)] }))).toMatchObject([{ kind: "ready" }]);
    expect(observe(input({ sessions: [session("worker", "working", 10)] }))).toEqual([]);
    expect(observe(input({ sessions: [session("worker", "waiting_human", 13)] }))).toEqual([]);
    observe(input({ sessions: [session("worker", "running_command", 14)] }));
    expect(observe(input({ sessions: [session("worker", "other", 15)] }))).toMatchObject([{ label: "Finished working" }]);
  });

  it("identifies ended native sessions without treating a rename as an ending or confusing a reused name", () => {
    const observe = watch();
    const original = { ...session(), customTitle: "Original task" };
    observe(input({ sessions: [original] }));
    const renamed = { ...original, name: "renamed" };
    expect(observe(input({ sessions: [renamed] }))).toEqual([]);
    const replacement = { ...renamed, id: "$replacement", customTitle: "Replacement" };
    expect(observe(input({ sessions: [replacement] }))).toMatchObject([
      { kind: "ended", sessionName: "renamed", title: "Original task" },
    ]);
    const events = observe(input({ sessions: [replacement], snapshot: {
      ...input().snapshot, callbackMessages: [message(1, "renamed", { tmuxSessionId: original.id })],
    } }));
    expect(events).toMatchObject([{ title: "renamed", kind: "message" }]);
    expect(observe(input({ sessions: [] }))).toMatchObject([{ kind: "ended", title: "Replacement" }]);
    expect(observe(input({ sessions: [] }))).toEqual([]);
  });

  it("gives rapid command completions distinct notices even within the same timestamp", () => {
    const observe = watch();
    observe(input({ sessions: [session("worker", "running_command", 10)] }));
    const first = observe(input({ sessions: [session("worker", "other", 11)] }));
    observe(input({ sessions: [session("worker", "running_command", 11)] }));
    const second = observe(input({ sessions: [session("worker", "other", 11)] }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first[0].id);
  });

  it("identifies the same readiness event across tabs with different scopes and completion histories", () => {
    const global = watch();
    const local = watch();
    const context = { workspaceSessionNames: ["worker"], workspaceCallbackSessions: [] };
    global(input({ ...context, sessions: [session("worker"), session("other")] }));
    local(input({ ...context, scope: "workspace", sessions: [session("worker"), session("other")] }));
    global(input({ ...context, sessions: [session("worker"), session("other", "waiting_human", 11)] }));
    local(input({ ...context, scope: "workspace", sessions: [session("worker"), session("other", "waiting_human", 11)] }));
    const finished = { ...session("worker", "waiting_human", 12), readyAttention: { latestReadyEvent: 3, lastCheckedEvent: 0 } };
    const first = global(input({ ...context, sessions: [finished, session("other", "waiting_human", 11)] }));
    const second = local(input({ ...context, scope: "workspace", sessions: [finished, session("other", "waiting_human", 11)] }));
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toContain("event:3");
  });

  it("suppresses held entries without replaying them when resumed", () => {
    const observe = watch();
    observe(input());
    const snapshot = { ...input().snapshot, onHoldSessions: ["worker"], callbackMessages: [message(1)] };
    expect(observe(input({ sessions: [session("worker", "waiting_human", 11)], snapshot }))).toEqual([]);
    expect(observe(input({ sessions: [session("worker", "waiting_human", 11)], snapshot: { ...snapshot, onHoldSessions: [] } }))).toEqual([]);
    expect(observe(input({ sessions: [], snapshot }))).toEqual([]);
  });

  it("defaults unknown preferences to Off", () => {
    for (const value of [null, "global", "", {}, false]) expect(parseCallbackNotificationScope(value)).toBe("off");
  });
});
