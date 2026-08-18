export interface SessionWorkspaceState {
  openSessions: string[];
  recentSessions: string[];
}

export const EMPTY_SESSION_WORKSPACE: Readonly<SessionWorkspaceState> = {
  openSessions: [],
  recentSessions: [],
};

const MAX_RECENT_SESSIONS = 30;
export const WORKSPACE_TAB_SEARCH_PARAM = "tab";
export const SAVED_WORKSPACE_SEARCH_PARAM = "workspace";

function uniqueSessionNames(sessionNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const sessionName of sessionNames) {
    if (!sessionName || seen.has(sessionName)) continue;
    seen.add(sessionName);
    unique.push(sessionName);
  }
  return unique;
}

function sameSessions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((sessionName, index) => sessionName === right[index]);
}

function queryParts(search: string): string[] {
  const rawSearch = search.startsWith("?") ? search.slice(1) : search;
  return rawSearch ? rawSearch.split("&").filter(Boolean) : [];
}

function queryPartName(part: string): string {
  const separator = part.indexOf("=");
  const rawName = separator < 0 ? part : part.slice(0, separator);
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    return rawName;
  }
}

export function workspaceTabsFromSearch(
  search: string,
  activeSession?: string,
): string[] {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tabs = uniqueSessionNames(params.getAll(WORKSPACE_TAB_SEARCH_PARAM));
  if (activeSession && !tabs.includes(activeSession)) tabs.push(activeSession);
  return tabs;
}

export function searchWithoutWorkspaceTabs(search: string): string {
  const parts = queryParts(search).filter(
    (part) => queryPartName(part) !== WORKSPACE_TAB_SEARCH_PARAM,
  );
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function savedWorkspaceIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(SAVED_WORKSPACE_SEARCH_PARAM) || null;
}

export function searchWithSavedWorkspaceId(
  search: string,
  workspaceId: string | null,
): string {
  const parts = queryParts(search).filter(
    (part) => queryPartName(part) !== SAVED_WORKSPACE_SEARCH_PARAM,
  );
  if (workspaceId) {
    parts.push(`${SAVED_WORKSPACE_SEARCH_PARAM}=${encodeURIComponent(workspaceId)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function searchWithWorkspaceTabs(
  search: string,
  openSessions: readonly string[],
): string {
  const parts = queryParts(search).filter(
    (part) => queryPartName(part) !== WORKSPACE_TAB_SEARCH_PARAM,
  );
  for (const sessionName of uniqueSessionNames(openSessions)) {
    parts.push(`${WORKSPACE_TAB_SEARCH_PARAM}=${encodeURIComponent(sessionName)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function createSessionWorkspace(activeSession?: string): SessionWorkspaceState {
  if (!activeSession) return { openSessions: [], recentSessions: [] };
  return { openSessions: [activeSession], recentSessions: [activeSession] };
}

export function visitWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  const openSessions = workspace.openSessions.includes(sessionName)
    ? workspace.openSessions
    : [...workspace.openSessions, sessionName];
  const recentSessions = [
    sessionName,
    ...workspace.recentSessions.filter((name) => name !== sessionName),
  ].slice(0, MAX_RECENT_SESSIONS);

  if (
    openSessions === workspace.openSessions
    && recentSessions.length === workspace.recentSessions.length
    && recentSessions.every((name, index) => name === workspace.recentSessions[index])
  ) return workspace;

  return { openSessions, recentSessions };
}

export function restoreWorkspaceTabs(
  workspace: SessionWorkspaceState,
  activeSession: string | undefined,
  orderedTabs: readonly string[],
): SessionWorkspaceState {
  const openSessions = uniqueSessionNames(orderedTabs);
  if (activeSession && !openSessions.includes(activeSession)) openSessions.push(activeSession);

  let recentSessions = [...workspace.recentSessions];
  for (const sessionName of [...openSessions].reverse()) {
    if (!recentSessions.includes(sessionName)) recentSessions.push(sessionName);
  }
  if (activeSession) {
    recentSessions = [
      activeSession,
      ...recentSessions.filter((sessionName) => sessionName !== activeSession),
    ];
  }
  recentSessions = recentSessions.slice(0, MAX_RECENT_SESSIONS);

  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
  ) return workspace;

  return { openSessions, recentSessions };
}

export function closeWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  if (!workspace.openSessions.includes(sessionName)) return workspace;
  return {
    ...workspace,
    openSessions: workspace.openSessions.filter((name) => name !== sessionName),
  };
}

export function moveWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
  targetIndex: number,
): SessionWorkspaceState {
  const currentIndex = workspace.openSessions.indexOf(sessionName);
  if (currentIndex < 0 || !Number.isInteger(targetIndex)) return workspace;

  const boundedTargetIndex = Math.max(
    0,
    Math.min(targetIndex, workspace.openSessions.length - 1),
  );
  if (currentIndex === boundedTargetIndex) return workspace;

  const openSessions = [...workspace.openSessions];
  const [movedSession] = openSessions.splice(currentIndex, 1);
  openSessions.splice(boundedTargetIndex, 0, movedSession);
  return { ...workspace, openSessions };
}

export function renameWorkspaceSession(
  workspace: SessionWorkspaceState,
  previousName: string,
  nextName: string,
): SessionWorkspaceState {
  if (!previousName || !nextName || previousName === nextName) return workspace;

  const rename = (sessionNames: readonly string[]) => uniqueSessionNames(
    sessionNames.map((sessionName) => (
      sessionName === previousName ? nextName : sessionName
    )),
  );
  const openSessions = rename(workspace.openSessions);
  const recentSessions = rename(workspace.recentSessions);
  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
  ) return workspace;
  return { openSessions, recentSessions };
}

export function clearClosedWorkspaceHistory(
  workspace: SessionWorkspaceState,
): SessionWorkspaceState {
  const open = new Set(workspace.openSessions);
  const recentSessions = workspace.recentSessions.filter((name) => open.has(name));
  if (recentSessions.length === workspace.recentSessions.length) return workspace;
  return { ...workspace, recentSessions };
}

export function sessionAfterClose(
  openSessions: readonly string[],
  closingSession: string,
): string | null {
  const closingIndex = openSessions.indexOf(closingSession);
  if (closingIndex < 0) return null;
  const remaining = openSessions.filter((name) => name !== closingSession);
  if (remaining.length === 0) return null;
  return remaining[Math.min(closingIndex, remaining.length - 1)];
}
