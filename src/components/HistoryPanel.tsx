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
import { createHistorySnapshot, loadHistoryPage } from "../api";
import { CloseIcon, RefreshIcon } from "../icons";
import type { HistoryPage, Pane } from "../types";
import { SubmittedMessages } from "./SubmittedMessages";
import { SavedScrollback } from "./SavedScrollback";
import { AgentTranscript } from "./AgentTranscript";
import { paneCommandKind } from "../sessionDashboardModel";
import { acquireBodyScrollLock } from "../bodyScrollLock";

export const DEFAULT_HISTORY_PANEL_WIDTH = 680;
export const MIN_HISTORY_PANEL_WIDTH = 360;
export const HISTORY_PANEL_MOBILE_BREAKPOINT = 640;

const HISTORY_PANEL_KEYBOARD_STEP = 16;
const HISTORY_PANEL_KEYBOARD_LARGE_STEP = 64;
const HISTORY_PANEL_WIDTH_PRESETS = [50, 75, 100] as const;

interface HistoryPanelProps {
  pane: Pane;
  sessionName?: string;
  sessionIdentity?: string;
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
    max: Math.max(MIN_HISTORY_PANEL_WIDTH, viewportWidth),
  };
}

function clampWidth(width: number, viewportWidth: number): number {
  const bounds = widthBounds(viewportWidth);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

export function HistoryPanel({
  pane,
  sessionName,
  sessionIdentity,
  onClose,
  preferredWidth = DEFAULT_HISTORY_PANEL_WIDTH,
  onPreferredWidthChange,
}: HistoryPanelProps) {
  const viewId = useId();
  const isAgent = ["codex", "claude", "copilot", "cursor", "grok"].includes(paneCommandKind(pane.command, pane.title));
  const [view, selectView] = useState<"transcript" | "scrollback" | "recorded" | "submitted">(isAgent ? "transcript" : "scrollback");
  const views = sessionName ? ["transcript", "scrollback", "recorded", "submitted"] as const : ["transcript", "scrollback", "recorded"] as const;
  const viewLabels = { transcript: "Transcript", scrollback: "Scrollback", recorded: "Recorded output", submitted: "Submitted messages" };
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [panelWidth, setPanelWidth] = useState(() => (
    clampWidth(preferredWidth, window.innerWidth)
  ));
  const [restoreWidth, setRestoreWidth] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const capturePending = useRef(false);
  const panelWidthRef = useRef(panelWidth);
  const resizeRef = useRef<ResizeState | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) closeRef.current?.focus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      const panel = panelRef.current;
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, summary, [tabindex]",
      )).filter((element) => {
        if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [aria-hidden='true']")) return false;
        const closedDetails = element.closest("details:not([open])");
        return !closedDetails || !!closedDetails.querySelector(":scope > summary")?.contains(element);
      });
      const first = focusable[0] ?? panel;
      const last = focusable.at(-1) ?? panel;
      if (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("focusin", containFocus);
    window.addEventListener("keydown", handleKeyDown, true);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("focusin", containFocus);
      window.removeEventListener("keydown", handleKeyDown, true);
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

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
    if (capturePending.current) return;
    capturePending.current = true;
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
      capturePending.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    if (view === "scrollback" && page === null) void capture();
  }, [pane.id, view]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const commitWidth = useCallback((width: number, preset = false) => {
    const previousWidth = panelWidthRef.current;
    setRestoreWidth((previous) => preset ? previous ?? previousWidth : null);
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
        ref={panelRef}
        className="history-panel"
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Tmux pane history"
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
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
            <p className="eyebrow">{view === "submitted" ? `SESSION ${sessionName}` : `PANE ${pane.id}`} / HISTORY</p>
            <h2>{viewLabels[view]}</h2>
          </div>
          <div className="history-header-actions">
            {!mobile && <div className="history-width-presets" role="group" aria-label="History window width">
              {HISTORY_PANEL_WIDTH_PRESETS.map((percent) => {
                const width = clampWidth(viewportWidth * percent / 100, viewportWidth);
                const selected = panelWidth === width;
                return <button type="button" key={percent}
                  className={selected ? "primary-button" : "secondary-button"}
                  aria-label={`${percent}% width`} aria-pressed={selected}
                  title={`Fit to ${percent}% of the window width`}
                  onClick={() => commitWidth(width, true)}>{percent}%</button>;
              })}
              <button type="button" className="secondary-button"
                aria-label="Restore previous width" title="Restore the width before using presets"
                disabled={restoreWidth === null}
                onClick={() => { if (restoreWidth !== null) commitWidth(restoreWidth); }}>Restore</button>
            </div>}
            {view === "scrollback" && <button type="button" className="icon-button" onClick={() => void capture()} aria-label="Capture a new snapshot"><RefreshIcon /></button>}
            <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close history" title="Close history (Esc)"><CloseIcon /></button>
          </div>
        </header>

        <div className="history-view-tabs" role="tablist" aria-label="History view"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const current = views.findIndex((value) => value === view);
            const index = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
              : (current + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
            const next = views[index];
            selectView(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
          }}>
          {views.map((value) => <button type="button" key={value}
            id={`${viewId}-${value}`} data-view={value} role="tab" aria-selected={view === value}
            aria-controls={`${viewId}-content`} tabIndex={view === value ? 0 : -1}
            onClick={() => selectView(value)}>{viewLabels[value]}</button>)}
        </div>

        <div className="history-view-content" id={`${viewId}-content`} role="tabpanel"
          aria-labelledby={`${viewId}-${view}`}>
        {view === "transcript" ? <>
          <AgentTranscript target={{ paneId: pane.id, identity: sessionIdentity }}
            onShowScrollback={() => selectView("scrollback")} onShowBeginning={() => selectView("recorded")} />
          <footer className="history-footer"><button type="button" className="primary-button" onClick={onClose}>Back to live</button></footer>
        </> : view === "recorded" ? <>
          {isAgent && <div className="history-notice">Terminal output saved by Muxdeck. Recording may begin after the conversation started.
            {" "}<button type="button" onClick={() => selectView("transcript")}>Read the transcript</button>
          </div>}
          <SavedScrollback target={{ paneId: pane.id, identity: sessionIdentity }} part="beginning" />
          <footer className="history-footer"><button type="button" className="primary-button" onClick={onClose}>Back to live</button></footer>
        </> : view === "submitted" && sessionName ? <>
          <SubmittedMessages key={`${sessionName}:${sessionIdentity}`} target={{ sessionName, identity: sessionIdentity }} />
          <footer className="history-footer"><button type="button" className="primary-button" onClick={onClose}>Back to live</button></footer>
        </> : <>
        <div className="history-meta">
          <span>{page ? `${page.totalLines.toLocaleString()} captured lines` : "Capturing pane"}</span>
          <span>{page ? new Date(page.capturedAt * 1000).toLocaleTimeString() : "-"}</span>
        </div>

        {page && ((page.alternateOn && page.historySize === 0) || lines.some((line) => line.includes("Earlier messages are available"))) && (
          <div className="history-notice">The terminal may show only part of this conversation.
            {" "}<button type="button" onClick={() => selectView("transcript")}>Read the local agent transcript</button>
            {" "}Recorded output{sessionName ? " and Submitted messages are" : " is"} also available.</div>
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
        </>}
        </div>
      </aside>
    </div>
  );
}
