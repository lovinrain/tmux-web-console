import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALLBACK_NOTIFICATION_STORAGE_KEY,
  CALLBACK_NOTIFICATION_DISMISS_PREFIX,
  CALLBACK_NOTIFICATION_DISMISS_RETENTION,
  MAX_CALLBACK_NOTIFICATION_DISMISSALS,
  MAX_CALLBACK_NOTIFICATIONS,
  initialCallbackNotificationObservation,
  observeCallbackNotifications,
  parseCallbackNotificationScope,
  type CallbackNotification,
  type CallbackNotificationInput,
  type CallbackNotificationScope,
} from "./callbackNotifications";

function readScope(): CallbackNotificationScope {
  try {
    return parseCallbackNotificationScope(window.localStorage.getItem(CALLBACK_NOTIFICATION_STORAGE_KEY));
  } catch {
    return "off";
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

export function useCallbackNotifications(input: Omit<CallbackNotificationInput, "scope"> & { workspaceKey: string }) {
  const [scope, updateScope] = useState(readScope);
  const [notifications, setNotifications] = useState<CallbackNotification[]>([]);
  const observation = useRef(initialCallbackNotificationObservation());
  const [initialDismissals] = useState(readDismissals);
  const dismissed = useRef(initialDismissals);
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
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === CALLBACK_NOTIFICATION_STORAGE_KEY || event.key === null) updateScope(readScope());
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
  }, [rememberDismissal]);

  const scopedWorkspaceKey = scope === "workspace" ? input.workspaceKey : null;
  useEffect(() => setNotifications([]), [scope, scopedWorkspaceKey]);
  useEffect(() => {
    const next = observeCallbackNotifications(observation.current, { ...input, scope });
    observation.current = next.observation;
    if (next.notifications.length) {
      const sharedDismissals = readDismissals();
      const visible = next.notifications.filter((item) => !dismissed.current.has(item.id) && !sharedDismissals.has(item.id));
      setNotifications((current) => {
        const incoming = new Set(visible.map((item) => item.sessionName));
        return [...current.filter((item) => !incoming.has(item.sessionName)), ...visible]
          .slice(-MAX_CALLBACK_NOTIFICATIONS);
      });
    }
  }, [scope, input.sessions, input.snapshot, input.callbacksLoaded,
    input.workspaceSessionNames, input.workspaceCallbackSessions, input.workspaceName]);

  const dismiss = useCallback((id: string) => {
    rememberDismissal(id);
    writeDismissal(id);
  }, [rememberDismissal]);
  const expire = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  return { scope, setScope, notifications, dismiss, expire };
}
