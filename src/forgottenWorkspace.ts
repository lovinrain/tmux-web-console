import type { WorkspacePaneLayout, WorkspacePaneNode } from "./api";
import { workspacePaneLeaves } from "./workspacePaneLayouts";
import {
  MAX_WORKSPACE_TAB_GROUPS,
  normalizeWorkspaceParents,
  sameWorkspaceParents,
  type SessionWorkspaceState,
  workspaceSessionTreeOrder,
} from "./workspaceState";

function restoredIndex(
  name: string,
  before: readonly string[],
  current: readonly string[],
): number {
  const originalIndex = before.indexOf(name);
  for (let index = originalIndex + 1; index < before.length; index += 1) {
    const neighbor = current.indexOf(before[index]);
    if (neighbor >= 0) return neighbor;
  }
  for (let index = originalIndex - 1; index >= 0; index -= 1) {
    const neighbor = current.indexOf(before[index]);
    if (neighbor >= 0) return neighbor + 1;
  }
  return current.length;
}

function restoreName(
  name: string,
  before: readonly string[],
  current: string[],
): string[] {
  if (!before.includes(name) || current.includes(name)) return current;
  const restored = [...current];
  restored.splice(restoredIndex(name, before, current), 0, name);
  return restored;
}

function survivingAncestor(
  name: string,
  parents: ReadonlyMap<string, string>,
  sessions: ReadonlySet<string>,
): string | undefined {
  let parent = parents.get(name);
  while (parent && !sessions.has(parent)) parent = parents.get(parent);
  return parent;
}

function wouldCreateParentCycle(
  child: string,
  parent: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  let ancestor: string | undefined = parent;
  const visited = new Set<string>();
  while (ancestor && !visited.has(ancestor)) {
    if (ancestor === child) return true;
    visited.add(ancestor);
    ancestor = parents.get(ancestor);
  }
  return false;
}

/** Restore only this forgotten session, retaining later edits to the workspace. */
export function restoreForgottenWorkspaceSession(
  name: string,
  before: SessionWorkspaceState,
  current: SessionWorkspaceState,
): SessionWorkspaceState {
  const recentSessions = restoreName(name, before.recentSessions, current.recentSessions);
  let openSessions = current.openSessions;
  let groups = current.groups;
  let parents = current.parents;

  if (before.openSessions.includes(name) && !openSessions.includes(name)) {
    const originalGroup = before.groups.find((group) => group.tabs.includes(name));
    const currentGroup = originalGroup
      ? groups.find((group) => group.id === originalGroup.id)
      : undefined;
    let insertion = restoredIndex(name, before.openSessions, openSessions);
    if (currentGroup && originalGroup) {
      // The group may have moved since Forget. Follow its surviving members so
      // restoring one member cannot dissolve or move someone else's group.
      const groupIndex = restoredIndex(name, originalGroup.tabs, currentGroup.tabs);
      insertion = groupIndex < currentGroup.tabs.length
        ? openSessions.indexOf(currentGroup.tabs[groupIndex])
        : openSessions.indexOf(currentGroup.tabs.at(-1)!) + 1;
    }
    for (const group of groups) {
      if (group.id === currentGroup?.id) continue;
      const start = openSessions.indexOf(group.tabs[0]);
      const end = start + group.tabs.length;
      if (insertion > start && insertion < end) insertion = end;
    }
    openSessions = [...openSessions];
    openSessions.splice(insertion, 0, name);

    if (currentGroup) {
      groups = groups.map((group) => group.id === currentGroup.id
        ? { ...group, tabs: openSessions.filter((tab) => tab === name || group.tabs.includes(tab)) }
        : group);
    } else if (originalGroup && groups.length < MAX_WORKSPACE_TAB_GROUPS) {
      groups = [...groups, { ...originalGroup, tabs: [name] }];
    }
    groups = [...groups].sort((left, right) => (
      openSessions.indexOf(left.tabs[0]) - openSessions.indexOf(right.tabs[0])
    ));

    const originalParents = new Map(Object.entries(
      normalizeWorkspaceParents(before.parents, before.openSessions),
    ));
    const restoredParents = new Map(Object.entries(
      normalizeWorkspaceParents(current.parents, current.openSessions),
    ));
    const originalSessions = new Set(current.openSessions);
    const restoredSessions = new Set(openSessions);
    const groupFor = (session: string) => groups.find((group) => group.tabs.includes(session))?.id;
    const restoredGroup = groupFor(name);
    const originalParent = survivingAncestor(name, originalParents, restoredSessions);
    if (originalParent && groupFor(originalParent) === restoredGroup) {
      restoredParents.set(name, originalParent);
    }
    for (const child of current.openSessions) {
      // Several ancestors may have been forgotten together. Only reclaim the
      // surviving descendants still in the position caused by that removal.
      if (survivingAncestor(child, originalParents, restoredSessions) !== name
        || restoredParents.get(child) !== survivingAncestor(child, originalParents, originalSessions)
        || groupFor(child) !== restoredGroup
        || wouldCreateParentCycle(child, name, restoredParents)) continue;
      restoredParents.set(child, name);
    }
    const normalizedParents = normalizeWorkspaceParents(Object.fromEntries(restoredParents), openSessions);
    if (!sameWorkspaceParents(normalizedParents, parents)) {
      parents = Object.keys(normalizedParents).length ? normalizedParents : undefined;
    }
    openSessions = workspaceSessionTreeOrder(openSessions, parents);
    groups = groups.map((group) => ({
      ...group,
      tabs: openSessions.filter((session) => group.tabs.includes(session)),
    })).sort((left, right) => (
      openSessions.indexOf(left.tabs[0]) - openSessions.indexOf(right.tabs[0])
    ));
  }

  if (openSessions === current.openSessions
    && recentSessions === current.recentSessions
    && groups === current.groups
    && parents === current.parents) return current;
  const restored = { ...current, openSessions, recentSessions, groups };
  if (parents) restored.parents = parents;
  else delete restored.parents;
  return restored;
}

function restorePane(
  node: WorkspacePaneNode,
  originalPaneIds: ReadonlySet<string>,
  name: string,
): WorkspacePaneNode {
  if (node.kind === "pane") {
    return node.session === null && originalPaneIds.has(node.id)
      ? { ...node, session: name }
      : node;
  }
  const first = restorePane(node.first, originalPaneIds, name);
  const second = restorePane(node.second, originalPaneIds, name);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

/** Refill panes cleared by Forget without replacing layouts edited afterward. */
export function restoreForgottenPaneLayouts(
  name: string,
  beforeLayouts: readonly WorkspacePaneLayout[],
  currentLayouts: readonly WorkspacePaneLayout[],
  tabs: readonly string[],
): WorkspacePaneLayout[] {
  if (!tabs.includes(name)) return [...currentLayouts];
  const originals = new Map(beforeLayouts.map((layout) => [layout.id, layout]));
  return currentLayouts.map((layout) => {
    const original = originals.get(layout.id);
    // Reconciliation clears assignments but never removes layouts or panes.
    // Their removal, reassignment or an explicit move must survive Undo.
    if (!original || workspacePaneLeaves(layout.root).some((pane) => pane.session === name)) {
      return layout;
    }
    const originalPaneIds = new Set(workspacePaneLeaves(original.root)
      .filter((pane) => pane.session === name)
      .map((pane) => pane.id));
    const root = restorePane(layout.root, originalPaneIds, name);
    return root === layout.root ? layout : { ...layout, root };
  });
}
