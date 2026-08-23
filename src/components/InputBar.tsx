import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ContractIcon,
  EditIcon,
  ExpandIcon,
  KeyboardIcon,
  MemoIcon,
  RefreshIcon,
  SnippetIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import type { AgentScrollMode } from "../agentScrollPreferences";
import type { TerminalSubmissionTerminator } from "../terminalInput";

export const MAX_DRAFT_LENGTH = 65_536;
const DRAFT_KEY_PREFIX = "muxdeck-terminal-draft:";

interface InputBarProps {
  sessionName: string;
  sessionId?: string;
  enabled: boolean;
  composerVisible?: boolean;
  shortcutsVisible?: boolean;
  shortcutPanelHeader?: ReactNode;
  preferredScrollMode?: AgentScrollMode;
  preferredScrollLabel?: string;
  onScrollModeUsed?: (mode: AgentScrollMode) => void;
  mobileDistractionFree?: boolean;
  onToggleMobileDistractionFree?: () => void;
  onSend: (data: string) => boolean;
  onSubmit: (data: string, terminator: TerminalSubmissionTerminator) => Promise<boolean>;
  onAddToMemo?: (data: string) => Promise<void>;
  onConsumeMemo?: (source: MemoDraftSource) => Promise<void>;
  onReturnToLive: () => void;
  onFocus: () => void;
  onRedraw?: () => void;
  onRevealComposer?: () => void;
  onEditSessionTitle?: () => void;
  onRenameSession?: () => void;
  onTerminateSession?: () => void;
  onOpenMessages?: () => void;
  onOpenSnippets?: () => void;
  messageCount?: number;
  queuedMessageCount?: number;
}

export interface MemoDraftSource {
  messageId: string;
  text: string;
}

export interface InputBarHandle {
  loadDraft: (text: string, source?: MemoDraftSource) => boolean;
  insertText: (text: string) => boolean;
  getDraft: () => string;
  focus: () => void;
  blur: () => void;
}

interface TerminalKey {
  label: string;
  data: string;
  compact?: string;
  ariaLabel?: string;
  title?: string;
  scrollMode?: AgentScrollMode;
  scrollDirection?: "up" | "down";
}

const PAGE_UP_SEQUENCE = "\x1b[5~";
const PAGE_DOWN_SEQUENCE = "\x1b[6~";

const ESSENTIAL_KEYS: TerminalKey[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03", title: "Send Ctrl+C or leave tmux copy mode" },
  { label: "Enter", data: "\r" },
  {
    label: "^K",
    data: "\x0b",
    ariaLabel: "Ctrl+K - delete to end of input",
    title: "Delete from the cursor to the end of input in supported shells and agents (Ctrl+K)",
  },
];

const KEYS: TerminalKey[] = [
  {
    label: "Tmux PgUp",
    compact: "T Up",
    data: `\x02${PAGE_UP_SEQUENCE}`,
    ariaLabel: "Tmux Page Up",
    title: "Enter tmux copy mode one page up (Ctrl+B, then Page Up)",
    scrollMode: "tmux",
    scrollDirection: "up",
  },
  {
    label: "Tmux PgDn",
    compact: "T Dn",
    // Default tmux handles Page Down directly after Page Up enters copy mode.
    data: PAGE_DOWN_SEQUENCE,
    ariaLabel: "Tmux Page Down",
    title: "Page down while tmux copy mode is active",
    scrollMode: "tmux",
    scrollDirection: "down",
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
    scrollMode: "application",
    scrollDirection: "up",
  },
  {
    label: "PgDn",
    data: PAGE_DOWN_SEQUENCE,
    title: "Page down in the foreground application or tmux copy mode",
    scrollMode: "application",
    scrollDirection: "down",
  },
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
  preferredScrollMode?: AgentScrollMode;
  preferredScrollLabel?: string;
  onScrollModeUsed?: (mode: AgentScrollMode) => void;
}

function TerminalKeyButton({
  terminalKey,
  enabled,
  onSend,
  preferredScrollMode,
  preferredScrollLabel,
  onScrollModeUsed,
}: TerminalKeyButtonProps) {
  const preferred = Boolean(
    terminalKey.scrollMode && terminalKey.scrollMode === preferredScrollMode,
  );
  const shortcut = preferred && terminalKey.scrollDirection
    ? `Control+Shift+${terminalKey.scrollDirection === "up" ? "U" : "D"}`
    : undefined;
  const title = preferred
    ? `${terminalKey.title}. Preferred for ${preferredScrollLabel || "this agent"}${
      shortcut ? ` (${shortcut.replace("Control", "Ctrl")})` : ""
    }`
    : terminalKey.title;
  return (
    <button
      type="button"
      className={preferred ? "key-button preferred-scroll-key" : "key-button"}
      disabled={!enabled}
      aria-label={terminalKey.ariaLabel || terminalKey.label}
      aria-keyshortcuts={shortcut}
      data-scroll-preferred={preferred ? "true" : undefined}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const sent = onSend(terminalKey.data);
        if (sent && terminalKey.scrollMode) onScrollModeUsed?.(terminalKey.scrollMode);
      }}
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

type DraftStatus =
  | "idle"
  | "saved"
  | "loaded"
  | "sending"
  | "sent"
  | "sent-memo-cleanup-error"
  | "unconfirmed"
  | "queueing"
  | "queued"
  | "queue-error"
  | "clipboard-error"
  | "storage-error";

export type StageSessionDraftResult = "staged" | "cancelled" | "storage-error" | "invalid";
export type RenameSessionDraftResult = "migrated" | "swapped" | "unchanged" | "storage-error";

interface RenamedSessionDraftHandoff {
  sessionId: string;
  draft: string;
  storageError: boolean;
}

const renamedSessionDraftHandoffs = new Map<string, RenamedSessionDraftHandoff>();

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
  if (!writeDraft(sessionName, text)) return "storage-error";
  renamedSessionDraftHandoffs.delete(sessionName);
  return "staged";
}

export function renameSessionDraft(
  previousName: string,
  nextName: string,
  visibleDraft?: string,
): RenameSessionDraftResult {
  if (!previousName || !nextName || previousName === nextName) return "unchanged";
  try {
    const previousKey = draftKey(previousName);
    const nextKey = draftKey(nextName);
    const storedPreviousDraft = window.localStorage.getItem(previousKey);
    const previousDraft = visibleDraft ?? storedPreviousDraft;
    if (previousDraft === null) return "unchanged";
    const nextDraft = window.localStorage.getItem(nextKey);

    if (nextDraft && nextDraft !== previousDraft) {
      // The destination can have a stale draft even though tmux rejects live name collisions.
      window.localStorage.setItem(previousKey, nextDraft);
      try {
        if (previousDraft) window.localStorage.setItem(nextKey, previousDraft);
        else window.localStorage.removeItem(nextKey);
      } catch {
        try {
          if (storedPreviousDraft) {
            window.localStorage.setItem(previousKey, storedPreviousDraft);
          } else {
            window.localStorage.removeItem(previousKey);
          }
        } catch {
          // The in-memory handoff remains authoritative when rollback also fails.
        }
        return "storage-error";
      }
      return "swapped";
    }

    if (previousDraft) window.localStorage.setItem(nextKey, previousDraft);
    else window.localStorage.removeItem(nextKey);
    window.localStorage.removeItem(previousKey);
    return "migrated";
  } catch {
    return "storage-error";
  }
}

export function handoffRenamedSessionDraft(
  previousName: string,
  nextName: string,
  sessionId: string,
  visibleDraft: string,
): RenameSessionDraftResult {
  if (!previousName || !nextName || !sessionId || previousName === nextName) {
    return "unchanged";
  }
  const handoff = { sessionId, draft: visibleDraft, storageError: false };
  renamedSessionDraftHandoffs.set(nextName, handoff);
  const result = renameSessionDraft(previousName, nextName, visibleDraft);
  handoff.storageError = result === "storage-error";
  return result;
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 144)}px`;
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  sessionName,
  sessionId,
  enabled,
  composerVisible = true,
  shortcutsVisible = true,
  shortcutPanelHeader,
  preferredScrollMode,
  preferredScrollLabel,
  onScrollModeUsed,
  mobileDistractionFree = false,
  onToggleMobileDistractionFree,
  onSend,
  onSubmit,
  onAddToMemo,
  onConsumeMemo,
  onReturnToLive,
  onFocus,
  onRedraw,
  onRevealComposer,
  onEditSessionTitle,
  onRenameSession,
  onTerminateSession,
  onOpenMessages,
  onOpenSnippets,
  messageCount = 0,
  queuedMessageCount = 0,
}, ref) {
  const [initialDraftState] = useState(() => {
    const pendingHandoff = renamedSessionDraftHandoffs.get(sessionName);
    const handoff = pendingHandoff?.sessionId === sessionId ? pendingHandoff : undefined;
    return {
      draft: handoff?.draft ?? readDraft(sessionName),
      handoff,
    };
  });
  const initialDraft = initialDraftState.draft;
  const otherKeyPanelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const otherKeyPanelRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const actionPendingRef = useRef(false);
  const memoSourceRef = useRef<MemoDraftSource | null>(null);
  const [draftLength, setDraftLength] = useState(initialDraft.length);
  const [draftHasContent, setDraftHasContent] = useState(Boolean(initialDraft.trim()));
  const [status, setStatus] = useState<DraftStatus>(
    initialDraftState.handoff?.storageError
      ? "storage-error"
      : initialDraft ? "saved" : "idle",
  );
  const [actionPending, setActionPending] = useState(false);
  const [otherKeyPanelOpen, setOtherKeyPanelOpen] = useState(false);

  const recordDraft = (value: string, nextStatus: DraftStatus = "saved") => {
    const persisted = writeDraft(sessionName, value);
    setDraftLength(value.length);
    setDraftHasContent(Boolean(value.trim()));
    setStatus(persisted ? (value ? nextStatus : "idle") : "storage-error");
    return persisted;
  };

  const loadDraft = (text: string, source?: MemoDraftSource): boolean => {
    const textarea = textareaRef.current;
    if (
      !textarea
      || text.length > MAX_DRAFT_LENGTH
      || composingRef.current
      || actionPendingRef.current
    ) return false;
    if (
      textarea.value
      && textarea.value !== text
      && !window.confirm("Replace the staged input that is already here?")
    ) return false;
    textarea.value = text;
    memoSourceRef.current = source?.text === text ? source : null;
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return true;
  };

  const insertText = (text: string): boolean => {
    const textarea = textareaRef.current;
    if (!textarea || !text || composingRef.current || actionPendingRef.current) return false;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const nextLength = textarea.value.length - (end - start) + text.length;
    if (nextLength > MAX_DRAFT_LENGTH) return false;
    textarea.setRangeText(text, start, end, "end");
    memoSourceRef.current = null;
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    textarea.focus();
    return true;
  };

  useImperativeHandle(ref, () => ({
    loadDraft,
    insertText,
    getDraft: () => textareaRef.current?.value ?? initialDraft,
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
  }), [initialDraft]);

  useEffect(() => {
    const handoff = initialDraftState.handoff;
    if (handoff && renamedSessionDraftHandoffs.get(sessionName) === handoff) {
      renamedSessionDraftHandoffs.delete(sessionName);
    }
  }, [initialDraftState.handoff, sessionName]);

  useEffect(() => {
    if (!sessionId) return;
    const handoff = renamedSessionDraftHandoffs.get(sessionName);
    if (!handoff) return;
    if (handoff.sessionId !== sessionId) {
      renamedSessionDraftHandoffs.delete(sessionName);
      return;
    }

    const textarea = textareaRef.current;
    if (textarea && textarea.value === initialDraft) {
      textarea.value = handoff.draft;
      setDraftLength(handoff.draft.length);
      setDraftHasContent(Boolean(handoff.draft.trim()));
      setStatus(handoff.storageError ? "storage-error" : handoff.draft ? "saved" : "idle");
      resizeTextarea(textarea);
    }
    renamedSessionDraftHandoffs.delete(sessionName);
  }, [initialDraft, sessionId, sessionName]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = window.requestAnimationFrame(() => resizeTextarea(textarea));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!shortcutsVisible) setOtherKeyPanelOpen(false);
  }, [shortcutsVisible]);

  const sendDraft = async (terminator: TerminalSubmissionTerminator) => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value || !enabled || actionPendingRef.current) return;
    if (composingRef.current) {
      textarea.blur();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    const submitted = textarea.value;
    if (!submitted) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setStatus("sending");
    textarea.readOnly = true;
    let accepted = false;
    try {
      accepted = await onSubmit(submitted, terminator);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      textarea.readOnly = false;
      actionPendingRef.current = false;
      setActionPending(false);
      setStatus("unconfirmed");
      textarea.focus();
      return;
    }

    const memoSource = memoSourceRef.current?.text === submitted
      ? memoSourceRef.current
      : null;
    textarea.value = "";
    memoSourceRef.current = null;
    const draftCleared = recordDraft("", "sent");
    let memoCleanupFailed = false;
    if (memoSource && onConsumeMemo) {
      try {
        await onConsumeMemo(memoSource);
      } catch {
        memoCleanupFailed = true;
      }
    }
    textarea.readOnly = false;
    actionPendingRef.current = false;
    setActionPending(false);
    if (memoCleanupFailed) setStatus("sent-memo-cleanup-error");
    else if (draftCleared) setStatus("sent");
    resizeTextarea(textarea);
    textarea.focus();
  };

  const addDraftToMemo = async () => {
    const textarea = textareaRef.current;
    if (!textarea || !onAddToMemo || actionPendingRef.current) return;
    if (composingRef.current) {
      textarea.blur();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    const submitted = textarea.value;
    if (!submitted.trim()) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setStatus("queueing");
    textarea.readOnly = true;
    let queued = false;
    try {
      await onAddToMemo(submitted);
      queued = true;
    } catch {
      queued = false;
    } finally {
      textarea.readOnly = false;
      actionPendingRef.current = false;
      setActionPending(false);
    }
    if (!queued) {
      setStatus("queue-error");
      textarea.focus();
      return;
    }
    textarea.value = "";
    memoSourceRef.current = null;
    if (recordDraft("", "queued")) setStatus("queued");
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
    if (!enabled || !event.currentTarget.value || actionPendingRef.current) return;

    event.preventDefault();
    if (!event.repeat) void sendDraft("enter");
  };

  const clearDraft = () => {
    const textarea = textareaRef.current;
    if (!textarea || !textarea.value) return;
    if (!window.confirm("Discard this staged input?")) return;
    textarea.value = "";
    memoSourceRef.current = null;
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
      memoSourceRef.current = null;
      recordDraft(textarea.value);
      resizeTextarea(textarea);
      onRevealComposer?.();
      window.requestAnimationFrame(() => textarea.focus());
    } catch {
      setStatus("clipboard-error");
      textarea.focus();
    }
  };

  let statusText: string;
  if (status === "sent") {
    statusText = "Written once to the attached tmux PTY; the local draft was cleared.";
  } else if (status === "sent-memo-cleanup-error") {
    statusText = "Delivered, but its memo entry could not be removed. Delete that entry manually; do not send it again.";
  } else if (status === "sending") {
    statusText = "Writing this staged snapshot to the attached tmux PTY...";
  } else if (status === "loaded") {
    statusText = "Draft loaded locally. Memoranda, snippets, and console actions can stage text here; edit or send when ready.";
  } else if (status === "unconfirmed") {
    statusText = "Delivery was not confirmed. The draft is retained; check the terminal before retrying.";
  } else if (status === "queued") {
    statusText = "Queued in this session's memo; the local draft was cleared.";
  } else if (status === "queueing") {
    statusText = "Queueing this staged snapshot in the session memo...";
  } else if (status === "queue-error") {
    statusText = "The memo was not updated. The draft is retained; retry when ready.";
  } else if (status === "clipboard-error") {
    statusText = "Clipboard access was unavailable. Use the keyboard paste command here.";
  } else if (status === "storage-error") {
    statusText = "This draft is visible but could not be saved on this device. Copy it before leaving this page.";
  } else if (draftLength > 0) {
    statusText = "Saved on this device. Terminal-side edits do not rewrite this draft.";
  } else {
    statusText = enabled
      ? "Nothing goes to tmux or memoranda until you choose an action."
      : "Compose now; memoranda remain available while terminal sending reconnects.";
  }

  return (
    <section
      className="input-dock"
      aria-label="Terminal input"
      hidden={!composerVisible && !shortcutsVisible}
    >
      {shortcutPanelHeader}
      <div
        id="muxdeck-staged-input"
        className="staged-composer"
        hidden={!composerVisible}
      >
        <div className="composer-heading">
          <label htmlFor="terminal-staged-input">Staged input</label>
          <div
            className="composer-mobile-controls"
            role="group"
            aria-label="Mobile staged input controls"
          >
            <button
              type="button"
              className={queuedMessageCount > 0
                ? "composer-mobile-control composer-memo-open has-queued"
                : "composer-mobile-control composer-memo-open"}
              aria-label={queuedMessageCount > 0
                ? `Open memo, ${queuedMessageCount} queued`
                : messageCount > 0
                  ? `Open memo, ${messageCount} saved`
                  : "Open memo"}
              aria-haspopup="dialog"
              disabled={!onOpenMessages}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onOpenMessages}
            >
              <MemoIcon />
              <span>Memo</span>
              {queuedMessageCount > 0 ? (
                <strong className="memo-count queued" aria-hidden="true">
                  Q {queuedMessageCount}
                </strong>
              ) : messageCount > 0 ? (
                <strong className="memo-count" aria-hidden="true">{messageCount}</strong>
              ) : null}
            </button>
            <button
              type="button"
              className="composer-mobile-control composer-distraction-toggle"
              aria-label={mobileDistractionFree
                ? "Exit distraction-free input"
                : "Enter distraction-free input"}
              aria-controls="muxdeck-staged-input"
              aria-pressed={mobileDistractionFree}
              disabled={!onToggleMobileDistractionFree}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onToggleMobileDistractionFree}
            >
              {mobileDistractionFree ? <ContractIcon /> : <ExpandIcon />}
              <span>{mobileDistractionFree ? "Exit" : "Focus"}</span>
            </button>
          </div>
          <span>{draftLength.toLocaleString()} / {MAX_DRAFT_LENGTH.toLocaleString()}</span>
        </div>
        <div className="composer-body">
          <textarea
            id="terminal-staged-input"
            ref={textareaRef}
            defaultValue={initialDraft}
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
              memoSourceRef.current = null;
              recordDraft(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onInput={(event) => {
              // Never write value back: iOS owns its replacement range during dictation.
              memoSourceRef.current = null;
              recordDraft(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onBlur={(event) => recordDraft(event.currentTarget.value)}
          />
          <div className="composer-actions-primary">
            <button
              type="button"
              className="secondary-button composer-clear"
              aria-label="Clear"
              disabled={!draftLength || actionPending}
              onClick={clearDraft}
            >
              <span className="composer-action-label-full" aria-hidden="true">Clear</span>
              <span className="composer-action-label-compact" aria-hidden="true">C</span>
            </button>
            <button
              type="button"
              className="secondary-button composer-send"
              aria-label="Send"
              disabled={!enabled || !draftLength || actionPending}
              onClick={() => void sendDraft("none")}
            >
              <span className="composer-action-label-full" aria-hidden="true">Send</span>
              <span className="composer-action-label-compact" aria-hidden="true">S</span>
            </button>
            <button
              type="button"
              className="primary-button composer-send-enter"
              disabled={!enabled || !draftLength || actionPending}
              aria-label="Send + Enter"
              aria-keyshortcuts="Shift+Enter"
              title="Send staged input followed by Enter (Shift+Enter)"
              onClick={() => void sendDraft("enter")}
            >
              <span className="composer-action-label-full" aria-hidden="true">Send + Enter</span>
              <span className="composer-action-label-compact" aria-hidden="true">S+E</span>
              <span className="composer-shortcut-hint" aria-hidden="true">
                <kbd>Shift</kbd><span>+</span><kbd>Enter</kbd>
              </span>
            </button>
            <button
              type="button"
              className={queuedMessageCount > 0
                ? "secondary-button composer-memo has-queued"
                : "secondary-button composer-memo"}
              aria-label="Queue in memo"
              disabled={!onAddToMemo || !draftHasContent || actionPending}
              onClick={() => void addDraftToMemo()}
            >
              <span className="composer-action-label-full" aria-hidden="true">
                {status === "queueing" ? "Queueing..." : "Queue in memo"}
              </span>
              <span className="composer-action-label-compact" aria-hidden="true">M</span>
              {mobileDistractionFree && queuedMessageCount > 0 && (
                <span className="composer-memo-queued-count" aria-hidden="true">
                  Q {queuedMessageCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="secondary-button composer-send-tab"
              aria-label="Send + Tab"
              title="Send staged input followed by Tab"
              disabled={!enabled || !draftLength || actionPending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void sendDraft("tab")}
            >
              <span className="composer-action-label-full" aria-hidden="true">Send + Tab</span>
              <span className="composer-action-label-compact" aria-hidden="true">S+T</span>
            </button>
          </div>
        </div>
        <p className={`composer-status ${status}`} aria-live="polite">
          <span className={enabled || status === "queued" ? "ready" : ""} />{statusText}
        </p>
      </div>

      <div
        id="muxdeck-terminal-shortcuts"
        className="input-bar"
        role="group"
        aria-label="Terminal input shortcuts"
        hidden={!shortcutsVisible}
      >
        <button
          type="button"
          className={queuedMessageCount > 0 ? "key-button memo-key has-queued" : "key-button memo-key"}
          onClick={onOpenMessages}
          disabled={!onOpenMessages}
          aria-label={queuedMessageCount > 0
            ? `Open memoranda, ${queuedMessageCount} queued`
            : messageCount > 0
              ? `Open memoranda, ${messageCount} saved`
              : "Open memoranda"}
          aria-haspopup="dialog"
        >
          <MemoIcon />
          <span>Memo</span>
          {queuedMessageCount > 0 ? (
            <strong className="memo-count queued" aria-hidden="true">
              Q {queuedMessageCount}
            </strong>
          ) : messageCount > 0 ? (
            <strong className="memo-count" aria-hidden="true">{messageCount}</strong>
          ) : null}
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
        <button
          type="button"
          className="key-button live-key"
          onClick={onReturnToLive}
          disabled={!enabled}
          aria-label="Focus live terminal input"
          aria-controls="muxdeck-active-console"
          aria-keyshortcuts="Control+Shift+L"
          title="Exit scrollback and focus raw terminal input (Ctrl+Shift+L)"
          onMouseDown={(event) => event.preventDefault()}
        >
          <TerminalIcon /> <span>Live</span>
        </button>
        <button
          type="button"
          className="key-button redraw-key"
          onClick={onRedraw}
          disabled={!onRedraw}
          aria-label="Redraw terminal display"
          aria-controls="muxdeck-active-console"
          title="Repaint the local terminal display without reconnecting or changing the tmux session"
          onMouseDown={(event) => event.preventDefault()}
        >
          <RefreshIcon /> <span>Redraw</span>
        </button>
        <button
          type="button"
          className="key-button terminate-session-key"
          onClick={onTerminateSession}
          disabled={!onTerminateSession}
          aria-label="Terminate tmux session"
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+Shift+E"
          title="End this entire tmux session and all of its panes (Ctrl+Shift+E)"
        >
          <TrashIcon /> <span>End</span>
        </button>
        {ESSENTIAL_KEYS.map((terminalKey) => (
          <TerminalKeyButton
            key={terminalKey.label}
            terminalKey={terminalKey}
            enabled={enabled}
            onSend={onSend}
          />
        ))}
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
          <span>More Keys</span>
        </button>
        {KEYS.map((terminalKey) => (
          <TerminalKeyButton
            key={terminalKey.label}
            terminalKey={terminalKey}
            enabled={enabled}
            onSend={onSend}
            preferredScrollMode={preferredScrollMode}
            preferredScrollLabel={preferredScrollLabel}
            onScrollModeUsed={onScrollModeUsed}
          />
        ))}
        <button
          type="button"
          className="key-button session-title-key"
          onClick={onEditSessionTitle}
          disabled={!onEditSessionTitle}
          aria-label="Edit title and tags"
          title="Set a display title and organize this session"
        >
          <EditIcon /> <span>Details</span>
        </button>
        <button
          type="button"
          className="key-button session-rename-key"
          onClick={onRenameSession}
          disabled={!onRenameSession}
          aria-label="Rename tmux session"
          title="Rename the real tmux session (Ctrl+B, then $)"
        >
          <TerminalIcon /> <span>Tmux</span>
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
        <button type="button" className="key-button action-key" onClick={() => void pasteClipboard()}>Paste to draft</button>
      </div>

      {shortcutsVisible && otherKeyPanelOpen && (
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
