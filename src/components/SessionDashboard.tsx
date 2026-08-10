import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BASE_PATH, listSessions, subscribeToSessions, updateSessionStar, updateSessionTitle } from "../api";
import {
  ChevronRightIcon,
  EditIcon,
  ExternalLinkIcon,
  GridIcon,
  ListIcon,
  MemoIcon,
  RefreshIcon,
  SearchIcon,
  SnippetIcon,
  StarIcon,
  TerminalIcon,
} from "../icons";
import {
  DEFAULT_SESSION_SORT,
  SESSION_STATE_ORDER,
  filterSessions,
  parseSessionDashboardSearch,
  sessionStateChangedAt,
  serializeSessionDashboardSearch,
  sortSessions,
  type SessionDashboardRouteState,
  type SessionKindFilter,
  type SessionSortKey,
  type SessionStateFilter,
  type SessionViewMode,
} from "../sessionDashboardModel";
import type { AgentState, Pane, Session } from "../types";
import { AppTabs } from "./AppTabs";
import { stageSessionDraft } from "./InputBar";
import { MessageQueueDialog } from "./MessageQueueDialog";
import { SessionSortControls } from "./SessionSortControls";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import { SessionTitleDialog } from "./SessionTitleDialog";

interface SessionDashboardProps {
  onOpen: (session: string) => void;
  onOpenSnippets?: () => void;
}

type UpdateMode = "connecting" | "live" | "polling";

const VIEW_MODE_KEY = "muxdeck-session-view";
const SORT_MODE_KEY = "muxdeck-session-sort";
const SORT_PRIORITY_KEY = "muxdeck-session-sort-priority";
const GROUP_MODE_KEY = "muxdeck-session-group";
const KIND_FILTERS: SessionKindFilter[] = ["all", "agents", "claude", "codex", "shells"];
const STATE_GROUP_ORDER = [...SESSION_STATE_ORDER];
const DASHBOARD_QUERY_KEYS = ["q", "kind", "filter", "state", "view", "group", "sort"];

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Command wait",
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
  const command = pane?.command.toLowerCase() || "";
  if (command.includes("claude")) return { label: "Claude", tone: "claude" };
  if (command.includes("codex")) return { label: "Codex", tone: "codex" };
  if (["bash", "zsh", "fish", "sh"].includes(command)) return { label: "Shell", tone: "shell" };
  return { label: pane?.command || "Process", tone: "process" };
}

export function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
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

    if (window.localStorage.getItem(GROUP_MODE_KEY) === "state") parsed.group = "state";
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
  const search = serializeSessionDashboardSearch(route, window.location.search);
  const target = `${window.location.pathname}${search}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", target);
}

function sessionConsoleHref(sessionName: string): string {
  return `${BASE_PATH}/session/${encodeURIComponent(sessionName)}${window.location.search}`;
}

interface SessionItemProps {
  session: Session;
  index: number;
  viewMode: SessionViewMode;
  showStateChangeTime: boolean;
  starBusy: boolean;
  onOpen: (name: string) => void;
  onEdit: (name: string, trigger: HTMLButtonElement) => void;
  onMessages: (name: string, trigger: HTMLButtonElement) => void;
  onSnippets: (name: string, trigger: HTMLButtonElement) => void;
  onToggleStar: (session: Session) => void;
}

function SessionItem({
  session,
  index,
  viewMode,
  showStateChangeTime,
  starBusy,
  onOpen,
  onEdit,
  onMessages,
  onSnippets,
  onToggleStar,
}: SessionItemProps) {
  const pane = activePane(session);
  const classification = classifyPane(pane);
  const cardStyle = { "--i": Math.min(index, 14) } as CSSProperties;
  const displayName = session.customTitle || session.name;

  return (
    <article
      className={viewMode === "list" ? "session-card session-row" : "session-card"}
      style={cardStyle}
    >
      <button
        type="button"
        className="session-card-main"
        onClick={() => onOpen(session.name)}
        aria-label={`Open ${displayName}`}
      >
        <div className="session-card-top">
          <span className="session-badges">
            <span className={`agent-badge ${classification.tone}`}>{classification.label}</span>
            <span className={`state-badge ${session.agentState}`} title={session.agentStateReason}>{STATE_LABELS[session.agentState]}</span>
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
          className="session-messages-toggle"
          aria-label={`Manage memoranda for ${displayName}`}
          title="Queued memoranda"
          onClick={(event) => onMessages(session.name, event.currentTarget)}
        >
          <MemoIcon />
          {session.queuedMessageCount > 0 && <span>{session.queuedMessageCount}</span>}
        </button>
        <button
          type="button"
          className={session.starred ? "session-star-toggle active" : "session-star-toggle"}
          aria-label={`${session.starred ? "Remove" : "Add"} ${displayName} ${session.starred ? "from" : "to"} starred`}
          aria-pressed={session.starred}
          title={session.starred ? "Remove from starred" : "Add to starred"}
          disabled={starBusy}
          onClick={() => onToggleStar(session)}
        >
          <StarIcon filled={session.starred} />
        </button>
        <button
          type="button"
          className="session-title-edit"
          aria-label={`Edit title for ${session.name}`}
          title="Edit human title"
          onClick={(event) => onEdit(session.name, event.currentTarget)}
        >
          <EditIcon />
        </button>
      </div>
    </article>
  );
}

export function SessionDashboard({ onOpen, onOpenSnippets }: SessionDashboardProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [route, setRoute] = useState<SessionDashboardRouteState>(initialDashboardRoute);
  const [loading, setLoading] = useState(true);
  const [updateMode, setUpdateMode] = useState<UpdateMode>("connecting");
  const [, setRelativeTimeTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingSessionName, setEditingSessionName] = useState<string | null>(null);
  const [messageSessionName, setMessageSessionName] = useState<string | null>(null);
  const [snippetSessionName, setSnippetSessionName] = useState<string | null>(null);
  const [starBusyNames, setStarBusyNames] = useState<Set<string>>(() => new Set());
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const messageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const snippetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const {
    query,
    kind: filter,
    state: stateFilter,
    view: viewMode,
    group: groupMode,
    sort: sortCriteria,
  } = route;

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
      persistDashboardPreferences(restored);
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
        setSessions(next);
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
          setSessions(next);
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
  }, [refreshKey]);

  const visibleSessions = useMemo(
    () => filterSessions(sessions, route),
    [route, sessions],
  );

  const stateCounts = useMemo(() => sessions.reduce<Record<AgentState, number>>(
    (counts, session) => ({ ...counts, [session.agentState]: counts[session.agentState] + 1 }),
    { working: 0, waiting_human: 0, waiting_command: 0, unknown: 0, other: 0 },
  ), [sessions]);

  const sortVisibleSessions = useCallback(
    (items: Session[]) => sortSessions(items, sortCriteria),
    [sortCriteria],
  );

  const starredSessions = useMemo(
    () => sortVisibleSessions(sessions.filter((session) => session.starred)),
    [sessions, sortVisibleSessions],
  );
  const regularSessions = useMemo(
    () => sortVisibleSessions(visibleSessions.filter((session) => !session.starred)),
    [sortVisibleSessions, visibleSessions],
  );
  const regularStateGroups = useMemo(() => STATE_GROUP_ORDER
    .map((state) => ({ state, sessions: regularSessions.filter((session) => session.agentState === state) }))
    .filter((group) => group.sessions.length > 0), [regularSessions]);
  const groupByState = groupMode === "state";
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
    window.requestAnimationFrame(() => editTriggerRef.current?.focus());
  }, []);

  const saveTitle = useCallback(async (title: string) => {
    if (!editingSession) return;
    const customTitle = await updateSessionTitle(editingSession.name, title);
    setSessions((current) => current.map((session) => (
      session.name === editingSession.name ? { ...session, customTitle } : session
    )));
    closeTitleEditor();
  }, [closeTitleEditor, editingSession]);

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

  const chooseViewMode = (next: SessionViewMode) => updateRoute({ ...route, view: next });

  const chooseSortCriteria = (next: SessionSortKey[]) => updateRoute({
    ...route,
    sort: next.length > 0 ? next : [...DEFAULT_SESSION_SORT],
  });

  const toggleStar = useCallback(async (session: Session) => {
    const next = !session.starred;
    setActionError(null);
    setStarBusyNames((current) => new Set(current).add(session.name));
    setSessions((current) => current.map((item) => (
      item.name === session.name ? { ...item, starred: next } : item
    )));
    try {
      const starred = await updateSessionStar(session.name, next);
      setSessions((current) => current.map((item) => (
        item.name === session.name ? { ...item, starred } : item
      )));
    } catch (starError) {
      setSessions((current) => current.map((item) => (
        item.name === session.name ? { ...item, starred: session.starred } : item
      )));
      setActionError(starError instanceof Error ? starError.message : "Unable to update star");
    } finally {
      setStarBusyNames((current) => {
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
        </div>
      </header>

      <section className="dashboard-intro">
        <p className="section-index">01 / SELECT</p>
        <h2>Pick up where<br />the agents left off.</h2>
        <p className="intro-copy">Open any running Claude, Codex, or shell session. Output stays live; input goes straight to its tmux client.</p>
      </section>

      <section className="session-controls" aria-label="Session filters">
        <label className="search-field">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => updateRoute({ ...route, query: event.target.value })}
            placeholder="Find a session, command, or path"
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
              <p className="eyebrow">02 / SESSIONS</p>
              <p className="results-summary">{starredSessions.length} starred / {regularSessions.length} filtered</p>
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
                    starBusy={starBusyNames.has(session.name)}
                    onOpen={onOpen}
                    onEdit={(name, trigger) => {
                      editTriggerRef.current = trigger;
                      setEditingSessionName(name);
                    }}
                    onMessages={openMessages}
                    onSnippets={openSnippets}
                    onToggleStar={(item) => void toggleStar(item)}
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
                          starBusy={starBusyNames.has(session.name)}
                          onOpen={onOpen}
                          onEdit={(name, trigger) => {
                            editTriggerRef.current = trigger;
                            setEditingSessionName(name);
                          }}
                          onMessages={openMessages}
                          onSnippets={openSnippets}
                          onToggleStar={(item) => void toggleStar(item)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
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
                    starBusy={starBusyNames.has(session.name)}
                    onOpen={onOpen}
                    onEdit={(name, trigger) => {
                      editTriggerRef.current = trigger;
                      setEditingSessionName(name);
                    }}
                    onMessages={openMessages}
                    onSnippets={openSnippets}
                    onToggleStar={(item) => void toggleStar(item)}
                  />
                ))}
              </div>
            )}
          </section>

          {regularSessions.length === 0 && starredSessions.length === 0 && (
            <div className="empty-state">
              <TerminalIcon />
              <h3>No matching sessions</h3>
              <p>Try another search or filter.</p>
            </div>
          )}
          {regularSessions.length === 0 && starredSessions.length > 0 && (
            <div className="no-filter-results">No other sessions match the current filters.</div>
          )}
        </>
      )}

      {editingSession && (
        <SessionTitleDialog
          session={editingSession}
          onClose={closeTitleEditor}
          onSave={saveTitle}
        />
      )}
      {messageSession && (
        <MessageQueueDialog
          sessionName={messageSession.name}
          sessionTitle={messageSession.customTitle}
          onClose={closeMessages}
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
            onOpen(snippetSessionName);
          }}
        />
      )}
    </main>
  );
}
