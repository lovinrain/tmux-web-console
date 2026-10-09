import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { updateSessionAttention } from "./api";
import type { Session, SessionAttention } from "./types";
import {
  SESSION_READY_ATTENTION_STORAGE_KEY,
  checkSessionReadyAttention,
  mergeSessionReadyAttention,
  markSessionUnreadAttention,
  observeSessionReadyAttention,
  parseSessionReadyAttention,
  sessionReadyIsUnchecked,
  sessionReadyIdentity,
  type SessionReadyAttentionState,
} from "./sessionReadyAttention";

interface PendingAttention {
  sequence: number;
  action: "read" | "unread";
  event: number;
}

interface AttentionWrite extends PendingAttention {
  promise: Promise<SessionAttention | undefined>;
}

function readAttention(): SessionReadyAttentionState {
  try {
    return parseSessionReadyAttention(window.localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function useSessionReadyAttention(sessions: readonly Session[]) {
  const [attention, setAttention] = useState(readAttention);
  const [sharedAttention, setSharedAttention] = useState<Record<string, SessionAttention>>({});
  const sharedAttentionRef = useRef(sharedAttention);
  const [pending, setPending] = useState<Record<string, PendingAttention>>({});
  const pendingRef = useRef(pending);
  const writes = useRef(new Map<string, AttentionWrite>());
  const sequence = useRef(0);
  const mounted = useRef(true);
  const attentionRef = useRef(attention);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const receiveShared = useCallback((key: string, incoming: SessionAttention) => {
    const previous = sharedAttentionRef.current[key];
    const merged = {
      latestReadyEvent: Math.max(previous?.latestReadyEvent ?? 0, incoming.latestReadyEvent),
      lastCheckedEvent: Math.max(previous?.lastCheckedEvent ?? 0, incoming.lastCheckedEvent),
    };
    if (previous?.latestReadyEvent === merged.latestReadyEvent
      && previous.lastCheckedEvent === merged.lastCheckedEvent) return;
    sharedAttentionRef.current = { ...sharedAttentionRef.current, [key]: merged };
    if (mounted.current) setSharedAttention(sharedAttentionRef.current);
  }, []);

  const updatePending = useCallback((key: string, action: PendingAttention | null) => {
    const next = { ...pendingRef.current };
    if (action) next[key] = action;
    else delete next[key];
    pendingRef.current = next;
    if (mounted.current) setPending(next);
  }, []);

  const writeShared = useCallback((session: Session, action: "read" | "unread") => {
    const key = sessionReadyIdentity(session);
    const current = sharedAttentionRef.current[key] ?? session.readyAttention!;
    const previous = writes.current.get(key);
    if (action === "read" && current.latestReadyEvent === current.lastCheckedEvent
      && previous?.action !== "unread") return;
    if (action === "unread" && (previous?.action === "unread"
      || (current.latestReadyEvent > current.lastCheckedEvent && previous?.action !== "read"))) return;

    const intent: PendingAttention = {
      sequence: ++sequence.current, action, event: current.latestReadyEvent,
    };
    updatePending(key, intent);
    // Serialize this page's actions. A quick revisit can acknowledge its own
    // pending manual mark without acknowledging a later, unseen completion.
    const promise = (previous?.promise ?? Promise.resolve(undefined)).then(async (prior) => {
      const event = action === "read" && previous?.action === "unread" && prior
        ? Math.max(intent.event, prior.latestReadyEvent) : intent.event;
      if (pendingRef.current[key]?.sequence === intent.sequence && event !== intent.event) {
        updatePending(key, { ...intent, event });
      }
      const target = sessionsRef.current.find((candidate) => sessionReadyIdentity(candidate) === key) ?? session;
      const result = await updateSessionAttention(target, action, event);
      receiveShared(key, result);
      return result;
    }).catch((error: unknown) => {
      console.error("Unable to save session read/unread status", error);
      return undefined;
    }).finally(() => {
      if (pendingRef.current[key]?.sequence === intent.sequence) updatePending(key, null);
      if (writes.current.get(key)?.sequence === intent.sequence) writes.current.delete(key);
    });
    writes.current.set(key, { ...intent, promise });
  }, [receiveShared, updatePending]);

  const update = useCallback((action: (current: SessionReadyAttentionState) => SessionReadyAttentionState) => {
    const current = attentionRef.current;
    const next = action(mergeSessionReadyAttention(current, readAttention()));
    if (next !== current) {
      attentionRef.current = next;
      setAttention(next);
    }
    try {
      const raw = JSON.stringify(next);
      if (window.localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY) !== raw) {
        window.localStorage.setItem(SESSION_READY_ATTENTION_STORAGE_KEY, raw);
      }
    } catch {
      // Browsers that block storage still retain attention for this page.
    }
  }, []);

  useLayoutEffect(() => {
    for (const session of sessions) {
      if (session.readyAttention) receiveShared(sessionReadyIdentity(session), session.readyAttention);
    }
    // Local history is only a compatibility fallback for older servers.
    // It must not override a shared acknowledgement from another browser.
    const localSessions = sessions.filter((session) => !session.readyAttention);
    if (localSessions.length) update((current) => observeSessionReadyAttention(current, localSessions));
  }, [sessions, update, receiveShared]);

  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === SESSION_READY_ATTENTION_STORAGE_KEY && event.newValue !== null) {
        update((current) => mergeSessionReadyAttention(current, parseSessionReadyAttention(event.newValue)));
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [update]);

  const checkSessionReady = useCallback((name: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.name === name);
    if (!session) return;
    if (session.readyAttention) writeShared(session, "read");
    else update((current) => checkSessionReadyAttention(current, session));
  }, [update, writeShared]);

  const markSessionUnread = useCallback((name: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.name === name);
    if (!session) return;
    if (session.readyAttention) writeShared(session, "unread");
    else update((current) => markSessionUnreadAttention(current, session));
  }, [update, writeShared]);

  const uncheckedReadySessions = useMemo(() => new Set(sessions
    .filter((session) => {
      if (!session.readyAttention) return sessionReadyIsUnchecked(attention, session);
      const key = sessionReadyIdentity(session);
      const cursor = sharedAttention[key] ?? session.readyAttention;
      const intent = pending[key];
      if (intent?.action === "unread") return true;
      return cursor.latestReadyEvent > (intent?.action === "read" ? intent.event : cursor.lastCheckedEvent);
    })
    .map((session) => session.name)), [attention, sharedAttention, pending, sessions]);

  return { uncheckedReadySessions, checkSessionReady, markSessionUnread };
}
