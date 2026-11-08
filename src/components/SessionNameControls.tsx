import { useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon, WindowCopyIcon } from "../icons";
import { sessionRenameError } from "../sessionRenameValidation";
import type { Session } from "../types";

interface SessionNameControlsProps {
  name: string;
  displayTitle: string;
  session?: Session;
  disabled?: boolean;
  onRename?: (session: Session, name: string) => Promise<void>;
}

export function SessionNameControls({ name, displayTitle, session, disabled = false, onRename }: SessionNameControlsProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const editingSessionRef = useRef<Session | null>(null);
  const savingRef = useRef(false);
  const wasEditingRef = useRef(false);
  const editable = Boolean(session && onRename) && !disabled;
  const validation = sessionRenameError(draft);

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
    setDraft(name);
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
    if (!editing || savingRef.current || disabled || !target || !onRename) return;
    if (validation) { setError(validation); inputRef.current?.focus(); return; }
    if (draft === name) { cancel(); return; }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onRename(target, draft);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to rename the tmux session.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(name);
      setCopied("done");
    } catch { setCopied("manual"); }
  };

  return <div className={displayTitle !== name ? "session-name-controls has-display-title" : "session-name-controls"}>
    {displayTitle !== name && <strong className="session-name-display-title" onDoubleClick={begin}>{displayTitle}</strong>}
    <div className="session-name-row" data-session-name-editor={editing ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (editing && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); cancel();
        } else if (editing && event.key === "Enter" && event.target === inputRef.current) {
          event.preventDefault(); event.stopPropagation(); void save();
        }
      }}>
      {editing ? <input ref={inputRef} value={draft} maxLength={256}
        className="session-name-input" aria-label="Tmux session name" disabled={saving || disabled}
        aria-invalid={Boolean(error || validation)} onChange={(event) => { setDraft(event.target.value); setError(""); }} />
      : <button ref={nameRef} type="button" className="session-name-label"
        aria-label="Edit tmux session name" disabled={!editable}
        title={editable ? "Double-click to rename; Enter or F2 also edits" : name}
        onDoubleClick={begin} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "F2") {
            event.preventDefault(); event.stopPropagation(); begin();
          }
        }}>{name}</button>}
      {editing && <>
        <button type="button" className="icon-button session-name-action" aria-label="Save tmux session name"
          title="Save name (Enter)" disabled={saving || disabled || Boolean(validation)} onClick={() => void save()}><CheckIcon /></button>
        <button type="button" className="icon-button session-name-action" aria-label="Cancel session name edit"
          title="Cancel edit (Escape)" disabled={saving || disabled} onClick={cancel}><CloseIcon /></button>
      </>}
      <button type="button" className="icon-button session-name-action" aria-label="Copy tmux session name"
        title={copied === "done" ? "Session name copied" : "Copy the tmux session name"}
        disabled={disabled || saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void copy()}>
        {copied === "done" ? <CheckIcon /> : <WindowCopyIcon />}
      </button>
    </div>
    {saving && <span role="status">Renaming…</span>}
    {error && <p className="session-name-error" role="alert">{error}</p>}
    {copied === "done" && <span className="session-name-copy-status" role="status">Session name copied</span>}
    {copied === "manual" && <label className="session-name-manual-copy">
      <span>Select and copy the session name</span>
      <input ref={manualRef} value={name} readOnly aria-label="Session name to copy" onFocus={(event) => event.currentTarget.select()} />
    </label>}
  </div>;
}
