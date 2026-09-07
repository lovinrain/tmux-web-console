import type {
  WorkspacePaneLayout,
  WorkspacePaneNode,
  WorkspacePaneSplit,
  WorkspaceSessionPane,
} from "./api";

export const MAX_WORKSPACE_PANE_LAYOUTS = 16;
export const MAX_WORKSPACE_PANES_PER_LAYOUT = 12;
export const MAX_WORKSPACE_PANE_DEPTH = 6;
export const MAX_WORKSPACE_PANE_LAYOUT_NAME_LENGTH = 64;
export const MIN_WORKSPACE_PANE_RATIO = 0.15;
export const MAX_WORKSPACE_PANE_RATIO = 0.85;

let fallbackId = 0;

export function newWorkspacePaneId(prefix: "layout" | "pane" | "split"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function workspacePaneLeaves(node: WorkspacePaneNode): WorkspaceSessionPane[] {
  if (node.kind === "pane") return [node];
  return [...workspacePaneLeaves(node.first), ...workspacePaneLeaves(node.second)];
}

export function workspacePaneSessions(layout: WorkspacePaneLayout): string[] {
  return workspacePaneLeaves(layout.root).flatMap((pane) => (
    pane.session ? [pane.session] : []
  ));
}

function workspacePaneNodeDepth(
  node: WorkspacePaneNode,
  nodeId: string,
  depth = 1,
): number | null {
  if (node.id === nodeId) return depth;
  if (node.kind === "pane") return null;
  return workspacePaneNodeDepth(node.first, nodeId, depth + 1)
    ?? workspacePaneNodeDepth(node.second, nodeId, depth + 1);
}

export function canSplitWorkspacePane(
  layout: WorkspacePaneLayout,
  paneId: string,
): boolean {
  if (workspacePaneLeaves(layout.root).length >= MAX_WORKSPACE_PANES_PER_LAYOUT) {
    return false;
  }
  const depth = workspacePaneNodeDepth(layout.root, paneId);
  return depth !== null && depth < MAX_WORKSPACE_PANE_DEPTH;
}

export function createWorkspacePaneLayout(
  layouts: readonly WorkspacePaneLayout[],
  session: string | null,
  idFactory: typeof newWorkspacePaneId = newWorkspacePaneId,
): WorkspacePaneLayout {
  const names = new Set(layouts.map((layout) => layout.name.toLocaleLowerCase()));
  let suffix = 1;
  while (names.has(`pane view ${suffix}`)) suffix += 1;
  return {
    id: idFactory("layout"),
    name: `Pane view ${suffix}`,
    root: { id: idFactory("pane"), kind: "pane", session },
  };
}

function mapWorkspacePaneNode(
  node: WorkspacePaneNode,
  mapper: (pane: WorkspaceSessionPane) => WorkspaceSessionPane,
): WorkspacePaneNode {
  if (node.kind === "pane") return mapper(node);
  const first = mapWorkspacePaneNode(node.first, mapper);
  const second = mapWorkspacePaneNode(node.second, mapper);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

function replaceWorkspacePaneNode(
  node: WorkspacePaneNode,
  nodeId: string,
  replacement: (node: WorkspacePaneNode) => WorkspacePaneNode,
): WorkspacePaneNode {
  if (node.id === nodeId) return replacement(node);
  if (node.kind === "pane") return node;
  const first = replaceWorkspacePaneNode(node.first, nodeId, replacement);
  const second = replaceWorkspacePaneNode(node.second, nodeId, replacement);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function assignWorkspacePaneSession(
  layout: WorkspacePaneLayout,
  paneId: string,
  session: string | null,
): WorkspacePaneLayout {
  let found = false;
  const root = mapWorkspacePaneNode(layout.root, (pane) => {
    if (pane.id === paneId) {
      found = true;
      return pane.session === session ? pane : { ...pane, session };
    }
    if (session && pane.session === session) return { ...pane, session: null };
    return pane;
  });
  return found && root !== layout.root ? { ...layout, root } : layout;
}

export function splitWorkspacePane(
  layout: WorkspacePaneLayout,
  paneId: string,
  direction: WorkspacePaneSplit["direction"],
  idFactory: typeof newWorkspacePaneId = newWorkspacePaneId,
): WorkspacePaneLayout {
  if (!canSplitWorkspacePane(layout, paneId)) return layout;
  let split = false;
  const root = replaceWorkspacePaneNode(layout.root, paneId, (node) => {
    if (node.kind !== "pane") return node;
    split = true;
    return {
      id: idFactory("split"),
      kind: "split",
      direction,
      ratio: 0.5,
      first: node,
      second: { id: idFactory("pane"), kind: "pane", session: null },
    };
  });
  return split ? { ...layout, root } : layout;
}

function removePaneNode(
  node: WorkspacePaneNode,
  paneId: string,
): WorkspacePaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePaneNode(node.first, paneId);
  const second = removePaneNode(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function removeWorkspacePane(
  layout: WorkspacePaneLayout,
  paneId: string,
): WorkspacePaneLayout {
  if (workspacePaneLeaves(layout.root).length === 1) {
    return assignWorkspacePaneSession(layout, paneId, null);
  }
  const root = removePaneNode(layout.root, paneId);
  return root && root !== layout.root ? { ...layout, root } : layout;
}

export function resizeWorkspacePaneSplit(
  layout: WorkspacePaneLayout,
  splitId: string,
  ratio: number,
): WorkspacePaneLayout {
  const bounded = Math.min(
    MAX_WORKSPACE_PANE_RATIO,
    Math.max(MIN_WORKSPACE_PANE_RATIO, ratio),
  );
  const rounded = Math.round(bounded * 10_000) / 10_000;
  let resized = false;
  const root = replaceWorkspacePaneNode(layout.root, splitId, (node) => {
    if (node.kind !== "split" || node.ratio === rounded) return node;
    resized = true;
    return { ...node, ratio: rounded };
  });
  return resized ? { ...layout, root } : layout;
}

export function reconcileWorkspacePaneLayouts(
  layouts: readonly WorkspacePaneLayout[],
  openSessions: readonly string[],
): WorkspacePaneLayout[] {
  const open = new Set(openSessions);
  return layouts.map((layout) => {
    const seen = new Set<string>();
    const root = mapWorkspacePaneNode(layout.root, (pane) => {
      const session = pane.session;
      if (!session || !open.has(session) || seen.has(session)) {
        return session === null ? pane : { ...pane, session: null };
      }
      seen.add(session);
      return pane;
    });
    return root === layout.root ? layout : { ...layout, root };
  });
}

export function renameWorkspacePaneSession(
  layouts: readonly WorkspacePaneLayout[],
  previousName: string,
  nextName: string,
): WorkspacePaneLayout[] {
  return layouts.map((layout) => {
    const sourcePresent = workspacePaneSessions(layout).includes(previousName);
    const root = mapWorkspacePaneNode(layout.root, (pane) => {
      if (pane.session === previousName) return { ...pane, session: nextName };
      if (sourcePresent && pane.session === nextName) return { ...pane, session: null };
      return pane;
    });
    return root === layout.root ? layout : { ...layout, root };
  });
}

export function replaceWorkspacePaneLayout(
  layouts: readonly WorkspacePaneLayout[],
  nextLayout: WorkspacePaneLayout,
): WorkspacePaneLayout[] {
  return layouts.map((layout) => (
    layout.id === nextLayout.id ? nextLayout : layout
  ));
}
