import { useEffect, useRef, useState } from "react";
import { createHistorySnapshot, loadHistoryPage } from "../api";
import { CloseIcon, RefreshIcon } from "../icons";
import type { HistoryPage, Pane } from "../types";

interface HistoryPanelProps {
  pane: Pane;
  onClose: () => void;
}

export function HistoryPanel({ pane, onClose }: HistoryPanelProps) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="history-panel" role="dialog" aria-modal="true" aria-label="Tmux pane history" onMouseDown={(event) => event.stopPropagation()}>
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

