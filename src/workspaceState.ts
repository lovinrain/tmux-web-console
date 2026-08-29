export interface SessionWorkspaceState {
  openSessions: string[];
  recentSessions: string[];
  groups: WorkspaceTabGroup[];
}

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

export function searchWithoutWorkspaceTabs(search: string): string {
  const parts = queryParts(search).filter(
    (part) => ![
      WORKSPACE_TAB_SEARCH_PARAM,
      WORKSPACE_GROUPS_SEARCH_PARAM,
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
): string {
  const tabs = uniqueSessionNames(openSessions);
  const parts = queryParts(search).filter((part) => ![
    WORKSPACE_TAB_SEARCH_PARAM,
    WORKSPACE_GROUPS_SEARCH_PARAM,
  ].includes(queryPartName(part)));
  for (const sessionName of tabs) {
    parts.push(`${WORKSPACE_TAB_SEARCH_PARAM}=${encodeURIComponent(sessionName)}`);
  }
  const normalizedGroups = normalizeWorkspaceTabGroups(groups, tabs);
  for (const group of normalizedGroups) {
    parts.push(
      `${WORKSPACE_GROUPS_SEARCH_PARAM}=${encodeURIComponent(JSON.stringify(group))}`,
    );
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function isolatedWorkspaceSearch(
  search: string,
  openSessions: readonly string[] = [],
): string {
  return searchWithSavedWorkspaceId(
    searchWithWorkspaceState(search, openSessions, []),
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

  return { openSessions, recentSessions, groups };
}

export function insertWorkspaceSessionAfter<
  T extends Pick<SessionWorkspaceState, "openSessions" | "groups">,
>(
  workspace: T,
  sourceName: string,
  sessionName: string,
): T {
  if (!sessionName || workspace.openSessions.includes(sessionName)) return workspace;

  const sourceIndex = workspace.openSessions.indexOf(sourceName);
  const openSessions = [...workspace.openSessions];
  openSessions.splice(sourceIndex < 0 ? openSessions.length : sourceIndex + 1, 0, sessionName);

  const sourceGroup = workspace.groups.find((group) => group.tabs.includes(sourceName));
  const groups = sourceGroup
    ? workspace.groups.map((group) => {
        if (group.id !== sourceGroup.id) return group;
        const sourceGroupIndex = group.tabs.indexOf(sourceName);
        const tabs = [...group.tabs];
        tabs.splice(sourceGroupIndex + 1, 0, sessionName);
        return { ...group, tabs };
      })
    : workspace.groups;

  return { ...workspace, openSessions, groups };
}

export function restoreWorkspaceTabs(
  workspace: SessionWorkspaceState,
  activeSession: string | undefined,
  orderedTabs: readonly string[],
  orderedGroups: readonly WorkspaceTabGroup[] = workspace.groups,
): SessionWorkspaceState {
  const openSessions = uniqueSessionNames(orderedTabs);
  if (activeSession && !openSessions.includes(activeSession)) openSessions.push(activeSession);

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
  const groups = normalizeWorkspaceTabGroups(orderedGroups, openSessions);

  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
    && sameGroups(groups, workspace.groups)
  ) return workspace;

  return { openSessions, recentSessions, groups };
}

export function closeWorkspaceSession(
  workspace: SessionWorkspaceState,
  sessionName: string,
): SessionWorkspaceState {
  if (!workspace.openSessions.includes(sessionName)) return workspace;
  const openSessions = workspace.openSessions.filter((name) => name !== sessionName);
  return {
    ...workspace,
    openSessions,
    groups: normalizeWorkspaceTabGroups(workspace.groups, openSessions),
  };
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

export function stableSortWorkspaceSessionsByWorkingState(
  workspace: SessionWorkspaceState,
  workingSessionNames: ReadonlySet<string>,
): SessionWorkspaceState {
  const groupsBySession = new Map<string, WorkspaceTabGroup>();
  for (const group of workspace.groups) {
    for (const sessionName of group.tabs) groupsBySession.set(sessionName, group);
  }

  const blocks: Array<{
    tabs: string[];
    group: WorkspaceTabGroup | null;
    hasWorkingSession: boolean;
  }> = [];
  for (const sessionName of workspace.openSessions) {
    const group = groupsBySession.get(sessionName);
    if (group && group.tabs[0] !== sessionName) continue;
    const originalTabs = group?.tabs ?? [sessionName];
    const tabs = [
      ...originalTabs.filter((name) => !workingSessionNames.has(name)),
      ...originalTabs.filter((name) => workingSessionNames.has(name)),
    ];
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
  const adjacentTabs = adjacentGroup?.tabs ?? [adjacentSession];
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
  if (
    sameSessions(openSessions, workspace.openSessions)
    && sameSessions(recentSessions, workspace.recentSessions)
    && sameGroups(groups, workspace.groups)
  ) return workspace;
  return { openSessions, recentSessions, groups };
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
