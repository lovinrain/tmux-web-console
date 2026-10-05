import { useState } from "react";

export function WorkspaceViewDisconnected({ onRejoin }: { onRejoin: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejoin = async () => {
    setPending(true);
    setError(null);
    try { await onRejoin(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to rejoin."); setPending(false); }
  };
  return (
    <div className="workspace-view-paused" role="status">
      <strong>This view was disconnected</strong>
      <p>Your sessions are still running. Rejoin to attach this tab again.</p>
      <button type="button" className="primary-button" disabled={pending} onClick={() => void rejoin()}>
        {pending ? "Rejoining…" : "Rejoin"}
      </button>
      {error && <p className="title-error" role="alert">{error}</p>}
    </div>
  );
}
