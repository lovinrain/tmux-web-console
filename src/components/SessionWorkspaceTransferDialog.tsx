import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listWorkspaces,
  type SavedWorkspace,
  type WorkspaceSessionTransferOperation,
  type WorkspaceSessionTransferResult,
} from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  WindowCopyIcon,
  WindowMoveIcon,
} from "../icons";

interface SessionWorkspaceTransferDialogProps {
  sessionName: string;
  sourceWorkspaceId: string | null;
  sourceWorkspaceName: string | null;
  workspacePinned: boolean;
  onClose: () => void;
  onTransfer: (
    destinationWorkspaceId: string,
    operation: WorkspaceSessionTransferOperation,
    sessionRevision: number,
  ) => Promise<WorkspaceSessionTransferResult>;
}

interface PendingTransfer {
  workspaceId: string;
  operation: WorkspaceSessionTransferOperation;
}

interface TransferError {
  workspaceId: string;
  message: string;
}

function tabCountLabel(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

export function SessionWorkspaceTransferDialog({
  sessionName,
  sourceWorkspaceId,
  sourceWorkspaceName,
  workspacePinned,
  onClose,
  onTransfer,
}: SessionWorkspaceTransferDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const headingId = `${useId()}-heading`;
  const [workspaces, setWorkspaces] = useState<SavedWorkspace[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [transferError, setTransferError] = useState<TransferError | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void listWorkspaces(controller.signal).then((items) => {
      setWorkspaces(items);
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Unable to load workspaces");
      setLoading(false);
    });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    const releaseBodyScroll = acquireBodyScrollLock();
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      searchRef.current?.focus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!pending) onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], "
          + "[tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", containFocus);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", containFocus);
      window.removeEventListener("keydown", handleKeyDown, true);
      releaseBodyScroll();
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [onClose, pending]);

  const destinations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return workspaces.filter((workspace) => {
      if (workspace.id === sourceWorkspaceId) return false;
      if (!normalizedQuery) return true;
      return workspace.name.toLocaleLowerCase().includes(normalizedQuery)
        || workspace.tabs.some((tab) => tab.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [query, sourceWorkspaceId, workspaces]);

  const transfer = async (
    workspace: SavedWorkspace,
    operation: WorkspaceSessionTransferOperation,
  ) => {
    if (pending || (operation === "move" && workspacePinned)) return;
    setPending({ workspaceId: workspace.id, operation });
    setTransferError(null);
    setStatus(null);
    try {
      const result = await onTransfer(
        workspace.id,
        operation,
        workspace.sessionRevision,
      );
      setWorkspaces((current) => current.map((item) => {
        if (item.id === result.destinationWorkspace.id) {
          return result.destinationWorkspace;
        }
        if (result.sourceWorkspace && item.id === result.sourceWorkspace.id) {
          return result.sourceWorkspace;
        }
        return { ...item, sessionRevision: result.sessionRevision };
      }));
      if (operation === "move") {
        onClose();
        return;
      }
      setStatus(result.destinationAlreadyContained
        ? `${sessionName} was already in ${workspace.name}; no duplicate was added.`
        : `Copied ${sessionName} to ${workspace.name}.`);
    } catch (error) {
      setTransferError({
        workspaceId: workspace.id,
        message: error instanceof Error ? error.message : "Unable to transfer session",
      });
    } finally {
      setPending(null);
    }
  };

  const visibleWorkspaceCount = workspaces.filter((workspace) => (
    workspace.id !== sourceWorkspaceId
  )).length;
  const sourceLabel = sourceWorkspaceName || "this unsaved workspace";

  return (
    <div
      className="workspace-transfer-backdrop"
      role="presentation"
      onMouseDown={() => !pending && onClose()}
    >
      <aside
        ref={dialogRef}
        className="workspace-transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={Boolean(pending)}
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-transfer-header">
          <div>
            <p className="eyebrow">PLACE THIS SESSION</p>
            <h2 id={headingId}>Move or copy to a workspace</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={Boolean(pending)}
            aria-label="Close workspace transfer"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="workspace-transfer-context">
          <strong>{sessionName}</strong>
          <span>From {sourceLabel}</span>
        </div>

        {workspacePinned && (
          <p className="workspace-transfer-pinned" role="note">
            This session is pinned to every workspace, so it is already copied everywhere.
            Unpin it before moving it out of {sourceLabel}.
          </p>
        )}
        {!sourceWorkspaceId && !workspacePinned && (
          <p className="workspace-transfer-hint">
            Moving copies the session to the destination, then removes its tab from this
            browser&apos;s unsaved workspace.
          </p>
        )}

        <label className="workspace-transfer-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a saved workspace"
            aria-label="Search saved workspaces"
            disabled={loading || Boolean(loadError)}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} disabled={Boolean(pending)}>
              Clear
            </button>
          )}
        </label>

        <p
          className={status ? "workspace-transfer-status" : "workspace-sr-only"}
          role="status"
          aria-live="polite"
        >
          {status || `${destinations.length} destination ${destinations.length === 1 ? "workspace" : "workspaces"}`}
        </p>

        <div className="workspace-transfer-list" aria-label="Destination workspaces">
          {loading && (
            <div className="workspace-transfer-state">
              <span className="workspace-transfer-loader" aria-hidden="true" />
              <strong>Loading workspaces...</strong>
            </div>
          )}
          {!loading && loadError && (
            <div className="workspace-transfer-state error" role="alert">
              <strong>Could not load workspaces</strong>
              <span>{loadError}</span>
              <button type="button" onClick={() => setReloadToken((token) => token + 1)}>
                <RefreshIcon /> Retry
              </button>
            </div>
          )}
          {!loading && !loadError && visibleWorkspaceCount === 0 && (
            <div className="workspace-transfer-state">
              <strong>No other saved workspaces yet</strong>
              <span>Create another saved workspace, then it will appear here.</span>
            </div>
          )}
          {!loading && !loadError && visibleWorkspaceCount > 0 && destinations.length === 0 && (
            <div className="workspace-transfer-state">
              <strong>No workspace matches “{query.trim()}”</strong>
              <button type="button" onClick={() => setQuery("")}>Clear search</button>
            </div>
          )}
          {!loading && !loadError && destinations.map((workspace) => {
            const alreadyContains = workspace.tabs.includes(sessionName);
            const copyPending = pending?.workspaceId === workspace.id
              && pending.operation === "copy";
            const movePending = pending?.workspaceId === workspace.id
              && pending.operation === "move";
            const rowError = transferError?.workspaceId === workspace.id
              ? transferError.message
              : null;
            return (
              <article
                key={workspace.id}
                className={alreadyContains
                  ? "workspace-transfer-row already-contains"
                  : "workspace-transfer-row"}
              >
                <div className="workspace-transfer-row-copy">
                  <strong>{workspace.name}</strong>
                  <span>
                    {alreadyContains
                      ? `Already contains ${sessionName}`
                      : tabCountLabel(workspace.tabs.length)}
                  </span>
                </div>
                <div className="workspace-transfer-row-actions">
                  <button
                    type="button"
                    className="workspace-transfer-copy"
                    disabled={Boolean(pending) || alreadyContains}
                    aria-label={alreadyContains
                      ? `${sessionName} is already in ${workspace.name}`
                      : `Copy ${sessionName} to ${workspace.name}`}
                    onClick={() => void transfer(workspace, "copy")}
                  >
                    <WindowCopyIcon />
                    <span>{copyPending ? "Copying..." : alreadyContains ? "Added" : "Copy"}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-transfer-move"
                    disabled={Boolean(pending) || workspacePinned}
                    aria-label={`Move ${sessionName} to ${workspace.name}`}
                    title={workspacePinned ? "Unpin this session before moving it" : undefined}
                    onClick={() => void transfer(workspace, "move")}
                  >
                    <WindowMoveIcon />
                    <span>{movePending ? "Moving..." : "Move"}</span>
                  </button>
                </div>
                {rowError && (
                  <p className="workspace-transfer-row-error" role="alert">
                    {rowError}
                  </p>
                )}
              </article>
            );
          })}
        </div>

        <footer className="workspace-transfer-footer">
          <p>
            Copy keeps the session here. Move removes it from {sourceLabel}. Existing
            destination tabs are never duplicated.
          </p>
          <button type="button" className="secondary-button" onClick={onClose} disabled={Boolean(pending)}>
            Done
          </button>
        </footer>
      </aside>
    </div>
  );
}
