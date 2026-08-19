import { useEffect, useRef, useState, type FormEvent } from "react";
import { CloseIcon } from "../icons";
import {
  SESSION_TAG_LABELS,
  SESSION_TAGS,
  type Session,
  type SessionTag,
} from "../types";

interface SessionTitleDialogProps {
  session: Session;
  onClose: () => void;
  onSave: (title: string, tags: SessionTag[]) => Promise<void>;
}

export function SessionTitleDialog({ session, onClose, onSave }: SessionTitleDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(session.customTitle || "");
  const [tags, setTags] = useState<SessionTag[]>(session.tags ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
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
    window.addEventListener("keydown", handleDialogKey);
    return () => window.removeEventListener("keydown", handleDialogKey);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, tags);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save session details");
      setSaving(false);
    }
  };

  const toggleTag = (tag: SessionTag) => {
    setTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : SESSION_TAGS.filter((item) => item === tag || current.includes(item)));
  };

  return (
    <div className="title-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <form
        ref={dialogRef}
        className="title-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-details-heading"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">MUXDECK SESSION DETAILS</p>
            <h2 id="session-details-heading">Edit title and tags</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="Close session details"><CloseIcon /></button>
        </header>
        <div className="title-form-body">
          <label htmlFor="session-title-input">Human title</label>
          <input
            id="session-title-input"
            autoFocus
            disabled={saving}
            maxLength={80}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What is this session about?"
            aria-describedby="session-title-hint"
          />
          <p id="session-title-hint">
            Optional Muxdeck alias only. This does not rename the real tmux session
            {" "}<code>{session.name}</code>.
          </p>
          <fieldset className="session-tag-picker">
            <legend>Tags</legend>
            <p>Use predefined labels to find, filter, and organize this session.</p>
            <div>
              {SESSION_TAGS.map((tag) => (
                <label className={`session-tag-choice tag-${tag}`} key={tag}>
                  <input
                    type="checkbox"
                    checked={tags.includes(tag)}
                    disabled={saving}
                    onChange={() => toggleTag(tag)}
                  />
                  <span>{SESSION_TAG_LABELS[tag]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p className="title-error" role="alert">{error}</p>}
        </div>
        <div className="title-actions">
          {session.customTitle && <button type="button" className="secondary-button clear-title" onClick={() => setDraft("")} disabled={saving}>Clear title</button>}
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save details"}</button>
        </div>
      </form>
    </div>
  );
}
