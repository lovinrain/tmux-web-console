import type { SessionKind } from "./sessionDashboardModel";

export type AgentScrollMode = "application" | "tmux";
export type ApplicationScrollProfile = "claude" | "copilot" | "grok";

export function applicationScrollProfile(kind: SessionKind): ApplicationScrollProfile | null {
  return kind === "claude" || kind === "copilot" || kind === "grok" ? kind : null;
}

const AGENT_SCROLL_MODE: Readonly<Record<SessionKind, AgentScrollMode>> = {
  claude: "application",
  codex: "tmux",
  copilot: "application",
  cursor: "tmux",
  grok: "application",
  shells: "tmux",
  other: "tmux",
};

// Recommendations depend only on the detected agent, never on prior clicks.
export function preferredAgentScrollMode(kind: SessionKind): AgentScrollMode {
  return AGENT_SCROLL_MODE[kind];
}
