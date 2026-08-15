import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { EditIcon, KeyboardIcon, MemoIcon, SnippetIcon } from "../icons";

export const MAX_DRAFT_LENGTH = 65_536;
const DRAFT_KEY_PREFIX = "muxdeck-terminal-draft:";

interface InputBarProps {
  sessionName: string;
  enabled: boolean;
  onSend: (data: string) => boolean;
  onSubmit: (data: string, withEnter: boolean) => Promise<boolean>;
  onFocus: () => void;
  onEditSessionTitle?: () => void;
  onOpenMessages?: () => void;
  onOpenSnippets?: () => void;
  messageCount?: number;
}

export interface InputBarHandle {
  loadDraft: (text: string) => boolean;
  insertText: (text: string) => boolean;
  focus: () => void;
}

interface TerminalKey {
  label: string;
  data: string;
  compact?: string;
  ariaLabel?: string;
  title?: string;
}

const PAGE_UP_SEQUENCE = "\x1b[5~";
const PAGE_DOWN_SEQUENCE = "\x1b[6~";

const KEYS: TerminalKey[] = [
  {
    label: "Tmux PgUp",
    compact: "T Up",
    data: `\x02${PAGE_UP_SEQUENCE}`,
    ariaLabel: "Tmux Page Up",
    title: "Enter tmux copy mode one page up (Ctrl+B, then Page Up)",
  },
  {
    label: "Tmux PgDn",
    compact: "T Dn",
    // Default tmux handles Page Down directly after Page Up enters copy mode.
    data: PAGE_DOWN_SEQUENCE,
    ariaLabel: "Tmux Page Down",
    title: "Page down while tmux copy mode is active",
  },
  {
    label: "^A",
    data: "\x01",
    ariaLabel: "Ctrl+A - move to start of input",
    title: "Move to the start of input in supported shells and agents (Ctrl+A)",
  },
  {
    label: "^E",
    data: "\x05",
    ariaLabel: "Ctrl+E - move to end of input",
    title: "Move to the end of input in supported shells and agents (Ctrl+E)",
  },
  {
    label: "PgUp",
    data: PAGE_UP_SEQUENCE,
    title: "Page up in the foreground application or tmux copy mode",
  },
  {
    label: "PgDn",
    data: PAGE_DOWN_SEQUENCE,
    title: "Page down in the foreground application or tmux copy mode",
  },
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03", title: "Send Ctrl+C or leave tmux copy mode" },
  { label: "Enter", data: "\r" },
];

const OTHER_KEYS: TerminalKey[] = [
  { label: "Up", data: "\x1b[A" },
  { label: "Down", data: "\x1b[B" },
  { label: "Left", data: "\x1b[D" },
  { label: "Right", data: "\x1b[C" },
];

interface TerminalKeyButtonProps {
  terminalKey: TerminalKey;
  enabled: boolean;
  onSend: (data: string) => boolean;
}

function TerminalKeyButton({ terminalKey, enabled, onSend }: TerminalKeyButtonProps) {
  return (
    <button
      type="button"
      className="key-button"
      disabled={!enabled}
      aria-label={terminalKey.ariaLabel || terminalKey.label}
      title={terminalKey.title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSend(terminalKey.data)}
    >
      <span className={terminalKey.compact ? "wide-key-label" : ""}>
        {terminalKey.label}
      </span>
      {terminalKey.compact && (
        <span className="compact-key-label">{terminalKey.compact}</span>
      )}
    </button>
  );
}

type DraftStatus = "idle" | "saved" | "loaded" | "sending" | "sent" | "unconfirmed" | "clipboard-error" | "storage-error";

export type StageSessionDraftResult = "staged" | "cancelled" | "storage-error" | "invalid";

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

function writeDraft(sessionName: string, value: string): boolean {
  try {
    if (value) window.localStorage.setItem(draftKey(sessionName), value);
    else window.localStorage.removeItem(draftKey(sessionName));
    return true;
  } catch {
    // The textarea remains the source of truth when storage is unavailable.
    return false;
  }
}

export function stageSessionDraft(sessionName: string, text: string): StageSessionDraftResult {
  if (!text || text.length > MAX_DRAFT_LENGTH) return "invalid";
  const current = readDraft(sessionName);
  if (
    current
    && current !== text
    && !window.confirm(`Replace the staged input already saved for ${sessionName}?`)
  ) return "cancelled";
  return writeDraft(sessionName, text) ? "staged" : "storage-error";
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
  onOpenSnippets,
  messageCount = 0,
}, ref) {
  const initialDraftRef = useRef<string | null>(null);
  if (initialDraftRef.current === null) initialDraftRef.current = readDraft(sessionName);
  const otherKeyPanelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const otherKeyPanelRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const [draftLength, setDraftLength] = useState(initialDraftRef.current.length);
  const [status, setStatus] = useState<DraftStatus>(initialDraftRef.current ? "saved" : "idle");
  const [sending, setSending] = useState(false);
  const [otherKeyPanelOpen, setOtherKeyPanelOpen] = useState(false);

  const recordDraft = (value: string, nextStatus: DraftStatus = "saved") => {
    const persisted = writeDraft(sessionName, value);
    setDraftLength(value.length);
    setStatus(persisted ? (value ? nextStatus : "idle") : "storage-error");
    return persisted;
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

  const insertText = (text: string): boolean => {
    const textarea = textareaRef.current;
    if (!textarea || !text || composingRef.current || sendingRef.current) return false;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const nextLength = textarea.value.length - (end - start) + text.length;
    if (nextLength > MAX_DRAFT_LENGTH) return false;
    textarea.setRangeText(text, start, end, "end");
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    textarea.focus();
    return true;
  };

  useImperativeHandle(ref, () => ({
    loadDraft,
    insertText,
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
    if (recordDraft("", "sent")) setStatus("sent");
    resizeTextarea(textarea);
    textarea.focus();
  };

  const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const isSendWithEnterShortcut = event.key === "Enter"
      && event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey;
    if (!isSendWithEnterShortcut) return;

    // Some browsers report 229 when Enter completes an IME composition.
    if (
      composingRef.current
      || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229
    ) return;
    if (!enabled || !event.currentTarget.value || sendingRef.current) return;

    event.preventDefault();
    if (!event.repeat) void sendDraft(true);
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

  let statusText: string;
  if (status === "sent") {
    statusText = "Written once to the attached tmux PTY; the local draft was cleared.";
  } else if (status === "sending") {
    statusText = "Writing this staged snapshot to the attached tmux PTY...";
  } else if (status === "loaded") {
    statusText = "Memorandum loaded locally. Snippets are inserted here too; edit or send when ready.";
  } else if (status === "unconfirmed") {
    statusText = "Delivery was not confirmed. The draft is retained; check the terminal before retrying.";
  } else if (status === "clipboard-error") {
    statusText = "Clipboard access was unavailable. Use the keyboard paste command here.";
  } else if (status === "storage-error") {
    statusText = "This draft is visible but could not be saved on this device. Copy it before leaving this page.";
  } else if (draftLength > 0) {
    statusText = "Saved on this device. Terminal-side edits do not rewrite this draft.";
  } else {
    statusText = enabled
      ? "Nothing is sent until you choose Send."
      : "Compose now; sending unlocks when the terminal reconnects.";
  }

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
            placeholder="Dictate, type, or insert a snippet or memorandum..."
            onKeyDown={handleDraftKeyDown}
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
            <button
              type="button"
              className="primary-button composer-send-enter"
              disabled={!enabled || !draftLength || sending}
              aria-keyshortcuts="Shift+Enter"
              title="Send staged input followed by Enter (Shift+Enter)"
              onClick={() => void sendDraft(true)}
            >
              <span>Send + Enter</span>
              <span className="composer-shortcut-hint" aria-hidden="true">
                <kbd>Shift</kbd><span>+</span><kbd>Enter</kbd>
              </span>
            </button>
          </div>
        </div>
        <p className={`composer-status ${status}`} aria-live="polite">
          <span className={enabled ? "ready" : ""} />{statusText}
        </p>
      </div>

      <div className="input-bar" role="group" aria-label="Terminal input shortcuts">
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
        <button
          type="button"
          className="key-button snippet-key"
          onClick={onOpenSnippets}
          disabled={!onOpenSnippets}
          aria-label="Open snippets"
        >
          <SnippetIcon /> <span>Snippets</span>
        </button>
        <button
          type="button"
          className="key-button keyboard-key"
          onClick={onFocus}
          disabled={!enabled}
          aria-label="Raw terminal keyboard"
          title="Focus the live terminal so keyboard input goes directly to tmux"
        >
          <KeyboardIcon /> <span>Raw keys</span>
        </button>
        {KEYS.map((terminalKey) => (
          <TerminalKeyButton
            key={terminalKey.label}
            terminalKey={terminalKey}
            enabled={enabled}
            onSend={onSend}
          />
        ))}
        <button type="button" className="key-button action-key" onClick={() => void pasteClipboard()}>Paste to draft</button>
        <button
          type="button"
          className="key-button other-keys-toggle"
          aria-expanded={otherKeyPanelOpen}
          aria-controls={otherKeyPanelId}
          aria-label={otherKeyPanelOpen ? "Hide other keys" : "Show other keys"}
          title={otherKeyPanelOpen ? "Hide additional key controls" : "Show additional key controls"}
          onMouseDown={(event) => {
            // Preserve terminal/draft focus unless focus must leave the tray before collapse.
            if (!otherKeyPanelRef.current?.contains(document.activeElement)) event.preventDefault();
          }}
          onClick={() => setOtherKeyPanelOpen((open) => !open)}
        >
          <span>Other Keys</span>
        </button>
      </div>

      {otherKeyPanelOpen && (
        <div
          id={otherKeyPanelId}
          ref={otherKeyPanelRef}
          className="other-key-panel"
          role="group"
          aria-label="Other keys"
        >
          <span className="other-key-panel-label" aria-hidden="true">Other</span>
          {OTHER_KEYS.map((terminalKey) => (
            <TerminalKeyButton
              key={terminalKey.label}
              terminalKey={terminalKey}
              enabled={enabled}
              onSend={onSend}
            />
          ))}
        </div>
      )}
    </section>
  );
});
