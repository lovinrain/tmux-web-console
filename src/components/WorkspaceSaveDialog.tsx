import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CloseIcon, SaveIcon } from "../icons";
import {
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_TABS,
  uniqueWorkspaceTabs,
  workspaceNameError,
} from "../workspaceValidation";

interface WorkspaceSaveDialogProps {
  tabs: readonly string[];
  activeSession: string | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onFallbackFocus?: () => void;
}

export function WorkspaceSaveDialog({
  tabs,
  activeSession,
  onClose,
  onSave,
  onFallbackFocus,
}: WorkspaceSaveDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const fallbackFocusRef = useRef(onFallbackFocus);
  fallbackFocusRef.current = onFallbackFocus;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const orderedTabs = uniqueWorkspaceTabs(tabs);
  const nameError = name.length > 0 ? workspaceNameError(name) : null;
  const tooManyTabs = orderedTabs.length > MAX_WORKSPACE_TABS;
  const canSave = !workspaceNameError(name) && !tooManyTabs && !saving;
  const savedActiveSession = activeSession && orderedTabs.includes(activeSession)
    ? activeSession
    : null;

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
      if (restoreFocusRef.current?.isConnected) {
        restoreFocusRef.current.focus();
      } else if (fallbackFocusRef.current) {
        window.requestAnimationFrame(fallbackFocusRef.current);
      }
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setRequestError(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unable to save the workspace");
      setSaving(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const close = () => {
    if (!saving) onClose();
  };

  return createPortal(
    <div className="title-backdrop workspace-save-backdrop" role="presentation" onMouseDown={close}>
      <form
        ref={dialogRef}
        id="workspace-save-dialog"
        className="title-sheet workspace-save-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-save-heading"
        aria-describedby="workspace-save-description"
        aria-busy={saving}
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">SERVER-SAVED WORKSPACE</p>
            <h2 id="workspace-save-heading">Save this workspace</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={saving}
            aria-label="Close workspace save"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="title-form-body">
          <label htmlFor="workspace-save-name">Workspace name</label>
          <input
            ref={inputRef}
            id="workspace-save-name"
            value={name}
            maxLength={MAX_WORKSPACE_NAME_LENGTH}
            autoComplete="off"
            autoFocus
            disabled={saving}
            placeholder="Release room"
            aria-invalid={Boolean(nameError) || tooManyTabs || undefined}
            aria-describedby="workspace-save-description workspace-save-hint"
            onChange={(event) => {
              setName(event.target.value);
              setRequestError(null);
            }}
          />
          <p id="workspace-save-description">
            Save {orderedTabs.length} open {orderedTabs.length === 1 ? "tab" : "tabs"} in
            their current order. Future tab and active-session changes will sync automatically.
          </p>
          <p id="workspace-save-hint" className={nameError || tooManyTabs ? "title-error" : undefined}>
            {tooManyTabs
              ? `A saved workspace can contain up to ${MAX_WORKSPACE_TABS} tabs.`
              : nameError
                || `${name.trim().length} / ${MAX_WORKSPACE_NAME_LENGTH} characters`
            }
          </p>
          {savedActiveSession && (
            <p className="workspace-save-active-session">
              Resume tab: <code>{savedActiveSession}</code>
            </p>
          )}
          {requestError && <p className="title-error" role="alert">{requestError}</p>}
        </div>
        <div className="title-actions">
          <button type="button" className="secondary-button" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!canSave}>
            <SaveIcon /> {saving ? "Saving..." : "Save workspace"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
