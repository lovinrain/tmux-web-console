import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { EditIcon, KeyboardIcon, MemoIcon } from "../icons";

const MAX_DRAFT_LENGTH = 65_536;
const DRAFT_KEY_PREFIX = "muxdeck-terminal-draft:";

interface InputBarProps {
  sessionName: string;
  enabled: boolean;
  onSend: (data: string) => boolean;
  onSubmit: (data: string, withEnter: boolean) => Promise<boolean>;
  onFocus: () => void;
  onEditSessionTitle?: () => void;
  onOpenMessages?: () => void;
  messageCount?: number;
}

export interface InputBarHandle {
  loadDraft: (text: string) => boolean;
  focus: () => void;
}

const KEYS = [
  { label: "PgUp", data: "\x1b[5~" },
  { label: "PgDn", data: "\x1b[6~" },
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03" },
  { label: "Enter", data: "\r" },
  { label: "Up", data: "\x1b[A", compact: "^" },
  { label: "Down", data: "\x1b[B", compact: "v" },
  { label: "Left", data: "\x1b[D", compact: "<" },
  { label: "Right", data: "\x1b[C", compact: ">" },
];

type DraftStatus = "idle" | "saved" | "loaded" | "sending" | "sent" | "unconfirmed" | "clipboard-error";

function draftKey(sessionName: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionName}`;
}

function readDraft(sessionName: string): string {
  try {
    return window.localStorage.getItem(draftKey(sessionName)) || "";
  } catch {
    return "";
  }
}

function writeDraft(sessionName: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(draftKey(sessionName), value);
    else window.localStorage.removeItem(draftKey(sessionName));
  } catch {
    // The textarea remains the source of truth when storage is unavailable.
  }
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 144)}px`;
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  sessionName,
  enabled,
  onSend,
  onSubmit,
  onFocus,
  onEditSessionTitle,
  onOpenMessages,
  messageCount = 0,
}, ref) {
  const initialDraftRef = useRef<string | null>(null);
  if (initialDraftRef.current === null) initialDraftRef.current = readDraft(sessionName);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const [draftLength, setDraftLength] = useState(initialDraftRef.current.length);
  const [status, setStatus] = useState<DraftStatus>(initialDraftRef.current ? "saved" : "idle");
  const [sending, setSending] = useState(false);

  const recordDraft = (value: string, nextStatus: DraftStatus = "saved") => {
    writeDraft(sessionName, value);
    setDraftLength(value.length);
    setStatus(value ? nextStatus : "idle");
  };

  const loadDraft = (text: string): boolean => {
    const textarea = textareaRef.current;
    if (!textarea || composingRef.current || sendingRef.current) return false;
    if (
      textarea.value
      && textarea.value !== text
      && !window.confirm("Replace the staged input that is already here?")
    ) return false;
    textarea.value = text.slice(0, MAX_DRAFT_LENGTH);
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return true;
  };

  useImperativeHandle(ref, () => ({
    loadDraft,
    focus: () => textareaRef.current?.focus(),
  }));

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = window.requestAnimationFrame(() => resizeTextarea(textarea));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const sendDraft = async (withEnter: boolean) => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value || !enabled || sendingRef.current) return;
    if (composingRef.current) {
      textarea.blur();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    const submitted = textarea.value;
    if (!submitted) return;
    sendingRef.current = true;
    setSending(true);
    setStatus("sending");
    textarea.readOnly = true;
    let accepted = false;
    try {
      accepted = await onSubmit(submitted, withEnter);
    } catch {
      accepted = false;
    } finally {
      textarea.readOnly = false;
      sendingRef.current = false;
      setSending(false);
    }
    if (!accepted) {
      setStatus("unconfirmed");
      textarea.focus();
      return;
    }
    textarea.value = "";
    recordDraft("", "sent");
    setStatus("sent");
    resizeTextarea(textarea);
    textarea.focus();
  };

  const clearDraft = () => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value) return;
    if (!window.confirm("Discard this staged input?")) return;
    textarea.value = "";
    recordDraft("");
    resizeTextarea(textarea);
    textarea.focus();
  };

  const pasteClipboard = async () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const room = MAX_DRAFT_LENGTH - textarea.value.length + (textarea.selectionEnd - textarea.selectionStart);
      const insertion = text.slice(0, Math.max(0, room));
      textarea.setRangeText(insertion, textarea.selectionStart, textarea.selectionEnd, "end");
      recordDraft(textarea.value);
      resizeTextarea(textarea);
      textarea.focus();
    } catch {
      setStatus("clipboard-error");
      textarea.focus();
    }
  };

  const statusText = status === "sent"
    ? "Written once to the attached tmux PTY; the local draft was cleared."
    : status === "sending"
      ? "Writing this staged snapshot to the attached tmux PTY..."
    : status === "loaded"
      ? "Memorandum loaded locally. Edit it or send when ready."
      : status === "unconfirmed"
        ? "Delivery was not confirmed. The draft is retained; check the terminal before retrying."
        : status === "clipboard-error"
          ? "Clipboard access was unavailable. Use the keyboard paste command here."
          : draftLength > 0
            ? "Saved on this device. Terminal-side edits do not rewrite this draft."
            : enabled
              ? "Nothing is sent until you choose Send."
              : "Compose now; sending unlocks when the terminal reconnects.";

  return (
    <section className="input-dock" aria-label="Terminal input">
      <div className="staged-composer">
        <div className="composer-heading">
          <label htmlFor="terminal-staged-input">Staged input</label>
          <span>{draftLength.toLocaleString()} / {MAX_DRAFT_LENGTH.toLocaleString()}</span>
        </div>
        <div className="composer-body">
          <textarea
            id="terminal-staged-input"
            ref={textareaRef}
            defaultValue={initialDraftRef.current}
            maxLength={MAX_DRAFT_LENGTH}
            rows={2}
            inputMode="text"
            enterKeyHint="enter"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Dictate, type, or load a memorandum..."
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              recordDraft(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onInput={(event) => {
              // Never write value back: iOS owns its replacement range during dictation.
              recordDraft(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onBlur={(event) => recordDraft(event.currentTarget.value)}
          />
          <div className="composer-actions-primary">
            <button type="button" className="secondary-button composer-clear" disabled={!draftLength || sending} onClick={clearDraft}>Clear</button>
            <button type="button" className="secondary-button" disabled={!enabled || !draftLength || sending} onClick={() => void sendDraft(false)}>Send</button>
            <button type="button" className="primary-button" disabled={!enabled || !draftLength || sending} onClick={() => void sendDraft(true)}>Send + Enter</button>
          </div>
        </div>
        <p className={`composer-status ${status}`} aria-live="polite">
          <span className={enabled ? "ready" : ""} />{statusText}
        </p>
      </div>

      <div className="input-bar" aria-label="Terminal input shortcuts">
        <button
          type="button"
          className="key-button session-title-key"
          onClick={onEditSessionTitle}
          disabled={!onEditSessionTitle}
          aria-label="Update session name"
        >
          <EditIcon /> <span>Name</span>
        </button>
        <button
          type="button"
          className="key-button memo-key"
          onClick={onOpenMessages}
          disabled={!onOpenMessages}
          aria-label="Open memoranda"
        >
          <MemoIcon /> <span>Memo{messageCount > 0 ? ` ${messageCount}` : ""}</span>
        </button>
        <button type="button" className="key-button keyboard-key" onClick={onFocus} disabled={!enabled} aria-label="Raw terminal keyboard">
          <KeyboardIcon /> <span>Raw keys</span>
        </button>
        {KEYS.map((key) => (
          <button
            type="button"
            className="key-button"
            key={key.label}
            disabled={!enabled}
            aria-label={key.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSend(key.data)}
          >
            <span className={key.compact ? "wide-key-label" : ""}>{key.label}</span>
            {key.compact && <span className="compact-key-label">{key.compact}</span>}
          </button>
        ))}
        <button type="button" className="key-button action-key" onClick={() => void pasteClipboard()}>Paste to draft</button>
      </div>
    </section>
  );
});
