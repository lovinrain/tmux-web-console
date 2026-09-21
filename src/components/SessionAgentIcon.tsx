import { TerminalIcon } from "../icons";
import anthropicMark from "../assets/agent-brands/anthropic.svg";
import openaiMark from "../assets/agent-brands/openai.svg";
import grokMark from "../assets/agent-brands/grok.svg";
import cursorMark from "../assets/agent-brands/cursor.svg";
import copilotMark from "../assets/agent-brands/githubcopilot.svg";
import { paneCommandKind, type SessionKind } from "../sessionDashboardModel";
import type { Session } from "../types";
import "./SessionAgentIcon.css";

const BRAND_MARKS: Partial<Record<SessionKind, string>> = {
  claude: anthropicMark,
  codex: openaiMark,
  copilot: copilotMark,
  cursor: cursorMark,
  grok: grokMark,
};

const LABELS: Record<SessionKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  grok: "Grok",
  shells: "Shell",
  other: "Process",
};

export function sessionAgentInfo(session?: Session) {
  const pane = session?.panes.find((candidate) => candidate.id === session.activePaneId)
    ?? session?.panes[0];
  const kind = paneCommandKind(pane?.command ?? "", pane?.title ?? "");
  const label = !session ? "Session unavailable"
    : !pane ? "Agent unknown"
      : pane.dead ? "Pane ended"
        : kind === "other" ? `Process: ${pane.command || "unknown"}` : LABELS[kind];
  return { kind: !pane || pane.dead ? "other" : kind, label };
}

export function SessionAgentIcon({ session }: { session?: Session }) {
  const { kind, label } = sessionAgentInfo(session);
  const brandMark = BRAND_MARKS[kind];
  const tone = kind === "shells" ? "shell" : kind === "other" ? "process" : kind;
  return (
    <span className={`session-agent-icon agent-badge ${tone}`} data-agent-kind={kind} title={label} aria-hidden="true">
      {brandMark ? (
        <span className="session-agent-brand" style={{
          maskImage: `url("${brandMark}")`,
          WebkitMaskImage: `url("${brandMark}")`,
        }} />
      ) : kind === "shells" ? <TerminalIcon /> : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" />
        </svg>
      )}
    </span>
  );
}
