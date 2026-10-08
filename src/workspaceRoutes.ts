export const NEW_SESSION_PATH = "/sessions/new";

export interface SessionRoute {
  sessionName: string;
  recentsOpen: boolean;
}

export interface NewSessionRoute {
  recentsOpen: boolean;
}

export interface PaneLayoutRoute {
  layoutId: string;
}

function decodeSessionName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseSessionRoute(path: string): SessionRoute | null {
  const match = path.match(/^\/session\/(.+?)(\/recents)?\/?$/);
  if (!match) return null;
  return {
    sessionName: decodeSessionName(match[1]),
    recentsOpen: Boolean(match[2]),
  };
}

export function sessionPath(sessionName: string, recentsOpen = false): string {
  const base = `/session/${encodeURIComponent(sessionName)}`;
  return recentsOpen ? `${base}/recents` : base;
}

export function parseNewSessionRoute(path: string): NewSessionRoute | null {
  const match = path.match(/^\/sessions\/new(\/recents)?\/?$/);
  return match ? { recentsOpen: Boolean(match[1]) } : null;
}

export function newSessionPath(recentsOpen = false): string {
  return recentsOpen ? `${NEW_SESSION_PATH}/recents` : NEW_SESSION_PATH;
}

export function parsePaneLayoutRoute(path: string): PaneLayoutRoute | null {
  const match = path.match(/^\/panes\/([^/]+)\/?$/);
  return match ? { layoutId: decodeSessionName(match[1]) } : null;
}

export function paneLayoutPath(layoutId: string): string {
  return `/panes/${encodeURIComponent(layoutId)}`;
}

export function isWorkspaceRoute(path: string): boolean {
  return Boolean(parseSessionRoute(path) || parseNewSessionRoute(path) || parsePaneLayoutRoute(path));
}
