import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CloseIcon } from "../icons";
import type { WorkspaceView } from "../api";
import type { WorkspaceViewsController } from "../useWorkspaceViews";

export function WorkspaceViewsDialog({ controller, onClose }: {
  controller: WorkspaceViewsController;
  onClose: () => void;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownViews = controller.views.filter((view) => view.inScope);
  const relatedViews = controller.views.filter((view) => !view.inScope);
  const synced = controller.identity.group
    ? ownViews.filter((view) => view.group === controller.identity.group).length : 0;

  useEffect(() => {
    const release = acquireBodyScrollLock();
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], [tabindex='0']",
    ) ?? []);
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog?.contains(event.target)) dialog?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const items = focusables();
        const first = items[0], last = items.at(-1);
        if (!first || !last) { event.preventDefault(); dialog?.focus(); }
        else if (!dialog?.contains(document.activeElement) || document.activeElement === dialog
          || (!event.shiftKey && document.activeElement === last)
          || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("focusin", containFocus);
    window.addEventListener("keydown", onKey, true);
    focusables()[0]?.focus();
    return () => {
      document.removeEventListener("focusin", containFocus);
      window.removeEventListener("keydown", onKey, true);
      release();
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
    };
  }, [onClose]);

  const disconnect = async (id: string) => {
    setPending(id);
    setError(null);
    try { await controller.evict(id); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to disconnect this view."); }
    finally { setPending(null); }
  };

  const row = (view: WorkspaceView) => {
    const current = view.id === controller.identity.id;
    const label = `View ${view.number}`;
    const membership = !view.inScope ? "Workspace unknown"
      : view.group && view.group === controller.identity.group ? "In this sync group"
        : view.group ? "Other sync group" : "Independent view";
    return (
      <li key={view.id} className="workspace-view-row" data-view-id={view.id} data-current-view={current}>
        <div className="workspace-view-description">
          <strong>{label}{current && " · This tab"}</strong>
          <span className="workspace-view-membership">{membership}</span>
          <ul className="workspace-view-terminals">
            {view.terminals.map((terminal, index) => (
              <li key={index}>
                <span>{terminal.session}</span>
                <span>{terminal.ignoreSize ? "Size protected" : "Fit active"} · {terminal.cols}×{terminal.rows}</span>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" className="secondary-button workspace-view-disconnect"
          aria-label={`Disconnect ${label}`} disabled={current || pending !== null}
          title={current ? "This is your current tab" : "Release this view's terminal attachments"}
          onClick={() => void disconnect(view.id)}>
          {pending === view.id ? "Disconnecting…" : "Disconnect"}
        </button>
      </li>
    );
  };

  return createPortal(
    <div className="title-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="title-sheet workspace-views-sheet" role="dialog"
        aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">ATTACHED BROWSER VIEWS</p><h2 id={headingId}>Workspace views</h2></div>
          <button type="button" className="icon-button" aria-label="Close workspace views" onClick={onClose}><CloseIcon /></button>
        </header>
        <div className="title-form-body workspace-views-body">
          <p>{ownViews.length} workspace {ownViews.length === 1 ? "view" : "views"}
            {ownViews.some((view) => view.id === controller.identity.id) ? ", including this tab"
              : controller.paused ? " · This tab is disconnected" : ""}
            {controller.identity.group && ` · ${synced} in this sync group`}.
          </p>
          <p>Fit active views can affect the shared tmux size. Disconnect releases a view&apos;s terminals
            and pauses it until Rejoin. Sessions keep running.</p>
          {controller.loading && <p role="status">Loading views…</p>}
          {(error || controller.error) && <p className="title-error" role="alert">{error || controller.error}</p>}
          <ul className="workspace-view-list">{ownViews.map(row)}</ul>
          {relatedViews.length > 0 && <>
            <h3>Other attachments to these sessions</h3>
            <p>These connections have no workspace information. Older pages can appear once per terminal attachment.</p>
            <ul className="workspace-view-list">{relatedViews.map(row)}</ul>
          </>}
        </div>
      </div>
    </div>, document.body,
  );
}
