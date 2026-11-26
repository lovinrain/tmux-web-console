import type { RecoverableSession } from "./api";
import { AGENT_DISPLAY_LABELS, isAgentType } from "./types";

export type RecoveryAgentType = RecoverableSession["agentType"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{26}$/;

export function agentDisplayLabel(agentType?: string | null): string {
  return isAgentType(agentType) ? AGENT_DISPLAY_LABELS[agentType] : agentType || "Shell";
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
  if ((agentType === "pi" || agentType === "omp" || agentType === "agy") && sessionId.match(UUID)?.[0] !== sessionId) {
    return null;
  }
  if (agentType === "opencode" && sessionId.match(OPENCODE_SESSION_ID)?.[0] !== sessionId) return null;
  // Keep recorded values literal when the command is pasted into a shell.
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const id = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : quote(sessionId);
  let command: string;
  switch (agentType) {
    case "claude": command = `claude -r ${id}`; break;
    case "codex": command = `codex resume ${id}`; break;
    case "cursor": command = `cursor-agent --resume ${id}`; break;
    case "grok": command = `grok -r ${id}`; break;
    case "pi": command = `pi --session ${id}`; break;
    case "omp": command = `omp --resume ${id}`; break;
    case "opencode": command = `opencode --session ${id}`; break;
    case "agy": command = `agy --conversation ${id}`; break;
    default: return null;
  }
  return directory ? `cd -- ${quote(directory)} && ${command}` : command;
}

/** Resume restores the conversation only, never the work that was in flight. */
export const AGENT_RESUME_CAVEAT =
  "Reopens the recorded conversation only. Uncommitted work, running commands, "
  + "and terminal scrollback are not restored.";
