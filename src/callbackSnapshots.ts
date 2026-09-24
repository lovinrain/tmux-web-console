import type { GlobalCallbackSnapshot } from "./api";

/** Session membership and agent messages change independently. */
export function mergeCallbackSnapshot(
  current: GlobalCallbackSnapshot,
  incoming: GlobalCallbackSnapshot,
): GlobalCallbackSnapshot {
  const sessions = incoming.sessionRevision >= current.sessionRevision ? incoming : current;
  const messages = incoming.callbackMessageRevision !== undefined
    && incoming.callbackMessageRevision >= (current.callbackMessageRevision ?? -1)
    ? incoming : current;
  const callbackMessages = messages.callbackMessages ?? [];
  const merged = messages.callbackMessageRevision === undefined ? sessions : {
    ...sessions,
    callbackMessages,
    callbackMessageRevision: messages.callbackMessageRevision,
    callbackSessions: [...new Set([
      ...sessions.globalCallbackSessions,
      ...sessions.workspaceCallbacks.flatMap((source) => source.sessions),
      ...callbackMessages.filter((message) => message.reviewedAt === null)
        .map((message) => message.sessionName),
    ])],
  };

  // Receipt times are monotonic history, independent of either revision. A stale
  // response can still contain history for a newly watched session, while an
  // older server may omit this field entirely.
  const queuedNames = new Set(merged.callbackSessions);
  const latestTimes = new Map<string, number>();
  const remember = (name: string, timestamp: number) => {
    if (!queuedNames.has(name) || !Number.isFinite(timestamp) || timestamp < 0) return;
    latestTimes.set(name, Math.max(latestTimes.get(name) ?? timestamp, timestamp));
  };
  for (const source of [current, incoming]) {
    for (const [name, timestamp] of Object.entries(source.latestCallbackAtBySession ?? {})) {
      remember(name, timestamp);
    }
    // Preserve receipts observed from legacy responses even after review removes
    // their messages from the pending queue.
    for (const message of source.callbackMessages ?? []) {
      remember(message.sessionName, message.createdAt);
    }
  }
  if (latestTimes.size === 0 && current.latestCallbackAtBySession === undefined
    && incoming.latestCallbackAtBySession === undefined) return merged;
  return { ...merged, latestCallbackAtBySession: Object.fromEntries(latestTimes) };
}
