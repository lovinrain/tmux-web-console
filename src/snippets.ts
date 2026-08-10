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
