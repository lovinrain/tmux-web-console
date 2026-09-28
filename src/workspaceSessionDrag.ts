export const WORKSPACE_SESSION_DRAG_TYPE = "application/x-muxdeck-session";

export function hasWorkspaceSessionDrag(transfer: DataTransfer): boolean {
  const types = Array.from(transfer.types);
  return types.includes(WORKSPACE_SESSION_DRAG_TYPE) && !types.includes("Files");
}

export function readWorkspaceSessionDrag(
  transfer: DataTransfer,
  openSessions: readonly string[],
): string | null {
  if (!hasWorkspaceSessionDrag(transfer)) return null;
  const sessionName = transfer.getData(WORKSPACE_SESSION_DRAG_TYPE);
  return openSessions.includes(sessionName) ? sessionName : null;
}
