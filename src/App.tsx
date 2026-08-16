import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BASE_PATH } from "./api";
import {
  ConsoleScreen,
  DEFAULT_CONSOLE_BAR_VISIBILITY,
  type ConsoleBar,
  type SessionRenameWarning,
} from "./components/ConsoleScreen";
import { SessionDashboard } from "./components/SessionDashboard";
import { DEFAULT_HISTORY_PANEL_WIDTH } from "./components/HistoryPanel";
import { NewSessionScreen } from "./components/NewSessionScreen";
import { SessionWorkspaceNavigation } from "./components/SessionWorkspaceNavigation";
import { SnippetLibrary } from "./components/SnippetLibrary";
import { ThemeProvider } from "./theme";
import type { Session } from "./types";
import {
  clearClosedWorkspaceHistory,
  closeWorkspaceSession,
  createSessionWorkspace,
  renameWorkspaceSession,
  restoreWorkspaceTabs,
  searchWithWorkspaceTabs,
  sessionAfterClose,
  visitWorkspaceSession,
  workspaceTabsFromSearch,
  type SessionWorkspaceState,
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

type NewSessionViewToken = symbol;

interface RoutedNewSessionScreenProps {
  onCreated: (name: string, viewToken: NewSessionViewToken) => void;
  onCancel: () => void;
  onActiveChange: (viewToken: NewSessionViewToken, active: boolean) => void;
  sessionNavigation: ReactNode;
}

const FROM_DASHBOARD_KEY = "muxdeckFromDashboard";
const SNIPPETS_FROM_DASHBOARD_KEY = "muxdeckSnippetsFromDashboard";
const RECENTS_ENTRY_KEY = "muxdeckRecentsEntry";
const SESSION_BINDINGS_KEY = "muxdeckSessionBindings";
const NEW_SESSION_PATH = "/sessions/new";

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
  const tabs = workspaceTabsFromSearch(location.search).map(
    (sessionName, index) => resolveRenamedSession(
      sessionName,
      renames,
      knownSessions,
      bindings?.tabs[index]?.sessionId,
    ),
  );
  const search = searchWithWorkspaceTabs(location.search, tabs);
  return path === location.path && search === location.search
    ? location
    : { path, search };
}

function RoutedNewSessionScreen({
  onCreated,
  onCancel,
  onActiveChange,
  sessionNavigation,
}: RoutedNewSessionScreenProps) {
  const viewToken = useRef(Symbol("muxdeck-new-session-view")).current;

  useLayoutEffect(() => {
    onActiveChange(viewToken, true);
    return () => onActiveChange(viewToken, false);
  }, [onActiveChange, viewToken]);

  return (
    <NewSessionScreen
      onCreated={(name) => onCreated(name, viewToken)}
      onCancel={onCancel}
      sessionNavigation={sessionNavigation}
    />
  );
}

function AppRoutes() {
  const [location, setLocation] = useState(currentLocation);
  const [consoleBars, setConsoleBars] = useState(DEFAULT_CONSOLE_BAR_VISIBILITY);
  const [historyPanelWidth, setHistoryPanelWidth] = useState(
    DEFAULT_HISTORY_PANEL_WIDTH,
  );
  const [workspace, setWorkspace] = useState<SessionWorkspaceState>(() => {
    const initialLocation = currentLocation();
    const route = parseSessionRoute(initialLocation.path);
    return restoreWorkspaceTabs(
      createSessionWorkspace(),
      route?.sessionName,
      workspaceTabsFromSearch(initialLocation.search, route?.sessionName),
    );
  });
  const [knownSessions, setKnownSessions] = useState<Session[]>([]);
  const [renameWarnings, setRenameWarnings] = useState<Map<string, SessionRenameWarning>>(
    () => new Map(),
  );
  const pendingRecentsNavigation = useRef<PendingRecentsNavigation | null>(null);
  const pendingLocationTabs = useRef<string[] | null>(null);
  const activeNewSessionView = useRef<NewSessionViewToken | null>(null);
  const sessionRenames = useRef<SessionRenameAliases>(new Map());
  const knownSessionsRef = useRef<Session[]>([]);
  const workspaceRef = useRef(workspace);

  workspaceRef.current = workspace;

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
    window.history.pushState(
      stateForLocation(state, path, search, overrides),
      "",
      targetUrl(path, search),
    );
  }, [stateForLocation]);

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
    const route = parseSessionRoute(nextLocation.path);
    const orderedTabs = workspaceTabsFromSearch(
      nextLocation.search,
      route?.sessionName,
    );
    setWorkspace((current) => restoreWorkspaceTabs(
      current,
      route?.sessionName,
      orderedTabs,
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
      const pending = pendingRecentsNavigation.current;
      if (pending) {
        pendingRecentsNavigation.current = null;
        const restored = currentLocation();
        const restoredSearch = searchWithWorkspaceTabs(
          restored.search,
          workspaceRef.current.openSessions,
        );
        if (pending.replaceRestoredEntry) {
          replaceLocation(
            withoutRecentsEntry(window.history.state),
            sessionPath(pending.sessionName),
            restoredSearch,
          );
          syncLocation();
          return;
        }
        replaceLocation(
          window.history.state,
          restored.path,
          restoredSearch,
        );
        pushLocation(
          { [FROM_DASHBOARD_KEY]: true },
          sessionPath(pending.sessionName),
          restoredSearch,
        );
      } else if (pendingLocationTabs.current) {
        const openSessions = pendingLocationTabs.current;
        pendingLocationTabs.current = null;
        const restored = currentLocation();
        replaceLocation(
          window.history.state,
          restored.path,
          searchWithWorkspaceTabs(restored.search, openSessions),
        );
      }
      syncLocation();
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [pushLocation, replaceLocation, syncLocation]);

  const activeRoute = parseSessionRoute(location.path);
  const newSessionRoute = parseNewSessionRoute(location.path);

  useEffect(() => {
    const route = parseSessionRoute(location.path);
    const orderedTabs = workspaceTabsFromSearch(location.search, route?.sessionName);
    setWorkspace((current) => restoreWorkspaceTabs(
      current,
      route?.sessionName,
      orderedTabs,
    ));

    const canonicalSearch = searchWithWorkspaceTabs(location.search, orderedTabs);
    if (canonicalSearch === location.search) return;
    replaceLocation(
      window.history.state,
      location.path,
      canonicalSearch,
    );
    syncLocation();
  }, [location.path, location.search, replaceLocation, syncLocation]);

  const openSession = useCallback((sessionName: string) => {
    const nextWorkspace = visitWorkspaceSession(workspace, sessionName);
    setWorkspace(nextWorkspace);
    const current = currentLocation();
    const nextSearch = searchWithWorkspaceTabs(
      current.search,
      nextWorkspace.openSessions,
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

  const openNewSession = useCallback(() => {
    const current = currentLocation();
    const nextSearch = searchWithWorkspaceTabs(
      current.search,
      workspace.openSessions,
    );
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
  }, [pushLocation, replaceLocation, syncLocation, workspace.openSessions]);

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
    viewToken: NewSessionViewToken,
  ) => {
    const nextWorkspace = visitWorkspaceSession(workspaceRef.current, sessionName);
    workspaceRef.current = nextWorkspace;
    if (
      pendingLocationTabs.current
      && !pendingLocationTabs.current.includes(sessionName)
    ) {
      pendingLocationTabs.current = [...pendingLocationTabs.current, sessionName];
    }
    setWorkspace(nextWorkspace);
    const current = currentLocation();
    const newRoute = parseNewSessionRoute(current.path);
    const nextSearch = searchWithWorkspaceTabs(
      current.search,
      nextWorkspace.openSessions,
    );
    const ownsCurrentView = Boolean(newRoute)
      && activeNewSessionView.current === viewToken;
    const state = window.history.state as Record<string, unknown> | null;

    if (ownsCurrentView && newRoute?.recentsOpen && state?.[RECENTS_ENTRY_KEY] === true) {
      pendingRecentsNavigation.current = {
        sessionName,
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
      window.history.state,
      ownsCurrentView ? sessionPath(sessionName) : current.path,
      nextSearch,
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
    const nextSearch = searchWithWorkspaceTabs(
      current.search,
      nextWorkspace.openSessions,
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
        pendingLocationTabs.current = [...nextWorkspace.openSessions];
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
      window.history.state,
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

  const navigateToDashboard = useCallback((openSessions: readonly string[]) => {
    const state = window.history.state as Record<string, unknown> | null;
    const route = parseSessionRoute(currentLocation().path);
    const newRoute = parseNewSessionRoute(currentLocation().path);
    const dashboardSearch = searchWithWorkspaceTabs(
      currentLocation().search,
      openSessions,
    );
    if ((route?.recentsOpen || newRoute?.recentsOpen) && state?.[RECENTS_ENTRY_KEY] === true) {
      if (state[FROM_DASHBOARD_KEY] === true) {
        pendingLocationTabs.current = [...openSessions];
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
      pendingLocationTabs.current = [...openSessions];
      window.history.back();
      return;
    }

    // A directly opened console has no dashboard entry to return to.
    replaceLocation({}, "/", dashboardSearch);
    syncLocation();
  }, [replaceLocation, syncLocation]);

  const returnToDashboard = useCallback(() => {
    navigateToDashboard(workspaceRef.current.openSessions);
  }, [navigateToDashboard]);

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
      pendingLocationTabs.current = [...workspaceRef.current.openSessions];
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

  const closeSessionTab = useCallback((sessionName: string) => {
    const route = parseSessionRoute(currentLocation().path);
    const nextSession = sessionAfterClose(workspace.openSessions, sessionName);
    const closedWorkspace = closeWorkspaceSession(workspace, sessionName);
    if (route?.sessionName !== sessionName) {
      setWorkspace(closedWorkspace);
      const current = currentLocation();
      replaceLocation(
        window.history.state,
        current.path,
        searchWithWorkspaceTabs(current.search, closedWorkspace.openSessions),
      );
      syncLocation();
      return;
    }

    if (nextSession) {
      const nextWorkspace = visitWorkspaceSession(closedWorkspace, nextSession);
      setWorkspace(nextWorkspace);
      finishSessionSwitch(nextSession, nextWorkspace);
    } else {
      setWorkspace(closedWorkspace);
      navigateToDashboard(closedWorkspace.openSessions);
    }
  }, [finishSessionSwitch, navigateToDashboard, replaceLocation, syncLocation, workspace]);

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

    knownSessionsRef.current = sessions;
    setKnownSessions(sessions);
    syncLocation();
  }, [syncLocation]);

  const updateKnownSession = useCallback((updatedSession: Session) => {
    const nextSessions = knownSessionsRef.current.map((session) => (
      session.name === updatedSession.name ? updatedSession : session
    ));
    knownSessionsRef.current = nextSessions;
    setKnownSessions(nextSessions);
  }, []);

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

    if (previousNameStillBelongsToSession && pendingLocationTabs.current) {
      pendingLocationTabs.current = renameWorkspaceSession(
        { openSessions: pendingLocationTabs.current, recentSessions: [] },
        previousName,
        nextName,
      ).openSessions;
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
    const nextSearch = searchWithWorkspaceTabs(
      current.search,
      nextWorkspace.openSessions,
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

  const openSnippets = () => {
    const current = currentLocation();
    const dashboardSearch = searchWithWorkspaceTabs(
      current.search,
      workspace.openSessions,
    );
    replaceLocation(
      window.history.state,
      current.path,
      dashboardSearch,
    );
    pushLocation(
      { [SNIPPETS_FROM_DASHBOARD_KEY]: true },
      "/snippets",
      searchWithWorkspaceTabs("", workspace.openSessions),
    );
    syncLocation();
  };

  const returnFromSnippets = () => {
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[SNIPPETS_FROM_DASHBOARD_KEY] === true) {
      pendingLocationTabs.current = [...workspace.openSessions];
      window.history.back();
      return;
    }
    replaceLocation(
      {},
      "/",
      searchWithWorkspaceTabs("", workspace.openSessions),
    );
    syncLocation();
  };

  if (activeRoute) {
    const { sessionName, recentsOpen } = activeRoute;
    const liveSession = knownSessions.find((session) => session.name === sessionName);
    const renameWarning = liveSession
      ? renameWarnings.get(liveSession.id) || null
      : [...renameWarnings.values()].find((warning) => (
        warning.sessionName === sessionName
      )) || null;
    return (
      <ConsoleScreen
        sessionName={sessionName}
        onBack={returnToDashboard}
        workspaceOverlayOpen={recentsOpen}
        barVisibility={consoleBars}
        onBarVisibilityChange={setConsoleBarVisibility}
        historyPanelWidth={historyPanelWidth}
        onHistoryPanelWidthChange={setHistoryPanelWidth}
        onSessionsChange={replaceKnownSessions}
        onSessionUpdate={updateKnownSession}
        onSessionRenamed={renameOpenSession}
        renameWarning={renameWarning}
        onDismissRenameWarning={dismissRenameWarning}
        sessionNavigation={(
          <SessionWorkspaceNavigation
            activeSession={sessionName}
            openSessions={workspace.openSessions}
            recentSessions={workspace.recentSessions}
            sessions={knownSessions}
            recentsOpen={recentsOpen}
            tabsVisible={consoleBars.sessionTabs}
            onSelect={switchSession}
            onCloseTab={closeSessionTab}
            onOpenRecents={openRecents}
            onCloseRecents={closeRecents}
            onClearRecents={clearRecents}
            onOpenDashboard={returnToDashboard}
          />
        )}
      />
    );
  }

  if (newSessionRoute) {
    return (
      <RoutedNewSessionScreen
        onCreated={completeNewSession}
        onCancel={returnToDashboard}
        onActiveChange={setNewSessionViewActive}
        sessionNavigation={(
          <SessionWorkspaceNavigation
            activeSession={null}
            openSessions={workspace.openSessions}
            recentSessions={workspace.recentSessions}
            sessions={knownSessions}
            recentsOpen={newSessionRoute.recentsOpen}
            newSessionActive
            onSelect={switchSession}
            onCloseTab={closeSessionTab}
            onCloseNewSession={returnToDashboard}
            onOpenRecents={openRecents}
            onCloseRecents={closeRecents}
            onClearRecents={clearRecents}
            onOpenDashboard={returnToDashboard}
          />
        )}
      />
    );
  }

  if (location.path === "/snippets" || location.path === "/snippets/") {
    return <SnippetLibrary onOpenSessions={returnFromSnippets} />;
  }

  return (
    <SessionDashboard
      key={location.search}
      onOpen={openSession}
      onOpenSnippets={openSnippets}
      onNewSession={openNewSession}
      onSessionsChange={replaceKnownSessions}
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
