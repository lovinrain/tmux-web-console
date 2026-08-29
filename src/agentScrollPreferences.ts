import type { SessionKind } from "./sessionDashboardModel";

export type AgentScrollMode = "application" | "tmux";
export type AgentScrollPreferences = Partial<Record<SessionKind, AgentScrollMode>>;

export const AGENT_SCROLL_PREFERENCES_STORAGE_KEY = "muxdeck-agent-scroll-preferences";

const SESSION_KINDS: readonly SessionKind[] = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "grok",
  "shells",
  "other",
];

const DEFAULT_SCROLL_MODE: Readonly<Record<SessionKind, AgentScrollMode>> = {
  claude: "application",
  codex: "tmux",
  copilot: "application",
  cursor: "tmux",
  grok: "application",
  shells: "tmux",
  other: "tmux",
};

function isScrollMode(value: unknown): value is AgentScrollMode {
  return value === "application" || value === "tmux";
}

export function loadAgentScrollPreferences(): AgentScrollPreferences {
  try {
    const stored = window.localStorage.getItem(AGENT_SCROLL_PREFERENCES_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return Object.fromEntries(
      SESSION_KINDS.flatMap((kind) => (
        isScrollMode(record[kind]) ? [[kind, record[kind]]] : []
      )),
    ) as AgentScrollPreferences;
  } catch {
    return {};
  }
}

export function preferredAgentScrollMode(
  kind: SessionKind,
  preferences: AgentScrollPreferences,
): AgentScrollMode {
  return preferences[kind] ?? DEFAULT_SCROLL_MODE[kind];
}

export function rememberAgentScrollMode(
  preferences: AgentScrollPreferences,
  kind: SessionKind,
  mode: AgentScrollMode,
): AgentScrollPreferences {
  if (preferences[kind] === mode) return preferences;
  const next = { ...preferences, [kind]: mode };
  try {
    window.localStorage.setItem(
      AGENT_SCROLL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // The in-memory preference still applies when storage is unavailable.
  }
  return next;
}
