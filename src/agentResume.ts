import type { RecoverableSession } from "./api";

export type RecoveryAgentType = RecoverableSession["agentType"];

export const AGENT_DISPLAY_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  grok: "Grok",
  "dsh-tui": "DSH TUI",
};

export function agentDisplayLabel(agentType: RecoveryAgentType): string {
  return agentType ? AGENT_DISPLAY_LABELS[agentType] ?? agentType : "Shell";
}

/**
 * The CLI invocation that reopens a recorded agent conversation.
 *
 * Ordinary shell recreation only restores the shell. Saved-fold recovery can
 * explicitly launch an equivalent, validated argument vector after checking
 * the recorded ID and native transcript. Copilot is
 * omitted deliberately - no resume-by-id form has been verified for it.
 */
export function agentResumeCommand(
  agentType: RecoveryAgentType,
  sessionId: string | null,
  directory?: string,
): string | null {
  if (!sessionId) return null;
  // Keep recorded values literal when the command is pasted into a shell.
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const id = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : quote(sessionId);
  let command: string;
  switch (agentType) {
    case "claude": command = `claude -r ${id}`; break;
    case "codex": command = `codex resume ${id}`; break;
    case "cursor": command = `cursor-agent --resume ${id}`; break;
    case "grok": command = `grok -r ${id}`; break;
    default: return null;
  }
  return directory ? `cd -- ${quote(directory)} && ${command}` : command;
}

/** Resume restores the conversation only, never the work that was in flight. */
export const AGENT_RESUME_CAVEAT =
  "Reopens the recorded conversation only. Uncommitted work, running commands, "
  + "and terminal scrollback are not restored.";
