import type { Session } from "./types";

export const NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY =
  "muxdeck-new-session-workspace-memory";
export const LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY =
  "muxdeck-new-session-directories";
export const MAX_PINNED_WORKSPACES = 8;
export const MAX_VISIBLE_WORKSPACES = 8;

const MEMORY_VERSION = 1;
const MAX_MEMORY_ENTRIES = 40;
const MAX_HIDDEN_PATHS = 40;
const MAX_SESSION_KEYS_PER_PATH = 48;

export interface WorkspaceMemoryEntry {
  path: string;
  pinned: boolean;
  pinnedAt: number;
  launches: number;
  lastUsedAt: number;
  lastSeenAt: number;
  observedSessions: number;
  sessionKeys: string[];
}

export interface WorkspaceMemory {
  version: 1;
  entries: WorkspaceMemoryEntry[];
  hiddenPaths: string[];
}

export type WorkspaceSuggestionReason = "pinned" | "active" | "frequent" | "recent";

export interface WorkspaceSuggestion extends WorkspaceMemoryEntry {
  activeSessions: number;
  lastTouchedAt: number;
  reason: WorkspaceSuggestionReason;
}

export function workspacePathError(path: string): string | null {
  if (!path) return null;
  if (!path.trim()) {
    return "A working directory cannot be blank. Clear the field to use the server home directory.";
  }
  if (!path.startsWith("/")) {
    return "Enter an absolute server path beginning with a slash.";
  }
  if (/\p{Cc}|\u2028|\u2029/u.test(path)) {
    return "A working directory cannot contain control or line-separator characters.";
  }
  return null;
}

export function emptyWorkspaceMemory(): WorkspaceMemory {
  return { version: MEMORY_VERSION, entries: [], hiddenPaths: [] };
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeEntry(value: unknown): WorkspaceMemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.path !== "string"
    || candidate.path === ""
    || workspacePathError(candidate.path)
  ) return null;

  const sessionKeys = Array.isArray(candidate.sessionKeys)
    ? candidate.sessionKeys.filter((key): key is string => (
      typeof key === "string" && key.length > 0
    )).slice(-MAX_SESSION_KEYS_PER_PATH)
    : [];
  return {
    path: candidate.path,
    pinned: candidate.pinned === true,
    pinnedAt: safeNumber(candidate.pinnedAt),
    launches: Math.floor(safeNumber(candidate.launches)),
    lastUsedAt: safeNumber(candidate.lastUsedAt),
    lastSeenAt: safeNumber(candidate.lastSeenAt),
    observedSessions: Math.floor(safeNumber(candidate.observedSessions)),
    sessionKeys: [...new Set(sessionKeys)],
  };
}

function sanitizeMemory(value: unknown): WorkspaceMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== MEMORY_VERSION || !Array.isArray(candidate.entries)) return null;

  const entries: WorkspaceMemoryEntry[] = [];
  for (const rawEntry of candidate.entries) {
    const entry = sanitizeEntry(rawEntry);
    if (!entry || entries.some((current) => current.path === entry.path)) continue;
    entries.push(entry);
    if (entries.length === MAX_MEMORY_ENTRIES) break;
  }
  const retainedPins = new Set(
    entries
      .filter((entry) => entry.pinned)
      .sort((left, right) => right.pinnedAt - left.pinnedAt)
      .slice(0, MAX_PINNED_WORKSPACES)
      .map((entry) => entry.path),
  );
  const boundedEntries = entries.map((entry) => (
    entry.pinned && !retainedPins.has(entry.path)
      ? { ...entry, pinned: false, pinnedAt: 0 }
      : entry
  ));
  const hiddenPaths = Array.isArray(candidate.hiddenPaths)
    ? candidate.hiddenPaths.filter((path): path is string => (
      typeof path === "string"
      && path !== ""
      && !workspacePathError(path)
    )).filter((path, index, paths) => paths.indexOf(path) === index)
      .slice(-MAX_HIDDEN_PATHS)
    : [];
  return { version: MEMORY_VERSION, entries: boundedEntries, hiddenPaths };
}

function legacyPinnedWorkspaces(storage: Storage): WorkspaceMemory {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY) || "[]",
    );
    if (!Array.isArray(parsed)) return emptyWorkspaceMemory();
    const entries: WorkspaceMemoryEntry[] = [];
    for (const value of parsed) {
      if (
        typeof value !== "string"
        || value === ""
        || workspacePathError(value)
        || entries.some((entry) => entry.path === value)
      ) continue;
      entries.push({
        path: value,
        pinned: true,
        pinnedAt: 0,
        launches: 0,
        lastUsedAt: 0,
        lastSeenAt: 0,
        observedSessions: 0,
        sessionKeys: [],
      });
      if (entries.length === MAX_PINNED_WORKSPACES) break;
    }
    return { version: MEMORY_VERSION, entries, hiddenPaths: [] };
  } catch {
    return emptyWorkspaceMemory();
  }
}

export function loadWorkspaceMemory(storage: Storage): WorkspaceMemory {
  try {
    const stored = storage.getItem(NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY);
    if (stored !== null) {
      const memory = sanitizeMemory(JSON.parse(stored));
      if (memory) return memory;
    }
  } catch {
    // Fall through to the legacy pinned-path list when the new record is corrupt.
  }
  return legacyPinnedWorkspaces(storage);
}

export function persistWorkspaceMemory(storage: Storage, memory: WorkspaceMemory): void {
  try {
    storage.setItem(NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // In-memory suggestions remain usable when browser storage is unavailable.
  }
}

function activeSessionPath(session: Session): string | null {
  const pane = session.panes.find((candidate) => candidate.id === session.activePaneId)
    || session.panes[0];
  return pane?.path && !workspacePathError(pane.path) ? pane.path : null;
}

function sessionKey(session: Session): string {
  return `${session.serverPid}:${session.created}:${session.id}`;
}

function sessionSeenAt(session: Session): number {
  const pane = session.panes.find((candidate) => candidate.id === session.activePaneId)
    || session.panes[0];
  return Math.max(session.activity, pane?.activity || 0, session.created) * 1000;
}

function pruneEntries(entries: WorkspaceMemoryEntry[]): WorkspaceMemoryEntry[] {
  if (entries.length <= MAX_MEMORY_ENTRIES) return entries;
  return [...entries]
    .sort((left, right) => (
      Number(right.pinned) - Number(left.pinned)
      || Math.max(right.lastUsedAt, right.lastSeenAt, right.pinnedAt)
        - Math.max(left.lastUsedAt, left.lastSeenAt, left.pinnedAt)
    ))
    .slice(0, MAX_MEMORY_ENTRIES);
}

export function observeSessionWorkspaces(
  memory: WorkspaceMemory,
  sessions: readonly Session[],
): WorkspaceMemory {
  let entries = memory.entries;
  let changed = false;

  for (const session of sessions) {
    const path = activeSessionPath(session);
    if (!path) continue;
    const key = sessionKey(session);
    const seenAt = sessionSeenAt(session);
    const index = entries.findIndex((entry) => entry.path === path);
    if (index < 0) {
      if (!changed) entries = [...entries];
      entries.push({
        path,
        pinned: false,
        pinnedAt: 0,
        launches: 0,
        lastUsedAt: 0,
        lastSeenAt: seenAt,
        observedSessions: 1,
        sessionKeys: [key],
      });
      changed = true;
      continue;
    }

    const entry = entries[index];
    const newlyObserved = !entry.sessionKeys.includes(key);
    const nextSeenAt = Math.max(entry.lastSeenAt, seenAt);
    if (!newlyObserved && nextSeenAt === entry.lastSeenAt) continue;
    if (!changed) entries = [...entries];
    entries[index] = {
      ...entry,
      lastSeenAt: nextSeenAt,
      observedSessions: entry.observedSessions + Number(newlyObserved),
      sessionKeys: newlyObserved
        ? [...entry.sessionKeys, key].slice(-MAX_SESSION_KEYS_PER_PATH)
        : entry.sessionKeys,
    };
    changed = true;
  }

  return changed ? { ...memory, entries: pruneEntries(entries) } : memory;
}

function upsertWorkspace(
  memory: WorkspaceMemory,
  path: string,
  update: (entry: WorkspaceMemoryEntry) => WorkspaceMemoryEntry,
): WorkspaceMemory {
  const index = memory.entries.findIndex((entry) => entry.path === path);
  const base: WorkspaceMemoryEntry = index >= 0 ? memory.entries[index] : {
    path,
    pinned: false,
    pinnedAt: 0,
    launches: 0,
    lastUsedAt: 0,
    lastSeenAt: 0,
    observedSessions: 0,
    sessionKeys: [],
  };
  const nextEntry = update(base);
  const entries = index >= 0
    ? memory.entries.map((entry, entryIndex) => entryIndex === index ? nextEntry : entry)
    : pruneEntries([nextEntry, ...memory.entries]);
  return {
    ...memory,
    entries,
    hiddenPaths: memory.hiddenPaths.filter((hiddenPath) => hiddenPath !== path),
  };
}

export function pinWorkspace(
  memory: WorkspaceMemory,
  path: string,
  now = Date.now(),
): WorkspaceMemory {
  return upsertWorkspace(memory, path, (entry) => ({
    ...entry,
    pinned: true,
    pinnedAt: now,
  }));
}

export function unpinWorkspace(memory: WorkspaceMemory, path: string): WorkspaceMemory {
  return {
    ...memory,
    entries: memory.entries.map((entry) => (
      entry.path === path ? { ...entry, pinned: false } : entry
    )),
  };
}

export function recordWorkspaceLaunch(
  memory: WorkspaceMemory,
  path: string,
  now = Date.now(),
): WorkspaceMemory {
  return upsertWorkspace(memory, path, (entry) => ({
    ...entry,
    launches: entry.launches + 1,
    lastUsedAt: now,
  }));
}

export function hideWorkspace(memory: WorkspaceMemory, path: string): WorkspaceMemory {
  const entries = memory.entries.map((entry) => (
    entry.path === path ? { ...entry, pinned: false } : entry
  ));
  return {
    ...memory,
    entries,
    hiddenPaths: [...memory.hiddenPaths.filter((hiddenPath) => hiddenPath !== path), path]
      .slice(-MAX_HIDDEN_PATHS),
  };
}

export function restoreHiddenWorkspaces(memory: WorkspaceMemory): WorkspaceMemory {
  return memory.hiddenPaths.length === 0 ? memory : { ...memory, hiddenPaths: [] };
}

function workspaceScore(entry: WorkspaceMemoryEntry, activeSessions: number, now: number): number {
  const lastTouchedAt = Math.max(entry.lastUsedAt, entry.lastSeenAt, entry.pinnedAt);
  const ageHours = lastTouchedAt > 0 ? Math.max(0, now - lastTouchedAt) / 3_600_000 : 720;
  const recency = Math.max(0, 500_000 - ageHours * 5_000);
  const frequency = Math.min(20, entry.observedSessions + entry.launches * 2) * 50_000;
  return Number(entry.pinned) * 1_000_000_000
    + activeSessions * 1_000_000
    + frequency
    + recency;
}

export function rankWorkspaceSuggestions(
  memory: WorkspaceMemory,
  sessions: readonly Session[],
  now = Date.now(),
): WorkspaceSuggestion[] {
  const activeCounts = new Map<string, number>();
  for (const session of sessions) {
    const path = activeSessionPath(session);
    if (path) activeCounts.set(path, (activeCounts.get(path) || 0) + 1);
  }
  const hidden = new Set(memory.hiddenPaths);
  return memory.entries
    .filter((entry) => !hidden.has(entry.path))
    .map((entry): WorkspaceSuggestion => {
      const activeSessions = activeCounts.get(entry.path) || 0;
      const lastTouchedAt = Math.max(entry.lastUsedAt, entry.lastSeenAt, entry.pinnedAt);
      const reason: WorkspaceSuggestionReason = entry.pinned
        ? "pinned"
        : activeSessions > 0
          ? "active"
          : entry.observedSessions + entry.launches >= 3
            ? "frequent"
            : "recent";
      return { ...entry, activeSessions, lastTouchedAt, reason };
    })
    .sort((left, right) => (
      workspaceScore(right, right.activeSessions, now)
      - workspaceScore(left, left.activeSessions, now)
      || right.lastTouchedAt - left.lastTouchedAt
      || left.path.localeCompare(right.path)
    ))
    .slice(0, MAX_VISIBLE_WORKSPACES);
}

export function formatWorkspaceRecency(timestamp: number, now = Date.now()): string {
  if (!timestamp) return "saved";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return `${Math.floor(elapsed / 604_800_000)}w ago`;
}
