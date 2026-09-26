import type { CallbackMessage } from "./api";
import { paneCommandKind, type SessionKind } from "./sessionDashboardModel";
import type { Session } from "./types";

export const CALLBACK_SORT_OPTIONS = [
  { value: "queue", label: "Queue order" },
  { value: "ready-first", label: "Ready first" },
  { value: "ready-longest", label: "Ready longest" },
  { value: "callback-newest", label: "Newest callback" },
  { value: "callback-oldest", label: "Oldest callback" },
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
] as const;

export const CALLBACK_GROUP_OPTIONS = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
  { value: "agent", label: "Agent" },
  { value: "workspace", label: "Workspace" },
] as const;

export const CALLBACK_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "ended", label: "Ended / unavailable" },
  { value: "unknown", label: "Status unknown" },
] as const;

export const CALLBACK_AGENT_OPTIONS = [
  { value: "all", label: "All agents" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "cursor", label: "Cursor" },
  { value: "grok", label: "Grok" },
  { value: "shells", label: "Shells" },
  { value: "other", label: "Other / unknown" },
] as const;

export const CALLBACK_MESSAGE_OPTIONS = [
  { value: "all", label: "All callbacks" },
  { value: "with-messages", label: "With pending messages" },
  { value: "without-messages", label: "Without pending messages" },
] as const;

export const CALLBACK_LOCATION_OPTIONS = [
  { value: "all", label: "All locations" },
  { value: "current", label: "This workspace" },
  { value: "other", label: "Outside this workspace" },
  { value: "global-only", label: "Global only" },
] as const;

export type CallbackListSort = typeof CALLBACK_SORT_OPTIONS[number]["value"];
export type CallbackListGroupBy = typeof CALLBACK_GROUP_OPTIONS[number]["value"];
export type CallbackListStatusFilter = typeof CALLBACK_STATUS_OPTIONS[number]["value"];
export type CallbackListAgentFilter = typeof CALLBACK_AGENT_OPTIONS[number]["value"];
export type CallbackListMessageFilter = typeof CALLBACK_MESSAGE_OPTIONS[number]["value"];
export type CallbackListLocationFilter = typeof CALLBACK_LOCATION_OPTIONS[number]["value"];

export interface CallbackListViewPreferences {
  sort: CallbackListSort;
  group: CallbackListGroupBy;
  collapsedGroups: string[];
  status: CallbackListStatusFilter;
  agent: CallbackListAgentFilter;
  messages: CallbackListMessageFilter;
  location: CallbackListLocationFilter;
}

export const DEFAULT_CALLBACK_LIST_VIEW: Readonly<CallbackListViewPreferences> = {
  sort: "queue",
  group: "none",
  collapsedGroups: [],
  status: "all",
  agent: "all",
  messages: "all",
  location: "all",
};

/** One complete row after the caller has resolved scope and session liveness. */
export interface CallbackListEntry {
  name: string;
  session?: Session;
  messages: readonly CallbackMessage[];
  workspaceNames: readonly string[];
  workspaceSources?: readonly { id: string; name: string }[];
  inCurrentWorkspace: boolean;
  globalOnly: boolean;
  latestCallbackAt?: number;
}

export interface CallbackStatus {
  label: string;
  tone: "ended" | "working" | "running_command" | "ready" | "waiting" | "unknown";
  working: boolean;
}

export interface CallbackListGroup {
  key: string;
  label: string;
  entries: CallbackListEntry[];
  tone?: CallbackStatus["tone"];
}

export function callbackStatus(session: Session | undefined): CallbackStatus {
  if (!session) return { label: "Ended / unavailable", tone: "ended", working: false };
  const state = session.agentState;
  if (state === "working") return { label: "Working", tone: "working", working: true };
  if (state === "running_command") return { label: "Command running", tone: "running_command", working: true };
  if (state === "waiting_human") return { label: "Ready for review", tone: "ready", working: false };
  if (state === "waiting_command") return { label: "Waiting", tone: "waiting", working: false };
  if (state === "unknown") return { label: "Status unknown", tone: "unknown", working: false };
  return { label: "Ready", tone: "ready", working: false };
}

export function sessionDisplayName(session: Session | undefined, fallback: string): string {
  return session?.customTitle?.trim() || fallback;
}

function validTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    && Number.isFinite(new Date(value * 1000).getTime()) ? value : undefined;
}

export function callbackEntryReadySince(entry: CallbackListEntry): number | undefined {
  return entry.session?.agentState === "waiting_human"
    ? validTimestamp(entry.session.agentStateChangedAt)
    : undefined;
}

/** Retained history wins; pending messages support snapshots from older servers. */
export function callbackEntryLatestCallbackAt(entry: CallbackListEntry): number | undefined {
  const recorded = validTimestamp(entry.latestCallbackAt);
  if (recorded !== undefined) return recorded;
  let latest: number | undefined;
  for (const message of entry.messages) {
    const candidate = validTimestamp(message.createdAt);
    if (candidate !== undefined && (latest === undefined || candidate > latest)) latest = candidate;
  }
  return latest;
}

function optionValue<T extends string>(
  options: readonly { value: T }[],
  value: unknown,
  fallback: T,
): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

function validCollapsedGroupKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return /^(status:(ready|working|waiting|unknown|ended)|agent:(claude|codex|copilot|cursor|grok|shells|multiple|other)|workspace:(multiple|global|(id|name):.+))$/u.test(value);
}

export function validateCallbackListViewPreferences(value: unknown): CallbackListViewPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CALLBACK_LIST_VIEW, collapsedGroups: [] };
  }
  const candidate = value as Partial<Record<keyof CallbackListViewPreferences, unknown>>;
  return {
    sort: optionValue(CALLBACK_SORT_OPTIONS, candidate.sort, DEFAULT_CALLBACK_LIST_VIEW.sort),
    group: optionValue(CALLBACK_GROUP_OPTIONS, candidate.group, DEFAULT_CALLBACK_LIST_VIEW.group),
    collapsedGroups: Array.isArray(candidate.collapsedGroups)
      ? [...new Set(candidate.collapsedGroups.filter(validCollapsedGroupKey))].slice(0, 512)
      : [],
    status: optionValue(CALLBACK_STATUS_OPTIONS, candidate.status, DEFAULT_CALLBACK_LIST_VIEW.status),
    agent: optionValue(CALLBACK_AGENT_OPTIONS, candidate.agent, DEFAULT_CALLBACK_LIST_VIEW.agent),
    messages: optionValue(CALLBACK_MESSAGE_OPTIONS, candidate.messages, DEFAULT_CALLBACK_LIST_VIEW.messages),
    location: optionValue(CALLBACK_LOCATION_OPTIONS, candidate.location, DEFAULT_CALLBACK_LIST_VIEW.location),
  };
}

export function parseCallbackListViewPreferences(raw: string | null): CallbackListViewPreferences {
  try {
    return validateCallbackListViewPreferences(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CALLBACK_LIST_VIEW, collapsedGroups: [] };
  }
}

function reportedAgentKind(agentType: string): SessionKind {
  const normalized = agentType.trim().toLowerCase();
  if (normalized === "shell" || normalized === "shells") return "shells";
  return CALLBACK_AGENT_OPTIONS.some((option) => option.value === normalized)
    && normalized !== "all" ? normalized as SessionKind : "other";
}

function entryAgentKinds(entry: CallbackListEntry): Set<SessionKind> {
  const kinds = new Set<SessionKind>();
  const session = entry.session;
  if (session) {
    const pane = session.panes.find((candidate) => candidate.id === session.activePaneId)
      ?? session.panes[0];
    kinds.add(session.agentType ?? paneCommandKind(pane?.command ?? "", pane?.title ?? ""));
  }
  for (const message of entry.messages) kinds.add(reportedAgentKind(message.agentType));
  if (kinds.size === 0) kinds.add("other");
  return kinds;
}

function entrySearchText(entry: CallbackListEntry, agents: ReadonlySet<SessionKind>): string {
  return [
    entry.name,
    sessionDisplayName(entry.session, entry.name),
    ...entry.workspaceNames,
    ...agents,
    ...(entry.session?.panes.flatMap((pane) => [pane.command, pane.path, pane.title]) ?? []),
    ...entry.messages.flatMap((message) => [message.message, message.cwd, message.agentType]),
  ].join(" ").toLowerCase();
}

/** Missing times remain last for both directions. Equal values retain queue order. */
function compareTimes(left: number | undefined, right: number | undefined, newest: boolean): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return newest ? right - left : left - right;
}

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const STATUS_GROUPS: readonly Omit<CallbackListGroup, "entries">[] = [
  { key: "status:ready", label: "Ready", tone: "ready" },
  { key: "status:working", label: "Working", tone: "working" },
  { key: "status:waiting", label: "Waiting", tone: "waiting" },
  { key: "status:unknown", label: "Status unknown", tone: "unknown" },
  { key: "status:ended", label: "Ended / unavailable", tone: "ended" },
];

const AGENT_GROUPS: readonly Omit<CallbackListGroup, "entries">[] = [
  ...CALLBACK_AGENT_OPTIONS
    .filter((option) => option.value !== "all" && option.value !== "other")
    .map((option) => ({ key: `agent:${option.value}`, label: option.label })),
  { key: "agent:multiple", label: "Multiple agents" },
  { key: "agent:other", label: "Other / unknown" },
];

function workspaceGroup(entry: CallbackListEntry): Omit<CallbackListGroup, "entries"> {
  // IDs keep identically named workspaces distinct. Older callers can still supply names alone.
  const sources = entry.workspaceSources === undefined
    ? entry.workspaceNames.map((name) => ({ key: `workspace:name:${name}`, name }))
    : entry.workspaceSources.map((source) => ({ key: `workspace:id:${source.id}`, name: source.name }));
  const uniqueSources = new Map(sources.map((source) => [source.key, source.name]));
  if (uniqueSources.size > 1) return { key: "workspace:multiple", label: "Multiple workspaces" };
  const source = uniqueSources.entries().next().value;
  return source
    ? { key: source[0], label: source[1].trim() || "Unnamed workspace" }
    : { key: "workspace:global", label: "Global queue" };
}

/** Group already-filtered, sorted rows exactly once, retaining their order within each group. */
export function groupCallbacks(
  entries: readonly CallbackListEntry[],
  group: CallbackListGroupBy,
): CallbackListGroup[] {
  if (entries.length === 0) return [];
  if (group === "none") return [{ key: "none", label: "All callbacks", entries: [...entries] }];

  const definitions = group === "status" ? STATUS_GROUPS : group === "agent" ? AGENT_GROUPS : [];
  const groups = new Map<string, CallbackListGroup>();
  for (const entry of entries) {
    let definition: Omit<CallbackListGroup, "entries">;
    if (group === "status") {
      const status = callbackStatus(entry.session);
      const key = `status:${status.working ? "working" : status.tone}`;
      definition = STATUS_GROUPS.find((candidate) => candidate.key === key)!;
    } else if (group === "agent") {
      const agents = entryAgentKinds(entry);
      const key = `agent:${agents.size > 1 ? "multiple" : agents.values().next().value}`;
      definition = AGENT_GROUPS.find((candidate) => candidate.key === key)!;
    } else {
      definition = workspaceGroup(entry);
    }
    const existing = groups.get(definition.key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(definition.key, { ...definition, entries: [entry] });
    }
  }

  if (group !== "workspace") {
    return definitions.flatMap((definition) => {
      const result = groups.get(definition.key);
      return result ? [result] : [];
    });
  }
  const workspaceRank = (key: string) => key === "workspace:multiple" ? 1 : key === "workspace:global" ? 2 : 0;
  return [...groups.values()].sort((left, right) => workspaceRank(left.key) - workspaceRank(right.key)
    || NAME_COLLATOR.compare(left.label, right.label)
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export function filterAndSortCallbacks(
  entries: readonly CallbackListEntry[],
  preferences: Readonly<CallbackListViewPreferences>,
  query = "",
): CallbackListEntry[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matching = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
    const status = callbackStatus(entry.session);
    if (preferences.status !== "all" && (preferences.status === "working"
      ? !status.working : status.tone !== preferences.status)) return false;
    if (preferences.messages === "with-messages" && entry.messages.length === 0) return false;
    if (preferences.messages === "without-messages" && entry.messages.length > 0) return false;
    if (preferences.location === "current" && !entry.inCurrentWorkspace) return false;
    if (preferences.location === "other" && entry.inCurrentWorkspace) return false;
    if (preferences.location === "global-only" && !entry.globalOnly) return false;
    const agents = entryAgentKinds(entry);
    if (preferences.agent !== "all" && !agents.has(preferences.agent)) return false;
    if (tokens.length > 0) {
      const text = entrySearchText(entry, agents);
      if (!tokens.every((token) => text.includes(token))) return false;
    }
    return true;
  });
  matching.sort((left, right) => {
    let comparison = 0;
    switch (preferences.sort) {
      case "ready-first":
      case "ready-longest": {
        const leftReady = callbackStatus(left.entry.session).tone === "ready";
        const rightReady = callbackStatus(right.entry.session).tone === "ready";
        comparison = Number(rightReady) - Number(leftReady);
        if (comparison === 0 && leftReady && preferences.sort === "ready-longest") {
          comparison = compareTimes(callbackEntryReadySince(left.entry), callbackEntryReadySince(right.entry), false);
        }
        break;
      }
      case "callback-newest":
      case "callback-oldest":
        comparison = compareTimes(
          callbackEntryLatestCallbackAt(left.entry),
          callbackEntryLatestCallbackAt(right.entry),
          preferences.sort === "callback-newest",
        );
        break;
      case "name-asc":
      case "name-desc":
        comparison = NAME_COLLATOR.compare(
          sessionDisplayName(left.entry.session, left.entry.name),
          sessionDisplayName(right.entry.session, right.entry.name),
        ) * (preferences.sort === "name-desc" ? -1 : 1);
        break;
      case "queue":
        break;
    }
    return comparison || left.index - right.index;
  });
  return matching.map(({ entry }) => entry);
}
