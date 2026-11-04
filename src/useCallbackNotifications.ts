import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALLBACK_NOTIFICATION_STORAGE_KEY,
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

export function useCallbackNotifications(input: Omit<CallbackNotificationInput, "scope"> & { workspaceKey: string }) {
  const [scope, updateScope] = useState(readScope);
  const [notifications, setNotifications] = useState<CallbackNotification[]>([]);
  const observation = useRef(initialCallbackNotificationObservation());
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
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);

  const scopedWorkspaceKey = scope === "workspace" ? input.workspaceKey : null;
  useEffect(() => setNotifications([]), [scope, scopedWorkspaceKey]);
  useEffect(() => {
    const next = observeCallbackNotifications(observation.current, { ...input, scope });
    observation.current = next.observation;
    if (next.notifications.length) {
      setNotifications((current) => {
        const incoming = new Set(next.notifications.map((item) => item.sessionName));
        return [...current.filter((item) => !incoming.has(item.sessionName)), ...next.notifications]
          .slice(-MAX_CALLBACK_NOTIFICATIONS);
      });
    }
  }, [scope, input.sessions, input.snapshot, input.callbacksLoaded,
    input.workspaceSessionNames, input.workspaceCallbackSessions, input.workspaceName]);

  const dismiss = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  return { scope, setScope, notifications, dismiss };
}
