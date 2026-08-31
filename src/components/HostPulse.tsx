import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  getHostMetrics,
  type HostMetricRange,
  type HostMetricsSnapshot,
} from "../api";
import { CloseIcon, HostPulseIcon, PinIcon } from "../icons";

const DESKTOP_HOST_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const HOST_POLL_MS = 5_000;
const PANEL_MARGIN = 12;
const DEFAULT_PANEL_WIDTH = 442;
const DEFAULT_PANEL_HEIGHT = 386;
const MIN_PANEL_WIDTH = 360;
const MIN_PANEL_HEIGHT = 330;
const MOVE_STEP = 12;
const MOVE_LARGE_STEP = 32;
const RESIZE_STEP = 12;
const RESIZE_LARGE_STEP = 32;

export const HOST_PULSE_STORAGE_PREFIX = "muxdeck.host-pulse.v1:";

interface Point {
  x: number;
  y: number;
}

interface PanelSize {
  width: number;
  height: number;
}

type HostPulseMode = "overview" | "details";

interface HostPulsePanelState {
  open: boolean;
  pinned: boolean;
  paused: boolean;
  mode: HostPulseMode;
  range: HostMetricRange;
  position: Point;
  size: PanelSize;
}

interface HostPulseStore {
  identity: string;
  panel: HostPulsePanelState;
}

interface PersistedHostPulse {
  version: 1;
  panel: HostPulsePanelState;
}

interface HostPulseProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

type HostTone = "nominal" | "warm" | "critical" | "unavailable";

function viewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function clampSize(size: PanelSize): PanelSize {
  const current = viewport();
  return {
    width: Math.round(Math.min(
      Math.max(MIN_PANEL_WIDTH, size.width),
      Math.max(MIN_PANEL_WIDTH, current.width - PANEL_MARGIN * 2),
    )),
    height: Math.round(Math.min(
      Math.max(MIN_PANEL_HEIGHT, size.height),
      Math.max(MIN_PANEL_HEIGHT, current.height - PANEL_MARGIN * 2),
    )),
  };
}

function defaultSize(): PanelSize {
  return clampSize({ width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT });
}

function clampPosition(position: Point, size: PanelSize): Point {
  const current = viewport();
  return {
    x: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.x),
      Math.max(PANEL_MARGIN, current.width - size.width - PANEL_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.y),
      Math.max(PANEL_MARGIN, current.height - size.height - PANEL_MARGIN),
    )),
  };
}

function defaultPosition(size: PanelSize): Point {
  const current = viewport();
  return clampPosition({
    x: current.width - size.width - 28,
    y: Math.min(176, current.height - size.height - PANEL_MARGIN),
  }, size);
}

function defaultPanelState(): HostPulsePanelState {
  const size = defaultSize();
  return {
    open: false,
    pinned: false,
    paused: false,
    mode: "overview",
    range: "15m",
    position: defaultPosition(size),
    size,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePanelState(value: unknown): HostPulsePanelState {
  const fallback = defaultPanelState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<HostPulsePanelState>;
  const rawSize = candidate.size as Partial<PanelSize> | undefined;
  const size = rawSize && finite(rawSize.width) && finite(rawSize.height)
    ? clampSize({ width: rawSize.width, height: rawSize.height })
    : fallback.size;
  const rawPosition = candidate.position as Partial<Point> | undefined;
  const position = rawPosition && finite(rawPosition.x) && finite(rawPosition.y)
    ? clampPosition({ x: rawPosition.x, y: rawPosition.y }, size)
    : defaultPosition(size);
  const pinned = candidate.pinned === true;
  const range: HostMetricRange = candidate.range === "1h" || candidate.range === "24h"
    ? candidate.range
    : "15m";
  return {
    open: pinned || candidate.open === true,
    pinned,
    paused: candidate.paused === true,
    mode: candidate.mode === "details" ? "details" : "overview",
    range,
    position,
    size,
  };
}

function readPanel(identity: string): HostPulsePanelState {
  try {
    const raw = window.localStorage.getItem(`${HOST_PULSE_STORAGE_PREFIX}${identity}`);
    if (!raw) return defaultPanelState();
    const parsed = JSON.parse(raw) as Partial<PersistedHostPulse>;
    return normalizePanelState(parsed.panel);
  } catch {
    return defaultPanelState();
  }
}

function writePanel(identity: string, panel: HostPulsePanelState): void {
  try {
    const value: PersistedHostPulse = { version: 1, panel };
    window.localStorage.setItem(
      `${HOST_PULSE_STORAGE_PREFIX}${identity}`,
      JSON.stringify(value),
    );
  } catch {
    // Live metrics remain usable when browser storage is unavailable.
  }
}

function desktopViewport(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(DESKTOP_HOST_QUERY).matches;
  }
  const current = viewport();
  return current.width > 640 && current.height > 500;
}

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(desktopViewport);
  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_HOST_QUERY);
    const visualViewport = window.visualViewport;
    const update = () => setDesktop(desktopViewport());
    update();
    query?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    visualViewport?.addEventListener?.("resize", update);
    return () => {
      query?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener?.("resize", update);
    };
  }, []);
  return desktop;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "--" : `${Math.round(value)}%`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "--";
  const gibibytes = value / (1024 ** 3);
  if (gibibytes >= 10) return `${gibibytes.toFixed(1)} GB`;
  if (gibibytes >= 0.1) return `${gibibytes.toFixed(1)} GB`;
  return `${Math.round(value / (1024 ** 2))} MB`;
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "--";
  if (value < 1) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

function formatPressure(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  if (value > 0 && value < 0.01) return "<0.01%";
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function snapshotTone(snapshot: HostMetricsSnapshot | null, error: string | null): HostTone {
  if (!snapshot) return error ? "unavailable" : "nominal";
  const memoryPercent = snapshot.latest.memoryTotalBytes > 0
    ? snapshot.latest.memoryUsedBytes / snapshot.latest.memoryTotalBytes * 100
    : 0;
  const cpu = snapshot.latest.cpuPercent ?? 0;
  const pressure = snapshot.latest.memoryPressure?.some?.avg10 ?? 0;
  if (cpu >= 92 || memoryPercent >= 94 || pressure >= 20) return "critical";
  if (cpu >= 78 || memoryPercent >= 86 || pressure >= 5) return "warm";
  return "nominal";
}

function toneLabel(tone: HostTone): string {
  if (tone === "critical") return "Critical";
  if (tone === "warm") return "Elevated";
  if (tone === "unavailable") return "Unavailable";
  return "Nominal";
}

function rangeLabel(range: HostMetricRange): string {
  if (range === "1h") return "1 H";
  if (range === "24h") return "24 H";
  return "15 MIN";
}

function Sparkline({ values, kind }: { values: Array<number | null>; kind: "cpu" | "memory" }) {
  const numeric = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numeric.length < 2) {
    return <div className="host-pulse-sparkline-empty">COLLECTING HISTORY</div>;
  }
  const plotted = values.map((value, index) => {
    const safe = value === null ? numeric[numeric.length - 1] : value;
    const x = values.length === 1 ? 0 : index / (values.length - 1) * 100;
    const y = 100 - Math.max(0, Math.min(100, safe));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg
      className={`host-pulse-sparkline ${kind}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M0 25H100M0 50H100M0 75H100" />
      <polygon points={`0,100 ${plotted} 100,100`} />
      <polyline points={plotted} />
    </svg>
  );
}

function CoreTrace({ values }: { values: Array<number | null> }) {
  const numeric = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numeric.length < 2) return null;
  const points = values.map((value, index) => {
    const safe = value === null ? numeric[numeric.length - 1] : value;
    const x = values.length === 1 ? 0 : index / (values.length - 1) * 100;
    const y = 100 - Math.max(0, Math.min(100, safe));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

export function HostPulse({
  sessionName,
  workspaceId = null,
  workspaceName = null,
}: HostPulseProps) {
  const desktop = useDesktopViewport();
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const storageIdentity = workspaceId ? `workspace:${workspaceId}` : null;
  const renderIdentity = storageIdentity ?? "temporary-workspace";
  const initialStoreRef = useRef<HostPulseStore | null>(null);
  if (initialStoreRef.current === null) {
    initialStoreRef.current = {
      identity: renderIdentity,
      panel: storageIdentity ? readPanel(storageIdentity) : defaultPanelState(),
    };
  }
  const [store, setStore] = useState<HostPulseStore>(initialStoreRef.current);
  const [snapshot, setSnapshot] = useState<HostMetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [now, setNow] = useState(Date.now);
  const previousSessionRef = useRef({ identity: renderIdentity, sessionName });
  const snapshotKeyRef = useRef("");
  const samplingStateRef = useRef({ key: "", live: false, refreshToken: -1 });

  useEffect(() => {
    if (store.identity === renderIdentity) return;
    setStore({
      identity: renderIdentity,
      panel: storageIdentity ? readPanel(storageIdentity) : defaultPanelState(),
    });
  }, [renderIdentity, storageIdentity, store.identity]);

  useEffect(() => {
    if (!storageIdentity || store.identity !== renderIdentity) return;
    writePanel(storageIdentity, store.panel);
  }, [renderIdentity, storageIdentity, store]);

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (previous.identity === renderIdentity && previous.sessionName !== sessionName) {
      setStore((current) => current.identity === renderIdentity
        && current.panel.open
        && !current.panel.pinned
        ? { ...current, panel: { ...current.panel, open: false } }
        : current);
    }
    previousSessionRef.current = { identity: renderIdentity, sessionName };
  }, [renderIdentity, sessionName]);

  const active = store.identity === renderIdentity;
  const panel = active ? store.panel : defaultPanelState();
  const updatePanel = useCallback((
    updater: (current: HostPulsePanelState) => HostPulsePanelState,
  ) => {
    setStore((current) => current.identity === renderIdentity
      ? { ...current, panel: updater(current.panel) }
      : current);
  }, [renderIdentity]);

  useEffect(() => {
    if (!desktop || !active) {
      samplingStateRef.current = { key: "", live: false, refreshToken: -1 };
      return;
    }
    let controller: AbortController | null = null;
    let disposed = false;
    const requestKey = `${renderIdentity}:${panel.range}`;
    const live = panel.open && !panel.paused;
    const previous = samplingStateRef.current;
    const shouldLoad = previous.key !== requestKey
      || previous.refreshToken !== refreshToken
      || (live && !previous.live);
    samplingStateRef.current = { key: requestKey, live, refreshToken };
    const load = () => {
      if (disposed || document.hidden) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      void getHostMetrics(panel.range, requestController.signal).then((next) => {
        if (requestController.signal.aborted) return;
        setSnapshot(next);
        snapshotKeyRef.current = requestKey;
        setError(null);
        setNow(Date.now());
      }).catch((failure: unknown) => {
        if (requestController.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "Host metrics are unavailable");
      });
    };
    if (shouldLoad) load();
    const interval = live ? window.setInterval(load, HOST_POLL_MS) : null;
    const visibilityChanged = () => {
      if (!document.hidden && (live || snapshotKeyRef.current !== requestKey)) load();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
      controller?.abort();
    };
  }, [
    active,
    desktop,
    panel.open,
    panel.paused,
    panel.range,
    refreshToken,
    renderIdentity,
  ]);

  useEffect(() => {
    if (!active || !panel.open || !snapshot) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active, panel.open, snapshot]);

  useEffect(() => () => {
    interactionCleanupRef.current?.();
    document.documentElement.classList.remove("host-pulse-moving", "host-pulse-resizing");
  }, []);

  useEffect(() => {
    if (!active || !panel.open) return;
    const keepVisible = () => updatePanel((current) => {
      const size = clampSize(current.size);
      const position = clampPosition(current.position, size);
      if (
        size.width === current.size.width
        && size.height === current.size.height
        && position.x === current.position.x
        && position.y === current.position.y
      ) return current;
      return { ...current, size, position };
    });
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", keepVisible);
    visualViewport?.addEventListener?.("resize", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      visualViewport?.removeEventListener?.("resize", keepVisible);
    };
  }, [active, panel.open, updatePanel]);

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button, a")) return;
    event.preventDefault();
    event.stopPropagation();
    interactionCleanupRef.current?.();
    const pointerId = event.pointerId;
    const offsetX = event.clientX - panel.position.x;
    const offsetY = event.clientY - panel.position.y;
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("host-pulse-moving");
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
    document.documentElement.classList.add("host-pulse-moving");
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
    const distance = event.shiftKey ? MOVE_LARGE_STEP : MOVE_STEP;
    updatePanel((current) => ({
      ...current,
      position: clampPosition({
        x: current.position.x + direction[0] * distance,
        y: current.position.y + direction[1] * distance,
      }, current.size),
    }));
  }, [updatePanel]);

  const startResizing = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interactionCleanupRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = panel.size;
    const cleanup = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("host-pulse-resizing");
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null;
    };
    const resize = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      updatePanel((current) => {
        const size = clampSize({
          width: startSize.width + moveEvent.clientX - startX,
          height: startSize.height + moveEvent.clientY - startY,
        });
        return {
          ...current,
          size,
          position: clampPosition(current.position, size),
        };
      });
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    interactionCleanupRef.current = cleanup;
    document.documentElement.classList.add("host-pulse-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [panel.size, updatePanel]);

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "Enter"]
      .includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? RESIZE_LARGE_STEP : RESIZE_STEP;
    updatePanel((current) => {
      let nextSize: PanelSize = current.size;
      if (event.key === "Home") nextSize = { width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT };
      if (event.key === "Enter") nextSize = { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
      if (event.key === "ArrowLeft") nextSize = { ...current.size, width: current.size.width - step };
      if (event.key === "ArrowRight") nextSize = { ...current.size, width: current.size.width + step };
      if (event.key === "ArrowUp") nextSize = { ...current.size, height: current.size.height - step };
      if (event.key === "ArrowDown") nextSize = { ...current.size, height: current.size.height + step };
      const size = clampSize(nextSize);
      return { ...current, size, position: clampPosition(current.position, size) };
    });
  }, [updatePanel]);

  const memoryPercent = snapshot && snapshot.latest.memoryTotalBytes > 0
    ? snapshot.latest.memoryUsedBytes / snapshot.latest.memoryTotalBytes * 100
    : null;
  const swapPercent = snapshot && snapshot.latest.swapTotalBytes > 0
    ? snapshot.latest.swapUsedBytes / snapshot.latest.swapTotalBytes * 100
    : snapshot ? 0 : null;
  const tone = snapshotTone(snapshot, error);
  const cpuValues = useMemo(
    () => snapshot?.history.map((point) => point.cpuPercent) ?? [],
    [snapshot?.history],
  );
  const memoryValues = useMemo(
    () => snapshot?.history.map((point) => snapshot.latest.memoryTotalBytes > 0
      ? point.memoryUsedBytes / snapshot.latest.memoryTotalBytes * 100
      : null) ?? [],
    [snapshot],
  );
  const coreValues = snapshot?.latest.cpuCores ?? [];
  const coreHistories = useMemo(
    () => coreValues.map((_, coreIndex) => snapshot?.history.map((point) => (
      coreIndex < (point.cpuCores?.length ?? 0) ? point.cpuCores[coreIndex] : null
    ))) ?? [],
    [coreValues, snapshot?.history],
  );
  const updatedSeconds = snapshot
    ? Math.max(0, Math.floor(now / 1_000 - snapshot.latest.observedAt))
    : null;

  if (!desktop || !active) return null;

  const panelStyle = {
    left: panel.position.x,
    top: panel.position.y,
    width: panel.size.width,
    height: panel.size.height,
  } as CSSProperties;

  const floatingPanel = panel.open ? (
    <section
      ref={panelRef}
      className={`host-pulse-panel ${tone}${panel.pinned ? " pinned" : ""}`}
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
        className="host-pulse-panel-header"
        tabIndex={0}
        aria-label="Move Host Pulse window"
        title="Drag this title strip to move Host Pulse. Arrow keys also move it."
        onPointerDown={startDragging}
        onKeyDown={moveWithKeyboard}
      >
        <span className="host-pulse-panel-icon"><HostPulseIcon /></span>
        <div>
          <span>THIS HOST / {panel.paused ? "PAUSED" : "LIVE"}</span>
          <h2 id={headingId}>Host Pulse</h2>
        </div>
        <em>ON DEMAND</em>
        {panel.pinned && <em>PINNED</em>}
        <button
          type="button"
          aria-label={panel.pinned ? "Unpin Host Pulse" : "Pin Host Pulse"}
          aria-pressed={panel.pinned}
          title={panel.pinned
            ? "Stop keeping Host Pulse open"
            : "Keep Host Pulse visible across session switches"}
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
          aria-label="Close Host Pulse"
          onClick={() => updatePanel((current) => ({
            ...current,
            open: false,
            pinned: false,
          }))}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="host-pulse-body">
        <div className="host-pulse-summary">
          <span title={snapshot?.hostname}>{snapshot?.hostname || "HOST METRICS"}</span>
          <strong><i />{toneLabel(tone)}</strong>
        </div>
        <div className="host-pulse-view-switcher" role="group" aria-label="Host Pulse view">
          {(["overview", "details"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={panel.mode === mode}
              onClick={() => updatePanel((current) => ({ ...current, mode }))}
            >
              {mode === "overview" ? "Overview" : "Details"}
            </button>
          ))}
          <span>{panel.paused ? "SAMPLING PAUSED" : `${snapshot?.sampleSeconds ?? 5}S WHILE OPEN`}</span>
        </div>
        {error && !snapshot && (
          <div className="host-pulse-error" role="status">
            <span>{error}</span>
            <button type="button" onClick={() => setRefreshToken((value) => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {panel.mode === "overview" ? (
          <div className="host-pulse-overview">
            <div className="host-pulse-metrics" aria-live="polite">
              <article>
                <header><span>CPU</span><small>{snapshot?.cpuCount ?? "--"} CORES</small></header>
                <output>{percent(snapshot?.latest.cpuPercent ?? null)}</output>
                <Sparkline values={cpuValues} kind="cpu" />
              </article>
              <article>
                <header><span>MEMORY</span><small>{snapshot
                  ? formatBytes(snapshot.latest.memoryTotalBytes)
                  : "--"}</small></header>
                <output>{snapshot ? formatBytes(snapshot.latest.memoryUsedBytes) : "--"}</output>
                <Sparkline values={memoryValues} kind="memory" />
                <div className="host-pulse-memory-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, memoryPercent ?? 0))}%` }} />
                </div>
              </article>
            </div>
            <div className="host-pulse-details">
              <span><small>LOAD AVERAGE</small><strong>{snapshot
                ? snapshot.latest.loadAverage.map((value) => value.toFixed(2)).join(" / ")
                : "-- / -- / --"}</strong></span>
              <span><small>AVAILABLE</small><strong>{snapshot
                ? formatBytes(snapshot.latest.memoryAvailableBytes)
                : "--"}</strong></span>
              <span><small>SWAP</small><strong>{snapshot
                ? `${formatBytes(snapshot.latest.swapUsedBytes)} / ${formatBytes(snapshot.latest.swapTotalBytes)}`
                : "--"}</strong></span>
            </div>
          </div>
        ) : (
          <div className="host-pulse-deep-dive" aria-live="polite">
            <section className="host-pulse-core-section" aria-label="Per-core CPU utilization">
              <header>
                <div><small>LOGICAL PROCESSORS</small><h3>Every core</h3></div>
                <strong>{coreValues.length} / {snapshot?.cpuCount ?? "--"}</strong>
              </header>
              {coreValues.length ? (
                <div className="host-pulse-core-grid">
                  {coreValues.map((value, coreIndex) => (
                    <article
                      key={coreIndex}
                      aria-label={`CPU core ${coreIndex}: ${percent(value)}`}
                    >
                      <header><span>CORE {coreIndex}</span><strong>{percent(value)}</strong></header>
                      <div className="host-pulse-core-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
                      </div>
                      <CoreTrace values={coreHistories[coreIndex] ?? []} />
                    </article>
                  ))}
                </div>
              ) : (
                <p className="host-pulse-detail-empty">WAITING FOR PER-CORE DELTAS</p>
              )}
            </section>

            <section className="host-pulse-pressure-section" aria-label="Memory and swap pressure">
              <header>
                <div><small>STALLS + HEADROOM</small><h3>Memory / swap pressure</h3></div>
                <strong>PSI 10S / 60S</strong>
              </header>
              <div className="host-pulse-pressure-grid">
                <article className="memory">
                  <small>RAM USED</small>
                  <output>{percent(memoryPercent)}</output>
                  <div className="host-pulse-pressure-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, memoryPercent ?? 0))}%` }} />
                  </div>
                  <p>{snapshot
                    ? `${formatBytes(snapshot.latest.memoryAvailableBytes)} headroom / ${formatBytes(snapshot.latest.memoryTotalBytes)} total`
                    : "Waiting for a sample"}</p>
                </article>
                <article className="psi">
                  <small>PSI SOME</small>
                  <output>{formatPressure(snapshot?.latest.memoryPressure?.some?.avg10)}</output>
                  <strong>60S {formatPressure(snapshot?.latest.memoryPressure?.some?.avg60)}</strong>
                  <p>At least one task stalled on memory.</p>
                </article>
                <article className="psi">
                  <small>PSI FULL</small>
                  <output>{formatPressure(snapshot?.latest.memoryPressure?.full?.avg10)}</output>
                  <strong>60S {formatPressure(snapshot?.latest.memoryPressure?.full?.avg60)}</strong>
                  <p>All runnable tasks stalled together.</p>
                </article>
                <article className="swap">
                  <small>SWAP USED</small>
                  <output>{percent(swapPercent)}</output>
                  <div className="host-pulse-pressure-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, swapPercent ?? 0))}%` }} />
                  </div>
                  <p>{snapshot
                    ? `${formatBytes(snapshot.latest.swapUsedBytes)} / ${formatBytes(snapshot.latest.swapTotalBytes)}`
                    : "Waiting for a sample"}</p>
                </article>
                <article className="swap-io">
                  <small>ACTIVE SWAP I/O</small>
                  <div><span>IN</span><strong>{formatRate(snapshot?.latest.swapInBytesPerSecond ?? null)}</strong></div>
                  <div><span>OUT</span><strong>{formatRate(snapshot?.latest.swapOutBytesPerSecond ?? null)}</strong></div>
                  <p>Rates measured between requested samples.</p>
                </article>
              </div>
            </section>
          </div>
        )}
        <footer className="host-pulse-footer">
          <div role="group" aria-label="Host metric history range">
            {(["15m", "1h", "24h"] as const).map((range) => (
              <button
                type="button"
                key={range}
                aria-pressed={panel.range === range}
                onClick={() => updatePanel((current) => ({ ...current, range }))}
              >
                {rangeLabel(range)}
              </button>
            ))}
          </div>
          <span>{updatedSeconds === null
            ? "WAITING FOR SAMPLE"
            : `UPDATED ${updatedSeconds}S AGO`}</span>
          <button
            type="button"
            aria-label={panel.paused ? "Resume Host Pulse live updates" : "Pause Host Pulse live updates"}
            onClick={() => updatePanel((current) => ({ ...current, paused: !current.paused }))}
          >
            {panel.paused ? "Resume" : "Pause"}
          </button>
        </footer>
        <p className="host-pulse-footnote">
          ON-DEMAND HISTORY / NO BACKGROUND SERVER TIMER WHEN CLOSED
        </p>
      </div>
      <button
        type="button"
        className="host-pulse-resize-handle"
        aria-label="Resize Host Pulse window"
        aria-description="Drag to resize. Arrow keys resize one dimension; Home minimizes and Enter resets."
        title="Drag to resize. Arrow keys resize; Home minimizes; Enter resets."
        onPointerDown={startResizing}
        onKeyDown={resizeWithKeyboard}
      />
    </section>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={`host-pulse-card ${tone}${panel.open ? " window-open" : ""}${panel.pinned ? " window-pinned" : ""}`}
        aria-label={panel.open ? "Hide host metrics" : "Show host metrics"}
        aria-expanded={panel.open}
        title={`Host Pulse: CPU ${percent(snapshot?.latest.cpuPercent ?? null)}, memory ${percent(memoryPercent)}`}
        onClick={() => updatePanel((current) => current.open
          ? { ...current, open: false, pinned: false }
          : { ...current, open: true })}
      >
        <span className="host-pulse-card-icon"><HostPulseIcon /></span>
        <span><small>CPU</small><strong>{percent(snapshot?.latest.cpuPercent ?? null)}</strong></span>
        <span><small>MEMORY</small><strong>{percent(memoryPercent)}</strong></span>
        {(panel.pinned || panel.paused) && (
          <em aria-hidden="true">{panel.pinned ? "PIN" : "PAUSE"}</em>
        )}
      </button>
      {floatingPanel && createPortal(floatingPanel, document.body)}
    </>
  );
}
