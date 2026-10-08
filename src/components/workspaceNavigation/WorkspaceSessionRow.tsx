import {
  ArrowLeftIcon,
  CloseIcon,
  TrashIcon,
  WindowCopyIcon,
  WindowMoveIcon
} from "../../icons";
import { sessionDisplayTitle } from "../../sessionDashboardModel";
import type { Session } from "../../types";
import {
  type WorkspaceTabGroup
} from "../../workspaceState";


import { activePane, paneLabel, sessionTreeStyle, STATE_LABELS, workspaceSessionState, type SessionTreeContext } from "./presentation";

export interface WorkspaceSessionRowProps {
  sessionName: string;
  session?: Session;
  group?: WorkspaceTabGroup;
  tree?: SessionTreeContext;
  active: boolean;
  open: boolean;
  onSelect: () => void;
  openIndex?: number;
  openCount?: number;
  previousMoveIndex?: number;
  nextMoveIndex?: number;
  onMoveTab?: (targetIndex: number) => void;
  onCopyToNewWindow?: () => void;
  onMoveToNewWindow?: () => void;
  moveToNewWindowDisabledReason?: string | null;
  onClose?: () => void;
  onTerminate?: () => void;
}

export function WorkspaceSessionRow({
  sessionName,
  session,
  group,
  tree,
  active,
  open,
  onSelect,
  openIndex,
  openCount,
  previousMoveIndex = -1,
  nextMoveIndex = -1,
  onMoveTab,
  onCopyToNewWindow,
  onMoveToNewWindow,
  moveToNewWindowDisabledReason = null,
  onClose,
  onTerminate,
}: WorkspaceSessionRowProps) {
  const pane = session ? activePane(session) : undefined;
  const displayTitle = session ? sessionDisplayTitle(session) : sessionName;
  const state = workspaceSessionState(session);
  const stateLabel = STATE_LABELS[state];
  const canReorder = (
    open
    && onMoveTab
    && openIndex !== undefined
    && openCount !== undefined
    && openCount > 1
  );
  const hasWindowActions = Boolean(onCopyToNewWindow && onMoveToNewWindow);

  return (
    <div
      className={`workspace-session-row${active ? " active" : ""}${open && (onTerminate || hasWindowActions) ? " stacked-actions" : ""}`}
      data-workspace-session-name={sessionName}
      data-session-dead={state === "dead" ? "true" : undefined}
      data-session-parent={tree?.parentName}
      data-session-depth={tree?.depth}
      style={sessionTreeStyle(tree)}
    >
      <button
        type="button"
        className="workspace-session-select"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        aria-description={tree?.description}
        title={tree?.description}
      >
        <span
          className={`workspace-state-dot ${state}`}
          aria-hidden="true"
        />
        <span className="workspace-session-copy">
          <strong>{displayTitle}</strong>
          <span>
            {displayTitle !== sessionName ? `${sessionName} / ` : ""}
            {session ? paneLabel(pane) : "tmux session ended"}
          </span>
          {tree && (
            <span className="workspace-session-parent-label">
              <span className="workspace-tab-child-marker" aria-hidden="true" />
              Child of {tree.parentTitle}
            </span>
          )}
          {group && (
            <span
              className="workspace-session-group-label"
              data-tab-group-color={group.color}
            >
              <span aria-hidden="true" />
              Group: {group.name}
            </span>
          )}
        </span>
        <span className="workspace-session-indicators">
          <span className={`workspace-session-status ${state}`}>
            {active ? `Active \u00b7 ${stateLabel}` : stateLabel}
          </span>
          {session && session.queuedMessageCount > 0 && (
            <span
              className="workspace-session-memo-queue"
              aria-label={`${session.queuedMessageCount} queued memo ${session.queuedMessageCount === 1 ? "item" : "items"}`}
            >
              Q {session.queuedMessageCount}
            </span>
          )}
        </span>
      </button>
      {(canReorder || hasWindowActions || onClose || onTerminate) && (
        <span className="workspace-session-actions">
          {canReorder && (
            <span
              className="workspace-session-reorder"
              role="group"
              aria-label={`Reorder ${displayTitle} tab`}
            >
              <button
                type="button"
                className="workspace-session-move workspace-session-move-up"
                onClick={() => onMoveTab(previousMoveIndex)}
                disabled={previousMoveIndex < 0}
                aria-label={`Move ${displayTitle} tab up`}
                title="Move tab up"
              >
                <ArrowLeftIcon />
              </button>
              <button
                type="button"
                className="workspace-session-move workspace-session-move-down"
                onClick={() => onMoveTab(nextMoveIndex)}
                disabled={nextMoveIndex < 0}
                aria-label={`Move ${displayTitle} tab down`}
                title="Move tab down"
              >
                <ArrowLeftIcon />
              </button>
            </span>
          )}
          {hasWindowActions && (
            <span
              className="workspace-session-window-actions"
              role="group"
              aria-label={`${displayTitle} tab window actions`}
            >
              <button
                type="button"
                className="workspace-session-window-move"
                onClick={onMoveToNewWindow}
                disabled={Boolean(moveToNewWindowDisabledReason)}
                aria-label={`Move ${displayTitle} tab to new window`}
                aria-description={moveToNewWindowDisabledReason
                  ?? "Opens this session in a separate browser window and removes this quick tab here. The tmux session keeps running."}
                title={moveToNewWindowDisabledReason ?? "Move tab to new window"}
              >
                <WindowMoveIcon />
              </button>
              <button
                type="button"
                className="workspace-session-window-copy"
                onClick={onCopyToNewWindow}
                aria-label={`Copy ${displayTitle} tab to new window`}
                aria-description="Opens this session in a separate browser window and keeps this quick tab here."
                title="Copy tab to new window"
              >
                <WindowCopyIcon />
              </button>
            </span>
          )}
          {onTerminate && (
            <button
              type="button"
              className="workspace-session-terminate"
              onClick={onTerminate}
              aria-label={`Terminate ${displayTitle} tmux session`}
              aria-haspopup="dialog"
              title="Terminate tmux session"
            >
              <TrashIcon />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="workspace-session-close"
              onClick={onClose}
              aria-label={`Close ${displayTitle} quick tab`}
              title="Close quick tab"
            >
              <CloseIcon />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
