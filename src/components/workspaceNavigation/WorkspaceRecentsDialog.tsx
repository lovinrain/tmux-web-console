import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { acquireBodyScrollLock } from "../../bodyScrollLock";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  GridIcon,
  HistoryIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon
} from "../../icons";
import { sortSessions } from "../../sessionDashboardModel";
import type { Session } from "../../types";
import {
  MAX_WORKSPACE_TAB_GROUPS,
  type WorkspaceTabGroup
} from "../../workspaceState";


import { activePane, EMPTY_SESSION_PARENTS, sessionTreeContext, tabTitle, WORKSPACE_PERSISTENCE_COPY, workspaceIdentityName, workspaceIdentityStateLabel } from "./presentation";
import { tabMoveResultIndex, tabMoveTargetIndex } from "./tabMovement";
import type { SessionWorkspaceNavigationProps } from "./types";
import { moveToNewWindowDisabledReason, newWindowFailureMessage, WorkspaceWindowActionError } from "./windowActions";
import { WorkspaceSessionRow } from "./WorkspaceSessionRow";
import { isCompactWorkspaceViewport } from "./viewport";

export interface WorkspaceRecentsDialogProps extends SessionWorkspaceNavigationProps {
  sessionsByName: Map<string, Session>;
  query: string;
  initialScrollTop: number;
  onQueryChange: (query: string) => void;
  onScrollPositionChange: (scrollTop: number) => void;
  onRequestSaveWorkspace: () => void;
  onRequestRenameWorkspace?: () => void;
  onRequestTerminateSession: (session: Session) => void;
  onRequestNewTabGroup: (initialSession?: string | null) => void;
  onRequestEditTabGroup: (groupId: string) => void;
}

export function WorkspaceRecentsDialog({
  activeSession,
  openSessions,
  recentSessions,
  groups = [],
  sessionParents = EMPTY_SESSION_PARENTS,
  sessions,
  sessionsByName,
  query,
  initialScrollTop,
  onQueryChange,
  onScrollPositionChange,
  onSelect,
  onCloseTab,
  onMoveTab,
  onOpenTabInNewWindow,
  onSaveTabGroup,
  onDeleteTabGroup,
  onMoveTabGroup,
  onCloseRecents,
  onClearRecents,
  onOpenDashboard,
  workspacePersistenceState = "unsaved",
  workspaceName,
  onSaveWorkspace,
  onRequestSaveWorkspace,
  onRequestRenameWorkspace,
  onRequestTerminateSession,
  onRequestNewTabGroup,
  onRequestEditTabGroup,
  onSessionTerminated,
}: WorkspaceRecentsDialogProps) {
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [windowActionError, setWindowActionError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "up" | "down";
  } | null>(null);
  const openSet = useMemo(() => new Set(openSessions), [openSessions]);
  const recentSet = useMemo(() => new Set(recentSessions), [recentSessions]);
  const groupsBySession = useMemo(() => {
    const result = new Map<string, WorkspaceTabGroup>();
    groups.forEach((group) => group.tabs.forEach((sessionName) => {
      result.set(sessionName, group);
    }));
    return result;
  }, [groups]);
  const normalizedQuery = query.trim().toLowerCase();
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];
  const identityName = workspaceIdentityName(workspacePersistenceState, workspaceName);
  const identityStateLabel = workspaceIdentityStateLabel(workspacePersistenceState);
  const windowMoveDisabledReason = moveToNewWindowDisabledReason(
    workspacePersistenceState,
  );

  const matchesQuery = (sessionName: string): boolean => {
    if (!normalizedQuery) return true;
    const session = sessionsByName.get(sessionName);
    const pane = session ? activePane(session) : undefined;
    return [
      sessionName,
      session?.customTitle,
      pane?.command,
      pane?.path,
      pane?.title,
      groupsBySession.get(sessionName)?.name,
    ]
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
    const resultIndex = tabMoveResultIndex(openSessions, groups, sessionName, targetIndex, sessionParents);
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "up" : "down",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${tabTitle(sessionName, sessionsByName)} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  };

  const openDialogTabInNewWindow = (
    sessionName: string,
    move: boolean,
  ) => {
    if (!onOpenTabInNewWindow) return;
    const title = tabTitle(sessionName, sessionsByName);
    const result = onOpenTabInNewWindow(sessionName, move ? "move" : "copy");
    if (result !== "opened") {
      setReorderAnnouncement("");
      setWindowActionError(newWindowFailureMessage(result, title));
      return;
    }
    setWindowActionError("");
    setReorderAnnouncement(
      move
        ? `${title} moved to a new window. The tmux session keeps running.`
        : `${title} copied to a new window and remains open here.`,
    );
    if (move) closeDialogTab(sessionName);
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

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop;
  }, [initialScrollTop]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const compactTouchLayout = isCompactWorkspaceViewport();
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
          <div className="workspace-recents-heading">
            <p className="eyebrow">THIS BROWSER PAGE / WORKSPACE</p>
            <h2 id="workspace-recents-title">Switch sessions</h2>
            <div
              className={`workspace-recents-identity ${workspacePersistenceState}`}
              role="group"
              aria-label={`Workspace: ${identityName}. ${identityStateLabel}`}
              title={identityName}
            >
              <span className="workspace-recents-identity-name">{identityName}</span>
              <span className="workspace-recents-identity-state" aria-hidden="true">
                {identityStateLabel}
              </span>
            </div>
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
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Find an open, recent, or live session"
            aria-label="Find a workspace session"
          />
          {query && (
            <button type="button" onClick={() => onQueryChange("")} aria-label="Clear workspace search">
              Clear
            </button>
          )}
        </label>

        <WorkspaceWindowActionError
          message={windowActionError}
          onDismiss={() => setWindowActionError("")}
        />

        <p className="workspace-sr-only" role="status" aria-live="polite">
          {resultCount} {resultCount === 1 ? "session" : "sessions"} found
        </p>
        {reorderAnnouncement && (
          <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement}
          </p>
        )}

        <div
          ref={scrollRef}
          className="workspace-recents-scroll"
          onScroll={(event) => onScrollPositionChange(event.currentTarget.scrollTop)}
        >
          {filteredOpen.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-open-heading">
              <header>
                <div>
                  <p className="eyebrow">QUICK SWITCH</p>
                  <h3 id="workspace-open-heading">Open tabs</h3>
                </div>
                <span>{filteredOpen.length}</span>
              </header>
              {onSaveTabGroup && (
                (onDeleteTabGroup && groups.length > 0)
                || (openSessions.length > 0 && groups.length < MAX_WORKSPACE_TAB_GROUPS)
              ) && (
                <div className="workspace-recents-tab-groups" aria-label="Workspace tab groups">
                  {onDeleteTabGroup && groups.map((group) => {
                    const groupStart = openSessions.indexOf(group.tabs[0]);
                    const groupEnd = openSessions.indexOf(group.tabs.at(-1)!);
                    return (
                    <div
                      className="workspace-recents-tab-group"
                      data-tab-group-color={group.color}
                      key={group.id}
                    >
                      <button
                        type="button"
                        className="workspace-recents-tab-group-edit"
                        onClick={() => onRequestEditTabGroup(group.id)}
                        aria-label={`Edit ${group.name} tab group`}
                      >
                        <span aria-hidden="true" />
                        <strong>{group.name}</strong>
                        <small>{group.tabs.length}</small>
                        <EditIcon />
                      </button>
                      {onMoveTabGroup && (
                        <span role="group" aria-label={`Move ${group.name} tab group`}>
                          <button
                            type="button"
                            onClick={() => {
                              onMoveTabGroup(group.id, -1);
                              setReorderAnnouncement(`${group.name} group moved up.`);
                            }}
                            disabled={groupStart === 0}
                            aria-label={`Move ${group.name} group up`}
                          >
                            <ArrowUpIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onMoveTabGroup(group.id, 1);
                              setReorderAnnouncement(`${group.name} group moved down.`);
                            }}
                            disabled={groupEnd === openSessions.length - 1}
                            aria-label={`Move ${group.name} group down`}
                          >
                            <ArrowDownIcon />
                          </button>
                        </span>
                      )}
                    </div>
                    );
                  })}
                  {openSessions.length > 0
                    && groups.length < MAX_WORKSPACE_TAB_GROUPS && (
                    <button
                      type="button"
                      className="workspace-recents-new-group"
                      onClick={() => onRequestNewTabGroup(activeSession)}
                    >
                      <PlusIcon /> New group
                    </button>
                  )}
                </div>
              )}
              <div className="workspace-session-list">
                {filteredOpen.map((sessionName) => {
                  const openIndex = openSessions.indexOf(sessionName);
                  const session = sessionsByName.get(sessionName);
                  const group = groupsBySession.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      group={group}
                      tree={sessionTreeContext(sessionName, sessionParents, sessionsByName)}
                      active={sessionName === activeSession}
                      open
                      openIndex={openIndex}
                      openCount={openSessions.length}
                      previousMoveIndex={tabMoveTargetIndex(openSessions, group, sessionParents, sessionName, -1)}
                      nextMoveIndex={tabMoveTargetIndex(openSessions, group, sessionParents, sessionName, 1)}
                      onSelect={() => onSelect(sessionName)}
                      onMoveTab={onMoveTab
                        ? (targetIndex) => moveDialogTab(sessionName, targetIndex)
                        : undefined}
                      onMoveToNewWindow={onOpenTabInNewWindow
                        ? () => openDialogTabInNewWindow(sessionName, true)
                        : undefined}
                      onCopyToNewWindow={onOpenTabInNewWindow
                        ? () => openDialogTabInNewWindow(sessionName, false)
                        : undefined}
                      moveToNewWindowDisabledReason={windowMoveDisabledReason}
                      onClose={() => closeDialogTab(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
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
                {filteredRecent.map((sessionName) => {
                  const session = sessionsByName.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      active={false}
                      open={false}
                      onSelect={() => onSelect(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
                    />
                  );
                })}
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
                {filteredAvailable.map((sessionName) => {
                  const session = sessionsByName.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      active={false}
                      open={false}
                      onSelect={() => onSelect(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
                    />
                  );
                })}
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
            {onRequestRenameWorkspace && (
              <button
                type="button"
                className="secondary-button workspace-recents-rename-button"
                onClick={onRequestRenameWorkspace}
                aria-haspopup="dialog"
                aria-controls="workspace-rename-dialog"
              >
                <EditIcon /> Rename
              </button>
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
