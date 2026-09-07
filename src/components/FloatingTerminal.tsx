import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { openUtilityTerminal, terminateSession, type UtilityTerminalSession } from "../api";
import { CloseIcon, PinIcon, TerminalIcon } from "../icons";
import type { ConnectionState } from "../types";
import type { TerminalThemeMode } from "../terminalTheme";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import { FLOATING_TERMINAL_STORAGE_PREFIX } from "../floatingTerminalState";
import "./FloatingTerminal.css";

export { FLOATING_TERMINAL_STORAGE_PREFIX } from "../floatingTerminalState";
interface Geometry { x: number; y: number; width: number; height: number }
interface PanelState extends Geometry { open: boolean; pinned: boolean }
export interface FloatingTerminalHandle { toggle: () => void }
interface Props {
  workspaceKey: string;
  workspaceName?: string | null;
  sessionName: string;
  sessionId?: string;
  enabled: boolean;
  theme: TerminalThemeMode;
  onOpenChange: (open: boolean) => void;
}

function clampGeometry(value: Geometry): Geometry {
  const width = Math.min(Math.max(320, value.width), Math.max(240, window.innerWidth - 16));
  const height = Math.min(Math.max(180, value.height), Math.max(140, window.innerHeight - 16));
  return {
    width, height,
    x: Math.max(8, Math.min(value.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(value.y, window.innerHeight - height - 8)),
  };
}

function readPanel(key: string): PanelState {
  const fallback = { ...clampGeometry({ x: key.startsWith("session:") ? 160 : 120, y: key.startsWith("session:") ? 140 : 100, width: 680, height: 380 }), open: false, pinned: false };
  try {
    const storage = key.startsWith("temporary:") ? sessionStorage : localStorage;
    const value = JSON.parse(storage.getItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}${key}`) || "null");
    if (!value || ![value.x, value.y, value.width, value.height].every((v) => typeof v === "number" && Number.isFinite(v))) return fallback;
    return { ...clampGeometry(value), open: value.open === true, pinned: value.pinned === true };
  } catch {
    return fallback;
  }
}

export const FloatingTerminal = forwardRef<FloatingTerminalHandle, Props>(function FloatingTerminal({
  workspaceKey, workspaceName, sessionName, sessionId, enabled, theme, onOpenChange,
}, ref) {
  const sessionScoped = workspaceKey.startsWith("session:");
  const panelId = sessionScoped ? "muxdeck-session-terminal" : "muxdeck-floating-terminal";
  const [panel, setPanel] = useState(() => readPanel(workspaceKey));
  const [terminal, setTerminal] = useState<UtilityTerminalSession | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [request, setRequest] = useState({ revision: 0, create: false });
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const panelRef = useRef<HTMLElement>(null);
  const cleanupInteraction = useRef<(() => void) | null>(null);
  const sourceRef = useRef({ sessionName, sessionId });
  sourceRef.current = { sessionName, sessionId };
  const previousSession = useRef(sessionName);
  const visible = enabled && panel.open;
  const sourceReady = Boolean(sessionId);

  const hide = useCallback(() => {
    cleanupInteraction.current?.();
    setRequest((current) => ({ ...current, create: false }));
    setPanel((current) => ({ ...current, open: false }));
  }, []);

  useEffect(() => {
    if (!enabled) setRequest((current) => current.create ? { ...current, create: false } : current);
  }, [enabled]);

  useImperativeHandle(ref, () => ({
    toggle: () => {
      if (!enabled) return;
      if (panel.open) hide();
      else {
        setRequest((current) => ({ revision: current.revision + 1, create: true }));
        setPanel((current) => ({ ...current, open: true }));
      }
    },
  }), [enabled, hide, panel.open]);

  useEffect(() => {
    onOpenChange(visible);
  }, [onOpenChange, visible]);

  useEffect(() => {
    try {
      const storage = workspaceKey.startsWith("temporary:") ? sessionStorage : localStorage;
      storage.setItem(`${FLOATING_TERMINAL_STORAGE_PREFIX}${workspaceKey}`, JSON.stringify(panel));
    } catch { /* Private browsing can disable layout persistence. */ }
  }, [panel, workspaceKey, sessionScoped]);

  useEffect(() => {
    if (previousSession.current !== sessionName && !panel.pinned && !sessionScoped) hide();
    previousSession.current = sessionName;
  }, [hide, panel.pinned, sessionName, sessionScoped]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const source = sourceRef.current;
    setTerminal(null);
    setError(null);
    setBusy(true);
    if (!source.sessionId) {
      setBusy(false);
      setError("Wait for the active session to load, then retry.");
      return;
    }
    void openUtilityTerminal(workspaceKey, source.sessionName, source.sessionId, request.create, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setTerminal(result.terminal);
          setConnection("connecting");
        }
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to open utility terminal");
      }).finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [request, sourceReady, visible, workspaceKey]);

  useEffect(() => {
    const resize = () => setPanel((current) => ({ ...current, ...clampGeometry(current) }));
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cleanupInteraction.current?.();
    };
  }, []);

  const onPaneChange = useCallback(() => {}, []);
  const onConnection = useCallback((state: ConnectionState) => {
    setConnection(state);
    if (state === "live") terminalRef.current?.focus();
  }, []);

  const interact = (event: ReactPointerEvent<HTMLElement>, edge: string) => {
    if (event.button !== 0 || (edge === "move" && (event.target as HTMLElement).closest("button"))) return;
    event.preventDefault();
    cleanupInteraction.current?.();
    const start = { clientX: event.clientX, clientY: event.clientY, ...panel };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const dx = next.clientX - start.clientX;
      const dy = next.clientY - start.clientY;
      let geometry: Geometry = start;
      if (edge === "move") geometry = { ...start, x: start.x + dx, y: start.y + dy };
      else {
        const left = edge.includes("w") ? Math.max(8, Math.min(start.x + dx, start.x + start.width - 320)) : start.x;
        const top = edge.includes("n") ? Math.max(8, Math.min(start.y + dy, start.y + start.height - 180)) : start.y;
        const right = edge.includes("e") ? Math.max(start.x + 320, start.x + start.width + dx) : start.x + start.width;
        const bottom = edge.includes("s") ? Math.max(start.y + 180, start.y + start.height + dy) : start.y + start.height;
        geometry = { x: left, y: top, width: right - left, height: bottom - top };
      }
      setPanel((current) => ({ ...current, ...clampGeometry(geometry) }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      cleanupInteraction.current = null;
    };
    cleanupInteraction.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  };

  if (!visible) return null;
  const identity = terminal ? `${terminal.id}:${terminal.created}:${terminal.serverStarted}:${terminal.serverPid}` : undefined;
  const directory = terminal?.panes.find((pane) => pane.id === terminal.activePaneId)?.path;
  const retry = (create: boolean) => setRequest((current) => ({ revision: current.revision + 1, create }));

  return createPortal(<>
    <section
      ref={panelRef}
      id={panelId}
      className="floating-terminal-panel"
      role="dialog"
      aria-modal="false"
      aria-label={sessionScoped ? "Session terminal" : "Utility terminal"}
      data-pinned={panel.pinned}
      onPointerDownCapture={() => {
        document.querySelectorAll<HTMLElement>(".floating-terminal-panel").forEach((element) => {
          element.style.zIndex = element === panelRef.current ? "40" : "39";
        });
      }}
      style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height }}
    >
      <header
        className="floating-terminal-title"
        tabIndex={0}
        aria-label="Move utility terminal"
        title="Drag to move; arrow keys move, Shift+arrow keys resize"
        onPointerDown={(event) => interact(event, "move")}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) return;
          event.preventDefault();
          const dx = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
          const dy = event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
          setPanel((current) => ({ ...current, ...clampGeometry(event.shiftKey
            ? { ...current, width: current.width + dx, height: current.height + dy }
            : { ...current, x: current.x + dx, y: current.y + dy }) }));
        }}
      >
        <TerminalIcon />
        <strong>{sessionScoped ? "Session Terminal" : "Workspace Terminal"}</strong>
        <span className="floating-terminal-workspace">{sessionScoped ? sessionName : workspaceName || "Temporary workspace"}</span>
        {!sessionScoped && <button type="button" aria-label={panel.pinned ? "Unpin utility terminal" : "Pin utility terminal"}
          aria-pressed={panel.pinned} title="Keep this shell visible when switching session tabs"
          onClick={() => setPanel((current) => ({ ...current, pinned: !current.pinned }))}><PinIcon /></button>}
        <button type="button" aria-label="Hide utility terminal" title="Hide window; keep shell running" onClick={hide}><CloseIcon /></button>
      </header>
      <div className="floating-terminal-info">
        <span title={sessionScoped ? "Ends automatically when its parent session ends" : "Independent shell; does not send input to your coding agent"}>{directory || (sessionScoped ? "Independent session shell" : "Independent workspace shell")}</span>
        <span role="status">{busy ? "Opening..." : terminal ? connection : "No shell"}</span>
      </div>
      <div className="floating-terminal-body">
        {terminal && <LiveTerminal
          key={identity}
          ref={terminalRef}
          elementId={sessionScoped ? "muxdeck-session-utility-console" : "muxdeck-utility-console"}
          session={terminal.name}
          identity={identity}
          ignoreSize={false}
          theme={theme}
          onStateChange={onConnection}
          onPaneChange={onPaneChange}
        />}
        {!terminal && <div className="floating-terminal-empty">
          {error ? <p role="alert">{error}</p> : <p>{busy ? "Connecting to your shell..." : "No running utility shell. Start one in the active session's directory."}</p>}
          {!busy && <button type="button" onClick={() => retry(true)}>{error ? "Retry / start shell" : "Start shell"}</button>}
        </div>}
      </div>
      <footer className="floating-terminal-footer">
        <span title={terminal?.name}>{terminal?.name || "Created only when requested"}</span>
        {terminal && <>
          <button type="button" onClick={() => retry(false)} title="Reconnect to this shell without creating another">Reconnect</button>
          <button type="button" onClick={() => terminalRef.current?.redraw()}>Redraw</button>
          <button type="button" onClick={() => setConfirmEnd(true)}>End shell</button>
        </>}
      </footer>
      {["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => <div
        key={edge} className={`floating-terminal-resize edge-${edge}`} data-edge={edge}
        aria-hidden="true" onPointerDown={(event) => interact(event, edge)}
      />)}
    </section>
    {confirmEnd && terminal && <SessionTerminateDialog
      sessionName={terminal.name}
      sessionTitle={sessionScoped ? "Session utility shell" : "Workspace utility shell"}
      onClose={() => setConfirmEnd(false)}
      onTerminate={async () => {
        await terminateSession(terminal.name, terminal.id, terminal.created, terminal.serverStarted, terminal.serverPid);
        setTerminal(null);
        setError(null);
        setConfirmEnd(false);
      }}
    />}
  </>, document.body);
});
