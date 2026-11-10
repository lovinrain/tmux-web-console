import type { CallbackMessage, GlobalCallbackSnapshot } from "./api";
import {
  observeSessionReadyAttention,
  sessionReadyIdentity,
  type SessionReadyAttentionState,
} from "./sessionReadyAttention";
import type { Session } from "./types";

export const CALLBACK_NOTIFICATION_STORAGE_KEY = `muxdeck.callback-notifications.v1:${import.meta.env.BASE_URL}`;
export const CALLBACK_NOTIFICATION_WORKSPACE_PREFIX = `muxdeck.callback-notifications-workspace.v1:${import.meta.env.BASE_URL}:`;
export const CALLBACK_NOTIFICATION_DISMISS_PREFIX = `muxdeck.callback-notification-dismissed.v1:${import.meta.env.BASE_URL}:`;
export const CALLBACK_NOTIFICATION_MUTE_PREFIX = `muxdeck.callback-notification-muted.v1:${import.meta.env.BASE_URL}:`;
export const CALLBACK_NOTIFICATION_DISMISS_RETENTION = 7 * 24 * 60 * 60 * 1_000;
export const MAX_CALLBACK_NOTIFICATION_DISMISSALS = 256;
export const CALLBACK_NOTIFICATION_DURATION = 8_000;
export const CALLBACK_NOTIFICATION_FADE = 250;
export const MAX_CALLBACK_NOTIFICATIONS = 4;

export const CALLBACK_NOTIFICATION_SCOPES = [
  { value: "off", label: "Off", description: "Keep notifications quiet." },
  { value: "watched", label: "Watched callbacks", description: "Sessions in any callback list, plus new callback reports." },
  { value: "workspace", label: "This workspace", description: "Sessions and callbacks in the workspace open in this tab." },
  { value: "all", label: "All sessions", description: "Every session and callback across all workspaces." },
] as const;

export type CallbackNotificationScope = typeof CALLBACK_NOTIFICATION_SCOPES[number]["value"];

export function parseCallbackNotificationScope(value: unknown): CallbackNotificationScope {
  return CALLBACK_NOTIFICATION_SCOPES.find((option) => option.value === value)?.value ?? "off";
}

export interface CallbackNotification {
  id: string;
  sessionName: string;
  sessionIdentity: string | null;
  title: string;
  kind: "message" | "ready" | "ended";
  label: string;
  detail: string;
  workspace: string;
}

export interface MutedCallbackSession {
  identity: string;
  sessionName: string;
  title: string;
}

export interface CallbackNotificationInput {
  sessions: readonly Session[];
  snapshot: GlobalCallbackSnapshot;
  callbacksLoaded: boolean;
  workspaceSessionNames: readonly string[];
  workspaceCallbackSessions: readonly string[];
  workspaceName: string | null;
  scope: CallbackNotificationScope;
}

export interface CallbackNotificationObservation {
  sessions: ReadonlyMap<string, Session>;
  attention: SessionReadyAttentionState;
  messageSequence: number | null;
  workingAt: ReadonlyMap<string, number>;
}

export function initialCallbackNotificationObservation(): CallbackNotificationObservation {
  return { sessions: new Map(), attention: {}, messageSequence: null, workingAt: new Map() };
}

/** Observe every scope, including Off, so enabling or switching never replays old events. */
export function observeCallbackNotifications(
  previous: CallbackNotificationObservation,
  input: CallbackNotificationInput,
): { observation: CallbackNotificationObservation; notifications: CallbackNotification[] } {
  const { sessions, snapshot, scope } = input;
  const current = new Map(sessions.map((session) => [sessionReadyIdentity(session), session]));
  const byName = new Map(sessions.map((session) => [session.name, session]));
  const attention = observeSessionReadyAttention(previous.attention, sessions);
  const workingAt = new Map([...previous.workingAt].filter(([identity]) => current.has(identity)));
  for (const [identity, session] of current) {
    if ((session.agentState === "working" || session.agentState === "running_command")
      && session.agentStateChangedAt >= (previous.attention[identity]?.stateChangedAt ?? 0)) {
      workingAt.set(identity, attention[identity].stateChangedAt);
    }
  }
  const messages = snapshot.callbackMessages ?? [];
  const workspaceNames = new Set([...input.workspaceSessionNames, ...input.workspaceCallbackSessions]);
  const watched = new Set([
    ...snapshot.callbackSessions,
    ...snapshot.globalCallbackSessions,
    ...snapshot.workspaceCallbacks.flatMap((source) => source.sessions),
    ...input.workspaceCallbackSessions,
    ...messages.filter((message) => message.reviewedAt === null).map((message) => message.sessionName),
  ]);
  const held = new Set(snapshot.onHoldSessions);
  const eligible = (name: string) => !held.has(name) && (
    scope === "all" || scope === "workspace" && workspaceNames.has(name)
    || scope === "watched" && watched.has(name)
  );
  const workspaceLabel = (name: string) => {
    const sources = snapshot.workspaceCallbacks.filter((source) => source.sessions.includes(name));
    if (workspaceNames.has(name)) return input.workspaceName?.trim() || "This workspace";
    return [...new Set(sources.map((source) => source.workspaceName))].join(" · ");
  };
  const notification = (
    name: string, session: Session | undefined, rest: Pick<CallbackNotification, "id" | "kind" | "label" | "detail">,
  ): CallbackNotification => ({
    ...rest, sessionName: name, sessionIdentity: session ? sessionReadyIdentity(session) : null,
    title: session?.customTitle?.trim() || name, workspace: workspaceLabel(name),
  });

  // The initial snapshot is history. The sequence fence also ignores reconnect
  // replays, reviews, and older responses without retaining an unbounded ID set.
  let messageSequence = previous.messageSequence;
  const reports = new Map<string, CallbackMessage>();
  if (input.callbacksLoaded) {
    for (const message of messages) {
      if (previous.messageSequence !== null && message.sequence > previous.messageSequence
        && message.reviewedAt === null && eligible(message.sessionName)) {
        const latest = reports.get(message.sessionName);
        if (!latest || message.sequence > latest.sequence) reports.set(message.sessionName, message);
      }
    }
    messageSequence = Math.max(messageSequence ?? 0, ...messages.map((message) => message.sequence));
  }
  const notifications: CallbackNotification[] = [];
  for (const message of reports.values()) {
    const live = byName.get(message.sessionName);
    // A report for an ended native identity must not borrow a replacement's title.
    const session = message.tmuxSessionId === null || message.tmuxSessionId === live?.id ? live : undefined;
    notifications.push(notification(message.sessionName, session, {
      id: `message:${message.id}`, kind: "message", label: "New callback",
      detail: message.message.length > 280 ? `${message.message.slice(0, 280)}…` : message.message,
    }));
  }
  for (const [identity, session] of current) {
    const before = previous.attention[identity];
    const after = attention[identity];
    if (!before || !eligible(session.name) || reports.has(session.name)) continue;
    const ready = after.latestReadyEvent > before.latestReadyEvent
      || before.awaitingReady && after.state === "other" && after !== before;
    // A page-local counter differs across workspaces. Use the shared ready
    // marker, or the work/finish timestamps on older servers and shell commands.
    const event = session.agentState === "waiting_human" && session.readyAttention
      ? `event:${session.readyAttention.latestReadyEvent}`
      : `work:${workingAt.get(identity) ?? before.stateChangedAt}`;
    if (ready) notifications.push(notification(session.name, session, {
      id: `ready:${identity}:${after.state}:${after.stateChangedAt}:${event}`, kind: "ready",
      label: session.agentState === "waiting_human" ? "Ready for review" : "Finished working",
      detail: "Work has finished or is waiting for your input.",
    }));
  }
  for (const [identity, session] of previous.sessions) {
    if (current.has(identity) || !eligible(session.name) || reports.has(session.name)) continue;
    notifications.push(notification(session.name, session, {
      id: `ended:${identity}`, kind: "ended", label: "Session ended",
      detail: "This session is no longer available.",
    }));
  }
  return { observation: { sessions: current, attention, messageSequence, workingAt }, notifications };
}
