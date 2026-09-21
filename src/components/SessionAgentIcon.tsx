import { TerminalIcon } from "../icons";
import { paneCommandKind, type SessionKind } from "../sessionDashboardModel";
import type { Session } from "../types";
import "./SessionAgentIcon.css";

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
  return (
    <span className="session-agent-icon" data-agent-kind={kind} title={label} aria-hidden="true">
      {kind === "shells" ? <TerminalIcon /> : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {kind === "claude" && <path d="M12 2v6m0 8v6M2 12h6m8 0h6M5 5l4 4m6 6 4 4M5 19l4-4m6-6 4-4M8 3l2 5m4 8 2 5M3 16l5-2m8-4 5-2" />}
          {kind === "codex" && <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" />}
          {kind === "copilot" && <>
            <path d="M5 9V7a7 7 0 0 1 14 0v2M5 17v2l7 3 7-3v-2M3 10H1v6h3m18-6h1v6h-3" />
            <rect x="3" y="8" width="8" height="9" rx="3" />
            <rect x="13" y="8" width="8" height="9" rx="3" />
          </>}
          {kind === "cursor" && <path d="m5 2 15 12-8 1-4 7L5 2Z" fill="currentColor" strokeWidth="1" />}
          {kind === "grok" && <>
            <path d="M19 12a7 7 0 1 1-7-7h3" />
            <path d="m9 15 12-12m-7 0h7v7" strokeWidth="2.2" />
          </>}
          {kind === "other" && <>
            <rect x="5" y="5" width="14" height="14" rx="2" />
            <path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" />
          </>}
        </svg>
      )}
    </span>
  );
}
