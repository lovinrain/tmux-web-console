import { useCallback, useState } from "react";
import { closeWorkspaceFold, deleteWorkspaceFold, recoverWorkspaceFoldSession, type FoldDeleteSessionFence, type FoldSessionFence, type SavedWorkspace } from "./api";
import { SessionTerminateDialog } from "./components/SessionTerminateDialog";
import { sessionHasOnlyDeadPanes } from "./sessionLifecycle";
import type { Session } from "./types";
import { foldWorkspaceTabs, workspaceFoldMembers } from "./workspaceFolds";
import type { SessionWorkspaceState } from "./workspaceState";

interface Props {
  workspaceId: string | null;
  disabledReason: string | null;
  getWorkspace: () => SessionWorkspaceState;
  getSessions: () => Session[];
  captureSavedWorkspace: () => Promise<SavedWorkspace>;
  onWorkspaceUpdated: (workspace: SavedWorkspace) => void;
  refreshInventory: () => Promise<void>;
}

interface FoldRequest {
  mode: "close" | "delete";
  workspaceId: string;
  foldId: string;
  tabs: string[];
  names: string[];
  sessions: FoldDeleteSessionFence[];
  runningCount: number;
  deadCount: number;
}

export function useWorkspaceFoldActions({ workspaceId, disabledReason, getWorkspace, getSessions,
  captureSavedWorkspace, onWorkspaceUpdated, refreshInventory }: Props) {
  const [request, setRequest] = useState<FoldRequest | null>(null);
  const requestAction = useCallback((mode: "close" | "delete", names: string[], existingId?: string) => {
    if (!workspaceId || disabledReason) return;
    const state = getWorkspace();
    const id = existingId ?? crypto.randomUUID();
    const fold = existingId ? state.folds?.find((fold) => fold.id === id)
      : foldWorkspaceTabs(state, names, id).folds?.find((fold) => fold.id === id);
    if (!fold) return;
    const members = workspaceFoldMembers(fold, state.openSessions, state.parents);
    const live = new Map(getSessions().map((session) => [session.name, session]));
    const snapshots = new Map((fold.closedSessions ?? []).map((item) => [item.name, item]));
    const sessions = members.flatMap((name): FoldDeleteSessionFence[] => {
      const session = live.get(name);
      const snapshot = snapshots.get(name);
      return session ? [{ name, sessionId: session.id, sessionCreated: session.created,
        serverStarted: session.serverStarted, serverPid: session.serverPid,
        ...(mode === "delete" && sessionHasOnlyDeadPanes(session) ? { onlyDeadPanes: true as const } : {}) }]
        : mode === "delete" ? [{ name, sessionId: null }]
        : snapshot ? [{ name, sessionId: snapshot.sessionId, sessionCreated: snapshot.sessionCreated,
          serverStarted: snapshot.serverStarted, serverPid: snapshot.serverPid }] : [];
    });
    const present = members.flatMap((name) => live.has(name) ? [live.get(name)!] : []);
    const deadCount = present.filter(sessionHasOnlyDeadPanes).length;
    setRequest({ mode, workspaceId, foldId: id, tabs: [...fold.tabs], names: members, sessions,
      runningCount: present.length - deadCount, deadCount });
  }, [workspaceId, disabledReason, getWorkspace, getSessions]);
  const foldAndClose = useCallback((names: string[], existingId?: string) => requestAction("close", names, existingId), [requestAction]);
  const deleteFold = useCallback((foldId: string) => requestAction("delete", [], foldId), [requestAction]);

  const apply = async () => {
    if (!request) return;
    if (request.names.length !== request.sessions.length) {
      throw new Error("Some selected sessions are already missing. Recover them or remove them from the selection before closing.");
    }
    const saved = await captureSavedWorkspace();
    if (saved.id !== request.workspaceId) throw new Error("Workspace changed; reselect sessions in the intended workspace.");
    try {
      const result = request.mode === "delete"
        ? await deleteWorkspaceFold(saved, request.foldId, request.tabs, request.sessions)
        : await closeWorkspaceFold(saved, request.foldId, request.tabs,
          request.sessions.filter((item): item is FoldSessionFence => item.sessionId !== null));
      onWorkspaceUpdated(result.workspace);
      const failures = Object.entries(result.failures);
      if (failures.length) throw new Error(`${result.closed.length} closed; ${failures.length} failed. Recovery metadata was saved.${request.mode === "delete" ? " The fold was kept; retry to finish deleting it." : ""}\n${failures.map(([name, error]) => `${name}: ${error}`).join("\n")}`);
    } finally {
      // Also refresh after a lost response: committed metadata arrives by SSE,
      // and an exact-identity retry can safely finish the remaining closures.
      await refreshInventory();
    }
  };

  const recover = useCallback(async (foldId: string, name: string, mode: "shell" | "agent") => {
    const saved = await captureSavedWorkspace();
    if (saved.id !== workspaceId) throw new Error("Workspace changed; open the intended saved fold before recovering.");
    try { await recoverWorkspaceFoldSession(saved.id, foldId, name, mode); }
    finally { await refreshInventory(); }
  }, [captureSavedWorkspace, workspaceId, refreshInventory]);

  const deleting = request?.mode === "delete";
  const confirmation = request && <SessionTerminateDialog sessionName="" sessionTitle={null}
    heading={deleting ? `Delete fold and ${request.names.length} tabs?` : `Fold and close ${request.names.length} sessions?`}
    confirmLabel={deleting ? request.runningCount > 0 ? "Archive and delete" : "Delete fold" : "Fold and close"}
    pendingLabel={deleting ? "Archiving and deleting fold…" : "Saving metadata and closing sessions…"}
    onClose={() => setRequest(null)} onTerminate={apply}
    description={<>
      {deleting ? <>
        <p>This removes the fold and its {request.names.length} session tabs from this workspace.
          Session history, saved directories and recorded coding conversations remain available in History.</p>
        {request.runningCount > 0 && <p>{request.runningCount} running session{request.runningCount === 1 ? "" : "s"} will be archived before closing.
          All windows, panes and running processes in these sessions will end. Other workspaces viewing them will see them closed.</p>}
        {request.deadCount > 0 && <p>{request.deadCount} dead tmux session{request.deadCount === 1 ? "" : "s"} will also be removed.</p>}
        {request.runningCount + request.deadCount === 0 && <p>All sessions are already closed. They will stay closed.</p>}
      </> : <>
      <p>This saves each session’s directory, title and latest recorded coding conversation before closing tmux.
        The fold stays in this workspace with recovery options.</p>
      <p>All windows, panes and running processes in these sessions will end. Other workspaces viewing them will see them closed.</p>
      </>}
      <ul className="bulk-session-targets" aria-label={deleting ? "Sessions in fold to delete" : "Sessions to fold and close"}>
        {request.names.map((name) => <li key={name}><strong>{name}</strong></li>)}
      </ul>
    </>} />;
  return { foldAndClose, deleteFold, recover, confirmation };
}
