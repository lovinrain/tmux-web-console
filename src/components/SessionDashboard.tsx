import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  BASE_PATH,
  listSessions,
  subscribeToSessions,
  updateSessionDetails,
  updateSessionIgnored,
  updateSessionStar,
  updateSessionTags,
  updateSessionTitle,
  type SavedWorkspace,
} from "../api";
import {
  ChevronRightIcon,
  EditIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  GridIcon,
  ListIcon,
  MemoIcon,
  RefreshIcon,
  SearchIcon,
  SnippetIcon,
  StarIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import {
  DEFAULT_SESSION_SORT,
  SESSION_STATE_ORDER,
  filterSessions,
  groupSessionsByTag,
  paneCommandKind,
  parseSessionDashboardSearch,
  sessionStateChangedAt,
  serializeSessionDashboardSearch,
  sessionMatchesTagFilters,
  sortSessions,
  type SessionDashboardRouteState,
  type SessionKindFilter,
  type SessionSortKey,
  type SessionStateFilter,
  type SessionViewMode,
} from "../sessionDashboardModel";
import {
  SESSION_TAG_LABELS,
  SESSION_TAGS,
  type AgentState,
  type Pane,
  type Session,
  type SessionTag,
} from "../types";
import {
  isolatedWorkspaceSearch,
  searchWithSavedWorkspaceId,
  searchWithWorkspaceTabs,
  workspaceTabsFromSearch,
  type WorkspaceTabGroup,
} from "../workspaceState";
import { AppTabs } from "./AppTabs";
import { stageSessionDraft } from "./InputBar";
import { MessageQueueDialog } from "./MessageQueueDialog";
import { SavedWorkspaceList } from "./SavedWorkspaceList";
import { SessionSortControls } from "./SessionSortControls";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import { SessionTitleDialog } from "./SessionTitleDialog";
import { ThemeToggle } from "./ThemeToggle";

interface SessionDashboardProps {
  onOpen: (session: string) => void;
  onOpenInput?: (session: string) => void;
  onResumeWorkspace?: () => void;
  workspaceReturnSession?: string;
  workspaceTabCount?: number;
  onOpenSnippets?: () => void;
  onNewSession?: () => void;
  newSessionWindowHref?: string;
  onSessionsChange?: (sessions: Session[]) => void;
  currentWorkspaceTabs?: readonly string[];
  currentWorkspaceGroups?: readonly WorkspaceTabGroup[];
  activeSession?: string | null;
  activeWorkspaceId?: string | null;
  onOpenSavedWorkspace?: (workspace: SavedWorkspace) => void;
  onSavedWorkspaceDeleted?: (workspaceId: string) => void;
  onSavedWorkspaceUpdated?: (workspace: SavedWorkspace) => void;
  onSessionTerminated?: (
    sessionName: string,
    sessionId: string,
    sessionCreated: number,
    serverStarted: number,
    serverPid: number,
  ) => Promise<void>;
}

type UpdateMode = "connecting" | "live" | "polling";

const VIEW_MODE_KEY = "muxdeck-session-view";
const SORT_MODE_KEY = "muxdeck-session-sort";
const SORT_PRIORITY_KEY = "muxdeck-session-sort-priority";
const GROUP_MODE_KEY = "muxdeck-session-group";
const KIND_FILTERS: SessionKindFilter[] = [
  "all",
  "agents",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "grok",
  "shells",
];
const STATE_GROUP_ORDER = [...SESSION_STATE_ORDER];
const DASHBOARD_QUERY_KEYS = [
  "q",
  "kind",
  "filter",
  "state",
  "tag",
  "not-tag",
  "view",
  "group",
  "sort",
];

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Background work",
  unknown: "Unclear",
  other: "Other",
};

const STATE_FILTERS: SessionStateFilter[] = [
  "any",
  "waiting_human",
  "waiting_command",
  "working",
  "unknown",
  "other",
];

export function classifyPane(pane?: Pane): { label: string; tone: string } {
  switch (paneCommandKind(pane?.command || "", pane?.title || "")) {
    case "claude":
      return { label: "Claude", tone: "claude" };
    case "codex":
      return { label: "Codex", tone: "codex" };
    case "copilot":
      return { label: "Copilot", tone: "copilot" };
    case "cursor":
      return { label: "Cursor", tone: "cursor" };
    case "grok":
      return { label: "Grok", tone: "grok" };
    case "shells":
      return { label: "Shell", tone: "shell" };
    default:
      return { label: pane?.command || "Process", tone: "process" };
  }
}

export function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

function hasSameSessionIdentity(left: Session, right: Session): boolean {
  return left.id === right.id
    && left.created === right.created
    && left.serverStarted === right.serverStarted
    && left.serverPid === right.serverPid;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "unknown";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function initialDashboardRoute(): SessionDashboardRouteState {
  const parsed = parseSessionDashboardSearch(window.location.search);
  const params = new URLSearchParams(window.location.search);
  if (DASHBOARD_QUERY_KEYS.some((key) => params.has(key))) return parsed;

  try {
    const view = window.localStorage.getItem(VIEW_MODE_KEY);
    if (view === "list" || view === "cards") parsed.view = view;

    const savedPriority = window.localStorage.getItem(SORT_PRIORITY_KEY);
    const legacySort = window.localStorage.getItem(SORT_MODE_KEY);
    if (savedPriority) {
      parsed.sort = parseSessionDashboardSearch(`?sort=${encodeURIComponent(savedPriority)}`).sort;
    } else if (legacySort === "tmux-name") {
      parsed.sort = ["tmux-name"];
    } else if (legacySort === "state-change") {
      parsed.sort = ["state-change", "tmux-name"];
    } else if (legacySort === "state-groups") {
      parsed.group = "state";
      parsed.sort = ["state-change", "tmux-name"];
    }

    const savedGroup = window.localStorage.getItem(GROUP_MODE_KEY);
    if (savedGroup === "state" || savedGroup === "tag") parsed.group = savedGroup;
  } catch {
    // URL and product defaults remain authoritative when storage is unavailable.
  }
  return parsed;
}

function persistDashboardPreferences(route: SessionDashboardRouteState): void {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, route.view);
    window.localStorage.setItem(SORT_PRIORITY_KEY, route.sort.join(","));
    window.localStorage.setItem(GROUP_MODE_KEY, route.group);
  } catch {
    // The URL still contains the complete shareable configuration.
  }
}

function replaceDashboardUrl(route: SessionDashboardRouteState): void {
  const openSessions = workspaceTabsFromSearch(window.location.search);
  const dashboardSearch = serializeSessionDashboardSearch(route, window.location.search);
  const search = searchWithWorkspaceTabs(dashboardSearch, openSessions);
  const target = `${window.location.pathname}${search}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", target);
}

function isolatedWorkspaceHref(href: string): string {
  const url = new URL(href, window.location.href);
  url.search = isolatedWorkspaceSearch(url.search);
  if (url.origin === window.location.origin) return `${url.pathname}${url.search}${url.hash}`;
  return url.toString();
}

function sessionConsoleHref(sessionName: string): string {
  const search = isolatedWorkspaceSearch(window.location.search);
  return `${BASE_PATH}/session/${encodeURIComponent(sessionName)}${search}`;
}

interface SessionItemProps {
  session: Session;
  index: number;
  viewMode: SessionViewMode;
  showStateChangeTime: boolean;
  attentionBusy: boolean;
  onOpen: (name: string) => void;
  onEdit: (name: string, trigger: HTMLButtonElement) => void;
  onMessages: (name: string, trigger: HTMLButtonElement) => void;
  onSnippets: (name: string, trigger: HTMLButtonElement) => void;
  onTerminate?: (session: Session) => void;
  onToggleStar: (session: Session) => void;
  onToggleIgnored: (session: Session) => void;
}

function SessionItem({
  session,
  index,
  viewMode,
  showStateChangeTime,
  attentionBusy,
  onOpen,
  onEdit,
  onMessages,
  onSnippets,
  onTerminate,
  onToggleStar,
  onToggleIgnored,
}: SessionItemProps) {
  const stateDescriptionId = useId();
  const tagsDescriptionId = useId();
  const pane = activePane(session);
  const classification = classifyPane(pane);
  const tags = session.tags ?? [];
  const hiddenTags = tags.slice(3);
  const cardStyle = { "--i": Math.min(index, 14) } as CSSProperties;
  const displayName = session.customTitle || session.name;
  const memorandumCount = session.memorandumCount ?? session.queuedMessageCount;
  const queuedMemorandumCount = session.queuedMessageCount;
  const memoLabel = queuedMemorandumCount > 0
    ? `Manage memoranda for ${displayName}, ${queuedMemorandumCount} queued`
    : memorandumCount > 0
      ? `Manage memoranda for ${displayName}, ${memorandumCount} saved`
      : `Manage memoranda for ${displayName}`;

  return (
    <article
      className={`session-card${viewMode === "list" ? " session-row" : ""}${onTerminate ? " has-terminate" : ""}${tags.length > 0 ? " has-tags" : ""}`}
      style={cardStyle}
    >
      <button
        type="button"
        className="session-card-main"
        onClick={() => onOpen(session.name)}
        aria-label={`Open ${displayName}`}
        aria-describedby={`${stateDescriptionId}${tags.length > 0 ? ` ${tagsDescriptionId}` : ""}`}
      >
        <div className="session-card-top">
          <span className="session-badges">
            <span className={`agent-badge ${classification.tone}`}>{classification.label}</span>
            <span
              id={stateDescriptionId}
              className={`state-badge ${session.agentState}`}
              title={session.agentStateReason}
            >
              {STATE_LABELS[session.agentState]}
            </span>
          </span>
          <span className={showStateChangeTime ? "activity-time state-change-time" : "activity-time"}>
            {showStateChangeTime ? `state ${relativeTime(sessionStateChangedAt(session))}` : relativeTime(session.activity)}
          </span>
        </div>
        <div className="session-name-row">
          <h3>{displayName}</h3>
          <ChevronRightIcon />
        </div>
        {session.customTitle && <p className="session-tmux-name">tmux / {session.name}</p>}
        <p className="session-title">{pane?.title || pane?.command || "Idle tmux pane"}</p>
        {tags.length > 0 && (
          <span className="session-tag-list" aria-hidden="true">
            {tags.slice(0, 3).map((tag) => (
              <span className={`session-tag tag-${tag}`} key={tag}>
                {SESSION_TAG_LABELS[tag]}
              </span>
            ))}
            {hiddenTags.length > 0 && (
              <span className="session-tag-overflow">
                +{hiddenTags.length}
              </span>
            )}
          </span>
        )}
        {tags.length > 0 && (
          <span id={tagsDescriptionId} className="session-sr-only">
            Tags: {tags.map((tag) => SESSION_TAG_LABELS[tag]).join(", ")}
          </span>
        )}
        <p className="session-path">{pane?.path || "-"}</p>
        <div className="session-meta">
          <span>{session.windows} win / {session.panes.length} pane</span>
          <span>{pane?.width || 0}x{pane?.height || 0}</span>
          {session.attached > 0 && <span className="attached-label">attached</span>}
        </div>
      </button>
      <a
        className="session-open-new"
        href={sessionConsoleHref(session.name)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${displayName} in new window`}
        title="Open in new window"
      >
        <ExternalLinkIcon />
        <span>New window</span>
      </a>
      {onTerminate && (
        <button
          type="button"
          className="session-terminate-toggle"
          aria-label={`Terminate ${displayName} tmux session`}
          aria-haspopup="dialog"
          title="Terminate tmux session"
          onClick={() => onTerminate(session)}
        >
          <TrashIcon />
        </button>
      )}
      <div className="session-card-actions">
        <button
          type="button"
          className="session-snippets-toggle"
          aria-label={`Use snippet with ${displayName}`}
          title="Stage a snippet"
          onClick={(event) => onSnippets(session.name, event.currentTarget)}
        >
          <SnippetIcon />
        </button>
        <button
          type="button"
          className={queuedMemorandumCount > 0
            ? "session-messages-toggle has-queued"
            : memorandumCount > 0
              ? "session-messages-toggle has-memos"
              : "session-messages-toggle"}
          aria-label={memoLabel}
          title={queuedMemorandumCount > 0
            ? `${queuedMemorandumCount} queued in memo`
            : "Open session memo"}
          onClick={(event) => onMessages(session.name, event.currentTarget)}
        >
          <MemoIcon />
          {queuedMemorandumCount > 0 ? (
            <span className="queued">Q{queuedMemorandumCount}</span>
          ) : memorandumCount > 0 ? (
            <span>{memorandumCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={session.ignored ? "session-ignore-toggle active" : "session-ignore-toggle"}
          aria-label={session.ignored
            ? `Remove ${displayName} from ignored`
            : `Ignore ${displayName}`}
          aria-pressed={session.ignored}
          title={session.ignored ? "Restore session" : "Ignore long-running session"}
          disabled={attentionBusy}
          onClick={() => onToggleIgnored(session)}
        >
          <EyeOffIcon />
        </button>
        <button
          type="button"
          className={session.starred ? "session-star-toggle active" : "session-star-toggle"}
          aria-label={`${session.starred ? "Remove" : "Add"} ${displayName} ${session.starred ? "from" : "to"} starred`}
          aria-pressed={session.starred}
          title={session.starred ? "Remove from starred" : "Add to starred"}
          disabled={attentionBusy}
          onClick={() => onToggleStar(session)}
        >
          <StarIcon filled={session.starred} />
        </button>
        <button
          type="button"
          className="session-title-edit"
          aria-label={`Edit title and tags for ${session.name}`}
          title="Edit title and tags"
          onClick={(event) => onEdit(session.name, event.currentTarget)}
        >
          <EditIcon />
        </button>
      </div>
    </article>
  );
}

export function SessionDashboard({
  onOpen,
  onOpenInput,
  onResumeWorkspace,
  workspaceReturnSession,
  workspaceTabCount = 0,
  onOpenSnippets,
  onNewSession,
  newSessionWindowHref,
  onSessionsChange,
  currentWorkspaceTabs = [],
  currentWorkspaceGroups = [],
  activeSession = null,
  activeWorkspaceId = null,
  onOpenSavedWorkspace,
  onSavedWorkspaceDeleted,
  onSavedWorkspaceUpdated,
  onSessionTerminated,
}: SessionDashboardProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [route, setRoute] = useState<SessionDashboardRouteState>(initialDashboardRoute);
  const [loading, setLoading] = useState(true);
  const [updateMode, setUpdateMode] = useState<UpdateMode>("connecting");
  const [, setRelativeTimeTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tagFilterMode, setTagFilterMode] = useState<"include" | "exclude">(
    () => route.excludedTags.length > 0 ? "exclude" : "include",
  );
  const [editingSessionName, setEditingSessionName] = useState<string | null>(null);
  const [messageSessionName, setMessageSessionName] = useState<string | null>(null);
  const [snippetSessionName, setSnippetSessionName] = useState<string | null>(null);
  const [terminateTarget, setTerminateTarget] = useState<Session | null>(null);
  const [attentionBusyNames, setAttentionBusyNames] = useState<Set<string>>(() => new Set());
  const tagFilterModeDescriptionId = useId();
  const terminatedSessionsRef = useRef<Session[]>([]);
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const messageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const snippetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const {
    query,
    kind: filter,
    state: stateFilter,
    includedTags,
    excludedTags,
    view: viewMode,
    group: groupMode,
    sort: sortCriteria,
  } = route;
  const resolvedNewSessionWindowHref = isolatedWorkspaceHref(
    newSessionWindowHref ?? `${BASE_PATH}/sessions/new${window.location.search}`,
  );

  const withoutTerminatedSessions = useCallback((next: Session[]) => {
    if (terminatedSessionsRef.current.length === 0) return next;
    return next.filter((session) => !terminatedSessionsRef.current.some(
      (terminated) => hasSameSessionIdentity(session, terminated),
    ));
  }, []);

  useEffect(() => {
    if (!loading) onSessionsChange?.(sessions);
  }, [loading, onSessionsChange, sessions]);

  const updateRoute = useCallback((next: SessionDashboardRouteState) => {
    setRoute(next);
    persistDashboardPreferences(next);
    replaceDashboardUrl(next);
  }, []);

  useEffect(() => {
    persistDashboardPreferences(route);
    replaceDashboardUrl(route);

    const restoreFromHistory = () => {
      const restored = parseSessionDashboardSearch(window.location.search);
      setRoute(restored);
      setTagFilterMode(restored.excludedTags.length > 0 ? "exclude" : "include");
      persistDashboardPreferences(restored);
      replaceDashboardUrl(restored);
    };
    window.addEventListener("popstate", restoreFromHistory);
    return () => window.removeEventListener("popstate", restoreFromHistory);
    // Initial local preferences are canonicalized into the shareable URL once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = "Muxdeck - tmux sessions";
    const controller = new AbortController();
    let stopped = false;
    let pollingTimer: number | undefined;
    let streamVersion = 0;
    let pollRequestId = 0;

    const stopPolling = () => {
      if (pollingTimer !== undefined) {
        window.clearInterval(pollingTimer);
        pollingTimer = undefined;
      }
    };

    const refresh = async () => {
      const requestId = ++pollRequestId;
      const streamVersionAtStart = streamVersion;
      try {
        const next = await listSessions(controller.signal);
        if (
          stopped
          || controller.signal.aborted
          || requestId !== pollRequestId
          || streamVersionAtStart !== streamVersion
        ) return;
        setSessions(withoutTerminatedSessions(next));
        setError(null);
      } catch (requestError) {
        if (
          !stopped
          && !controller.signal.aborted
          && requestId === pollRequestId
          && streamVersionAtStart === streamVersion
        ) {
          setError(requestError instanceof Error ? requestError.message : "Unable to reach tmux");
        }
      } finally {
        if (
          !stopped
          && !controller.signal.aborted
          && requestId === pollRequestId
          && streamVersionAtStart === streamVersion
        ) setLoading(false);
      }
    };

    const startPolling = () => {
      if (stopped || pollingTimer !== undefined) return;
      setUpdateMode("polling");
      pollingTimer = window.setInterval(() => void refresh(), 4000);
    };

    void refresh();
    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeToSessions({
        onSessions: (next) => {
          if (stopped) return;
          streamVersion += 1;
          stopPolling();
          setSessions(withoutTerminatedSessions(next));
          setError(null);
          setLoading(false);
          setUpdateMode("live");
        },
        onStatus: (status) => {
          if (stopped) return;
          if (status === "open") {
            stopPolling();
            setUpdateMode("live");
          } else if (status === "error") {
            startPolling();
          } else {
            setUpdateMode("connecting");
          }
        },
        onError: () => {
          // EventSource reconnects automatically while polling covers the gap.
        },
      });
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      controller.abort();
      stopPolling();
      unsubscribe();
    };
  }, [refreshKey, withoutTerminatedSessions]);

  const visibleSessions = useMemo(
    () => filterSessions(sessions, route),
    [route, sessions],
  );

  const tagVisibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesTagFilters(session, route)),
    [route, sessions],
  );

  const activeSessions = useMemo(
    () => tagVisibleSessions.filter((session) => !session.ignored || session.starred),
    [tagVisibleSessions],
  );

  const tagCounts = useMemo(() => sessions.reduce<Record<SessionTag, number>>(
    (counts, session) => {
      for (const tag of session.tags ?? []) counts[tag] += 1;
      return counts;
    },
    { work: 0, review: 0, research: 0, urgent: 0, blocked: 0, background: 0 },
  ), [sessions]);

  const stateCounts = useMemo(() => activeSessions.reduce<Record<AgentState, number>>(
    (counts, session) => ({ ...counts, [session.agentState]: counts[session.agentState] + 1 }),
    { working: 0, waiting_human: 0, waiting_command: 0, unknown: 0, other: 0 },
  ), [activeSessions]);

  const sortVisibleSessions = useCallback(
    (items: Session[]) => sortSessions(items, sortCriteria),
    [sortCriteria],
  );

  const starredSessions = useMemo(
    () => sortVisibleSessions(tagVisibleSessions.filter((session) => session.starred)),
    [sortVisibleSessions, tagVisibleSessions],
  );
  const ignoredSessions = useMemo(
    () => sortVisibleSessions(tagVisibleSessions.filter(
      (session) => session.ignored && !session.starred,
    )),
    [sortVisibleSessions, tagVisibleSessions],
  );
  const regularSessions = useMemo(
    () => sortVisibleSessions(visibleSessions.filter(
      (session) => !session.starred && !session.ignored,
    )),
    [sortVisibleSessions, visibleSessions],
  );
  const regularStateGroups = useMemo(() => STATE_GROUP_ORDER
    .map((state) => ({ state, sessions: regularSessions.filter((session) => session.agentState === state) }))
    .filter((group) => group.sessions.length > 0), [regularSessions]);
  const regularTagGroups = useMemo(() => groupSessionsByTag(regularSessions), [regularSessions]);
  const groupByState = groupMode === "state";
  const groupByTag = groupMode === "tag";
  const showStateChangeTime = groupByState || sortCriteria.includes("state-change");

  useEffect(() => {
    if (!showStateChangeTime) return;
    const timer = window.setInterval(() => setRelativeTimeTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [showStateChangeTime]);

  const editingSession = sessions.find((session) => session.name === editingSessionName) || null;
  const messageSession = sessions.find((session) => session.name === messageSessionName) || null;
  const closeTitleEditor = useCallback(() => {
    setEditingSessionName(null);
    window.requestAnimationFrame(() => {
      const trigger = editTriggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      document.querySelector<HTMLInputElement>(".search-field input")?.focus();
    });
  }, []);

  const saveDetails = useCallback(async (title: string, tags: SessionTag[]) => {
    if (!editingSession) return;
    const titleChanged = (editingSession.customTitle ?? "") !== title.trim();
    const tagsChanged = (editingSession.tags ?? []).join("\0") !== tags.join("\0");
    if (titleChanged && tagsChanged) {
      const details = await updateSessionDetails(editingSession.name, title, tags);
      setSessions((current) => current.map((session) => (
        session.name === editingSession.name ? { ...session, ...details } : session
      )));
    } else if (titleChanged) {
      const customTitle = await updateSessionTitle(editingSession.name, title);
      setSessions((current) => current.map((session) => (
        session.name === editingSession.name ? { ...session, customTitle } : session
      )));
    } else if (tagsChanged) {
      const savedTags = await updateSessionTags(editingSession.name, tags);
      setSessions((current) => current.map((session) => (
        session.name === editingSession.name ? { ...session, tags: savedTags } : session
      )));
    }
    closeTitleEditor();
  }, [closeTitleEditor, editingSession]);

  const toggleTagFilter = useCallback((tag: SessionTag) => {
    const targetKey = tagFilterMode === "include" ? "includedTags" : "excludedTags";
    const oppositeKey = tagFilterMode === "include" ? "excludedTags" : "includedTags";
    const selected = route[targetKey].includes(tag);
    updateRoute({
      ...route,
      [targetKey]: selected
        ? route[targetKey].filter((item) => item !== tag)
        : SESSION_TAGS.filter((item) => item === tag || route[targetKey].includes(item)),
      [oppositeKey]: route[oppositeKey].filter((item) => item !== tag),
    });
  }, [route, tagFilterMode, updateRoute]);

  const reverseTagFilters = useCallback(() => {
    setTagFilterMode(tagFilterMode === "include" ? "exclude" : "include");
    updateRoute({
      ...route,
      includedTags: [...route.excludedTags],
      excludedTags: [...route.includedTags],
    });
  }, [route, tagFilterMode, updateRoute]);

  const openMessages = useCallback((name: string, trigger: HTMLButtonElement) => {
    messageTriggerRef.current = trigger;
    setMessageSessionName(name);
  }, []);

  const closeMessages = useCallback(() => {
    setMessageSessionName(null);
    window.requestAnimationFrame(() => messageTriggerRef.current?.focus());
  }, []);

  const openSnippets = useCallback((name: string, trigger: HTMLButtonElement) => {
    snippetTriggerRef.current = trigger;
    setSnippetSessionName(name);
  }, []);

  const closeSnippets = useCallback(() => {
    setSnippetSessionName(null);
    window.requestAnimationFrame(() => snippetTriggerRef.current?.focus());
  }, []);

  const terminateSelectedSession = useCallback(async () => {
    if (!terminateTarget || !onSessionTerminated) {
      throw new Error("This tmux session is no longer available.");
    }
    await onSessionTerminated(
      terminateTarget.name,
      terminateTarget.id,
      terminateTarget.created,
      terminateTarget.serverStarted,
      terminateTarget.serverPid,
    );
    terminatedSessionsRef.current.push(terminateTarget);
    setSessions((current) => current.filter((session) => (
      !hasSameSessionIdentity(session, terminateTarget)
    )));
  }, [onSessionTerminated, terminateTarget]);

  const focusAfterTermination = useCallback(() => {
    window.requestAnimationFrame(() => {
      const nextSession = Array.from(document.querySelectorAll<HTMLButtonElement>(
        ".session-card-main",
      )).find((button) => !button.closest("details:not([open])"));
      const search = document.querySelector<HTMLInputElement>(".search-field input");
      (nextSession ?? search)?.focus();
    });
  }, []);

  const chooseViewMode = (next: SessionViewMode) => updateRoute({ ...route, view: next });

  const chooseSortCriteria = (next: SessionSortKey[]) => updateRoute({
    ...route,
    sort: next.length > 0 ? next : [...DEFAULT_SESSION_SORT],
  });

  const toggleStar = useCallback(async (session: Session) => {
    const next = !session.starred;
    setActionError(null);
    setAttentionBusyNames((current) => new Set(current).add(session.name));
    setSessions((current) => current.map((item) => (
      item.name === session.name
        ? { ...item, starred: next, ignored: next ? false : item.ignored }
        : item
    )));
    try {
      const attention = await updateSessionStar(session.name, next);
      setSessions((current) => current.map((item) => (
        item.name === session.name ? { ...item, ...attention } : item
      )));
    } catch (starError) {
      setSessions((current) => current.map((item) => (
        item.name === session.name
          ? { ...item, starred: session.starred, ignored: session.ignored }
          : item
      )));
      setActionError(starError instanceof Error ? starError.message : "Unable to update star");
    } finally {
      setAttentionBusyNames((current) => {
        const nextBusy = new Set(current);
        nextBusy.delete(session.name);
        return nextBusy;
      });
    }
  }, []);

  const toggleIgnored = useCallback(async (session: Session) => {
    const next = !session.ignored;
    setActionError(null);
    setAttentionBusyNames((current) => new Set(current).add(session.name));
    setSessions((current) => current.map((item) => (
      item.name === session.name
        ? { ...item, ignored: next, starred: next ? false : item.starred }
        : item
    )));
    try {
      const attention = await updateSessionIgnored(session.name, next);
      setSessions((current) => current.map((item) => (
        item.name === session.name ? { ...item, ...attention } : item
      )));
    } catch (ignoreError) {
      setSessions((current) => current.map((item) => (
        item.name === session.name
          ? { ...item, starred: session.starred, ignored: session.ignored }
          : item
      )));
      setActionError(
        ignoreError instanceof Error
          ? ignoreError.message
          : "Unable to update ignored status",
      );
    } finally {
      setAttentionBusyNames((current) => {
        const nextBusy = new Set(current);
        nextBusy.delete(session.name);
        return nextBusy;
      });
    }
  }, []);

  return (
    <main className="dashboard-shell">
      <div className="ambient-grid" />
      <header className="dashboard-header">
        <div className="brand-lockup">
          <div className="brand-mark"><TerminalIcon /></div>
          <div>
            <p className="eyebrow">TMUX FIELD CONSOLE</p>
            <h1>Muxdeck</h1>
          </div>
        </div>
        <div className="dashboard-header-tools">
          <div className="server-pulse">
            <span className={error ? "pulse-dot error" : "pulse-dot"} />
            {error ? "offline" : `${sessions.length} sessions / ${updateMode}`}
          </div>
          <AppTabs
            active="sessions"
            onSessions={() => undefined}
            onSnippets={() => onOpenSnippets?.()}
          />
          <ThemeToggle />
        </div>
      </header>

      <section className="dashboard-intro">
        <p className="section-index">01 / SELECT</p>
        <h2>Pick up where<br />the agents left off.</h2>
        <div className="intro-copy">
          <p>Open any running Claude, Codex, Copilot, Cursor, Grok, or shell session. Output stays live; input goes straight to its tmux client.</p>
          {onResumeWorkspace && workspaceReturnSession && workspaceTabCount > 0 && (
            <button
              type="button"
              className="secondary-button dashboard-workspace-resume"
              onClick={onResumeWorkspace}
              aria-label={`Resume workspace at ${workspaceReturnSession}, ${workspaceTabCount} open ${workspaceTabCount === 1 ? "tab" : "tabs"}`}
            >
              <span className="dashboard-workspace-resume-icon"><TerminalIcon /></span>
              <span className="dashboard-workspace-resume-copy">
                <strong>Resume workspace</strong>
                <small title={workspaceReturnSession}>Resume at · {workspaceReturnSession}</small>
              </span>
              <span className="dashboard-workspace-resume-count" aria-hidden="true">
                {workspaceTabCount} {workspaceTabCount === 1 ? "tab" : "tabs"}
              </span>
              <ChevronRightIcon />
            </button>
          )}
          <div className="dashboard-new-session-actions" role="group" aria-label="New session actions">
            <button
              type="button"
              className="primary-button dashboard-new-session-primary"
              onClick={() => onNewSession?.()}
            >
              <TerminalIcon /> New session
            </button>
            <a
              className="secondary-button dashboard-new-session-window"
              href={resolvedNewSessionWindowHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open new session in new window"
            >
              <ExternalLinkIcon /> New window
            </a>
          </div>
        </div>
      </section>

      <SavedWorkspaceList
        currentTabs={currentWorkspaceTabs}
        currentWorkspaceGroups={currentWorkspaceGroups}
        activeSession={activeSession}
        activeWorkspaceId={activeWorkspaceId}
        onOpen={(workspace) => onOpenSavedWorkspace?.(workspace)}
        onDeleted={onSavedWorkspaceDeleted}
        onUpdated={onSavedWorkspaceUpdated}
      />

      <section className="session-controls" aria-label="Session filters">
        <label className="search-field">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => updateRoute({ ...route, query: event.target.value })}
            placeholder="Find a session, tag, command, or path"
            aria-label="Find a session"
          />
          {query && <button type="button" onClick={() => updateRoute({ ...route, query: "" })} aria-label="Clear search">Clear</button>}
        </label>
        <div className="filter-stack">
          <div className="filter-row kind-filter-row" aria-label="Session type">
            {KIND_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                className={filter === item ? "filter-chip active" : "filter-chip"}
                onClick={() => updateRoute({ ...route, kind: item })}
                aria-pressed={filter === item}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="filter-row state-filter-row" aria-label="Agent state">
            {STATE_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                className={stateFilter === item ? "filter-chip state-filter active" : "filter-chip state-filter"}
                onClick={() => updateRoute({ ...route, state: item })}
                aria-pressed={stateFilter === item}
              >
                {item === "any" ? "Any state" : STATE_LABELS[item]}
                {item !== "any" && <span>{stateCounts[item]}</span>}
              </button>
            ))}
            <button
              type="button"
              className="refresh-button"
              onClick={() => { setLoading(true); setRefreshKey((key) => key + 1); }}
              aria-label="Refresh sessions"
            >
              <RefreshIcon className={loading ? "spinning" : ""} />
            </button>
          </div>
        </div>
        <fieldset className="tag-filter-panel">
          <legend>Tags</legend>
          <div className="tag-filter-header">
            <p id={tagFilterModeDescriptionId} aria-live="polite">
              {tagFilterMode === "include"
                ? "Tag clicks include matches; included tags match any."
                : "Tag clicks exclude matches; excluded sessions never appear."}
            </p>
            <div className="tag-filter-actions" role="group" aria-label="Tag filter mode">
              <button
                type="button"
                className={tagFilterMode === "exclude" ? "tag-filter-mode active" : "tag-filter-mode"}
                aria-describedby={tagFilterModeDescriptionId}
                onClick={reverseTagFilters}
              >
                <EyeOffIcon /> {tagFilterMode === "include" ? "Exclude matches" : "Include matches"}
              </button>
              <button
                type="button"
                className="tag-filter-clear"
                aria-label="Clear tag filters"
                disabled={includedTags.length === 0 && excludedTags.length === 0}
                onClick={() => updateRoute({
                  ...route,
                  includedTags: [],
                  excludedTags: [],
                })}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="tag-filter-options">
            {SESSION_TAGS.map((tag) => {
              const included = includedTags.includes(tag);
              const excluded = excludedTags.includes(tag);
              const selectedInMode = tagFilterMode === "include" ? included : excluded;
              const selectedInOtherMode = tagFilterMode === "include" ? excluded : included;
              const action = tagFilterMode === "include" ? "Include" : "Exclude";
              const label = SESSION_TAG_LABELS[tag];
              const countLabel = `${tagCounts[tag]} ${tagCounts[tag] === 1 ? "session" : "sessions"}`;
              const ariaLabel = selectedInMode
                ? `Remove ${label} ${tagFilterMode} filter, ${countLabel}`
                : selectedInOtherMode
                  ? `Change ${label} to ${tagFilterMode} filter, ${countLabel}`
                  : `Add ${label} ${tagFilterMode} filter, ${countLabel}`;
              return (
                <button
                  type="button"
                  key={tag}
                  className={`tag-filter-chip tag-${tag}${included ? " included" : ""}${excluded ? " excluded" : ""}`}
                  aria-label={ariaLabel}
                  onClick={() => toggleTagFilter(tag)}
                >
                  {(included || excluded) && (
                    <span className="tag-filter-sign" aria-hidden="true">{included ? "+" : "-"}</span>
                  )}
                  <span>{label}</span>
                  <small>{tagCounts[tag]}</small>
                </button>
              );
            })}
          </div>
        </fieldset>
      </section>

      {error && <div className="dashboard-error" role="alert">{error}</div>}
      {actionError && <div className="dashboard-error action-error" role="alert">{actionError}</div>}

      {loading && sessions.length === 0 ? (
        <section className="session-grid" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => <div className="session-card skeleton" key={index} />)}
        </section>
      ) : (
        <>
          <div className="results-toolbar">
            <div>
              <p className="eyebrow">03 / SESSIONS</p>
              <p className="results-summary" aria-live="polite">
                {starredSessions.length} starred / {regularSessions.length} filtered / {ignoredSessions.length} ignored
              </p>
            </div>
            <div className="results-tools">
              <div className="view-switch" aria-label="Session view">
                <button type="button" className={viewMode === "cards" ? "active" : ""} aria-pressed={viewMode === "cards"} onClick={() => chooseViewMode("cards")}>
                  <GridIcon /> Cards
                </button>
                <button type="button" className={viewMode === "list" ? "active" : ""} aria-pressed={viewMode === "list"} onClick={() => chooseViewMode("list")}>
                  <ListIcon /> List
                </button>
              </div>
            </div>
          </div>

          <SessionSortControls
            criteria={sortCriteria}
            group={groupMode}
            onChange={chooseSortCriteria}
            onGroupChange={(group) => updateRoute({ ...route, group })}
          />

          {starredSessions.length > 0 && (
            <section className="session-section starred-section" aria-labelledby="starred-heading">
              <header className="session-section-header">
                <div>
                  <p className="eyebrow">PINNED</p>
                  <h2 id="starred-heading"><StarIcon filled /> Starred</h2>
                </div>
                <span>{starredSessions.length}</span>
              </header>
              <div className={viewMode === "list" ? "session-grid session-list" : "session-grid"}>
                {starredSessions.map((session, index) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    index={index}
                    viewMode={viewMode}
                    showStateChangeTime={showStateChangeTime}
                    attentionBusy={attentionBusyNames.has(session.name)}
                    onOpen={onOpen}
                    onEdit={(name, trigger) => {
                      editTriggerRef.current = trigger;
                      setEditingSessionName(name);
                    }}
                    onMessages={openMessages}
                    onSnippets={openSnippets}
                    onTerminate={onSessionTerminated ? setTerminateTarget : undefined}
                    onToggleStar={(item) => void toggleStar(item)}
                    onToggleIgnored={(item) => void toggleIgnored(item)}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="session-section" aria-labelledby="sessions-heading">
            <header className="session-section-header compact">
              <div>
                <p className="eyebrow">FILTERED</p>
                <h2 id="sessions-heading">Sessions</h2>
              </div>
              <span>{regularSessions.length}</span>
            </header>
            {groupByState ? (
              <div className="state-session-groups" aria-busy={loading}>
                {regularStateGroups.map((group) => (
                  <section className={`state-session-group ${group.state}`} key={group.state} aria-labelledby={`state-group-${group.state}`}>
                    <header className="state-group-header">
                      <h3 id={`state-group-${group.state}`}><span />{STATE_LABELS[group.state]}</h3>
                      <span>{group.sessions.length}</span>
                    </header>
                    <div className={viewMode === "list" ? "session-grid session-list" : "session-grid"}>
                      {group.sessions.map((session, index) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          index={index}
                          viewMode={viewMode}
                          showStateChangeTime
                          attentionBusy={attentionBusyNames.has(session.name)}
                          onOpen={onOpen}
                          onEdit={(name, trigger) => {
                            editTriggerRef.current = trigger;
                            setEditingSessionName(name);
                          }}
                          onMessages={openMessages}
                          onSnippets={openSnippets}
                          onTerminate={onSessionTerminated ? setTerminateTarget : undefined}
                          onToggleStar={(item) => void toggleStar(item)}
                          onToggleIgnored={(item) => void toggleIgnored(item)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : groupByTag ? (
              <div className="state-session-groups tag-session-groups" aria-busy={loading}>
                {regularTagGroups.map((group) => {
                  const groupName = group.tag ?? "untagged";
                  const groupLabel = group.tag ? SESSION_TAG_LABELS[group.tag] : "Untagged";
                  return (
                    <section
                      className={`state-session-group tag-session-group tag-${groupName}`}
                      key={groupName}
                      aria-labelledby={`tag-group-${groupName}`}
                    >
                      <header className="state-group-header">
                        <h3 id={`tag-group-${groupName}`}><span />{groupLabel}</h3>
                        <span>{group.sessions.length}</span>
                      </header>
                      <div className={viewMode === "list" ? "session-grid session-list" : "session-grid"}>
                        {group.sessions.map((session, index) => (
                          <SessionItem
                            key={session.id}
                            session={session}
                            index={index}
                            viewMode={viewMode}
                            showStateChangeTime={showStateChangeTime}
                            attentionBusy={attentionBusyNames.has(session.name)}
                            onOpen={onOpen}
                            onEdit={(name, trigger) => {
                              editTriggerRef.current = trigger;
                              setEditingSessionName(name);
                            }}
                            onMessages={openMessages}
                            onSnippets={openSnippets}
                            onTerminate={onSessionTerminated ? setTerminateTarget : undefined}
                            onToggleStar={(item) => void toggleStar(item)}
                            onToggleIgnored={(item) => void toggleIgnored(item)}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className={viewMode === "list" ? "session-grid session-list" : "session-grid"} aria-busy={loading}>
                {regularSessions.map((session, index) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    index={index}
                    viewMode={viewMode}
                    showStateChangeTime={showStateChangeTime}
                    attentionBusy={attentionBusyNames.has(session.name)}
                    onOpen={onOpen}
                    onEdit={(name, trigger) => {
                      editTriggerRef.current = trigger;
                      setEditingSessionName(name);
                    }}
                    onMessages={openMessages}
                    onSnippets={openSnippets}
                    onTerminate={onSessionTerminated ? setTerminateTarget : undefined}
                    onToggleStar={(item) => void toggleStar(item)}
                    onToggleIgnored={(item) => void toggleIgnored(item)}
                  />
                ))}
              </div>
            )}
          </section>

          <details className="session-section ignored-section">
            <summary className="ignored-section-summary">
              <span className="ignored-section-heading">
                <span className="eyebrow">BACKGROUND</span>
                <span className="ignored-section-title"><EyeOffIcon /> Ignored</span>
              </span>
              <span className="ignored-section-count">{ignoredSessions.length}</span>
            </summary>
            <p className="ignored-section-copy">
              Long-running sessions kept out of the active filtered queue.
            </p>
            <div className={viewMode === "list" ? "session-grid session-list" : "session-grid"}>
              {ignoredSessions.map((session, index) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  index={index}
                  viewMode={viewMode}
                  showStateChangeTime={showStateChangeTime}
                  attentionBusy={attentionBusyNames.has(session.name)}
                  onOpen={onOpen}
                  onEdit={(name, trigger) => {
                    editTriggerRef.current = trigger;
                    setEditingSessionName(name);
                  }}
                  onMessages={openMessages}
                  onSnippets={openSnippets}
                  onTerminate={onSessionTerminated ? setTerminateTarget : undefined}
                  onToggleStar={(item) => void toggleStar(item)}
                  onToggleIgnored={(item) => void toggleIgnored(item)}
                />
              ))}
            </div>
          </details>

          {regularSessions.length === 0
            && starredSessions.length === 0
            && ignoredSessions.length === 0 && (
            <div className="empty-state">
              <TerminalIcon />
              <h3>No matching sessions</h3>
              <p>Try another search or filter.</p>
            </div>
          )}
          {regularSessions.length === 0
            && (starredSessions.length > 0 || ignoredSessions.length > 0) && (
            <div className="no-filter-results">No other sessions match the current filters.</div>
          )}
        </>
      )}

      {editingSession && (
        <SessionTitleDialog
          session={editingSession}
          onClose={closeTitleEditor}
          onSave={saveDetails}
        />
      )}
      {messageSession && (
        <MessageQueueDialog
          sessionName={messageSession.name}
          sessionTitle={messageSession.customTitle}
          onClose={closeMessages}
          onCountsChange={({ total, queued }) => {
            setSessions((current) => current.map((session) => (
              session.name === messageSession.name
                ? { ...session, memorandumCount: total, queuedMessageCount: queued }
                : session
            )));
          }}
        />
      )}
      {snippetSessionName && (
        <SnippetPickerDialog
          title={`Stage a snippet for ${snippetSessionName}`}
          onClose={closeSnippets}
          onManage={onOpenSnippets}
          onChoose={(snippet) => {
            const result = stageSessionDraft(snippetSessionName, snippet.text);
            if (result === "cancelled") return false;
            if (result === "storage-error") {
              throw new Error("The snippet could not be saved in this browser; the staged input was left unchanged.");
            }
            if (result === "invalid") {
              throw new Error("This snippet does not fit in the staged input.");
            }
            (onOpenInput ?? onOpen)(snippetSessionName);
          }}
        />
      )}
      {terminateTarget && onSessionTerminated && (
        <SessionTerminateDialog
          sessionName={terminateTarget.name}
          sessionTitle={terminateTarget.customTitle}
          onClose={() => setTerminateTarget(null)}
          onTerminate={terminateSelectedSession}
          onFallbackFocus={focusAfterTermination}
        />
      )}
    </main>
  );
}
