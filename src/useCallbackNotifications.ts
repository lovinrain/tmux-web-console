import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALLBACK_NOTIFICATION_STORAGE_KEY,
  CALLBACK_NOTIFICATION_WORKSPACE_PREFIX,
  CALLBACK_NOTIFICATION_SCOPES,
  CALLBACK_NOTIFICATION_DISMISS_PREFIX,
  CALLBACK_NOTIFICATION_MUTE_PREFIX,
  CALLBACK_NOTIFICATION_DISMISS_RETENTION,
  MAX_CALLBACK_NOTIFICATION_DISMISSALS,
  MAX_CALLBACK_NOTIFICATIONS,
  initialCallbackNotificationObservation,
  observeCallbackNotifications,
  parseCallbackNotificationScope,
  type CallbackNotification,
  type CallbackNotificationInput,
  type CallbackNotificationScope,
  type MutedCallbackSession,
} from "./callbackNotifications";
import { sessionReadyIdentity } from "./sessionReadyAttention";

function readScope(): CallbackNotificationScope {
  try {
    return parseCallbackNotificationScope(window.localStorage.getItem(CALLBACK_NOTIFICATION_STORAGE_KEY));
  } catch {
    return "off";
  }
}

function readWorkspaceScopes(): Map<string, CallbackNotificationScope> | null {
  try {
    const result = new Map<string, CallbackNotificationScope>();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX)) continue;
      try {
        const id = decodeURIComponent(key.slice(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX.length));
        const scope = CALLBACK_NOTIFICATION_SCOPES.find((option) => option.value === localStorage.getItem(key))?.value;
        if (id && id.length <= 128 && scope) result.set(id, scope);
      } catch { /* Ignore malformed optional preferences. */ }
    }
    return result;
  } catch {
    return null;
  }
}

function dismissalRecords(): Array<{ key: string; id: string; at: number }> {
  const records: Array<{ key: string; id: string; at: number }> = [];
  const storage = window.localStorage;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(CALLBACK_NOTIFICATION_DISMISS_PREFIX)) continue;
    try {
      const id = decodeURIComponent(key.slice(CALLBACK_NOTIFICATION_DISMISS_PREFIX.length));
      const at = Number(storage.getItem(key));
      if (id.length > 0 && id.length <= 1024 && Number.isSafeInteger(at) && at > 0) records.push({ key, id, at });
    } catch {
      // Ignore malformed optional browser preferences.
    }
  }
  return records;
}

function readDismissals(): Set<string> {
  try {
    return new Set(dismissalRecords()
      .filter((record) => record.at > Date.now() - CALLBACK_NOTIFICATION_DISMISS_RETENTION)
      .sort((left, right) => right.at - left.at).slice(0, MAX_CALLBACK_NOTIFICATION_DISMISSALS)
      .map((record) => record.id));
  } catch {
    return new Set();
  }
}

function writeDismissal(id: string): void {
  try {
    // Separate keys prevent concurrent dismissals in different tabs from
    // overwriting each other in a shared read/modify/write list.
    window.localStorage.setItem(`${CALLBACK_NOTIFICATION_DISMISS_PREFIX}${encodeURIComponent(id)}`, String(Date.now()));
    const records = dismissalRecords().sort((left, right) => right.at - left.at);
    records.forEach((record, index) => {
      if (index >= MAX_CALLBACK_NOTIFICATION_DISMISSALS
        || record.at <= Date.now() - CALLBACK_NOTIFICATION_DISMISS_RETENTION) window.localStorage.removeItem(record.key);
    });
  } catch {
    // Dismissal still works locally when browser storage is blocked.
  }
}

function muteKey(identity: string): string {
  return `${CALLBACK_NOTIFICATION_MUTE_PREFIX}${encodeURIComponent(identity)}`;
}

function readSessionMutes(): Set<string> | null {
  try {
    const muted = new Set<string>();
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(CALLBACK_NOTIFICATION_MUTE_PREFIX) || storage.getItem(key) !== "1") continue;
      try {
        const identity = decodeURIComponent(key.slice(CALLBACK_NOTIFICATION_MUTE_PREFIX.length));
        const parts: unknown = JSON.parse(identity);
        if (identity.length <= 1024 && Array.isArray(parts) && parts.length === 4
          && typeof parts[0] === "string" && parts.slice(1).every((part) => Number.isSafeInteger(part) && part >= 0)) {
          muted.add(identity);
        }
      } catch {
        // Ignore malformed optional browser preferences.
      }
    }
    return muted;
  } catch {
    return null;
  }
}

export function useCallbackNotifications(input: Omit<CallbackNotificationInput, "scope"> & {
  workspaceKey: string;
  workspaceId?: string | null;
  sessionsLoaded: boolean;
}) {
  const [scope, updateScope] = useState(readScope);
  const [workspaceScopes, updateWorkspaceScopes] = useState(() => readWorkspaceScopes() ?? new Map<string, CallbackNotificationScope>());
  const unsavedWorkspaceScopes = useRef(new Map<string, CallbackNotificationScope | null>());
  const receiveWorkspaceScopes = useCallback((stored: Map<string, CallbackNotificationScope>) => {
    const next = new Map(stored);
    for (const [id, value] of unsavedWorkspaceScopes.current) {
      if (value === null) next.delete(id);
      else next.set(id, value);
    }
    updateWorkspaceScopes(next);
  }, []);
  const workspaceScope = input.workspaceId ? workspaceScopes.get(input.workspaceId) ?? null : null;
  const effectiveScope = workspaceScope ?? scope;
  const [notifications, setNotifications] = useState<CallbackNotification[]>([]);
  const observation = useRef(initialCallbackNotificationObservation());
  const [initialDismissals] = useState(readDismissals);
  const dismissed = useRef(initialDismissals);
  const [mutedSessionIdentities, setMutedSessionIdentities] = useState(() => readSessionMutes() ?? new Set<string>());
  const muted = useRef(mutedSessionIdentities);
  const quietEndings = useRef(new Set<string>());
  const receiveSessionMutes = useCallback((next: Set<string>) => {
    muted.current = next;
    setMutedSessionIdentities((current) => current.size === next.size && [...current].every((identity) => next.has(identity))
      ? current : next);
    setNotifications((current) => {
      const visible = current.filter((item) => item.sessionIdentity === null || !next.has(item.sessionIdentity));
      return visible.length === current.length ? current : visible;
    });
  }, []);
  const rememberDismissal = useCallback((id: string) => {
    dismissed.current.add(id);
    if (dismissed.current.size > MAX_CALLBACK_NOTIFICATION_DISMISSALS) {
      dismissed.current = new Set([...dismissed.current].slice(-MAX_CALLBACK_NOTIFICATION_DISMISSALS));
    }
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  const setScope = useCallback((next: CallbackNotificationScope) => {
    updateScope(next);
    try {
      window.localStorage.setItem(CALLBACK_NOTIFICATION_STORAGE_KEY, next);
    } catch {
      // Notification preferences still work for this page when storage is blocked.
    }
  }, []);
  const setWorkspaceScope = useCallback((next: CallbackNotificationScope | null) => {
    const id = input.workspaceId;
    if (!id) return;
    updateWorkspaceScopes((current) => {
      const result = new Map(current);
      if (next === null) result.delete(id);
      else result.set(id, next);
      return result;
    });
    try {
      const key = CALLBACK_NOTIFICATION_WORKSPACE_PREFIX + encodeURIComponent(id);
      if (next === null) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
      unsavedWorkspaceScopes.current.delete(id);
    } catch {
      unsavedWorkspaceScopes.current.set(id, next);
    }
  }, [input.workspaceId]);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === CALLBACK_NOTIFICATION_STORAGE_KEY || event.key === null) updateScope(readScope());
      if (event.key?.startsWith(CALLBACK_NOTIFICATION_WORKSPACE_PREFIX) || event.key === null) {
        const next = readWorkspaceScopes();
        if (next) receiveWorkspaceScopes(next);
      }
      if (event.key?.startsWith(CALLBACK_NOTIFICATION_MUTE_PREFIX) || event.key === null) {
        if (event.key !== null) {
          try {
            const identity = decodeURIComponent(event.key.slice(CALLBACK_NOTIFICATION_MUTE_PREFIX.length));
            // Another tab can retire a mute before this tab receives the ended
            // inventory. Explicit re-enabling writes "0" before removing its key.
            if (event.newValue === null && event.oldValue === "1" && observation.current.sessions.has(identity)) {
              quietEndings.current.add(identity);
            } else if (event.newValue === "0" || event.newValue === "1") {
              quietEndings.current.delete(identity);
            }
          } catch {
            // Ignore malformed optional browser preferences.
          }
        } else {
          quietEndings.current.clear();
        }
        const next = readSessionMutes();
        if (next) receiveSessionMutes(next);
      }
      if (event.key?.startsWith(CALLBACK_NOTIFICATION_DISMISS_PREFIX) && event.newValue !== null) {
        try {
          const id = decodeURIComponent(event.key.slice(CALLBACK_NOTIFICATION_DISMISS_PREFIX.length));
          const at = Number(event.newValue);
          if (id.length > 0 && id.length <= 1024 && Number.isSafeInteger(at)
            && at > Date.now() - CALLBACK_NOTIFICATION_DISMISS_RETENTION) rememberDismissal(id);
        } catch {
          // Ignore malformed optional browser preferences.
        }
      }
    };
    const refresh = () => {
      const preferences = readWorkspaceScopes();
      if (preferences) {
        receiveWorkspaceScopes(preferences);
      }
      const next = readSessionMutes();
      if (next) receiveSessionMutes(next);
      dismissed.current = new Set([...dismissed.current, ...readDismissals()].slice(-MAX_CALLBACK_NOTIFICATION_DISMISSALS));
      setNotifications((current) => current.filter((item) => !dismissed.current.has(item.id)));
    };
    const visible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("storage", receive);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", receive);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [rememberDismissal, receiveSessionMutes, receiveWorkspaceScopes]);

  const scopedWorkspaceKey = effectiveScope === "workspace" ? input.workspaceKey : null;
  useEffect(() => setNotifications([]), [effectiveScope, scopedWorkspaceKey]);
  useEffect(() => {
    if (!input.sessionsLoaded) return;
    const next = observeCallbackNotifications(observation.current, { ...input, scope: effectiveScope });
    observation.current = next.observation;
    if (next.notifications.length) {
      const sharedDismissals = readDismissals();
      const sharedMutes = readSessionMutes();
      const visible = next.notifications.filter((item) => !dismissed.current.has(item.id) && !sharedDismissals.has(item.id)
        && (item.sessionIdentity === null || !muted.current.has(item.sessionIdentity) && !sharedMutes?.has(item.sessionIdentity)
          && !(item.kind === "ended" && quietEndings.current.has(item.sessionIdentity))));
      setNotifications((current) => {
        const incoming = new Set(visible.map((item) => item.sessionName));
        return [...current.filter((item) => !incoming.has(item.sessionName)), ...visible]
          .slice(-MAX_CALLBACK_NOTIFICATIONS);
      });
    }
    for (const identity of quietEndings.current) {
      if (!next.observation.sessions.has(identity)) quietEndings.current.delete(identity);
    }
  }, [effectiveScope, input.sessions, input.sessionsLoaded, input.snapshot, input.callbacksLoaded,
    input.workspaceSessionNames, input.workspaceCallbackSessions, input.workspaceName]);

  useEffect(() => {
    // An empty inventory before the first successful load does not prove that
    // saved sessions ended. Once loaded, retire mutes by full native identity.
    if (!input.sessionsLoaded) return;
    const live = new Set(input.sessions.map(sessionReadyIdentity));
    const stored = readSessionMutes();
    for (const identity of stored ?? []) {
      if (live.has(identity)) continue;
      try { window.localStorage.removeItem(muteKey(identity)); } catch {
        // Closed sessions still disappear locally when browser storage is blocked.
      }
    }
    receiveSessionMutes(new Set([...muted.current, ...(stored ?? [])].filter((identity) => live.has(identity))));
  }, [input.sessions, input.sessionsLoaded, mutedSessionIdentities, receiveSessionMutes]);

  const muteSession = useCallback((identity: string) => {
    if (!input.sessions.some((session) => sessionReadyIdentity(session) === identity)) return;
    try {
      // Independent keys preserve concurrent mutes from different workspace tabs.
      window.localStorage.setItem(muteKey(identity), "1");
    } catch {
      // Muting still works for this page when browser storage is blocked.
    }
    receiveSessionMutes(new Set([...muted.current, ...(readSessionMutes() ?? []), identity]));
  }, [input.sessions, receiveSessionMutes]);
  const unmuteSession = useCallback((identity: string) => {
    quietEndings.current.delete(identity);
    try {
      // The intermediate value distinguishes a user's re-enable from automatic
      // retirement in storage events, without retaining an unmuted-session list.
      window.localStorage.setItem(muteKey(identity), "0");
      window.localStorage.removeItem(muteKey(identity));
    } catch {
      // Re-enabling still works locally when browser storage is blocked.
    }
    const next = new Set([...muted.current, ...(readSessionMutes() ?? [])]);
    next.delete(identity);
    receiveSessionMutes(next);
  }, [receiveSessionMutes]);
  const mutedSessions: MutedCallbackSession[] = input.sessions
    .filter((session) => mutedSessionIdentities.has(sessionReadyIdentity(session)))
    .map((session) => ({
      identity: sessionReadyIdentity(session), sessionName: session.name, title: session.customTitle?.trim() || session.name,
    }));

  const dismiss = useCallback((id: string) => {
    rememberDismissal(id);
    writeDismissal(id);
  }, [rememberDismissal]);
  const expire = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  return { scope, setScope, workspaceScope, setWorkspaceScope, effectiveScope,
    notifications, dismiss, expire, mutedSessions, muteSession, unmuteSession };
}
