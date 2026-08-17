import type {
  HistoryPage,
  MemorandumState,
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

export interface CreatedSession {
  name: string;
  id: string;
}

export async function createSession(name?: string): Promise<CreatedSession> {
  const result = await jsonRequest<{ session: string; sessionId: string }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
  return { name: result.session, id: result.sessionId };
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

export interface SavedWorkspace {
  id: string;
  name: string;
  tabs: string[];
  activeSession: string | null;
  sessionRevision: number;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
}

export interface CreateWorkspaceInput {
  name: string;
  tabs: string[];
  activeSession: string | null;
}

export type WorkspaceUpdate = Partial<Pick<
  SavedWorkspace,
  "name" | "tabs" | "activeSession" | "sessionRevision"
>>;

function workspacePath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}`;
}

export async function listWorkspaces(signal?: AbortSignal): Promise<SavedWorkspace[]> {
  const result = await jsonRequest<{ workspaces: SavedWorkspace[] }>(
    "/api/workspaces",
    { signal },
  );
  return result.workspaces;
}

export async function getWorkspace(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SavedWorkspace> {
  const result = await jsonRequest<{ workspace: SavedWorkspace }>(
    workspacePath(workspaceId),
    { signal },
  );
  return result.workspace;
}

export async function createWorkspace(
  workspace: CreateWorkspaceInput,
): Promise<SavedWorkspace> {
  const result = await jsonRequest<{ workspace: SavedWorkspace }>("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspace),
  });
  return result.workspace;
}

export async function updateWorkspace(
  workspaceId: string,
  update: WorkspaceUpdate,
): Promise<SavedWorkspace> {
  const result = await jsonRequest<{ workspace: SavedWorkspace }>(
    workspacePath(workspaceId),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    },
  );
  return result.workspace;
}

export async function updateWorkspaceActivity(
  workspaceId: string,
  tabs: string[],
  activeSession: string | null,
  sessionRevision: number,
): Promise<SavedWorkspace> {
  const result = await jsonRequest<{ workspace: SavedWorkspace }>(
    `${workspacePath(workspaceId)}/activity`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs, activeSession, sessionRevision }),
    },
  );
  return result.workspace;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await jsonRequest<unknown>(workspacePath(workspaceId), { method: "DELETE" });
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
  state: MemorandumState = "queued",
): Promise<QueuedMessage> {
  const result = await jsonRequest<{ session: string; message: QueuedMessage }>(
    messageQueuePath(session),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, state }),
    },
  );
  return result.message;
}

export interface QueuedMessageUpdate {
  text?: string;
  position?: number;
  state?: MemorandumState;
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
