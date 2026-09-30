import type { SessionKind } from "./sessionDashboardModel";

export type AgentScrollMode = "application" | "tmux";
export type ApplicationScrollProfile = "claude" | "codex" | "copilot" | "grok" | "wheel";

export function applicationScrollProfile(kind: SessionKind): ApplicationScrollProfile {
  // Agent-specific tuning is optional; every other application can receive a
  // plain wheel step when its active pane has enabled mouse reporting.
  return kind === "claude" || kind === "codex" || kind === "copilot" || kind === "grok" ? kind : "wheel";
}

const AGENT_SCROLL_MODE: Readonly<Record<SessionKind, AgentScrollMode>> = {
  claude: "application",
  codex: "application",
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
