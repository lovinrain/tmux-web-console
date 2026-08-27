import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApiRequestError,
  BASE_PATH,
  createWorkspace,
  getWorkspace,
  listSessions,
  terminateSession,
  transferSessionToWorkspace,
  updateWorkspaceActivity,
  type SavedWorkspace,
  type WorkspaceSessionTransferOperation,
} from "./api";
import {
  ConsoleScreen,
  DEFAULT_CONSOLE_BAR_VISIBILITY,
  type ConsoleBar,
  type MobileConsoleMode,
  type SessionRenameWarning,
} from "./components/ConsoleScreen";
import { SessionDashboard } from "./components/SessionDashboard";
import { DEFAULT_HISTORY_PANEL_WIDTH } from "./components/HistoryPanel";
import { NewSessionScreen } from "./components/NewSessionScreen";
import { ScopedStickyNotes } from "./components/ScopedStickyNotes";
import { WorkspaceQuickLinks } from "./components/WorkspaceQuickLinks";
import {
  SessionWorkspaceNavigation,
  WorkspaceTabSearchDialog,
  DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
  clampDesktopTabRailWidth,
  isCompactWorkspaceViewport,
  type OpenTabInNewWindowMode,
  type OpenTabInNewWindowResult,
  type WorkspaceTabOrientation,
  type WorkspacePersistenceState,
} from "./components/SessionWorkspaceNavigation";
import { SnippetLibrary } from "./components/SnippetLibrary";
import { ThemeProvider } from "./theme";
import type { Session } from "./types";
import {
  clearClosedWorkspaceHistory,
  closeWorkspaceSession,
  createSessionWorkspace,
  isolatedWorkspaceSearch,
  moveWorkspaceTabGroup,
  moveWorkspaceSession,
  removeWorkspaceTabGroup,
  renameWorkspaceSession,
  restoreWorkspaceTabs,
  savedWorkspaceIdFromSearch,
  searchWithSavedWorkspaceId,
  searchWithWorkspaceState,
  setWorkspaceTabGroup,
  setWorkspaceTabGroupCollapsed,
  sessionAfterClose,
  visitWorkspaceSession,
  workspaceGroupsFromSearch,
  workspaceTabsFromSearch,
  type SessionWorkspaceState,
  type WorkspaceTabGroup,
} from "./workspaceState";

interface MuxLocation {
  path: string;
  search: string;
}

interface SessionRoute {
  sessionName: string;
  recentsOpen: boolean;
}

interface NewSessionRoute {
  recentsOpen: boolean;
}

interface PendingRecentsNavigation {
  sessionName: string;
  sessionId?: string;
  replaceRestoredEntry?: boolean;
}

interface SessionRenameAlias {
  sessionId: string;
  nextName: string;
}

type SessionRenameAliases = Map<string, SessionRenameAlias[]>;

interface SessionHistoryBinding {
  name: string;
  sessionId?: string;
}

interface SessionHistoryBindings {
  route?: SessionHistoryBinding;
  tabs: SessionHistoryBinding[];
}

type SessionIdentity = Pick<
  Session,
  "id" | "created" | "serverStarted" | "serverPid"
>;

interface WorkspaceActivitySnapshot {
  workspaceId: string;
  tabs: string[];
  groups: WorkspaceTabGroup[];
  activeSession: string | null;
  sessionRevision: number;
}

type PendingWorkspaceSnapshot = Pick<SessionWorkspaceState, "openSessions" | "groups">;

interface ActiveWorkspaceIdentity {
  id: string;
  name: string;
}

interface WorkspaceSyncProblem {
  kind: "load" | "save" | "detached" | "create";
  message: string;
}

type NewSessionViewToken = symbol;

interface RoutedNewSessionScreenProps {
  onCreated: (name: string, sessionId: string, viewToken: NewSessionViewToken) => void;
  onCancel: () => void;
  onActiveChange: (viewToken: NewSessionViewToken, active: boolean) => void;
  sessionNavigation: ReactNode;
  workspaceLoading: boolean;
  desktopTabOrientation: WorkspaceTabOrientation;
}

const FROM_DASHBOARD_KEY = "muxdeckFromDashboard";
const SNIPPETS_FROM_DASHBOARD_KEY = "muxdeckSnippetsFromDashboard";
const NEW_SESSION_RETURN_SESSION_KEY = "muxdeckNewSessionReturnSession";
const RECENTS_ENTRY_KEY = "muxdeckRecentsEntry";
const SESSION_BINDINGS_KEY = "muxdeckSessionBindings";
const DESKTOP_TAB_ORIENTATION_KEY = "muxdeck-desktop-tab-orientation";
const DESKTOP_TAB_RAIL_WIDTH_KEY = "muxdeck-desktop-tab-rail-width";
const DESKTOP_TAB_ACTIONS_VISIBLE_KEY = "muxdeck-desktop-tab-actions-visible";
const NEW_SESSION_PATH = "/sessions/new";
const WORKSPACE_ACTIVITY_DEBOUNCE_MS = 400;

function storedDesktopTabOrientation(): WorkspaceTabOrientation {
  try {
    const stored = window.localStorage.getItem(DESKTOP_TAB_ORIENTATION_KEY);
    if (stored === "horizontal" || stored === "vertical") return stored;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return "horizontal";
}

function storedDesktopTabRailWidth(): number {
  try {
    const stored = window.localStorage.getItem(DESKTOP_TAB_RAIL_WIDTH_KEY);
    if (stored !== null && stored.trim() !== "") {
      const width = Number(stored);
      if (Number.isFinite(width)) return clampDesktopTabRailWidth(width);
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return DEFAULT_DESKTOP_TAB_RAIL_WIDTH;
}

function storedDesktopTabActionsVisible(): boolean {
  try {
    const stored = window.localStorage.getItem(DESKTOP_TAB_ACTIONS_VISIBLE_KEY);
    if (stored === "false") return false;
    if (stored === "true") return true;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return true;
}

function workspaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sameWorkspaceActivity(
  left: WorkspaceActivitySnapshot | null,
  right: WorkspaceActivitySnapshot,
): boolean {
  return Boolean(
    left
    && left.workspaceId === right.workspaceId
    && left.sessionRevision === right.sessionRevision
    && left.activeSession === right.activeSession
    && left.tabs.length === right.tabs.length
    && left.tabs.every((tab, index) => tab === right.tabs[index])
    && sameWorkspaceGroups(left.groups, right.groups),
  );
}

function sameWorkspaceGroups(
  left: readonly WorkspaceTabGroup[],
  right: readonly WorkspaceTabGroup[],
): boolean {
  return left.length === right.length && left.every((group, index) => {
    const other = right[index];
    return Boolean(
      other
      && group.id === other.id
      && group.name === other.name
      && group.color === other.color
      && group.collapsed === other.collapsed
      && group.tabs.length === other.tabs.length
      && group.tabs.every((tab, tabIndex) => tab === other.tabs[tabIndex]),
    );
  });
}

function workspaceActivityUrl(workspaceId: string): string {
  return `${BASE_PATH}/api/workspaces/${encodeURIComponent(workspaceId)}/activity`;
}

function persistWorkspaceActivityOnPageHide(
  snapshot: WorkspaceActivitySnapshot,
  includeGroups: boolean,
): void {
  const body = JSON.stringify({
    tabs: snapshot.tabs,
    ...(includeGroups ? { groups: snapshot.groups } : {}),
    activeSession: snapshot.activeSession,
    sessionRevision: snapshot.sessionRevision,
  });
  const url = workspaceActivityUrl(snapshot.workspaceId);
  if (typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) {
        return;
      }
    } catch {
      // Fall through to a keepalive request when beacon delivery is unavailable.
    }
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function liveWorkspaceSession(
  savedWorkspace: SavedWorkspace,
  sessions: readonly Session[],
): string | null {
  const liveNames = new Set(sessions.map((session) => session.name));
  if (savedWorkspace.activeSession && liveNames.has(savedWorkspace.activeSession)) {
    return savedWorkspace.activeSession;
  }
  return savedWorkspace.tabs.find((sessionName) => liveNames.has(sessionName)) ?? null;
}

function hasSessionIdentity(session: Session, identity: SessionIdentity): boolean {
  return session.id === identity.id
    && session.created === identity.created
    && session.serverStarted === identity.serverStarted
    && session.serverPid === identity.serverPid;
}

function withoutTerminatedSessions(
  sessions: Session[],
  terminatedSessions: readonly SessionIdentity[],
): Session[] {
  if (terminatedSessions.length === 0) return sessions;
  return sessions.filter((session) => !terminatedSessions.some(
    (identity) => hasSessionIdentity(session, identity),
  ));
}

function isDashboardPath(path: string): boolean {
  return path === "/" || path === "";
}

function currentLocation(): MuxLocation {
  const path = window.location.pathname;
  const relative = BASE_PATH && path.startsWith(BASE_PATH)
    ? path.slice(BASE_PATH.length) || "/"
    : path;
  return { path: relative, search: window.location.search };
}

function targetUrl(path: string, search = window.location.search): string {
  return `${BASE_PATH}${path === "/" ? "/" : path}${search}`;
}

function decodeSessionName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseSessionRoute(path: string): SessionRoute | null {
  const match = path.match(/^\/session\/(.+?)(\/recents)?\/?$/);
  if (!match) return null;
  return {
    sessionName: decodeSessionName(match[1]),
    recentsOpen: Boolean(match[2]),
  };
}

function sessionPath(sessionName: string, recentsOpen = false): string {
  const base = `/session/${encodeURIComponent(sessionName)}`;
  return recentsOpen ? `${base}/recents` : base;
}

function parseNewSessionRoute(path: string): NewSessionRoute | null {
  const match = path.match(/^\/sessions\/new(\/recents)?\/?$/);
  return match ? { recentsOpen: Boolean(match[1]) } : null;
}

function newSessionPath(recentsOpen = false): string {
  return recentsOpen ? `${NEW_SESSION_PATH}/recents` : NEW_SESSION_PATH;
}

function withoutRecentsEntry(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const next = { ...(state as Record<string, unknown>) };
  delete next[RECENTS_ENTRY_KEY];
  return next;
}

function withoutNewSessionReturn(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const next = { ...(state as Record<string, unknown>) };
  delete next[NEW_SESSION_RETURN_SESSION_KEY];
  return next;
}

function newSessionReturnSession(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[NEW_SESSION_RETURN_SESSION_KEY];
  return typeof value === "string" && value ? value : null;
}

function historyStateRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : {};
}

function readSessionHistoryBindings(
  state: unknown,
  location: MuxLocation,
): SessionHistoryBindings | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[SESSION_BINDINGS_KEY];
  if (!value || typeof value !== "object") return null;
  const raw = value as { route?: unknown; tabs?: unknown };
  if (!Array.isArray(raw.tabs)) return null;

  const tabs = workspaceTabsFromSearch(location.search);
  if (raw.tabs.length !== tabs.length) return null;
  const parsedTabs: SessionHistoryBinding[] = [];
  for (let index = 0; index < raw.tabs.length; index += 1) {
    const item = raw.tabs[index];
    if (!item || typeof item !== "object") return null;
    const { name, sessionId } = item as { name?: unknown; sessionId?: unknown };
    if (
      typeof name !== "string"
      || name !== tabs[index]
      || (sessionId !== undefined && typeof sessionId !== "string")
    ) return null;
    parsedTabs.push({ name, ...(sessionId ? { sessionId } : {}) });
  }

  const route = parseSessionRoute(location.path);
  let parsedRoute: SessionHistoryBinding | undefined;
  if (raw.route !== undefined) {
    if (!raw.route || typeof raw.route !== "object" || !route) return null;
    const { name, sessionId } = raw.route as { name?: unknown; sessionId?: unknown };
    if (
      typeof name !== "string"
      || name !== route.sessionName
      || (sessionId !== undefined && typeof sessionId !== "string")
    ) return null;
    parsedRoute = { name, ...(sessionId ? { sessionId } : {}) };
  } else if (route) {
    return null;
  }

  return { route: parsedRoute, tabs: parsedTabs };
}

function resolveRenamedSession(
  sessionName: string,
  renames: SessionRenameAliases,
  knownSessions: readonly Session[],
  sessionId?: string,
): string {
  if (!sessionId) {
    const liveSession = knownSessions.find((session) => session.name === sessionName);
    if (liveSession) {
      return resolveRenamedSessionForId(sessionName, renames, liveSession.id);
    }
  }

  if (sessionId) return resolveRenamedSessionForId(sessionName, renames, sessionId);

  const candidates = renames.get(sessionName) || [];
  const resolved = new Set(candidates.map((alias) => (
    resolveRenamedSessionForId(sessionName, renames, alias.sessionId)
  )));
  return resolved.size === 1 ? [...resolved][0] : sessionName;
}

function removeRenameAlias(
  renames: SessionRenameAliases,
  sessionName: string,
  sessionId: string,
): void {
  const remaining = (renames.get(sessionName) || []).filter(
    (alias) => alias.sessionId !== sessionId,
  );
  if (remaining.length > 0) renames.set(sessionName, remaining);
  else renames.delete(sessionName);
}

function setRenameAlias(
  renames: SessionRenameAliases,
  sessionName: string,
  alias: SessionRenameAlias,
): void {
  const remaining = (renames.get(sessionName) || []).filter(
    (item) => item.sessionId !== alias.sessionId,
  );
  renames.set(sessionName, [...remaining, alias]);
}

function resolveRenamedSessionForId(
  sessionName: string,
  renames: SessionRenameAliases,
  sessionId: string,
): string {
  let resolved = sessionName;
  const seen = new Set<string>();
  while (!seen.has(resolved)) {
    seen.add(resolved);
    const alias = renames.get(resolved)?.find((item) => item.sessionId === sessionId);
    if (!alias) break;
    resolved = alias.nextName;
  }
  return resolved;
}

function reconcileRenamedSessions(
  sessions: Session[],
  renames: SessionRenameAliases,
): Session[] {
  let changed = false;
  const reconciled = sessions.map((session) => {
    const name = resolveRenamedSessionForId(session.name, renames, session.id);
    if (name === session.name) return session;
    changed = true;
    return { ...session, name };
  });
  return changed ? reconciled : sessions;
}

function recordSessionRename(
  renames: SessionRenameAliases,
  previousName: string,
  nextName: string,
  sessionId: string,
): void {
  const aliases = new Set<string>([previousName]);
  for (const alias of renames.keys()) {
    if (resolveRenamedSessionForId(alias, renames, sessionId) === previousName) {
      aliases.add(alias);
    }
  }
  removeRenameAlias(renames, nextName, sessionId);
  for (const alias of aliases) {
    if (alias === nextName) removeRenameAlias(renames, alias, sessionId);
    else setRenameAlias(renames, alias, { sessionId, nextName });
  }
}

function sessionIdForHistoryName(
  sessionName: string,
  sources: readonly SessionHistoryBindings[],
  knownSessions: readonly Session[],
  renames: SessionRenameAliases,
  overrides: readonly SessionHistoryBinding[],
): string | undefined {
  const override = overrides.find((binding) => (
    binding.name === sessionName && binding.sessionId
  ));
  if (override?.sessionId) return override.sessionId;

  const sourceBindings = sources.flatMap((source) => (
    source.route ? [source.route, ...source.tabs] : source.tabs
  ));
  const carried = sourceBindings.find((binding) => (
    binding.sessionId
    && resolveRenamedSessionForId(binding.name, renames, binding.sessionId) === sessionName
  ));
  if (carried?.sessionId) return carried.sessionId;

  const liveSession = knownSessions.find((session) => (
    session.name === sessionName
    && resolveRenamedSessionForId(session.name, renames, session.id) === sessionName
  ));
  if (liveSession) return liveSession.id;

  const aliasIds = new Set<string>();
  for (const [alias, candidates] of renames) {
    for (const candidate of candidates) {
      if (resolveRenamedSessionForId(alias, renames, candidate.sessionId) === sessionName) {
        aliasIds.add(candidate.sessionId);
      }
    }
  }
  return aliasIds.size === 1 ? [...aliasIds][0] : undefined;
}

function withSessionHistoryBindings(
  state: unknown,
  location: MuxLocation,
  knownSessions: readonly Session[],
  renames: SessionRenameAliases,
  sources: readonly SessionHistoryBindings[] = [],
  overrides: readonly SessionHistoryBinding[] = [],
): Record<string, unknown> {
  const next = historyStateRecord(state);
  const route = parseSessionRoute(location.path);
  const tabs = workspaceTabsFromSearch(location.search);
  if (!route && tabs.length === 0) {
    delete next[SESSION_BINDINGS_KEY];
    return next;
  }

  const bind = (name: string): SessionHistoryBinding => {
    const sessionId = sessionIdForHistoryName(
      name,
      sources,
      knownSessions,
      renames,
      overrides,
    );
    return { name, ...(sessionId ? { sessionId } : {}) };
  };
  const bindings: SessionHistoryBindings = {
    ...(route ? { route: bind(route.sessionName) } : {}),
    tabs: tabs.map(bind),
  };
  next[SESSION_BINDINGS_KEY] = bindings;
  return next;
}

function sessionHistoryBindingsMatch(left: unknown, right: unknown): boolean {
  const leftValue = left && typeof left === "object"
    ? (left as Record<string, unknown>)[SESSION_BINDINGS_KEY]
    : undefined;
  const rightValue = right && typeof right === "object"
    ? (right as Record<string, unknown>)[SESSION_BINDINGS_KEY]
    : undefined;
  return JSON.stringify(leftValue) === JSON.stringify(rightValue);
}

function canonicalizeRenamedLocation(
  location: MuxLocation,
  renames: SessionRenameAliases,
  knownSessions: readonly Session[],
  bindings?: SessionHistoryBindings | null,
  routeSessionId?: string,
): MuxLocation {
  if (renames.size === 0) return location;
  const route = parseSessionRoute(location.path);
  const path = route
    ? sessionPath(
      resolveRenamedSession(
        route.sessionName,
        renames,
        knownSessions,
        routeSessionId ?? bindings?.route?.sessionId,
      ),
      route.recentsOpen,
    )
    : location.path;
  const sourceTabs = workspaceTabsFromSearch(location.search);
  const sourceGroups = workspaceGroupsFromSearch(location.search, sourceTabs);
  const tabs = sourceTabs.map(
    (sessionName, index) => resolveRenamedSession(
      sessionName,
      renames,
      knownSessions,
      bindings?.tabs[index]?.sessionId,
    ),
  );
  const groups = sourceGroups.map((group) => ({
    ...group,
    tabs: group.tabs.map((sessionName) => {
      const index = sourceTabs.indexOf(sessionName);
      return resolveRenamedSession(
        sessionName,
        renames,
        knownSessions,
        index >= 0 ? bindings?.tabs[index]?.sessionId : undefined,
      );
    }),
  }));
  const search = searchWithWorkspaceState(location.search, tabs, groups);
  return path === location.path && search === location.search
    ? location
    : { path, search };
}

function RoutedNewSessionScreen({
  onCreated,
  onCancel,
  onActiveChange,
  sessionNavigation,
  workspaceLoading,
  desktopTabOrientation,
}: RoutedNewSessionScreenProps) {
  const viewToken = useRef(Symbol("muxdeck-new-session-view")).current;

  useLayoutEffect(() => {
    onActiveChange(viewToken, true);
    return () => onActiveChange(viewToken, false);
  }, [onActiveChange, viewToken]);

  return (
    <NewSessionScreen
      onCreated={(name, sessionId) => onCreated(name, sessionId, viewToken)}
      onCancel={onCancel}
      sessionNavigation={sessionNavigation}
      workspaceLoading={workspaceLoading}
      desktopTabOrientation={desktopTabOrientation}
    />
  );
}

function AppRoutes() {
  const [location, setLocation] = useState(currentLocation);
  const [consoleBars, setConsoleBars] = useState(DEFAULT_CONSOLE_BAR_VISIBILITY);
  const [desktopTabOrientation, setDesktopTabOrientationState] =
    useState<WorkspaceTabOrientation>(storedDesktopTabOrientation);
  const [desktopTabRailWidth, setDesktopTabRailWidthState] =
    useState(storedDesktopTabRailWidth);
  const [desktopTabActionsVisible, setDesktopTabActionsVisibleState] =
    useState(storedDesktopTabActionsVisible);
  const [mobileConsoleMode, setMobileConsoleMode] = useState<MobileConsoleMode>(
    "terminal",
  );
  const [historyPanelWidth, setHistoryPanelWidth] = useState(
    DEFAULT_HISTORY_PANEL_WIDTH,
  );
  const [workspace, setWorkspace] = useState<SessionWorkspaceState>(() => {
    const initialLocation = currentLocation();
    const route = parseSessionRoute(initialLocation.path);
    const tabs = workspaceTabsFromSearch(initialLocation.search, route?.sessionName);
    return restoreWorkspaceTabs(
      createSessionWorkspace(),
      route?.sessionName,
      tabs,
      workspaceGroupsFromSearch(initialLocation.search, tabs),
    );
  });
  const [hydratedWorkspaceId, setHydratedWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceIdentity, setActiveWorkspaceIdentity] =
    useState<ActiveWorkspaceIdentity | null>(null);
  const [workspaceSyncProblem, setWorkspaceSyncProblem] = useState<WorkspaceSyncProblem | null>(
    null,
  );
  const [workspaceGroupsSupported, setWorkspaceGroupsSupported] = useState<boolean | null>(null);
  const [workspaceGroupsPending, setWorkspaceGroupsPending] = useState(false);
  const [dismissedWorkspaceSyncProblem, setDismissedWorkspaceSyncProblem] =
    useState<WorkspaceSyncProblem | null>(null);
  const [knownSessions, setKnownSessions] = useState<Session[]>([]);
  const [tabSearchOpen, setTabSearchOpen] = useState(false);
  const [renameWarnings, setRenameWarnings] = useState<Map<string, SessionRenameWarning>>(
    () => new Map(),
  );
  const pendingRecentsNavigation = useRef<PendingRecentsNavigation | null>(null);
  const pendingWorkspaceSnapshot = useRef<PendingWorkspaceSnapshot | null>(null);
  const activeNewSessionView = useRef<NewSessionViewToken | null>(null);
  const sessionRenames = useRef<SessionRenameAliases>(new Map());
  const knownSessionsRef = useRef<Session[]>([]);
  const terminatedSessionsRef = useRef<SessionIdentity[]>([]);
  const locationRef = useRef(location);
  const workspaceRef = useRef(workspace);
  const hydratedWorkspaceIdRef = useRef<string | null>(null);
  const activeWorkspaceIdentityRef = useRef<ActiveWorkspaceIdentity | null>(null);
  const workspaceHydrationRequest = useRef(0);
  const workspaceHydrationInFlight = useRef<string | null>(null);
  const workspaceSessionRevision = useRef<{
    workspaceId: string;
    value: number;
  } | null>(null);
  const workspaceGroupsSupportedRef = useRef<boolean | null>(null);
  const workspaceGroupsProbeInFlight = useRef<symbol | null>(null);
  const workspaceActivityTimer = useRef<number | null>(null);
  const stagedWorkspaceActivity = useRef<WorkspaceActivitySnapshot | null>(null);
  const queuedWorkspaceActivities = useRef<WorkspaceActivitySnapshot[]>([]);
  const failedWorkspaceActivity = useRef<WorkspaceActivitySnapshot | null>(null);
  const lastSavedWorkspaceActivity = useRef<WorkspaceActivitySnapshot | null>(null);
  const workspaceActivityRunning = useRef(false);
  const workspaceActivityInFlight = useRef<WorkspaceActivitySnapshot | null>(null);
  const workspaceActivityFlush = useRef<() => void>(() => undefined);
  const workspaceActivityCommit = useRef<() => void>(() => undefined);
  const workspaceActivitySuppressedFor = useRef<string | null>(null);
  const navigationGeneration = useRef(0);
  const focusDashboardAfterSessionClose = useRef(false);
  const focusWorkspaceTabAfterNavigation = useRef<string | null>(null);
  const appMounted = useRef(true);

  const setDesktopTabOrientation = useCallback((orientation: WorkspaceTabOrientation) => {
    setDesktopTabOrientationState(orientation);
    try {
      window.localStorage.setItem(DESKTOP_TAB_ORIENTATION_KEY, orientation);
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  }, []);

  const setDesktopTabRailWidth = useCallback((width: number) => {
    const clampedWidth = clampDesktopTabRailWidth(width);
    setDesktopTabRailWidthState(clampedWidth);
    try {
      window.localStorage.setItem(DESKTOP_TAB_RAIL_WIDTH_KEY, String(clampedWidth));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  }, []);

  const setDesktopTabActionsVisible = useCallback((visible: boolean) => {
    setDesktopTabActionsVisibleState(visible);
    try {
      window.localStorage.setItem(DESKTOP_TAB_ACTIONS_VISIBLE_KEY, String(visible));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  }, []);

  locationRef.current = location;
  workspaceRef.current = workspace;

  const recordWorkspaceGroupsSupport = useCallback((supported: boolean | null) => {
    workspaceGroupsSupportedRef.current = supported;
    setWorkspaceGroupsSupported(supported);
    if (supported === null) {
      workspaceGroupsProbeInFlight.current = null;
      setWorkspaceGroupsPending(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (!focusDashboardAfterSessionClose.current || !isDashboardPath(location.path)) return;
    focusDashboardAfterSessionClose.current = false;
    document.querySelector<HTMLInputElement>(".search-field input")?.focus();
  }, [location.path]);

  useLayoutEffect(() => {
    const sessionName = focusWorkspaceTabAfterNavigation.current;
    const route = parseSessionRoute(location.path);
    if (!sessionName || route?.sessionName !== sessionName || route.recentsOpen) return;
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>(
      "#muxdeck-session-tabs [role='tab']",
    )).find((tab) => (
      tab.closest<HTMLElement>(".workspace-tab")?.dataset.workspaceSessionName === sessionName
    ));
    if (!target) return;
    focusWorkspaceTabAfterNavigation.current = null;
    target.focus();
  }, [location.path]);

  const setHydratedWorkspaceBinding = useCallback((workspaceId: string | null) => {
    hydratedWorkspaceIdRef.current = workspaceId;
    setHydratedWorkspaceId(workspaceId);
  }, []);

  const setWorkspaceIdentity = useCallback((workspace: ActiveWorkspaceIdentity | null) => {
    activeWorkspaceIdentityRef.current = workspace;
    setActiveWorkspaceIdentity(workspace);
  }, []);

  useEffect(() => {
    appMounted.current = true;
    return () => {
      appMounted.current = false;
      workspaceHydrationRequest.current += 1;
      workspaceHydrationInFlight.current = null;
      if (workspaceActivityTimer.current !== null) {
        window.clearTimeout(workspaceActivityTimer.current);
        workspaceActivityTimer.current = null;
      }
    };
  }, []);

  const stateForLocation = useCallback((
    state: unknown,
    path: string,
    search: string,
    overrides: readonly SessionHistoryBinding[] = [],
  ) => {
    const sourceBindings = readSessionHistoryBindings(
      window.history.state,
      currentLocation(),
    );
    return withSessionHistoryBindings(
      state,
      { path, search },
      knownSessionsRef.current,
      sessionRenames.current,
      sourceBindings ? [sourceBindings] : [],
      overrides,
    );
  }, []);

  const replaceLocation = useCallback((
    state: unknown,
    path: string,
    search: string,
    overrides: readonly SessionHistoryBinding[] = [],
  ) => {
    navigationGeneration.current += 1;
    window.history.replaceState(
      stateForLocation(state, path, search, overrides),
      "",
      targetUrl(path, search),
    );
  }, [stateForLocation]);

  const pushLocation = useCallback((
    state: unknown,
    path: string,
    search: string,
    overrides: readonly SessionHistoryBinding[] = [],
  ) => {
    navigationGeneration.current += 1;
    window.history.pushState(
      stateForLocation(state, path, search, overrides),
      "",
      targetUrl(path, search),
    );
  }, [stateForLocation]);

  const detachSavedWorkspace = useCallback((message?: string) => {
    const detachedWorkspaceId = hydratedWorkspaceIdRef.current;
    workspaceHydrationRequest.current += 1;
    workspaceHydrationInFlight.current = null;
    workspaceSessionRevision.current = null;
    recordWorkspaceGroupsSupport(null);
    setHydratedWorkspaceBinding(null);
    setWorkspaceIdentity(null);
    if (stagedWorkspaceActivity.current?.workspaceId === detachedWorkspaceId) {
      stagedWorkspaceActivity.current = null;
    }
    queuedWorkspaceActivities.current = queuedWorkspaceActivities.current.filter(
      (activity) => activity.workspaceId !== detachedWorkspaceId,
    );
    failedWorkspaceActivity.current = null;
    lastSavedWorkspaceActivity.current = null;
    if (workspaceActivityTimer.current !== null) {
      window.clearTimeout(workspaceActivityTimer.current);
      workspaceActivityTimer.current = null;
    }

    const current = currentLocation();
    const search = searchWithSavedWorkspaceId(
      searchWithWorkspaceState(
        current.search,
        workspaceRef.current.openSessions,
        workspaceRef.current.groups,
      ),
      null,
    );
    replaceLocation(window.history.state, current.path, search);
    setLocation({ path: current.path, search });
    setWorkspaceSyncProblem(message ? { kind: "detached", message } : null);
  }, [
    recordWorkspaceGroupsSupport,
    replaceLocation,
    setHydratedWorkspaceBinding,
    setWorkspaceIdentity,
  ]);

  const hydrateSavedWorkspace = useCallback(async (
    workspaceId: string,
    resume = false,
    revisionFence?: number,
  ) => {
    workspaceActivityCommit.current();
    const requestId = ++workspaceHydrationRequest.current;
    workspaceHydrationInFlight.current = workspaceId;
    workspaceSessionRevision.current = revisionFence === undefined
      ? null
      : { workspaceId, value: revisionFence };
    recordWorkspaceGroupsSupport(null);
    setHydratedWorkspaceBinding(null);
    if (activeWorkspaceIdentityRef.current?.id !== workspaceId) {
      setWorkspaceIdentity(null);
    }
    failedWorkspaceActivity.current = null;
    setWorkspaceSyncProblem(null);

    try {
      const [savedWorkspace, sessions] = await Promise.all([
        getWorkspace(workspaceId),
        listSessions().catch(() => knownSessionsRef.current),
      ]);
      if (
        !appMounted.current
        || requestId !== workspaceHydrationRequest.current
        || savedWorkspaceIdFromSearch(currentLocation().search) !== workspaceId
      ) return;

      const currentSessions = withoutTerminatedSessions(
        sessions,
        terminatedSessionsRef.current,
      );
      const targetSession = liveWorkspaceSession(savedWorkspace, currentSessions);
      const restoredWorkspace = restoreWorkspaceTabs(
        createSessionWorkspace(),
        savedWorkspace.activeSession ?? targetSession ?? undefined,
        savedWorkspace.tabs,
        savedWorkspace.groups ?? [],
      );
      workspaceRef.current = restoredWorkspace;
      setWorkspace(restoredWorkspace);
      knownSessionsRef.current = currentSessions;
      setKnownSessions(currentSessions);
      failedWorkspaceActivity.current = null;
      lastSavedWorkspaceActivity.current = null;
      recordWorkspaceGroupsSupport(Array.isArray(savedWorkspace.groups));
      workspaceSessionRevision.current = {
        workspaceId,
        value: savedWorkspace.sessionRevision,
      };
      setWorkspaceIdentity({ id: workspaceId, name: savedWorkspace.name });
      setHydratedWorkspaceBinding(workspaceId);
      workspaceHydrationInFlight.current = null;

      const current = currentLocation();
      const route = parseSessionRoute(current.path);
      let path = current.path;
      if (route || (resume && isDashboardPath(current.path))) {
        path = targetSession
          ? sessionPath(targetSession, Boolean(route?.recentsOpen))
          : "/";
      }
      const search = searchWithSavedWorkspaceId(
        searchWithWorkspaceState(
          current.search,
          savedWorkspace.tabs,
          savedWorkspace.groups ?? [],
        ),
        workspaceId,
      );
      const liveTarget = targetSession
        ? currentSessions.find((session) => session.name === targetSession)
        : undefined;
      replaceLocation(
        window.history.state,
        path,
        search,
        liveTarget ? [{ name: liveTarget.name, sessionId: liveTarget.id }] : [],
      );
      setLocation({ path, search });
    } catch (error) {
      if (
        !appMounted.current
        || requestId !== workspaceHydrationRequest.current
        || savedWorkspaceIdFromSearch(currentLocation().search) !== workspaceId
      ) return;
      workspaceHydrationInFlight.current = null;
      if (error instanceof ApiRequestError && error.status === 404) {
        detachSavedWorkspace(
          "That saved workspace no longer exists. Its current tabs are still open as an unsaved workspace.",
        );
        return;
      }
      setHydratedWorkspaceBinding(null);
      setWorkspaceIdentity(null);
      setWorkspaceSyncProblem({
        kind: "load",
        message: workspaceErrorMessage(error, "Unable to load the saved workspace"),
      });
    }
  }, [
    detachSavedWorkspace,
    recordWorkspaceGroupsSupport,
    replaceLocation,
    setHydratedWorkspaceBinding,
    setWorkspaceIdentity,
  ]);

  const openSavedWorkspace = useCallback((savedWorkspace: SavedWorkspace) => {
    setWorkspaceIdentity({ id: savedWorkspace.id, name: savedWorkspace.name });
    const current = currentLocation();
    const search = searchWithSavedWorkspaceId(current.search, savedWorkspace.id);
    replaceLocation(window.history.state, current.path, search);
    setLocation({ path: current.path, search });
    void hydrateSavedWorkspace(savedWorkspace.id, true);
  }, [hydrateSavedWorkspace, replaceLocation, setWorkspaceIdentity]);

  const saveCurrentWorkspace = useCallback(async (name: string) => {
    const startingLocation = currentLocation();
    if (
      savedWorkspaceIdFromSearch(startingLocation.search)
      || hydratedWorkspaceIdRef.current
    ) {
      throw new Error("This workspace is already saved and syncing automatically.");
    }

    const currentWorkspace = workspaceRef.current;
    const tabs = [...currentWorkspace.openSessions];
    const groups = currentWorkspace.groups.map((group) => ({
      ...group,
      tabs: [...group.tabs],
    }));
    const route = parseSessionRoute(startingLocation.path);
    const activeSession = route && tabs.includes(route.sessionName)
      ? route.sessionName
      : null;
    const startingNavigationGeneration = navigationGeneration.current;
    const created = await createWorkspace({ name, tabs, groups, activeSession });
    if (!appMounted.current) return;

    const latestLocation = currentLocation();
    if (navigationGeneration.current !== startingNavigationGeneration) {
      const message = (
        "The workspace was saved on the server, but this page changed before it could be "
        + "opened. Find it in Sessions; this page was not changed."
      );
      setWorkspaceSyncProblem({ kind: "create", message });
      throw new Error(message);
    }
    if (
      savedWorkspaceIdFromSearch(latestLocation.search)
      || hydratedWorkspaceIdRef.current
    ) {
      throw new Error(
        "The workspace was saved, but this page switched workspaces before it could be opened. Find it in Sessions.",
      );
    }

    workspaceHydrationRequest.current += 1;
    workspaceHydrationInFlight.current = null;
    failedWorkspaceActivity.current = null;
    stagedWorkspaceActivity.current = null;
    if (workspaceActivityTimer.current !== null) {
      window.clearTimeout(workspaceActivityTimer.current);
      workspaceActivityTimer.current = null;
    }

    const createdGroupsSupported = Array.isArray(created.groups);
    const serverGroups = created.groups ?? [];
    const groupsPersisted = createdGroupsSupported
      && sameWorkspaceGroups(serverGroups, groups);
    const boundGroups = groupsPersisted ? serverGroups : groups;
    const boundWorkspace = restoreWorkspaceTabs(
      workspaceRef.current,
      created.activeSession ?? undefined,
      created.tabs,
      boundGroups,
    );
    workspaceRef.current = boundWorkspace;
    setWorkspace(boundWorkspace);
    workspaceSessionRevision.current = {
      workspaceId: created.id,
      value: created.sessionRevision,
    };
    recordWorkspaceGroupsSupport(createdGroupsSupported);
    setWorkspaceGroupsPending(!groupsPersisted && boundGroups.length > 0);
    lastSavedWorkspaceActivity.current = {
      workspaceId: created.id,
      tabs: [...created.tabs],
      groups: (createdGroupsSupported ? serverGroups : boundGroups).map((group) => ({
        ...group,
        tabs: [...group.tabs],
      })),
      activeSession: created.activeSession,
      sessionRevision: created.sessionRevision,
    };
    setWorkspaceIdentity({ id: created.id, name: created.name });
    setHydratedWorkspaceBinding(created.id);
    setWorkspaceSyncProblem(null);

    const search = searchWithSavedWorkspaceId(
      searchWithWorkspaceState(
        latestLocation.search,
        created.tabs,
        boundGroups,
      ),
      created.id,
    );
    replaceLocation(window.history.state, latestLocation.path, search);
    setLocation({ path: latestLocation.path, search });
  }, [
    recordWorkspaceGroupsSupport,
    replaceLocation,
    setHydratedWorkspaceBinding,
    setWorkspaceIdentity,
  ]);

  const syncLocation = useCallback(() => {
    const restoredLocation = currentLocation();
    const restoredBindings = readSessionHistoryBindings(
      window.history.state,
      restoredLocation,
    );
    const nextLocation = canonicalizeRenamedLocation(
      restoredLocation,
      sessionRenames.current,
      knownSessionsRef.current,
      restoredBindings,
    );
    const nextState = withSessionHistoryBindings(
      window.history.state,
      nextLocation,
      knownSessionsRef.current,
      sessionRenames.current,
      restoredBindings ? [restoredBindings] : [],
    );
    if (
      nextLocation.path !== restoredLocation.path
      || nextLocation.search !== restoredLocation.search
      || !sessionHistoryBindingsMatch(window.history.state, nextState)
    ) {
      window.history.replaceState(
        nextState,
        "",
        targetUrl(nextLocation.path, nextLocation.search),
      );
    }
    const savedWorkspaceId = savedWorkspaceIdFromSearch(nextLocation.search);
    if (savedWorkspaceId && hydratedWorkspaceIdRef.current !== savedWorkspaceId) {
      setLocation(nextLocation);
      return;
    }
    const route = parseSessionRoute(nextLocation.path);
    const orderedTabs = workspaceTabsFromSearch(
      nextLocation.search,
      route?.sessionName,
    );
    const orderedGroups = workspaceGroupsFromSearch(nextLocation.search, orderedTabs);
    setWorkspace((current) => restoreWorkspaceTabs(
      current,
      route?.sessionName,
      orderedTabs,
      orderedGroups,
    ));
    setLocation(nextLocation);
  }, []);

  const setConsoleBarVisibility = useCallback((bar: ConsoleBar, visible: boolean) => {
    setConsoleBars((current) => (
      current[bar] === visible ? current : { ...current, [bar]: visible }
    ));
  }, []);

  useEffect(() => {
    const update = () => {
      navigationGeneration.current += 1;
      const pending = pendingRecentsNavigation.current;
      const pendingWorkspace = pendingWorkspaceSnapshot.current;
      if (pending) {
        pendingRecentsNavigation.current = null;
        const overrides = pending.sessionId
          ? [{ name: pending.sessionName, sessionId: pending.sessionId }]
          : [];
        const restored = currentLocation();
        const restoredSearch = searchWithWorkspaceState(
          restored.search,
          workspaceRef.current.openSessions,
          workspaceRef.current.groups,
        );
        if (pending.replaceRestoredEntry) {
          replaceLocation(
            withoutNewSessionReturn(withoutRecentsEntry(window.history.state)),
            sessionPath(pending.sessionName),
            restoredSearch,
            overrides,
          );
          syncLocation();
          return;
        }
        replaceLocation(
          window.history.state,
          restored.path,
          restoredSearch,
          overrides,
        );
        pushLocation(
          { [FROM_DASHBOARD_KEY]: true },
          sessionPath(pending.sessionName),
          restoredSearch,
          overrides,
        );
      } else {
        const restored = currentLocation();
        const restoredWorkspaceId = savedWorkspaceIdFromSearch(restored.search);
        const previousWorkspaceId = savedWorkspaceIdFromSearch(locationRef.current.search);
        const sameWorkspace = restoredWorkspaceId === previousWorkspaceId;
        const restoredWorkspace = pendingWorkspace
          ?? (sameWorkspace
            ? {
                openSessions: workspaceRef.current.openSessions,
                groups: workspaceRef.current.groups,
              }
            : null);
        if (!restoredWorkspace) {
          const savedWorkspaceId = savedWorkspaceIdFromSearch(restored.search);
          if (savedWorkspaceId) {
            setLocation(restored);
            void hydrateSavedWorkspace(savedWorkspaceId);
            return;
          }
          syncLocation();
          return;
        }
        pendingWorkspaceSnapshot.current = null;
        replaceLocation(
          window.history.state,
          restored.path,
          searchWithWorkspaceState(
            restored.search,
            restoredWorkspace.openSessions,
            restoredWorkspace.groups,
          ),
        );
      }
      syncLocation();
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [hydrateSavedWorkspace, pushLocation, replaceLocation, syncLocation]);

  useEffect(() => {
    const browserLocation = currentLocation();
    if (
      browserLocation.path !== location.path
      || browserLocation.search !== location.search
    ) return;
    const savedWorkspaceId = savedWorkspaceIdFromSearch(location.search);
    if (!savedWorkspaceId) {
      recordWorkspaceGroupsSupport(null);
      setWorkspaceSyncProblem((current) => (
        current?.kind === "load" || current?.kind === "save" ? null : current
      ));
      setDismissedWorkspaceSyncProblem(null);
      workspaceHydrationRequest.current += 1;
      workspaceHydrationInFlight.current = null;
      setWorkspaceIdentity(null);
      if (hydratedWorkspaceIdRef.current !== null) {
        workspaceActivityCommit.current();
        setHydratedWorkspaceBinding(null);
        workspaceSessionRevision.current = null;
        failedWorkspaceActivity.current = null;
        lastSavedWorkspaceActivity.current = null;
      }
      return;
    }
    if (
      hydratedWorkspaceIdRef.current !== savedWorkspaceId
      && workspaceHydrationInFlight.current !== savedWorkspaceId
    ) {
      void hydrateSavedWorkspace(savedWorkspaceId);
    }
  }, [
    hydrateSavedWorkspace,
    location.search,
    recordWorkspaceGroupsSupport,
    setHydratedWorkspaceBinding,
    setWorkspaceIdentity,
  ]);

  const activeRoute = parseSessionRoute(location.path);
  const newSessionRoute = parseNewSessionRoute(location.path);
  const locationWorkspaceId = savedWorkspaceIdFromSearch(location.search);
  const workspaceName = (
    locationWorkspaceId && activeWorkspaceIdentity?.id === locationWorkspaceId
      ? activeWorkspaceIdentity.name
      : null
  );
  const workspacePersistenceState: WorkspacePersistenceState = (
    !locationWorkspaceId
      ? "unsaved"
      : workspaceSyncProblem?.kind === "load" || workspaceSyncProblem?.kind === "save"
        ? "error"
        : hydratedWorkspaceId === locationWorkspaceId
          ? (workspaceGroupsSupported === false || workspaceGroupsPending)
              && workspace.groups.length > 0
            ? "limited"
            : "saved"
          : "loading"
  );

  useEffect(() => {
    const browserLocation = currentLocation();
    if (
      browserLocation.path !== location.path
      || browserLocation.search !== location.search
    ) return;
    const savedWorkspaceId = savedWorkspaceIdFromSearch(location.search);
    if (savedWorkspaceId && hydratedWorkspaceIdRef.current !== savedWorkspaceId) return;
    const route = parseSessionRoute(location.path);
    const orderedTabs = workspaceTabsFromSearch(location.search, route?.sessionName);
    const orderedGroups = workspaceGroupsFromSearch(location.search, orderedTabs);
    setWorkspace((current) => restoreWorkspaceTabs(
      current,
      route?.sessionName,
      orderedTabs,
      orderedGroups,
    ));

    const canonicalSearch = searchWithWorkspaceState(
      location.search,
      orderedTabs,
      orderedGroups,
    );
    if (canonicalSearch === location.search) return;
    replaceLocation(
      window.history.state,
      location.path,
      canonicalSearch,
    );
    syncLocation();
  }, [location.path, location.search, replaceLocation, syncLocation]);

  const flushWorkspaceActivity = useCallback(() => {
    if (workspaceActivityRunning.current || !appMounted.current) return;
    const snapshot = queuedWorkspaceActivities.current.shift();
    if (!snapshot) return;
    workspaceActivityRunning.current = true;
    workspaceActivityInFlight.current = snapshot;

    void updateWorkspaceActivity(
      snapshot.workspaceId,
      snapshot.tabs,
      snapshot.groups,
      snapshot.activeSession,
      snapshot.sessionRevision,
    ).then((savedWorkspace) => {
      if (
        !appMounted.current
        || hydratedWorkspaceIdRef.current !== snapshot.workspaceId
        || savedWorkspaceIdFromSearch(currentLocation().search) !== snapshot.workspaceId
      ) return;
      const currentRevision = workspaceSessionRevision.current;
      if (
        currentRevision?.workspaceId === snapshot.workspaceId
        && currentRevision.value > snapshot.sessionRevision
      ) return;
      workspaceSessionRevision.current = {
        workspaceId: snapshot.workspaceId,
        value: savedWorkspace.sessionRevision,
      };
      const savedGroupsSupported = Array.isArray(savedWorkspace.groups);
      const savedGroups = savedWorkspace.groups ?? [];
      const groupsPersisted = savedGroupsSupported
        && sameWorkspaceGroups(savedGroups, snapshot.groups);
      recordWorkspaceGroupsSupport(savedGroupsSupported);
      setWorkspaceGroupsPending(!groupsPersisted && snapshot.groups.length > 0);
      setWorkspaceIdentity({ id: snapshot.workspaceId, name: savedWorkspace.name });
      lastSavedWorkspaceActivity.current = savedGroupsSupported && !groupsPersisted
        ? {
            ...snapshot,
            groups: savedGroups.map((group) => ({
              ...group,
              tabs: [...group.tabs],
            })),
          }
        : snapshot;
      if (failedWorkspaceActivity.current?.workspaceId === snapshot.workspaceId) {
        failedWorkspaceActivity.current = null;
        setWorkspaceSyncProblem((current) => (
          current?.kind === "save" ? null : current
        ));
      }
    }).catch((error: unknown) => {
      if (
        !appMounted.current
        || hydratedWorkspaceIdRef.current !== snapshot.workspaceId
        || savedWorkspaceIdFromSearch(currentLocation().search) !== snapshot.workspaceId
      ) return;
      if (error instanceof ApiRequestError && error.status === 404) {
        detachSavedWorkspace(
          "That workspace was deleted on another device. Its tabs remain open here as an unsaved workspace.",
        );
        return;
      }
      if (error instanceof ApiRequestError && error.status === 409) {
        const currentRevision = workspaceSessionRevision.current;
        if (
          currentRevision?.workspaceId === snapshot.workspaceId
          && currentRevision.value > snapshot.sessionRevision
        ) return;
        if (
          stagedWorkspaceActivity.current?.workspaceId === snapshot.workspaceId
          && stagedWorkspaceActivity.current.sessionRevision <= snapshot.sessionRevision
        ) {
          stagedWorkspaceActivity.current = null;
          if (workspaceActivityTimer.current !== null) {
            window.clearTimeout(workspaceActivityTimer.current);
            workspaceActivityTimer.current = null;
          }
        }
        queuedWorkspaceActivities.current = queuedWorkspaceActivities.current.filter(
          (activity) => (
            activity.workspaceId !== snapshot.workspaceId
            || activity.sessionRevision > snapshot.sessionRevision
          ),
        );
        if (
          failedWorkspaceActivity.current?.workspaceId === snapshot.workspaceId
          && failedWorkspaceActivity.current.sessionRevision <= snapshot.sessionRevision
        ) failedWorkspaceActivity.current = null;
        if (
          lastSavedWorkspaceActivity.current?.workspaceId === snapshot.workspaceId
          && lastSavedWorkspaceActivity.current.sessionRevision <= snapshot.sessionRevision
        ) lastSavedWorkspaceActivity.current = null;
        void hydrateSavedWorkspace(snapshot.workspaceId);
        return;
      }
      failedWorkspaceActivity.current = snapshot;
      setWorkspaceSyncProblem({
        kind: "save",
        message: workspaceErrorMessage(error, "Unable to save workspace changes"),
      });
    }).finally(() => {
      if (workspaceActivityInFlight.current === snapshot) {
        workspaceActivityInFlight.current = null;
      }
      workspaceActivityRunning.current = false;
      if (appMounted.current && queuedWorkspaceActivities.current.length > 0) {
        window.setTimeout(() => workspaceActivityFlush.current(), 0);
      }
    });
  }, [
    detachSavedWorkspace,
    hydrateSavedWorkspace,
    recordWorkspaceGroupsSupport,
    setWorkspaceIdentity,
  ]);

  workspaceActivityFlush.current = flushWorkspaceActivity;

  const commitStagedWorkspaceActivity = useCallback(() => {
    if (workspaceActivityTimer.current !== null) {
      window.clearTimeout(workspaceActivityTimer.current);
      workspaceActivityTimer.current = null;
    }
    const snapshot = stagedWorkspaceActivity.current;
    if (!snapshot) return;
    stagedWorkspaceActivity.current = null;
    const queued = queuedWorkspaceActivities.current;
    const lastQueued = queued.at(-1);
    if (lastQueued?.workspaceId === snapshot.workspaceId) {
      queued[queued.length - 1] = snapshot;
    } else {
      queued.push(snapshot);
    }
    workspaceActivityFlush.current();
  }, []);

  workspaceActivityCommit.current = commitStagedWorkspaceActivity;

  const queueWorkspaceActivity = useCallback((
    snapshot: WorkspaceActivitySnapshot,
    delay = WORKSPACE_ACTIVITY_DEBOUNCE_MS,
  ) => {
    if (sameWorkspaceActivity(stagedWorkspaceActivity.current, snapshot)) return;
    stagedWorkspaceActivity.current = snapshot;
    if (workspaceActivityTimer.current !== null) {
      window.clearTimeout(workspaceActivityTimer.current);
    }
    workspaceActivityTimer.current = window.setTimeout(() => {
      workspaceActivityCommit.current();
    }, delay);
  }, []);

  const currentWorkspaceActivitySnapshot = useCallback((): WorkspaceActivitySnapshot | null => {
    const workspaceId = hydratedWorkspaceIdRef.current;
    const sessionRevision = workspaceSessionRevision.current;
    const current = currentLocation();
    if (
      !workspaceId
      || workspaceActivitySuppressedFor.current === workspaceId
      || sessionRevision?.workspaceId !== workspaceId
      || savedWorkspaceIdFromSearch(current.search) !== workspaceId
    ) return null;

    const currentWorkspace = workspaceRef.current;
    const openSessions = currentWorkspace.openSessions;
    const route = parseSessionRoute(current.path);
    const liveNames = new Set(knownSessionsRef.current.map((session) => session.name));
    const activeSession = route && openSessions.includes(route.sessionName)
      ? route.sessionName
      : currentWorkspace.recentSessions.find((sessionName) => (
          openSessions.includes(sessionName) && liveNames.has(sessionName)
        )) ?? null;
    return {
      workspaceId,
      tabs: [...openSessions],
      groups: currentWorkspace.groups.map((group) => ({
        ...group,
        tabs: [...group.tabs],
      })),
      activeSession,
      sessionRevision: sessionRevision.value,
    };
  }, []);

  useEffect(() => {
    const saveLatestWorkspaceActivity = () => {
      const snapshot = currentWorkspaceActivitySnapshot();
      if (
        !snapshot
        || sameWorkspaceActivity(lastSavedWorkspaceActivity.current, snapshot)
      ) return;
      persistWorkspaceActivityOnPageHide(
        snapshot,
        workspaceGroupsSupportedRef.current !== false,
      );
    };

    window.addEventListener("pagehide", saveLatestWorkspaceActivity);
    return () => window.removeEventListener("pagehide", saveLatestWorkspaceActivity);
  }, [currentWorkspaceActivitySnapshot]);

  useEffect(() => {
    const snapshot = currentWorkspaceActivitySnapshot();
    if (
      !snapshot
      || hydratedWorkspaceId !== snapshot.workspaceId
    ) return;
    if (
      sameWorkspaceActivity(lastSavedWorkspaceActivity.current, snapshot)
      && !failedWorkspaceActivity.current
    ) return;
    queueWorkspaceActivity(snapshot);
  }, [
    currentWorkspaceActivitySnapshot,
    hydratedWorkspaceId,
    knownSessions,
    location.path,
    location.search,
    queueWorkspaceActivity,
    workspace.groups,
    workspaceGroupsPending,
    workspaceGroupsSupported,
    workspace.openSessions,
    workspace.recentSessions,
  ]);

  useEffect(() => {
    if (
      workspaceGroupsSupported !== false
      || workspace.groups.length === 0
      || hydratedWorkspaceId === null
    ) return;

    const probeWorkspaceGroups = () => {
      if (workspaceGroupsProbeInFlight.current) return;
      const workspaceId = hydratedWorkspaceIdRef.current;
      if (!workspaceId || savedWorkspaceIdFromSearch(currentLocation().search) !== workspaceId) {
        return;
      }
      const probeToken = Symbol("workspace-groups-probe");
      workspaceGroupsProbeInFlight.current = probeToken;
      void getWorkspace(workspaceId).then((savedWorkspace) => {
        if (
          !appMounted.current
          || hydratedWorkspaceIdRef.current !== workspaceId
          || savedWorkspaceIdFromSearch(currentLocation().search) !== workspaceId
          || !Array.isArray(savedWorkspace.groups)
        ) return;

        recordWorkspaceGroupsSupport(true);
        const snapshot = currentWorkspaceActivitySnapshot();
        if (!snapshot) return;
        if (sameWorkspaceGroups(savedWorkspace.groups, snapshot.groups)) {
          setWorkspaceGroupsPending(false);
          return;
        }
        setWorkspaceGroupsPending(true);
        queueWorkspaceActivity(snapshot, 0);
      }).catch(() => {
        // Capability checks are opportunistic; ordinary saves still report real failures.
      }).finally(() => {
        if (workspaceGroupsProbeInFlight.current === probeToken) {
          workspaceGroupsProbeInFlight.current = null;
        }
      });
    };
    const probeWhenVisible = () => {
      if (document.visibilityState === "visible") probeWorkspaceGroups();
    };

    window.addEventListener("focus", probeWorkspaceGroups);
    document.addEventListener("visibilitychange", probeWhenVisible);
    return () => {
      window.removeEventListener("focus", probeWorkspaceGroups);
      document.removeEventListener("visibilitychange", probeWhenVisible);
    };
  }, [
    currentWorkspaceActivitySnapshot,
    hydratedWorkspaceId,
    queueWorkspaceActivity,
    recordWorkspaceGroupsSupport,
    workspace.groups.length,
    workspaceGroupsSupported,
  ]);

  const openSession = useCallback((sessionName: string) => {
    const nextWorkspace = visitWorkspaceSession(workspace, sessionName);
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    const current = currentLocation();
    const nextSearch = searchWithWorkspaceState(
      current.search,
      nextWorkspace.openSessions,
      nextWorkspace.groups,
    );
    const liveSession = knownSessionsRef.current.find((session) => (
      session.name === sessionName
    ));
    const overrides = liveSession
      ? [{ name: sessionName, sessionId: liveSession.id }]
      : [];
    replaceLocation(
      window.history.state,
      current.path,
      nextSearch,
      overrides,
    );
    pushLocation(
      { [FROM_DASHBOARD_KEY]: true },
      sessionPath(sessionName),
      nextSearch,
      overrides,
    );
    syncLocation();
  }, [pushLocation, replaceLocation, syncLocation, workspace]);

  const openSessionInput = useCallback((sessionName: string) => {
    setMobileConsoleMode("input");
    openSession(sessionName);
  }, [openSession]);

  const resumeWorkspace = useCallback(() => {
    const currentWorkspace = workspaceRef.current;
    const liveNames = new Set(knownSessionsRef.current.map((session) => session.name));
    const target = hydratedWorkspaceIdRef.current
      ? currentWorkspace.recentSessions.find((sessionName) => (
          currentWorkspace.openSessions.includes(sessionName)
          && liveNames.has(sessionName)
        )) ?? currentWorkspace.openSessions.find((sessionName) => liveNames.has(sessionName))
      : currentWorkspace.recentSessions.find(
          (sessionName) => currentWorkspace.openSessions.includes(sessionName),
        ) ?? currentWorkspace.openSessions.at(-1);
    if (target) openSession(target);
  }, [openSession]);

  const openNewSession = useCallback(() => {
    const current = currentLocation();
    if (parseNewSessionRoute(current.path)) return;
    const nextSearch = searchWithWorkspaceState(
      current.search,
      workspace.openSessions,
      workspace.groups,
    );
    const currentRoute = parseSessionRoute(current.path);
    if (currentRoute && !currentRoute.recentsOpen) {
      replaceLocation(
        {
          ...historyStateRecord(window.history.state),
          [NEW_SESSION_RETURN_SESSION_KEY]: currentRoute.sessionName,
        },
        newSessionPath(),
        nextSearch,
      );
      syncLocation();
      return;
    }
    replaceLocation(
      window.history.state,
      current.path,
      nextSearch,
    );
    pushLocation(
      { [FROM_DASHBOARD_KEY]: true },
      newSessionPath(),
      nextSearch,
    );
    syncLocation();
  }, [pushLocation, replaceLocation, syncLocation, workspace]);

  const setNewSessionViewActive = useCallback((
    viewToken: NewSessionViewToken,
    active: boolean,
  ) => {
    if (active) {
      activeNewSessionView.current = viewToken;
    } else if (activeNewSessionView.current === viewToken) {
      activeNewSessionView.current = null;
    }
  }, []);

  const completeNewSession = useCallback((
    sessionName: string,
    sessionId: string,
    viewToken: NewSessionViewToken,
  ) => {
    const current = currentLocation();
    const newRoute = parseNewSessionRoute(current.path);
    const ownsCurrentView = Boolean(newRoute)
      && activeNewSessionView.current === viewToken;
    const currentWorkspace = workspaceRef.current;
    const nextWorkspace = ownsCurrentView
      ? visitWorkspaceSession(currentWorkspace, sessionName)
      : {
          ...currentWorkspace,
          openSessions: currentWorkspace.openSessions.includes(sessionName)
            ? currentWorkspace.openSessions
            : [...currentWorkspace.openSessions, sessionName],
        };
    workspaceRef.current = nextWorkspace;
    if (
      pendingWorkspaceSnapshot.current
      && !pendingWorkspaceSnapshot.current.openSessions.includes(sessionName)
    ) {
      pendingWorkspaceSnapshot.current = {
        ...pendingWorkspaceSnapshot.current,
        openSessions: [...pendingWorkspaceSnapshot.current.openSessions, sessionName],
      };
    }
    setWorkspace(nextWorkspace);
    const nextSearch = searchWithWorkspaceState(
      current.search,
      nextWorkspace.openSessions,
      nextWorkspace.groups,
    );
    const state = window.history.state as Record<string, unknown> | null;

    if (ownsCurrentView && newRoute?.recentsOpen && state?.[RECENTS_ENTRY_KEY] === true) {
      pendingRecentsNavigation.current = {
        sessionName,
        sessionId,
        replaceRestoredEntry: state[FROM_DASHBOARD_KEY] !== true,
      };
      if (state[FROM_DASHBOARD_KEY] === true) {
        window.history.go(-2);
      } else {
        window.history.back();
      }
      return;
    }

    replaceLocation(
      ownsCurrentView
        ? withoutNewSessionReturn(window.history.state)
        : window.history.state,
      ownsCurrentView ? sessionPath(sessionName) : current.path,
      nextSearch,
      [{ name: sessionName, sessionId }],
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const completeCopiedSession = useCallback((
    sourceName: string,
    sessionName: string,
    sessionId: string,
  ) => {
    const current = currentLocation();
    const route = parseSessionRoute(current.path);
    const ownsCurrentView = route?.sessionName === sourceName && !route.recentsOpen;
    const currentWorkspace = workspaceRef.current;
    const nextWorkspace = ownsCurrentView
      ? visitWorkspaceSession(currentWorkspace, sessionName)
      : {
          ...currentWorkspace,
          openSessions: currentWorkspace.openSessions.includes(sessionName)
            ? currentWorkspace.openSessions
            : [...currentWorkspace.openSessions, sessionName],
        };
    workspaceRef.current = nextWorkspace;
    if (
      pendingWorkspaceSnapshot.current
      && !pendingWorkspaceSnapshot.current.openSessions.includes(sessionName)
    ) {
      pendingWorkspaceSnapshot.current = {
        ...pendingWorkspaceSnapshot.current,
        openSessions: [...pendingWorkspaceSnapshot.current.openSessions, sessionName],
      };
    }
    setWorkspace(nextWorkspace);
    replaceLocation(
      window.history.state,
      ownsCurrentView ? sessionPath(sessionName) : current.path,
      searchWithWorkspaceState(
        current.search,
        nextWorkspace.openSessions,
        nextWorkspace.groups,
      ),
      [{ name: sessionName, sessionId }],
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const finishSessionSwitch = useCallback((
    sessionName: string,
    nextWorkspace: SessionWorkspaceState,
  ) => {
    workspaceRef.current = nextWorkspace;
    const current = currentLocation();
    const route = parseSessionRoute(current.path);
    const newRoute = parseNewSessionRoute(current.path);
    const nextSearch = searchWithWorkspaceState(
      current.search,
      nextWorkspace.openSessions,
      nextWorkspace.groups,
    );
    const liveSession = knownSessionsRef.current.find((session) => (
      session.name === sessionName
    ));
    const overrides = liveSession
      ? [{ name: sessionName, sessionId: liveSession.id }]
      : [];
    if (route?.sessionName === sessionName && !route.recentsOpen) {
      if (nextSearch !== current.search) {
        replaceLocation(
          window.history.state,
          sessionPath(sessionName),
          nextSearch,
          overrides,
        );
        syncLocation();
      }
      return;
    }

    const state = window.history.state as Record<string, unknown> | null;
    if ((route?.recentsOpen || newRoute?.recentsOpen) && state?.[RECENTS_ENTRY_KEY] === true) {
      if (route?.sessionName === sessionName) {
        pendingWorkspaceSnapshot.current = {
          openSessions: [...nextWorkspace.openSessions],
          groups: nextWorkspace.groups,
        };
        window.history.back();
        return;
      }
      if (state[FROM_DASHBOARD_KEY] === true) {
        // Collapse dashboard -> console -> Recents back to dashboard -> console.
        // Pushing after the two-step Back also discards the stale Recents entry.
        pendingRecentsNavigation.current = {
          sessionName,
        };
        window.history.go(-2);
      } else if (newRoute?.recentsOpen) {
        pendingRecentsNavigation.current = {
          sessionName,
          replaceRestoredEntry: true,
        };
        window.history.back();
      } else {
        replaceLocation(
          withoutRecentsEntry(state),
          sessionPath(sessionName),
          nextSearch,
          overrides,
        );
        syncLocation();
      }
      return;
    }

    replaceLocation(
      newRoute
        ? withoutNewSessionReturn(window.history.state)
        : window.history.state,
      sessionPath(sessionName),
      nextSearch,
      overrides,
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const switchSession = useCallback((sessionName: string) => {
    const nextWorkspace = visitWorkspaceSession(workspace, sessionName);
    setWorkspace(nextWorkspace);
    finishSessionSwitch(sessionName, nextWorkspace);
  }, [finishSessionSwitch, workspace]);

  const commitWorkspaceStructure = useCallback((nextWorkspace: SessionWorkspaceState) => {
    if (nextWorkspace === workspaceRef.current) return;
    workspaceRef.current = nextWorkspace;
    if (pendingWorkspaceSnapshot.current) {
      pendingWorkspaceSnapshot.current = {
        openSessions: [...nextWorkspace.openSessions],
        groups: nextWorkspace.groups,
      };
    }
    setWorkspace(nextWorkspace);
    const current = currentLocation();
    replaceLocation(
      window.history.state,
      current.path,
      searchWithWorkspaceState(
        current.search,
        nextWorkspace.openSessions,
        nextWorkspace.groups,
      ),
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const moveSessionTab = useCallback((sessionName: string, targetIndex: number) => {
    const nextWorkspace = moveWorkspaceSession(
      workspaceRef.current,
      sessionName,
      targetIndex,
    );
    commitWorkspaceStructure(nextWorkspace);
  }, [commitWorkspaceStructure]);

  const saveTabGroup = useCallback((group: WorkspaceTabGroup) => {
    commitWorkspaceStructure(setWorkspaceTabGroup(workspaceRef.current, group));
  }, [commitWorkspaceStructure]);

  const deleteTabGroup = useCallback((groupId: string) => {
    commitWorkspaceStructure(removeWorkspaceTabGroup(workspaceRef.current, groupId));
  }, [commitWorkspaceStructure]);

  const toggleTabGroup = useCallback((groupId: string, collapsed: boolean) => {
    commitWorkspaceStructure(
      setWorkspaceTabGroupCollapsed(workspaceRef.current, groupId, collapsed),
    );
  }, [commitWorkspaceStructure]);

  const moveTabGroup = useCallback((groupId: string, direction: -1 | 1) => {
    commitWorkspaceStructure(moveWorkspaceTabGroup(workspaceRef.current, groupId, direction));
  }, [commitWorkspaceStructure]);

  const openTabSearch = useCallback(() => {
    const current = currentLocation();
    if (
      (!parseSessionRoute(current.path) && !parseNewSessionRoute(current.path))
      || workspaceRef.current.openSessions.length === 0
      || isCompactWorkspaceViewport()
      || document.querySelector('[aria-modal="true"]')
    ) return;
    setTabSearchOpen(true);
  }, []);
  const closeTabSearch = useCallback(() => setTabSearchOpen(false), []);

  useEffect(() => {
    if (tabSearchOpen && workspace.openSessions.length === 0) {
      setTabSearchOpen(false);
    }
  }, [tabSearchOpen, workspace.openSessions.length]);

  useEffect(() => {
    setTabSearchOpen(false);
  }, [location.path]);

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || tabSearchOpen
        || isCompactWorkspaceViewport()
        || document.querySelector('[aria-modal="true"]')
        || !event.ctrlKey
        || !event.shiftKey
        || event.altKey
        || event.metaKey
      ) return;

      const current = currentLocation();
      if (!parseSessionRoute(current.path) && !parseNewSessionRoute(current.path)) return;

      const searchRequested = event.code === "Semicolon";
      const togglesTabActions = event.code === "KeyA";
      const opensNewSession = event.code === "KeyB";
      const direction = event.code === "Comma"
        ? -1
        : event.code === "Period"
          ? 1
          : 0;
      const directMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      const directIndex = directMatch ? Number(directMatch[1]) - 1 : null;
      if (
        !searchRequested
        && !togglesTabActions
        && !opensNewSession
        && direction === 0
        && directIndex === null
      ) return;

      const currentWorkspace = workspaceRef.current;
      if (currentWorkspace.openSessions.length === 0) return;
      event.preventDefault();
      event.stopPropagation();

      if (togglesTabActions) {
        setDesktopTabActionsVisible(!desktopTabActionsVisible);
        return;
      }

      if (opensNewSession) {
        if (workspacePersistenceState !== "loading" && !event.repeat) openNewSession();
        return;
      }

      if (searchRequested) {
        setTabSearchOpen(true);
        return;
      }

      if (directIndex !== null) {
        const targetSession = currentWorkspace.openSessions[directIndex];
        if (targetSession) switchSession(targetSession);
        return;
      }

      const route = parseSessionRoute(current.path);
      const newSession = parseNewSessionRoute(current.path);
      const fallbackActive = newSession
        ? null
        : currentWorkspace.recentSessions.find((sessionName) => (
          currentWorkspace.openSessions.includes(sessionName)
        )) ?? null;
      const activeSession = route?.sessionName ?? fallbackActive;
      const currentIndex = activeSession
        ? currentWorkspace.openSessions.indexOf(activeSession)
        : -1;
      const nextIndex = currentIndex < 0
        ? direction > 0 ? 0 : currentWorkspace.openSessions.length - 1
        : (currentIndex + direction + currentWorkspace.openSessions.length)
          % currentWorkspace.openSessions.length;
      switchSession(currentWorkspace.openSessions[nextIndex]);
    };

    window.addEventListener("keydown", handleWorkspaceShortcut, true);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcut, true);
  }, [
    desktopTabActionsVisible,
    openNewSession,
    setDesktopTabActionsVisible,
    switchSession,
    tabSearchOpen,
    workspacePersistenceState,
  ]);

  const navigateToDashboard = useCallback((nextWorkspace: PendingWorkspaceSnapshot) => {
    const state = window.history.state as Record<string, unknown> | null;
    const route = parseSessionRoute(currentLocation().path);
    const newRoute = parseNewSessionRoute(currentLocation().path);
    const dashboardSearch = searchWithWorkspaceState(
      currentLocation().search,
      nextWorkspace.openSessions,
      nextWorkspace.groups,
    );
    if ((route?.recentsOpen || newRoute?.recentsOpen) && state?.[RECENTS_ENTRY_KEY] === true) {
      if (state[FROM_DASHBOARD_KEY] === true) {
        pendingWorkspaceSnapshot.current = {
          openSessions: [...nextWorkspace.openSessions],
          groups: nextWorkspace.groups,
        };
        window.history.go(-2);
      } else {
        replaceLocation(
          {},
          "/",
          dashboardSearch,
        );
        syncLocation();
      }
      return;
    }
    if (state?.[FROM_DASHBOARD_KEY] === true) {
      pendingWorkspaceSnapshot.current = {
        openSessions: [...nextWorkspace.openSessions],
        groups: nextWorkspace.groups,
      };
      window.history.back();
      return;
    }

    // A directly opened console has no dashboard entry to return to.
    replaceLocation({}, "/", dashboardSearch);
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const returnToDashboard = useCallback(() => {
    navigateToDashboard(workspaceRef.current);
  }, [navigateToDashboard]);

  const closeNewSessionView = useCallback(() => {
    const returnSession = newSessionReturnSession(window.history.state);
    if (returnSession) {
      const currentWorkspace = workspaceRef.current;
      const target = currentWorkspace.openSessions.includes(returnSession)
        ? returnSession
        : currentWorkspace.recentSessions.find((sessionName) => (
            currentWorkspace.openSessions.includes(sessionName)
          ));
      if (target) {
        const nextWorkspace = visitWorkspaceSession(currentWorkspace, target);
        focusWorkspaceTabAfterNavigation.current = target;
        setWorkspace(nextWorkspace);
        finishSessionSwitch(target, nextWorkspace);
        return;
      }
    }
    returnToDashboard();
  }, [finishSessionSwitch, returnToDashboard]);

  const openRecents = useCallback(() => {
    const route = parseSessionRoute(currentLocation().path);
    const newRoute = parseNewSessionRoute(currentLocation().path);
    if ((!route && !newRoute) || route?.recentsOpen || newRoute?.recentsOpen) return;
    const currentState = (window.history.state || {}) as Record<string, unknown>;
    const path = route
      ? sessionPath(route.sessionName, true)
      : newSessionPath(true);
    pushLocation(
      { ...currentState, [RECENTS_ENTRY_KEY]: true },
      path,
      currentLocation().search,
    );
    syncLocation();
  }, [pushLocation, syncLocation]);

  const closeRecents = useCallback(() => {
    const route = parseSessionRoute(currentLocation().path);
    const newRoute = parseNewSessionRoute(currentLocation().path);
    if (!route?.recentsOpen && !newRoute?.recentsOpen) return;
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[RECENTS_ENTRY_KEY] === true) {
      pendingWorkspaceSnapshot.current = {
        openSessions: [...workspaceRef.current.openSessions],
        groups: workspaceRef.current.groups,
      };
      window.history.back();
      return;
    }
    replaceLocation(
      window.history.state,
      route ? sessionPath(route.sessionName) : newSessionPath(),
      currentLocation().search,
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const openSessionInNewWindow = useCallback((
    sessionName: string,
    mode: OpenTabInNewWindowMode,
  ): OpenTabInNewWindowResult => {
    if (!workspaceRef.current.openSessions.includes(sessionName)) return "failed";
    const current = currentLocation();
    const savedWorkspaceId = savedWorkspaceIdFromSearch(current.search);
    if (mode === "move" && savedWorkspaceId) {
      const snapshot = currentWorkspaceActivitySnapshot();
      const earlierSavePending = (
        !snapshot
        || hydratedWorkspaceIdRef.current !== savedWorkspaceId
        || (
          workspaceActivityTimer.current !== null
          && stagedWorkspaceActivity.current?.workspaceId === savedWorkspaceId
        )
        || stagedWorkspaceActivity.current?.workspaceId === savedWorkspaceId
        || queuedWorkspaceActivities.current.some(
          (activity) => activity.workspaceId === savedWorkspaceId,
        )
        || workspaceActivityInFlight.current?.workspaceId === savedWorkspaceId
        || failedWorkspaceActivity.current?.workspaceId === savedWorkspaceId
        || !sameWorkspaceActivity(lastSavedWorkspaceActivity.current, snapshot)
      );
      if (earlierSavePending) {
        workspaceActivityCommit.current();
        return "workspace-sync-pending";
      }
    }
    const search = isolatedWorkspaceSearch(current.search, [sessionName]);
    const destination = new URL(
      targetUrl(sessionPath(sessionName), search),
      window.location.href,
    ).toString();

    let child: Window | null = null;
    try {
      child = window.open("about:blank", "_blank");
      if (!child) return "blocked";
      child.opener = null;
      child.location.replace(destination);
      return "opened";
    } catch {
      try {
        child?.close();
      } catch {
        // The source tab remains intact even if a partial popup cannot be closed.
      }
      return "failed";
    }
  }, [currentWorkspaceActivitySnapshot]);

  const closeSessionTab = useCallback((sessionName: string) => {
    const route = parseSessionRoute(currentLocation().path);
    const currentWorkspace = workspaceRef.current;
    const nextSession = sessionAfterClose(currentWorkspace.openSessions, sessionName);
    if (route?.sessionName === sessionName && nextSession === null) {
      focusDashboardAfterSessionClose.current = true;
    }
    const closedWorkspace = closeWorkspaceSession(currentWorkspace, sessionName);
    if (route?.sessionName !== sessionName) {
      workspaceRef.current = closedWorkspace;
      setWorkspace(closedWorkspace);
      const current = currentLocation();
      replaceLocation(
        window.history.state,
        current.path,
        searchWithWorkspaceState(
          current.search,
          closedWorkspace.openSessions,
          closedWorkspace.groups,
        ),
      );
      syncLocation();
      return;
    }

    if (nextSession) {
      const nextWorkspace = visitWorkspaceSession(closedWorkspace, nextSession);
      setWorkspace(nextWorkspace);
      finishSessionSwitch(nextSession, nextWorkspace);
    } else {
      workspaceRef.current = closedWorkspace;
      setWorkspace(closedWorkspace);
      navigateToDashboard(closedWorkspace);
    }
  }, [finishSessionSwitch, navigateToDashboard, replaceLocation, syncLocation]);

  const terminateOpenSession = useCallback(async (
    sessionName: string,
    sessionId: string,
    sessionCreated: number,
    serverStarted: number,
    serverPid: number,
  ) => {
    await terminateSession(
      sessionName,
      sessionId,
      sessionCreated,
      serverStarted,
      serverPid,
    );
    if (!appMounted.current) return;

    const currentNamedSession = knownSessionsRef.current.find(
      (session) => session.name === sessionName,
    );
    const stillRepresentsTerminatedSession = (
      !currentNamedSession
      || hasSessionIdentity(currentNamedSession, {
        id: sessionId,
        created: sessionCreated,
        serverStarted,
        serverPid,
      })
    );
    const terminatedIdentity: SessionIdentity = {
      id: sessionId,
      created: sessionCreated,
      serverStarted,
      serverPid,
    };
    terminatedSessionsRef.current.push(terminatedIdentity);
    const remainingSessions = knownSessionsRef.current.filter(
      (session) => !hasSessionIdentity(session, terminatedIdentity),
    );
    knownSessionsRef.current = remainingSessions;
    setKnownSessions(remainingSessions);
    setRenameWarnings((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });

    // A same-name session created after the kill owns the route and quick tab now.
    if (stillRepresentsTerminatedSession) {
      const route = parseSessionRoute(currentLocation().path);
      if (
        route?.sessionName === sessionName
        && sessionAfterClose(workspaceRef.current.openSessions, sessionName) === null
      ) focusDashboardAfterSessionClose.current = true;
      closeSessionTab(sessionName);
    }
  }, [closeSessionTab]);

  const clearRecents = useCallback(() => {
    setWorkspace(clearClosedWorkspaceHistory);
  }, []);

  const replaceKnownSessions = useCallback((sessions: Session[]) => {
    const reconciled = reconcileRenamedSessions(sessions, sessionRenames.current);
    if (reconciled !== sessions) {
      // Any old name for an ID renamed in this page proves the whole snapshot
      // predates that rename; accepting it could erase a newer reused-name ID.
      syncLocation();
      return;
    }

    const currentSessions = withoutTerminatedSessions(
      sessions,
      terminatedSessionsRef.current,
    );
    knownSessionsRef.current = currentSessions;
    setKnownSessions(currentSessions);
    syncLocation();
  }, [syncLocation]);

  const updateKnownSession = useCallback((updatedSession: Session) => {
    if (terminatedSessionsRef.current.some(
      (identity) => hasSessionIdentity(updatedSession, identity),
    )) return;
    const nextSessions = knownSessionsRef.current.map((session) => (
      session.name === updatedSession.name ? updatedSession : session
    ));
    knownSessionsRef.current = nextSessions;
    setKnownSessions(nextSessions);
  }, []);

  const sessionWorkspacePinChanged = useCallback(async (
    sessionName: string,
    pinned: boolean,
    sessionRevision: number,
  ) => {
    const nextSessions = knownSessionsRef.current.map((session) => (
      session.name === sessionName
        ? { ...session, workspacePinned: pinned }
        : session
    ));
    knownSessionsRef.current = nextSessions;
    setKnownSessions(nextSessions);

    const workspaceId = savedWorkspaceIdFromSearch(currentLocation().search);
    if (workspaceId) await hydrateSavedWorkspace(workspaceId, false, sessionRevision);
  }, [hydrateSavedWorkspace]);

  const transferOpenSessionToWorkspace = useCallback(async (
    sessionName: string,
    destinationWorkspaceId: string,
    operation: WorkspaceSessionTransferOperation,
    sessionRevision: number,
  ) => {
    const current = currentLocation();
    const locationWorkspaceId = savedWorkspaceIdFromSearch(current.search);
    const sourceWorkspaceId = (
      locationWorkspaceId
      && hydratedWorkspaceIdRef.current === locationWorkspaceId
    ) ? locationWorkspaceId : null;

    // Flush the newest source layout first. The transfer then advances the
    // document revision so any older in-flight browser save cannot undo it.
    if (sourceWorkspaceId) {
      workspaceActivityCommit.current();
      workspaceActivitySuppressedFor.current = sourceWorkspaceId;
    }
    try {
      const result = await transferSessionToWorkspace(
        sessionName,
        sourceWorkspaceId,
        destinationWorkspaceId,
        operation,
        sessionRevision,
      );
      if (!appMounted.current) return result;

      if (sourceWorkspaceId) {
        workspaceSessionRevision.current = {
          workspaceId: sourceWorkspaceId,
          value: result.sessionRevision,
        };
        if (operation === "move") {
          if (workspaceActivityTimer.current !== null) {
            window.clearTimeout(workspaceActivityTimer.current);
            workspaceActivityTimer.current = null;
          }
          if (stagedWorkspaceActivity.current?.workspaceId === sourceWorkspaceId) {
            stagedWorkspaceActivity.current = null;
          }
          queuedWorkspaceActivities.current = queuedWorkspaceActivities.current.filter(
            (snapshot) => snapshot.workspaceId !== sourceWorkspaceId,
          );
          if (failedWorkspaceActivity.current?.workspaceId === sourceWorkspaceId) {
            failedWorkspaceActivity.current = null;
          }
          if (lastSavedWorkspaceActivity.current?.workspaceId === sourceWorkspaceId) {
            lastSavedWorkspaceActivity.current = null;
          }

          const savedSource = result.sourceWorkspace;
          if (savedSource) {
            workspaceHydrationRequest.current += 1;
            workspaceHydrationInFlight.current = null;
            const currentSessions = knownSessionsRef.current;
            const targetSession = liveWorkspaceSession(savedSource, currentSessions);
            const restoredWorkspace = restoreWorkspaceTabs(
              createSessionWorkspace(),
              savedSource.activeSession ?? targetSession ?? undefined,
              savedSource.tabs,
              savedSource.groups ?? [],
            );
            workspaceRef.current = restoredWorkspace;
            setWorkspace(restoredWorkspace);
            recordWorkspaceGroupsSupport(Array.isArray(savedSource.groups));
            workspaceSessionRevision.current = {
              workspaceId: sourceWorkspaceId,
              value: result.sessionRevision,
            };
            setWorkspaceIdentity({ id: sourceWorkspaceId, name: savedSource.name });
            setHydratedWorkspaceBinding(sourceWorkspaceId);

            const latest = currentLocation();
            const route = parseSessionRoute(latest.path);
            const path = route
              ? targetSession
                ? sessionPath(targetSession)
                : "/"
              : latest.path;
            const search = searchWithSavedWorkspaceId(
              searchWithWorkspaceState(
                latest.search,
                savedSource.tabs,
                savedSource.groups ?? [],
              ),
              sourceWorkspaceId,
            );
            const liveTarget = targetSession
              ? currentSessions.find((item) => item.name === targetSession)
              : undefined;
            replaceLocation(
              window.history.state,
              path,
              search,
              liveTarget ? [{ name: liveTarget.name, sessionId: liveTarget.id }] : [],
            );
            setLocation({ path, search });
          }
        } else {
          const rebaseSnapshot = (snapshot: WorkspaceActivitySnapshot | null) => (
            snapshot?.workspaceId === sourceWorkspaceId
              ? { ...snapshot, sessionRevision: result.sessionRevision }
              : snapshot
          );
          stagedWorkspaceActivity.current = rebaseSnapshot(
            stagedWorkspaceActivity.current,
          );
          queuedWorkspaceActivities.current = queuedWorkspaceActivities.current.map(
            (snapshot) => rebaseSnapshot(snapshot) as WorkspaceActivitySnapshot,
          );
          failedWorkspaceActivity.current = rebaseSnapshot(
            failedWorkspaceActivity.current,
          );
          lastSavedWorkspaceActivity.current = rebaseSnapshot(
            lastSavedWorkspaceActivity.current,
          );
        }
      } else if (operation === "move") {
        closeSessionTab(sessionName);
      }
      return result;
    } finally {
      if (workspaceActivitySuppressedFor.current === sourceWorkspaceId) {
        workspaceActivitySuppressedFor.current = null;
      }
    }
  }, [
    closeSessionTab,
    recordWorkspaceGroupsSupport,
    replaceLocation,
    setHydratedWorkspaceBinding,
    setWorkspaceIdentity,
  ]);

  const renameOpenSession = useCallback((
    previousName: string,
    nextName: string,
    sessionId: string,
    warnings: readonly string[] = [],
  ) => {
    if (!previousName || !nextName || !sessionId || previousName === nextName) return;
    const previousLiveSession = knownSessionsRef.current.find(
      (session) => session.name === previousName,
    );
    recordSessionRename(
      sessionRenames.current,
      previousName,
      nextName,
      sessionId,
    );
    setRenameWarnings((current) => {
      const previousWarning = current.get(sessionId);
      const messages = [...new Set([
        ...(previousWarning?.messages || []),
        ...warnings,
      ])];
      if (messages.length === 0) return current;
      const next = new Map(current);
      next.set(sessionId, {
        sessionId,
        sessionName: nextName,
        messages,
      });
      return next;
    });

    const previousNameStillBelongsToSession = (
      !previousLiveSession || previousLiveSession.id === sessionId
    );

    const nextWorkspace = previousNameStillBelongsToSession
      ? renameWorkspaceSession(workspaceRef.current, previousName, nextName)
      : workspaceRef.current;
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    const nextKnownSessions = knownSessionsRef.current.map((session) => (
      session.id === sessionId && session.name === previousName
        ? { ...session, name: nextName }
        : session
    ));
    knownSessionsRef.current = nextKnownSessions;
    setKnownSessions(nextKnownSessions);

    if (previousNameStillBelongsToSession && pendingWorkspaceSnapshot.current) {
      const renamedPending = renameWorkspaceSession(
        { ...pendingWorkspaceSnapshot.current, recentSessions: [] },
        previousName,
        nextName,
      );
      pendingWorkspaceSnapshot.current = {
        openSessions: renamedPending.openSessions,
        groups: renamedPending.groups,
      };
    }
    if (
      previousNameStillBelongsToSession
      && pendingRecentsNavigation.current?.sessionName === previousName
    ) {
      pendingRecentsNavigation.current = {
        ...pendingRecentsNavigation.current,
        sessionName: nextName,
      };
    }

    const currentLocationBeforeRename = currentLocation();
    const currentRouteBeforeRename = parseSessionRoute(
      currentLocationBeforeRename.path,
    );
    const current = canonicalizeRenamedLocation(
      currentLocationBeforeRename,
      sessionRenames.current,
      knownSessionsRef.current,
      readSessionHistoryBindings(
        window.history.state,
        currentLocationBeforeRename,
      ),
      previousNameStillBelongsToSession
        && currentRouteBeforeRename?.sessionName === previousName
        ? sessionId
        : undefined,
    );
    const nextSearch = searchWithWorkspaceState(
      current.search,
      nextWorkspace.openSessions,
      nextWorkspace.groups,
    );
    replaceLocation(
      window.history.state,
      current.path,
      nextSearch,
      [{ name: nextName, sessionId }],
    );
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const dismissRenameWarning = useCallback((sessionId: string) => {
    setRenameWarnings((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const savedWorkspaceDeleted = useCallback((workspaceId: string) => {
    if (savedWorkspaceIdFromSearch(currentLocation().search) !== workspaceId) return;
    detachSavedWorkspace(
      "Saved workspace deleted. Its tabs remain open here as an unsaved workspace.",
    );
  }, [detachSavedWorkspace]);

  const savedWorkspaceUpdated = useCallback((savedWorkspace: SavedWorkspace) => {
    if (savedWorkspaceIdFromSearch(currentLocation().search) !== savedWorkspace.id) return;
    setWorkspaceIdentity({ id: savedWorkspace.id, name: savedWorkspace.name });
  }, [setWorkspaceIdentity]);

  const retryWorkspaceSync = useCallback(() => {
    const workspaceId = savedWorkspaceIdFromSearch(currentLocation().search);
    if (
      workspaceSyncProblem?.kind === "save"
      && failedWorkspaceActivity.current
      && workspaceId === failedWorkspaceActivity.current.workspaceId
      && hydratedWorkspaceIdRef.current === workspaceId
    ) {
      const failedActivity = failedWorkspaceActivity.current;
      workspaceActivityCommit.current();
      const pendingActivityWillSupersedeFailure = (
        workspaceActivityInFlight.current?.workspaceId === workspaceId
        || queuedWorkspaceActivities.current.some((activity) => (
          activity.workspaceId === workspaceId
        ))
      );
      if (!pendingActivityWillSupersedeFailure) {
        queuedWorkspaceActivities.current.push(failedActivity);
      }
      workspaceActivityFlush.current();
      return;
    }
    if (!workspaceId) {
      setWorkspaceSyncProblem(null);
      return;
    }
    if (workspaceSyncProblem?.kind === "load") {
      void hydrateSavedWorkspace(workspaceId);
    }
  }, [hydrateSavedWorkspace, workspaceSyncProblem?.kind]);

  const openSnippets = () => {
    const current = currentLocation();
    const dashboardSearch = searchWithWorkspaceState(
      current.search,
      workspace.openSessions,
      workspace.groups,
    );
    replaceLocation(
      window.history.state,
      current.path,
      dashboardSearch,
    );
    pushLocation(
      { [SNIPPETS_FROM_DASHBOARD_KEY]: true },
      "/snippets",
      searchWithSavedWorkspaceId(
        searchWithWorkspaceState("", workspace.openSessions, workspace.groups),
        savedWorkspaceIdFromSearch(current.search),
      ),
    );
    syncLocation();
  };

  const returnFromSnippets = () => {
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[SNIPPETS_FROM_DASHBOARD_KEY] === true) {
      pendingWorkspaceSnapshot.current = {
        openSessions: [...workspace.openSessions],
        groups: workspace.groups,
      };
      window.history.back();
      return;
    }
    replaceLocation(
      {},
      "/",
      searchWithSavedWorkspaceId(
        searchWithWorkspaceState("", workspace.openSessions, workspace.groups),
        savedWorkspaceIdFromSearch(currentLocation().search),
      ),
    );
    syncLocation();
  };

  const tabSearchActiveSession = activeRoute?.sessionName
    ?? (newSessionRoute
      ? null
      : workspace.recentSessions.find((sessionName) => (
        workspace.openSessions.includes(sessionName)
      )) ?? null);
  const workspaceSyncNoticeDismissed = (
    workspaceSyncProblem !== null
    && dismissedWorkspaceSyncProblem === workspaceSyncProblem
  );

  const dismissWorkspaceSyncNotice = () => {
    if (!workspaceSyncProblem) return;
    if (workspaceSyncProblem.kind === "load" || workspaceSyncProblem.kind === "save") {
      setDismissedWorkspaceSyncProblem(workspaceSyncProblem);
      return;
    }
    setWorkspaceSyncProblem(null);
  };

  const withWorkspaceSyncNotice = (content: ReactNode) => (
    <>
      {workspaceSyncProblem && !workspaceSyncNoticeDismissed && (
        <aside
          className={activeRoute
            ? "workspace-sync-notice workspace-sync-notice--console"
            : "workspace-sync-notice"}
          role="alert"
        >
          <div>
            <strong>
              {workspaceSyncProblem.kind === "load"
                ? "Saved workspace unavailable"
                : workspaceSyncProblem.kind === "save"
                  ? "Workspace changes are not saved"
                  : workspaceSyncProblem.kind === "create"
                    ? "Workspace saved separately"
                    : "Workspace is now unsaved"}
            </strong>
            <p>{workspaceSyncProblem.message}</p>
          </div>
          <div className="workspace-sync-notice-actions">
            {(workspaceSyncProblem.kind === "load"
              || workspaceSyncProblem.kind === "save") && (
              <button type="button" onClick={retryWorkspaceSync}>Retry</button>
            )}
            <button type="button" onClick={dismissWorkspaceSyncNotice}>
              {workspaceSyncProblem.kind === "load" || workspaceSyncProblem.kind === "save"
                ? "Hide details"
                : "Dismiss"}
            </button>
          </div>
        </aside>
      )}
      {workspaceSyncProblem && workspaceSyncNoticeDismissed && (
        <aside
          className={activeRoute
            ? "workspace-sync-notice workspace-sync-notice--compact workspace-sync-notice--console"
            : "workspace-sync-notice workspace-sync-notice--compact"}
          aria-label="Workspace sync recovery"
          aria-live="polite"
        >
          <div>
            <strong>Workspace sync issue</strong>
          </div>
          <div className="workspace-sync-notice-actions">
            <button type="button" onClick={retryWorkspaceSync}>Retry</button>
            <button
              type="button"
              aria-label="Show workspace sync details"
              onClick={() => setDismissedWorkspaceSyncProblem(null)}
            >
              Details
            </button>
          </div>
        </aside>
      )}
      {tabSearchOpen && (activeRoute || newSessionRoute) && (
        <WorkspaceTabSearchDialog
          activeSession={tabSearchActiveSession}
          openSessions={workspace.openSessions}
          groups={workspace.groups}
          sessions={knownSessions}
          onSelect={switchSession}
          onClose={closeTabSearch}
        />
      )}
      {content}
    </>
  );

  if (activeRoute) {
    const { sessionName, recentsOpen } = activeRoute;
    const liveSession = knownSessions.find((session) => session.name === sessionName);
    const renameWarning = liveSession
      ? renameWarnings.get(liveSession.id) || null
      : [...renameWarnings.values()].find((warning) => (
        warning.sessionName === sessionName
      )) || null;
    return withWorkspaceSyncNotice(
      <ConsoleScreen
        sessionName={sessionName}
        workspaceId={hydratedWorkspaceId === locationWorkspaceId
          ? locationWorkspaceId
          : null}
        workspaceName={workspaceName}
        headerNotes={(
          <ScopedStickyNotes
            sessionName={sessionName}
            workspaceId={hydratedWorkspaceId === locationWorkspaceId
              ? locationWorkspaceId
              : null}
            workspaceName={workspaceName}
          />
        )}
        workspaceLinks={(
          <WorkspaceQuickLinks
            sessionName={sessionName}
            workspaceId={hydratedWorkspaceId === locationWorkspaceId
              ? locationWorkspaceId
              : null}
            workspaceName={workspaceName}
          />
        )}
        onBack={returnToDashboard}
        workspaceOverlayOpen={recentsOpen}
        mobileMode={mobileConsoleMode}
        onMobileModeChange={setMobileConsoleMode}
        onOpenWorkspaceOverview={openRecents}
        onCloseWorkspaceOverview={closeRecents}
        barVisibility={consoleBars}
        onBarVisibilityChange={setConsoleBarVisibility}
        desktopTabOrientation={desktopTabOrientation}
        onDesktopTabOrientationChange={setDesktopTabOrientation}
        tabActionsVisible={desktopTabActionsVisible}
        onTabActionsVisibilityChange={setDesktopTabActionsVisible}
        desktopTabRailWidth={desktopTabRailWidth}
        onDesktopTabRailWidthChange={setDesktopTabRailWidth}
        historyPanelWidth={historyPanelWidth}
        onHistoryPanelWidthChange={setHistoryPanelWidth}
        onSessionsChange={replaceKnownSessions}
        onSessionUpdate={updateKnownSession}
        onWorkspacePinChange={sessionWorkspacePinChanged}
        onSessionWorkspaceTransfer={transferOpenSessionToWorkspace}
        workspaceTransferDisabled={workspacePersistenceState === "loading"
          || workspacePersistenceState === "error"}
        onSessionRenamed={renameOpenSession}
        onSessionTerminated={terminateOpenSession}
        onSessionCopied={completeCopiedSession}
        copySessionDisabled={workspacePersistenceState === "loading"}
        renameWarning={renameWarning}
        onDismissRenameWarning={dismissRenameWarning}
        sessionNavigation={(
          <SessionWorkspaceNavigation
            activeSession={sessionName}
            openSessions={workspace.openSessions}
            recentSessions={workspace.recentSessions}
            groups={workspace.groups}
            sessions={knownSessions}
            recentsOpen={recentsOpen}
            tabsVisible={consoleBars.sessionTabs}
            tabActionsVisible={desktopTabActionsVisible}
            orientation={desktopTabOrientation}
            desktopTabRailWidth={desktopTabRailWidth}
            onDesktopTabRailWidthChange={setDesktopTabRailWidth}
            onSelect={switchSession}
            onMoveTab={moveSessionTab}
            onSaveTabGroup={saveTabGroup}
            onDeleteTabGroup={deleteTabGroup}
            onToggleTabGroup={toggleTabGroup}
            onMoveTabGroup={moveTabGroup}
            onOpenTabInNewWindow={openSessionInNewWindow}
            onCloseTab={closeSessionTab}
            onOpenRecents={openRecents}
            onCloseRecents={closeRecents}
            onClearRecents={clearRecents}
            onOpenDashboard={returnToDashboard}
            onNewSession={openNewSession}
            onOpenTabSearch={openTabSearch}
            workspacePersistenceState={workspacePersistenceState}
            workspaceName={workspaceName}
            onSaveWorkspace={saveCurrentWorkspace}
            onSessionTerminated={terminateOpenSession}
          />
        )}
      />
    );
  }

  if (newSessionRoute) {
    return withWorkspaceSyncNotice(
      <RoutedNewSessionScreen
        onCreated={completeNewSession}
        onCancel={closeNewSessionView}
        onActiveChange={setNewSessionViewActive}
        workspaceLoading={workspacePersistenceState === "loading"}
        desktopTabOrientation={desktopTabOrientation}
        sessionNavigation={(
          <SessionWorkspaceNavigation
            activeSession={null}
            openSessions={workspace.openSessions}
            recentSessions={workspace.recentSessions}
            groups={workspace.groups}
            sessions={knownSessions}
            recentsOpen={newSessionRoute.recentsOpen}
            newSessionActive
            tabActionsVisible={desktopTabActionsVisible}
            orientation={desktopTabOrientation}
            desktopTabRailWidth={desktopTabRailWidth}
            onDesktopTabRailWidthChange={setDesktopTabRailWidth}
            onSelect={switchSession}
            onMoveTab={moveSessionTab}
            onSaveTabGroup={saveTabGroup}
            onDeleteTabGroup={deleteTabGroup}
            onToggleTabGroup={toggleTabGroup}
            onMoveTabGroup={moveTabGroup}
            onOpenTabInNewWindow={openSessionInNewWindow}
            onCloseTab={closeSessionTab}
            onCloseNewSession={closeNewSessionView}
            onOpenRecents={openRecents}
            onCloseRecents={closeRecents}
            onClearRecents={clearRecents}
            onOpenDashboard={returnToDashboard}
            onNewSession={openNewSession}
            onOpenTabSearch={openTabSearch}
            workspacePersistenceState={workspacePersistenceState}
            workspaceName={workspaceName}
            onSaveWorkspace={saveCurrentWorkspace}
            onSessionTerminated={terminateOpenSession}
          />
        )}
      />
    );
  }

  if (location.path === "/snippets" || location.path === "/snippets/") {
    return withWorkspaceSyncNotice(
      <SnippetLibrary onOpenSessions={returnFromSnippets} />,
    );
  }

  const workspaceReturnSession = hydratedWorkspaceId
    ? workspace.recentSessions.find((sessionName) => (
        workspace.openSessions.includes(sessionName)
        && knownSessions.some((session) => session.name === sessionName)
      )) ?? workspace.openSessions.find((sessionName) => (
        knownSessions.some((session) => session.name === sessionName)
      ))
    : workspace.recentSessions.find(
        (sessionName) => workspace.openSessions.includes(sessionName),
      ) ?? workspace.openSessions.at(-1);

  return withWorkspaceSyncNotice(
    <SessionDashboard
      onOpen={openSession}
      onOpenInput={openSessionInput}
      onResumeWorkspace={workspaceReturnSession ? resumeWorkspace : undefined}
      workspaceReturnSession={workspaceReturnSession}
      workspaceTabCount={workspace.openSessions.length}
      onOpenSnippets={openSnippets}
      onNewSession={openNewSession}
      onSessionsChange={replaceKnownSessions}
      currentWorkspaceTabs={workspace.openSessions}
      currentWorkspaceGroups={workspace.groups}
      activeSession={workspaceReturnSession ?? null}
      activeWorkspaceId={hydratedWorkspaceId}
      onOpenSavedWorkspace={openSavedWorkspace}
      onSavedWorkspaceDeleted={savedWorkspaceDeleted}
      onSavedWorkspaceUpdated={savedWorkspaceUpdated}
      onWorkspacePinChange={sessionWorkspacePinChanged}
      onSessionTerminated={terminateOpenSession}
    />
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AppRoutes />
    </ThemeProvider>
  );
}
