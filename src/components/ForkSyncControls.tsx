import { useCallback, useState } from "react";
import { RefreshIcon } from "../icons";
import type { WorkspaceViewsController } from "../useWorkspaceViews";
import { WorkspaceViewsDialog } from "./WorkspaceViewsDialog";
import "./ForkSyncControls.css";

export interface ForkSyncControlsProps {
  active: boolean;
  linked?: boolean;
  available: boolean;
  href: string;
  prepareFork: () => string;
  unlink: () => void;
  problem?: string | null;
  onFork?: () => void;
  views?: WorkspaceViewsController;
}

export function ForkSyncControls({ active, linked = active, available, href, prepareFork, unlink, problem, onFork, views }: ForkSyncControlsProps) {
  const [showViews, setShowViews] = useState(false);
  const closeViews = useCallback(() => setShowViews(false), []);
  const count = views?.views.filter((view) => view.inScope).length ?? 0;
  return (
    <span className="fork-sync-controls">
      {available ? (
        <a
          className="split-workspace-button fork-sync-view-button"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Fork-sync current view in a new browser tab"
          title="Open a linked tab. Selecting a session or pane view in either tab updates both; appearance stays independent."
          onClick={(event) => { event.currentTarget.href = prepareFork(); onFork?.(); }}
          onContextMenu={(event) => { event.currentTarget.href = prepareFork(); }}
          onAuxClick={(event) => {
            if (event.button === 1) { event.currentTarget.href = prepareFork(); onFork?.(); }
          }}
        >
          <RefreshIcon /><span>Fork-sync</span>
        </a>
      ) : (
        <button type="button" className="split-workspace-button" disabled
          aria-label="Fork-sync current view in a new browser tab"
          title={problem ?? "Open a session or pane view before linking tabs"}>
          <RefreshIcon /><span>Fork-sync</span>
        </button>
      )}
      {active && <span className="fork-sync-status" role="status" title="Session and pane view selections are linked in this browser">Synced</span>}
      {linked && (
          <button type="button" className="split-workspace-button fork-sync-unlink-button"
            aria-label="Unlink this browser tab" title="Keep this view and continue navigating independently" onClick={unlink}>
            Unlink
          </button>
      )}
      {views?.available && (
        <button type="button" className="split-workspace-button workspace-views-button"
          aria-label="Manage workspace views" aria-haspopup="dialog"
          title="See attached views and disconnect those affecting the shared terminal size"
          onClick={() => { views.refresh(); setShowViews(true); }}>
          Views {views.loading ? "…" : views.error ? "?" : count}
        </button>
      )}
      {problem && <span className="fork-sync-problem" role="status">{problem}</span>}
      {showViews && views?.available && <WorkspaceViewsDialog controller={views} onClose={closeViews} />}
    </span>
  );
}
