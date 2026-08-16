import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createHistorySnapshot, loadHistoryPage } from "../api";
import { CloseIcon, RefreshIcon } from "../icons";
import type { HistoryPage, Pane } from "../types";

export const DEFAULT_HISTORY_PANEL_WIDTH = 680;
export const MIN_HISTORY_PANEL_WIDTH = 360;
export const HISTORY_PANEL_MOBILE_BREAKPOINT = 640;

const HISTORY_PANEL_BACKDROP_GUTTER = 48;
const HISTORY_PANEL_KEYBOARD_STEP = 16;
const HISTORY_PANEL_KEYBOARD_LARGE_STEP = 64;

interface HistoryPanelProps {
  pane: Pane;
  onClose: () => void;
  preferredWidth?: number;
  onPreferredWidthChange?: (width: number) => void;
}

interface ResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

function widthBounds(viewportWidth: number) {
  return {
    min: MIN_HISTORY_PANEL_WIDTH,
    max: Math.max(MIN_HISTORY_PANEL_WIDTH, viewportWidth - HISTORY_PANEL_BACKDROP_GUTTER),
  };
}

function clampWidth(width: number, viewportWidth: number): number {
  const bounds = widthBounds(viewportWidth);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

export function HistoryPanel({
  pane,
  onClose,
  preferredWidth = DEFAULT_HISTORY_PANEL_WIDTH,
  onPreferredWidthChange,
}: HistoryPanelProps) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [panelWidth, setPanelWidth] = useState(() => (
    clampWidth(preferredWidth, window.innerWidth)
  ));
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelWidthRef = useRef(panelWidth);
  const resizeRef = useRef<ResizeState | null>(null);

  const updatePanelWidth = useCallback((width: number) => {
    panelWidthRef.current = width;
    setPanelWidth(width);
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (resizeRef.current) return;
    updatePanelWidth(clampWidth(preferredWidth, viewportWidth));
  }, [preferredWidth, updatePanelWidth, viewportWidth]);

  useEffect(() => () => {
    document.documentElement.classList.remove("history-resizing");
  }, []);

  const capture = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await createHistorySnapshot(pane.id);
      setPage(next);
      setLines(next.lines);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to capture history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void capture();
  }, [pane.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = async () => {
    if (!page?.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    const viewport = scrollRef.current;
    const previousHeight = viewport?.scrollHeight || 0;
    try {
      const older = await loadHistoryPage(page.snapshotId, page.nextCursor);
      setLines((current) => [...older.lines, ...current]);
      setPage(older);
      requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load older history");
    } finally {
      setLoadingOlder(false);
    }
  };

  const copyHistory = async () => {
    await navigator.clipboard.writeText(lines.join("\n"));
  };

  const commitWidth = useCallback((width: number) => {
    const nextWidth = clampWidth(width, window.innerWidth);
    updatePanelWidth(nextWidth);
    onPreferredWidthChange?.(nextWidth);
  }, [onPreferredWidthChange, updatePanelWidth]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= HISTORY_PANEL_MOBILE_BREAKPOINT) return;
    if (resizeRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidthRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add("history-resizing");
  };

  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    event.preventDefault();
    const nextWidth = resize.startWidth + resize.startX - event.clientX;
    updatePanelWidth(clampWidth(nextWidth, window.innerWidth));
  };

  const finishResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    shouldCommit: boolean,
  ) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    resizeRef.current = null;
    document.documentElement.classList.remove("history-resizing");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (shouldCommit) {
      commitWidth(panelWidthRef.current);
    } else {
      updatePanelWidth(clampWidth(preferredWidth, window.innerWidth));
    }
  };

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (viewportWidth <= HISTORY_PANEL_MOBILE_BREAKPOINT) return;

    const bounds = widthBounds(viewportWidth);
    const step = event.shiftKey
      ? HISTORY_PANEL_KEYBOARD_LARGE_STEP
      : HISTORY_PANEL_KEYBOARD_STEP;
    let nextWidth: number;

    switch (event.key) {
      case "ArrowLeft":
        nextWidth = panelWidth + step;
        break;
      case "ArrowRight":
        nextWidth = panelWidth - step;
        break;
      case "Home":
        nextWidth = bounds.min;
        break;
      case "End":
        nextWidth = bounds.max;
        break;
      case "Enter":
        nextWidth = DEFAULT_HISTORY_PANEL_WIDTH;
        break;
      default:
        return;
    }

    event.preventDefault();
    commitWidth(nextWidth);
  };

  const bounds = widthBounds(viewportWidth);
  const mobile = viewportWidth <= HISTORY_PANEL_MOBILE_BREAKPOINT;
  const panelStyle = {
    "--history-panel-width": `${panelWidth}px`,
  } as CSSProperties;

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="history-panel"
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Tmux pane history"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="history-resize-handle"
          role="separator"
          aria-label="Resize scrollback panel"
          aria-orientation="vertical"
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={panelWidth}
          aria-valuetext={`${panelWidth} pixels wide`}
          aria-hidden={mobile || undefined}
          tabIndex={mobile ? -1 : 0}
          title="Drag to resize. Use Left and Right arrows; Enter resets."
          onPointerDown={beginResize}
          onPointerMove={resizeFromPointer}
          onPointerUp={(event) => finishResize(event, true)}
          onPointerCancel={(event) => finishResize(event, false)}
          onLostPointerCapture={(event) => finishResize(event, true)}
          onDoubleClick={() => commitWidth(DEFAULT_HISTORY_PANEL_WIDTH)}
          onKeyDown={resizeFromKeyboard}
        />
        <header className="history-header">
          <div>
            <p className="eyebrow">PANE {pane.id} / HISTORY</p>
            <h2>Scrollback</h2>
          </div>
          <div className="history-header-actions">
            <button type="button" className="icon-button" onClick={() => void capture()} aria-label="Capture a new snapshot"><RefreshIcon /></button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close history"><CloseIcon /></button>
          </div>
        </header>

        <div className="history-meta">
          <span>{page ? `${page.totalLines.toLocaleString()} captured lines` : "Capturing pane"}</span>
          <span>{page ? new Date(page.capturedAt * 1000).toLocaleTimeString() : "-"}</span>
        </div>

        {page?.alternateOn && page.historySize === 0 && (
          <div className="history-notice">This full-screen app has no retained tmux scrollback. The current screen is shown; older screens cannot be recovered by tmux.</div>
        )}

        <div className="history-scroll" ref={scrollRef}>
          {page?.nextCursor !== null && page && (
            <button type="button" className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading..." : "Load older lines"}
            </button>
          )}
          {loading && <div className="history-status">Capturing retained tmux history...</div>}
          {error && <div className="history-status error">{error}<button type="button" onClick={() => void capture()}>Retry</button></div>}
          {!loading && !error && lines.length === 0 && <div className="history-status">No retained output in this pane.</div>}
          {lines.length > 0 && <pre>{lines.join("\n")}</pre>}
        </div>

        <footer className="history-footer">
          <button type="button" className="secondary-button" onClick={() => void copyHistory()} disabled={lines.length === 0}>Copy loaded</button>
          <button type="button" className="primary-button" onClick={onClose}>Back to live</button>
        </footer>
      </aside>
    </div>
  );
}
