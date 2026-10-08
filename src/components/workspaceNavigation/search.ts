import type { Session } from "../../types";
import type { WorkspaceTabGroup } from "../../workspaceState";
import { tabTitle } from "./presentation";

export interface TabSearchResult {
  sessionName: string;
  title: string;
  session: Session | undefined;
  group: WorkspaceTabGroup | undefined;
  position: number;
  score: number;
}

function searchScore(
  title: string,
  sessionName: string,
  groupName: string | undefined,
  query: string,
): number | null {
  if (!query) return 0;
  const normalizedTitle = title.toLowerCase();
  const normalizedName = sessionName.toLowerCase();
  const normalizedGroup = groupName?.toLowerCase() ?? "";
  if (normalizedTitle === query) return 0;
  if (normalizedName === query) return 1;
  if (normalizedTitle.startsWith(query)) return 2;
  if (normalizedName.startsWith(query)) return 3;
  if (normalizedTitle.includes(query)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedGroup === query) return 6;
  if (normalizedGroup.startsWith(query)) return 7;
  if (normalizedGroup.includes(query)) return 8;
  return null;
}

export function searchWorkspaceTabs(
  openSessions: readonly string[],
  sessionsByName: Map<string, Session>,
  groupsBySession: ReadonlyMap<string, WorkspaceTabGroup>,
  normalizedQuery: string,
): TabSearchResult[] {
  return openSessions
    .map((sessionName, position) => {
      const session = sessionsByName.get(sessionName);
      const title = tabTitle(sessionName, sessionsByName);
      const group = groupsBySession.get(sessionName);
      const score = searchScore(title, sessionName, group?.name, normalizedQuery);
      return score === null
        ? null
        : { sessionName, title, session, group, position, score };
    })
    .filter((result): result is TabSearchResult => result !== null)
    .sort((left, right) => left.score - right.score || left.position - right.position);
}
