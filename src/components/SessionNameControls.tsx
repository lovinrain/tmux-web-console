import { useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon, EditIcon, WindowCopyIcon } from "../icons";
import { sessionRenameError } from "../sessionRenameValidation";
import type { Session } from "../types";

interface SessionNameControlsProps {
  name: string;
  displayTitle: string;
  session?: Session;
  disabled?: boolean;
  onRename?: (session: Session, name: string) => Promise<void>;
  onUpdateTitle?: (session: Session, title: string) => Promise<void>;
}

const fieldLabels = {
  name: {
    caption: "Tmux session name", edit: "Edit tmux session name", editButton: "Rename tmux session inline",
    input: "Tmux session name", save: "Save tmux session name", cancel: "Cancel session name edit",
    copy: "Copy tmux session name", copied: "Session name copied", manual: "Session name to copy",
    manualHint: "Select and copy the session name", saving: "Renaming…", failure: "Unable to rename the tmux session.",
    maxLength: 256,
  },
  title: {
    caption: "Display title", edit: "Edit session display title", editButton: "Edit display title",
    input: "Session display title", save: "Save session display title", cancel: "Cancel display title edit",
    copy: "Copy session display title", copied: "Display title copied", manual: "Display title to copy",
    manualHint: "Select and copy the display title", saving: "Saving title…", failure: "Unable to save the display title.",
    maxLength: 80,
  },
};

function displayTitleError(value: string): string | null {
  const title = value.trim();
  if (title.length > 80) return "A display title can contain at most 80 characters.";
  if ([...title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return "A display title cannot contain control characters.";
  }
  return null;
}

interface SessionNameFieldProps {
  field: keyof typeof fieldLabels;
  value: string;
  session?: Session;
  disabled: boolean;
  onSave?: (session: Session, value: string) => Promise<void>;
}

function SessionNameField({ field, value, session, disabled, onSave }: SessionNameFieldProps) {
  const labels = fieldLabels[field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const editingSessionRef = useRef<Session | null>(null);
  const savingRef = useRef(false);
  const wasEditingRef = useRef(false);
  const editable = Boolean(session && onSave) && !disabled;
  const validation = field === "name" ? sessionRenameError(draft) : displayTitleError(draft);

  useEffect(() => {
    if (editing && !saving) {
      inputRef.current?.focus();
      if (!wasEditingRef.current) inputRef.current?.select();
    } else if (!editing && wasEditingRef.current) nameRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing, saving]);

  useEffect(() => {
    if (copied === "manual") {
      manualRef.current?.focus();
      manualRef.current?.select();
    }
    if (copied !== "done") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const begin = () => {
    if (!editable || !session || savingRef.current) return;
    editingSessionRef.current = { ...session };
    setDraft(value);
    setError("");
    setCopied("idle");
    setEditing(true);
  };
  const cancel = () => {
    if (savingRef.current) return;
    setEditing(false);
    setError("");
  };
  const save = async () => {
    const target = editingSessionRef.current;
    if (!editing || savingRef.current || disabled || !target || !onSave) return;
    if (validation) { setError(validation); inputRef.current?.focus(); return; }
    if ((field === "title" ? draft.trim() : draft) === value) { cancel(); return; }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(target, draft);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failure);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopied("done");
    } catch { setCopied("manual"); }
  };

  return <div className={`session-name-field session-name-field-${field}`}
    data-session-name-editor={editing ? "true" : undefined} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (editing && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); cancel();
        } else if (editing && event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault(); event.stopPropagation(); void save();
        }
      }}>
    <span className="session-name-caption">{labels.caption}</span>
    <div className="session-context-name-row">
      {editing ? <input ref={inputRef} value={draft} maxLength={labels.maxLength}
        className="session-name-input" aria-label={labels.input} disabled={saving || disabled}
        aria-invalid={Boolean(error || validation)} onChange={(event) => { setDraft(event.target.value); setError(""); }} />
      : <button ref={nameRef} type="button" className="session-name-label"
        aria-label={labels.edit} disabled={!editable}
        title={editable ? "Double-click to edit; Enter or F2 also edits" : value}
        onDoubleClick={begin} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "F2") {
            event.preventDefault(); event.stopPropagation(); begin();
          }
        }}>{value || "No display title"}</button>}
      {editing && <>
        <button type="button" className="icon-button session-name-action" aria-label={labels.save}
          title="Save (Enter)" disabled={saving || disabled || Boolean(validation)} onClick={() => void save()}><CheckIcon /></button>
        <button type="button" className="icon-button session-name-action" aria-label={labels.cancel}
          title="Cancel edit (Escape)" disabled={saving || disabled} onClick={cancel}><CloseIcon /></button>
      </>}
      {!editing && <button type="button" className="icon-button session-name-action" aria-label={labels.editButton}
        title={labels.editButton} disabled={!editable} onClick={begin}><EditIcon /></button>}
      <button type="button" className="icon-button session-name-action" aria-label={labels.copy}
        title={copied === "done" ? labels.copied : labels.copy}
        disabled={disabled || saving || !value} onMouseDown={(event) => event.preventDefault()} onClick={() => void copy()}>
        {copied === "done" ? <CheckIcon /> : <WindowCopyIcon />}
      </button>
    </div>
    {saving && <span role="status">{labels.saving}</span>}
    {error && <p className="session-name-error" role="alert">{error}</p>}
    {copied === "done" && <span className="session-name-copy-status" role="status">{labels.copied}</span>}
    {copied === "manual" && <label className="session-name-manual-copy">
      <span>{labels.manualHint}</span>
      <input ref={manualRef} value={value} readOnly aria-label={labels.manual} onFocus={(event) => event.currentTarget.select()} />
    </label>}
  </div>;
}

export function SessionNameControls({ name, displayTitle, session, disabled = false, onRename, onUpdateTitle }: SessionNameControlsProps) {
  const title = session?.customTitle ?? (displayTitle !== name ? displayTitle : "");
  return <div className="session-name-controls">
    <SessionNameField field="title" value={title} session={session} disabled={disabled} onSave={onUpdateTitle} />
    <SessionNameField field="name" value={name} session={session} disabled={disabled} onSave={onRename} />
  </div>;
}
