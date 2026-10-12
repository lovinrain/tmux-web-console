import { useCallback, useState } from "react";
import { closeWorkspaceFold, recoverWorkspaceFoldSession, type FoldSessionFence, type SavedWorkspace } from "./api";
import { SessionTerminateDialog } from "./components/SessionTerminateDialog";
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

interface CloseRequest {
  workspaceId: string;
  foldId: string;
  tabs: string[];
  names: string[];
  sessions: FoldSessionFence[];
}

export function useWorkspaceFoldActions({ workspaceId, disabledReason, getWorkspace, getSessions,
  captureSavedWorkspace, onWorkspaceUpdated, refreshInventory }: Props) {
  const [request, setRequest] = useState<CloseRequest | null>(null);
  const foldAndClose = useCallback((names: string[], existingId?: string) => {
    if (!workspaceId || disabledReason) return;
    const state = getWorkspace();
    const id = existingId ?? crypto.randomUUID();
    const fold = existingId ? state.folds?.find((fold) => fold.id === id)
      : foldWorkspaceTabs(state, names, id).folds?.find((fold) => fold.id === id);
    if (!fold) return;
    const members = workspaceFoldMembers(fold, state.openSessions, state.parents);
    const live = new Map(getSessions().map((session) => [session.name, session]));
    const snapshots = new Map((fold.closedSessions ?? []).map((item) => [item.name, item]));
    const sessions = members.flatMap((name): FoldSessionFence[] => {
      const session = live.get(name);
      const snapshot = snapshots.get(name);
      return session ? [{ name, sessionId: session.id, sessionCreated: session.created,
        serverStarted: session.serverStarted, serverPid: session.serverPid }]
        : snapshot ? [{ name, sessionId: snapshot.sessionId, sessionCreated: snapshot.sessionCreated,
          serverStarted: snapshot.serverStarted, serverPid: snapshot.serverPid }] : [];
    });
    setRequest({ workspaceId, foldId: id, tabs: [...fold.tabs], names: members, sessions });
  }, [workspaceId, disabledReason, getWorkspace, getSessions]);

  const apply = async () => {
    if (!request) return;
    if (request.names.length !== request.sessions.length) {
      throw new Error("Some selected sessions are already missing. Recover them or remove them from the selection before closing.");
    }
    const saved = await captureSavedWorkspace();
    if (saved.id !== request.workspaceId) throw new Error("Workspace changed; reselect sessions in the intended workspace.");
    try {
      const result = await closeWorkspaceFold(saved, request.foldId, request.tabs, request.sessions);
      onWorkspaceUpdated(result.workspace);
      const failures = Object.entries(result.failures);
      if (failures.length) throw new Error(`${result.closed.length} closed; ${failures.length} failed. Recovery metadata was saved.\n${failures.map(([name, error]) => `${name}: ${error}`).join("\n")}`);
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

  const confirmation = request && <SessionTerminateDialog sessionName="" sessionTitle={null}
    heading={`Fold and close ${request.names.length} sessions?`} confirmLabel="Fold and close"
    pendingLabel="Saving metadata and closing sessions…" onClose={() => setRequest(null)} onTerminate={apply}
    description={<>
      <p>This saves each session’s directory, title and latest recorded coding conversation before closing tmux.
        The fold stays in this workspace with recovery options.</p>
      <p>All windows, panes and running processes in these sessions will end. Other workspaces viewing them will see them closed.</p>
      <ul className="bulk-session-targets" aria-label="Sessions to fold and close">
        {request.names.map((name) => <li key={name}><strong>{name}</strong></li>)}
      </ul>
    </>} />;
  return { foldAndClose, recover, confirmation };
}
