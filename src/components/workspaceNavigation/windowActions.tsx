import { CloseIcon } from "../../icons";
import type { OpenTabInNewWindowResult, WorkspacePersistenceState } from "./types";

export function moveToNewWindowDisabledReason(
  workspacePersistenceState: WorkspacePersistenceState,
): string | null {
  if (workspacePersistenceState === "loading") {
    return "Move is unavailable until the saved workspace finishes opening.";
  }
  if (workspacePersistenceState === "error") {
    return "Move is unavailable until the workspace sync issue is resolved.";
  }
  return null;
}

export function newWindowFailureMessage(
  result: Exclude<OpenTabInNewWindowResult, "opened">,
  title: string,
): string {
  if (result === "workspace-sync-pending") {
    return `Muxdeck is finishing an earlier workspace save before moving ${title}. The source tab is unchanged. Try Move again when the save finishes.`;
  }
  if (result === "blocked") {
    return `The browser blocked a new window for ${title}. Allow pop-ups and try again.`;
  }
  return `Muxdeck could not open ${title} in a new window. The source tab is unchanged. Try again.`;
}

export function WorkspaceWindowActionError({
  message,
  onDismiss,
  dismissLabel = "Dismiss new window error",
}: {
  message: string;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  if (!message) return null;
  return (
    <div className="workspace-window-action-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label={dismissLabel}>
        <CloseIcon />
      </button>
    </div>
  );
}
