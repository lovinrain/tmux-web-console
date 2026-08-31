import type {
  HistoryPage,
  MemorandumState,
  MessageQueue,
  QueuedMessage,
  Session,
  SessionTag,
  SnippetNode,
  SnippetTree,
} from "./types";
import type { WorkspaceTabGroup } from "./workspaceState";
import type { Theme } from "./theme";

export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function isUnknownFieldError(error: unknown, field: string): error is ApiRequestError {
  return error instanceof ApiRequestError
    && error.status === 400
    && error.message === `unknown field: ${field}`;
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

export type HostMetricRange = "15m" | "1h" | "24h";

export interface HostMetricPoint {
  observedAt: number;
  cpuPercent: number | null;
  cpuCores: Array<number | null>;
  memoryUsedBytes: number;
}

export interface HostPressureAverages {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface HostMetricLatest extends HostMetricPoint {
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryPressure: {
    some: HostPressureAverages | null;
    full: HostPressureAverages | null;
  } | null;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapInBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
  loadAverage: [number, number, number];
}

export interface HostMetricsSnapshot {
  hostname: string;
  cpuCount: number;
  sampleSeconds: number;
  collectionMode: "on-demand";
  range: HostMetricRange;
  latest: HostMetricLatest;
  history: HostMetricPoint[];
}

export async function getHostMetrics(
  range: HostMetricRange = "15m",
  signal?: AbortSignal,
): Promise<HostMetricsSnapshot> {
  const query = new URLSearchParams({ range });
  return jsonRequest<HostMetricsSnapshot>(`/api/host-metrics?${query}`, { signal });
}

export interface CreatedSession {
  name: string;
  id: string;
}

async function requestSessionCreation(
  body: Record<string, string>,
  path = "/api/sessions",
): Promise<CreatedSession> {
  const result = await jsonRequest<{ session: string; sessionId: string }>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { name: result.session, id: result.sessionId };
}

export async function createSession(
  name?: string,
  theme?: Theme,
  directory?: string,
): Promise<CreatedSession> {
  const body = {
    ...(name === undefined ? {} : { name }),
    ...(theme === undefined ? {} : { theme }),
    ...(directory === undefined ? {} : { directory }),
  };
  try {
    return await requestSessionCreation(body);
  } catch (error) {
    if (
      theme !== undefined
      && isUnknownFieldError(error, "theme")
    ) {
      // An older backend rejects the field before creating anything, so one
      // theme-less retry safely bridges an in-place frontend/backend rollout.
      return requestSessionCreation({
        ...(name === undefined ? {} : { name }),
        ...(directory === undefined ? {} : { directory }),
      });
    }
    throw error;
  }
}

export async function copySession(
  sourceSession: string,
  sourceSessionId: string,
  theme?: Theme,
): Promise<CreatedSession> {
  return requestSessionCreation({
    sessionId: sourceSessionId,
    ...(theme === undefined ? {} : { theme }),
  }, `/api/sessions/${encodeURIComponent(sourceSession)}/copy`);
}

export interface UploadedSessionAttachment {
  name: string;
  path: string;
  terminalText: string;
  contentType: string;
  size: number;
}

export type SessionFileKind = "directory" | "file" | "other";

export interface SessionFileEntry {
  name: string;
  path: string;
  absolutePath: string;
  terminalText: string;
  kind: SessionFileKind;
  size: number | null;
  modified: number | null;
  hidden: boolean;
  symlink: boolean;
  accessible: boolean;
}

export interface SessionDirectoryListing {
  root: string;
  path: string;
  absolutePath: string;
  terminalText: string;
  entries: SessionFileEntry[];
  truncated: boolean;
  limit: number;
  /** Directory above this root, or null when the boundary stops here. */
  rootParent?: string | null;
}

export interface ResolvedSessionFilePath {
  kind: "directory" | "file";
  root: string;
  path: string;
  absolutePath: string;
  entry: SessionFileEntry | null;
}

export interface SessionFilePreview {
  root: string;
  name: string;
  path: string;
  absolutePath: string;
  terminalText: string;
  kind: "text" | "image" | "binary";
  mediaType: string;
  size: number;
  modified: number;
  truncated: boolean;
  previewBytes: number;
  content: string | null;
  editable?: boolean;
}

export interface SessionFileRemoval {
  name: string;
  path: string;
  absolutePath: string;
  terminalText: string;
  kind: SessionFileKind;
  symlink: boolean;
  removedEntries: number;
}

export interface SessionFileTarget {
  session: string;
  sessionId: string;
  paneId: string;
  /**
   * Absolute directory to browse instead of the live pane working directory.
   * Omitted while the browser sits at the pane's own directory, so an older
   * backend that does not know the field still serves the default view.
   */
  root?: string;
}

function sessionFileQuery(target: SessionFileTarget, path: string): string {
  const query = new URLSearchParams({
    sessionId: target.sessionId,
    paneId: target.paneId,
    path,
  });
  if (target.root) query.set("root", target.root);
  return query.toString();
}

function sessionFileUrl(
  target: SessionFileTarget,
  route: string,
  path: string,
): string {
  const base = `/api/sessions/${encodeURIComponent(target.session)}/files`;
  const query = sessionFileQuery(target, path);
  return route ? `${base}/${route}?${query}` : `${base}?${query}`;
}

export async function listSessionFiles(
  target: SessionFileTarget,
  path = "",
  signal?: AbortSignal,
): Promise<SessionDirectoryListing> {
  return jsonRequest<SessionDirectoryListing>(
    sessionFileUrl(target, "", path),
    { signal },
  );
}

export async function resolveSessionFilePath(
  target: SessionFileTarget,
  absolutePath: string,
  signal?: AbortSignal,
): Promise<ResolvedSessionFilePath> {
  // Resolution is against the server's configured browse boundary, not the
  // directory currently displayed by the client, so an old root is omitted.
  const query = new URLSearchParams({
    sessionId: target.sessionId,
    paneId: target.paneId,
    path: absolutePath,
  });
  return jsonRequest<ResolvedSessionFilePath>(
    `/api/sessions/${encodeURIComponent(target.session)}/files/resolve?${query}`,
    { signal },
  );
}

export async function previewSessionFile(
  target: SessionFileTarget,
  path: string,
  signal?: AbortSignal,
): Promise<SessionFilePreview> {
  return jsonRequest<SessionFilePreview>(
    sessionFileUrl(target, "preview", path),
    { signal },
  );
}

export function sessionFileImageUrl(
  target: SessionFileTarget,
  path: string,
): string {
  return `${BASE_PATH}${sessionFileUrl(target, "image", path)}`;
}

export function sessionFileDownloadUrl(
  target: SessionFileTarget,
  path: string,
): string {
  return `${BASE_PATH}${sessionFileUrl(target, "download", path)}`;
}

export async function uploadSessionFile(
  target: SessionFileTarget,
  directoryPath: string,
  file: File,
  signal?: AbortSignal,
): Promise<SessionFileEntry> {
  const query = new URLSearchParams({
    sessionId: target.sessionId,
    paneId: target.paneId,
    path: directoryPath,
    filename: file.name,
  });
  if (target.root) query.set("root", target.root);
  return jsonRequest<SessionFileEntry>(
    `/api/sessions/${encodeURIComponent(target.session)}/files/upload?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      signal,
    },
  );
}

async function sessionFileMutation<T>(
  target: SessionFileTarget,
  route: string,
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "PUT",
  signal?: AbortSignal,
): Promise<T> {
  return jsonRequest<T>(sessionFileUrl(target, route, path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function createSessionFileEntry(
  target: SessionFileTarget,
  directoryPath: string,
  name: string,
  kind: "directory" | "file",
  signal?: AbortSignal,
): Promise<SessionFileEntry> {
  return sessionFileMutation<SessionFileEntry>(
    target,
    "create",
    directoryPath,
    { name, kind },
    "POST",
    signal,
  );
}

export async function moveSessionFileEntry(
  target: SessionFileTarget,
  path: string,
  destination: string,
  signal?: AbortSignal,
): Promise<SessionFileEntry> {
  return sessionFileMutation<SessionFileEntry>(
    target,
    "move",
    path,
    { destination },
    "POST",
    signal,
  );
}

export async function copySessionFileEntry(
  target: SessionFileTarget,
  path: string,
  destination: string,
  signal?: AbortSignal,
): Promise<SessionFileEntry> {
  return sessionFileMutation<SessionFileEntry>(
    target,
    "copy",
    path,
    { destination },
    "POST",
    signal,
  );
}

export async function deleteSessionFileEntry(
  target: SessionFileTarget,
  path: string,
  recursive = false,
  signal?: AbortSignal,
): Promise<SessionFileRemoval> {
  return sessionFileMutation<SessionFileRemoval>(
    target,
    "delete",
    path,
    { recursive },
    "POST",
    signal,
  );
}

export async function saveSessionFileContent(
  target: SessionFileTarget,
  path: string,
  content: string,
  expectedModified?: number,
  signal?: AbortSignal,
): Promise<SessionFileEntry> {
  return sessionFileMutation<SessionFileEntry>(
    target,
    "content",
    path,
    expectedModified === undefined ? { content } : { content, expectedModified },
    "PUT",
    signal,
  );
}


export async function uploadSessionAttachment(
  session: string,
  sessionId: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadedSessionAttachment> {
  const query = new URLSearchParams({ filename: file.name, sessionId });
  return jsonRequest<UploadedSessionAttachment>(
    `/api/sessions/${encodeURIComponent(session)}/attachments?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      signal,
    },
  );
}

export async function terminateSession(
  session: string,
  sessionId: string,
  sessionCreated: number,
  serverStarted: number,
  serverPid: number,
): Promise<void> {
  await jsonRequest<unknown>(`/api/sessions/${encodeURIComponent(session)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, sessionCreated, serverStarted, serverPid }),
  });
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

export async function updateSessionTags(
  session: string,
  tags: readonly SessionTag[],
): Promise<SessionTag[]> {
  const result = await jsonRequest<{ session: string; tags: SessionTag[] }>(
    "/api/session-tags",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, tags }),
    },
  );
  return result.tags;
}

export async function updateSessionDetails(
  session: string,
  title: string,
  tags: readonly SessionTag[],
): Promise<Pick<Session, "customTitle" | "tags">> {
  const result = await jsonRequest<{
    session: string;
    customTitle: string | null;
    tags: SessionTag[];
  }>(
    "/api/session-details",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, title, tags }),
    },
  );
  return { customTitle: result.customTitle, tags: result.tags };
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

export interface SessionWorkspacePinResult {
  session: string;
  workspacePinned: boolean;
  sessionRevision: number;
}

export async function updateSessionWorkspacePin(
  session: string,
  pinned: boolean,
): Promise<SessionWorkspacePinResult> {
  return jsonRequest<SessionWorkspacePinResult>("/api/session-workspace-pin", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, pinned }),
  });
}

export interface SavedWorkspace {
  id: string;
  name: string;
  tabs: string[];
  groups?: WorkspaceTabGroup[];
  quickLinks?: WorkspaceQuickLink[];
  activeSession: string | null;
  sessionRevision: number;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
}

export type WorkspaceSessionTransferOperation = "copy" | "move";

export interface WorkspaceSessionTransferResult {
  session: string;
  operation: WorkspaceSessionTransferOperation;
  destinationAlreadyContained: boolean;
  destinationAdded: boolean;
  sourceRemoved: boolean;
  sourceWorkspace: SavedWorkspace | null;
  destinationWorkspace: SavedWorkspace;
  sessionRevision: number;
}

export interface WorkspaceQuickLink {
  id: string;
  label: string;
  url: string;
}

export interface CreateWorkspaceInput {
  name: string;
  tabs: string[];
  groups: WorkspaceTabGroup[];
  activeSession: string | null;
}

export type WorkspaceUpdate = Partial<Pick<
  SavedWorkspace,
  "name" | "tabs" | "activeSession" | "sessionRevision"
>>;

function workspacePath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}`;
}

function workspaceQuickLinksPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/quick-links`;
}

function sessionQuickLinksPath(sessionName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionName)}/quick-links`;
}

function workspaceNotePath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/note`;
}

function sessionNotePath(sessionName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionName)}/note`;
}

export async function getCommonWorkspaceQuickLinks(
  signal?: AbortSignal,
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    "/api/workspace-quick-links",
    { signal },
  );
  return result.links;
}

export async function replaceCommonWorkspaceQuickLinks(
  links: WorkspaceQuickLink[],
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    "/api/workspace-quick-links",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ links }),
    },
  );
  return result.links;
}

export async function getSessionQuickLinks(
  sessionName: string,
  signal?: AbortSignal,
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    sessionQuickLinksPath(sessionName),
    { signal },
  );
  return result.links;
}

export async function replaceSessionQuickLinks(
  sessionName: string,
  links: WorkspaceQuickLink[],
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    sessionQuickLinksPath(sessionName),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ links }),
    },
  );
  return result.links;
}

export async function getWorkspaceQuickLinks(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    workspaceQuickLinksPath(workspaceId),
    { signal },
  );
  return result.links;
}

export async function replaceWorkspaceQuickLinks(
  workspaceId: string,
  links: WorkspaceQuickLink[],
): Promise<WorkspaceQuickLink[]> {
  const result = await jsonRequest<{ links: WorkspaceQuickLink[] }>(
    workspaceQuickLinksPath(workspaceId),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ links }),
    },
  );
  return result.links;
}

export async function getCommonNote(signal?: AbortSignal): Promise<string> {
  const result = await jsonRequest<{ note: string }>("/api/common-note", { signal });
  return result.note;
}

export async function replaceCommonNote(note: string): Promise<string> {
  const result = await jsonRequest<{ note: string }>("/api/common-note", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  return result.note;
}

export async function getWorkspaceNote(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await jsonRequest<{ note: string }>(
    workspaceNotePath(workspaceId),
    { signal },
  );
  return result.note;
}

export async function replaceWorkspaceNote(
  workspaceId: string,
  note: string,
): Promise<string> {
  const result = await jsonRequest<{ note: string }>(workspaceNotePath(workspaceId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  return result.note;
}

export async function getSessionNote(
  sessionName: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await jsonRequest<{ note: string }>(
    sessionNotePath(sessionName),
    { signal },
  );
  return result.note;
}

export async function replaceSessionNote(
  sessionName: string,
  note: string,
): Promise<string> {
  const result = await jsonRequest<{ note: string }>(sessionNotePath(sessionName), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  return result.note;
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
  const request = async (body: CreateWorkspaceInput | Omit<CreateWorkspaceInput, "groups">) => {
    const result = await jsonRequest<{ workspace: SavedWorkspace }>("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return result.workspace;
  };

  try {
    return await request(workspace);
  } catch (error) {
    if (!isUnknownFieldError(error, "groups")) throw error;
    // Pre-group servers reject the request before creating anything, so retry is safe.
    return request({
      name: workspace.name,
      tabs: workspace.tabs,
      activeSession: workspace.activeSession,
    });
  }
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

export async function transferSessionToWorkspace(
  session: string,
  sourceWorkspaceId: string | null,
  destinationWorkspaceId: string,
  operation: WorkspaceSessionTransferOperation,
  sessionRevision: number,
): Promise<WorkspaceSessionTransferResult> {
  return jsonRequest<WorkspaceSessionTransferResult>(
    "/api/session-workspace-transfer",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session,
        sourceWorkspaceId,
        destinationWorkspaceId,
        operation,
        sessionRevision,
      }),
    },
  );
}

export async function updateWorkspaceActivity(
  workspaceId: string,
  tabs: string[],
  groups: WorkspaceTabGroup[] | undefined,
  activeSession: string | null,
  sessionRevision: number,
): Promise<SavedWorkspace> {
  const request = async (includeGroups: boolean) => {
    const result = await jsonRequest<{ workspace: SavedWorkspace }>(
      `${workspacePath(workspaceId)}/activity`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabs,
          ...(includeGroups ? { groups } : {}),
          activeSession,
          sessionRevision,
        }),
      },
    );
    return result.workspace;
  };

  if (groups === undefined) return request(false);
  try {
    return await request(true);
  } catch (error) {
    if (!isUnknownFieldError(error, "groups")) throw error;
    // The rejected request never mutated an older server.
    return request(false);
  }
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

export interface ShortcutBindingPayload {
  direct: string | null;
  launcher: string | null;
}

export interface ShortcutSettingsPayload {
  revision: number;
  bindings: Record<string, ShortcutBindingPayload>;
}

export async function getShortcutSettings(
  signal?: AbortSignal,
): Promise<ShortcutSettingsPayload> {
  return jsonRequest<ShortcutSettingsPayload>("/api/shortcuts", { signal });
}

export async function saveShortcutSettings(
  bindings: Record<string, ShortcutBindingPayload>,
  revision: number,
): Promise<ShortcutSettingsPayload> {
  return jsonRequest<ShortcutSettingsPayload>("/api/shortcuts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bindings, revision }),
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
