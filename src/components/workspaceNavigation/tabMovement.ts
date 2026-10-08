import { moveWorkspaceSession, type WorkspaceSessionParents, type WorkspaceTabGroup } from "../../workspaceState";

export function tabMoveResultIndex(
  openSessions: readonly string[],
  groups: readonly WorkspaceTabGroup[],
  sessionName: string,
  targetIndex: number,
  parents?: WorkspaceSessionParents,
): number {
  return moveWorkspaceSession({
    openSessions: [...openSessions],
    recentSessions: [],
    groups: [...groups],
    parents,
  }, sessionName, targetIndex).openSessions.indexOf(sessionName);
}

export function tabMoveTargetIndex(
  openSessions: readonly string[],
  group: WorkspaceTabGroup | undefined,
  parents: WorkspaceSessionParents,
  sessionName: string,
  direction: -1 | 1,
): number {
  const parentOf = (name: string) => Object.hasOwn(parents, name) ? parents[name] : undefined;
  const parent = parentOf(sessionName);
  for (
    let index = openSessions.indexOf(sessionName) + direction;
    index >= 0 && index < openSessions.length;
    index += direction
  ) {
    const candidate = openSessions[index];
    if (group && !group.tabs.includes(candidate)) return -1;
    if (parentOf(candidate) === parent) return index;
  }
  return -1;
}
