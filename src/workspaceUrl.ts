import { WORKSPACE_FOLDS_SEARCH_PARAM } from "./workspaceFolds";
import {
  searchWithoutWorkspaceTabs,
  WORKSPACE_GROUPS_SEARCH_PARAM,
  WORKSPACE_PARENTS_SEARCH_PARAM,
  WORKSPACE_TAB_SEARCH_PARAM,
} from "./workspaceState";

// Leave room below aiohttp's 8,190-byte request-line limit. Browser fragments
// travel with copied links and history entries, but never reach the HTTP server.
export const MAX_WORKSPACE_REQUEST_TARGET_BYTES = 6 * 1024;
const WORKSPACE_HASH_PREFIX = "#muxdeck-workspace?";
const metadataNames = new Set([
  WORKSPACE_TAB_SEARCH_PARAM,
  WORKSPACE_GROUPS_SEARCH_PARAM,
  WORKSPACE_PARENTS_SEARCH_PARAM,
  WORKSPACE_FOLDS_SEARCH_PARAM,
]);

function queryParts(search: string): string[] {
  return (search.startsWith("?") ? search.slice(1) : search).split("&").filter(Boolean);
}

function isWorkspacePart(part: string): boolean {
  return metadataNames.has(new URLSearchParams(part).keys().next().value ?? "");
}

function ordinaryHash(hash: string): string {
  if (!hash.startsWith(WORKSPACE_HASH_PREFIX)) return hash;
  const anchorIndex = hash.indexOf("#", WORKSPACE_HASH_PREFIX.length);
  return anchorIndex < 0 ? "" : hash.slice(anchorIndex);
}

/** Read legacy query links and large links with browser-only workspace state. */
export function workspaceSearchFromLocation(
  location: { search: string; hash: string },
): string {
  if (!location.hash.startsWith(WORKSPACE_HASH_PREFIX)) return location.search;
  const original = queryParts(
    location.hash.slice(WORKSPACE_HASH_PREFIX.length).split("#", 1)[0],
  );
  const query = queryParts(location.search);
  // Explicit legacy query metadata wins over any stale fragment.
  if (query.some(isWorkspacePart) || !original.some(isWorkspacePart)) return location.search;

  // Retain the logical query's exact ordering for navigation/version guards,
  // while keeping actual query parameters authoritative (including removals).
  const remaining = [...query];
  const parts = original.filter((part) => {
    if (isWorkspacePart(part)) return true;
    const index = remaining.indexOf(part);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
  parts.push(...remaining);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Format a logical workspace query without sending oversized state to HTTP. */
export function workspaceHref(path: string, search: string, hash = ""): string {
  const anchor = ordinaryHash(hash);
  if (new TextEncoder().encode(path + search).byteLength <= MAX_WORKSPACE_REQUEST_TARGET_BYTES
    || !queryParts(search).some(isWorkspacePart)) {
    return `${path}${search}${anchor}`;
  }
  // Keeping the original query in the fragment preserves byte-for-byte ordering;
  // workspaceSearchFromLocation accepts only its workspace fields as authority.
  return `${path}${searchWithoutWorkspaceTabs(search)}${WORKSPACE_HASH_PREFIX}${search.slice(1)}${anchor}`;
}
