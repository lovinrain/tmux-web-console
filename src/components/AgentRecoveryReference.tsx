import { useEffect, useRef, useState } from "react";
import {
  AGENT_RESUME_CAVEAT,
  agentDisplayLabel,
  agentResumeCommand,
  type RecoveryAgentType,
} from "../agentResume";

interface AgentRecoveryReferenceProps {
  sessionName: string;
  agentType: RecoveryAgentType;
  agentSessionId: string | null;
  /** Compact omits the caveat line, for dense card layouts. */
  compact?: boolean;
}

async function copyText(text: string): Promise<boolean> {
  // The async clipboard needs a secure context, which a console reached over
  // plain HTTP on a LAN or tunnel does not have. Report that rather than
  // throwing, so the caller can offer the text for manual selection instead.
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * What agent was running here, and how to reopen its conversation. Muxdeck
 * records the reference but never resumes an agent itself.
 */
export function AgentRecoveryReference({
  sessionName,
  agentType,
  agentSessionId,
  compact = false,
}: AgentRecoveryReferenceProps) {
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const manualRef = useRef<HTMLInputElement>(null);
  const command = agentResumeCommand(agentType, agentSessionId);

  useEffect(() => {
    if (copied !== "done") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (copied === "manual") manualRef.current?.select();
  }, [copied]);

  if (!agentType && !agentSessionId) return null;

  return (
    <div className="agent-recovery-reference">
      <div className="agent-recovery-heading">
        <span className={`agent-badge ${agentType ?? "shell"}`}>
          {agentDisplayLabel(agentType)}
        </span>
        <span className="agent-recovery-eyebrow">
          {agentSessionId ? "was running here" : "no recorded session id"}
        </span>
      </div>

      {agentSessionId && (
        <code className="agent-recovery-id" title={agentSessionId}>{agentSessionId}</code>
      )}

      {command ? (
        <>
          <div className="agent-recovery-command">
            <code>{command}</code>
            <button
              type="button"
              aria-label={`Copy resume command for ${sessionName}`}
              onClick={() => void copyText(command).then(
                (ok) => setCopied(ok ? "done" : "manual"),
              )}
            >
              {copied === "done" ? "Copied" : "Copy"}
            </button>
          </div>
          {copied === "manual" && (
            <input
              ref={manualRef}
              className="agent-recovery-manual"
              readOnly
              value={command}
              aria-label={`Resume command for ${sessionName}, select and copy manually`}
              onFocus={(event) => event.target.select()}
            />
          )}
          {!compact && <p className="agent-recovery-caveat">{AGENT_RESUME_CAVEAT}</p>}
        </>
      ) : agentSessionId && (
        <p className="agent-recovery-caveat">
          No resume command is known for this agent; use the session ID above.
        </p>
      )}
    </div>
  );
}
