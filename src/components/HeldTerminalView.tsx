import type { AgentState, ConnectionState } from "../types";
import type { HeldTerminalSnapshot } from "../useHeldTerminalView";
import { PinIcon, TerminalIcon } from "../icons";
import "./HeldTerminalView.css";

interface HeldTerminalViewProps {
  snapshot: HeldTerminalSnapshot;
  sessionName: string;
  agentState: AgentState;
  connection: ConnectionState;
  onReturnToLive: () => void;
}

export function HeldTerminalView({ snapshot, sessionName, agentState, connection, onReturnToLive }: HeldTerminalViewProps) {
  const working = agentState === "working" || agentState === "running_command";
  const status = connection !== "live" ? "Disconnected"
    : working ? "Working" : agentState === "waiting_human" ? "Ready" : "Live session running";
  return (
    <section className="held-terminal-view" aria-label="Held terminal view">
      <header className="held-terminal-header">
        <div className="held-terminal-label">
          <strong><PinIcon filled /> View held · {sessionName}</strong>
          <span>Visible area captured at <time dateTime={new Date(snapshot.capturedAt).toISOString()}>
            {new Date(snapshot.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time> · This tab only</span>
        </div>
        <span className="held-terminal-status" data-working={working ? "true" : undefined} role="status">
          {status} · live output hidden
        </span>
        <button type="button" className="secondary-button" onClick={onReturnToLive}>
          <TerminalIcon /> Back to live
        </button>
      </header>
      <div className="held-terminal-image-viewport" tabIndex={0} aria-label="Frozen terminal screenshot">
        <img src={snapshot.url} alt={"Terminal view kept from " + sessionName}
          width={snapshot.width} height={snapshot.height} draggable={false} />
      </div>
    </section>
  );
}
