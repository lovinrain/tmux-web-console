import type { WorkspaceSessionParents, WorkspaceTabGroup } from "./workspaceState";

/** A temporary-looking placeholder, persisted as workspace metadata. */
export interface WorkspaceTabFold {
  id: string;
  /** Sibling branch roots; descendants stay in their original tree. */
  tabs: string[];
  /** Durable recovery snapshots captured before fold-and-close terminates tmux. */
  closedSessions?: WorkspaceFoldSnapshot[];
}

export interface WorkspaceFoldSnapshot {
  name: string;
  historyId: string;
  directory: string;
  title: string | null;
  agentType: "claude" | "codex" | "copilot" | "cursor" | "grok" | null;
  agentSessionId: string | null;
  sessionId: string;
  sessionCreated: number;
  serverStarted: number;
  serverPid: number;
  savedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceFoldSnapshot(value: unknown): value is WorkspaceFoldSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && item.name.length > 0 && item.name.length <= 256
    && typeof item.historyId === "string" && UUID.test(item.historyId)
    && typeof item.directory === "string" && item.directory.startsWith("/") && item.directory.length <= 4096
    && (item.title === null || typeof item.title === "string")
    && (item.agentType === null || ["claude", "codex", "copilot", "cursor", "grok"].includes(item.agentType as string))
    && (item.agentSessionId === null || (item.agentType !== null && typeof item.agentSessionId === "string"
      && item.agentSessionId.length > 0 && item.agentSessionId.length <= 256))
    && typeof item.sessionId === "string" && /^\$\d+$/.test(item.sessionId)
    && ["sessionCreated", "serverStarted", "serverPid", "savedAt"].every((field) => (
      typeof item[field] === "number" && Number.isSafeInteger(item[field]) && (item[field] as number) > 0
    ));
}

export const MAX_WORKSPACE_TAB_FOLDS = 128;
export const WORKSPACE_FOLDS_SEARCH_PARAM = "tab-fold";

interface FoldWorkspace {
  openSessions: readonly string[];
  groups: readonly WorkspaceTabGroup[];
  parents?: WorkspaceSessionParents;
  folds?: WorkspaceTabFold[];
}

function parentOf(name: string, parents?: WorkspaceSessionParents): string | undefined {
  return parents && Object.hasOwn(parents, name) ? parents[name] : undefined;
}

function selectionRoots(workspace: FoldWorkspace, names: readonly string[]): string[] {
  const selected = new Set(names);
  return workspace.openSessions.filter((name) => {
    if (!selected.has(name)) return false;
    const visited = new Set([name]);
    let parent = parentOf(name, workspace.parents);
    while (parent && !visited.has(parent)) {
      if (selected.has(parent)) return false;
      visited.add(parent);
      parent = parentOf(parent, workspace.parents);
    }
    return true;
  });
}

export function workspaceFoldMembers(
  fold: WorkspaceTabFold,
  tabs: readonly string[],
  parents?: WorkspaceSessionParents,
): string[] {
  const roots = new Set(fold.tabs);
  return tabs.filter((name) => {
    let cursor: string | undefined = name;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      if (roots.has(cursor)) return true;
      visited.add(cursor);
      cursor = parentOf(cursor, parents);
    }
    return false;
  });
}

function sameLevel(workspace: FoldWorkspace, roots: readonly string[]): boolean {
  const parent = parentOf(roots[0], workspace.parents);
  const groupId = workspace.groups.find((group) => group.tabs.includes(roots[0]))?.id;
  return roots.every((name) => parentOf(name, workspace.parents) === parent
    && workspace.groups.find((group) => group.tabs.includes(name))?.id === groupId);
}

export function workspaceFoldSelectionError(
  workspace: FoldWorkspace,
  names: readonly string[],
): string | null {
  const roots = selectionRoots(workspace, names);
  const members = workspaceFoldMembers({ id: "selection", tabs: roots }, workspace.openSessions, workspace.parents);
  if (members.length < 2) return "Select at least two tabs to fold.";
  if (!sameLevel(workspace, roots)) return "Choose tabs at the same level under the same parent and in the same group.";
  const selected = new Set(members);
  if (workspace.folds?.some((fold) => workspaceFoldMembers(fold, workspace.openSessions, workspace.parents)
    .some((name) => selected.has(name)))) return "Unfold the existing placeholder before folding these tabs.";
  if ((workspace.folds?.length ?? 0) >= MAX_WORKSPACE_TAB_FOLDS) return "Unfold a placeholder before creating another.";
  return null;
}

export function normalizeWorkspaceTabFolds(
  value: unknown,
  tabs: readonly string[],
  parents?: WorkspaceSessionParents,
  groups: readonly WorkspaceTabGroup[] = [],
): WorkspaceTabFold[] {
  if (!Array.isArray(value)) return [];
  const workspace = { openSessions: tabs, parents, groups };
  const open = new Set(tabs);
  const ids = new Set<string>();
  const hidden = new Set<string>();
  const folds: WorkspaceTabFold[] = [];
  for (const candidate of value.slice(0, MAX_WORKSPACE_TAB_FOLDS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)
      || ids.has(raw.id) || !Array.isArray(raw.tabs)) continue;
    const roots = selectionRoots(workspace, raw.tabs.filter((name): name is string => (
      typeof name === "string" && open.has(name)
    )));
    const fold: WorkspaceTabFold = { id: raw.id, tabs: roots };
    const members = workspaceFoldMembers(fold, tabs, parents);
    if (raw.closedSessions !== undefined) {
      if (!Array.isArray(raw.closedSessions) || !raw.closedSessions.every(isWorkspaceFoldSnapshot)) continue;
      const snapshots = new Map(raw.closedSessions.map((item) => [item.name, item]));
      const saved = members.flatMap((name) => snapshots.has(name) ? [snapshots.get(name)!] : []);
      if (saved.length) fold.closedSessions = saved;
    }
    if (members.length < (fold.closedSessions ? 1 : 2) || !sameLevel(workspace, roots) || members.some((name) => hidden.has(name))) continue;
    ids.add(fold.id);
    members.forEach((name) => hidden.add(name));
    folds.push(fold);
  }
  return folds.sort((left, right) => tabs.indexOf(left.tabs[0]) - tabs.indexOf(right.tabs[0]));
}

export function sameWorkspaceTabFolds(
  left: readonly WorkspaceTabFold[] | undefined,
  right: readonly WorkspaceTabFold[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((fold, index) => fold.id === b[index].id
    && fold.tabs.length === b[index].tabs.length
    && fold.tabs.every((tab, position) => tab === b[index].tabs[position])
    && JSON.stringify(fold.closedSessions ?? []) === JSON.stringify(b[index].closedSessions ?? []));
}

export function withWorkspaceTabFolds<T extends FoldWorkspace>(
  workspace: T,
  value: unknown = workspace.folds,
): T {
  // URL snapshots and older clients only contain fold IDs and roots. Preserve
  // server-held recovery metadata for a surviving placeholder.
  const previous = new Map((workspace.folds ?? []).map((fold) => [fold.id, fold.closedSessions]));
  const candidates = Array.isArray(value) ? value.map((fold) => (
    fold && typeof fold === "object" && !Array.isArray(fold) && !fold.closedSessions && previous.get(fold.id)
      ? { ...fold, closedSessions: previous.get(fold.id) } : fold
  )) : value;
  const folds = normalizeWorkspaceTabFolds(candidates, workspace.openSessions, workspace.parents, workspace.groups);
  if (sameWorkspaceTabFolds(workspace.folds, folds)) return workspace;
  const next = { ...workspace };
  if (folds.length > 0) next.folds = folds;
  else delete next.folds;
  return next;
}

export function foldWorkspaceTabs<T extends FoldWorkspace>(
  workspace: T,
  names: readonly string[],
  id: string,
): T {
  if (workspaceFoldSelectionError(workspace, names)) return workspace;
  return withWorkspaceTabFolds(workspace, [
    ...(workspace.folds ?? []), { id, tabs: selectionRoots(workspace, names) },
  ]);
}

export function unfoldWorkspaceTabs<T extends FoldWorkspace>(workspace: T, id: string): T {
  return withWorkspaceTabFolds(workspace, workspace.folds?.filter((fold) => fold.id !== id));
}

export function revealWorkspaceFold<T extends FoldWorkspace>(workspace: T, name: string): T {
  return withWorkspaceTabFolds(workspace, workspace.folds?.filter((fold) => (
    !workspaceFoldMembers(fold, workspace.openSessions, workspace.parents).includes(name)
  )));
}
