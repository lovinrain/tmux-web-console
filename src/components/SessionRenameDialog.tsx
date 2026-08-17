import { useEffect, useRef, useState, type FormEvent } from "react";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CloseIcon } from "../icons";

interface SessionRenameDialogProps {
  sessionName: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}

export function SessionRenameDialog({
  sessionName,
  onClose,
  onRename,
}: SessionRenameDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const wasSavingRef = useRef(false);
  const [draft, setDraft] = useState(sessionName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blankName = !draft.trim();
  const invalidCharacters = draft.includes(":")
    || draft.includes(".")
    || draft.includes("\\");
  const trailingCommandSeparator = draft.endsWith(";");
  const canRename = !blankName
    && draft !== sessionName
    && !invalidCharacters
    && !trailingCommandSeparator
    && !saving;

  useEffect(() => {
    const releaseBodyScroll = acquireBodyScrollLock();
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) return;
      if (inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
      else dialog.focus();
    };
    document.addEventListener("focusin", containFocus);
    inputRef.current?.focus();

    return () => {
      document.removeEventListener("focusin", containFocus);
      releaseBodyScroll();
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!saving) onClose();
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, saving]);

  useEffect(() => {
    if (saving) dialogRef.current?.focus();
    else if (wasSavingRef.current) inputRef.current?.focus();
    wasSavingRef.current = saving;
  }, [saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canRename) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(draft);
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : "Unable to rename the tmux session",
      );
      setSaving(false);
    }
  };

  return (
    <div className="title-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <form
        ref={dialogRef}
        className="title-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-rename-heading"
        aria-busy={saving}
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">TMUX SESSION NAME</p>
            <h2 id="session-rename-heading">Rename tmux session</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close tmux rename"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="title-form-body">
          <label htmlFor="session-rename-input">Native tmux name</label>
          <input
            ref={inputRef}
            id="session-rename-input"
            autoFocus
            maxLength={256}
            value={draft}
            disabled={saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            aria-describedby="session-rename-hint"
          />
          <p id="session-rename-hint">
            This is the real tmux rename (default prefix <code>Ctrl+B</code>, then
            {" "}<code>$</code>). It updates this workspace&apos;s tabs and URL; your
            separate Muxdeck display title is preserved. Colons, periods, backslashes, and a
            final semicolon are not allowed.
            Leading and trailing spaces are part of the name and will be preserved.
          </p>
          {invalidCharacters && (
            <p className="title-error" role="alert">
              A tmux session name cannot contain a colon, period, or backslash.
            </p>
          )}
          {trailingCommandSeparator && (
            <p className="title-error" role="alert">
              A tmux session name cannot end with a semicolon.
            </p>
          )}
          {error && <p className="title-error" role="alert">{error}</p>}
        </div>
        <div className="title-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!canRename}>
            {saving ? "Renaming..." : "Rename session"}
          </button>
        </div>
      </form>
    </div>
  );
}
