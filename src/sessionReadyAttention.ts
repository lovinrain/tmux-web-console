import type { AgentState, Session } from "./types";

export const SESSION_READY_ATTENTION_STORAGE_KEY = `muxdeck.session-ready-attention.v1:${import.meta.env.BASE_URL}`;
const MAX_RETAINED_SESSIONS = 1024;
const AGENT_STATES = new Set<AgentState>([
  "working", "running_command", "waiting_human", "waiting_command", "unknown", "other",
]);

export interface SessionReadyAttention {
  state: AgentState;
  stateChangedAt: number;
  /** A work episode stays armed through temporary unknown/waiting signals. */
  awaitingReady: boolean;
  latestReadyEvent: number;
  lastCheckedEvent: number;
}

export type SessionReadyAttentionState = Readonly<Record<string, SessionReadyAttention>>;

export function sessionReadyIdentity(session: Session): string {
  return JSON.stringify([session.id, session.created, session.serverStarted, session.serverPid]);
}

function sameRecord(left: SessionReadyAttention, right: SessionReadyAttention): boolean {
  return left.state === right.state
    && left.stateChangedAt === right.stateChangedAt
    && left.awaitingReady === right.awaitingReady
    && left.latestReadyEvent === right.latestReadyEvent
    && left.lastCheckedEvent === right.lastCheckedEvent;
}

/** Event markers use the server observation time, advancing even within a second. */
export function observeSessionReadyAttention(
  current: SessionReadyAttentionState,
  sessions: readonly Session[],
): SessionReadyAttentionState {
  let next = current;
  for (const session of sessions) {
    const key = sessionReadyIdentity(session);
    const previous = next[key];
    const stateChangedAt = Number.isFinite(session.agentStateChangedAt)
      ? Math.max(0, Math.trunc(session.agentStateChangedAt)) : 0;
    // Concurrent inventory requests can finish in a different order.
    if (previous && stateChangedAt < previous.stateChangedAt) continue;
    const busy = session.agentState === "working" || session.agentState === "running_command";
    const ready = session.agentState === "waiting_human";
    const latestReadyEvent = ready && previous?.awaitingReady
      ? Math.max(previous.latestReadyEvent + 1, stateChangedAt)
      : previous?.latestReadyEvent ?? 0;
    const record: SessionReadyAttention = {
      state: session.agentState,
      stateChangedAt,
      awaitingReady: busy || (!ready && session.agentState !== "other" && Boolean(previous?.awaitingReady)),
      latestReadyEvent,
      lastCheckedEvent: previous?.lastCheckedEvent ?? 0,
    };
    if (!previous || !sameRecord(previous, record)) next = { ...next, [key]: record };
  }
  // Keep observations through the initial empty inventory on page reload, but
  // bound retained identities from ended/recreated sessions.
  const keys = Object.keys(next);
  if (keys.length > MAX_RETAINED_SESSIONS) {
    const live = new Set(sessions.map(sessionReadyIdentity));
    const retained = keys.sort((left, right) => (
      Number(live.has(right)) - Number(live.has(left))
      || next[right].stateChangedAt - next[left].stateChangedAt
    )).slice(0, Math.max(MAX_RETAINED_SESSIONS, live.size));
    next = Object.fromEntries(retained.map((key) => [key, next[key]]));
  }
  return next;
}

export function checkSessionReadyAttention(
  current: SessionReadyAttentionState,
  session: Session,
): SessionReadyAttentionState {
  const observed = observeSessionReadyAttention(current, [session]);
  const key = sessionReadyIdentity(session);
  const record = observed[key];
  if (record.lastCheckedEvent === record.latestReadyEvent) return observed;
  return { ...observed, [key]: { ...record, lastCheckedEvent: record.latestReadyEvent } };
}

export function sessionReadyIsUnchecked(current: SessionReadyAttentionState, session: Session): boolean {
  const record = current[sessionReadyIdentity(session)];
  return Boolean(record && record.latestReadyEvent > record.lastCheckedEvent);
}

/** A check from another page must never acknowledge a newer ready event. */
export function mergeSessionReadyAttention(
  current: SessionReadyAttentionState,
  incoming: SessionReadyAttentionState,
): SessionReadyAttentionState {
  let next = current;
  for (const [key, record] of Object.entries(incoming)) {
    const previous = next[key];
    const newer = previous && (previous.stateChangedAt > record.stateChangedAt
      || (previous.stateChangedAt === record.stateChangedAt && previous.latestReadyEvent > record.latestReadyEvent))
      ? previous : record;
    const merged = {
      ...newer,
      latestReadyEvent: Math.max(previous?.latestReadyEvent ?? 0, record.latestReadyEvent),
      lastCheckedEvent: Math.max(previous?.lastCheckedEvent ?? 0, record.lastCheckedEvent),
    };
    if (!previous || !sameRecord(previous, merged)) next = { ...next, [key]: merged };
  }
  return next;
}

export function parseSessionReadyAttention(raw: string | null): SessionReadyAttentionState {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, SessionReadyAttention> = {};
    for (const [key, candidate] of Object.entries(value).slice(0, MAX_RETAINED_SESSIONS)) {
      let identity: unknown;
      try { identity = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(identity) || identity.length !== 4 || typeof identity[0] !== "string"
        || !identity.slice(1).every((part) => Number.isSafeInteger(part) && part >= 0)) continue;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as SessionReadyAttention;
      if (!AGENT_STATES.has(record.state) || typeof record.awaitingReady !== "boolean"
        || ![record.stateChangedAt, record.latestReadyEvent, record.lastCheckedEvent]
          .every((part) => Number.isSafeInteger(part) && part >= 0)
        || record.lastCheckedEvent > record.latestReadyEvent) continue;
      result[key] = {
        state: record.state, stateChangedAt: record.stateChangedAt, awaitingReady: record.awaitingReady,
        latestReadyEvent: record.latestReadyEvent, lastCheckedEvent: record.lastCheckedEvent,
      };
    }
    return result;
  } catch {
    return {};
  }
}
