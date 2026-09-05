import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  CloseIcon,
  ContractIcon,
  EditIcon,
  ExpandIcon,
  AttachmentIcon,
  KeyboardIcon,
  MemoIcon,
  RefreshIcon,
  SnippetIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import type { AgentScrollMode } from "../agentScrollPreferences";
import type { UploadedSessionAttachment } from "../api";
import {
  desktopAttachmentsAvailable,
  MAX_ATTACHMENT_UPLOAD_BATCH,
  transferHasFiles,
  type SessionAttachmentUploader,
} from "../attachments";
import type { TerminalSubmissionTerminator } from "../terminalInput";
import {
  directShortcutAria,
  directShortcutLabel,
  useShortcutSettings,
} from "../shortcutSettings";

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
  onUploadAttachment?: SessionAttachmentUploader;
  onDraftChange?: (value: string) => void;
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
  replaceDraft: (text: string) => boolean;
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

interface StagedAttachmentUpload extends UploadedSessionAttachment {
  previewUrl?: string;
}

const PAGE_UP_SEQUENCE = "\x1b[5~";
const PAGE_DOWN_SEQUENCE = "\x1b[6~";
const CLEAR_TERMINAL_INPUT_SEQUENCE = "\x01\x0b";

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
  {
    label: "^Q",
    data: "\x11",
    ariaLabel: "Ctrl+Q - enqueue in Copilot CLI",
    title: "Enqueue the current prompt in Copilot CLI (Ctrl+Q)",
  },
  {
    label: "^T",
    data: "\x14",
    ariaLabel: "Ctrl+T - view full transcript in Codex CLI",
    title: "View earlier messages and the full transcript in Codex CLI (Ctrl+T)",
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
  const { bindings: shortcutBindings } = useShortcutSettings();
  const preferred = Boolean(
    terminalKey.scrollMode && terminalKey.scrollMode === preferredScrollMode,
  );
  const scrollBinding = terminalKey.scrollDirection === "up"
    ? shortcutBindings["terminal-page-up"]
    : shortcutBindings["terminal-page-down"];
  const shortcut = preferred && terminalKey.scrollDirection
    ? directShortcutAria(scrollBinding)
    : undefined;
  const shortcutLabel = preferred && terminalKey.scrollDirection
    ? directShortcutLabel(scrollBinding)
    : null;
  const title = preferred
    ? `${terminalKey.title}. Preferred for ${preferredScrollLabel || "this agent"}${
      shortcutLabel ? ` (${shortcutLabel})` : ""
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
  | "terminal-cleared"
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
  onUploadAttachment,
  onDraftChange,
  messageCount = 0,
  queuedMessageCount = 0,
}, ref) {
  const { bindings: shortcutBindings } = useShortcutSettings();
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
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const otherKeyPanelRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const actionPendingRef = useRef(false);
  const attachmentUploadPendingRef = useRef(false);
  const attachmentUploadControllersRef = useRef(new Set<AbortController>());
  const previewUrlsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const attachmentDragDepthRef = useRef(0);
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
  const [attachmentUploadPending, setAttachmentUploadPending] = useState(false);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachmentUpload[]>([]);
  const [attachmentUploadMessage, setAttachmentUploadMessage] = useState<string | null>(null);
  const [attachmentUploadError, setAttachmentUploadError] = useState(false);

  const recordDraft = (value: string, nextStatus: DraftStatus = "saved") => {
    const persisted = writeDraft(sessionName, value);
    setDraftLength(value.length);
    setDraftHasContent(Boolean(value.trim()));
    setStatus(persisted ? (value ? nextStatus : "idle") : "storage-error");
    onDraftChange?.(value);
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

  const replaceDraft = (text: string): boolean => {
    const textarea = textareaRef.current;
    if (
      !textarea
      || text.length > MAX_DRAFT_LENGTH
      || composingRef.current
      || actionPendingRef.current
    ) return false;
    textarea.value = text;
    memoSourceRef.current = null;
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    return true;
  };

  useImperativeHandle(ref, () => ({
    loadDraft,
    insertText,
    replaceDraft,
    getDraft: () => textareaRef.current?.value ?? initialDraft,
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
  }), [initialDraft]);

  useEffect(() => {
    onDraftChange?.(textareaRef.current?.value ?? initialDraft);
  }, [initialDraft, onDraftChange]);

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
      onDraftChange?.(handoff.draft);
      resizeTextarea(textarea);
    }
    renamedSessionDraftHandoffs.delete(sessionName);
  }, [initialDraft, onDraftChange, sessionId, sessionName]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = window.requestAnimationFrame(() => resizeTextarea(textarea));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!shortcutsVisible) setOtherKeyPanelOpen(false);
  }, [shortcutsVisible]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of attachmentUploadControllersRef.current) controller.abort();
      attachmentUploadControllersRef.current.clear();
      for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.clear();
    };
  }, []);

  const dismissAttachmentPreview = (path: string) => {
    setStagedAttachments((current) => current.filter((attachment) => {
      if (attachment.path !== path) return true;
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
        previewUrlsRef.current.delete(attachment.previewUrl);
      }
      return false;
    }));
  };

  const clearAttachmentPreviews = () => {
    for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.clear();
    setStagedAttachments([]);
    setAttachmentUploadMessage(null);
    setAttachmentUploadError(false);
  };

  const stageUploadedAttachments = (attachments: UploadedSessionAttachment[]): boolean => {
    const textarea = textareaRef.current;
    if (!textarea || attachments.length === 0) return false;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const leading = before && !/\s$/.test(before) ? "\n" : "";
    const trailing = after && !/^\s/.test(after) ? "\n" : "";
    const paths = attachments.map((attachment) => attachment.terminalText || attachment.path).join("\n");
    const insertion = `${leading}${paths}${trailing}`;
    const nextLength = textarea.value.length - (end - start) + insertion.length;
    if (nextLength > MAX_DRAFT_LENGTH) return false;

    textarea.setRangeText(insertion, start, end, "end");
    memoSourceRef.current = null;
    recordDraft(textarea.value, "loaded");
    resizeTextarea(textarea);
    onRevealComposer?.();
    window.requestAnimationFrame(() => textarea.focus());
    return true;
  };

  const uploadAttachmentFiles = async (files: File[]) => {
    if (
      !onUploadAttachment
      || attachmentUploadPendingRef.current
      || !desktopAttachmentsAvailable()
    ) return;
    if (files.length === 0) {
      setAttachmentUploadError(true);
      setAttachmentUploadMessage("Choose at least one file to attach.");
      return;
    }

    const selected = files.slice(0, MAX_ATTACHMENT_UPLOAD_BATCH);
    const controller = new AbortController();
    attachmentUploadControllersRef.current.add(controller);
    attachmentUploadPendingRef.current = true;
    setAttachmentUploadPending(true);
    setAttachmentUploadError(false);
    setAttachmentUploadMessage(
      `Uploading ${selected.length === 1 ? selected[0].name : `${selected.length} attachments`}...`,
    );

    const completed = await Promise.all(selected.map(async (file) => {
      try {
        return { file, uploaded: await onUploadAttachment(file, controller.signal) };
      } catch (error) {
        return { file, error };
      }
    }));
    attachmentUploadControllersRef.current.delete(controller);
    attachmentUploadPendingRef.current = false;
    if (!mountedRef.current || controller.signal.aborted) return;
    setAttachmentUploadPending(false);

    const successful = completed.filter((result) => "uploaded" in result) as Array<{
      file: File;
      uploaded: UploadedSessionAttachment;
    }>;
    const failed = completed.filter((result) => "error" in result) as Array<{
      file: File;
      error: unknown;
    }>;
    const previews = successful.map(({ file, uploaded }) => {
      let previewUrl: string | undefined;
      if (file.type.startsWith("image/")) {
        try {
          previewUrl = URL.createObjectURL(file);
          previewUrlsRef.current.add(previewUrl);
        } catch {
          previewUrl = undefined;
        }
      }
      return { ...uploaded, previewUrl };
    });
    if (previews.length > 0) {
      setStagedAttachments((current) => {
        const combined = [...current, ...previews];
        const retained = combined.slice(-MAX_ATTACHMENT_UPLOAD_BATCH);
        for (const removed of combined.slice(0, -MAX_ATTACHMENT_UPLOAD_BATCH)) {
          if (removed.previewUrl) {
            URL.revokeObjectURL(removed.previewUrl);
            previewUrlsRef.current.delete(removed.previewUrl);
          }
        }
        return retained;
      });
    }

    const staged = stageUploadedAttachments(successful.map((result) => result.uploaded));
    if (failed.length > 0) {
      const firstError = failed[0].error;
      const detail = firstError instanceof Error
        ? firstError.message
        : `Unable to upload ${failed[0].file.name}`;
      setAttachmentUploadError(true);
      setAttachmentUploadMessage(successful.length > 0
        ? `${successful.length} staged; ${failed.length} failed: ${detail}`
        : detail);
      return;
    }
    if (!staged) {
      setAttachmentUploadError(true);
      setAttachmentUploadMessage(
        "File uploaded, but the draft is too full for its path. Copy the path from the file card.",
      );
      return;
    }
    const skipped = files.length - selected.length;
    setAttachmentUploadMessage(
      `${successful.length === 1 ? "File path" : `${successful.length} file paths`} staged at the cursor. Add instructions, then send.${skipped > 0 ? ` ${skipped} extra files were skipped.` : ""}`,
    );
  };

  const handleAttachmentPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (
      files.length === 0
      || !onUploadAttachment
      || !desktopAttachmentsAvailable()
    ) return;
    event.preventDefault();
    void uploadAttachmentFiles(files);
  };

  const handleAttachmentDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (
      !onUploadAttachment
      || !desktopAttachmentsAvailable()
      || !transferHasFiles(event.dataTransfer)
    ) return;
    event.preventDefault();
    attachmentDragDepthRef.current += 1;
    setAttachmentDragActive(true);
  };

  const handleAttachmentDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (
      !onUploadAttachment
      || !desktopAttachmentsAvailable()
      || !transferHasFiles(event.dataTransfer)
    ) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleAttachmentDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!attachmentDragActive) return;
    event.preventDefault();
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
    if (attachmentDragDepthRef.current === 0) setAttachmentDragActive(false);
  };

  const handleAttachmentDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (
      !onUploadAttachment
      || !desktopAttachmentsAvailable()
      || !transferHasFiles(event.dataTransfer)
    ) return;
    event.preventDefault();
    attachmentDragDepthRef.current = 0;
    setAttachmentDragActive(false);
    void uploadAttachmentFiles(Array.from(event.dataTransfer.files));
  };

  const copyAttachmentPath = async (attachment: StagedAttachmentUpload) => {
    try {
      await navigator.clipboard.writeText(attachment.terminalText || attachment.path);
      setAttachmentUploadError(false);
      setAttachmentUploadMessage(`Copied the server path for ${attachment.name}.`);
    } catch {
      setAttachmentUploadError(true);
      setAttachmentUploadMessage("Clipboard access was unavailable; select the path from the card.");
    }
  };

  const sendDraft = async (terminator: TerminalSubmissionTerminator) => {
    const textarea = textareaRef.current;
    if (
      !textarea
      || !textarea.value
      || !enabled
      || actionPendingRef.current
      || attachmentUploadPendingRef.current
    ) return;
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
    clearAttachmentPreviews();
    resizeTextarea(textarea);
    textarea.focus();
  };

  const addDraftToMemo = async () => {
    const textarea = textareaRef.current;
    if (
      !textarea
      || !onAddToMemo
      || actionPendingRef.current
      || attachmentUploadPendingRef.current
    ) return;
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
    if (
      !enabled
      || !event.currentTarget.value
      || actionPendingRef.current
      || attachmentUploadPendingRef.current
    ) return;

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
    clearAttachmentPreviews();
    resizeTextarea(textarea);
    textarea.focus();
  };

  const clearTerminalInput = () => {
    if (!enabled || actionPendingRef.current) return;
    if (onSend(CLEAR_TERMINAL_INPUT_SEQUENCE)) setStatus("terminal-cleared");
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
  } else if (status === "terminal-cleared") {
    statusText = "Terminal-side input cleared; the local staged draft is unchanged.";
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
  const draftActionPending = actionPending || attachmentUploadPending;

  return (
    <section
      className="input-dock"
      aria-label="Terminal input"
      hidden={!composerVisible && !shortcutsVisible}
    >
      {shortcutPanelHeader}
      <div
        id="muxdeck-staged-input"
        className={attachmentDragActive ? "staged-composer attachment-drag-active" : "staged-composer"}
        data-attachment-uploading={attachmentUploadPending ? "true" : "false"}
        hidden={!composerVisible}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
        <div className="composer-heading">
          <label htmlFor="terminal-staged-input">Staged input</label>
          <div className="composer-heading-tools">
            <button
              type="button"
              className="composer-snippet-trigger"
              aria-label="Insert snippet into staged input"
              aria-haspopup="dialog"
              title="Search your snippet library and insert at the current cursor without sending"
              disabled={!onOpenSnippets}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onOpenSnippets}
            >
              <SnippetIcon />
              <span>Insert snippet</span>
            </button>
            <button
              type="button"
              className="composer-attachment-trigger"
              aria-label="Attach files to staged input"
              title="Upload files to this host and stage their private server paths"
              disabled={!onUploadAttachment || attachmentUploadPending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => attachmentInputRef.current?.click()}
            >
              <AttachmentIcon />
              <span>{attachmentUploadPending ? "Uploading..." : "Attach files"}</span>
            </button>
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files || []);
                event.currentTarget.value = "";
                if (files.length > 0) void uploadAttachmentFiles(files);
              }}
            />
          </div>
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
        {attachmentDragActive && (
          <div className="composer-attachment-drop" role="status">
            <AttachmentIcon />
            <strong>Drop to stage file paths</strong>
            <span>Files stay on the Muxdeck host for your terminal agent.</span>
          </div>
        )}
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
            onPaste={handleAttachmentPaste}
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
              disabled={!draftLength || draftActionPending}
              onClick={clearDraft}
            >
              <span className="composer-action-label-full" aria-hidden="true">Clear</span>
              <span className="composer-action-label-compact" aria-hidden="true">C</span>
            </button>
            <button
              type="button"
              className="secondary-button composer-clear-terminal"
              aria-label="Clear terminal input"
              title="Clear text already written to the terminal without submitting it; keep the local staged-input box unchanged"
              disabled={!enabled || actionPending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearTerminalInput}
            >
              <span className="composer-action-label-full" aria-hidden="true">Clear terminal</span>
              <span className="composer-action-label-compact" aria-hidden="true">CT</span>
            </button>
            <button
              type="button"
              className="secondary-button composer-send"
              aria-label="Send"
              disabled={!enabled || !draftLength || draftActionPending}
              onClick={() => void sendDraft("none")}
            >
              <span className="composer-action-label-full" aria-hidden="true">Send</span>
              <span className="composer-action-label-compact" aria-hidden="true">S</span>
            </button>
            <button
              type="button"
              className="primary-button composer-send-enter"
              disabled={!enabled || !draftLength || draftActionPending}
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
              disabled={!onAddToMemo || !draftHasContent || draftActionPending}
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
              disabled={!enabled || !draftLength || draftActionPending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void sendDraft("tab")}
            >
              <span className="composer-action-label-full" aria-hidden="true">Send + Tab</span>
              <span className="composer-action-label-compact" aria-hidden="true">S+T</span>
            </button>
          </div>
        </div>
        {stagedAttachments.length > 0 && (
          <div
            className="composer-attachment-tray"
            role="region"
            aria-label="Uploaded files"
          >
            {stagedAttachments.map((attachment) => (
              <article className="composer-attachment-card" key={attachment.path}>
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <span className="composer-attachment-fallback" aria-hidden="true">
                    <AttachmentIcon />
                  </span>
                )}
                <div>
                  <strong>{attachment.name}</strong>
                  <button
                    type="button"
                    title={attachment.path}
                    aria-label={`Copy server path for ${attachment.name}`}
                    onClick={() => void copyAttachmentPath(attachment)}
                  >
                    <code>{attachment.path}</code>
                    <span>Copy path</span>
                  </button>
                </div>
                <button
                  type="button"
                  className="composer-attachment-dismiss"
                  aria-label={`Dismiss file card for ${attachment.name}`}
                  title="Dismiss this card; the staged path and host file remain"
                  onClick={() => dismissAttachmentPreview(attachment.path)}
                >
                  <CloseIcon />
                </button>
              </article>
            ))}
          </div>
        )}
        {attachmentUploadMessage && (
          <p
            className={attachmentUploadError
              ? "composer-attachment-status error"
              : "composer-attachment-status"}
            role="status"
            aria-live="polite"
          >
            {attachmentUploadPending && <span className="composer-attachment-spinner" aria-hidden="true" />}
            {attachmentUploadMessage}
          </p>
        )}
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
          aria-keyshortcuts={directShortcutAria(shortcutBindings["terminal-return-live"])}
          title={`Exit scrollback and focus raw terminal input${directShortcutLabel(shortcutBindings["terminal-return-live"])
            ? ` (${directShortcutLabel(shortcutBindings["terminal-return-live"])})`
            : ""}`}
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
          aria-keyshortcuts={directShortcutAria(shortcutBindings["session-end"])}
          title={`End this entire tmux session and all of its panes${directShortcutLabel(shortcutBindings["session-end"])
            ? ` (${directShortcutLabel(shortcutBindings["session-end"])})`
            : ""}`}
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
          aria-keyshortcuts={directShortcutAria(shortcutBindings["session-rename"])}
          title={`Rename the real tmux session (${[
            directShortcutLabel(shortcutBindings["session-rename"]),
            "tmux: Ctrl+B, then $",
          ].filter(Boolean).join("; ")})`}
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
