import { describe, expect, it } from "vitest";
import type { AgentState, Session } from "./types";
import {
  checkSessionReadyAttention, mergeSessionReadyAttention, observeSessionReadyAttention,
  markSessionUnreadAttention,
  parseSessionReadyAttention, sessionReadyIdentity, sessionReadyIsUnchecked,
} from "./sessionReadyAttention";

function session(agentState: AgentState, agentStateChangedAt = 10, overrides: Partial<Session> = {}): Session {
  return {
    name: "alpha", id: "$1", created: 1, serverStarted: 2, serverPid: 3,
    windows: 1, attached: 0, activity: 1, activePaneId: "%1", agentState,
    agentStateChangedAt, agentStateReason: "fixture", customTitle: null, tags: [],
    starred: false, ignored: false, queuedMessageCount: 0, panes: [], ...overrides,
  };
}

function completed() {
  const working = observeSessionReadyAttention({}, [session("working")]);
  return observeSessionReadyAttention(working, [session("waiting_human", 20)]);
}

describe("unchecked ready events", () => {
  it.each<AgentState>(["working", "running_command", "waiting_human", "waiting_command", "unknown", "other"])(
    "manually marks a read %s session without changing its agent state", (state) => {
      const live = session(state);
      const observed = observeSessionReadyAttention({}, [live]);
      const marked = markSessionUnreadAttention(observed, live);
      expect(sessionReadyIsUnchecked(marked, live)).toBe(true);
      expect(marked[sessionReadyIdentity(live)].state).toBe(state);
      expect(marked[sessionReadyIdentity(live)].awaitingReady)
        .toBe(observed[sessionReadyIdentity(live)].awaitingReady);
      expect(markSessionUnreadAttention(marked, live)).toBe(marked);
      const restored = parseSessionReadyAttention(JSON.stringify(marked));
      expect(sessionReadyIsUnchecked(restored, live)).toBe(true);
      expect(sessionReadyIsUnchecked(checkSessionReadyAttention(restored, live), live)).toBe(false);
    },
  );

  it("a manual mark survives an older acknowledgement without resurrecting a subsequently read mark", () => {
    const live = session("waiting_human", 20);
    const checked = checkSessionReadyAttention(completed(), live);
    const marked = markSessionUnreadAttention(checked, live);
    const merged = mergeSessionReadyAttention(marked, checked);
    expect(sessionReadyIsUnchecked(merged, live)).toBe(true);
    expect(mergeSessionReadyAttention(checked, marked)).toEqual(merged);
    const readAgain = checkSessionReadyAttention(marked, live);
    expect(sessionReadyIsUnchecked(mergeSessionReadyAttention(readAgain, marked), live)).toBe(false);
  });

  it("a manual mark while working preserves the next automatic completion event", () => {
    const working = session("working");
    const marked = markSessionUnreadAttention({}, working);
    const checked = checkSessionReadyAttention(marked, working);
    const ready = session("waiting_human", 20);
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(checked, [ready]), ready)).toBe(true);
  });

  it.each<AgentState>(["working", "running_command"])("marks %s becoming ready once", (state) => {
    const busy = observeSessionReadyAttention({}, [session(state)]);
    const ready = session("waiting_human", 20);
    const attention = observeSessionReadyAttention(busy, [ready]);
    expect(sessionReadyIsUnchecked(attention, ready)).toBe(true);
    expect(observeSessionReadyAttention(attention, [ready])).toBe(attention);
    expect(sessionReadyIsUnchecked(checkSessionReadyAttention(attention, ready), ready)).toBe(false);
  });

  it.each<AgentState>(["waiting_human", "waiting_command", "unknown", "other"])(
    "does not invent a work episode from an initial %s session", (state) => {
      const initial = observeSessionReadyAttention({}, [session(state)]);
      const ready = session("waiting_human", 20);
      expect(sessionReadyIsUnchecked(observeSessionReadyAttention(initial, [ready]), ready)).toBe(false);
    },
  );

  it("a visit while working does not acknowledge the next ready event", () => {
    const working = session("working");
    const checked = checkSessionReadyAttention(observeSessionReadyAttention({}, [working]), working);
    const ready = session("waiting_human", 20);
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(checked, [ready]), ready)).toBe(true);
  });

  it("requires another visit after each cycle even when transitions share a second", () => {
    const ready = session("waiting_human");
    const first = observeSessionReadyAttention(observeSessionReadyAttention({}, [session("working")]), [ready]);
    const checked = checkSessionReadyAttention(first, ready);
    const second = observeSessionReadyAttention(observeSessionReadyAttention(checked, [session("running_command")]), [ready]);
    expect(second[sessionReadyIdentity(ready)].latestReadyEvent).toBeGreaterThan(first[sessionReadyIdentity(ready)].latestReadyEvent);
    expect(sessionReadyIsUnchecked(second, ready)).toBe(true);
  });

  it.each<AgentState>(["unknown", "waiting_command"])("retains observed work through a temporary %s signal", (state) => {
    const working = observeSessionReadyAttention({}, [session("working")]);
    const transient = observeSessionReadyAttention(working, [session(state, 15)]);
    expect(sessionReadyIsUnchecked(transient, session(state, 15))).toBe(false);
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(transient, [session("waiting_human", 20)]), session("waiting_human", 20))).toBe(true);
  });

  it("does not treat an agent exiting to an ordinary shell as a ready event", () => {
    const working = observeSessionReadyAttention({}, [session("working")]);
    const shell = observeSessionReadyAttention(working, [session("other", 15)]);
    const ready = session("waiting_human", 20);
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(shell, [ready]), ready)).toBe(false);
  });

  it("keeps an earlier unchecked result when another work episode starts", () => {
    const working = session("working", 30);
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(completed(), [working]), working)).toBe(true);
  });

  it("follows a native rename without treating the new name as a new identity", () => {
    const renamed = session("waiting_human", 20, { name: "renamed" });
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(completed(), [renamed]), renamed)).toBe(true);
  });

  it.each<keyof Pick<Session, "id" | "created" | "serverStarted" | "serverPid">>([
    "id", "created", "serverStarted", "serverPid",
  ])("does not transfer attention to a reused name with a different %s", (part) => {
    const recreated = session("waiting_human", 30, { [part]: part === "id" ? "$2" : 50 });
    expect(sessionReadyIsUnchecked(observeSessionReadyAttention(completed(), [recreated]), recreated)).toBe(false);
  });

  it("ignores stale inventory replies after a newer ready observation", () => {
    const ready = completed();
    expect(observeSessionReadyAttention(ready, [session("working", 10)])).toBe(ready);
  });

  it("retains pending work and unchecked events through reload's empty initial inventory", () => {
    const working = observeSessionReadyAttention({}, [session("working")]);
    const restored = parseSessionReadyAttention(JSON.stringify(working));
    expect(observeSessionReadyAttention(restored, [])).toBe(restored);
    const ready = session("waiting_human", 20);
    const attention = observeSessionReadyAttention(restored, [ready]);
    expect(sessionReadyIsUnchecked(parseSessionReadyAttention(JSON.stringify(attention)), ready)).toBe(true);
  });

  it("an acknowledgement from another page cannot hide a newer ready event", () => {
    const older = checkSessionReadyAttention(completed(), session("waiting_human", 20));
    const newer = observeSessionReadyAttention(observeSessionReadyAttention(older, [session("working", 30)]), [session("waiting_human", 40)]);
    const merged = mergeSessionReadyAttention(newer, older);
    expect(sessionReadyIsUnchecked(merged, session("waiting_human", 40))).toBe(true);
    expect(mergeSessionReadyAttention(older, newer)).toEqual(merged);
  });

  it("accepts valid stored records while ignoring malformed entries and impossible checks", () => {
    const valid = completed();
    const invalidIdentity = sessionReadyIdentity(session("waiting_human", 20, { id: "$invalid" }));
    expect(parseSessionReadyAttention(JSON.stringify({
      broken: {}, ...valid, [invalidIdentity]: { ...valid[sessionReadyIdentity(session("working"))], lastCheckedEvent: 999 },
    }))).toEqual(valid);
    for (const raw of [null, "broken", "[]", "null"]) expect(parseSessionReadyAttention(raw)).toEqual({});
  });
});
