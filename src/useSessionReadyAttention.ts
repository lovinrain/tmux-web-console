import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session } from "./types";
import {
  SESSION_READY_ATTENTION_STORAGE_KEY,
  checkSessionReadyAttention,
  mergeSessionReadyAttention,
  observeSessionReadyAttention,
  parseSessionReadyAttention,
  sessionReadyIsUnchecked,
  type SessionReadyAttentionState,
} from "./sessionReadyAttention";

function readAttention(): SessionReadyAttentionState {
  try {
    return parseSessionReadyAttention(window.localStorage.getItem(SESSION_READY_ATTENTION_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function useSessionReadyAttention(sessions: readonly Session[]) {
  const [attention, setAttention] = useState(readAttention);
  const attentionRef = useRef(attention);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

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
    update((current) => observeSessionReadyAttention(current, sessions));
  }, [sessions, update]);

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
    if (session) update((current) => checkSessionReadyAttention(current, session));
  }, [update]);

  const uncheckedReadySessions = useMemo(() => new Set(sessions
    .filter((session) => sessionReadyIsUnchecked(attention, session))
    .map((session) => session.name)), [attention, sessions]);

  return { uncheckedReadySessions, checkSessionReady };
}
