import type {
  HistoryPage,
  MessageQueue,
  QueuedMessage,
  Session,
  SnippetNode,
  SnippetTree,
} from "./types";

export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_PATH}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiRequestError(payload.error || `Request failed (${response.status})`, response.status);
  }
  return payload as T;
}

export async function listSessions(signal?: AbortSignal): Promise<Session[]> {
  const result = await jsonRequest<{ sessions: Session[] }>("/api/sessions", { signal });
  return result.sessions;
}

export async function createSession(): Promise<string> {
  const result = await jsonRequest<{ session: string }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return result.session;
}

export interface SessionRenameResult {
  previousSession: string;
  session: string;
  warnings: string[];
}

export async function renameSession(
  session: string,
  name: string,
): Promise<SessionRenameResult> {
  const result = await jsonRequest<{
    session: string;
    previousSession: string;
    warnings?: string[];
  }>(
    "/api/session-name",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, name }),
    },
  );
  return {
    previousSession: result.previousSession,
    session: result.session,
    warnings: result.warnings ?? [],
  };
}

export type SessionStreamStatus = "connecting" | "open" | "error";

export interface SessionStreamOptions {
  onSessions: (sessions: Session[]) => void;
  onStatus?: (status: SessionStreamStatus) => void;
  onError?: (error: Error) => void;
}

export function subscribeToSessions({
  onSessions,
  onStatus,
  onError,
}: SessionStreamOptions): () => void {
  if (typeof EventSource === "undefined") {
    throw new Error("Server-sent events are not supported by this browser");
  }

  onStatus?.("connecting");
  const source = new EventSource(`${BASE_PATH}/api/sessions/stream`);
  let closed = false;

  const handleSessions = (event: MessageEvent<string>) => {
    if (closed) return;

    try {
      const payload = JSON.parse(event.data) as { sessions?: unknown };
      if (!Array.isArray(payload.sessions)) {
        throw new Error("Session stream event did not contain a sessions array");
      }
      onSessions(payload.sessions as Session[]);
    } catch (error) {
      const streamError = error instanceof Error ? error : new Error(String(error));
      onStatus?.("error");
      onError?.(streamError);
    }
  };

  source.addEventListener("sessions", handleSessions);
  source.onopen = () => {
    if (!closed) onStatus?.("open");
  };
  source.onerror = () => {
    if (closed) return;
    onStatus?.("error");
    onError?.(new Error("Session stream connection failed"));
  };

  return () => {
    if (closed) return;
    closed = true;
    source.removeEventListener("sessions", handleSessions);
    source.close();
  };
}

export async function updateSessionTitle(
  session: string,
  title: string,
): Promise<string | null> {
  const result = await jsonRequest<{ session: string; customTitle: string | null }>(
    "/api/session-title",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, title }),
    },
  );
  return result.customTitle;
}

export async function updateSessionStar(
  session: string,
  starred: boolean,
): Promise<Pick<Session, "starred" | "ignored">> {
  const result = await jsonRequest<{
    session: string;
    starred: boolean;
    ignored: boolean;
  }>(
    "/api/session-star",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, starred }),
    },
  );
  return { starred: result.starred, ignored: result.ignored };
}

export async function updateSessionIgnored(
  session: string,
  ignored: boolean,
): Promise<Pick<Session, "starred" | "ignored">> {
  const result = await jsonRequest<{
    session: string;
    starred: boolean;
    ignored: boolean;
  }>(
    "/api/session-ignored",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, ignored }),
    },
  );
  return { starred: result.starred, ignored: result.ignored };
}

function messageQueuePath(session: string): string {
  return `/api/sessions/${encodeURIComponent(session)}/messages`;
}

export async function listQueuedMessages(
  session: string,
  signal?: AbortSignal,
): Promise<MessageQueue> {
  return jsonRequest<MessageQueue>(messageQueuePath(session), { signal });
}

export async function createQueuedMessage(
  session: string,
  text: string,
): Promise<QueuedMessage> {
  const result = await jsonRequest<{ session: string; message: QueuedMessage }>(
    messageQueuePath(session),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return result.message;
}

export interface QueuedMessageUpdate {
  text?: string;
  position?: number;
}

export async function updateQueuedMessage(
  session: string,
  messageId: string,
  update: QueuedMessageUpdate,
): Promise<QueuedMessage> {
  const result = await jsonRequest<{ session: string; message: QueuedMessage }>(
    `${messageQueuePath(session)}/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    },
  );
  return result.message;
}

export async function deleteQueuedMessage(
  session: string,
  messageId: string,
): Promise<void> {
  await jsonRequest<unknown>(
    `${messageQueuePath(session)}/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
}

export async function getSnippetTree(signal?: AbortSignal): Promise<SnippetTree> {
  return jsonRequest<SnippetTree>("/api/snippets", { signal });
}

export async function saveSnippetTree(
  tree: SnippetNode[],
  revision: number,
): Promise<SnippetTree> {
  return jsonRequest<SnippetTree>("/api/snippets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tree, revision }),
  });
}

export function createHistorySnapshot(paneId: string, limit = 250): Promise<HistoryPage> {
  return jsonRequest<HistoryPage>(
    `/api/panes/${encodeURIComponent(paneId)}/history?limit=${limit}`,
    { method: "POST" },
  );
}

export function loadHistoryPage(
  snapshotId: string,
  before: number,
  limit = 250,
): Promise<HistoryPage> {
  return jsonRequest<HistoryPage>(
    `/api/history/${encodeURIComponent(snapshotId)}?before=${before}&limit=${limit}`,
  );
}

export function terminalWebSocketUrl(
  session: string,
  cols: number,
  rows: number,
  ignoreSize: boolean,
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    session,
    cols: String(cols),
    rows: String(rows),
    ignoreSize: ignoreSize ? "1" : "0",
  });
  return `${protocol}//${window.location.host}${BASE_PATH}/ws/terminal?${query}`;
}
