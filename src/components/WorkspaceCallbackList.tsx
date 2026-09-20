import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  CheckIcon,
  CloseIcon,
  HistoryIcon,
  PinIcon,
  PlusIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import type { CallbackMessage, GlobalCallbackSnapshot } from "../api";
import "./WorkspaceCallbackMessages.css";
import type { AgentState, Session } from "../types";
import {
  directShortcutAria,
  directShortcutLabel,
  useShortcutSettings,
} from "../shortcutSettings";

const DESKTOP_CALLBACK_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const CALLBACK_STORAGE_PREFIX = "muxdeck.workspace-callback-panel.v1:";
export const CALLBACK_SCOPE_PREFERENCE_STORAGE_KEY = `${CALLBACK_STORAGE_PREFIX}scope`;
const CALLBACK_PANEL_MARGIN = 12;
const CALLBACK_PANEL_WIDTH = 390;
const CALLBACK_PANEL_HEIGHT = 520;
const CALLBACK_PANEL_MIN_WIDTH = 300;
const CALLBACK_PANEL_MIN_HEIGHT = 300;
const CALLBACK_MOVE_STEP = 12;
const CALLBACK_MOVE_LARGE_STEP = 32;

interface CallbackPanelPosition {
  x: number;
  y: number;
}

interface CallbackPanelSize {
  width: number;
  height: number;
}

interface CallbackPanelPreference {
  open: boolean;
  pinned: boolean;
  position: CallbackPanelPosition | null;
  size: CallbackPanelSize | null;
}

interface WorkspaceCallbackListProps {
  sessionName: string;
  /** The session being viewed; null for views without a single active session. */
  activeSessionName?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  temporaryKey?: string;
  sessions: readonly Session[];
  /** Names currently open as tabs in this workspace. */
  workspaceSessionNames?: readonly string[];
  callbackSessions: readonly string[];
  onChange: (sessions: string[]) => Promise<void>;
  /** Global callback state; omitted for backwards-compatible workspace-only use. */
  globalCallbackSnapshot?: GlobalCallbackSnapshot | null;
  onGlobalChange?: (sessions: string[]) => Promise<void>;
  globalCallbackBusy?: boolean;
  onGlobalRefresh?: () => void;
  /** Mark a callback reviewed across all global/workspace queues. */
  onReviewSession?: (sessionName: string) => Promise<void>;
  onReviewMessage?: (id: string) => Promise<void>;
  onSelectSession: (sessionName: string) => void;
}

export type CallbackScope = "global" | "workspace";

interface CallbackPanelState {
  open: boolean;
  pinned: boolean;
  position: CallbackPanelPosition;
  size: CallbackPanelSize;
}

interface CallbackPanelStore {
  identity: string;
  panel: CallbackPanelState;
}

function viewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function defaultPosition(): CallbackPanelPosition {
  const view = viewport();
  return {
    x: Math.max(CALLBACK_PANEL_MARGIN, view.width - CALLBACK_PANEL_WIDTH - 24),
    y: Math.max(CALLBACK_PANEL_MARGIN, 94),
  };
}

function defaultSize(): CallbackPanelSize {
  return { width: CALLBACK_PANEL_WIDTH, height: CALLBACK_PANEL_HEIGHT };
}

function clampSize(
  size: CallbackPanelSize,
  position: CallbackPanelPosition = { x: CALLBACK_PANEL_MARGIN, y: CALLBACK_PANEL_MARGIN },
): CallbackPanelSize {
  const view = viewport();
  return {
    width: Math.round(Math.min(
      Math.max(CALLBACK_PANEL_MIN_WIDTH, view.width - position.x - CALLBACK_PANEL_MARGIN),
      Math.max(CALLBACK_PANEL_MIN_WIDTH, size.width),
    )),
    height: Math.round(Math.min(
      Math.max(CALLBACK_PANEL_MIN_HEIGHT, view.height - position.y - CALLBACK_PANEL_MARGIN),
      Math.max(CALLBACK_PANEL_MIN_HEIGHT, size.height),
    )),
  };
}

function clampPosition(
  position: CallbackPanelPosition,
  size: CallbackPanelSize,
): CallbackPanelPosition {
  const view = viewport();
  return {
    x: Math.round(Math.min(
      Math.max(CALLBACK_PANEL_MARGIN, position.x),
      Math.max(CALLBACK_PANEL_MARGIN, view.width - size.width - CALLBACK_PANEL_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(CALLBACK_PANEL_MARGIN, position.y),
      Math.max(CALLBACK_PANEL_MARGIN, view.height - size.height - CALLBACK_PANEL_MARGIN),
    )),
  };
}

function validPosition(value: unknown): value is CallbackPanelPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CallbackPanelPosition>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function validSize(value: unknown): value is CallbackPanelSize {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CallbackPanelSize>;
  return Number.isFinite(candidate.width)
    && Number.isFinite(candidate.height)
    && Number(candidate.width) > 0
    && Number(candidate.height) > 0;
}

function readPreference(identity: string): CallbackPanelState {
  const fallback: CallbackPanelState = {
    open: false,
    pinned: false,
    position: defaultPosition(),
    size: defaultSize(),
  };
  try {
    const raw = window.localStorage.getItem(`${CALLBACK_STORAGE_PREFIX}${identity}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CallbackPanelPreference>;
    const position = validPosition(parsed.position) ? parsed.position : fallback.position;
    const size = validSize(parsed.size) ? parsed.size : fallback.size;
    const clampedSize = clampSize(size, position);
    const clampedPosition = clampPosition(position, clampedSize);
    return {
      open: parsed.open === true || parsed.pinned === true,
      pinned: parsed.pinned === true,
      position: clampedPosition,
      size: clampedSize,
    };
  } catch {
    return fallback;
  }
}

function writePreference(identity: string, panel: CallbackPanelState): void {
  try {
    const preference: CallbackPanelPreference = {
      open: panel.open,
      pinned: panel.pinned,
      position: panel.position,
      size: panel.size,
    };
    window.localStorage.setItem(
      `${CALLBACK_STORAGE_PREFIX}${identity}`,
      JSON.stringify(preference),
    );
  } catch {
    // Callback content is server-persisted; panel layout is optional browser state.
  }
}

function desktopCallbackViewport(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(DESKTOP_CALLBACK_QUERY).matches;
  }
  return window.innerWidth > 640 && window.innerHeight > 500;
}

function callbackStatus(session: Session | undefined): {
  label: string;
  tone: string;
  working: boolean;
} {
  if (!session) return { label: "Ended / unavailable", tone: "ended", working: false };
  const state: AgentState = session.agentState;
  if (state === "working") return { label: "Working", tone: "working", working: true };
  if (state === "waiting_human") return { label: "Ready for review", tone: "ready", working: false };
  if (state === "waiting_command") return { label: "Waiting", tone: "waiting", working: false };
  if (state === "unknown") return { label: "Status unknown", tone: "unknown", working: false };
  return { label: "Ready", tone: "ready", working: false };
}

function sessionDisplayName(session: Session | undefined, fallback: string): string {
  return session?.customTitle?.trim() || fallback;
}

function normalizeCallbackSessions(value: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value ?? []) {
    if (typeof candidate !== "string" || !candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function isCallbackScope(value: unknown): value is CallbackScope {
  return value === "global" || value === "workspace";
}

function readPreferredCallbackScope(fallback: CallbackScope): CallbackScope {
  try {
    const stored = window.localStorage.getItem(CALLBACK_SCOPE_PREFERENCE_STORAGE_KEY);
    return isCallbackScope(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function writePreferredCallbackScope(scope: CallbackScope): void {
  try {
    window.localStorage.setItem(CALLBACK_SCOPE_PREFERENCE_STORAGE_KEY, scope);
  } catch {
    // Scope preference is optional when browser storage is unavailable.
  }
}

export function WorkspaceCallbackList({
  sessionName,
  activeSessionName = sessionName,
  workspaceId = null,
  workspaceName = null,
  temporaryKey = "default",
  sessions,
  workspaceSessionNames,
  callbackSessions,
  onChange,
  globalCallbackSnapshot = null,
  onGlobalChange,
  globalCallbackBusy = false,
  onGlobalRefresh,
  onReviewSession,
  onReviewMessage,
  onSelectSession,
}: WorkspaceCallbackListProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const [desktop, setDesktop] = useState(desktopCallbackViewport);
  const headingId = useId();
  const panelId = `${headingId}-panel`;
  const panelRef = useRef<HTMLElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const globalEnabled = globalCallbackSnapshot !== null || Boolean(onGlobalChange);
  const initialScopeRef = useRef<CallbackScope | null>(null);
  if (initialScopeRef.current === null) {
    initialScopeRef.current = readPreferredCallbackScope(globalEnabled ? "global" : "workspace");
  }
  const [scope, setScope] = useState<CallbackScope>(initialScopeRef.current);
  const activeScope: CallbackScope = globalEnabled ? scope : "workspace";
  const workspaceIdentity = workspaceId ? `workspace:${workspaceId}` : `temporary:${temporaryKey}`;
  const identity = activeScope === "global" ? "global" : workspaceIdentity;
  const initialStoreRef = useRef<CallbackPanelStore | null>(null);
  if (initialStoreRef.current === null) {
    initialStoreRef.current = { identity, panel: readPreference(identity) };
  }
  const [store, setStore] = useState<CallbackPanelStore>(initialStoreRef.current);
  const [busy, setBusy] = useState(false);
  const isBusy = busy || globalCallbackBusy;
  const [error, setError] = useState("");
  const [selectedSession, setSelectedSession] = useState("");
  const previousSessionRef = useRef({ identity, sessionName });

  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_CALLBACK_QUERY);
    const update = () => setDesktop(desktopCallbackViewport());
    update();
    query?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener?.("resize", update);
    return () => {
      query?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener?.("resize", update);
    };
  }, []);

  useEffect(() => {
    if (store.identity === identity) return;
    setStore({ identity, panel: readPreference(identity) });
    setSelectedSession("");
    setError("");
  }, [identity, store.identity]);

  useEffect(() => {
    if (store.identity !== identity) return;
    writePreference(identity, store.panel);
  }, [identity, store]);

  const active = store.identity === identity;
  const panel = active ? store.panel : {
    open: false,
    pinned: false,
    position: defaultPosition(),
    size: defaultSize(),
  };

  const workspaceSessionList = normalizeCallbackSessions(callbackSessions);
  const workspaceSessionSet = workspaceSessionNames === undefined
    ? null
    : new Set(workspaceSessionNames);
  const pendingMessages = (globalCallbackSnapshot?.callbackMessages ?? [])
    .filter((message) => message.reviewedAt === null);
  const visibleMessages = activeScope === "global" ? pendingMessages : pendingMessages.filter(
    (message) => workspaceSessionSet?.has(message.sessionName)
      || workspaceSessionList.includes(message.sessionName),
  );
  const messagesBySession = new Map<string, CallbackMessage[]>();
  for (const message of visibleMessages) {
    const messages = messagesBySession.get(message.sessionName) ?? [];
    messages.push(message);
    messagesBySession.set(message.sessionName, messages);
  }
  const explicitGlobalSessions = normalizeCallbackSessions(
    globalCallbackSnapshot?.globalCallbackSessions
      ?? (globalEnabled ? undefined : callbackSessions),
  );
  const sourceRecords = (globalCallbackSnapshot?.workspaceCallbacks ?? []).map((source) => ({
    ...source,
    sessions: normalizeCallbackSessions(source.sessions),
  }));
  const currentSourceId = workspaceId || `temporary:${temporaryKey}`;
  const currentSource = {
    workspaceId: currentSourceId,
    workspaceName: workspaceName?.trim() || "This workspace",
    sessions: workspaceSessionList,
  };
  const sourceIndex = sourceRecords.findIndex((source) => source.workspaceId === currentSourceId);
  if (sourceIndex >= 0) sourceRecords[sourceIndex] = currentSource;
  else if (workspaceSessionList.length > 0) sourceRecords.push(currentSource);
  const globalSessionList = normalizeCallbackSessions([
    ...explicitGlobalSessions,
    ...(globalCallbackSnapshot?.callbackSessions ?? []),
    ...sourceRecords.flatMap((source) => source.sessions),
    ...pendingMessages.map((message) => message.sessionName),
  ]);
  const visibleCallbackSessions = activeScope === "global"
    ? globalSessionList
    : normalizeCallbackSessions([
      ...workspaceSessionList, ...visibleMessages.map((message) => message.sessionName),
    ]);
  const globalWorkspaceSources = new Map<string, typeof sourceRecords>();
  sourceRecords.forEach((source) => {
    source.sessions.forEach((name) => {
      const existing = globalWorkspaceSources.get(name) ?? [];
      existing.push(source);
      globalWorkspaceSources.set(name, existing);
    });
  });

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (
      previous.identity === identity
      && previous.sessionName !== sessionName
      && activeScope !== "global"
      && !panel.pinned
      && panel.open
    ) {
      setStore((current) => current.identity === identity
        ? { ...current, panel: { ...current.panel, open: false, pinned: false } }
        : current);
    }
    previousSessionRef.current = { identity, sessionName };
  }, [activeScope, identity, panel.open, panel.pinned, sessionName]);

  useEffect(() => () => {
    interactionCleanupRef.current?.();
    document.documentElement.classList.remove("workspace-callback-moving");
  }, []);

  useEffect(() => {
    if (!active || !panel.open) return;
    const keepVisible = () => {
      setStore((current) => {
        if (current.identity !== identity) return current;
        const size = clampSize(current.panel.size, current.panel.position);
        const position = clampPosition(current.panel.position, size);
        if (
          size.width === current.panel.size.width
          && size.height === current.panel.size.height
          && position.x === current.panel.position.x
          && position.y === current.panel.position.y
        ) return current;
        return { ...current, panel: { ...current.panel, position, size } };
      });
    };
    window.addEventListener("resize", keepVisible);
    window.visualViewport?.addEventListener?.("resize", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      window.visualViewport?.removeEventListener?.("resize", keepVisible);
    };
  }, [active, identity, panel.open]);

  const updatePanel = useCallback((updater: (current: CallbackPanelState) => CallbackPanelState) => {
    setStore((current) => current.identity === identity
      ? { ...current, panel: updater(current.panel) }
      : current);
  }, [identity]);

  useEffect(() => {
    if (!active || !desktop || !panel.open || typeof ResizeObserver !== "function") return;
    const element = panelRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const measured = {
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
      if (measured.width <= 0 || measured.height <= 0) return;
      updatePanel((current) => {
        const size = clampSize(measured, current.position);
        const position = clampPosition(current.position, size);
        if (
          size.width === current.size.width
          && size.height === current.size.height
          && position.x === current.position.x
          && position.y === current.position.y
        ) return current;
        return { ...current, position, size };
      });
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [active, desktop, panel.open, updatePanel]);

  const persistCallbacks = useCallback(async (
    targetScope: CallbackScope,
    next: readonly string[],
  ) => {
    const unique = normalizeCallbackSessions(next);
    setBusy(true);
    setError("");
    try {
      if (targetScope === "global") {
        if (!onGlobalChange) throw new Error("Global callback list is unavailable.");
        await onGlobalChange(unique);
      } else {
        await onChange(unique);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save callback list");
    } finally {
      setBusy(false);
    }
  }, [onChange, onGlobalChange]);

  const changeCallbacks = useCallback((next: readonly string[]) => (
    persistCallbacks(activeScope, next)
  ), [activeScope, persistCallbacks]);

  const addSession = useCallback((name: string) => {
    if (!name || visibleCallbackSessions.includes(name)) return;
    const base = activeScope === "global"
      ? explicitGlobalSessions
      : workspaceSessionList;
    void changeCallbacks([...base, name]);
    setSelectedSession("");
  }, [activeScope, changeCallbacks, explicitGlobalSessions, visibleCallbackSessions, workspaceSessionList]);

  const removeSession = useCallback((name: string) => {
    if (activeScope === "global") {
      if (!explicitGlobalSessions.includes(name)) {
        const sources = globalWorkspaceSources.get(name) ?? [];
        const currentSourceOwnsEntry = sources.some((source) => source.workspaceId === currentSourceId);
        if (!currentSourceOwnsEntry) return;
        void persistCallbacks("workspace", workspaceSessionList.filter((item) => item !== name));
        return;
      }
      void changeCallbacks(explicitGlobalSessions.filter((item) => item !== name));
      return;
    }
    void changeCallbacks(workspaceSessionList.filter((item) => item !== name));
  }, [activeScope, changeCallbacks, currentSourceId, explicitGlobalSessions, globalWorkspaceSources, persistCallbacks, workspaceSessionList]);

  const reviewSession = useCallback(async (name: string) => {
    if (!onReviewSession) {
      removeSession(name);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onReviewSession(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review callback");
    } finally {
      setBusy(false);
    }
  }, [onReviewSession, removeSession]);

  const reviewMessage = async (id: string) => {
    if (!onReviewMessage) return;
    setBusy(true);
    setError("");
    try {
      await onReviewMessage(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review message");
    } finally {
      setBusy(false);
    }
  };

  const clearCallbacks = async (names: readonly string[]) => {
    const selected = new Set(names);
    setBusy(true);
    setError("");
    try {
      // Capture the manual-list mutation before any message request can yield
      // to another tab's update. Later message reviews never replace that list.
      const manual = activeScope === "global" ? explicitGlobalSessions : workspaceSessionList;
      const nextManual = manual.filter((name) => !selected.has(name));
      if (activeScope === "global") {
        if (!onGlobalChange) throw new Error("Global callback list is unavailable.");
        await onGlobalChange(nextManual);
      } else {
        await onChange(nextManual);
      }
      // Reviewing messages preserves their history and other workspace markers.
      for (const message of visibleMessages) {
        if (selected.has(message.sessionName)) await onReviewMessage?.(message.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to clear callbacks");
    } finally {
      setBusy(false);
    }
  };

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button, input, select, a")) return;
    event.preventDefault();
    event.stopPropagation();
    interactionCleanupRef.current?.();
    const pointerId = event.pointerId;
    const rect = panelRef.current?.getBoundingClientRect();
    const offsetX = event.clientX - (rect?.left ?? panel.position.x);
    const offsetY = event.clientY - (rect?.top ?? panel.position.y);
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("workspace-callback-moving");
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      updatePanel((current) => ({
        ...current,
        position: clampPosition({
          x: moveEvent.clientX - offsetX,
          y: moveEvent.clientY - offsetY,
        }, current.size),
      }));
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    interactionCleanupRef.current = cleanup;
    document.documentElement.classList.add("workspace-callback-moving");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [panel.position.x, panel.position.y, panel.size, updatePanel]);

  const moveWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      updatePanel((current) => ({
        ...current,
        position: clampPosition(defaultPosition(), current.size),
      }));
      return;
    }
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const vector = direction[event.key];
    if (!vector) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? CALLBACK_MOVE_LARGE_STEP : CALLBACK_MOVE_STEP;
    updatePanel((current) => ({
      ...current,
      position: clampPosition({
        x: current.position.x + vector[0] * distance,
        y: current.position.y + vector[1] * distance,
      }, current.size),
    }));
  }, [updatePanel]);

  const selectScope = useCallback((nextScope: CallbackScope) => {
    if (nextScope === activeScope || (nextScope === "global" && !globalEnabled)) return;
    writePreferredCallbackScope(nextScope);
    const nextIdentity = nextScope === "global" ? "global" : workspaceIdentity;
    setScope(nextScope);
    setStore({
      identity: nextIdentity,
      panel: { ...readPreference(nextIdentity), open: true },
    });
    setSelectedSession("");
    setError("");
    if (nextScope === "global") onGlobalRefresh?.();
  }, [activeScope, globalEnabled, onGlobalRefresh, workspaceIdentity]);

  if (!desktop) return null;

  const sessionMap = new Map(sessions.map((item) => [item.name, item]));
  for (const [name, messages] of messagesBySession) {
    const manuallyWatched = activeScope === "global"
      ? explicitGlobalSessions.includes(name) || globalWorkspaceSources.has(name)
      : workspaceSessionList.includes(name);
    const reportedIds = messages.flatMap((message) => (
      message.tmuxSessionId === null ? [] : [message.tmuxSessionId]
    ));
    if (!manuallyWatched && reportedIds.length > 0
      && !reportedIds.includes(sessionMap.get(name)?.id ?? "")) {
      // A reused name must not open a replacement shell for an older callback.
      sessionMap.delete(name);
    }
  }
  const availableSessions = sessions.filter((item) => !visibleCallbackSessions.includes(item.name));
  const workingCount = visibleCallbackSessions.filter((name) => callbackStatus(sessionMap.get(name)).working).length;
  const readyCount = visibleCallbackSessions.filter((name) => callbackStatus(sessionMap.get(name)).tone === "ready").length;
  const unavailableCount = visibleCallbackSessions.filter((name) => !sessionMap.has(name)).length;
  const removableUnavailableCount = activeScope === "global"
    ? new Set([
      ...explicitGlobalSessions,
      ...visibleMessages.map((message) => message.sessionName),
    ].filter((name) => !sessionMap.has(name))).size
    : unavailableCount;
  const inheritedCount = activeScope === "global"
    ? visibleCallbackSessions.filter((name) => !explicitGlobalSessions.includes(name)
      && globalWorkspaceSources.has(name)).length
    : 0;
  const scopeLabel = activeScope === "global"
    ? "Global"
    : workspaceName?.trim() || "Workspace";
  const scopeDescription = activeScope === "global"
    ? "Global queue · includes every workspace callback"
    : workspaceId
      ? "Workspace queue · saved with this workspace"
      : "Workspace queue · temporary workspace in this browser";
  const panelStyle: CSSProperties = {
    left: panel.position.x,
    top: panel.position.y,
    width: panel.size.width,
    height: panel.size.height,
  };

  const floatingPanel = panel.open ? (
    <section
      ref={panelRef}
      id={panelId}
      className={`workspace-callback-panel${panel.pinned ? " pinned" : ""}${workingCount > 0 ? " has-working" : ""}`}
      style={panelStyle}
      role="dialog"
      aria-labelledby={headingId}
      data-pinned={panel.pinned ? "true" : "false"}
      data-scope={activeScope}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          updatePanel((current) => ({ ...current, open: false, pinned: false }));
        }
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header
        className="workspace-callback-panel-header"
        tabIndex={0}
        aria-label="Move callback list window"
        title="Drag this title strip to move the callback list. Arrow keys also move it."
        onPointerDown={startDragging}
        onKeyDown={moveWithKeyboard}
      >
        <HistoryIcon />
        <div>
          <span>{scopeLabel}</span>
          <h2 id={headingId}>Callback list</h2>
        </div>
        {panel.pinned && <em aria-hidden="true">PINNED</em>}
        <button
          type="button"
          aria-label={panel.pinned ? "Unpin callback list" : "Pin callback list"}
          aria-pressed={panel.pinned}
          title={panel.pinned
            ? "Stop keeping the callback list open across session switches"
            : "Keep the callback list visible across session switches"}
          onClick={() => updatePanel((current) => ({
            ...current,
            open: true,
            pinned: !current.pinned,
          }))}
        >
          <PinIcon filled={panel.pinned} />
        </button>
        <button
          type="button"
          aria-label="Close callback list"
          title="Hide the callback list"
          onClick={() => updatePanel((current) => ({ ...current, open: false, pinned: false }))}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="workspace-callback-body">
        <div className="workspace-callback-summary">
          <strong>{visibleCallbackSessions.length} watching</strong>
          {visibleMessages.length > 0 && <span className="workspace-callback-message-count">
            {visibleMessages.length} {visibleMessages.length === 1 ? "message" : "messages"}
          </span>}
          <span>{workingCount} working</span>
          {unavailableCount > 0 && <span className="ended">{unavailableCount} ended</span>}
          {activeScope === "global" && inheritedCount > 0 && (
            <span>{inheritedCount} from workspaces</span>
          )}
        </div>
        {globalEnabled && (
          <div className="workspace-callback-scope" role="group" aria-label="Callback scope">
            {(["global", "workspace"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={activeScope === candidate}
                aria-label={`${candidate[0].toUpperCase()}${candidate.slice(1)} callback scope`}
                onClick={() => selectScope(candidate)}
              >
                {candidate === "global" ? "Global" : "Workspace"}
              </button>
            ))}
          </div>
        )}
        <p className="workspace-callback-scope-description">{scopeDescription}</p>
        <div className="workspace-callback-add" role="group" aria-label="Add a session to the callback list">
          <select
            aria-label="Choose a session to watch"
            value={selectedSession}
            disabled={isBusy || availableSessions.length === 0}
            onChange={(event) => setSelectedSession(event.target.value)}
          >
            <option value="">Choose session...</option>
            {availableSessions.map((item) => (
              <option key={item.name} value={item.name}>
                {sessionDisplayName(item, item.name)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={isBusy || !selectedSession}
            onClick={() => addSession(selectedSession)}
          >
            <PlusIcon />
            <span>Add</span>
          </button>
          <button
            type="button"
            disabled={isBusy || !sessionName || visibleCallbackSessions.includes(sessionName)}
            onClick={() => addSession(sessionName)}
            title={visibleCallbackSessions.includes(sessionName)
              ? "The current session is already being watched"
              : "Add the current session"}
          >
            <TerminalIcon />
            <span>Current</span>
          </button>
        </div>
        {error && (
          <div className="workspace-callback-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {visibleCallbackSessions.length === 0 ? (
          <div className="workspace-callback-empty">
            <HistoryIcon />
            <strong>Nothing queued for a callback</strong>
            <span>{activeScope === "global"
              ? "Add sessions globally, or mark one in any workspace to inherit it here."
              : "Add sessions here before you step away. Their live status stays visible."}</span>
          </div>
        ) : (
          <ol className="workspace-callback-list" aria-label="Sessions to call back">
            {visibleCallbackSessions.map((name, index) => {
              const session = sessionMap.get(name);
              const messages = messagesBySession.get(name) ?? [];
              const status = callbackStatus(session);
              const globalOnly = activeScope === "global" && explicitGlobalSessions.includes(name);
              const sources = globalWorkspaceSources.get(name) ?? [];
              const inCurrentWorkspace = workspaceSessionSet === null
                || workspaceSessionSet.has(name);
              const sourceLabel = sources.length > 0
                ? sources.length === 1
                  ? sources[0].workspaceName
                  : `${sources.length} workspaces`
                : "Global queue";
              const locationLabel = activeScope === "global"
                ? inCurrentWorkspace
                  ? "This workspace"
                  : sources.length > 0
                    ? `Other · ${sourceLabel}`
                    : "Global only"
                : inCurrentWorkspace
                  ? (session && session.customTitle ? name : status.label)
                  : "Not in this workspace";
              const canOpen = Boolean(session && inCurrentWorkspace);
              const currentSourceOwnsEntry = sources.some(
                (source) => source.workspaceId === currentSourceId,
              );
              const canRemove = activeScope !== "global"
                || Boolean(onReviewSession)
                || globalOnly
                || currentSourceOwnsEntry;
              const removeLabel = activeScope === "global"
                ? onReviewSession
                  ? `Mark ${name} reviewed and remove from all callback lists`
                  : globalOnly
                    ? `Remove ${name} from the global callback list`
                    : `Remove ${name} from this workspace callback list`
                : `Mark ${name} reviewed and remove from callback list`;
              const sessionTitle = !session
                ? `${name} is no longer live`
                : canOpen
                  ? `Open ${name}`
                  : `${name} is not open in this workspace; switch workspaces to open it`;
              return (
                  <li
                    key={name}
                    className={`workspace-callback-item ${status.tone}${activeScope === "global" && !inCurrentWorkspace ? " inherited" : ""}`}
                    data-workspace-presence={activeScope === "global"
                      ? inCurrentWorkspace ? "current" : "other"
                      : inCurrentWorkspace ? "current" : "other"}
                  >
                  <span className="workspace-callback-index" aria-hidden="true">{index + 1}</span>
                  <span className={`workspace-callback-status-dot ${status.tone}`} aria-hidden="true" />
                  <button
                    type="button"
                    className="workspace-callback-session"
                    aria-current={name === activeSessionName ? "true" : undefined}
                    onClick={() => onSelectSession(name)}
                    disabled={!canOpen}
                    title={sessionTitle}
                  >
                    <strong>{sessionDisplayName(session, name)}</strong>
                    <span className="workspace-callback-session-details">
                      <small>{locationLabel}</small>
                      {name === activeSessionName && (
                        <span className="workspace-callback-current-session">Current session</span>
                      )}
                    </span>
                  </button>
                  <span className={`workspace-callback-status ${status.tone}`}>{status.label}</span>
                  <button
                    type="button"
                    className="workspace-callback-open"
                    disabled={!canOpen}
                    onClick={() => canOpen && onSelectSession(name)}
                    aria-label={`Open ${name}`}
                    title={sessionTitle}
                  >
                    <TerminalIcon />
                  </button>
                  <button
                    type="button"
                    className="workspace-callback-remove"
                    disabled={isBusy || !canRemove}
                    onClick={() => {
                      if ((activeScope === "global" || messages.length > 0) && onReviewSession) {
                        void reviewSession(name);
                      } else {
                        removeSession(name);
                      }
                    }}
                    aria-label={removeLabel}
                    title={canRemove
                      ? activeScope === "global" && onReviewSession
                        ? "Mark reviewed and remove it from every callback scope"
                        : activeScope === "global" && !globalOnly
                          ? "Remove this workspace-owned entry from its current workspace"
                          : activeScope === "global"
                            ? sources.length > 0
                              ? "Remove the global marker; workspace-owned entries remain"
                              : "Remove this global callback entry"
                            : "Mark reviewed and remove"
                      : "This entry is owned by another workspace; remove it there"}
                  >
                    <CheckIcon />
                  </button>
                  {messages.length > 0 && (
                    <div className="workspace-callback-messages" aria-label={`Messages for ${name}`}>
                      {messages.map((message) => (
                        <article className="workspace-callback-message" key={message.id}>
                          <div className="workspace-callback-message-meta">
                            <strong>{message.agentType}</strong>
                            <time dateTime={new Date(message.createdAt * 1000).toISOString()}>
                              {new Date(message.createdAt * 1000).toLocaleString()}
                            </time>
                            <button
                              type="button"
                              className="workspace-callback-message-review"
                              disabled={isBusy || !onReviewMessage}
                              onClick={() => void reviewMessage(message.id)}
                              aria-label={`Mark message from ${message.agentType} in ${name} reviewed`}
                              title="Mark this message reviewed; keep its history"
                            >
                              <CheckIcon />
                            </button>
                          </div>
                          <div className="workspace-callback-message-cwd" title={message.cwd}>
                            {message.cwd}
                          </div>
                          {message.message.length > 600 ? (
                            <details className="workspace-callback-message-details">
                              <summary>
                                <span className="workspace-callback-message-preview">{message.message.slice(0, 240)}…</span>
                                <span className="workspace-callback-message-expand">Show full message</span>
                              </summary>
                              <p>{message.message}</p>
                            </details>
                          ) : <p>{message.message}</p>}
                          {(message.tmuxSessionId || message.tmuxPaneId || message.host) && (
                            <small className="workspace-callback-message-origin">
                              {[message.host, message.tmuxSessionId, message.tmuxPaneId].filter(Boolean).join(" · ")}
                            </small>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <footer className="workspace-callback-footer">
          <span>{scopeDescription}</span>
          <div>
            {removableUnavailableCount > 0 && (
              <button type="button" disabled={isBusy} onClick={() => void clearCallbacks(
                visibleCallbackSessions.filter((name) => !sessionMap.has(name)),
              )}>
                <TrashIcon />
                <span>Clear ended</span>
              </button>
            )}
            {(activeScope === "global"
              ? explicitGlobalSessions.length > 0 || visibleMessages.length > 0
              : visibleCallbackSessions.length > 0) && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void clearCallbacks(visibleCallbackSessions)}
                title={activeScope === "global"
                  ? "Review pending messages and remove global markers; workspace markers remain"
                  : "Review these messages and remove this workspace's callback markers"}
              >
                {activeScope === "global" ? "Clear global" : "Clear all"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </section>
  ) : null;

  const summaryLabel = `${readyCount}/${visibleCallbackSessions.length} ready`;
  const summaryDescription = `${readyCount} ready out of ${visibleCallbackSessions.length} sessions; ${workingCount} working${visibleMessages.length > 0 ? `; ${visibleMessages.length} messages` : ""}`;
  return (
    <>
      <button
        type="button"
        className={`workspace-callback-card${panel.open ? " window-open" : ""}${panel.pinned ? " window-pinned" : ""}${workingCount > 0 ? " has-working" : ""}`}
        aria-label={panel.open ? "Hide callback list" : "Show callback list"}
        aria-description={summaryDescription}
        aria-expanded={panel.open}
        aria-controls={panelId}
        data-scope={activeScope}
        aria-keyshortcuts={directShortcutAria(shortcutBindings["workspace-callback"])}
        title={`${summaryDescription}. Keep sessions here for a later callback${directShortcutLabel(
          shortcutBindings["workspace-callback"],
        ) ? ` (${directShortcutLabel(shortcutBindings["workspace-callback"])})` : ""}`}
        onClick={() => {
          if (!panel.open && activeScope === "global") onGlobalRefresh?.();
          updatePanel((current) => (
            current.open
              ? { ...current, open: false, pinned: false }
              : { ...current, open: true }
          ));
        }}
      >
        <HistoryIcon />
        <span>
          <strong>{activeScope === "global" ? "Global callback" : "Callback"}</strong>
          <small>{summaryLabel}</small>
        </span>
        {(panel.open || panel.pinned) && <em aria-hidden="true">{panel.pinned ? "PIN" : "OPEN"}</em>}
      </button>
      {floatingPanel && createPortal(floatingPanel, document.body)}
    </>
  );
}
