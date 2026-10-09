import { listSessions, subscribeToSessions, type RecoverableSession } from "./api";
import type { Session } from "./types";

interface SessionInventoryOptions {
  onSessions: (sessions: Session[]) => void;
  onError?: (error: unknown) => void;
  onMode?: (mode: "connecting" | "live" | "polling") => void;
  pollInterval?: number;
}

/** One inventory stream per view, with polling only while streaming is unavailable. */
export function subscribeToSessionInventory({
  onSessions, onError, onMode, pollInterval = 5000,
}: SessionInventoryOptions): () => void {
  const controller = new AbortController();
  let stopped = false;
  let polling: number | undefined;
  let streamVersion = 0;
  let requestId = 0;
  const stopPolling = () => {
    if (polling !== undefined) window.clearInterval(polling);
    polling = undefined;
  };
  const refresh = async () => {
    const id = ++requestId;
    const version = streamVersion;
    const current = () => !stopped && !controller.signal.aborted
      && id === requestId && version === streamVersion;
    try {
      const sessions = await listSessions(controller.signal);
      if (current()) onSessions(sessions);
    } catch (error) {
      if (current()) onError?.(error);
    }
  };
  const startPolling = () => {
    if (stopped || polling !== undefined) return;
    onMode?.("polling");
    polling = window.setInterval(() => void refresh(), pollInterval);
  };

  onMode?.("connecting");
  void refresh();
  let unsubscribe = () => {};
  try {
    unsubscribe = subscribeToSessions({
      onSessions: (sessions, recoverable: RecoverableSession[] = []) => {
        if (stopped) return;
        streamVersion += 1;
        stopPolling();
        Object.defineProperty(sessions, "recoverableSessions", {
          configurable: true, value: recoverable,
        });
        onSessions(sessions);
        onMode?.("live");
      },
      onStatus: (status) => {
        if (stopped) return;
        if (status === "open") {
          stopPolling();
          onMode?.("live");
        } else if (status === "error") startPolling();
      },
      // EventSource reconnects itself; polling covers a disconnected stream.
      onError: () => {},
    });
  } catch {
    startPolling();
  }
  return () => {
    stopped = true;
    controller.abort();
    stopPolling();
    unsubscribe();
  };
}
