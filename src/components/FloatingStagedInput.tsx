import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { CloseIcon, ExpandIcon, KeyboardIcon, PinIcon, TrashIcon } from "../icons";
import { MAX_DRAFT_LENGTH } from "./InputBar";

const DESKTOP_FLOATING_INPUT_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const FLOATING_INPUT_WIDTH = 440;
const FLOATING_INPUT_ESTIMATED_HEIGHT = 250;
const FLOATING_INPUT_MARGIN = 12;
const FLOATING_INPUT_MOVE_STEP = 12;
const FLOATING_INPUT_MOVE_LARGE_STEP = 32;

export const FLOATING_STAGED_INPUT_STORAGE_PREFIX = "muxdeck.floating-staged-input.v1:";

interface FloatingInputPosition {
  x: number;
  y: number;
}

interface FloatingInputPanelState {
  open: boolean;
  pinned: boolean;
  position: FloatingInputPosition;
}

interface FloatingInputStore {
  identity: string;
  panel: FloatingInputPanelState;
}

interface PersistedFloatingInput {
  version: 1;
  panel: FloatingInputPanelState;
}

export interface FloatingStagedInputPanelState {
  open: boolean;
  pinned: boolean;
}

export interface FloatingStagedInputHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

interface FloatingStagedInputProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  value: string;
  onChange: (value: string) => boolean;
  onOpenFullInput: () => void;
  onPanelStateChange?: (state: FloatingStagedInputPanelState) => void;
}

function floatingInputViewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function defaultFloatingInputPosition(): FloatingInputPosition {
  const viewport = floatingInputViewport();
  return {
    x: Math.max(
      FLOATING_INPUT_MARGIN,
      viewport.width - FLOATING_INPUT_WIDTH - 28,
    ),
    y: Math.max(
      FLOATING_INPUT_MARGIN,
      Math.min(92, viewport.height - FLOATING_INPUT_MARGIN),
    ),
  };
}

function clampFloatingInputPosition(
  position: FloatingInputPosition,
  element?: HTMLElement | null,
): FloatingInputPosition {
  const viewport = floatingInputViewport();
  const rect = element?.getBoundingClientRect();
  const width = rect?.width || FLOATING_INPUT_WIDTH;
  const height = rect?.height || FLOATING_INPUT_ESTIMATED_HEIGHT;
  return {
    x: Math.round(Math.min(
      Math.max(FLOATING_INPUT_MARGIN, position.x),
      Math.max(FLOATING_INPUT_MARGIN, viewport.width - width - FLOATING_INPUT_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(FLOATING_INPUT_MARGIN, position.y),
      Math.max(FLOATING_INPUT_MARGIN, viewport.height - height - FLOATING_INPUT_MARGIN),
    )),
  };
}

function defaultPanelState(): FloatingInputPanelState {
  return {
    open: false,
    pinned: false,
    position: defaultFloatingInputPosition(),
  };
}

function normalizePanelState(value: unknown): FloatingInputPanelState {
  const fallback = defaultPanelState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<FloatingInputPanelState>;
  const rawPosition = candidate.position as Partial<FloatingInputPosition> | undefined;
  const position = rawPosition
    && Number.isFinite(rawPosition.x)
    && Number.isFinite(rawPosition.y)
    ? clampFloatingInputPosition({ x: Number(rawPosition.x), y: Number(rawPosition.y) })
    : fallback.position;
  const pinned = candidate.pinned === true;
  return {
    open: pinned || candidate.open === true,
    pinned,
    position,
  };
}

function readWorkspacePanel(identity: string): FloatingInputPanelState {
  try {
    const raw = window.localStorage.getItem(
      `${FLOATING_STAGED_INPUT_STORAGE_PREFIX}${identity}`,
    );
    if (!raw) return defaultPanelState();
    const parsed = JSON.parse(raw) as Partial<PersistedFloatingInput>;
    return normalizePanelState(parsed.panel);
  } catch {
    return defaultPanelState();
  }
}

function writeWorkspacePanel(identity: string, panel: FloatingInputPanelState): void {
  try {
    const persisted: PersistedFloatingInput = { version: 1, panel };
    window.localStorage.setItem(
      `${FLOATING_STAGED_INPUT_STORAGE_PREFIX}${identity}`,
      JSON.stringify(persisted),
    );
  } catch {
    // The panel remains usable in memory when browser storage is unavailable.
  }
}

function desktopFloatingInputViewport(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(DESKTOP_FLOATING_INPUT_QUERY).matches;
  }
  const viewport = floatingInputViewport();
  return viewport.width > 640 && viewport.height > 500;
}

function useDesktopFloatingInput(): boolean {
  const [desktop, setDesktop] = useState(desktopFloatingInputViewport);

  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_FLOATING_INPUT_QUERY);
    const viewport = window.visualViewport;
    const update = () => setDesktop(desktopFloatingInputViewport());
    update();
    query?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    viewport?.addEventListener?.("resize", update);
    return () => {
      query?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener?.("resize", update);
    };
  }, []);

  return desktop;
}

export const FloatingStagedInput = forwardRef<
  FloatingStagedInputHandle,
  FloatingStagedInputProps
>(function FloatingStagedInput({
  sessionName,
  workspaceId = null,
  workspaceName = null,
  value,
  onChange,
  onOpenFullInput,
  onPanelStateChange,
}, ref) {
  const desktop = useDesktopFloatingInput();
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const focusAfterOpenRef = useRef(false);
  const storageIdentity = workspaceId ? `workspace:${workspaceId}` : null;
  const renderIdentity = storageIdentity ?? "temporary-workspace";
  const initialStoreRef = useRef<FloatingInputStore | null>(null);
  if (initialStoreRef.current === null) {
    initialStoreRef.current = {
      identity: renderIdentity,
      panel: storageIdentity ? readWorkspacePanel(storageIdentity) : defaultPanelState(),
    };
  }
  const [store, setStore] = useState<FloatingInputStore>(initialStoreRef.current);
  const [draftRejected, setDraftRejected] = useState(false);
  const previousSessionRef = useRef({ identity: renderIdentity, sessionName });

  useEffect(() => {
    if (store.identity === renderIdentity) return;
    setStore({
      identity: renderIdentity,
      panel: storageIdentity ? readWorkspacePanel(storageIdentity) : defaultPanelState(),
    });
  }, [renderIdentity, storageIdentity, store.identity]);

  useEffect(() => {
    if (!storageIdentity || store.identity !== renderIdentity) return;
    writeWorkspacePanel(storageIdentity, store.panel);
  }, [renderIdentity, storageIdentity, store]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (
      previous.identity === renderIdentity
      && previous.sessionName !== sessionName
    ) {
      setStore((current) => {
        if (
          current.identity !== renderIdentity
          || !current.panel.open
          || current.panel.pinned
        ) return current;
        return {
          ...current,
          panel: { ...current.panel, open: false },
        };
      });
    }
    setDraftRejected(false);
    previousSessionRef.current = { identity: renderIdentity, sessionName };
  }, [renderIdentity, sessionName]);

  const active = store.identity === renderIdentity;
  const panel = active ? store.panel : defaultPanelState();

  const updatePanel = useCallback((
    updater: (current: FloatingInputPanelState) => FloatingInputPanelState,
  ) => {
    setStore((current) => current.identity === renderIdentity
      ? { ...current, panel: updater(current.panel) }
      : current);
  }, [renderIdentity]);

  const closePanel = useCallback(() => {
    focusAfterOpenRef.current = false;
    updatePanel((current) => ({ ...current, open: false, pinned: false }));
  }, [updatePanel]);

  const openPanel = useCallback(() => {
    focusAfterOpenRef.current = true;
    updatePanel((current) => ({ ...current, open: true }));
  }, [updatePanel]);

  const togglePanel = useCallback(() => {
    updatePanel((current) => {
      if (current.open) {
        focusAfterOpenRef.current = false;
        return { ...current, open: false, pinned: false };
      }
      focusAfterOpenRef.current = true;
      return { ...current, open: true };
    });
  }, [updatePanel]);

  useImperativeHandle(ref, () => ({
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
  }), [closePanel, openPanel, togglePanel]);

  useEffect(() => {
    onPanelStateChange?.({ open: panel.open, pinned: panel.pinned });
  }, [onPanelStateChange, panel.open, panel.pinned]);

  useEffect(() => {
    if (!active || !desktop || !panel.open || !focusAfterOpenRef.current) return;
    focusAfterOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, desktop, panel.open, value.length]);

  useEffect(() => {
    if (!active || !panel.open) return;
    const keepVisible = () => {
      updatePanel((current) => {
        const position = clampFloatingInputPosition(
          current.position,
          panelRef.current,
        );
        if (
          position.x === current.position.x
          && position.y === current.position.y
        ) return current;
        return { ...current, position };
      });
    };
    const viewport = window.visualViewport;
    window.addEventListener("resize", keepVisible);
    viewport?.addEventListener?.("resize", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      viewport?.removeEventListener?.("resize", keepVisible);
    };
  }, [active, panel.open, updatePanel]);

  useEffect(() => () => {
    interactionCleanupRef.current?.();
    document.documentElement.classList.remove("floating-staged-input-moving");
  }, []);

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button, textarea, a")) return;
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
      document.documentElement.classList.remove("floating-staged-input-moving");
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const position = clampFloatingInputPosition({
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY,
      }, panelRef.current);
      updatePanel((current) => ({ ...current, position }));
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };

    interactionCleanupRef.current = cleanup;
    document.documentElement.classList.add("floating-staged-input-moving");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [panel.position.x, panel.position.y, updatePanel]);

  const moveWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey
      ? FLOATING_INPUT_MOVE_LARGE_STEP
      : FLOATING_INPUT_MOVE_STEP;
    updatePanel((current) => ({
      ...current,
      position: clampFloatingInputPosition({
        x: current.position.x + direction[0] * distance,
        y: current.position.y + direction[1] * distance,
      }, panelRef.current),
    }));
  }, [updatePanel]);

  if (!desktop || !active || !panel.open) return null;

  const panelStyle: CSSProperties = {
    left: panel.position.x,
    top: panel.position.y,
  };
  const floatingPanel = (
    <section
      id="muxdeck-floating-staged-input"
      ref={panelRef}
      className={`floating-staged-input-panel${panel.pinned ? " pinned" : ""}`}
      style={panelStyle}
      role="dialog"
      aria-labelledby={headingId}
      data-pinned={panel.pinned ? "true" : "false"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePanel();
        }
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header
        className="floating-staged-input-header"
        tabIndex={0}
        aria-label="Move floating staged input window"
        title="Drag this title strip to move the input. Arrow keys also move it."
        onPointerDown={startDragging}
        onKeyDown={moveWithKeyboard}
      >
        <KeyboardIcon />
        <div>
          <span>{workspaceName?.trim() || "Workspace"} / {sessionName}</span>
          <h2 id={headingId}>Floating staged input</h2>
        </div>
        {panel.pinned && <em aria-hidden="true">PINNED</em>}
        <button
          type="button"
          aria-label={panel.pinned
            ? "Unpin floating staged input"
            : "Pin floating staged input"}
          aria-pressed={panel.pinned}
          title={panel.pinned
            ? "Close this input when you switch sessions"
            : "Keep this input open and follow the active session"}
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
          aria-label="Close floating staged input"
          onClick={closePanel}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="floating-staged-input-body">
        <textarea
          ref={textareaRef}
          value={value}
          maxLength={MAX_DRAFT_LENGTH}
          rows={6}
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Floating staged input"
          placeholder="Type here while the terminal remains in Focus..."
          onChange={(event) => {
            const accepted = onChange(event.currentTarget.value);
            setDraftRejected(!accepted);
          }}
        />
        <div className="floating-staged-input-meta" role="status" aria-live="polite">
          <span>{draftRejected
            ? "The staged draft is busy; your last edit was not applied."
            : "Mirrors this session's saved staged draft."}</span>
          <span>{value.length.toLocaleString()} / {MAX_DRAFT_LENGTH.toLocaleString()}</span>
        </div>
        <div className="floating-staged-input-actions">
          <button
            type="button"
            className="floating-staged-input-clear"
            disabled={!value}
            onClick={() => {
              if (!window.confirm("Discard this staged input?")) return;
              const accepted = onChange("");
              setDraftRejected(!accepted);
              if (accepted) window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          >
            <TrashIcon />
            <span>Clear</span>
          </button>
          <button
            type="button"
            className="floating-staged-input-open-full"
            onClick={() => {
              closePanel();
              onOpenFullInput();
            }}
          >
            <ExpandIcon />
            <span>Open full input</span>
          </button>
        </div>
      </div>
    </section>
  );

  return createPortal(floatingPanel, document.body);
});
