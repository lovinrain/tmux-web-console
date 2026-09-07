import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CloseIcon, TrashIcon } from "../icons";

interface SessionTerminateDialogProps {
  sessionName: string;
  sessionTitle: string | null;
  onClose: () => void;
  onTerminate: () => Promise<void>;
  onFallbackFocus?: () => void;
  heading?: string;
  description?: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  destructive?: boolean;
}

export function SessionTerminateDialog({
  sessionName,
  sessionTitle,
  onClose,
  onTerminate,
  onFallbackFocus,
  heading = "Terminate tmux session?",
  description,
  confirmLabel = "Terminate session",
  pendingLabel = "Terminating...",
  destructive = true,
}: SessionTerminateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const fallbackFocusRef = useRef(onFallbackFocus);
  fallbackFocusRef.current = onFallbackFocus;
  const [terminating, setTerminating] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const releaseBodyScroll = acquireBodyScrollLock();
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      if (cancelRef.current && !cancelRef.current.disabled) cancelRef.current.focus();
      else dialog.focus();
    };
    document.addEventListener("focusin", containFocus);
    cancelRef.current?.focus();

    return () => {
      document.removeEventListener("focusin", containFocus);
      releaseBodyScroll();
      const restoreTarget = restoreFocusRef.current;
      let usedFallback = false;
      if (restoreTarget?.isConnected) restoreTarget.focus();
      else {
        fallbackFocusRef.current?.();
        usedFallback = true;
      }
      window.requestAnimationFrame(() => {
        if (!usedFallback && !restoreTarget?.isConnected) fallbackFocusRef.current?.();
      });
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminating) onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, terminating]);

  const terminate = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTerminating(true);
    setError(null);
    try {
      await onTerminate();
      onClose();
    } catch (terminateError) {
      setError(
        terminateError instanceof Error
          ? terminateError.message
          : "Unable to terminate the tmux session",
      );
      setTerminating(false);
      inFlight.current = false;
    }
  };

  const displayTitle = sessionTitle || sessionName;
  const dialogId = useId();
  const headingId = `${dialogId}-heading`;
  const descriptionId = `${dialogId}-description`;

  return (
    <div
      className="title-backdrop"
      role="presentation"
      onMouseDown={() => !terminating && onClose()}
    >
      <div
        ref={dialogRef}
        className="title-sheet session-terminate-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        aria-busy={terminating}
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{destructive ? "DESTRUCTIVE SESSION ACTION" : "WORKSPACE TAB ACTION"}</p>
            <h2 id={headingId}>{heading}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={terminating}
            aria-label="Close terminate-session confirmation"
          >
            <CloseIcon />
          </button>
        </header>
        <div id={descriptionId} className="title-form-body session-terminate-body">
          {description ?? <><p className="session-terminate-target">
            <TrashIcon />
            <span>
              End <strong>{displayTitle}</strong>
              {sessionTitle && sessionTitle !== sessionName && <code>{sessionName}</code>}
            </span>
          </p>
          <p>
            This immediately ends the entire tmux session, including every pane and the
            programs running in them. Unsaved terminal work can be lost.
          </p>
          <p>
            Muxdeck removes its quick tab if it is open. Memoranda and display metadata
            remain saved, and references in other saved workspaces are not silently rewritten.
          </p></>}
          {error && <p className="title-error" role="alert">{error}</p>}
        </div>
        <div className="title-actions">
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={terminating}
          >
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? "danger-button" : "primary-button"}
            onClick={() => void terminate()}
            disabled={terminating}
          >
            {terminating ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
