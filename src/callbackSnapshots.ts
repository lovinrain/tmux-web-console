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
  if (messages.callbackMessageRevision === undefined) return sessions;
  const callbackMessages = messages.callbackMessages ?? [];
  return {
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
}
