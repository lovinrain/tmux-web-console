import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { listWorkspaces, type SavedWorkspace, type WorkspaceSessionTransferOperation } from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { ArrowUpIcon, CheckIcon, CloseIcon, FolderIcon, SearchIcon } from "../icons";
import { sessionDisplayTitle } from "../sessionDashboardModel";
import {
  previousWorkspaceSibling, workspaceSessionDepth, workspaceSessionParent,
  workspaceSessionTreeOrder, workspaceSubtree, type SessionWorkspaceState,
} from "../workspaceState";
import type { SessionWorkspaceTransferDialogProps } from "./SessionWorkspaceTransferDialog";
import "./SessionPlacementDialog.css";

type PlacementProps = SessionWorkspaceTransferDialogProps & {
  sourceWorkspace: SessionWorkspaceState;
  onReparentSession: NonNullable<SessionWorkspaceTransferDialogProps["onReparentSession"]>;
};

export function SessionPlacementDialog({
  sessionNames, sourceWorkspace, sourceWorkspaceId, sourceWorkspaceName,
  sessions = [], workspacePinnedSessions = [], onReparentSession, onTransfer, onClose,
}: PlacementProps) {
  const name = sessionNames[0];
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<SavedWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [destinationId, setDestinationId] = useState("");
  const currentParent = workspaceSessionParent(name, sourceWorkspace.parents) ?? null;
  const [parentName, setParentName] = useState<string | null>(currentParent);
  const [query, setQuery] = useState("");
  const [operation, setOperation] = useState<WorkspaceSessionTransferOperation>("move");
  const [error, setError] = useState("");
  const local = destinationId === "";
  const destination = workspaces.find((workspace) => workspace.id === destinationId);
  const sourceLabel = sourceWorkspaceName || "Unsaved workspace";
  const destinationLabel = local ? sourceLabel : destination?.name ?? "Workspace";
  const titles = new Map(sessions.map((session) => [session.name, sessionDisplayTitle(session)]));
  const title = (sessionName: string) => titles.get(sessionName) || sessionName;
  const branch = workspaceSubtree(name, sourceWorkspace.openSessions, sourceWorkspace.parents);
  const hasPinned = branch.some((sessionName) => workspacePinnedSessions.includes(sessionName));
  const transferOperation = hasPinned ? "copy" : operation;
  const tabs = local ? sourceWorkspace.openSessions : destination?.tabs ?? [];
  const parents = local ? sourceWorkspace.parents : destination?.parents;
  const unavailableParents = new Set(branch.flatMap((sessionName) => (
    workspaceSubtree(sessionName, tabs, parents)
  )));
  branch.forEach((sessionName) => unavailableParents.add(sessionName));
  const availableParents = workspaceSessionTreeOrder(tabs, parents)
    .filter((sessionName) => !unavailableParents.has(sessionName));
  const matchingParents = availableParents.filter((sessionName) => (
    `${title(sessionName)} ${sessionName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ));
  const previousSibling = previousWorkspaceSibling(sourceWorkspace, name);
  const parentAvailable = parentName === null || availableParents.includes(parentName);
  const sourceAvailable = sourceWorkspace.openSessions.includes(name);
  const canApply = sourceAvailable && parentAvailable
    && (local ? parentName !== currentParent : Boolean(destination));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void listWorkspaces(controller.signal).then((items) => {
      if (!controller.signal.aborted) setWorkspaces(items.sort((a, b) => a.name.localeCompare(b.name)));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Unable to load workspaces");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseScroll = acquireBodyScrollLock();
    const focusFrame = requestAnimationFrame(() => searchRef.current?.focus());
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) {
        (busyRef.current ? dialogRef.current : searchRef.current)?.focus();
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']",
      ));
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("focusin", containFocus);
    window.addEventListener("keydown", keyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      releaseScroll();
      document.removeEventListener("focusin", containFocus);
      window.removeEventListener("keydown", keyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const apply = async (targetParent = parentName, forceLocal = false) => {
    if (busyRef.current || !sourceAvailable) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (local || forceLocal) await onReparentSession(name, targetParent);
      else {
        if (!destination) throw new Error("Choose a destination workspace.");
        await onTransfer(branch, destination.id, transferOperation, destination.sessionRevision, targetParent);
      }
      closeRef.current();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to place this session.");
      if (!local && !forceLocal) setReload((value) => value + 1);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <div className="workspace-transfer-backdrop session-placement-backdrop" role="presentation"
    onMouseDown={() => { if (!busyRef.current) onClose(); }}>
    <section ref={dialogRef} className="workspace-transfer-dialog session-placement-dialog" role="dialog"
      aria-modal="true" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-hint`}
      aria-busy={busy} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <header className="workspace-transfer-header">
        <div><p className="eyebrow">ORGANIZE SESSION</p><h2 id={`${id}-heading`}>Move / Nest</h2></div>
        <button type="button" className="icon-button" aria-label="Close session placement" disabled={busy} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="session-placement-source">
        <strong title={name}>{title(name)}</strong>
        <span>{sourceLabel} / {currentParent ? title(currentParent) : "Top level"}</span>
        <p id={`${id}-hint`}>{branch.length > 1
          ? `${branch.length - 1} nested session${branch.length === 2 ? " comes" : "s come"} with it.`
          : "Choose top level or an existing session to nest under."}</p>
      </div>
      {local && <div className="session-placement-quick" role="group" aria-label="Quick placement">
        <button type="button" disabled={busy || !currentParent || !sourceAvailable}
          title={currentParent ? `Move out of ${title(currentParent)}` : "Already at the top level"}
          onClick={() => void apply(workspaceSessionParent(currentParent!, sourceWorkspace.parents) ?? null, true)}>
          <ArrowUpIcon /> Up one level
        </button>
        <button type="button" disabled={busy || !previousSibling || !sourceAvailable}
          title={previousSibling ? `Nest under ${title(previousSibling)}` : "No previous sibling to nest under"}
          onClick={() => { if (previousSibling) void apply(previousSibling, true); }}>
          <span aria-hidden="true">↳</span> Nest under previous
        </button>
      </div>}
      <label className="session-placement-workspace">
        <span>Workspace</span>
        <select aria-label="Destination workspace" value={destinationId} disabled={busy}
          onChange={(event) => {
            setDestinationId(event.target.value);
            setParentName(event.target.value === "" ? currentParent : null);
            setQuery(""); setError("");
          }}>
          <option value="">This workspace · {sourceLabel}</option>
          {workspaces.filter((workspace) => workspace.id !== sourceWorkspaceId).map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
      </label>
      {loading && <p className="session-placement-note" role="status">Loading other workspaces…</p>}
      {loadError && <p className="session-placement-note" role="alert">{loadError} <button type="button"
        disabled={busy} onClick={() => setReload((value) => value + 1)}>Retry</button></p>}
      <label className="workspace-transfer-search session-placement-search">
        <SearchIcon /><input ref={searchRef} type="search" aria-label="Find a parent session" placeholder="Find a parent session…"
          value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <fieldset className="session-placement-tree" disabled={busy}>
        <legend>Place under</legend>
        <label className={`session-placement-target${parentName === null ? " selected" : ""}`}>
          <input type="radio" name={`${id}-parent`} value="" checked={parentName === null} onChange={() => setParentName(null)} />
          <FolderIcon /><span><strong>Top level</strong><small>Alongside the other root sessions</small></span>
          {parentName === null && <CheckIcon />}
        </label>
        {matchingParents.map((candidate) => <label key={candidate}
          className={`session-placement-target${parentName === candidate ? " selected" : ""}`}
          style={{ "--placement-depth": Math.min(5, workspaceSessionDepth(candidate, parents)) } as CSSProperties}>
          <input type="radio" name={`${id}-parent`} value={candidate} checked={parentName === candidate}
            aria-label={`Nest under ${title(candidate)}`} onChange={() => setParentName(candidate)} />
          <span className="session-placement-branch" aria-hidden="true">↳</span>
          <span><strong>{title(candidate)}</strong><small>{workspaceSessionParent(candidate, parents)
            ? `Under ${title(workspaceSessionParent(candidate, parents)!)}` : candidate}</small></span>
          {parentName === candidate && <CheckIcon />}
        </label>)}
        {query && matchingParents.length === 0 && <p className="session-placement-note">No matching parent sessions.</p>}
      </fieldset>
      {!local && <div className="session-placement-operation" role="group" aria-label="Transfer operation">
        {(["move", "copy"] as const).map((value) => <button key={value} type="button"
          aria-pressed={transferOperation === value} disabled={busy || (value === "move" && hasPinned)}
          onClick={() => setOperation(value)}>{value === "move" ? "Move" : "Copy"}</button>)}
        <span>{hasPinned ? "Pinned sessions can be copied; unpin before moving."
          : transferOperation === "copy" ? "Keep this branch here too." : "Remove this branch from this workspace."}</span>
      </div>}
      <p className="session-placement-preview" aria-live="polite">
        {destinationLabel} <span aria-hidden="true">/</span> {parentName ? title(parentName) : "Top level"}
        <span aria-hidden="true"> / </span><strong>{title(name)}</strong>
      </p>
      {!sourceAvailable && <p className="workspace-transfer-row-error" role="alert">This session is no longer in the source workspace.</p>}
      {!parentAvailable && <p className="workspace-transfer-row-error" role="alert">That parent is no longer available. Choose another placement.</p>}
      {error && <p className="workspace-transfer-row-error" role="alert">{error}</p>}
      <footer className="session-placement-footer">
        <span>Tip: drag onto a tab to nest.</span>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || !canApply || (!local && (loading || Boolean(loadError)))}
          onClick={() => void apply()}>{busy ? "Saving…" : local ? parentName ? "Nest session" : "Make top level"
            : transferOperation === "copy" ? "Copy here" : "Move here"}</button>
      </footer>
    </section>
  </div>;
}
