import { WindowCopyIcon } from "../icons";
import "./CopySessionControl.css";

export type CopySessionPlacement = "sibling" | "child";

interface CopySessionControlProps {
  busy: boolean;
  disabled: boolean;
  title: string;
  shortcut: string | undefined;
  onCopy: (placement: CopySessionPlacement) => void;
}

export function CopySessionControl({
  busy, disabled, title, shortcut, onCopy,
}: CopySessionControlProps) {
  return (
    <div className="copy-session-control" role="group" aria-label="Copy" aria-busy={busy}>
      <span className="copy-session-label" aria-hidden="true">{busy ? "Creating..." : "Copy"}</span>
      <div className="copy-session-actions">
        <button
          type="button"
          className="copy-session-button"
          aria-label="Copy sibling session"
          aria-keyshortcuts={shortcut}
          disabled={disabled || busy}
          title={title}
          onClick={() => onCopy("sibling")}
        >
          <WindowCopyIcon />
          <span>Sibling</span>
        </button>
        <button
          type="button"
          className="copy-session-button"
          aria-label="Copy child session"
          disabled={disabled || busy}
          title="Create and open a fresh session in this pane's working directory, indented under this session"
          onClick={() => onCopy("child")}
        >
          <span className="copy-session-child-icon" aria-hidden="true">
            <WindowCopyIcon />
            <span className="copy-session-child-mark">↳</span>
          </span>
          <span>Child</span>
        </button>
      </div>
    </div>
  );
}
