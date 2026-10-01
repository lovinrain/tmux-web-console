import { useEffect, useState } from "react";
import { BASE_PATH } from "../api";
import { loadWorkerTerminal, workerTerminalQuery, type WorkerTerminalSnapshot } from "../workerTerminal";
import "./WorkerTerminalScreen.css";

const STATE_LABELS = { live: "Live worker", ended: "Worker ended · retained history", stale: "Stale worker association · retained history", missing: "Worker association unavailable" };

export function WorkerTerminalScreen({ search }: { search: string }) {
  const [snapshot, setSnapshot] = useState<WorkerTerminalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let query: string;
    try {
      query = workerTerminalQuery(search);
    } catch (failure) {
      setSnapshot(null);
      setError(failure instanceof Error ? failure.message : "Invalid worker link.");
      return;
    }
    setSnapshot(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const next = await loadWorkerTerminal(query, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setError(null);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "Worker terminal is unavailable.");
      }
      if (!controller.signal.aborted) timer = setTimeout(update, 1500);
    };
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [search, refresh]);

  return (
    <main className="worker-terminal-screen">
      <header className="worker-terminal-header">
        <a href={`${BASE_PATH}/`}>Muxdeck</a>
        <h1>Worker terminal</h1>
        <button type="button" className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </header>
      <p role="status" data-testid="worker-terminal-state">
        {error ? "Worker connection unavailable" : snapshot ? STATE_LABELS[snapshot.state] : "Opening worker terminal…"}
        {!error && snapshot?.session ? ` · ${snapshot.session}` : ""}
      </p>
      {error && <p role="alert">{error}</p>}
      <p className="worker-terminal-notice">
        Read-only output. Send instructions or stop this task through your main agent or Multica.
      </p>
      <p className="worker-terminal-notice">Closing this view does not stop the task.</p>
      {(snapshot?.runId || snapshot?.providerExecutionId) && (
        <details>
          <summary>Details</summary>
          {snapshot.runId && <p className="worker-terminal-identity">Run: {snapshot.runId}</p>}
          {snapshot.providerExecutionId && <p className="worker-terminal-identity">Provider execution: {snapshot.providerExecutionId}</p>}
        </details>
      )}
      {snapshot?.state === "stale" && <p>The original pane is gone or has been replaced. This link stays with the original worker.</p>}
      {snapshot?.state === "missing" && <p>No live terminal or retained output was recorded for this exact worker identity.</p>}
      {snapshot?.limited && <p>Showing a bounded recent capture. Earlier output may be available in the run transcript.</p>}
      <pre className="worker-terminal-output" aria-label="Worker terminal output" tabIndex={0}>
        {snapshot?.text || (snapshot ? "No retained output is available yet." : "")}
      </pre>
      {error && snapshot && <p>Output above is the last confirmed capture.</p>}
    </main>
  );
}
