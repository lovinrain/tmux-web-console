import { useRef, useState } from "react";
import { agentDisplayLabel } from "../agentResume";
import type { RecoverableSession } from "../api";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import "./BulkSessionActionsDialog.css";

export interface WorkspaceRecreateTarget {
  name: string;
  recovery?: RecoverableSession;
}

interface Props {
  targets: WorkspaceRecreateTarget[];
  workspaceName?: string | null;
  onRecreate: (target: WorkspaceRecreateTarget) => Promise<void>;
  onClose: () => void;
}

export function recreateBlockedReason(
  target: WorkspaceRecreateTarget,
): string | null {
  if (!target.recovery) return "No saved directory; this tab cannot be recreated.";
  if (!target.recovery.directoryAvailable) {
    return "Saved directory is unavailable. Restore it before recreating.";
  }
  return null;
}

/**
 * Bulk recovery for a workspace whose shells died with the host. Applies
 * sequentially: the API serialises session creation on one lock, and a restart
 * can leave dozens of tabs missing at once.
 */
export function WorkspaceRecreateDialog({
  targets,
  workspaceName,
  onRecreate,
  onClose,
}: Props) {
  const [results, setResults] = useState<Record<string, string>>({});
  const completed = useRef(new Set<string>());
  const remaining = targets.length - completed.current.size;

  const apply = async () => {
    let failures = 0;
    // Keep the confirmed target list fixed. Retries must never repeat a shell
    // that already came back, or the name collides with its own live session.
    for (const target of targets) {
      if (completed.current.has(target.name)) continue;
      const blocked = recreateBlockedReason(target);
      if (blocked) {
        failures += 1;
        setResults((current) => ({ ...current, [target.name]: blocked }));
        continue;
      }
      setResults((current) => ({ ...current, [target.name]: "Recreating..." }));
      try {
        await onRecreate(target);
        completed.current.add(target.name);
        setResults((current) => ({ ...current, [target.name]: "Recreated" }));
      } catch (error) {
        failures += 1;
        setResults((current) => ({
          ...current,
          [target.name]: error instanceof Error ? error.message : "Recreate failed",
        }));
      }
    }
    if (failures) {
      throw new Error(
        `${completed.current.size} recreated; ${failures} failed. Only failed shells will be retried. You can also dismiss this window.`,
      );
    }
  };

  return <SessionTerminateDialog
    sessionName="" sessionTitle={null} onClose={onClose} onTerminate={apply}
    heading={`Recreate ${targets.length} missing shell${targets.length === 1 ? "" : "s"}?`}
    destructive={false}
    confirmLabel={`${Object.keys(results).length ? "Retry" : "Recreate"} ${remaining} shell${remaining === 1 ? "" : "s"}`}
    pendingLabel="Recreating shells..."
    description={<>
      <p>
        This starts a fresh detached shell for each missing tab
        {workspaceName ? ` in ${workspaceName}` : ""}, at its saved working
        directory, under its original name so it returns to the same tab.
      </p>
      <p>
        Shells start empty. Agent IDs are identification references only; Muxdeck
        never resumes a coding agent automatically.
      </p>
      <ul className="bulk-session-targets" aria-label="Missing shells">
        {targets.map((target) => <li key={target.name}>
          <strong>{target.name}</strong>
          {target.recovery && (
            <span className={`agent-badge ${target.recovery.agentType ?? "shell"}`}>
              {agentDisplayLabel(target.recovery.agentType)}
            </span>
          )}
          {target.recovery && <code>{target.recovery.directory}</code>}
          <span>{results[target.name] || recreateBlockedReason(target) || "Ready"}</span>
        </li>)}
      </ul>
    </>}
  />;
}
