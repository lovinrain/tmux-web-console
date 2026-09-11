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
import type { AgentState, Session } from "../types";
import {
  directShortcutAria,
  directShortcutLabel,
  useShortcutSettings,
} from "../shortcutSettings";

const DESKTOP_CALLBACK_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const CALLBACK_STORAGE_PREFIX = "muxdeck.workspace-callback-panel.v1:";
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
  workspaceId?: string | null;
  workspaceName?: string | null;
  temporaryKey?: string;
  sessions: readonly Session[];
  callbackSessions: readonly string[];
  onChange: (sessions: string[]) => Promise<void>;
  onSelectSession: (sessionName: string) => void;
}

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

export function WorkspaceCallbackList({
  sessionName,
  workspaceId = null,
  workspaceName = null,
  temporaryKey = "default",
  sessions,
  callbackSessions,
  onChange,
  onSelectSession,
}: WorkspaceCallbackListProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const [desktop, setDesktop] = useState(desktopCallbackViewport);
  const headingId = useId();
  const panelId = `${headingId}-panel`;
  const panelRef = useRef<HTMLElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const identity = workspaceId ? `workspace:${workspaceId}` : `temporary:${temporaryKey}`;
  const initialStoreRef = useRef<CallbackPanelStore | null>(null);
  if (initialStoreRef.current === null) {
    initialStoreRef.current = { identity, panel: readPreference(identity) };
  }
  const [store, setStore] = useState<CallbackPanelStore>(initialStoreRef.current);
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (
      previous.identity === identity
      && previous.sessionName !== sessionName
      && !panel.pinned
      && panel.open
    ) {
      setStore((current) => current.identity === identity
        ? { ...current, panel: { ...current.panel, open: false, pinned: false } }
        : current);
    }
    previousSessionRef.current = { identity, sessionName };
  }, [identity, panel.open, panel.pinned, sessionName]);

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

  const changeCallbacks = useCallback(async (next: readonly string[]) => {
    const unique = [...new Set(next.filter(Boolean))];
    setBusy(true);
    setError("");
    try {
      await onChange(unique);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save callback list");
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const addSession = useCallback((name: string) => {
    if (!name || callbackSessions.includes(name)) return;
    void changeCallbacks([...callbackSessions, name]);
    setSelectedSession("");
  }, [callbackSessions, changeCallbacks]);

  const removeSession = useCallback((name: string) => {
    void changeCallbacks(callbackSessions.filter((item) => item !== name));
  }, [callbackSessions, changeCallbacks]);

  const clearUnavailable = useCallback(() => {
    const liveNames = new Set(sessions.map((item) => item.name));
    void changeCallbacks(callbackSessions.filter((name) => liveNames.has(name)));
  }, [callbackSessions, changeCallbacks, sessions]);

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

  if (!desktop) return null;

  const sessionMap = new Map(sessions.map((item) => [item.name, item]));
  const availableSessions = sessions.filter((item) => !callbackSessions.includes(item.name));
  const workingCount = callbackSessions.filter((name) => callbackStatus(sessionMap.get(name)).working).length;
  const unavailableCount = callbackSessions.filter((name) => !sessionMap.has(name)).length;
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
          <span>{workspaceName?.trim() || "Workspace"}</span>
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
          <strong>{callbackSessions.length} watching</strong>
          <span>{workingCount} working</span>
          {unavailableCount > 0 && <span className="ended">{unavailableCount} ended</span>}
        </div>
        <div className="workspace-callback-add" role="group" aria-label="Add a session to the callback list">
          <select
            aria-label="Choose a session to watch"
            value={selectedSession}
            disabled={busy || availableSessions.length === 0}
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
            disabled={busy || !selectedSession}
            onClick={() => addSession(selectedSession)}
          >
            <PlusIcon />
            <span>Add</span>
          </button>
          <button
            type="button"
            disabled={busy || callbackSessions.includes(sessionName)}
            onClick={() => addSession(sessionName)}
            title={callbackSessions.includes(sessionName)
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
        {callbackSessions.length === 0 ? (
          <div className="workspace-callback-empty">
            <HistoryIcon />
            <strong>Nothing queued for a callback</strong>
            <span>Add sessions here before you step away. Their live status stays visible.</span>
          </div>
        ) : (
          <ol className="workspace-callback-list" aria-label="Sessions to call back">
            {callbackSessions.map((name, index) => {
              const session = sessionMap.get(name);
              const status = callbackStatus(session);
              return (
                <li key={name} className={`workspace-callback-item ${status.tone}`}>
                  <span className="workspace-callback-index" aria-hidden="true">{index + 1}</span>
                  <span className={`workspace-callback-status-dot ${status.tone}`} aria-hidden="true" />
                  <button
                    type="button"
                    className="workspace-callback-session"
                    onClick={() => onSelectSession(name)}
                    disabled={!session}
                    title={session ? `Open ${name}` : `${name} is no longer live`}
                  >
                    <strong>{sessionDisplayName(session, name)}</strong>
                    <small>{session && session.customTitle ? name : status.label}</small>
                  </button>
                  <span className={`workspace-callback-status ${status.tone}`}>{status.label}</span>
                  <button
                    type="button"
                    className="workspace-callback-open"
                    disabled={!session}
                    onClick={() => session && onSelectSession(name)}
                    aria-label={`Open ${name}`}
                    title={session ? "Open this session" : "Session is unavailable"}
                  >
                    <TerminalIcon />
                  </button>
                  <button
                    type="button"
                    className="workspace-callback-remove"
                    disabled={busy}
                    onClick={() => removeSession(name)}
                    aria-label={`Mark ${name} reviewed and remove from callback list`}
                    title="Mark reviewed and remove"
                  >
                    <CheckIcon />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <footer className="workspace-callback-footer">
          <span>{workspaceId ? "Saved with this workspace" : "Temporary workspace; saved in this browser"}</span>
          <div>
            {unavailableCount > 0 && (
              <button type="button" disabled={busy} onClick={clearUnavailable}>
                <TrashIcon />
                <span>Clear ended</span>
              </button>
            )}
            {callbackSessions.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void changeCallbacks([])}
                title="Remove every session from the callback list"
              >
                Clear all
              </button>
            )}
          </div>
        </footer>
      </div>
    </section>
  ) : null;

  const summaryLabel = callbackSessions.length === 0
    ? "No sessions"
    : `${callbackSessions.length} ${callbackSessions.length === 1 ? "session" : "sessions"}`;
  return (
    <>
      <button
        type="button"
        className={`workspace-callback-card${panel.open ? " window-open" : ""}${panel.pinned ? " window-pinned" : ""}${workingCount > 0 ? " has-working" : ""}`}
        aria-label={panel.open ? "Hide callback list" : "Show callback list"}
        aria-expanded={panel.open}
        aria-controls={panelId}
        aria-keyshortcuts={directShortcutAria(shortcutBindings["workspace-callback"])}
        title={`Keep sessions here for a later callback${directShortcutLabel(
          shortcutBindings["workspace-callback"],
        ) ? ` (${directShortcutLabel(shortcutBindings["workspace-callback"])})` : ""}`}
        onClick={() => updatePanel((current) => (
          current.open
            ? { ...current, open: false, pinned: false }
            : { ...current, open: true }
        ))}
      >
        <HistoryIcon />
        <span>
          <strong>Callback</strong>
          <small>{summaryLabel}{workingCount > 0 ? ` / ${workingCount} working` : ""}</small>
        </span>
        {(panel.open || panel.pinned) && <em aria-hidden="true">{panel.pinned ? "PIN" : "OPEN"}</em>}
      </button>
      {floatingPanel && createPortal(floatingPanel, document.body)}
    </>
  );
}
