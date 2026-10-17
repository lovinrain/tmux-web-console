import { useEffect, useId, useRef, useState } from "react";
import { agentDisplayLabel, agentResumeCommand } from "../../agentResume";
import { acquireBodyScrollLock } from "../../bodyScrollLock";
import { ArrowRightIcon, CloseIcon, HistoryIcon, TerminalIcon, TrashIcon } from "../../icons";
import { sessionHasOnlyDeadPanes } from "../../sessionLifecycle";
import type { Session } from "../../types";
import type { WorkspaceTabFold, WorkspaceFoldSnapshot } from "../../workspaceFolds";
import { SessionHistoryDialog } from "../SessionHistoryDialog";
import { tabTitle, workspaceSessionState } from "./presentation";
import "./WorkspaceFoldPreview.css";

interface Props {
  fold: WorkspaceTabFold;
  members: string[];
  sessions: ReadonlyMap<string, Session>;
  activeSession: string | null;
  workspaceId?: string | null;
  onPreview: (name: string) => void;
  onUnfold?: () => void;
  onFoldAndClose?: () => void;
  onDelete?: () => void;
  closeDisabledReason?: string | null;
  onRecover?: (name: string, mode: "shell" | "agent") => Promise<void>;
  onClose: () => void;
}

export function foldSnapshotCanResume(snapshot: WorkspaceFoldSnapshot | undefined): boolean {
  return Boolean(snapshot?.agentSessionId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(snapshot.agentSessionId)
    && agentResumeCommand(snapshot.agentType, snapshot.agentSessionId));
}

export function WorkspaceFoldPreview({ fold, members, sessions, activeSession, workspaceId,
  onPreview, onUnfold, onFoldAndClose, onDelete, closeDisabledReason, onRecover, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [historyName, setHistoryName] = useState<string | null>(null);
  const headingId = useId();
  const descriptionId = useId();
  const saved = new Map((fold.closedSessions ?? []).map((item) => [item.name, item]));
  const missing = members.filter((name) => !sessions.has(name) && saved.has(name));
  const present = members.flatMap((name) => sessions.has(name) ? [sessions.get(name)!] : []);
  const deadCount = present.filter(sessionHasOnlyDeadPanes).length;
  const liveCount = present.length - deadCount;

  useEffect(() => {
    if (historyName) return;
    const release = acquireBodyScrollLock();
    dialog.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!inFlight.current) onClose();
      } else if (event.key === "Tab" && dialog.current) {
        const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (dialog.current && event.target instanceof Node && !dialog.current.contains(event.target)) {
        dialog.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("focusin", containFocus);
      release();
      if (origin.current?.isConnected) origin.current.focus();
    };
  }, [historyName, onClose]);

  const recover = async (names: string[], mode: "shell" | "agent") => {
    if (!onRecover || inFlight.current) return;
    inFlight.current = true;
    setBusy(names.length === 1 ? names[0] : "all"); setError("");
    const failures: string[] = [];
    for (const name of names) {
      try { await onRecover(name, mode === "agent" && foldSnapshotCanResume(saved.get(name)) ? "agent" : "shell"); }
      catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : "Recovery failed"}`); }
    }
    setError(failures.join("\n")); setBusy(null); inFlight.current = false;
  };

  if (historyName) return <SessionHistoryDialog workspaceId={workspaceId ?? null} sessionName={historyName}
    onClose={() => setHistoryName(null)} onOpenSession={(name) => { onClose(); onPreview(name); }} />;

  return <div className="title-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
    <div ref={dialog} className="title-sheet workspace-fold-preview" role="dialog" aria-modal="true"
      aria-labelledby={headingId} aria-describedby={descriptionId} aria-busy={Boolean(busy)}
      onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <header><div><p className="eyebrow">{fold.closedSessions ? "SAVED FOLD" : "FOLD"}</p>
        <h2 id={headingId}>Fold preview</h2></div>
        <button type="button" className="title-close" disabled={Boolean(busy)} onClick={onClose} aria-label="Close fold preview"><CloseIcon /></button>
      </header>
      <p id={descriptionId}>{members.length} sessions · {liveCount} running{deadCount > 0 ? ` · ${deadCount} dead` : ""}. Preview opens a session while keeping this fold intact.
        {fold.closedSessions && " Closed sessions can be recovered individually or together."}</p>
      {fold.closedSessions && <p className="workspace-fold-resume-note">Resume reopens the latest recorded coding conversation.
        Running commands, unsaved terminal state and other panes are not restored.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul className="workspace-fold-members" aria-label="Folded sessions">
        {members.map((name) => {
          const session = sessions.get(name); const snapshot = saved.get(name);
          const title = session ? tabTitle(name, sessions) : snapshot?.title || name;
          return <li key={name} data-fold-preview-session={name} className={name === activeSession ? "active" : ""}>
            <div className="workspace-fold-member-info"><strong>{title}</strong>
              <small>{session ? workspaceSessionState(session) : "Closed"}{snapshot ? ` · ${agentDisplayLabel(snapshot.agentType)}` : ""}</small>
              {snapshot && <><code>{snapshot.directory}</code>
                {snapshot.agentSessionId && <small>{snapshot.agentSessionId}</small>}</>}
            </div>
            <div className="workspace-fold-member-actions">
              {session ? <button type="button" disabled={Boolean(busy)} aria-label={`Preview ${title}`}
                onClick={() => { onClose(); onPreview(name); }}><TerminalIcon /><span>Preview</span></button>
                : snapshot && onRecover && <>
                  <button type="button" disabled={Boolean(busy)} aria-label={`Recover shell for ${title}`}
                    onClick={() => void recover([name], "shell")}>{busy === name ? "Recovering…" : "Shell only"}</button>
                  <button type="button" disabled={Boolean(busy) || !foldSnapshotCanResume(snapshot)}
                    aria-label={`Recover coding session for ${title}`} title={foldSnapshotCanResume(snapshot)
                      ? "Recreate tmux and resume the recorded coding conversation" : "No supported coding conversation ID was recorded"}
                    onClick={() => void recover([name], "agent")}>Resume coding session</button>
                </>}
              <button type="button" disabled={Boolean(busy)} aria-label={`View history for ${title}`}
                onClick={() => setHistoryName(name)}><HistoryIcon /><span>History</span></button>
            </div>
          </li>;
        })}
      </ul>
      <footer>
        {missing.length > 0 && onRecover && <>
          <button type="button" disabled={Boolean(busy)} onClick={() => void recover(missing, "shell")}>Recover all shells</button>
          <button type="button" disabled={Boolean(busy) || !missing.some((name) => foldSnapshotCanResume(saved.get(name)))}
            title="Resume supported recorded agents; sessions without a resume command get a shell"
            onClick={() => void recover(missing, "agent")}>Recover all + coding</button>
        </>}
        {onUnfold && <button type="button" disabled={Boolean(busy)} onClick={() => { onClose(); onUnfold(); }}><ArrowRightIcon />Unfold</button>}
        {onFoldAndClose && present.length > 0 && <button type="button" className="danger-button" disabled={Boolean(busy) || Boolean(closeDisabledReason)}
          title={closeDisabledReason ?? "Save metadata, then close every session in this fold"}
          onClick={() => { onClose(); onFoldAndClose(); }}>Fold and close</button>}
        {onDelete && <button type="button" className="danger-button" disabled={Boolean(busy) || Boolean(closeDisabledReason)}
          title={closeDisabledReason ?? "Archive live sessions, then remove this fold and its tabs; keep session history"}
          onClick={() => { onClose(); onDelete(); }}><TrashIcon />Delete fold</button>}
      </footer>
    </div>
  </div>;
}
