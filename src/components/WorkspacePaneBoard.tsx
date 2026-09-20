import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  WorkspacePaneLayout,
  WorkspacePaneNode,
  WorkspacePaneSplit,
  WorkspaceSessionPane,
} from "../api";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  CloseIcon,
  EditIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  SaveIcon,
  TrashIcon,
  WindowMoveIcon,
} from "../icons";
import { sessionDisplayTitle } from "../sessionDashboardModel";
import {
  PANE_NAVIGATION_ACTION,
  SHORTCUT_ACTION_EVENT,
  directShortcutAria,
  directShortcutLabel,
  matchesDirectShortcut,
  useShortcutSettings,
  type ShortcutActionId,
} from "../shortcutSettings";
import type { Session } from "../types";
import {
  adjacentWorkspacePaneId,
  assignWorkspacePaneSession,
  canSplitWorkspacePane,
  MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH,
  removeWorkspacePane,
  resizeWorkspacePaneSplit,
  splitWorkspacePane,
  workspacePaneLeaves,
  workspacePaneSessions,
  type WorkspacePaneDirection,
} from "../workspacePaneLayouts";
import {
  ActivePaneSessionContext,
  isCompactWorkspaceViewport,
  type WorkspacePersistenceState,
  type WorkspaceTabOrientation,
} from "./SessionWorkspaceNavigation";

interface WorkspacePaneBoardProps {
  layout: WorkspacePaneLayout;
  openSessions: string[];
  sessions: Session[];
  workspaceName?: string | null;
  workspaceLinks?: ReactNode;
  headerWidgets?: ReactNode;
  sessionNavigation: ReactNode;
  desktopTabOrientation: WorkspaceTabOrientation;
  desktopTabRailWidth: number;
  workspacePersistenceState: WorkspacePersistenceState;
  onChange: (layout: WorkspacePaneLayout) => Promise<void>;
  onDelete: (layoutId: string) => Promise<void>;
  onExit: () => void;
  renderSession: (
    sessionName: string,
    paneId: string,
    active: boolean,
    onActivate: () => void,
    focusRequestToken?: number,
  ) => ReactNode;
}

interface ResizeDrag {
  pointerId: number;
  splitId: string;
  direction: WorkspacePaneSplit["direction"];
  container: HTMLElement;
  target: HTMLDivElement;
  changed: boolean;
}

const PANE_NAVIGATION_REPEAT_MS = 1_500;

function sameLayout(left: WorkspacePaneLayout, right: WorkspacePaneLayout): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function WorkspacePaneBoard({
  layout,
  openSessions,
  sessions,
  workspaceName,
  workspaceLinks,
  headerWidgets,
  sessionNavigation,
  desktopTabOrientation,
  desktopTabRailWidth,
  workspacePersistenceState,
  onChange,
  onDelete,
  onExit,
  renderSession,
}: WorkspacePaneBoardProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const [draft, setDraft] = useState(layout);
  const draftRef = useRef(draft);
  const screenRef = useRef<HTMLElement>(null);
  const [activePaneId, setActivePaneId] = useState(
    () => workspacePaneLeaves(layout.root)[0]?.id ?? "",
  );
  const activePaneIdRef = useRef(activePaneId);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(layout.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [paneNavigationArmed, setPaneNavigationArmed] = useState(false);
  const paneNavigationArmedRef = useRef(false);
  const [paneNavigationStatus, setPaneNavigationStatus] = useState("");
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    paneId: string;
    token: number;
  } | null>(null);
  const terminalFocusRequestCounter = useRef(0);
  const paneNavigationTimerRef = useRef<number | null>(null);
  const resizeDragRef = useRef<ResizeDrag | null>(null);
  draftRef.current = draft;
  activePaneIdRef.current = activePaneId;

  useEffect(() => {
    setDraft(layout);
    setNameDraft(layout.name);
    const leaves = workspacePaneLeaves(layout.root);
    setActivePaneId((current) => {
      const next = leaves.some((pane) => pane.id === current)
        ? current
        : leaves[0]?.id ?? "";
      activePaneIdRef.current = next;
      return next;
    });
  }, [layout]);

  useEffect(() => {
    const title = workspaceName?.trim();
    document.title = title
      ? `${layout.name} - ${title}`
      : `${layout.name} - Muxdeck`;
  }, [layout.name, workspaceName]);

  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const assignedSessions = useMemo(
    () => new Set(workspacePaneSessions(draft)),
    [draft],
  );
  const paneCount = workspacePaneLeaves(draft.root).length;

  const clearPaneNavigationTimer = useCallback(() => {
    if (paneNavigationTimerRef.current === null) return;
    window.clearTimeout(paneNavigationTimerRef.current);
    paneNavigationTimerRef.current = null;
  }, []);

  const keepPaneNavigationArmed = useCallback(() => {
    clearPaneNavigationTimer();
    paneNavigationTimerRef.current = window.setTimeout(() => {
      paneNavigationTimerRef.current = null;
      paneNavigationArmedRef.current = false;
      setPaneNavigationArmed(false);
      setPaneNavigationStatus("");
    }, PANE_NAVIGATION_REPEAT_MS);
  }, [clearPaneNavigationTimer]);

  const disarmPaneNavigation = useCallback(() => {
    clearPaneNavigationTimer();
    paneNavigationArmedRef.current = false;
    setPaneNavigationArmed(false);
    setPaneNavigationStatus("");
  }, [clearPaneNavigationTimer]);

  const focusPane = useCallback((paneId: string) => {
    activePaneIdRef.current = paneId;
    setActivePaneId(paneId);
    const pane = workspacePaneLeaves(draftRef.current.root).find((item) => item.id === paneId);
    if (pane?.session) {
      terminalFocusRequestCounter.current += 1;
      setTerminalFocusRequest({
        paneId,
        token: terminalFocusRequestCounter.current,
      });
      return;
    }
    setTerminalFocusRequest(null);
    window.requestAnimationFrame(() => {
      const paneElement = Array.from(
        screenRef.current?.querySelectorAll<HTMLElement>("[data-pane-id]") ?? [],
      ).find((element) => element.dataset.paneId === paneId);
      paneElement?.querySelector<HTMLSelectElement>("select")?.focus();
    });
  }, []);

  const armPaneNavigation = useCallback(() => {
    if (isCompactWorkspaceViewport() || paneCount < 2) return;
    paneNavigationArmedRef.current = true;
    setPaneNavigationArmed(true);
    setPaneNavigationStatus("Use an arrow key to move between panes.");
    keepPaneNavigationArmed();
    focusPane(activePaneIdRef.current);
  }, [focusPane, keepPaneNavigationArmed, paneCount]);

  const movePaneFocus = useCallback((direction: WorkspacePaneDirection) => {
    const paneElements = Array.from(
      screenRef.current?.querySelectorAll<HTMLElement>("[data-pane-id]") ?? [],
    );
    const bounds = paneElements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.right <= rect.left || rect.bottom <= rect.top) return [];
      return [{
        id: element.dataset.paneId ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }];
    }).filter((pane) => pane.id);
    const nextPaneId = adjacentWorkspacePaneId(
      bounds,
      activePaneIdRef.current,
      direction,
    );
    if (!nextPaneId) {
      setPaneNavigationStatus(`No pane ${direction} of the active pane.`);
      keepPaneNavigationArmed();
      return;
    }
    const pane = workspacePaneLeaves(draftRef.current.root).find(
      (item) => item.id === nextPaneId,
    );
    const session = pane?.session ? sessionsByName.get(pane.session) : undefined;
    focusPane(nextPaneId);
    setPaneNavigationStatus(
      pane?.session
        ? `Focused ${session ? sessionDisplayTitle(session) : pane.session}.`
        : "Focused an empty pane.",
    );
    keepPaneNavigationArmed();
  }, [focusPane, keepPaneNavigationArmed, sessionsByName]);

  useEffect(() => clearPaneNavigationTimer, [clearPaneNavigationTimer]);

  useEffect(() => {
    const handleShortcutAction = (event: Event) => {
      if ((event as CustomEvent<ShortcutActionId>).detail === PANE_NAVIGATION_ACTION) {
        armPaneNavigation();
      }
    };
    const handlePaneNavigationKey = (event: KeyboardEvent) => {
      if (matchesDirectShortcut(event, shortcutBindings[PANE_NAVIGATION_ACTION])) {
        if (
          isCompactWorkspaceViewport()
          || document.querySelector('[aria-modal="true"]')
        ) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) armPaneNavigation();
        return;
      }
      if (!paneNavigationArmedRef.current) return;
      if (isCompactWorkspaceViewport()) {
        disarmPaneNavigation();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        disarmPaneNavigation();
        return;
      }
      const direction: WorkspacePaneDirection | null = event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
      if (!direction) {
        if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
          disarmPaneNavigation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      movePaneFocus(direction);
    };

    window.addEventListener("keydown", handlePaneNavigationKey, true);
    window.addEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
    return () => {
      window.removeEventListener("keydown", handlePaneNavigationKey, true);
      window.removeEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
    };
  }, [
    armPaneNavigation,
    disarmPaneNavigation,
    movePaneFocus,
    shortcutBindings,
  ]);

  const commit = async (next: WorkspacePaneLayout) => {
    if (sameLayout(next, layout) && sameLayout(next, draftRef.current)) return;
    setDraft(next);
    draftRef.current = next;
    setSaving(true);
    setError("");
    try {
      await onChange(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save pane view");
    } finally {
      setSaving(false);
    }
  };

  const assignSession = (pane: WorkspaceSessionPane, session: string | null) => {
    activePaneIdRef.current = pane.id;
    setActivePaneId(pane.id);
    void commit(assignWorkspacePaneSession(draftRef.current, pane.id, session));
  };

  const splitPane = (
    pane: WorkspaceSessionPane,
    direction: WorkspacePaneSplit["direction"],
  ) => {
    const next = splitWorkspacePane(draftRef.current, pane.id, direction);
    if (next === draftRef.current) return;
    const leaves = workspacePaneLeaves(next.root);
    const nextActivePaneId = leaves.at(-1)?.id ?? pane.id;
    activePaneIdRef.current = nextActivePaneId;
    setActivePaneId(nextActivePaneId);
    void commit(next);
  };

  const removePane = (pane: WorkspaceSessionPane) => {
    const next = removeWorkspacePane(draftRef.current, pane.id);
    const leaves = workspacePaneLeaves(next.root);
    const nextActivePaneId = leaves[0]?.id ?? "";
    activePaneIdRef.current = nextActivePaneId;
    setActivePaneId(nextActivePaneId);
    void commit(next);
  };

  const saveName = () => {
    const name = nameDraft.trim();
    if (!name || name.length > MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH) return;
    setEditingName(false);
    if (name !== draftRef.current.name) {
      void commit({ ...draftRef.current, name });
    }
  };

  const updateResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    split: WorkspacePaneSplit,
  ) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.splitId !== split.id) return;
    const rect = drag.container.getBoundingClientRect();
    const rawRatio = drag.direction === "horizontal"
      ? (event.clientX - rect.left) / Math.max(1, rect.width)
      : (event.clientY - rect.top) / Math.max(1, rect.height);
    const next = resizeWorkspacePaneSplit(draftRef.current, split.id, rawRatio);
    if (next !== draftRef.current) {
      drag.changed = true;
      draftRef.current = next;
      setDraft(next);
    }
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeDragRef.current = null;
    try {
      if (drag.target.hasPointerCapture(event.pointerId)) {
        drag.target.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The final ratio is still valid if pointer capture was already released.
    }
    if (drag.changed) void commit(draftRef.current);
  };

  const resizeWithKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>,
    split: WorkspacePaneSplit,
  ) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    let ratio = split.ratio;
    if (event.key === "Home") ratio = 0.15;
    else if (event.key === "End") ratio = 0.85;
    else if (event.key === "Enter") ratio = 0.5;
    else if (
      (split.direction === "horizontal" && event.key === "ArrowLeft")
      || (split.direction === "vertical" && event.key === "ArrowUp")
    ) ratio -= step;
    else if (
      (split.direction === "horizontal" && event.key === "ArrowRight")
      || (split.direction === "vertical" && event.key === "ArrowDown")
    ) ratio += step;
    else return;
    event.preventDefault();
    void commit(resizeWorkspacePaneSplit(draftRef.current, split.id, ratio));
  };

  const renderPane = (pane: WorkspaceSessionPane) => {
    const selectedSession = pane.session ? sessionsByName.get(pane.session) : undefined;
    const active = activePaneId === pane.id;
    return (
      <section
        key={pane.id}
        className={[
          "workspace-pane-leaf",
          active ? "active" : "",
          active && paneNavigationArmed ? "navigation-target" : "",
        ].filter(Boolean).join(" ")}
        data-pane-id={pane.id}
        onPointerDownCapture={() => {
          activePaneIdRef.current = pane.id;
          setActivePaneId(pane.id);
          if (paneNavigationArmed) disarmPaneNavigation();
        }}
      >
        <header className="workspace-pane-leaf-toolbar">
          <span className="workspace-pane-leaf-mark" aria-hidden="true" />
          <label>
            <span>Session</span>
            <select
              value={pane.session ?? ""}
              disabled={saving}
              aria-label={`Session shown in pane ${pane.id}`}
              onChange={(event) => assignSession(pane, event.target.value || null)}
            >
              <option value="">Choose workspace session...</option>
              {openSessions.map((sessionName) => {
                const session = sessionsByName.get(sessionName);
                const usedElsewhere = assignedSessions.has(sessionName)
                  && sessionName !== pane.session;
                return (
                  <option key={sessionName} value={sessionName}>
                    {session ? sessionDisplayTitle(session) : sessionName}
                    {!session ? " (unavailable)" : usedElsewhere ? " (move here)" : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <div className="workspace-pane-leaf-actions" role="group" aria-label="Pane layout actions">
            <button
              type="button"
              disabled={saving || !canSplitWorkspacePane(draft, pane.id)}
              onClick={() => splitPane(pane, "horizontal")}
              aria-label="Split this pane left and right"
              title="Split left / right"
            >
              <ListIcon /><span>Split right</span>
            </button>
            <button
              type="button"
              disabled={saving || !canSplitWorkspacePane(draft, pane.id)}
              onClick={() => splitPane(pane, "vertical")}
              aria-label="Split this pane top and bottom"
              title="Split top / bottom"
            >
              <GridIcon /><span>Split down</span>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => removePane(pane)}
              aria-label={paneCount === 1 ? "Clear this pane" : "Remove this pane"}
              title={paneCount === 1 ? "Clear assignment" : "Remove pane and expand its neighbor"}
            >
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className="workspace-pane-leaf-content">
          {pane.session
            ? renderSession(
                pane.session,
                pane.id,
                active,
                () => setActivePaneId(pane.id),
                terminalFocusRequest?.paneId === pane.id
                  ? terminalFocusRequest.token
                  : undefined,
              )
            : (
              <div className="workspace-pane-empty">
                <GridIcon />
                <strong>Empty pane</strong>
                <p>Choose an open workspace session, then split this pane again whenever you need more.</p>
              </div>
            )}
        </div>
        {pane.session && !selectedSession && (
          <span className="workspace-pane-session-unavailable" role="status">
            Waiting for {pane.session} to become available
          </span>
        )}
      </section>
    );
  };

  const renderNode = (node: WorkspacePaneNode): ReactNode => {
    if (node.kind === "pane") return renderPane(node);
    const splitStyle = {
      "--workspace-pane-first": `${node.ratio * 100}%`,
    } as React.CSSProperties;
    return (
      <div
        key={node.id}
        className={`workspace-pane-split workspace-pane-split-${node.direction}`}
        data-split-id={node.id}
        style={splitStyle}
      >
        <div className="workspace-pane-split-first">{renderNode(node.first)}</div>
        <div
          className="workspace-pane-divider"
          role="separator"
          tabIndex={0}
          aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(node.ratio * 100)}
          aria-label="Resize workspace panes"
          title="Drag to resize. Arrow keys adjust; Shift moves farther; Enter resets."
          onPointerDown={(event) => {
            if (event.button !== 0 || saving) return;
            const container = event.currentTarget.parentElement;
            if (!container) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeDragRef.current = {
              pointerId: event.pointerId,
              splitId: node.id,
              direction: node.direction,
              container,
              target: event.currentTarget,
              changed: false,
            };
          }}
          onPointerMove={(event) => updateResize(event, node)}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(event) => resizeWithKeyboard(event, node)}
        >
          <span />
        </div>
        <div className="workspace-pane-split-second">{renderNode(node.second)}</div>
      </div>
    );
  };

  return (
    <main
      ref={screenRef}
      id="muxdeck-workspace-pane-board"
      className={paneNavigationArmed
        ? "workspace-pane-screen pane-navigation-armed"
        : "workspace-pane-screen"}
      data-desktop-tabs={desktopTabOrientation}
      style={{ "--desktop-tab-rail-width": `${desktopTabRailWidth}px` } as React.CSSProperties}
    >
      <div className="workspace-pane-mobile-unavailable">
        <GridIcon />
        <strong>Multi-pane views are desktop-only</strong>
        <button type="button" onClick={onExit}>Return to session</button>
      </div>
      <div className="workspace-pane-top-strip">
        <button type="button" className="workspace-pane-back" onClick={onExit}>
          <ArrowLeftIcon /><span>Session</span>
        </button>
        <div className="workspace-pane-links">{workspaceLinks}</div>
        <span className={`workspace-pane-save-state ${workspacePersistenceState}`}>
          <SaveIcon />
          {saving
            ? "Saving layout..."
            : workspacePersistenceState === "unsaved"
              ? "Saves with workspace"
              : "Layout saved"}
        </span>
      </div>
      <header className="workspace-pane-header">
        <div className="workspace-pane-title">
          <GridIcon />
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              maxLength={MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH}
              aria-label="Pane view name"
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                else if (event.key === "Escape") {
                  setNameDraft(draft.name);
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <>
              <div>
                <span>Multi-pane view</span>
                <h1>{draft.name}</h1>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditingName(true)}
                aria-label={`Rename pane view ${draft.name}`}
              >
                <EditIcon />
              </button>
            </>
          )}
        </div>
        <div className="workspace-pane-header-summary">
          <strong>{paneCount}</strong><span>{paneCount === 1 ? "pane" : "panes"}</span>
          <small>{workspacePaneSessions(draft).length} assigned</small>
        </div>
        {headerWidgets}
        <div className="workspace-pane-navigation-control">
          <button
            type="button"
            className={paneNavigationArmed ? "active" : ""}
            disabled={paneCount < 2}
            aria-pressed={paneNavigationArmed}
            aria-keyshortcuts={directShortcutAria(
              shortcutBindings[PANE_NAVIGATION_ACTION],
            )}
            title={paneCount < 2
              ? "Split this view before navigating between panes"
              : `Arm pane navigation${directShortcutLabel(
                shortcutBindings[PANE_NAVIGATION_ACTION],
              ) ? ` (${directShortcutLabel(shortcutBindings[PANE_NAVIGATION_ACTION])})` : ""}`}
            onClick={paneNavigationArmed ? disarmPaneNavigation : armPaneNavigation}
          >
            <WindowMoveIcon />
            <span>{paneNavigationArmed ? "Navigating" : "Navigate"}</span>
            {directShortcutLabel(shortcutBindings[PANE_NAVIGATION_ACTION]) && (
              <kbd>{directShortcutLabel(shortcutBindings[PANE_NAVIGATION_ACTION])}</kbd>
            )}
          </button>
        </div>
        <div className="workspace-pane-danger">
          <button
            type="button"
            className={deleteArmed ? "armed" : ""}
            disabled={saving}
            onClick={() => {
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              setSaving(true);
              void onDelete(draft.id).catch((reason) => {
                setError(reason instanceof Error ? reason.message : "Unable to delete pane view");
                setSaving(false);
                setDeleteArmed(false);
              });
            }}
          >
            <TrashIcon />
            <span>{deleteArmed ? "Confirm delete" : "Delete view"}</span>
          </button>
        </div>
      </header>
      <ActivePaneSessionContext.Provider value={
        workspacePaneLeaves(draft.root).find((pane) => pane.id === activePaneId)?.session ?? null
      }>
        <div className="workspace-pane-navigation">{sessionNavigation}</div>
      </ActivePaneSessionContext.Provider>
      {error && (
        <aside className="workspace-pane-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>Dismiss</button>
        </aside>
      )}
      <div className="workspace-pane-canvas">
        {paneNavigationArmed && (
          <div className="workspace-pane-navigation-hud" role="status" aria-live="polite">
            <WindowMoveIcon />
            <span>
              <strong>Pane navigation</strong>
              <small>{paneNavigationStatus}</small>
            </span>
            <kbd>Arrow keys</kbd>
            <kbd>Esc</kbd>
          </div>
        )}
        {renderNode(draft.root)}
      </div>
      <div className="workspace-pane-mobile-unavailable-actions" aria-hidden="true">
        <PlusIcon /><ArrowDownIcon />
      </div>
    </main>
  );
}
