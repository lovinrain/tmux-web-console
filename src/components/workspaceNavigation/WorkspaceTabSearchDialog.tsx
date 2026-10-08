import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { acquireBodyScrollLock } from "../../bodyScrollLock";
import {
  CloseIcon,
  FolderIcon,
  SearchIcon,
  WindowMoveIcon
} from "../../icons";
import {
  directShortcutLabel,
  useShortcutSettings
} from "../../shortcutSettings";
import type { Session } from "../../types";
import { useFloatingSessionJumper } from "../../useFloatingSessionJumper";
import {
  type WorkspaceSessionParents,
  type WorkspaceTabGroup
} from "../../workspaceState";
import { searchWorkspaceTabs } from "./search";


import "../FloatingSessionJumper.css";
import { EMPTY_SESSION_PARENTS, sessionTreeContext, sessionTreeStyle, STATE_LABELS, workspaceSessionState } from "./presentation";
import { isCompactWorkspaceViewport } from "./viewport";

export interface WorkspaceTabSearchDialogProps {
  workspaceKey?: string;
  floating?: boolean;
  onFloatingChange?: (floating: boolean) => void;
  focusRequest?: number;
  activeSession: string | null;
  openSessions: string[];
  groups?: readonly WorkspaceTabGroup[];
  sessionParents?: WorkspaceSessionParents;
  sessions: Session[];
  onSelect: (sessionName: string) => void;
  onClose: () => void;
}

export function WorkspaceTabSearchDialog({
  workspaceKey = "temporary-workspace",
  floating = false,
  onFloatingChange,
  focusRequest = 0,
  activeSession,
  openSessions,
  groups = [],
  sessionParents = EMPTY_SESSION_PARENTS,
  sessions,
  onSelect,
  onClose,
}: WorkspaceTabSearchDialogProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const findTabShortcut = directShortcutLabel(shortcutBindings["workspace-find-tab"]);
  const previousTabShortcut = directShortcutLabel(
    shortcutBindings["workspace-previous-tab"],
  );
  const nextTabShortcut = directShortcutLabel(shortcutBindings["workspace-next-tab"]);
  const directTabShortcuts = Array.from({ length: 9 }, (_, index) => (
    directShortcutLabel(shortcutBindings[
      `workspace-tab-${index + 1}` as keyof typeof shortcutBindings
    ])
  )).filter((shortcut): shortcut is string => Boolean(shortcut));
  const [query, setQuery] = useState("");
  const [highlightedSession, setHighlightedSession] = useState<string | null>(activeSession);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const floatingWindow = useFloatingSessionJumper(workspaceKey, floating);
  const listId = useId();
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const groupsBySession = useMemo(() => {
    const memberships = new Map<string, WorkspaceTabGroup>();
    for (const group of groups) {
      for (const sessionName of group.tabs) {
        if (!memberships.has(sessionName)) memberships.set(sessionName, group);
      }
    }
    return memberships;
  }, [groups]);
  const normalizedQuery = query.trim().toLowerCase();
  const highlightContextRef = useRef({ activeSession, query: normalizedQuery });
  const results = useMemo(() => searchWorkspaceTabs(
    openSessions, sessionsByName, groupsBySession, normalizedQuery,
  ), [normalizedQuery, openSessions, groupsBySession, sessionsByName]);
  useEffect(() => {
    const contextChanged = highlightContextRef.current.activeSession !== activeSession
      || highlightContextRef.current.query !== normalizedQuery;
    highlightContextRef.current = { activeSession, query: normalizedQuery };
    setHighlightedSession((current) => {
      // Live status, title, and ordering updates must not replace the user's choice.
      if (!contextChanged && results.some((result) => result.sessionName === current)) {
        return current;
      }
      const activeResult = normalizedQuery
        ? undefined
        : results.find((result) => result.sessionName === activeSession);
      return activeResult?.sessionName ?? results[0]?.sessionName ?? null;
    });
  }, [activeSession, normalizedQuery, results]);

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
    const previousFocus = restoreFocusRef.current;
    const panelElement = dialogRef.current;
    const releaseBodyScroll = floating ? () => {} : acquireBodyScrollLock();
    const closeOnCompactLayout = () => {
      if (isCompactWorkspaceViewport()) onClose();
    };
    const handleDialogKeyDown = (event: globalThis.KeyboardEvent) => {
      if (floating && (!(event.target instanceof Node) || !dialogRef.current?.contains(event.target)
        || document.querySelector('[aria-modal="true"]'))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (floating || event.key !== "Tab" || !dialogRef.current) return;
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
      window.removeEventListener("resize", closeOnCompactLayout);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      window.visualViewport?.removeEventListener("resize", closeOnCompactLayout);
      releaseBodyScroll();
      if ((!floating || panelElement?.contains(document.activeElement) || document.activeElement === document.body)
        && !document.querySelector('[aria-modal="true"]')) {
        const target = previousFocus?.isConnected ? previousFocus
          : document.querySelector<HTMLElement>("#muxdeck-active-console .xterm-helper-textarea");
        target?.focus();
      }
    };
  }, [floating, onClose]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [floating, focusRequest]);

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
    if (floating) setQuery("");
    else onClose();
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

  const panel = (
      <aside
        ref={dialogRef}
        className="workspace-tab-search-dialog"
        data-floating={floating ? "true" : undefined}
        style={floating ? {
          left: floatingWindow.geometry.x, top: floatingWindow.geometry.y,
          width: floatingWindow.geometry.width, height: floatingWindow.geometry.height,
        } : undefined}
        role="dialog"
        aria-modal={!floating}
        aria-labelledby="workspace-tab-search-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <header className="workspace-tab-search-header"
          tabIndex={floating ? 0 : undefined}
          aria-label={floating ? "Move session jumper window" : undefined}
          title={floating ? "Drag to move. Arrow keys move the window; Shift moves faster. Enter resets it." : undefined}
          onPointerDown={floating ? floatingWindow.move : undefined}
          onKeyDown={floating ? floatingWindow.moveWithKeyboard : undefined}
        >
          <div>
            <p className="eyebrow">OPEN WORKSPACE TABS</p>
            <h2 id="workspace-tab-search-title">Jump to tab</h2>
          </div>
          <div className="workspace-tab-search-header-actions">
            <kbd>{findTabShortcut || "Button only"}</kbd>
            {onFloatingChange && (
              <button type="button" className="workspace-tab-search-mode-button"
                aria-label={floating ? "Use modal session jumper" : "Float session jumper"}
                title={floating ? "Return to a centered modal picker" : "Keep the session jumper open as a movable window"}
                onClick={() => onFloatingChange(!floating)}
              >
                <WindowMoveIcon /><span>{floating ? "Modal" : "Float"}</span>
              </button>
            )}
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
            placeholder="Type a title, tmux name, or group"
            aria-label="Search open tabs by title or tmux name"
            aria-description="Search by title, tmux session name, or tab group name."
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
            const state = workspaceSessionState(result.session);
            const tree = sessionTreeContext(result.sessionName, sessionParents, sessionsByName);
            return (
              <button
                type="button"
                id={`${listId}-${encodeURIComponent(result.sessionName)}`}
                key={result.sessionName}
                className={highlighted ? "workspace-tab-search-result highlighted" : "workspace-tab-search-result"}
                role="option"
                aria-selected={highlighted}
                aria-description={tree?.description}
                title={tree?.description}
                data-session-parent={tree?.parentName}
                data-session-depth={tree?.depth}
                style={sessionTreeStyle(tree)}
                tabIndex={-1}
                onMouseEnter={() => setHighlightedSession(result.sessionName)}
                onClick={() => chooseSession(result.sessionName)}
              >
                <span className={`workspace-state-dot ${state}`} aria-hidden="true" />
                <span className="workspace-tab-search-result-copy">
                  <strong>{result.title}</strong>
                  <span>{result.title === result.sessionName ? "tmux session" : result.sessionName}</span>
                  {tree && (
                    <span className="workspace-session-parent-label">
                      <span className="workspace-tab-child-marker" aria-hidden="true" />
                      Child of {tree.parentTitle}
                    </span>
                  )}
                  {result.group && (
                    <span
                      className="workspace-tab-search-result-group"
                      data-tab-group-color={result.group.color}
                      aria-label={`Tab group ${result.group.name}, color ${result.group.color}`}
                    >
                      <FolderIcon
                        width="12"
                        height="12"
                        style={{ color: "var(--tab-group-color)" }}
                      />
                      {result.group.name}
                    </span>
                  )}
                </span>
                <span className={`workspace-tab-search-result-state ${state}`}>
                  {active ? "Current" : STATE_LABELS[state]}
                </span>
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="workspace-tab-search-empty">
              <SearchIcon />
              <strong>No matching open tabs</strong>
              <span>Search by custom title, tmux session name, or tab group name.</span>
            </div>
          )}
        </div>

        <footer className="workspace-tab-search-footer">
          <span>
            {previousTabShortcut && <kbd>{previousTabShortcut}</kbd>}
            {nextTabShortcut && <kbd>{nextTabShortcut}</kbd>}
            cycle tabs
          </span>
          {directTabShortcuts.length > 0 && (
            <span className="workspace-tab-direct-shortcuts">
              {directTabShortcuts.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)}
              direct
            </span>
          )}
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> jump</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
        {floating && (
          <button type="button" className="workspace-session-jumper-resize"
            aria-label="Resize session jumper window"
            title="Drag to resize. Arrow keys resize the window; Shift resizes faster. Enter resets it."
            onPointerDown={floatingWindow.resize}
            onKeyDown={floatingWindow.resizeWithKeyboard}
          >↘</button>
        )}
      </aside>
  );
  return floating ? panel : (
    <div className="workspace-tab-search-backdrop" role="presentation" onMouseDown={onClose}>
      {panel}
    </div>
  );
}
