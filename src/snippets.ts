import type { SnippetFolder, SnippetLeaf, SnippetNode } from "./types";

export interface SnippetSearchEntry {
  snippet: SnippetLeaf;
  path: string[];
}

export interface FolderOption {
  id: string | null;
  label: string;
  depth: number;
}

export function parseSnippetAliases(value: string): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const alias of value.split(/[\s,]+/u).filter(Boolean)) {
    if (/\p{Cc}|\p{Cf}/u.test(alias)) {
      throw new Error("Shortcuts cannot contain control characters.");
    }
    if ([...alias].length > 32) {
      throw new Error("Each shortcut can contain up to 32 characters.");
    }
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  if (aliases.length > 8) throw new Error("Use up to 8 shortcuts per snippet.");
  return aliases;
}

function normalizeSnippetSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function snippetFuzzyScore(query: string, value: string): number | null {
  if (value === query) return 5_000;
  if (value.startsWith(query)) return 4_000 - [...value].length;
  const substringIndex = value.indexOf(query);
  if (substringIndex >= 0) return 3_000 - substringIndex - [...value].length;

  const wanted = [...query];
  const candidate = [...value];
  let queryIndex = 0;
  let previousMatch = -1;
  let score = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== wanted[queryIndex]) continue;
    score += index === previousMatch + 1 ? 20 : 1;
    if (index === 0 || /[\s_-]/u.test(candidate[index - 1])) score += 10;
    score -= index - previousMatch - 1;
    previousMatch = index;
    queryIndex += 1;
    if (queryIndex === wanted.length) return score - candidate.length;
  }
  return null;
}

/** Rank shortcuts ahead of title matches, with stable ordering for equally good matches. */
export function searchSnippets(entries: SnippetSearchEntry[], query: string): SnippetSearchEntry[] {
  const normalizedQuery = normalizeSnippetSearch(query);
  if (!normalizedQuery) return entries;
  return entries.flatMap((entry, index) => {
    const aliases = (entry.snippet.aliases ?? []).map(normalizeSnippetSearch);
    let rank: number;
    let score = 0;
    if (aliases.some((alias) => alias === normalizedQuery)) {
      rank = 0;
    } else {
      const prefixes = aliases.filter((alias) => alias.startsWith(normalizedQuery));
      const aliasScores = aliases.flatMap((alias) => {
        const matched = snippetFuzzyScore(normalizedQuery, alias);
        return matched === null ? [] : [matched];
      });
      const titleScore = snippetFuzzyScore(normalizedQuery, normalizeSnippetSearch(entry.snippet.name));
      if (prefixes.length) {
        rank = 1;
        score = -Math.min(...prefixes.map((alias) => [...alias].length));
      } else if (aliasScores.length) {
        rank = 2;
        score = Math.max(...aliasScores);
      } else if (titleScore !== null) {
        rank = 3;
        score = titleScore;
      } else if (normalizeSnippetSearch(`${entry.path.join(" ")} ${entry.snippet.text}`).includes(normalizedQuery)) {
        rank = 4;
      } else {
        return [];
      }
    }
    return [{ entry, rank, score, index }];
  }).sort((left, right) => left.rank - right.rank || right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
}

export function newSnippetId(prefix: "folder" | "snippet"): string {
  const randomId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

export function findSnippetNode(nodes: SnippetNode[], id: string): SnippetNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === "folder") {
      const found = findSnippetNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function findSnippetFolder(
  nodes: SnippetNode[],
  id: string | null,
): SnippetFolder | null {
  if (id === null) return null;
  const node = findSnippetNode(nodes, id);
  return node?.type === "folder" ? node : null;
}

export function childrenForFolder(nodes: SnippetNode[], id: string | null): SnippetNode[] {
  if (id === null) return nodes;
  return findSnippetFolder(nodes, id)?.children ?? [];
}

export function snippetFolderPath(nodes: SnippetNode[], id: string | null): SnippetFolder[] {
  if (id === null) return [];

  const walk = (items: SnippetNode[], path: SnippetFolder[]): SnippetFolder[] | null => {
    for (const item of items) {
      if (item.type !== "folder") continue;
      const nextPath = [...path, item];
      if (item.id === id) return nextPath;
      const nested = walk(item.children, nextPath);
      if (nested) return nested;
    }
    return null;
  };

  return walk(nodes, []) ?? [];
}

export function flattenSnippets(
  nodes: SnippetNode[],
  path: string[] = [],
): SnippetSearchEntry[] {
  return nodes.flatMap((node) => {
    if (node.type === "snippet") return [{ snippet: node, path }];
    return flattenSnippets(node.children, [...path, node.name]);
  });
}

export function folderOptions(
  nodes: SnippetNode[],
  excludedIds: Set<string> = new Set(),
): FolderOption[] {
  const options: FolderOption[] = [{ id: null, label: "Library root", depth: 0 }];
  const walk = (items: SnippetNode[], path: string[]) => {
    for (const item of items) {
      if (item.type !== "folder" || excludedIds.has(item.id)) continue;
      const nextPath = [...path, item.name];
      options.push({ id: item.id, label: nextPath.join(" / "), depth: path.length + 1 });
      walk(item.children, nextPath);
    }
  };
  walk(nodes, []);
  return options;
}

export function descendantFolderIds(node: SnippetNode): Set<string> {
  const ids = new Set<string>();
  if (node.type !== "folder") return ids;
  ids.add(node.id);
  for (const child of node.children) {
    for (const id of descendantFolderIds(child)) ids.add(id);
  }
  return ids;
}

export function insertSnippetNode(
  nodes: SnippetNode[],
  parentId: string | null,
  node: SnippetNode,
): SnippetNode[] {
  if (parentId === null) return [...nodes, node];
  let inserted = false;
  const next = nodes.map((item): SnippetNode => {
    if (item.type !== "folder") return item;
    if (item.id === parentId) {
      inserted = true;
      return { ...item, children: [...item.children, node] };
    }
    const children = insertIntoNestedFolder(item.children, parentId, node);
    if (children !== item.children) {
      inserted = true;
      return { ...item, children };
    }
    return item;
  });
  if (!inserted) throw new Error("The destination folder no longer exists.");
  return next;
}

function insertIntoNestedFolder(
  nodes: SnippetNode[],
  parentId: string,
  node: SnippetNode,
): SnippetNode[] {
  for (let index = 0; index < nodes.length; index += 1) {
    const item = nodes[index];
    if (item.type !== "folder") continue;
    if (item.id === parentId) {
      const copy = [...nodes];
      copy[index] = { ...item, children: [...item.children, node] };
      return copy;
    }
    const children = insertIntoNestedFolder(item.children, parentId, node);
    if (children !== item.children) {
      const copy = [...nodes];
      copy[index] = { ...item, children };
      return copy;
    }
  }
  return nodes;
}

export function updateSnippetNode(
  nodes: SnippetNode[],
  id: string,
  update: (node: SnippetNode) => SnippetNode,
): SnippetNode[] {
  let changed = false;
  const next = nodes.map((node): SnippetNode => {
    if (node.id === id) {
      changed = true;
      return update(node);
    }
    if (node.type === "folder") {
      const children = updateSnippetNode(node.children, id, update);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

interface RemovalResult {
  tree: SnippetNode[];
  removed: SnippetNode | null;
}

export function removeSnippetNode(nodes: SnippetNode[], id: string): RemovalResult {
  const directIndex = nodes.findIndex((node) => node.id === id);
  if (directIndex >= 0) {
    return {
      tree: nodes.filter((_, index) => index !== directIndex),
      removed: nodes[directIndex],
    };
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type !== "folder") continue;
    const nested = removeSnippetNode(node.children, id);
    if (nested.removed) {
      const tree = [...nodes];
      tree[index] = { ...node, children: nested.tree };
      return { tree, removed: nested.removed };
    }
  }
  return { tree: nodes, removed: null };
}

export function moveSnippetNode(
  nodes: SnippetNode[],
  id: string,
  destinationFolderId: string | null,
): SnippetNode[] {
  const node = findSnippetNode(nodes, id);
  if (!node) throw new Error("The item no longer exists.");
  if (descendantFolderIds(node).has(destinationFolderId ?? "")) {
    throw new Error("A folder cannot be moved inside itself.");
  }
  const removal = removeSnippetNode(nodes, id);
  return insertSnippetNode(removal.tree, destinationFolderId, node);
}

export function reorderSnippetNode(
  nodes: SnippetNode[],
  id: string,
  direction: -1 | 1,
): SnippetNode[] {
  const directIndex = nodes.findIndex((node) => node.id === id);
  if (directIndex >= 0) {
    const destination = directIndex + direction;
    if (destination < 0 || destination >= nodes.length) return nodes;
    const next = [...nodes];
    [next[directIndex], next[destination]] = [next[destination], next[directIndex]];
    return next;
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type !== "folder") continue;
    const children = reorderSnippetNode(node.children, id, direction);
    if (children !== node.children) {
      const next = [...nodes];
      next[index] = { ...node, children };
      return next;
    }
  }
  return nodes;
}
