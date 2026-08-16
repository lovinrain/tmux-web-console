import { useEffect, useState, type FormEvent } from "react";
import { CloseIcon } from "../icons";
import type { Session } from "../types";

interface SessionTitleDialogProps {
  session: Session;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}

export function SessionTitleDialog({ session, onClose, onSave }: SessionTitleDialogProps) {
  const [draft, setDraft] = useState(session.customTitle || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save title");
      setSaving(false);
    }
  };

  return (
    <div className="title-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <form
        className="title-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-title-heading"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">MUXDECK DISPLAY TITLE</p>
            <h2 id="session-title-heading">Edit display title</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="Close title editor"><CloseIcon /></button>
        </header>
        <div className="title-form-body">
          <label htmlFor="session-title-input">Human title</label>
          <input
            id="session-title-input"
            autoFocus
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
          {error && <p className="title-error" role="alert">{error}</p>}
        </div>
        <div className="title-actions">
          {session.customTitle && <button type="button" className="secondary-button clear-title" onClick={() => setDraft("")} disabled={saving}>Clear</button>}
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save title"}</button>
        </div>
      </form>
    </div>
  );
}
