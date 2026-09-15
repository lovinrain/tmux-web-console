import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { fuzzyFieldsScore } from "../fuzzySearch";
import {
  ChevronRightIcon,
  CloseIcon,
  EyeOffIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TerminalIcon,
} from "../icons";
import { paneCommandKind, sessionDisplayTitle } from "../sessionDashboardModel";
import type { RecoverableSession } from "../api";
import type { AgentState, Pane, Session } from "../types";

interface WorkspaceSessionAddDialogProps {
  sessions: Session[];
  openSessions: string[];
  recoverableSessions?: RecoverableSession[];
  workspaceName?: string | null;
  workspaceFull?: boolean;
  onAdd: (sessionName: string, open: boolean) => void;
  onRecreate?: (sessionName: string) => void | Promise<void>;
  onClose: () => void;
}

export interface RankedAddableSession {
  session: Session;
  score: number;
  sourceIndex: number;
}

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Background work",
  unknown: "Unclear",
  other: "Other",
};

const STATE_PRIORITY: Record<AgentState, number> = {
  waiting_human: 0,
  working: 1,
  waiting_command: 2,
  other: 3,
  unknown: 4,
};

function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId)
    ?? session.panes[0];
}

function recoveryAgentLabel(agentType: RecoverableSession["agentType"]): string {
  switch (agentType) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "cursor": return "Cursor";
    case "grok": return "Grok";
    default: return "Shell";
  }
}

function agentLabel(session: Session, pane: Pane | undefined): string {
  const kind = session.agentType ?? paneCommandKind(
    pane?.command ?? "",
    pane?.title ?? "",
  );
  switch (kind) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "cursor": return "Cursor";
    case "grok": return "Grok";
    case "shells": return "Shell";
    default: return pane?.command || "Session";
  }
}

function scoreLiveSession(session: Session, normalizedQuery: string): number | null {
  const pane = activePane(session);
  return fuzzyFieldsScore(normalizedQuery, [
    sessionDisplayTitle(session),
    session.name,
    pane?.path ?? "",
    agentLabel(session, pane),
    session.agentType ?? "",
    pane?.command ?? "",
    pane?.title ?? "",
    STATE_LABELS[session.agentState],
    session.agentStateReason,
    ...session.tags,
  ]);
}

function compareLiveSessions(left: Session, right: Session): number {
  if (left.ignored !== right.ignored) {
    return Number(left.ignored) - Number(right.ignored);
  }
  if (left.starred !== right.starred) {
    return Number(right.starred) - Number(left.starred);
  }
  const stateDifference = STATE_PRIORITY[left.agentState] - STATE_PRIORITY[right.agentState];
  if (stateDifference !== 0) return stateDifference;
  if (right.activity !== left.activity) return right.activity - left.activity;
  return 0;
}

export function rankAddableSessions(
  sessions: readonly Session[],
  openSessions: readonly string[],
  query: string,
): RankedAddableSession[] {
  const open = new Set(openSessions);
  const normalizedQuery = query.trim();
  return sessions
    .flatMap((session, sourceIndex) => {
      if (open.has(session.name)) return [];
      const score = scoreLiveSession(session, normalizedQuery);
      return score === null ? [] : [{ session, score, sourceIndex }];
    })
    .sort((left, right) => {
      if (normalizedQuery && right.score !== left.score) return right.score - left.score;
      const liveOrder = compareLiveSessions(left.session, right.session);
      if (liveOrder !== 0) return liveOrder;
      return left.sourceIndex - right.sourceIndex;
    });
}

export type AddableEntry =
  | { kind: "live"; name: string; session: Session }
  | { kind: "missing"; name: string; recovery: RecoverableSession };

export interface RankedAddableEntry {
  entry: AddableEntry;
  score: number;
  sourceIndex: number;
}

/**
 * One query over live and missing shells. A restart can leave every match in
 * the registry rather than in tmux, so searching live-only looked broken.
 * Live shells stay grouped ahead of missing ones.
 */
export function rankAddableEntries(
  sessions: readonly Session[],
  recoverableSessions: readonly RecoverableSession[],
  openSessions: readonly string[],
  query: string,
): RankedAddableEntry[] {
  const open = new Set(openSessions);
  const live = new Set(sessions.map((session) => session.name));
  const normalizedQuery = query.trim();

  const liveEntries = sessions.flatMap<RankedAddableEntry>((session, sourceIndex) => {
    if (open.has(session.name)) return [];
    const score = scoreLiveSession(session, normalizedQuery);
    return score === null ? [] : [{
      entry: { kind: "live", name: session.name, session },
      score,
      sourceIndex,
    }];
  });

  const missingEntries = recoverableSessions.flatMap<RankedAddableEntry>(
    (recovery, sourceIndex) => {
      if (open.has(recovery.name) || live.has(recovery.name)) return [];
      const score = fuzzyFieldsScore(normalizedQuery, [
        recovery.name,
        recovery.directory,
        recovery.agentType ?? "",
        recovery.agentSessionId ?? "",
        "missing",
      ]);
      return score === null ? [] : [{
        entry: { kind: "missing", name: recovery.name, recovery },
        score,
        sourceIndex,
      }];
    },
  );

  const byRelevance = (left: RankedAddableEntry, right: RankedAddableEntry): number => {
    if (normalizedQuery && right.score !== left.score) return right.score - left.score;
    if (left.entry.kind === "live" && right.entry.kind === "live") {
      const liveOrder = compareLiveSessions(left.entry.session, right.entry.session);
      if (liveOrder !== 0) return liveOrder;
    }
    if (left.entry.kind === "missing" && right.entry.kind === "missing") {
      const seen = right.entry.recovery.lastSeenAt - left.entry.recovery.lastSeenAt;
      if (seen !== 0) return seen;
    }
    return left.sourceIndex - right.sourceIndex;
  };

  return [...liveEntries.sort(byRelevance), ...missingEntries.sort(byRelevance)];
}

export function WorkspaceSessionAddDialog({
  sessions,
  openSessions,
  recoverableSessions = [],
  workspaceName,
  workspaceFull = false,
  onAdd,
  onRecreate,
  onClose,
}: WorkspaceSessionAddDialogProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [query, setQuery] = useState("");
  const [highlightedSession, setHighlightedSession] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const results = useMemo(
    () => rankAddableEntries(sessions, recoverableSessions, openSessions, query),
    [openSessions, query, recoverableSessions, sessions],
  );
  const resultNames = results.map(({ entry }) => entry.name).join("\u0000");

  useEffect(() => {
    setHighlightedSession((current) => (
      current && results.some(({ entry }) => entry.name === current)
        ? current
        : results[0]?.entry.name ?? null
    ));
  }, [resultNames, results]);

  useEffect(() => {
    if (!highlightedSession) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(
        `workspace-session-add-${encodeURIComponent(highlightedSession)}`,
      )?.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedSession]);

  useEffect(() => {
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], "
          + "[tabindex]:not([tabindex='-1'])",
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
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [onClose]);

  const moveHighlight = (offset: number) => {
    if (results.length === 0) return;
    const currentIndex = results.findIndex(({ entry }) => (
      entry.name === highlightedSession
    ));
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + offset + results.length) % results.length;
    setHighlightedSession(results[nextIndex].entry.name);
  };

  const entryTitle = (entry: AddableEntry) => (
    entry.kind === "live" ? sessionDisplayTitle(entry.session) : entry.name
  );

  const addEntry = (entry: AddableEntry, open: boolean) => {
    if (workspaceFull) return;
    if (open) onClose();
    onAdd(entry.name, open);
    if (!open) setStatus(`Added ${entryTitle(entry)} to the workspace.`);
  };

  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
      const highlighted = results.find(({ entry }) => (
        entry.name === highlightedSession
      ));
      if (highlighted) addEntry(highlighted.entry, event.shiftKey);
    }
  };

  const destinationName = workspaceName?.trim() || "this workspace";
  const dialog = (
    <div
      className="workspace-session-add-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        ref={dialogRef}
        className="workspace-session-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <header className="workspace-session-add-header">
          <div>
            <p className="eyebrow">QUICK ADD</p>
            <h2 id={headingId}>Add running sessions</h2>
            <span>{results.length} available for {destinationName}</span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close session picker">
            <CloseIcon />
          </button>
        </header>

        <label className="workspace-session-add-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            role="combobox"
            aria-label="Find a session to add"
            aria-autocomplete="list"
            aria-expanded="true"
            value={query}
            placeholder="Name, title, CWD, agent, state, tag - live and missing"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={searchKeyDown}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear session search">
              Clear
            </button>
          )}
        </label>

        <p className={status ? "workspace-session-add-status" : "workspace-sr-only"} role="status" aria-live="polite">
          {status || `${results.length} session${results.length === 1 ? "" : "s"} available`}
        </p>

        {workspaceFull && (
          <p className="workspace-session-add-limit" role="alert">
            This workspace is full. Remove a tab before adding another session.
          </p>
        )}

        <div className="workspace-session-add-results" role="list" aria-label="Sessions available to add">
          {results.map(({ entry }) => {
            const highlighted = entry.name === highlightedSession;
            const className = highlighted
              ? "workspace-session-add-result highlighted"
              : "workspace-session-add-result";
            const id = `workspace-session-add-${encodeURIComponent(entry.name)}`;

            if (entry.kind === "missing") {
              const { recovery } = entry;
              return (
                <article
                  id={id}
                  key={entry.name}
                  className={className}
                  role="listitem"
                  data-session-missing="true"
                  onMouseEnter={() => setHighlightedSession(entry.name)}
                >
                  <span className="workspace-state-dot unavailable" aria-hidden="true" />
                  <div className="workspace-session-add-copy">
                    <strong>{entry.name}</strong>
                    <span>{recoveryAgentLabel(recovery.agentType)}</span>
                    <small title={recovery.directory}>{recovery.directory}</small>
                  </div>
                  <div className="workspace-session-add-badges">
                    <span data-agent-state="unavailable">Missing</span>
                  </div>
                  <div className="workspace-session-add-actions">
                    <button
                      type="button"
                      disabled={workspaceFull}
                      aria-label={`Add ${entry.name} to workspace`}
                      title="Add the tab back; its shell is still missing"
                      onClick={() => addEntry(entry, false)}
                    >
                      <PlusIcon /><span>Add</span>
                    </button>
                    {onRecreate && (
                      <button
                        type="button"
                        disabled={!recovery.directoryAvailable}
                        aria-label={`Recreate ${entry.name}`}
                        title={recovery.directoryAvailable
                          ? "Start a fresh shell at its saved directory"
                          : "The saved directory is unavailable"}
                        onClick={() => void onRecreate(entry.name)}
                      >
                        <TerminalIcon /><span>Recreate</span>
                      </button>
                    )}
                  </div>
                </article>
              );
            }

            const { session } = entry;
            const pane = activePane(session);
            const title = sessionDisplayTitle(session);
            return (
              <article
                id={id}
                key={entry.name}
                className={className}
                role="listitem"
                onMouseEnter={() => setHighlightedSession(entry.name)}
              >
                <span className={`workspace-state-dot ${session.agentState}`} aria-hidden="true" />
                <div className="workspace-session-add-copy">
                  <strong>{title}</strong>
                  <span>{title === session.name ? agentLabel(session, pane) : session.name}</span>
                  <small title={pane?.path}>{pane?.path || "Working directory unavailable"}</small>
                </div>
                <div className="workspace-session-add-badges">
                  {session.starred && <span title="Starred"><StarIcon filled /> Starred</span>}
                  {session.ignored && <span title="Ignored"><EyeOffIcon /> Ignored</span>}
                  <span data-agent-state={session.agentState}>{STATE_LABELS[session.agentState]}</span>
                </div>
                <div className="workspace-session-add-actions">
                  <button
                    type="button"
                    disabled={workspaceFull}
                    aria-label={`Add ${session.name} to workspace`}
                    onClick={() => addEntry(entry, false)}
                  >
                    <PlusIcon /><span>Add</span>
                  </button>
                  <button
                    type="button"
                    disabled={workspaceFull}
                    aria-label={`Add ${session.name} and open`}
                    title="Add this session and switch to it"
                    onClick={() => addEntry(entry, true)}
                  >
                    <span>Open</span><ChevronRightIcon />
                  </button>
                </div>
              </article>
            );
          })}
          {results.length === 0 && (
            <div className="workspace-session-add-empty">
              <SearchIcon />
              <strong>{query.trim() ? "No fuzzy matches" : "Every live session is already here"}</strong>
              <span>
                {query.trim()
                  ? "Try part of a title, tmux name, directory, agent, state, or tag."
                  : "This workspace already contains every running tmux session."}
              </span>
            </div>
          )}
        </div>

        <footer className="workspace-session-add-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> add</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> add &amp; open</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </aside>
    </div>
  );

  return createPortal(dialog, document.body);
}
