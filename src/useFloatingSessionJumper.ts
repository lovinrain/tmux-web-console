import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const SESSION_JUMPER_GEOMETRY_PREFIX = "muxdeck.session-jumper.v1:";
const MARGIN = 12;

export interface SessionJumperGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function viewport() {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

export function clampSessionJumperGeometry(value: SessionJumperGeometry): SessionJumperGeometry {
  const view = viewport();
  const maxWidth = Math.max(1, view.width - MARGIN * 2);
  const maxHeight = Math.max(1, view.height - MARGIN * 2);
  const width = Math.round(Math.min(maxWidth, Math.max(Math.min(360, maxWidth), value.width)));
  const height = Math.round(Math.min(maxHeight, Math.max(Math.min(300, maxHeight), value.height)));
  return {
    width,
    height,
    x: Math.round(Math.max(MARGIN, Math.min(value.x, view.width - width - MARGIN))),
    y: Math.round(Math.max(MARGIN, Math.min(value.y, view.height - height - MARGIN))),
  };
}

function defaultGeometry(): SessionJumperGeometry {
  const view = viewport();
  return clampSessionJumperGeometry({ x: view.width - 468, y: 72, width: 440, height: 480 });
}

function readGeometry(storageKey: string): SessionJumperGeometry {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null") as SessionJumperGeometry | null;
    if (value && ["x", "y", "width", "height"].every((key) => (
      typeof value[key as keyof SessionJumperGeometry] === "number"
      && Number.isFinite(value[key as keyof SessionJumperGeometry])
    ))) return clampSessionJumperGeometry(value);
  } catch { /* Keep the jumper usable when storage is unavailable or malformed. */ }
  return defaultGeometry();
}

/** The picker is keyed by workspace, so geometry remains local to that scope. */
export function useFloatingSessionJumper(workspaceKey: string, floating: boolean) {
  const storageKey = SESSION_JUMPER_GEOMETRY_PREFIX + workspaceKey;
  const [geometry, setGeometry] = useState(() => readGeometry(storageKey));
  const interactionCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!floating) return;
    try { localStorage.setItem(storageKey, JSON.stringify(geometry)); }
    catch { /* Geometry still works in memory. */ }
  }, [floating, geometry, storageKey]);

  useEffect(() => {
    if (!floating) {
      interactionCleanup.current?.();
      return;
    }
    const keepVisible = () => setGeometry((current) => clampSessionJumperGeometry(current));
    window.addEventListener("resize", keepVisible);
    window.visualViewport?.addEventListener?.("resize", keepVisible);
    keepVisible();
    return () => {
      window.removeEventListener("resize", keepVisible);
      window.visualViewport?.removeEventListener?.("resize", keepVisible);
      interactionCleanup.current?.();
    };
  }, [floating]);

  const startInteraction = (event: PointerEvent<HTMLElement>, resizing: boolean) => {
    if (!floating || event.button !== 0
      || (!resizing && (event.target as HTMLElement).closest("button, input, a"))) return;
    event.preventDefault();
    event.stopPropagation();
    interactionCleanup.current?.();
    const start = { ...geometry, clientX: event.clientX, clientY: event.clientY };
    const pointerId = event.pointerId;
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      const dx = next.clientX - start.clientX;
      const dy = next.clientY - start.clientY;
      setGeometry(clampSessionJumperGeometry(resizing
        ? { ...start, width: start.width + dx, height: start.height + dy }
        : { ...start, x: start.x + dx, y: start.y + dy }));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("session-jumper-window-moving");
      if (interactionCleanup.current === cleanup) interactionCleanup.current = null;
    };
    const finish = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) cleanup();
    };
    interactionCleanup.current = cleanup;
    document.documentElement.classList.add("session-jumper-window-moving");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const adjustWithKeyboard = (event: KeyboardEvent<HTMLElement>, resizing: boolean) => {
    if (!floating || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      setGeometry(defaultGeometry());
      return;
    }
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? 64 : 16;
    setGeometry((current) => clampSessionJumperGeometry(resizing
      ? { ...current, width: current.width + direction[0] * distance, height: current.height + direction[1] * distance }
      : { ...current, x: current.x + direction[0] * distance, y: current.y + direction[1] * distance }));
  };

  return {
    geometry,
    move: (event: PointerEvent<HTMLElement>) => startInteraction(event, false),
    resize: (event: PointerEvent<HTMLElement>) => startInteraction(event, true),
    moveWithKeyboard: (event: KeyboardEvent<HTMLElement>) => adjustWithKeyboard(event, false),
    resizeWithKeyboard: (event: KeyboardEvent<HTMLElement>) => adjustWithKeyboard(event, true),
  };
}
