import type { KeyboardEvent, Ref } from "react";
import { ArrowRightIcon } from "../../icons";
import type { WorkspaceTabFold } from "../../workspaceFolds";
import { sessionTreeStyle, type sessionTreeContext } from "./presentation";
import "./WorkspaceFoldTab.css";

interface Props {
  fold: WorkspaceTabFold;
  count: number;
  titles: string[];
  activeTitle: string | null;
  unreadCount: number;
  tree: ReturnType<typeof sessionTreeContext>;
  activeRef?: Ref<HTMLButtonElement>;
  onUnfold?: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function WorkspaceFoldTab({ fold, count, titles, activeTitle, unreadCount, tree, activeRef, onUnfold, onKeyDown }: Props) {
  const description = [
    titles.join(", "),
    activeTitle ? `Active session: ${activeTitle}.` : "",
    unreadCount ? `${unreadCount} unread sessions.` : "",
    "Unfold to restore these tabs in their original positions.",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={`workspace-tab workspace-fold-placeholder${activeTitle ? " active" : ""}`}
      data-workspace-tab-fold-id={fold.id}
      data-fold-anchor={fold.tabs[0]}
      data-session-parent={tree?.parentName}
      data-session-depth={tree?.depth}
      style={sessionTreeStyle(tree)}
    >
      <button
        ref={activeRef}
        type="button"
        role="tab"
        aria-selected={Boolean(activeTitle)}
        aria-controls={activeTitle ? "muxdeck-active-console" : undefined}
        aria-label={`Unfold ${count} sessions`}
        aria-description={description}
        title={description}
        tabIndex={activeTitle ? 0 : -1}
        disabled={!onUnfold}
        onClick={() => onUnfold?.(fold.id)}
        onKeyDown={onKeyDown}
      >
        {tree && <span className="workspace-tab-child-marker" aria-hidden="true" />}
        <ArrowRightIcon />
        <span className="workspace-fold-title">Fold</span>
        <strong className="workspace-fold-count">{count}</strong>
        <span className="workspace-tab-title">{activeTitle ?? titles[0]}</span>
        {unreadCount > 0 && <span className="workspace-tab-group-ready-count"
          aria-label={`${unreadCount} unread sessions`}>{unreadCount}</span>}
      </button>
    </div>
  );
}
