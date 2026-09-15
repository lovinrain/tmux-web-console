import type { RecoverableSession } from "./api";

export type RecoveryAgentType = RecoverableSession["agentType"];

export const AGENT_DISPLAY_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  grok: "Grok",
};

export function agentDisplayLabel(agentType: RecoveryAgentType): string {
  return agentType ? AGENT_DISPLAY_LABELS[agentType] ?? agentType : "Shell";
}

/**
 * The CLI invocation that reopens a recorded agent conversation.
 *
 * Muxdeck never runs this: recreating a shell only restores the shell. The
 * command is shown so the recorded reference is actionable by hand. Copilot is
 * omitted deliberately - no resume-by-id form has been verified for it.
 */
export function agentResumeCommand(
  agentType: RecoveryAgentType,
  sessionId: string | null,
): string | null {
  if (!sessionId) return null;
  switch (agentType) {
    case "claude": return `claude -r ${sessionId}`;
    case "codex": return `codex resume ${sessionId}`;
    case "cursor": return `cursor-agent --resume ${sessionId}`;
    case "grok": return `grok -r ${sessionId}`;
    default: return null;
  }
}

/** Resume restores the conversation only, never the work that was in flight. */
export const AGENT_RESUME_CAVEAT =
  "Reopens the recorded conversation only. Uncommitted work, running commands, "
  + "and terminal scrollback are not restored.";
