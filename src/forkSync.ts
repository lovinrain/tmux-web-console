import type { WorkspacePaneLayout, WorkspacePaneNode } from "./api";

export const FORK_SYNC_SEARCH_PARAM = "fork-sync";
const CACHE_PREFIX = "muxdeck-fork-sync:";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ForkSyncSelection {
  workspaceId: string | null;
  tabs: string[];
  view: { kind: "session"; sessionName: string }
    | { kind: "panes"; layout: WorkspacePaneLayout; activePaneId: string | null };
}

export interface ForkSyncSnapshot {
  version: 1;
  sequence: number;
  sender: string;
  updatedAt: number;
  selection: ForkSyncSelection;
}

export interface ForkSyncTransport {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
  close: () => void;
}

export function newForkSyncId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function forkSyncGroupFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(FORK_SYNC_SEARCH_PARAM);
  return value && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : null;
}

export function searchWithForkSyncGroup(search: string, group: string | null): string {
  const params = new URLSearchParams(search);
  params.delete(FORK_SYNC_SEARCH_PARAM);
  if (group) params.set(FORK_SYNC_SEARCH_PARAM, group);
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function independentForkHref(href: string): string {
  const url = new URL(href);
  // Preserve ordinary Fork's exact URL when it is already independent.
  if (url.searchParams.has(FORK_SYNC_SEARCH_PARAM)) {
    url.searchParams.delete(FORK_SYNC_SEARCH_PARAM);
    return url.href;
  }
  return href;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function paneNode(value: unknown, tabs: readonly string[], ids: Set<string>, depth = 0): value is WorkspacePaneNode {
  if (!record(value) || depth > 6 || !identifier(value.id) || ids.has(value.id)) return false;
  ids.add(value.id);
  if (value.kind === "pane") {
    return value.session === null || (identifier(value.session) && tabs.includes(value.session));
  }
  return value.kind === "split"
    && (value.direction === "horizontal" || value.direction === "vertical")
    && typeof value.ratio === "number" && value.ratio >= 0.15 && value.ratio <= 0.85
    && paneNode(value.first, tabs, ids, depth + 1)
    && paneNode(value.second, tabs, ids, depth + 1);
}

export function isForkSyncSnapshot(value: unknown): value is ForkSyncSnapshot {
  if (!record(value) || value.version !== 1
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !identifier(value.sender) || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt) || !record(value.selection)) return false;
  const { workspaceId, tabs, view } = value.selection;
  if (!(workspaceId === null || identifier(workspaceId))
    || !Array.isArray(tabs) || tabs.length > 256 || !tabs.every(identifier)
    || new Set(tabs).size !== tabs.length || !record(view)) return false;
  if (view.kind === "session") return identifier(view.sessionName) && tabs.includes(view.sessionName);
  if (view.kind !== "panes" || !record(view.layout)
    || !identifier(view.layout.id) || !identifier(view.layout.name)) return false;
  const ids = new Set<string>();
  if (!paneNode(view.layout.root, tabs, ids)) return false;
  const leaves = (node: WorkspacePaneNode): string[] => node.kind === "pane"
    ? [node.id] : [...leaves(node.first), ...leaves(node.second)];
  const paneIds = leaves(view.layout.root);
  return paneIds.length <= 12
    && (view.activePaneId === null || paneIds.includes(view.activePaneId as string));
}

export function forkSyncSelectionKey(selection: ForkSyncSelection): string {
  // Tab membership is carried for startup/navigation, but sidebar edits alone
  // must not turn into a new selection or bounce back a received selection.
  const view = selection.workspaceId && selection.view.kind === "panes"
    ? { kind: "panes", layoutId: selection.view.layout.id, activePaneId: selection.view.activePaneId }
    : selection.view;
  // Saved panel definitions already follow the versioned workspace stream.
  // Only temporary panels need their definitions sent with each local edit.
  return JSON.stringify([selection.workspaceId, view]);
}

export function compareForkSyncSnapshots(left: ForkSyncSnapshot, right: ForkSyncSnapshot): number {
  return left.sequence - right.sequence
    || (left.sender < right.sender ? -1 : left.sender > right.sender ? 1 : 0);
}

export function readForkSyncSnapshot(group: string, storage: Storage | null): ForkSyncSnapshot | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(`${CACHE_PREFIX}${group}`) ?? "null");
    return isForkSyncSnapshot(value) && Date.now() - value.updatedAt < CACHE_MAX_AGE_MS ? value : null;
  } catch { return null; }
}

export function storeForkSyncSnapshot(group: string, snapshot: ForkSyncSnapshot, storage: Storage | null): void {
  try {
    const previous = readForkSyncSnapshot(group, storage);
    if (!previous || compareForkSyncSnapshots(snapshot, previous) >= 0) {
      storage?.setItem(`${CACHE_PREFIX}${group}`, JSON.stringify(snapshot));
    }
  } catch { /* Live tab-to-tab synchronization also works without browser storage. */ }
}

/** Each group has a Lamport clock; sender IDs break simultaneous-selection ties. */
export class ForkSyncPeer {
  snapshot: ForkSyncSnapshot | null;
  private closed = false;

  constructor(
    readonly group: string,
    readonly sender: string,
    private transport: ForkSyncTransport,
    private storage: Storage | null,
    private onSelection: (selection: ForkSyncSelection) => void,
  ) {
    this.snapshot = readForkSyncSnapshot(group, storage);
    transport.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!record(data)) return;
      if (data.type === "request") {
        if (this.snapshot) transport.postMessage({ type: "selection", snapshot: this.snapshot });
      } else if (data.type === "selection" && isForkSyncSnapshot(data.snapshot)) {
        this.receive(data.snapshot);
      }
    };
  }

  connect(): void {
    if (this.snapshot) this.onSelection(this.snapshot.selection);
    this.transport.postMessage({ type: "request" });
  }

  requestSelection(): void {
    if (this.closed) return;
    const cached = readForkSyncSnapshot(this.group, this.storage);
    if (cached) this.receive(cached);
    this.transport.postMessage({ type: "request" });
  }

  select(selection: ForkSyncSelection, force = false): void {
    if (this.closed) return;
    if (!force && this.snapshot
      && forkSyncSelectionKey(selection) === forkSyncSelectionKey(this.snapshot.selection)) return;
    const cached = readForkSyncSnapshot(this.group, this.storage);
    const sequence = Math.max(this.snapshot?.sequence ?? 0, cached?.sequence ?? 0) + 1;
    this.snapshot = { version: 1, sequence, sender: this.sender, updatedAt: Date.now(), selection };
    storeForkSyncSnapshot(this.group, this.snapshot, this.storage);
    this.transport.postMessage({ type: "selection", snapshot: this.snapshot });
  }

  private receive(snapshot: ForkSyncSnapshot): void {
    if (this.snapshot && compareForkSyncSnapshots(snapshot, this.snapshot) <= 0) {
      // A concurrent losing writer may have been the last to touch the cache.
      storeForkSyncSnapshot(this.group, this.snapshot, this.storage);
      return;
    }
    this.snapshot = snapshot;
    storeForkSyncSnapshot(this.group, snapshot, this.storage);
    this.onSelection(snapshot.selection);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.onmessage = null;
    this.transport.close();
  }
}
