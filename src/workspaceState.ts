export interface SessionWorkspaceState {
  openSessions: string[];
  recentSessions: string[];
  groups: WorkspaceTabGroup[];
  parents?: WorkspaceSessionParents;
}

/** Child session name to its parent; hierarchy is workspace metadata only. */
export type WorkspaceSessionParents = Record<string, string>;

export const WORKSPACE_TAB_GROUP_COLORS = [
  "gray",
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
] as const;

export type WorkspaceTabGroupColor = typeof WORKSPACE_TAB_GROUP_COLORS[number];

export interface WorkspaceTabGroup {
  id: string;
  name: string;
  color: WorkspaceTabGroupColor;
  collapsed: boolean;
  tabs: string[];
}

export const EMPTY_SESSION_WORKSPACE: Readonly<SessionWorkspaceState> = {
  openSessions: [],
  recentSessions: [],
  groups: [],
};

const MAX_RECENT_SESSIONS = 30;
export const MAX_WORKSPACE_TAB_GROUPS = 16;
export const MAX_WORKSPACE_TAB_GROUP_ID_LENGTH = 64;
export const MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH = 40;
export const WORKSPACE_TAB_SEARCH_PARAM = "tab";
export const WORKSPACE_GROUPS_SEARCH_PARAM = "tab-group";
export const WORKSPACE_PARENTS_SEARCH_PARAM = "tab-parent";
export const SAVED_WORKSPACE_SEARCH_PARAM = "workspace";

function uniqueSessionNames(sessionNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const sessionName of sessionNames) {
    if (!sessionName || seen.has(sessionName)) continue;
    seen.add(sessionName);
    unique.push(sessionName);
  }
  return unique;
}

function sameSessions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((sessionName, index) => sessionName === right[index]);
}

export function sameWorkspaceParents(
  left: WorkspaceSessionParents | undefined,
  right: WorkspaceSessionParents | undefined,
): boolean {
  const entries = Object.entries(left ?? {});
  return entries.length === Object.keys(right ?? {}).length
    && entries.every(([name, parent]) => Object.hasOwn(right ?? {}, name) && right?.[name] === parent);
}

export function normalizeWorkspaceParents(
  value: unknown,
  openSessions: readonly string[],
): WorkspaceSessionParents {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const open = new Set(openSessions);
  const entries: Array<[string, string]> = [];
  for (const name of openSessions) {
    let cursor = name;
    let parent: string | undefined;
    const visited = new Set([name]);
    while (Object.hasOwn(raw, cursor) && typeof raw[cursor] === "string") {
      cursor = raw[cursor] as string;
      if (visited.has(cursor)) {
        parent = undefined;
        break;
      }
      visited.add(cursor);
      if (!parent && open.has(cursor)) parent = cursor;
    }
    if (parent) entries.push([name, parent]);
  }
  return Object.fromEntries(entries);
}

export function workspaceSessionDepth(
  sessionName: string,
  parents: WorkspaceSessionParents | undefined,
): number {
  let depth = 0;
  const visited = new Set([sessionName]);
  let cursor = sessionName;
  while (parents && Object.hasOwn(parents, cursor)) {
    cursor = parents[cursor];
    if (!cursor || visited.has(cursor)) break;
    visited.add(cursor);
    depth += 1;
  }
  return depth;
}

function workspaceSessionRoot(name: string, parents: WorkspaceSessionParents): string {
  let cursor = name;
  const visited = new Set([name]);
  while (Object.hasOwn(parents, cursor) && !visited.has(parents[cursor])) {
    cursor = parents[cursor];
    visited.add(cursor);
  }
  return cursor;
}

function workspaceSessionParent(name: string, parents?: WorkspaceSessionParents): string | undefined {
  return parents && Object.hasOwn(parents, name) ? parents[name] : undefined;
}

export function workspaceSessionTreeOrder(
  sessionNames: readonly string[],
  parents?: WorkspaceSessionParents,
): string[] {
  const tabs = uniqueSessionNames(sessionNames);
  const normalized = normalizeWorkspaceParents(parents, tabs);
  const children = new Map<string, string[]>();
  for (const name of tabs) {
    if (!Object.hasOwn(normalized, name)) continue;
    const siblings = children.get(normalized[name]) ?? [];
    siblings.push(name);
    children.set(normalized[name], siblings);
  }
  const result: string[] = [];
  const pending = tabs.filter((name) => !Object.hasOwn(normalized, name)).reverse();
  while (pending.length > 0) {
    const name = pending.pop()!;
    result.push(name);
    pending.push(...[...(children.get(name) ?? [])].reverse());
  }
  return result;
}

function workspaceSubtree(
  sessionName: string,
  openSessions: readonly string[],
  parents: WorkspaceSessionParents | undefined,
): string[] {
  return openSessions.filter((name) => {
    let cursor = name;
    const visited = new Set<string>();
    while (!visited.has(cursor)) {
      if (cursor === sessionName) return true;
      visited.add(cursor);
      if (!parents || !Object.hasOwn(parents, cursor)) break;
      cursor = parents[cursor];
    }
    return false;
  });
}

function withWorkspaceParents<T extends object>(value: T, parents: WorkspaceSessionParents): T {
  const result = { ...value } as T & { parents?: WorkspaceSessionParents };
  if (Object.keys(parents).length > 0) result.parents = parents;
  else delete result.parents;
  return result;
}

function sameGroups(
  left: readonly WorkspaceTabGroup[],
  right: readonly WorkspaceTabGroup[],
): boolean {
  return left.length === right.length && left.every((group, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && group.id === candidate.id
      && group.name === candidate.name
      && group.color === candidate.color
      && group.collapsed === candidate.collapsed
      && sameSessions(group.tabs, candidate.tabs);
  });
}

function validWorkspaceTabGroupId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_WORKSPACE_TAB_GROUP_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export function workspaceTabGroupNameError(name: string): string | null {
  const normalized = name.trim();
  if (!normalized) return "Enter a group name.";
  if (normalized.length > MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH) {
    return `Use ${MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH} characters or fewer.`;
  }
  if (/\p{Cc}/u.test(normalized)) {
    return "Group names cannot contain control characters.";
  }
  return null;
}

export function normalizeWorkspaceTabGroups(
  value: unknown,
  openSessions: readonly string[],
): WorkspaceTabGroup[] {
  if (!Array.isArray(value)) return [];
  const openIndex = new Map(openSessions.map((sessionName, index) => [sessionName, index]));
  const colors = new Set<string>(WORKSPACE_TAB_GROUP_COLORS);
  const seenIds = new Set<string>();
  const groupedSessions = new Set<string>();
  const groups: WorkspaceTabGroup[] = [];

  for (const candidate of value.slice(0, MAX_WORKSPACE_TAB_GROUPS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    if (
      !validWorkspaceTabGroupId(raw.id)
      || seenIds.has(raw.id)
      || typeof raw.name !== "string"
      || workspaceTabGroupNameError(raw.name)
      || typeof raw.color !== "string"
      || !colors.has(raw.color)
      || typeof raw.collapsed !== "boolean"
      || !Array.isArray(raw.tabs)
    ) continue;

    const tabs = uniqueSessionNames(
      raw.tabs.filter((tab): tab is string => (
        typeof tab === "string" && openIndex.has(tab) && !groupedSessions.has(tab)
      )),
    ).sort((left, right) => openIndex.get(left)! - openIndex.get(right)!);
    if (tabs.length === 0) continue;
    const indices = tabs.map((tab) => openIndex.get(tab)!);
    if (indices.some((index, position) => position > 0 && index !== indices[0] + position)) {
      continue;
    }

    seenIds.add(raw.id);
    tabs.forEach((tab) => groupedSessions.add(tab));
    groups.push({
      id: raw.id,
      name: raw.name.trim(),
      color: raw.color as WorkspaceTabGroupColor,
      collapsed: raw.collapsed,
      tabs,
    });
  }

  return groups.sort((left, right) => (
    openIndex.get(left.tabs[0])! - openIndex.get(right.tabs[0])!
  ));
}

/** Keep families and named groups contiguous without discarding parent links. */
export function normalizeWorkspaceHierarchy(
  sessionNames: readonly string[],
  groups: readonly WorkspaceTabGroup[],
  value?: WorkspaceSessionParents,
): { tabs: string[]; groups: WorkspaceTabGroup[]; parents?: WorkspaceSessionParents } {
  const parents = normalizeWorkspaceParents(value, sessionNames);
  const tabs = workspaceSessionTreeOrder(sessionNames, parents);
  if (Object.keys(parents).length === 0) {
    return { tabs, groups: normalizeWorkspaceTabGroups(groups, tabs) };
  }
  const available = new Set(tabs);
  const seenGroupIds = new Set<string>();
  const candidates = groups.slice(0, MAX_WORKSPACE_TAB_GROUPS).flatMap((group) => {
    if (seenGroupIds.has(group.id)) return [];
    const members = uniqueSessionNames(group.tabs.filter((name) => available.has(name)));
    // The tree or a concurrent edit may have reordered members; validation
    // still applies, then the whole group is assembled below.
    const normalized = normalizeWorkspaceTabGroups([group], [
      ...members, ...tabs.filter((name) => !members.includes(name)),
    ]);
    if (normalized.length > 0) seenGroupIds.add(group.id);
    return normalized;
  });
  const groupBySession = new Map<string, string>();
  for (const group of candidates) {
    for (const name of group.tabs) {
      if (!groupBySession.has(name)) groupBySession.set(name, group.id);
    }
  }
  const roots = tabs.filter((name) => !Object.hasOwn(parents, name));
  const trees = roots.map((root) => {
    const members = workspaceSubtree(root, tabs, parents);
    return {
      members,
      groupId: groupBySession.get(root),
    };
  });
  const emitted = new Set<string>();
  const orderedTabs: string[] = [];
  const orderedGroups: WorkspaceTabGroup[] = [];
  for (const tree of trees) {
    if (!tree.groupId) {
      orderedTabs.push(...tree.members);
      continue;
    }
    if (emitted.has(tree.groupId)) continue;
    emitted.add(tree.groupId);
    const members = trees.filter((candidate) => candidate.groupId === tree.groupId)
      .flatMap((candidate) => candidate.members);
    orderedTabs.push(...members);
    orderedGroups.push({ ...candidates.find((group) => group.id === tree.groupId)!, tabs: members });
  }
  return { tabs: orderedTabs, groups: orderedGroups, parents };
}

function queryParts(search: string): string[] {
  const rawSearch = search.startsWith("?") ? search.slice(1) : search;
  return rawSearch ? rawSearch.split("&").filter(Boolean) : [];
}

function queryPartName(part: string): string {
  const separator = part.indexOf("=");
  const rawName = separator < 0 ? part : part.slice(0, separator);
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    return rawName;
  }
}

export function workspaceTabsFromSearch(
  search: string,
  activeSession?: string,
): string[] {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tabs = uniqueSessionNames(params.getAll(WORKSPACE_TAB_SEARCH_PARAM));
  if (activeSession && !tabs.includes(activeSession)) tabs.push(activeSession);
  return tabs;
}

export function workspaceGroupsFromSearch(
  search: string,
  openSessions: readonly string[],
): WorkspaceTabGroup[] {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const groups: unknown[] = [];
  for (const serialized of params.getAll(WORKSPACE_GROUPS_SEARCH_PARAM)) {
    try {
      groups.push(JSON.parse(serialized));
    } catch {
      // Malformed group entries are discarded during URL canonicalization.
    }
  }
  return normalizeWorkspaceTabGroups(groups, openSessions);
}

export function workspaceParentsFromSearch(
  search: string,
  openSessions: readonly string[],
): WorkspaceSessionParents {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  try {
    return normalizeWorkspaceParents(JSON.parse(params.get(WORKSPACE_PARENTS_SEARCH_PARAM) ?? "null"), openSessions);
  } catch {
    return {};
  }
}

export function searchWithoutWorkspaceTabs(search: string): string {
  const parts = queryParts(search).filter(
    (part) => ![
      WORKSPACE_TAB_SEARCH_PARAM,
      WORKSPACE_GROUPS_SEARCH_PARAM,
      WORKSPACE_PARENTS_SEARCH_PARAM,
    ].includes(queryPartName(part)),
  );
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function savedWorkspaceIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(SAVED_WORKSPACE_SEARCH_PARAM) || null;
}

export function searchWithSavedWorkspaceId(
  search: string,
  workspaceId: string | null,
): string {
  const parts = queryParts(search).filter(
    (part) => queryPartName(part) !== SAVED_WORKSPACE_SEARCH_PARAM,
  );
  if (workspaceId) {
    parts.push(`${SAVED_WORKSPACE_SEARCH_PARAM}=${encodeURIComponent(workspaceId)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function searchWithWorkspaceTabs(
  search: string,
  openSessions: readonly string[],
): string {
  return searchWithWorkspaceState(
    search,
    openSessions,
    workspaceGroupsFromSearch(search, openSessions),
  );
}

export function searchWithWorkspaceState(
  search: string,
  openSessions: readonly string[],
  groups: readonly WorkspaceTabGroup[],
  parents: WorkspaceSessionParents = workspaceParentsFromSearch(search, openSessions),
): string {
  const hierarchy = normalizeWorkspaceHierarchy(openSessions, groups, parents);
  const tabs = hierarchy.tabs;
  const parts = queryParts(search).filter((part) => ![
    WORKSPACE_TAB_SEARCH_PARAM,
    WORKSPACE_GROUPS_SEARCH_PARAM,
    WORKSPACE_PARENTS_SEARCH_PARAM,
  ].includes(queryPartName(part)));
  for (const sessionName of tabs) {
    parts.push(`${WORKSPACE_TAB_SEARCH_PARAM}=${encodeURIComponent(sessionName)}`);
  }
  for (const group of hierarchy.groups) {
    parts.push(
      `${WORKSPACE_GROUPS_SEARCH_PARAM}=${encodeURIComponent(JSON.stringify(group))}`,
    );
  }
  if (hierarchy.parents) {
    parts.push(`${WORKSPACE_PARENTS_SEARCH_PARAM}=${encodeURIComponent(JSON.stringify(hierarchy.parents))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function isolatedWorkspaceSearch(
  search: string,
  openSessions: readonly string[] = [],
): string {
  return searchWithSavedWorkspaceId(
    searchWithWorkspaceState(search, openSessions, [], {}),
    null,
  );
}

export function createSessionWorkspace(activeSession?: string): SessionWorkspaceState {
  if (!activeSession) return { openSessions: [], recentSessions: [], groups: [] };
  return { openSessions: [activeSession], recentSessions: [activeSession], groups: [] };
}

export function visitWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  const openSessions = workspace.openSessions.includes(sessionName)
    ? workspace.openSessions
    : [...workspace.openSessions, sessionName];
  const recentSessions = [
    sessionName,
    ...workspace.recentSessions.filter((name) => name !== sessionName),
  ].slice(0, MAX_RECENT_SESSIONS);
  const groups = workspace.groups.map((group) => (
    group.collapsed && group.tabs.includes(sessionName)
      ? { ...group, collapsed: false }
      : group
  ));

  if (
    openSessions === workspace.openSessions
    && recentSessions.length === workspace.recentSessions.length
    && recentSessions.every((name, index) => name === workspace.recentSessions[index])
    && sameGroups(groups, workspace.groups)
  ) return workspace;

  return { ...workspace, openSessions, recentSessions, groups };
}

export function insertWorkspaceSessionAfter<
  T extends Pick<SessionWorkspaceState, "openSessions" | "groups" | "parents">,
>(
  workspace: T,
  sourceName: string,
  sessionName: string,
  placement: "sibling" | "child" = "sibling",
): T {
  if (!sessionName || workspace.openSessions.includes(sessionName)) return workspace;

  const sourceIndex = workspace.openSessions.indexOf(sourceName);
  const openSessions = [...workspace.openSessions];
  const subtree = workspaceSubtree(sourceName, openSessions, workspace.parents);
  const insertionIndex = sourceIndex < 0
    ? openSessions.length
    : Math.max(...subtree.map((name) => openSessions.indexOf(name))) + 1;
  openSessions.splice(insertionIndex, 0, sessionName);
  const parents = normalizeWorkspaceParents(workspace.parents, openSessions);
  if (sourceIndex >= 0) {
    const parent = placement === "child" ? sourceName : workspaceSessionParent(sourceName, parents);
    if (parent) Object.defineProperty(parents, sessionName, {
      value: parent, enumerable: true, writable: true, configurable: true,
    });
  }

  const sourceGroup = workspace.groups.find((group) => group.tabs.includes(sourceName));
  const groups = sourceGroup
    ? workspace.groups.map((group) => {
        if (group.id !== sourceGroup.id) return group;
        const tabs = openSessions.filter((name) => name === sessionName || group.tabs.includes(name));
        return { ...group, tabs };
      })
    : workspace.groups;

  return withWorkspaceParents({ ...workspace, openSessions, groups }, parents);
}

export function restoreWorkspaceTabs(
  workspace: SessionWorkspaceState,
  activeSession: string | undefined,
  orderedTabs: readonly string[],
  orderedGroups: readonly WorkspaceTabGroup[] = workspace.groups,
  orderedParents: WorkspaceSessionParents | undefined = workspace.parents,
): SessionWorkspaceState {
  const requestedTabs = uniqueSessionNames(orderedTabs);
  if (activeSession && !requestedTabs.includes(activeSession)) requestedTabs.push(activeSession);
  const hierarchy = normalizeWorkspaceHierarchy(requestedTabs, orderedGroups, orderedParents);
  const openSessions = hierarchy.tabs;

  let recentSessions = [...workspace.recentSessions];
  for (const sessionName of [...openSessions].reverse()) {
    if (!recentSessions.includes(sessionName)) recentSessions.push(sessionName);
  }
  if (activeSession) {
    recentSessions = [
      activeSession,
      ...recentSessions.filter((sessionName) => sessionName !== activeSession),
    ];
  }
  recentSessions = recentSessions.slice(0, MAX_RECENT_SESSIONS);
  const groups = hierarchy.groups;

  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
    && sameGroups(groups, workspace.groups)
    && sameWorkspaceParents(hierarchy.parents, workspace.parents)
  ) return workspace;

  return withWorkspaceParents({ openSessions, recentSessions, groups }, hierarchy.parents ?? {});
}

export function closeWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  if (!workspace.openSessions.includes(sessionName)) return workspace;
  const openSessions = workspace.openSessions.filter((name) => name !== sessionName);
  return withWorkspaceParents({
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(workspace.groups, openSessions),
  }, normalizeWorkspaceParents(workspace.parents, openSessions));
}

export function removeWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  const closed = closeWorkspaceSession(workspace, sessionName);
  const recentSessions = closed.recentSessions.filter((name) => name !== sessionName);
  if (closed === workspace && recentSessions.length === workspace.recentSessions.length) {
    return workspace;
  }
  return { ...closed, recentSessions };
}

export function moveWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
  targetIndex: number,
): SessionWorkspaceState {
  const currentIndex = workspace.openSessions.indexOf(sessionName);
  if (currentIndex < 0 || !Number.isInteger(targetIndex)) return workspace;

  const boundedTargetIndex = Math.max(
    0,
    Math.min(targetIndex, workspace.openSessions.length - 1),
  );
  if (currentIndex === boundedTargetIndex) return workspace;

  const openSessions = [...workspace.openSessions];
  const targetSession = openSessions[boundedTargetIndex];
  const sourceGroup = workspace.groups.find((group) => group.tabs.includes(sessionName));
  const targetGroup = workspace.groups.find((group) => group.tabs.includes(targetSession));
  if (sourceGroup && sourceGroup.id !== targetGroup?.id) return workspace;
  if (workspace.parents && Object.keys(workspace.parents).length > 0) {
    const parents = workspace.parents;
    const subtree = workspaceSubtree(sessionName, openSessions, parents);
    if (subtree.includes(targetSession)) return workspace;
    const sourceParent = workspaceSessionParent(sessionName, parents);
    let targetRoot = targetSession;
    const visited = new Set<string>();
    while (workspaceSessionParent(targetRoot, parents) !== sourceParent) {
      if (!Object.hasOwn(parents, targetRoot) || visited.has(targetRoot)) return workspace;
      visited.add(targetRoot);
      targetRoot = parents[targetRoot];
    }
    if (targetRoot === sessionName) return workspace;
    const targetBlock = !sourceGroup && targetGroup
      ? targetGroup.tabs
      : workspaceSubtree(targetRoot, openSessions, parents);
    const remaining = openSessions.filter((name) => !subtree.includes(name));
    const insertion = currentIndex < boundedTargetIndex
      ? remaining.indexOf(targetBlock.at(-1)!) + 1
      : remaining.indexOf(targetBlock[0]);
    remaining.splice(insertion, 0, ...subtree);
    if (sameSessions(remaining, workspace.openSessions)) return workspace;
    return {
      ...workspace,
      openSessions: remaining,
      groups: normalizeWorkspaceTabGroups(workspace.groups, remaining),
    };
  }
  const adjustedTargetIndex = !sourceGroup && targetGroup
    ? currentIndex < boundedTargetIndex
      ? workspace.openSessions.indexOf(targetGroup.tabs.at(-1)!)
      : workspace.openSessions.indexOf(targetGroup.tabs[0])
    : boundedTargetIndex;
  const [movedSession] = openSessions.splice(currentIndex, 1);
  openSessions.splice(adjustedTargetIndex, 0, movedSession);
  return {
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(workspace.groups, openSessions),
  };
}

export function expandWorkspaceTabSelection(
  openSessions: readonly string[],
  groups: readonly WorkspaceTabGroup[],
  sessionNames: readonly string[],
  parents?: WorkspaceSessionParents,
): string[] {
  const openSet = new Set(openSessions);
  const selected = new Set(sessionNames.filter((sessionName) => openSet.has(sessionName)));
  let previousSize = -1;
  while (previousSize !== selected.size) {
    previousSize = selected.size;
    for (const sessionName of selected) {
      workspaceSubtree(sessionName, openSessions, parents).forEach((name) => selected.add(name));
    }
    for (const group of groups) {
      if (!group.tabs.some((sessionName) => selected.has(sessionName))) continue;
      group.tabs.forEach((sessionName) => {
        if (openSet.has(sessionName)) selected.add(sessionName);
      });
    }
  }
  return openSessions.filter((sessionName) => selected.has(sessionName));
}

export function moveWorkspaceSessions(
  workspace: SessionWorkspaceState,
  sessionNames: readonly string[],
  targetIndex: number,
): SessionWorkspaceState {
  if (!Number.isInteger(targetIndex)) return workspace;
  const selectedTabs = expandWorkspaceTabSelection(
    workspace.openSessions,
    workspace.groups,
    sessionNames,
    workspace.parents,
  );
  if (selectedTabs.length === 0) return workspace;

  const selected = new Set(selectedTabs);
  const remainingTabs = workspace.openSessions.filter((sessionName) => !selected.has(sessionName));
  let insertionIndex = Math.max(0, Math.min(targetIndex, remainingTabs.length));

  // A caller cannot split a non-selected named group. Snap to the side the
  // selected block approaches from if an insertion lands inside one.
  const firstSelectedIndex = workspace.openSessions.indexOf(selectedTabs[0]);
  for (const group of workspace.groups) {
    if (selected.has(group.tabs[0])) continue;
    const start = remainingTabs.indexOf(group.tabs[0]);
    const end = start + group.tabs.length;
    if (start < 0 || insertionIndex <= start || insertionIndex >= end) continue;
    const originalGroupStart = workspace.openSessions.indexOf(group.tabs[0]);
    insertionIndex = originalGroupStart > firstSelectedIndex ? end : start;
    break;
  }

  for (const root of remainingTabs.filter((name) => !workspaceSessionParent(name, workspace.parents))) {
    const originalTree = workspaceSubtree(root, workspace.openSessions, workspace.parents);
    if (originalTree.some((name) => selected.has(name))) continue;
    const start = remainingTabs.indexOf(root);
    const end = start + originalTree.length;
    if (insertionIndex <= start || insertionIndex >= end) continue;
    insertionIndex = workspace.openSessions.indexOf(root) > firstSelectedIndex ? end : start;
    break;
  }

  const openSessions = workspaceSessionTreeOrder([
    ...remainingTabs.slice(0, insertionIndex),
    ...selectedTabs,
    ...remainingTabs.slice(insertionIndex),
  ], workspace.parents);
  if (sameSessions(openSessions, workspace.openSessions)) return workspace;
  return {
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(workspace.groups, openSessions),
  };
}

export function stableSortWorkspaceSessionsByWorkingState(
  workspace: SessionWorkspaceState,
  workingSessionNames: ReadonlySet<string>,
): SessionWorkspaceState {
  const groupsBySession = new Map<string, WorkspaceTabGroup>();
  for (const group of workspace.groups) {
    for (const sessionName of group.tabs) groupsBySession.set(sessionName, group);
  }

  const sortedTreeBlocks = (members: readonly string[]): string[] => {
    const memberSet = new Set(members);
    const roots = members.filter((name) => !memberSet.has(workspaceSessionParent(name, workspace.parents) ?? ""));
    const trees = roots.map((name) => workspaceSubtree(name, members, workspace.parents));
    return [
      ...trees.filter((tree) => !tree.some((name) => workingSessionNames.has(name))),
      ...trees.filter((tree) => tree.some((name) => workingSessionNames.has(name))),
    ].flat();
  };

  const blocks: Array<{
    tabs: string[];
    group: WorkspaceTabGroup | null;
    hasWorkingSession: boolean;
  }> = [];
  for (const sessionName of workspace.openSessions) {
    const group = groupsBySession.get(sessionName);
    if (group && group.tabs[0] !== sessionName) continue;
    if (!group && workspaceSessionParent(sessionName, workspace.parents)) continue;
    const originalTabs = group?.tabs ?? workspaceSubtree(sessionName, workspace.openSessions, workspace.parents);
    const tabs = sortedTreeBlocks(originalTabs);
    blocks.push({
      tabs,
      group: group ? { ...group, tabs } : null,
      hasWorkingSession: originalTabs.some((name) => workingSessionNames.has(name)),
    });
  }

  // Explicit tab groups remain atomic; a group with any working member joins the
  // working partition, while its own members receive the same stable partition.
  const sortedBlocks = [
    ...blocks.filter((block) => !block.hasWorkingSession),
    ...blocks.filter((block) => block.hasWorkingSession),
  ];
  const openSessions = sortedBlocks.flatMap((block) => block.tabs);
  const groups = sortedBlocks.flatMap((block) => block.group ? [block.group] : []);

  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameGroups(groups, workspace.groups)
  ) return workspace;
  return { ...workspace, openSessions, groups };
}

export function setWorkspaceTabGroup(
  workspace: SessionWorkspaceState,
  candidate: WorkspaceTabGroup,
): SessionWorkspaceState {
  if (
    !validWorkspaceTabGroupId(candidate.id)
    || workspaceTabGroupNameError(candidate.name)
    || !WORKSPACE_TAB_GROUP_COLORS.includes(candidate.color)
    || typeof candidate.collapsed !== "boolean"
  ) return workspace;

  const selected = new Set(candidate.tabs.filter((tab) => (
    workspace.openSessions.includes(tab)
  )));
  if (workspace.parents) {
    for (const tab of selected) {
      const root = workspaceSessionRoot(tab, workspace.parents);
      workspaceSubtree(root, workspace.openSessions, workspace.parents)
        .forEach((name) => selected.add(name));
    }
  }
  if (selected.size === 0) return workspace;
  const selectedTabs = workspace.openSessions.filter((tab) => selected.has(tab));
  const currentGroup = workspace.groups.find((group) => group.id === candidate.id);
  const anchor = currentGroup
    ? workspace.openSessions.indexOf(currentGroup.tabs[0])
    : Math.min(...selectedTabs.map((tab) => workspace.openSessions.indexOf(tab)));
  let insertionIndex = workspace.openSessions
    .slice(0, anchor)
    .filter((tab) => !selected.has(tab)).length;
  const openSessions = workspace.openSessions.filter((tab) => !selected.has(tab));
  const groups = workspace.groups.flatMap((group) => {
    if (group.id === candidate.id) return [];
    const tabs = group.tabs.filter((tab) => !selected.has(tab));
    return tabs.length > 0 ? [{ ...group, tabs }] : [];
  });

  // Moving a middle member out of another group must not insert the new block
  // back between that group's remaining members.
  for (const group of groups) {
    const start = openSessions.indexOf(group.tabs[0]);
    const end = start + group.tabs.length;
    if (insertionIndex > start && insertionIndex < end) insertionIndex = end;
  }
  openSessions.splice(insertionIndex, 0, ...selectedTabs);

  groups.push({
    id: candidate.id,
    name: candidate.name.trim(),
    color: candidate.color,
    collapsed: candidate.collapsed,
    tabs: selectedTabs,
  });

  return {
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(groups, openSessions),
  };
}

export function removeWorkspaceTabGroup(
  workspace: SessionWorkspaceState,
  groupId: string,
): SessionWorkspaceState {
  if (!workspace.groups.some((group) => group.id === groupId)) return workspace;
  return {
    ...workspace,
    groups: workspace.groups.filter((group) => group.id !== groupId),
  };
}

export function setWorkspaceTabGroupCollapsed(
  workspace: SessionWorkspaceState,
  groupId: string,
  collapsed: boolean,
): SessionWorkspaceState {
  let changed = false;
  const groups = workspace.groups.map((group) => {
    if (group.id !== groupId || group.collapsed === collapsed) return group;
    changed = true;
    return { ...group, collapsed };
  });
  return changed ? { ...workspace, groups } : workspace;
}

export function moveWorkspaceTabGroup(
  workspace: SessionWorkspaceState,
  groupId: string,
  direction: -1 | 1,
): SessionWorkspaceState {
  const group = workspace.groups.find((candidate) => candidate.id === groupId);
  if (!group) return workspace;
  const start = workspace.openSessions.indexOf(group.tabs[0]);
  const end = start + group.tabs.length - 1;
  if ((direction < 0 && start === 0) || (direction > 0 && end >= workspace.openSessions.length - 1)) {
    return workspace;
  }

  const adjacentIndex = direction < 0 ? start - 1 : end + 1;
  const adjacentSession = workspace.openSessions[adjacentIndex];
  const adjacentGroup = workspace.groups.find((candidate) => (
    candidate.tabs.includes(adjacentSession)
  ));
  const adjacentTabs = adjacentGroup?.tabs ?? workspaceSubtree(
    workspaceSessionRoot(adjacentSession, workspace.parents ?? {}),
    workspace.openSessions,
    workspace.parents,
  );
  const blockStart = direction < 0 ? start - adjacentTabs.length : start;
  const blockLength = group.tabs.length + adjacentTabs.length;
  const openSessions = [...workspace.openSessions];
  openSessions.splice(blockStart, blockLength);
  openSessions.splice(
    blockStart,
    0,
    ...(direction < 0
      ? [...group.tabs, ...adjacentTabs]
      : [...adjacentTabs, ...group.tabs]),
  );
  if (sameSessions(openSessions, workspace.openSessions)) return workspace;
  return {
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(workspace.groups, openSessions),
  };
}

export function renameWorkspaceSession(
  workspace: SessionWorkspaceState,
  previousName: string,
  nextName: string,
): SessionWorkspaceState {
  if (!previousName || !nextName || previousName === nextName) return workspace;

  const rename = (sessionNames: readonly string[]) => {
    const sourcePresent = sessionNames.includes(previousName);
    return uniqueSessionNames(
      sessionNames
        .filter((sessionName) => !sourcePresent || sessionName !== nextName)
        .map((sessionName) => (
          sessionName === previousName ? nextName : sessionName
        )),
    );
  };
  const openSessions = rename(workspace.openSessions);
  const recentSessions = rename(workspace.recentSessions);
  const sourcePresent = workspace.openSessions.includes(previousName);
  const sourceGroupId = workspace.groups.find((group) => (
    group.tabs.includes(previousName)
  ))?.id;
  const groups = normalizeWorkspaceTabGroups(
    workspace.groups.map((group) => ({
      ...group,
      // A stale tab already using the target name must not steal the real
      // renamed session's group membership during collision deduplication.
      tabs: rename(group.tabs.filter((tab) => !(
        sourcePresent
        && tab === nextName
        && group.id !== sourceGroupId
      ))),
    })),
    openSessions,
  );
  // A stale destination tab is closed before renaming the real source. Its
  // children retain their own ancestry instead of attaching to the source.
  const collisionFreeParents = normalizeWorkspaceParents(
    workspace.parents,
    workspace.openSessions.filter((name) => !sourcePresent || name !== nextName),
  );
  const parents = normalizeWorkspaceParents(Object.fromEntries(
    Object.entries(collisionFreeParents)
      .map(([name, parent]) => [
        name === previousName ? nextName : name,
        parent === previousName ? nextName : parent,
      ]),
  ), openSessions);
  const hierarchy = normalizeWorkspaceHierarchy(openSessions, groups, parents);
  if (
    sameSessions(hierarchy.tabs, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
    && sameGroups(hierarchy.groups, workspace.groups)
    && sameWorkspaceParents(hierarchy.parents, workspace.parents)
  ) return workspace;
  return withWorkspaceParents({
    openSessions: hierarchy.tabs, recentSessions, groups: hierarchy.groups,
  }, hierarchy.parents ?? {});
}

export function clearClosedWorkspaceHistory(
  workspace: SessionWorkspaceState,
): SessionWorkspaceState {
  const open = new Set(workspace.openSessions);
  const recentSessions = workspace.recentSessions.filter((name) => open.has(name));
  if (recentSessions.length === workspace.recentSessions.length) return workspace;
  return { ...workspace, recentSessions };
}

export function sessionAfterClose(
  openSessions: readonly string[],
  closingSession: string,
): string | null {
  const closingIndex = openSessions.indexOf(closingSession);
  if (closingIndex < 0) return null;
  const remaining = openSessions.filter((name) => name !== closingSession);
  if (remaining.length === 0) return null;
  return remaining[Math.min(closingIndex, remaining.length - 1)];
}
