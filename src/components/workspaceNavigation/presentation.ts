import type { CSSProperties } from "react";
import { paneCommandKind, sessionDisplayTitle } from "../../sessionDashboardModel";
import { sessionHasOnlyDeadPanes } from "../../sessionLifecycle";
import type { AgentState, Pane, Session } from "../../types";
import { workspaceSessionDepth, type WorkspaceSessionParents } from "../../workspaceState";
import type { WorkspacePersistenceState } from "./types";

export const EMPTY_SESSION_PARENTS: WorkspaceSessionParents = {};

export type WorkspaceSessionState = AgentState | "dead" | "unavailable";

export function workspaceSessionState(session: Session | undefined): WorkspaceSessionState {
  return sessionHasOnlyDeadPanes(session) ? "dead" : session?.agentState ?? "unavailable";
}

export const STATE_LABELS: Record<WorkspaceSessionState, string> = {
  working: "Working",
  running_command: "Command running",
  waiting_human: "Needs input",
  waiting_command: "Background work",
  unknown: "Unclear",
  other: "Other",
  dead: "Dead",
  unavailable: "Unavailable",
};

export const WORKSPACE_PERSISTENCE_COPY: Record<
  Exclude<WorkspacePersistenceState, "unsaved">,
  { label: string; accessibleLabel: string; description: string }
> = {
  saved: {
    label: "Saved",
    accessibleLabel: "Workspace saved automatically",
    description: "Tab order and your active session save automatically.",
  },
  loading: {
    label: "Opening",
    accessibleLabel: "Opening saved workspace",
    description: "Opening this saved workspace from the server.",
  },
  limited: {
    label: "Tabs saved",
    accessibleLabel: "Workspace tabs saved; tab groups are not stored by this server",
    description: "Tabs and your active session save automatically. Tab groups are not stored by this server yet.",
  },
  error: {
    label: "Sync issue",
    accessibleLabel: "Workspace sync issue",
    description: "This saved workspace has a sync issue.",
  },
};

export function workspaceIdentityName(
  workspacePersistenceState: WorkspacePersistenceState,
  workspaceName?: string | null,
): string {
  if (workspacePersistenceState === "unsaved") return "Temporary workspace";
  const normalizedName = workspaceName?.trim();
  if (normalizedName) return normalizedName;
  return workspacePersistenceState === "loading" ? "Opening workspace" : "Saved workspace";
}

export function workspaceIdentityStateLabel(
  workspacePersistenceState: WorkspacePersistenceState,
): string {
  return workspacePersistenceState === "unsaved"
    ? "Not saved"
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState].label;
}

export function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

export function paneLabel(pane?: Pane): string {
  switch (paneCommandKind(pane?.command || "", pane?.title || "")) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "cursor": return "Cursor";
    case "grok": return "Grok";
    case "shells": return "Shell";
    default: return pane?.command || "Process";
  }
}

export function tabTitle(sessionName: string, sessionsByName: Map<string, Session>): string {
  const session = sessionsByName.get(sessionName);
  return session ? sessionDisplayTitle(session) : sessionName;
}

export interface SessionTreeContext {
  depth: number;
  parentName: string;
  parentTitle: string;
  description: string;
}

export function sessionTreeContext(
  sessionName: string,
  parents: WorkspaceSessionParents,
  sessionsByName: Map<string, Session>,
): SessionTreeContext | undefined {
  const depth = workspaceSessionDepth(sessionName, parents);
  const parentName = Object.hasOwn(parents, sessionName) ? parents[sessionName] : undefined;
  if (!depth || !parentName) return undefined;
  const parentTitle = tabTitle(parentName, sessionsByName);
  const parentLabel = parentTitle === parentName ? parentTitle : `${parentTitle} (${parentName})`;
  return {
    depth,
    parentName,
    parentTitle,
    description: `Child of ${parentLabel}. Nesting level ${depth}.`,
  };
}

export function sessionTreeStyle(tree?: SessionTreeContext): CSSProperties | undefined {
  return tree ? { "--workspace-session-depth": tree.depth } as CSSProperties : undefined;
}
