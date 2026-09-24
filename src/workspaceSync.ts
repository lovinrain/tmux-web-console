import type { SavedWorkspace } from "./api";
import {
  normalizeWorkspaceHierarchy,
  normalizeWorkspaceParents,
  type WorkspaceSessionParents,
  type WorkspaceTabGroup,
} from "./workspaceState";

type WorkspaceContents = Pick<SavedWorkspace, "tabs" | "groups" | "parents">;

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rebaseTabs(
  base: readonly string[],
  local: readonly string[],
  remote: readonly string[],
): string[] {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  // A stale tab must not bring back something either browser closed.
  const tabs = remote.filter((tab) => !baseSet.has(tab) || localSet.has(tab));
  const surviving = new Set(tabs);
  const baseCommon = base.filter((tab) => localSet.has(tab));
  const localCommon = local.filter((tab) => baseSet.has(tab));

  if (!sameOrder(baseCommon, localCommon)) {
    // An intentional local reorder wins for shared tabs. Keep remote additions
    // in their current slots so that every retry against this snapshot agrees.
    const reordered = localCommon.filter((tab) => surviving.has(tab));
    let index = 0;
    for (let position = 0; position < tabs.length; position += 1) {
      if (baseSet.has(tabs[position])) tabs[position] = reordered[index++];
    }
  }

  for (let index = 0; index < local.length; index += 1) {
    const tab = local[index];
    if (baseSet.has(tab) || surviving.has(tab)) continue;
    let insertion = -1;
    for (let before = index - 1; before >= 0; before -= 1) {
      const neighbor = tabs.indexOf(local[before]);
      if (neighbor < 0) continue;
      insertion = neighbor + 1;
      break;
    }
    if (insertion < 0) {
      for (let after = index + 1; after < local.length; after += 1) {
        const neighbor = tabs.indexOf(local[after]);
        if (neighbor < 0) continue;
        insertion = neighbor;
        break;
      }
    }
    tabs.splice(insertion < 0 ? tabs.length : insertion, 0, tab);
    surviving.add(tab);
  }
  return tabs;
}

function rebaseParents(
  base: WorkspaceContents,
  local: WorkspaceContents,
  remote: WorkspaceContents,
): WorkspaceSessionParents {
  const baseParents = base.parents ?? {};
  const remoteParents = new Map(Object.entries(normalizeWorkspaceParents(remote.parents, remote.tabs)));
  // Keep ancestry for removed tabs until the final normalization. A child
  // created concurrently with closing its parent can then move to the nearest
  // surviving ancestor without restoring the closed tab.
  const parents = new Map([...Object.entries(baseParents), ...remoteParents]);
  for (const tab of remote.tabs) {
    if (!remoteParents.has(tab)) parents.delete(tab);
  }

  // Closing a parent automatically promotes its children. Compare against the
  // base with that same promotion applied, so it does not masquerade as an
  // intentional reparent and overwrite a concurrent remote edit.
  const baseWithLocalTabs = new Map(Object.entries(normalizeWorkspaceParents(baseParents, local.tabs)));
  const localParents = new Map(Object.entries(normalizeWorkspaceParents(local.parents, local.tabs)));
  for (const tab of local.tabs) {
    const parent = localParents.get(tab);
    if (parent === baseWithLocalTabs.get(tab)) continue;
    if (parent) parents.set(tab, parent);
    else parents.delete(tab);
  }
  return Object.fromEntries(parents);
}

/** Apply edits since base to the latest server snapshot without reviving closed tabs. */
export function rebaseWorkspaceEdits(
  base: WorkspaceContents,
  local: WorkspaceContents,
  remote: WorkspaceContents,
): { tabs: string[]; groups: WorkspaceTabGroup[]; parents?: WorkspaceSessionParents } {
  const tabs = rebaseTabs(base.tabs, local.tabs, remote.tabs);
  const baseGroups = new Map((base.groups ?? []).map((group) => [group.id, group]));
  const localGroups = new Map((local.groups ?? []).map((group) => [group.id, group]));
  const remoteGroups = new Map((remote.groups ?? []).map((group) => [group.id, group]));
  const groups: WorkspaceTabGroup[] = [];

  for (const remoteGroup of remoteGroups.values()) {
    const baseGroup = baseGroups.get(remoteGroup.id);
    const localGroup = localGroups.get(remoteGroup.id);
    if (baseGroup && !localGroup) continue;
    if (!localGroup) {
      groups.push({ ...remoteGroup, tabs: [...remoteGroup.tabs] });
      continue;
    }
    if (!baseGroup) {
      groups.push({ ...localGroup, tabs: rebaseTabs([], localGroup.tabs, remoteGroup.tabs) });
      continue;
    }
    groups.push({
      id: remoteGroup.id,
      name: localGroup.name === baseGroup.name ? remoteGroup.name : localGroup.name,
      color: localGroup.color === baseGroup.color ? remoteGroup.color : localGroup.color,
      collapsed: localGroup.collapsed === baseGroup.collapsed
        ? remoteGroup.collapsed
        : localGroup.collapsed,
      tabs: rebaseTabs(baseGroup.tabs, localGroup.tabs, remoteGroup.tabs),
    });
  }

  for (const localGroup of localGroups.values()) {
    // Deletion of an existing group also wins over stale local metadata edits.
    if (!baseGroups.has(localGroup.id) && !remoteGroups.has(localGroup.id)) {
      groups.push({ ...localGroup, tabs: [...localGroup.tabs] });
    }
  }

  const baseAssignments = new Map(
    [...baseGroups.values()].flatMap((group) => group.tabs.map((tab) => [tab, group.id] as const)),
  );
  const localAssignments = new Map(
    [...localGroups.values()].flatMap((group) => group.tabs.map((tab) => [tab, group.id] as const)),
  );
  // A deliberate assignment takes precedence over a concurrent assignment to
  // another group; otherwise normalization would arbitrarily keep the first one.
  for (const group of groups) {
    group.tabs = group.tabs.filter((tab) => (
      baseAssignments.get(tab) === localAssignments.get(tab)
      || localAssignments.get(tab) === group.id
    ));
  }

  return normalizeWorkspaceHierarchy(tabs, groups, rebaseParents(base, local, remote));
}
