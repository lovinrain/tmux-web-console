import {
  SESSION_TAGS,
  type AgentState,
  type Pane,
  type Session,
  type SessionTag,
} from "./types";

export type SessionKindFilter =
  | "all"
  | "agents"
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "grok"
  | "shells";
export type SessionKind =
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "grok"
  | "shells"
  | "other";
export type SessionStateFilter = "any" | AgentState;
export type SessionViewMode = "cards" | "list";
export type SessionGroupMode = "none" | "state" | "tag";
export type SessionSortKey = "activity" | "state" | "state-change" | "title" | "tmux-name";

export interface SessionDashboardRouteState {
  query: string;
  kind: SessionKindFilter;
  state: SessionStateFilter;
  includedTags: SessionTag[];
  excludedTags: SessionTag[];
  view: SessionViewMode;
  group: SessionGroupMode;
  sort: SessionSortKey[];
}

export const SESSION_STATE_ORDER: readonly AgentState[] = [
  "waiting_human",
  "working",
  "waiting_command",
  "unknown",
  "other",
];

export const SESSION_SORT_LABELS: Readonly<Record<SessionSortKey, string>> = {
  activity: "Activity (newest)",
  state: "State (attention first)",
  "state-change": "State changed (newest)",
  title: "Title (A-Z)",
  "tmux-name": "Tmux name (A-Z)",
};

export const DEFAULT_SESSION_SORT: readonly SessionSortKey[] = ["activity", "tmux-name"];

export const DEFAULT_SESSION_DASHBOARD_ROUTE: Readonly<SessionDashboardRouteState> = {
  query: "",
  kind: "all",
  state: "any",
  includedTags: [],
  excludedTags: [],
  view: "cards",
  group: "none",
  sort: [...DEFAULT_SESSION_SORT],
};

const KIND_FILTERS = new Set<SessionKindFilter>([
  "all",
  "agents",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "grok",
  "shells",
]);
const AGENT_KINDS = new Set<SessionKind>(["claude", "codex", "copilot", "cursor", "grok"]);
/** The Cursor CLI installs as `cursor-agent` plus a bare `agent` symlink. */
const CURSOR_PANE_COMMANDS = new Set(["agent", "cursor", "cursor-agent"]);
const SHELL_PANE_COMMANDS = new Set(["bash", "zsh", "fish", "sh"]);
const STATE_FILTERS = new Set<SessionStateFilter>(["any", ...SESSION_STATE_ORDER]);
const VIEW_MODES = new Set<SessionViewMode>(["cards", "list"]);
const GROUP_MODES = new Set<SessionGroupMode>(["none", "state", "tag"]);
const SORT_KEYS = new Set<SessionSortKey>([
  "activity",
  "state",
  "state-change",
  "title",
  "tmux-name",
]);
const OWNED_SEARCH_KEYS = [
  "q",
  "kind",
  "filter",
  "state",
  "tag",
  "not-tag",
  "view",
  "group",
  "sort",
];
const STATE_PRIORITY = new Map(SESSION_STATE_ORDER.map((state, index) => [state, index]));
const NATURAL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const LEGACY_STATE_GROUP_SORT: readonly SessionSortKey[] = ["state-change", "tmux-name"];

const SORT_KEY_ALIASES: Readonly<Record<string, SessionSortKey>> = {
  activity: "activity",
  state: "state",
  "state-change": "state-change",
  state_changed: "state-change",
  "state-change-time": "state-change",
  title: "title",
  "tmux-name": "tmux-name",
  tmux: "tmux-name",
};

function copySort(criteria: readonly SessionSortKey[]): SessionSortKey[] {
  return [...criteria];
}

function defaultRouteState(): SessionDashboardRouteState {
  return {
    ...DEFAULT_SESSION_DASHBOARD_ROUTE,
    includedTags: [...DEFAULT_SESSION_DASHBOARD_ROUTE.includedTags],
    excludedTags: [...DEFAULT_SESSION_DASHBOARD_ROUTE.excludedTags],
    sort: copySort(DEFAULT_SESSION_SORT),
  };
}

function searchParams(input: string | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  const questionMark = input.indexOf("?");
  const rawSearch = questionMark >= 0 ? input.slice(questionMark + 1) : input.replace(/^\?/, "");
  return new URLSearchParams(rawSearch.split("#", 1)[0]);
}

function parseKind(value: string | null): SessionKindFilter {
  if (!value) return "all";
  const normalized = value.toLowerCase();
  if (normalized === "agent") return "agents";
  if (normalized === "cursor-agent") return "cursor";
  if (normalized === "shell") return "shells";
  return KIND_FILTERS.has(normalized as SessionKindFilter)
    ? normalized as SessionKindFilter
    : "all";
}

function parseState(value: string | null): SessionStateFilter {
  if (!value) return "any";
  const normalized = value.toLowerCase();
  const aliases: Record<string, SessionStateFilter> = {
    "needs-input": "waiting_human",
    "command-wait": "waiting_command",
    "background-work": "waiting_command",
    unclear: "unknown",
  };
  const canonical = aliases[normalized] || normalized;
  return STATE_FILTERS.has(canonical as SessionStateFilter)
    ? canonical as SessionStateFilter
    : "any";
}

function parseView(value: string | null): SessionViewMode {
  if (value?.toLowerCase() === "grid") return "cards";
  const normalized = value?.toLowerCase() as SessionViewMode | undefined;
  return normalized && VIEW_MODES.has(normalized) ? normalized : "cards";
}

function parseGroup(value: string | null): SessionGroupMode {
  const normalized = value?.toLowerCase();
  if (normalized === "states" || normalized === "state-groups") return "state";
  if (normalized === "tags" || normalized === "tag-groups") return "tag";
  return normalized && GROUP_MODES.has(normalized as SessionGroupMode)
    ? normalized as SessionGroupMode
    : "none";
}

function parseTags(values: readonly string[]): SessionTag[] {
  const requested = new Set(values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase()));
  return SESSION_TAGS.filter((tag) => requested.has(tag));
}

interface ParsedSortToken {
  key?: SessionSortKey;
  legacyStateGroups: boolean;
}

function parseSortToken(rawToken: string): ParsedSortToken {
  let token = rawToken.trim().toLowerCase();
  if (!token) return { legacyStateGroups: false };
  if (token === "state-groups") return { legacyStateGroups: true };

  const key = SORT_KEY_ALIASES[token];
  if (!key || !SORT_KEYS.has(key)) return { legacyStateGroups: false };
  return {
    key,
    legacyStateGroups: false,
  };
}

function parseSort(params: URLSearchParams): {
  criteria: SessionSortKey[];
  legacyStateGroups: boolean;
} {
  const rawTokens = params.getAll("sort").flatMap((value) => value.split(","));
  const criteria: SessionSortKey[] = [];
  const seen = new Set<SessionSortKey>();
  let legacyStateGroups = false;

  for (const rawToken of rawTokens) {
    const parsed = parseSortToken(rawToken);
    legacyStateGroups ||= parsed.legacyStateGroups;
    if (!parsed.key || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    criteria.push(parsed.key);
  }

  if (criteria.length > 0) return { criteria, legacyStateGroups };
  return {
    criteria: copySort(legacyStateGroups ? LEGACY_STATE_GROUP_SORT : DEFAULT_SESSION_SORT),
    legacyStateGroups,
  };
}

/** Parse dashboard controls from a query string without reading browser globals. */
export function parseSessionDashboardSearch(
  input: string | URLSearchParams,
): SessionDashboardRouteState {
  const params = searchParams(input);
  const parsedSort = parseSort(params);
  const explicitKind = params.get("kind");
  const excludedTags = parseTags(params.getAll("not-tag"));
  const excludedTagSet = new Set(excludedTags);
  const includedTags = parseTags(params.getAll("tag"))
    .filter((tag) => !excludedTagSet.has(tag));

  return {
    query: params.get("q") || "",
    kind: parseKind(explicitKind === null ? params.get("filter") : explicitKind),
    state: parseState(params.get("state")),
    includedTags,
    excludedTags,
    view: parseView(params.get("view")),
    group: parsedSort.legacyStateGroups ? "state" : parseGroup(params.get("group")),
    sort: parsedSort.criteria,
  };
}

function sameSort(
  left: readonly SessionSortKey[],
  right: readonly SessionSortKey[],
): boolean {
  return left.length === right.length
    && left.every((criterion, index) => criterion === right[index]);
}

/**
 * Serialize in badge order. Known defaults are omitted; unrelated parameters are preserved
 * when a base query string is supplied.
 */
export function serializeSessionDashboardSearch(
  state: SessionDashboardRouteState,
  baseSearch: string | URLSearchParams = "",
): string {
  const params = searchParams(baseSearch);
  for (const key of OWNED_SEARCH_KEYS) params.delete(key);

  if (state.query) params.set("q", state.query);
  if (state.kind !== "all") params.set("kind", state.kind);
  if (state.state !== "any") params.set("state", state.state);
  for (const tag of SESSION_TAGS) {
    if (state.includedTags.includes(tag) && !state.excludedTags.includes(tag)) {
      params.append("tag", tag);
    }
  }
  for (const tag of SESSION_TAGS) {
    if (state.excludedTags.includes(tag)) params.append("not-tag", tag);
  }
  if (state.view !== "cards") params.set("view", state.view);
  if (state.group !== "none") params.set("group", state.group);

  const normalizedSort = state.sort.length > 0 ? state.sort : DEFAULT_SESSION_SORT;
  if (!sameSort(normalizedSort, DEFAULT_SESSION_SORT)) {
    params.set("sort", normalizedSort.join(","));
  }

  let encoded = params.toString();
  if (!sameSort(normalizedSort, DEFAULT_SESSION_SORT)) {
    const sortValue = normalizedSort.join(",");
    encoded = encoded.replace(
      `sort=${encodeURIComponent(sortValue)}`,
      `sort=${sortValue}`,
    );
  }
  return encoded ? `?${encoded}` : "";
}

/** Normalize aliases, duplicates, and invalid values to the URL's canonical representation. */
export function canonicalizeSessionDashboardSearch(
  input: string | URLSearchParams,
): string {
  return serializeSessionDashboardSearch(parseSessionDashboardSearch(input), input);
}

export function sessionStateChangedAt(session: Session): number {
  return session.agentStateChangedAt || session.activity || session.created;
}

export function sessionDisplayTitle(session: Session): string {
  return session.customTitle?.trim() || session.name;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCriterion(
  left: Session,
  right: Session,
  criterion: SessionSortKey,
): number {
  let comparison = 0;
  if (criterion === "activity") {
    comparison = compareNumber(left.activity, right.activity);
  } else if (criterion === "state") {
    comparison = compareNumber(
      STATE_PRIORITY.get(left.agentState) ?? SESSION_STATE_ORDER.length,
      STATE_PRIORITY.get(right.agentState) ?? SESSION_STATE_ORDER.length,
    );
  } else if (criterion === "state-change") {
    comparison = compareNumber(sessionStateChangedAt(left), sessionStateChangedAt(right));
  } else if (criterion === "title") {
    comparison = NATURAL_COLLATOR.compare(sessionDisplayTitle(left), sessionDisplayTitle(right));
  } else {
    comparison = NATURAL_COLLATOR.compare(left.name, right.name);
  }
  return criterion === "activity" || criterion === "state-change" ? -comparison : comparison;
}

/** Sort without mutating input; tmux name, id, then input order make exact ties deterministic. */
export function sortSessions(
  sessions: readonly Session[],
  criteria: readonly SessionSortKey[] = DEFAULT_SESSION_SORT,
): Session[] {
  const effectiveCriteria = criteria.length > 0 ? criteria : DEFAULT_SESSION_SORT;
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      for (const criterion of effectiveCriteria) {
        const comparison = compareCriterion(left.session, right.session, criterion);
        if (comparison !== 0) return comparison;
      }
      return NATURAL_COLLATOR.compare(left.session.name, right.session.name)
        || NATURAL_COLLATOR.compare(left.session.id, right.session.id)
        || left.index - right.index;
    })
    .map(({ session }) => session);
}

function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

export function paneCommandKind(command: string, title = ""): SessionKind {
  const normalized = command.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  // The official npm launcher keeps `node` in tmux while branding the pane title.
  if (
    normalized === "copilot"
    || (
      normalized === "node"
      && (
        normalizedTitle === "github copilot"
        || normalizedTitle.endsWith(" - github copilot")
      )
    )
  ) return "copilot";
  if (CURSOR_PANE_COMMANDS.has(normalized)) return "cursor";
  if (normalized === "grok") return "grok";
  if (SHELL_PANE_COMMANDS.has(normalized)) return "shells";
  return "other";
}

function sessionKind(session: Session): SessionKind {
  const pane = activePane(session);
  return paneCommandKind(pane?.command || "", pane?.title || "");
}

export function sessionMatchesTagFilters(
  session: Session,
  filters: Pick<SessionDashboardRouteState, "includedTags" | "excludedTags">,
): boolean {
  const includedTags = new Set(filters.includedTags);
  const excludedTags = new Set(filters.excludedTags);
  const sessionTags = session.tags ?? [];
  return (includedTags.size === 0 || sessionTags.some((tag) => includedTags.has(tag)))
    && !sessionTags.some((tag) => excludedTags.has(tag));
}

/** Apply shareable dashboard facets; tag values are ORed within include/exclude sets. */
export function filterSessions(
  sessions: readonly Session[],
  filters: Pick<
    SessionDashboardRouteState,
    "query" | "kind" | "state" | "includedTags" | "excludedTags"
  >,
): Session[] {
  const needle = filters.query.trim().toLowerCase();
  return sessions.filter((session) => {
    const pane = activePane(session);
    const kind = sessionKind(session);
    const matchesQuery = !needle || [
      session.name,
      session.customTitle,
      pane?.path,
      pane?.title,
      pane?.command,
      ...(session.tags ?? []),
    ].filter(Boolean).some((value) => value!.toLowerCase().includes(needle));
    const matchesKind = filters.kind === "all"
      || (filters.kind === "agents" && AGENT_KINDS.has(kind))
      || filters.kind === kind;
    const matchesState = filters.state === "any" || filters.state === session.agentState;
    return matchesQuery
      && matchesKind
      && matchesState
      && sessionMatchesTagFilters(session, filters);
  });
}

export interface SessionTagGroup {
  tag: SessionTag | null;
  sessions: Session[];
}

/** Multi-tag sessions appear in every matching group; untagged sessions remain discoverable. */
export function groupSessionsByTag(sessions: readonly Session[]): SessionTagGroup[] {
  const groups: SessionTagGroup[] = SESSION_TAGS
    .map((tag) => ({
      tag,
      sessions: sessions.filter((session) => (session.tags ?? []).includes(tag)),
    }))
    .filter((group) => group.sessions.length > 0);
  const untagged = sessions.filter((session) => (session.tags ?? []).length === 0);
  if (untagged.length > 0) groups.push({ tag: null, sessions: untagged });
  return groups;
}

/** Useful when callers need a fresh default object for React state. */
export function createDefaultSessionDashboardRoute(): SessionDashboardRouteState {
  return defaultRouteState();
}
