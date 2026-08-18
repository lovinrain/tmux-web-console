import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  GridIcon,
  HistoryIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
} from "../icons";
import { paneCommandKind, sessionDisplayTitle, sortSessions } from "../sessionDashboardModel";
import type { AgentState, Pane, Session } from "../types";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import { WorkspaceSaveDialog } from "./WorkspaceSaveDialog";

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
  onMoveTab?: (sessionName: string, targetIndex: number) => void;
  onCloseNewSession?: () => void;
  onOpenRecents: () => void;
  onCloseRecents: () => void;
  onClearRecents: () => void;
  onOpenDashboard: () => void;
  onOpenTabSearch?: () => void;
  workspacePersistenceState?: WorkspacePersistenceState;
  onSaveWorkspace?: (name: string) => Promise<void>;
}

export type WorkspacePersistenceState = "unsaved" | "loading" | "saved" | "error";

export const WORKSPACE_TAB_SHORTCUTS = {
  previous: "Ctrl+Shift+,",
  next: "Ctrl+Shift+.",
  search: "Ctrl+Shift+;",
  direct: "Ctrl+Shift+1-9",
} as const;

export const MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID = "muxdeck-mobile-workspace-overview";

export function isCompactWorkspaceViewport(): boolean {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return viewportWidth <= 640
    || (viewportWidth <= 1024 && (coarsePointer || viewportHeight <= 500));
}

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Background work",
  unknown: "Unclear",
  other: "Other",
};

const WORKSPACE_PERSISTENCE_COPY: Record<
  Exclude<WorkspacePersistenceState, "unsaved">,
  { label: string; accessibleLabel: string; description: string }
> = {
  saved: {
    label: "Saved",
    accessibleLabel: "Workspace saved automatically",
    description: "Tab order and your active session save automatically.",
  },
  loading: {
    label: "Opening",
    accessibleLabel: "Opening saved workspace",
    description: "Opening this saved workspace from the server.",
  },
  error: {
    label: "Sync issue",
    accessibleLabel: "Workspace sync issue",
    description: "This saved workspace has a sync issue.",
  },
};

function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

function paneLabel(pane?: Pane): string {
  switch (paneCommandKind(pane?.command || "", pane?.title || "")) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "cursor": return "Cursor";
    case "grok": return "Grok";
    case "shells": return "Shell";
    default: return pane?.command || "Process";
  }
}

function tabTitle(sessionName: string, sessionsByName: Map<string, Session>): string {
  const session = sessionsByName.get(sessionName);
  return session ? sessionDisplayTitle(session) : sessionName;
}

interface WorkspaceTabSearchDialogProps {
  activeSession: string | null;
  openSessions: string[];
  sessions: Session[];
  onSelect: (sessionName: string) => void;
  onClose: () => void;
}

interface TabSearchResult {
  sessionName: string;
  title: string;
  session: Session | undefined;
  position: number;
  score: number;
}

function searchScore(title: string, sessionName: string, query: string): number | null {
  if (!query) return 0;
  const normalizedTitle = title.toLowerCase();
  const normalizedName = sessionName.toLowerCase();
  if (normalizedTitle === query) return 0;
  if (normalizedName === query) return 1;
  if (normalizedTitle.startsWith(query)) return 2;
  if (normalizedName.startsWith(query)) return 3;
  if (normalizedTitle.includes(query)) return 4;
  if (normalizedName.includes(query)) return 5;
  return null;
}

export function WorkspaceTabSearchDialog({
  activeSession,
  openSessions,
  sessions,
  onSelect,
  onClose,
}: WorkspaceTabSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [highlightedSession, setHighlightedSession] = useState<string | null>(activeSession);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo<TabSearchResult[]>(() => openSessions
    .map((sessionName, position) => {
      const session = sessionsByName.get(sessionName);
      const title = tabTitle(sessionName, sessionsByName);
      const score = searchScore(title, sessionName, normalizedQuery);
      return score === null ? null : { sessionName, title, session, position, score };
    })
    .filter((result): result is TabSearchResult => result !== null)
    .sort((left, right) => left.score - right.score || left.position - right.position), [
    normalizedQuery,
    openSessions,
    sessionsByName,
  ]);
  const resultNames = results.map((result) => result.sessionName).join("\u0000");

  useEffect(() => {
    const activeResult = normalizedQuery
      ? undefined
      : results.find((result) => result.sessionName === activeSession);
    setHighlightedSession(activeResult?.sessionName ?? results[0]?.sessionName ?? null);
  }, [activeSession, normalizedQuery, resultNames, results]);

  useEffect(() => {
    if (!highlightedSession) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(
        `${listId}-${encodeURIComponent(highlightedSession)}`,
      )?.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedSession, listId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const closeOnCompactLayout = () => {
      if (isCompactWorkspaceViewport()) onClose();
    };
    const handleDialogKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden") && element.tabIndex >= 0);
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

    window.addEventListener("resize", closeOnCompactLayout);
    window.addEventListener("keydown", handleDialogKeyDown, true);
    window.visualViewport?.addEventListener("resize", closeOnCompactLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", closeOnCompactLayout);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      window.visualViewport?.removeEventListener("resize", closeOnCompactLayout);
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  const moveHighlight = (offset: number) => {
    if (results.length === 0) return;
    const currentIndex = results.findIndex((result) => (
      result.sessionName === highlightedSession
    ));
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + offset + results.length) % results.length;
    setHighlightedSession(results[nextIndex].sessionName);
  };

  const chooseSession = (sessionName: string) => {
    onClose();
    onSelect(sessionName);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Enter" && highlightedSession) {
      event.preventDefault();
      chooseSession(highlightedSession);
    }
  };

  return (
    <div className="workspace-tab-search-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        ref={dialogRef}
        className="workspace-tab-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-tab-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-tab-search-header">
          <div>
            <p className="eyebrow">OPEN WORKSPACE TABS</p>
            <h2 id="workspace-tab-search-title">Jump to tab</h2>
          </div>
          <div className="workspace-tab-search-header-actions">
            <kbd>{WORKSPACE_TAB_SHORTCUTS.search}</kbd>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close tab search">
              <CloseIcon />
            </button>
          </div>
        </header>

        <label className="workspace-tab-search-field">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Type a title or tmux name"
            aria-label="Search open tabs by title or tmux name"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={highlightedSession
              ? `${listId}-${encodeURIComponent(highlightedSession)}`
              : undefined}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear tab search">
              Clear
            </button>
          )}
        </label>

        <p className="workspace-sr-only" role="status" aria-live="polite">
          {results.length} {results.length === 1 ? "tab" : "tabs"} found
        </p>

        <div className="workspace-tab-search-results" id={listId} role="listbox" aria-label="Open tabs">
          {results.map((result) => {
            const highlighted = result.sessionName === highlightedSession;
            const active = result.sessionName === activeSession;
            const state = result.session?.agentState || "unavailable";
            return (
              <button
                type="button"
                id={`${listId}-${encodeURIComponent(result.sessionName)}`}
                key={result.sessionName}
                className={highlighted ? "workspace-tab-search-result highlighted" : "workspace-tab-search-result"}
                role="option"
                aria-selected={highlighted}
                tabIndex={-1}
                onMouseEnter={() => setHighlightedSession(result.sessionName)}
                onClick={() => chooseSession(result.sessionName)}
              >
                <span className={`workspace-state-dot ${state}`} aria-hidden="true" />
                <span className="workspace-tab-search-result-copy">
                  <strong>{result.title}</strong>
                  <span>{result.title === result.sessionName ? "tmux session" : result.sessionName}</span>
                </span>
                <span className={`workspace-tab-search-result-state ${state}`}>
                  {active ? "Current" : result.session ? STATE_LABELS[result.session.agentState] : "Unavailable"}
                </span>
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="workspace-tab-search-empty">
              <SearchIcon />
              <strong>No matching open tabs</strong>
              <span>Search by custom title or tmux session name.</span>
            </div>
          )}
        </div>

        <footer className="workspace-tab-search-footer">
          <span>
            <kbd>{WORKSPACE_TAB_SHORTCUTS.previous}</kbd>
            <kbd>{WORKSPACE_TAB_SHORTCUTS.next}</kbd>
            cycle tabs
          </span>
          <span><kbd>{WORKSPACE_TAB_SHORTCUTS.direct}</kbd> direct</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> jump</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </aside>
    </div>
  );
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
  openIndex?: number;
  openCount?: number;
  onMoveTab?: (targetIndex: number) => void;
  onClose?: () => void;
}

function WorkspaceSessionRow({
  sessionName,
  session,
  active,
  open,
  onSelect,
  openIndex,
  openCount,
  onMoveTab,
  onClose,
}: WorkspaceSessionRowProps) {
  const pane = session ? activePane(session) : undefined;
  const displayTitle = session ? sessionDisplayTitle(session) : sessionName;
  const stateLabel = session ? STATE_LABELS[session.agentState] : "Unavailable";
  const canReorder = (
    open
    && onMoveTab
    && openIndex !== undefined
    && openCount !== undefined
    && openCount > 1
  );

  return (
    <div
      className={active ? "workspace-session-row active" : "workspace-session-row"}
      data-workspace-session-name={sessionName}
    >
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
        <span className="workspace-session-indicators">
          <span className={`workspace-session-status ${session?.agentState || "unavailable"}`}>
            {active ? `Active \u00b7 ${stateLabel}` : stateLabel}
          </span>
          {session && session.queuedMessageCount > 0 && (
            <span
              className="workspace-session-memo-queue"
              aria-label={`${session.queuedMessageCount} queued memo ${session.queuedMessageCount === 1 ? "item" : "items"}`}
            >
              Q {session.queuedMessageCount}
            </span>
          )}
        </span>
      </button>
      {open && (canReorder || onClose) && (
        <span className="workspace-session-actions">
          {canReorder && (
            <span
              className="workspace-session-reorder"
              role="group"
              aria-label={`Reorder ${displayTitle} tab`}
            >
              <button
                type="button"
                className="workspace-session-move workspace-session-move-up"
                onClick={() => onMoveTab(openIndex - 1)}
                disabled={openIndex === 0}
                aria-label={`Move ${displayTitle} tab up`}
                title="Move tab up"
              >
                <ArrowLeftIcon />
              </button>
              <button
                type="button"
                className="workspace-session-move workspace-session-move-down"
                onClick={() => onMoveTab(openIndex + 1)}
                disabled={openIndex === openCount - 1}
                aria-label={`Move ${displayTitle} tab down`}
                title="Move tab down"
              >
                <ArrowLeftIcon />
              </button>
            </span>
          )}
          {onClose && (
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
        </span>
      )}
    </div>
  );
}

interface WorkspaceRecentsDialogProps extends SessionWorkspaceNavigationProps {
  sessionsByName: Map<string, Session>;
  onRequestSaveWorkspace: () => void;
}

function WorkspaceRecentsDialog({
  activeSession,
  openSessions,
  recentSessions,
  sessions,
  sessionsByName,
  onSelect,
  onCloseTab,
  onMoveTab,
  onCloseRecents,
  onClearRecents,
  onOpenDashboard,
  workspacePersistenceState = "unsaved",
  onSaveWorkspace,
  onRequestSaveWorkspace,
}: WorkspaceRecentsDialogProps) {
  const [query, setQuery] = useState("");
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "up" | "down";
  } | null>(null);
  const openSet = useMemo(() => new Set(openSessions), [openSessions]);
  const recentSet = useMemo(() => new Set(recentSessions), [recentSessions]);
  const normalizedQuery = query.trim().toLowerCase();
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];

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

  const moveDialogTab = (sessionName: string, targetIndex: number) => {
    if (!onMoveTab || targetIndex < 0 || targetIndex >= openSessions.length) return;
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "up" : "down",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${tabTitle(sessionName, sessionsByName)} moved to position ${targetIndex + 1} of ${openSessions.length}.`,
    );
  };

  useEffect(() => {
    const intent = reorderFocusIntent.current;
    if (!intent) return;
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(".workspace-session-row") ?? [],
      ).find((item) => item.dataset.workspaceSessionName === intent.sessionName);
      const controls = Array.from(
        row?.querySelectorAll<HTMLButtonElement>(".workspace-session-move") ?? [],
      );
      const preferred = controls[intent.direction === "up" ? 0 : 1];
      const target = preferred && !preferred.disabled
        ? preferred
        : controls.find((control) => !control.disabled)
          ?? row?.querySelector<HTMLButtonElement>(".workspace-session-select");
      target?.focus();
      reorderFocusIntent.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openSessions, reorderAnnouncement]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const compactTouchLayout = viewportWidth <= 640
      || (viewportWidth <= 1024 && (coarsePointer || viewportHeight <= 500));
    const frame = window.requestAnimationFrame(() => {
      if (compactTouchLayout) dialogRef.current?.focus();
      else searchRef.current?.focus();
    });

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
        {reorderAnnouncement && (
          <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement}
          </p>
        )}

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
                {filteredOpen.map((sessionName) => {
                  const openIndex = openSessions.indexOf(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={sessionsByName.get(sessionName)}
                      active={sessionName === activeSession}
                      open
                      openIndex={openIndex}
                      openCount={openSessions.length}
                      onSelect={() => onSelect(sessionName)}
                      onMoveTab={onMoveTab
                        ? (targetIndex) => moveDialogTab(sessionName, targetIndex)
                        : undefined}
                      onClose={() => closeDialogTab(sessionName)}
                    />
                  );
                })}
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
          <p>
            {persistenceCopy?.description
              ?? "Save these open tabs to resume them here or on another device."}
          </p>
          <div className="workspace-recents-footer-actions">
            {workspacePersistenceState === "unsaved" ? onSaveWorkspace && (
              <button
                type="button"
                className="secondary-button workspace-recents-save-button"
                onClick={onRequestSaveWorkspace}
                aria-haspopup="dialog"
                aria-controls="workspace-save-dialog"
              >
                <SaveIcon /> Save
              </button>
            ) : persistenceCopy && (
              <span
                className={`workspace-recents-saved-status ${workspacePersistenceState}`}
                role="status"
                tabIndex={-1}
                aria-label={persistenceCopy.accessibleLabel}
                title={persistenceCopy.accessibleLabel}
              >
                {workspacePersistenceState === "saved"
                  ? <CheckIcon />
                  : workspacePersistenceState === "loading"
                    ? <HistoryIcon />
                    : <SaveIcon />}
                {persistenceCopy.label}
              </span>
            )}
            <button type="button" className="secondary-button" onClick={onOpenDashboard}>
              <GridIcon /> Browse all
            </button>
          </div>
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
    onMoveTab,
    onCloseNewSession,
    onOpenRecents,
    onCloseRecents,
    onOpenDashboard,
    onOpenTabSearch,
    workspacePersistenceState = "unsaved",
    onSaveWorkspace,
  } = props;
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const persistenceStatusRef = useRef<HTMLSpanElement>(null);
  const focusActiveTabAfterClose = useRef(false);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "left" | "right";
  } | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAfterRecents, setSaveAfterRecents] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const closedRecentCount = recentSessions.filter((name) => !openSessions.includes(name)).length;
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];

  const focusSaveReplacement = useCallback(() => {
    if (isCompactWorkspaceViewport()) {
      const overviewControl = document.getElementById(MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID);
      if (overviewControl instanceof HTMLElement) {
        overviewControl.focus();
        return;
      }
    }
    const target = persistenceStatusRef.current || saveButtonRef.current;
    target?.focus();
  }, []);

  useEffect(() => {
    if (workspacePersistenceState === "unsaved") return;
    setSaveDialogOpen(false);
    setSaveAfterRecents(false);
  }, [workspacePersistenceState]);

  useEffect(() => {
    if (
      recentsOpen
      || !saveAfterRecents
      || workspacePersistenceState !== "unsaved"
      || !onSaveWorkspace
    ) return;
    setSaveAfterRecents(false);
    setSaveDialogOpen(true);
  }, [onSaveWorkspace, recentsOpen, saveAfterRecents, workspacePersistenceState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTab = activeTabRef.current;
      activeTab?.scrollIntoView?.({ block: "nearest", inline: "center" });
      if (focusActiveTabAfterClose.current && activeTab) {
        focusActiveTabAfterClose.current = false;
        activeTab.focus();
      }
      const intent = reorderFocusIntent.current;
      if (intent) {
        const tab = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>(".workspace-tab") ?? [],
        ).find((item) => item.dataset.workspaceSessionName === intent.sessionName);
        const controls = Array.from(
          tab?.querySelectorAll<HTMLButtonElement>(".workspace-tab-move") ?? [],
        );
        const preferred = controls[intent.direction === "left" ? 0 : 1];
        const target = preferred && !preferred.disabled
          ? preferred
          : controls.find((control) => !control.disabled)
            ?? tab?.querySelector<HTMLButtonElement>("[role='tab']");
        target?.focus();
        reorderFocusIntent.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession, newSessionActive, openSessions, reorderAnnouncement, tabsVisible]);

  const closeQuickTab = (sessionName: string) => {
    focusActiveTabAfterClose.current = true;
    onCloseTab(sessionName);
  };

  const closeNewSession = () => {
    focusActiveTabAfterClose.current = true;
    onCloseNewSession?.();
  };

  const moveQuickTab = (sessionName: string, title: string, targetIndex: number) => {
    if (!onMoveTab || targetIndex < 0 || targetIndex >= openSessions.length) return;
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "left" : "right",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${title} moved to position ${targetIndex + 1} of ${openSessions.length}.`,
    );
  };

  const requestSaveFromRecents = () => {
    if (!onSaveWorkspace || workspacePersistenceState !== "unsaved") return;
    setSaveAfterRecents(true);
    onCloseRecents();
  };

  return (
    <>
      <nav
        ref={navigationRef}
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
              {openSessions.map((sessionName, index) => {
                const session = sessionsByName.get(sessionName);
                const title = tabTitle(sessionName, sessionsByName);
                const active = !newSessionActive && sessionName === activeSession;
                return (
                  <div
                    className={active ? "workspace-tab active" : "workspace-tab"}
                    data-workspace-session-name={sessionName}
                    key={sessionName}
                  >
                    <button
                      ref={active ? activeTabRef : undefined}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls={active ? "muxdeck-active-console" : undefined}
                      aria-label={`${title}${session ? `, ${STATE_LABELS[session.agentState]}` : ", unavailable"}`}
                      aria-keyshortcuts={index < 9 ? `Control+Shift+${index + 1}` : undefined}
                      title={index < 9 ? `${title} (Ctrl+Shift+${index + 1})` : title}
                      tabIndex={active ? 0 : -1}
                      onKeyDown={tabKeyDown}
                      onClick={() => onSelect(sessionName)}
                    >
                      <span className={`workspace-state-dot ${session?.agentState || "unavailable"}`} aria-hidden="true" />
                      <span>{title}</span>
                    </button>
                    {onMoveTab && openSessions.length > 1 && (
                      <span
                        className="workspace-tab-reorder"
                        role="group"
                        aria-label={`Reorder ${title} tab`}
                      >
                        <button
                          type="button"
                          className="workspace-tab-move"
                          onClick={() => moveQuickTab(sessionName, title, index - 1)}
                          disabled={index === 0}
                          aria-label={`Move ${title} tab left`}
                          title="Move tab left"
                        >
                          <ArrowLeftIcon />
                        </button>
                        <button
                          type="button"
                          className="workspace-tab-move workspace-tab-move-right"
                          onClick={() => moveQuickTab(sessionName, title, index + 1)}
                          disabled={index === openSessions.length - 1}
                          aria-label={`Move ${title} tab right`}
                          title="Move tab right"
                        >
                          <ArrowLeftIcon />
                        </button>
                      </span>
                    )}
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
          {workspacePersistenceState === "unsaved" ? onSaveWorkspace && (
            <button
              ref={saveButtonRef}
              type="button"
              className="workspace-save-button"
              onClick={() => setSaveDialogOpen(true)}
              aria-haspopup="dialog"
              aria-controls="workspace-save-dialog"
              aria-expanded={saveDialogOpen}
              aria-label="Save workspace"
              title="Save workspace"
            >
              <SaveIcon />
              <span className="workspace-save-label-full">Save workspace</span>
              <span className="workspace-save-label-compact">Save</span>
            </button>
          ) : persistenceCopy && (
            <span
              ref={persistenceStatusRef}
              className={`workspace-saved-indicator ${workspacePersistenceState}`}
              role="status"
              tabIndex={-1}
              aria-label={persistenceCopy.accessibleLabel}
              title={persistenceCopy.accessibleLabel}
            >
              {workspacePersistenceState === "saved"
                ? <CheckIcon />
                : workspacePersistenceState === "loading"
                  ? <HistoryIcon />
                  : <SaveIcon />}
              <span>{persistenceCopy.label}</span>
            </span>
          )}
          {onOpenTabSearch && openSessions.length > 0 && (
            <button
              type="button"
              className="workspace-tab-search-button"
              onClick={onOpenTabSearch}
              aria-label="Search open tabs"
              aria-keyshortcuts="Control+Shift+;"
              title={`Search open tabs (${WORKSPACE_TAB_SHORTCUTS.search})`}
            >
              <SearchIcon />
              <span>Find tab</span>
              <kbd>{WORKSPACE_TAB_SHORTCUTS.search}</kbd>
            </button>
          )}
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

      {reorderAnnouncement && (
        <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement}
        </p>
      )}

      {recentsOpen && (
        <WorkspaceRecentsDialog
          {...props}
          sessionsByName={sessionsByName}
          onRequestSaveWorkspace={requestSaveFromRecents}
        />
      )}

      {saveDialogOpen && onSaveWorkspace && workspacePersistenceState === "unsaved" && (
        <WorkspaceSaveDialog
          tabs={openSessions}
          activeSession={activeSession}
          onSave={onSaveWorkspace}
          onClose={() => setSaveDialogOpen(false)}
          onFallbackFocus={focusSaveReplacement}
        />
      )}
    </>
  );
}
