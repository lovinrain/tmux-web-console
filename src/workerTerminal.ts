import { ApiRequestError, BASE_PATH } from "./api";

const IDENTITY_FIELDS = ["sessionId", "sessionCreated", "serverStarted", "serverPid", "paneId", "panePid"] as const;
const METADATA_FIELDS = ["historyId", "runId", "providerExecutionId", "workspace"] as const;

export interface WorkerTerminalSnapshot {
  state: "live" | "ended" | "stale" | "missing";
  session: string | null;
  historyId: string | null;
  text: string;
  limited: boolean;
  capturedAt: number | null;
  runId: string | null;
  providerExecutionId: string | null;
}

/** No editable session name or workspace state participates in worker lookup. */
export function workerTerminalQuery(search: string): string {
  const query = new URLSearchParams(search);
  const allowed: readonly string[] = [...IDENTITY_FIELDS, ...METADATA_FIELDS];
  for (const [field] of query) {
    if (!allowed.includes(field) || query.getAll(field).length !== 1) {
      throw new Error("This worker link has invalid or duplicate identity fields.");
    }
  }
  for (const field of IDENTITY_FIELDS) {
    const value = query.get(field) ?? "";
    const valid = field === "sessionId" ? /^\$[0-9]+$/.test(value)
      : field === "paneId" ? /^%[0-9]+$/.test(value)
        : /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
    if (!valid) throw new Error("This worker link is missing a valid immutable terminal identity.");
  }
  for (const field of METADATA_FIELDS) {
    const value = query.get(field);
    if (value !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      throw new Error("This worker link has invalid run or history metadata.");
    }
  }
  // Workspace is a return-navigation hint; it must never select the terminal.
  query.delete("workspace");
  return query.toString();
}

export async function loadWorkerTerminal(query: string, signal: AbortSignal): Promise<WorkerTerminalSnapshot> {
  const response = await fetch(`${BASE_PATH}/api/worker-terminal?${query}`, {
    signal, headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiRequestError(payload.error || "Worker terminal could not be opened.", response.status);
  return payload as WorkerTerminalSnapshot;
}
