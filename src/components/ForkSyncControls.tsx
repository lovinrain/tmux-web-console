import { useCallback, useState } from "react";
import { EyeIcon, LinkIcon, UnlinkIcon } from "../icons";
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
          aria-label="Open synced workspace tab"
          title="Synced tab: open this workspace in a new browser tab. Session and panel selection stay in sync; themes and controls stay separate."
          onClick={(event) => { event.currentTarget.href = prepareFork(); onFork?.(); }}
          onContextMenu={(event) => { event.currentTarget.href = prepareFork(); }}
          onAuxClick={(event) => {
            if (event.button === 1) { event.currentTarget.href = prepareFork(); onFork?.(); }
          }}
        >
          <LinkIcon /><span>Synced tab</span>
        </a>
      ) : (
        <button type="button" className="split-workspace-button" disabled
          aria-label="Open synced workspace tab"
          title={problem ?? "Open a session or pane view before linking tabs"}>
          <LinkIcon /><span>Synced tab</span>
        </button>
      )}
      {active && <span className="fork-sync-status" role="status" title="Session and pane view selections are linked in this browser">Synced</span>}
      {linked && (
          <button type="button" className="split-workspace-button fork-sync-unlink-button"
            aria-label="Unlink this browser tab" title="Keep this view and continue navigating independently" onClick={unlink}>
            <UnlinkIcon width={16} height={16} /><span>Unlink</span>
          </button>
      )}
      {views?.available && (
        <button type="button" className="split-workspace-button workspace-views-button"
          aria-label="Manage workspace views" aria-haspopup="dialog"
          title={`See attached views and disconnect those affecting the shared terminal size (${count} attached)`}
          onClick={() => { views.refresh(); setShowViews(true); }}>
          <EyeIcon width={16} height={16} /><span>Views</span> <strong>{views.loading ? "…" : views.error ? "?" : count}</strong>
        </button>
      )}
      {problem && <span className="fork-sync-problem" role="status" title={problem}>{problem}</span>}
      {showViews && views?.available && <WorkspaceViewsDialog controller={views} onClose={closeViews} />}
    </span>
  );
}
