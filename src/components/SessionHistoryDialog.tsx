import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listSessionHistory, restoreSessionHistory, type SessionHistoryEntry } from "../api";
import { CloseIcon, HistoryIcon, RefreshIcon, SearchIcon } from "../icons";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import "./SessionHistoryDialog.css";

interface Props {
  workspaceId?: string | null;
  workspaceName?: string | null;
  onClose: () => void;
  onOpenSession: (name: string) => void;
}

function date(value: number | null): string {
  return value ? new Date(value * 1000).toLocaleString() : "Not recorded";
}

export function SessionHistoryDialog({ workspaceId = null, workspaceName, onClose, onOpenSession }: Props) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [recycled, setRecycled] = useState(true);
  const [entries, setEntries] = useState<SessionHistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SessionHistoryEntry | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const actionRef = useRef({ busy, confirm });
  actionRef.current = { busy, confirm };
  const cancel = useRef<HTMLButtonElement>(null);
  const title = workspaceId ? "Recent Sessions" : "Recycle Bin";

  useEffect(() => {
    const trigger = document.activeElement;
    const release = acquireBodyScrollLock();
    input.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!actionRef.current.busy) {
          if (actionRef.current.confirm) setConfirm(null);
          else closeRef.current();
        }
      }
      if (event.key === "Tab") {
        const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']") ?? []);
        const first = nodes[0];
        const last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) input.current?.focus();
    };
    window.addEventListener("keydown", keyboard, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("focusin", containFocus);
      release();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => { if (confirm) cancel.current?.focus(); }, [confirm]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listSessionHistory(workspaceId, search, recycled, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setEntries((previous) => offset ? [...previous, ...result.entries.filter((entry) => !previous.some((item) => item.id === entry.id))] : result.entries);
      setNextOffset(result.nextOffset);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load history");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, recycled, revision, search, workspaceId]);

  const restore = async (entry: SessionHistoryEntry, create: boolean) => {
    if (busy) return;
    setBusy(entry.id);
    setError(null);
    try {
      const result = await restoreSessionHistory(entry.id, create);
      if (result.warnings?.length) {
        setError(`${result.session} was created: ${result.warnings.join("; ")}. Find it in Sessions.`);
        setConfirm(null);
        return;
      }
      onOpenSession(result.session);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to restore this session");
    } finally { setBusy(null); }
  };

  return createPortal(<div className="session-history-backdrop">
    <section ref={dialog} className="session-history-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <HistoryIcon />
        <div><p className="eyebrow">PERSISTENT SESSION HISTORY</p><h2>{title}</h2></div>
        <button type="button" aria-label="Close session history" disabled={Boolean(busy)} onClick={onClose}><CloseIcon /></button>
      </header>
      <p className="session-history-explainer">{workspaceId ? `Previously associated with ${workspaceName || "this workspace"}. ` : "Closed tabs and ended or missing sessions. "}
        Reopen a running session, or explicitly create a fresh shell. Agent IDs are references only; terminal output and running processes are not restored.</p>
      <form className="session-history-search" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(query.trim()); setRevision((current) => current + 1); }}>
        <SearchIcon /><input ref={input} aria-label="Search session history" placeholder="Session name, old name, directory, or agent ID" maxLength={256} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" disabled={Boolean(busy)}>Search</button>
        <button type="button" aria-label="Refresh session history" disabled={loading || Boolean(busy)} onClick={() => { setOffset(0); setRevision((value) => value + 1); }}><RefreshIcon /></button>
      </form>
      <div className="session-history-filters">
        <button type="button" aria-pressed={!recycled} disabled={Boolean(busy)} onClick={() => { setOffset(0); setRecycled(false); }}>All history</button>
        <button type="button" aria-pressed={recycled} disabled={Boolean(busy)} onClick={() => { setOffset(0); setRecycled(true); }}>Recycle Bin</button>
        <span>Newest activity first / shared across browsers</span>
      </div>
      {error && <p className="session-history-error" role="alert">{error}</p>}
      {confirm && <div className="session-history-confirm" role="alertdialog" aria-label="Recreate shell confirmation">
        <strong>Recreate {confirm.name}?</strong><p>A new shell will start in {confirm.directory}. No coding agent will be resumed. Other sessions will not be replaced.</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => void restore(confirm, true)}>{busy ? "Creating..." : "Create fresh shell"}</button>
        <button ref={cancel} type="button" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>Cancel</button>
      </div>}
      <div className="session-history-list" aria-busy={loading}>
        {!loading && !entries.length && <p className="session-history-empty">No matching history yet. Closed sessions and workspace tab history will appear here as Muxdeck records them.</p>}
        {entries.map((entry) => <article key={entry.id} className="session-history-entry" aria-label={`History for ${entry.name}`}>
          <div className="session-history-entry-heading"><strong>{entry.name}</strong><span data-state={entry.state}>{entry.state === "live" ? "Still running" : entry.state === "ended" ? "Ended" : "Missing"}</span></div>
          {entry.title && <p>{entry.title}</p>}
          <code>{entry.directory}</code>
          {entry.names.length > 1 && <p>Previous names: {entry.names.filter((name) => name !== entry.name).join(", ")}</p>}
          <div className="session-history-memberships">{entry.workspaces.length ? entry.workspaces.map((workspace) => <span key={workspace.id} title={`Last associated: ${date(workspace.lastSeenAt)}${workspace.closedAt ? ` / Tab removed: ${date(workspace.closedAt)}` : ""}`}>{workspace.name}{workspace.present ? "" : " (previous)"}</span>) : <span>No saved workspace recorded</span>}</div>
          <p className="session-history-agent">{entry.agentType || "Agent not detected"}{entry.agentSessionId && <> / Reference ID: <code>{entry.agentSessionId}</code></>}</p>
          <footer><div><span>First seen {date(entry.firstSeenAt)}</span><span>Last seen {date(entry.lastSeenAt)}</span>{(entry.endedAt || entry.tabClosedAt) && <span>{entry.endedAt ? "End/disappearance recorded" : "Tab closed"} {date(entry.endedAt || entry.tabClosedAt)}</span>}</div>
            <button type="button" disabled={Boolean(busy) || loading || (entry.state !== "live" && !entry.directoryAvailable)}
              onClick={() => entry.state === "live" ? void restore(entry, false) : setConfirm(entry)}>
              {busy === entry.id ? "Opening..." : entry.state === "live" ? "Reopen session" : "Recreate shell"}
            </button>
          </footer>
          {!entry.directoryAvailable && entry.state !== "live" && <p>Saved directory is unavailable. Restore the directory before recreating this shell.</p>}
        </article>)}
        {loading && <p role="status">Loading session history...</p>}
        {nextOffset !== null && <button type="button" disabled={loading || Boolean(busy)} onClick={() => setOffset(nextOffset)}>Load older sessions</button>}
      </div>
    </section>
  </div>, document.body);
}
