import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  CloseIcon,
  GridIcon,
  HistoryIcon,
  SearchIcon,
  TerminalIcon,
} from "../icons";
import { paneCommandKind, sessionDisplayTitle, sortSessions } from "../sessionDashboardModel";
import type { AgentState, Pane, Session } from "../types";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";

export interface SessionWorkspaceNavigationProps {
  activeSession: string | null;
  openSessions: string[];
  recentSessions: string[];
  sessions: Session[];
  recentsOpen: boolean;
  tabsVisible?: boolean;
  newSessionActive?: boolean;
  onSelect: (sessionName: string) => void;
  onCloseTab: (sessionName: string) => void;
  onCloseNewSession?: () => void;
  onOpenRecents: () => void;
  onCloseRecents: () => void;
  onClearRecents: () => void;
  onOpenDashboard: () => void;
}

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Command wait",
  unknown: "Unclear",
  other: "Other",
};

function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

function paneLabel(pane?: Pane): string {
  switch (paneCommandKind(pane?.command || "")) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "shells": return "Shell";
    default: return pane?.command || "Process";
  }
}

function tabTitle(sessionName: string, sessionsByName: Map<string, Session>): string {
  const session = sessionsByName.get(sessionName);
  return session ? sessionDisplayTitle(session) : sessionName;
}

function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabList = event.currentTarget.closest("[role='tablist']");
  const tabs = tabList
    ? Array.from(tabList.querySelectorAll<HTMLButtonElement>("[role='tab']"))
    : [];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) return;

  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  tabs[nextIndex]?.focus();
}

interface WorkspaceSessionRowProps {
  sessionName: string;
  session?: Session;
  active: boolean;
  open: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function WorkspaceSessionRow({
  sessionName,
  session,
  active,
  open,
  onSelect,
  onClose,
}: WorkspaceSessionRowProps) {
  const pane = session ? activePane(session) : undefined;
  const displayTitle = session ? sessionDisplayTitle(session) : sessionName;
  const stateLabel = session ? STATE_LABELS[session.agentState] : "Unavailable";

  return (
    <div className={active ? "workspace-session-row active" : "workspace-session-row"}>
      <button
        type="button"
        className="workspace-session-select"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
      >
        <span
          className={`workspace-state-dot ${session?.agentState || "unavailable"}`}
          aria-hidden="true"
        />
        <span className="workspace-session-copy">
          <strong>{displayTitle}</strong>
          <span>
            {displayTitle !== sessionName ? `${sessionName} / ` : ""}
            {session ? paneLabel(pane) : "tmux session ended"}
          </span>
        </span>
        <span className={`workspace-session-status ${session?.agentState || "unavailable"}`}>
          {active ? "Active" : stateLabel}
        </span>
      </button>
      {open && onClose && (
        <button
          type="button"
          className="workspace-session-close"
          onClick={onClose}
          aria-label={`Close ${displayTitle} quick tab`}
          title="Close quick tab"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

interface WorkspaceRecentsDialogProps extends SessionWorkspaceNavigationProps {
  sessionsByName: Map<string, Session>;
}

function WorkspaceRecentsDialog({
  activeSession,
  openSessions,
  recentSessions,
  sessions,
  sessionsByName,
  onSelect,
  onCloseTab,
  onCloseRecents,
  onClearRecents,
  onOpenDashboard,
}: WorkspaceRecentsDialogProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openSet = useMemo(() => new Set(openSessions), [openSessions]);
  const recentSet = useMemo(() => new Set(recentSessions), [recentSessions]);
  const normalizedQuery = query.trim().toLowerCase();

  const matchesQuery = (sessionName: string): boolean => {
    if (!normalizedQuery) return true;
    const session = sessionsByName.get(sessionName);
    const pane = session ? activePane(session) : undefined;
    return [sessionName, session?.customTitle, pane?.command, pane?.path, pane?.title]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedQuery));
  };

  const filteredOpen = openSessions.filter(matchesQuery);
  const filteredRecent = recentSessions
    .filter((sessionName) => !openSet.has(sessionName))
    .filter(matchesQuery);
  const filteredAvailable = sortSessions(sessions, ["state", "activity", "tmux-name"])
    .sort((left, right) => Number(left.ignored) - Number(right.ignored))
    .map((session) => session.name)
    .filter((sessionName) => !openSet.has(sessionName) && !recentSet.has(sessionName))
    .filter(matchesQuery);
  const resultCount = filteredOpen.length + filteredRecent.length + filteredAvailable.length;

  const closeDialogTab = (sessionName: string) => {
    onCloseTab(sessionName);
    window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog?.isConnected && !dialog.contains(document.activeElement)) {
        searchRef.current?.focus();
      }
    });
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRecents();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onCloseRecents]);

  return (
    <div className="workspace-recents-backdrop" role="presentation" onMouseDown={onCloseRecents}>
      <aside
        ref={dialogRef}
        className="workspace-recents-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-recents-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-recents-header">
          <div>
            <p className="eyebrow">THIS BROWSER PAGE / WORKSPACE</p>
            <h2 id="workspace-recents-title">Switch sessions</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCloseRecents} aria-label="Close session switcher">
            <CloseIcon />
          </button>
        </header>

        <label className="workspace-session-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an open, recent, or live session"
            aria-label="Find a workspace session"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear workspace search">
              Clear
            </button>
          )}
        </label>

        <p className="workspace-sr-only" role="status" aria-live="polite">
          {resultCount} {resultCount === 1 ? "session" : "sessions"} found
        </p>

        <div className="workspace-recents-scroll">
          {filteredOpen.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-open-heading">
              <header>
                <div>
                  <p className="eyebrow">QUICK SWITCH</p>
                  <h3 id="workspace-open-heading">Open tabs</h3>
                </div>
                <span>{filteredOpen.length}</span>
              </header>
              <div className="workspace-session-list">
                {filteredOpen.map((sessionName) => (
                  <WorkspaceSessionRow
                    key={sessionName}
                    sessionName={sessionName}
                    session={sessionsByName.get(sessionName)}
                    active={sessionName === activeSession}
                    open
                    onSelect={() => onSelect(sessionName)}
                    onClose={() => closeDialogTab(sessionName)}
                  />
                ))}
              </div>
            </section>
          )}

          {filteredRecent.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-recent-heading">
              <header>
                <div>
                  <p className="eyebrow">VISIT TRAIL</p>
                  <h3 id="workspace-recent-heading">Recently visited</h3>
                </div>
                <button type="button" className="workspace-clear-recents" onClick={onClearRecents}>
                  Clear closed
                </button>
              </header>
              <div className="workspace-session-list">
                {filteredRecent.map((sessionName) => (
                  <WorkspaceSessionRow
                    key={sessionName}
                    sessionName={sessionName}
                    session={sessionsByName.get(sessionName)}
                    active={false}
                    open={false}
                    onSelect={() => onSelect(sessionName)}
                  />
                ))}
              </div>
            </section>
          )}

          {filteredAvailable.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-available-heading">
              <header>
                <div>
                  <p className="eyebrow">TMUX SERVER</p>
                  <h3 id="workspace-available-heading">Other live sessions</h3>
                </div>
                <span>{filteredAvailable.length}</span>
              </header>
              <div className="workspace-session-list">
                {filteredAvailable.map((sessionName) => (
                  <WorkspaceSessionRow
                    key={sessionName}
                    sessionName={sessionName}
                    session={sessionsByName.get(sessionName)}
                    active={false}
                    open={false}
                    onSelect={() => onSelect(sessionName)}
                  />
                ))}
              </div>
            </section>
          )}

          {resultCount === 0 && (
            <div className="workspace-recents-empty">
              <TerminalIcon />
              <h3>{normalizedQuery ? "No matching sessions" : "No other sessions yet"}</h3>
              <p>{normalizedQuery ? "Try a different title, command, or path." : "Open a session from the dashboard to start a visit trail."}</p>
            </div>
          )}
        </div>

        <footer className="workspace-recents-footer">
          <p>Open tabs follow this URL. Closed visits clear when the page reloads.</p>
          <button type="button" className="secondary-button" onClick={onOpenDashboard}>
            <GridIcon /> Browse all
          </button>
        </footer>
      </aside>
    </div>
  );
}

export function SessionWorkspaceNavigation(props: SessionWorkspaceNavigationProps) {
  const {
    activeSession,
    openSessions,
    recentSessions,
    sessions,
    recentsOpen,
    tabsVisible = true,
    newSessionActive = false,
    onSelect,
    onCloseTab,
    onCloseNewSession,
    onOpenRecents,
    onOpenDashboard,
  } = props;
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const focusActiveTabAfterClose = useRef(false);
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const closedRecentCount = recentSessions.filter((name) => !openSessions.includes(name)).length;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTab = activeTabRef.current;
      activeTab?.scrollIntoView?.({ block: "nearest", inline: "center" });
      if (focusActiveTabAfterClose.current && activeTab) {
        focusActiveTabAfterClose.current = false;
        activeTab.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession, newSessionActive, openSessions, tabsVisible]);

  const closeQuickTab = (sessionName: string) => {
    focusActiveTabAfterClose.current = true;
    onCloseTab(sessionName);
  };

  const closeNewSession = () => {
    focusActiveTabAfterClose.current = true;
    onCloseNewSession?.();
  };

  return (
    <>
      <nav
        id="muxdeck-session-tabs"
        className="workspace-navigation"
        aria-label="Session workspace"
        hidden={!tabsVisible}
      >
          <button
            type="button"
            className="workspace-dashboard-button"
            onClick={onOpenDashboard}
            aria-label="All sessions"
            title="All sessions"
          >
            <GridIcon />
            <span>Sessions</span>
          </button>
          <div className="workspace-tab-viewport">
            <div className="workspace-tab-list" role="tablist" aria-label="Session workspace tabs">
              {openSessions.map((sessionName) => {
                const session = sessionsByName.get(sessionName);
                const title = tabTitle(sessionName, sessionsByName);
                const active = !newSessionActive && sessionName === activeSession;
                return (
                  <div className={active ? "workspace-tab active" : "workspace-tab"} key={sessionName}>
                    <button
                      ref={active ? activeTabRef : undefined}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={active ? "muxdeck-active-console" : undefined}
                      aria-label={`${title}${session ? `, ${STATE_LABELS[session.agentState]}` : ", unavailable"}`}
                      tabIndex={active ? 0 : -1}
                      onKeyDown={tabKeyDown}
                      onClick={() => onSelect(sessionName)}
                    >
                      <span className={`workspace-state-dot ${session?.agentState || "unavailable"}`} aria-hidden="true" />
                      <span>{title}</span>
                    </button>
                    <button
                      type="button"
                      className="workspace-tab-close"
                      onClick={() => closeQuickTab(sessionName)}
                      aria-label={`Close ${title} quick tab`}
                      title="Close quick tab"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                );
              })}
              {newSessionActive && (
                <div className="workspace-tab workspace-new-session-tab active">
                  <button
                    ref={activeTabRef}
                    type="button"
                    role="tab"
                    aria-selected="true"
                    aria-controls={NEW_SESSION_PANEL_ID}
                    aria-label="New session, not created yet"
                    tabIndex={0}
                    onKeyDown={tabKeyDown}
                  >
                    <span className="workspace-state-dot new-session" aria-hidden="true" />
                    <span>New session</span>
                  </button>
                  {onCloseNewSession && (
                    <button
                      type="button"
                      className="workspace-tab-close"
                      onClick={closeNewSession}
                      aria-label="Close New session tab"
                      title="Close new session"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={recentsOpen ? "workspace-recents-button active" : "workspace-recents-button"}
            onClick={onOpenRecents}
            aria-haspopup="dialog"
            aria-expanded={recentsOpen}
            aria-label={`Open session switcher${closedRecentCount > 0 ? `, ${closedRecentCount} recently visited` : ""}`}
          >
            <HistoryIcon />
            <span>Recents</span>
            {closedRecentCount > 0 && <strong>{closedRecentCount}</strong>}
          </button>
      </nav>

      <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {newSessionActive
          ? "Active view: New session"
          : `Active session: ${activeSession
            ? tabTitle(activeSession, sessionsByName)
            : "None"}`}
      </p>

      {recentsOpen && (
        <WorkspaceRecentsDialog {...props} sessionsByName={sessionsByName} />
      )}
    </>
  );
}
