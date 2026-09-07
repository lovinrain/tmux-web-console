import { useRef, useState } from "react";
import type { Session } from "../types";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import "./BulkSessionActionsDialog.css";

export type BulkSessionAction = "close" | "end";
export interface BulkSessionTarget { name: string; session?: Session }
interface Props {
  action: BulkSessionAction;
  targets: BulkSessionTarget[];
  onApply: (target: BulkSessionTarget) => Promise<void>;
  onClose: () => void;
}

export function BulkSessionActionsDialog({ action, targets, onApply, onClose }: Props) {
  const [results, setResults] = useState<Record<string, string>>({});
  const completed = useRef(new Set<string>());
  const ending = action === "end";
  const remaining = targets.length - completed.current.size;
  const noun = ending ? "session" : "tab";
  const apply = async () => {
    let failures = 0;
    // Keep the confirmed identities fixed. Retries must never include completed targets.
    for (const target of targets) {
      if (completed.current.has(target.name)) continue;
      setResults((current) => ({ ...current, [target.name]: "Processing..." }));
      try {
        if (ending && !target.session) throw new Error("Session unavailable; refresh before trying to end it.");
        await onApply(target);
        completed.current.add(target.name);
        setResults((current) => ({ ...current, [target.name]: ending ? "Ended" : "Tab closed" }));
      } catch (error) {
        failures += 1;
        setResults((current) => ({ ...current, [target.name]: error instanceof Error ? error.message : "Action failed" }));
      }
    }
    if (failures) throw new Error(`${completed.current.size} succeeded; ${failures} failed. Only failed items will be retried. You can also dismiss this window.`);
  };
  return <SessionTerminateDialog
    sessionName="" sessionTitle={null} onClose={onClose} onTerminate={apply}
    heading={`${ending ? "End" : "Close"} ${targets.length} selected ${noun}${targets.length === 1 ? "" : "s"}?`}
    destructive={ending}
    confirmLabel={`${Object.keys(results).length ? "Retry" : ending ? "End" : "Close"} ${remaining} ${noun}${remaining === 1 ? "" : "s"}`}
    pendingLabel={ending ? "Ending sessions..." : "Closing tabs..."}
    description={<>
      <p>{ending
        ? "This ends the selected tmux sessions and every pane and program running in them, across all workspaces. Unsaved terminal work can be lost. Their owned session terminals will also end."
        : "Remove these tabs from this workspace only. Their tmux sessions and session terminals keep running, and other workspaces are unchanged."}</p>
      <p>{ending
        ? "Session metadata remains in Recycle Bin history; terminal contents and running programs cannot be restored from it."
        : "Closed tabs are recorded in Recent Sessions / Recycle Bin history so they can be reopened."}</p>
      <ul className="bulk-session-targets" aria-label="Selected sessions">
        {targets.map((target) => <li key={target.name}>
          <strong>{target.session?.customTitle || target.name}</strong>
          {target.session?.customTitle && <code>{target.name}</code>}
          <span>{results[target.name] || (ending && !target.session ? "Unavailable" : target.session?.agentState === "working" ? "Working" : "Ready")}</span>
        </li>)}
      </ul>
    </>}
  />;
}
