import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  createQueuedMessage,
  deleteQueuedMessage,
  listQueuedMessages,
  updateQueuedMessage,
} from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CloseIcon, RefreshIcon, SnippetIcon } from "../icons";
import type { QueuedMessage, SnippetLeaf } from "../types";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import "./MessageQueueDialog.css";

export const MAX_QUEUED_MESSAGE_LENGTH = 65_536;

export interface MessageQueueDialogProps {
  sessionName: string;
  sessionTitle?: string | null;
  onClose: () => void;
  onChoose?: (message: QueuedMessage) => void | Promise<void>;
  onSend?: (message: QueuedMessage) => void | Promise<void>;
}

function sortMessages(messages: QueuedMessage[]): QueuedMessage[] {
  return [...messages].sort(
    (left, right) => left.position - right.position || left.createdAt - right.createdAt,
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatMessageTime(message: QueuedMessage): string {
  const timestamp = message.updatedAt || message.createdAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function MessageQueueDialog({
  sessionName,
  sessionTitle,
  onClose,
  onChoose,
  onSend,
}: MessageQueueDialogProps) {
  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingInitialText, setEditingInitialText] = useState("");
  const [editLength, setEditLength] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [addLength, setAddLength] = useState(0);
  const [snippetTarget, setSnippetTarget] = useState<"add" | "edit" | null>(null);
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const requestNumberRef = useRef(0);
  const sessionNameRef = useRef(sessionName);

  sessionNameRef.current = sessionName;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    dialogRef.current?.focus();

    return () => {
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestNumber = ++requestNumberRef.current;
    setMessages([]);
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    setPending(null);
    setEditingId(null);
    setConfirmDeleteId(null);
    setAddLength(0);
    if (addTextareaRef.current) addTextareaRef.current.value = "";

    void listQueuedMessages(sessionName, controller.signal)
      .then((queue) => {
        if (requestNumber !== requestNumberRef.current) return;
        setMessages(sortMessages(queue.messages));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestNumber !== requestNumberRef.current) return;
        setLoadError(errorMessage(error, "Unable to load queued messages"));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestNumber === requestNumberRef.current) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [sessionName]);

  useEffect(() => {
    if (!editingId) return;
    const frame = window.requestAnimationFrame(() => editTextareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editingId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (snippetTarget) return;
      if (event.key === "Escape") {
        if (pending) return;
        if (confirmDeleteId) {
          setConfirmDeleteId(null);
        } else if (editingId) {
          setEditingId(null);
        } else {
          onClose();
        }
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirmDeleteId, editingId, onClose, pending, snippetTarget]);

  const refresh = async () => {
    const requestedSession = sessionName;
    const requestNumber = ++requestNumberRef.current;
    setRefreshing(true);
    setLoadError(null);
    setActionError(null);
    try {
      const queue = await listQueuedMessages(requestedSession);
      if (requestNumber !== requestNumberRef.current || sessionNameRef.current !== requestedSession) {
        return;
      }
      setMessages(sortMessages(queue.messages));
      setNotice("Queue refreshed.");
    } catch (error) {
      if (requestNumber !== requestNumberRef.current) return;
      setLoadError(errorMessage(error, "Unable to refresh queued messages"));
    } finally {
      if (requestNumber === requestNumberRef.current) setRefreshing(false);
    }
  };

  const addMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = addTextareaRef.current?.value ?? "";
    const length = codePointLength(text);
    if (!text.trim() || length > MAX_QUEUED_MESSAGE_LENGTH) return;

    setPending("add");
    setActionError(null);
    setNotice(null);
    try {
      const message = await createQueuedMessage(sessionName, text);
      setMessages((current) => sortMessages([...current, message]));
      if (addTextareaRef.current) addTextareaRef.current.value = "";
      setAddLength(0);
      setNotice("Message added to the queue.");
    } catch (error) {
      setActionError(errorMessage(error, "Unable to add message"));
    } finally {
      setPending(null);
    }
  };

  const startEditing = (message: QueuedMessage) => {
    setEditingId(message.id);
    setEditingInitialText(message.text);
    setEditLength(codePointLength(message.text));
    setConfirmDeleteId(null);
    setActionError(null);
    setNotice(null);
  };

  const saveEdit = async (event: FormEvent, messageId: string) => {
    event.preventDefault();
    const text = editTextareaRef.current?.value ?? "";
    const length = codePointLength(text);
    if (!text.trim() || length > MAX_QUEUED_MESSAGE_LENGTH) return;

    setPending(`edit:${messageId}`);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await updateQueuedMessage(sessionName, messageId, { text });
      setMessages((current) => sortMessages(
        current.map((message) => message.id === messageId ? updated : message),
      ));
      setEditingId(null);
      setNotice("Queued message updated.");
    } catch (error) {
      setActionError(errorMessage(error, "Unable to update message"));
    } finally {
      setPending(null);
    }
  };

  const removeMessage = async (message: QueuedMessage) => {
    setPending(`delete:${message.id}`);
    setActionError(null);
    setNotice(null);
    try {
      await deleteQueuedMessage(sessionName, message.id);
      setMessages((current) => current
        .filter((candidate) => candidate.id !== message.id)
        .map((candidate, position) => ({ ...candidate, position })));
      setConfirmDeleteId(null);
      setNotice("Message deleted from the queue.");
    } catch (error) {
      setActionError(errorMessage(error, "Unable to delete message"));
    } finally {
      setPending(null);
    }
  };

  const chooseMessage = async (message: QueuedMessage) => {
    if (!onChoose) return;
    setPending(`choose:${message.id}`);
    setActionError(null);
    setNotice(null);
    try {
      await onChoose(message);
      onClose();
    } catch (error) {
      setActionError(errorMessage(error, "Unable to use queued message"));
      setPending(null);
    }
  };

  const sendMessage = async (message: QueuedMessage) => {
    if (!onSend) return;
    setPending(`send:${message.id}`);
    setActionError(null);
    setNotice(null);
    try {
      await onSend(message);
      setNotice("Message sent. It remains in the queue for reuse.");
    } catch (error) {
      setActionError(errorMessage(error, "Unable to send queued message"));
    } finally {
      setPending(null);
    }
  };

  const closeFromBackdrop = () => {
    if (!pending) onClose();
  };

  const stopDialogKeyPropagation = (event: ReactKeyboardEvent) => {
    // Terminal-level keyboard handlers must never receive text typed in this dialog.
    event.stopPropagation();
  };

  const insertSnippet = (snippet: SnippetLeaf) => {
    const textarea = snippetTarget === "edit" ? editTextareaRef.current : addTextareaRef.current;
    if (!textarea) throw new Error("The target input is no longer available.");
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const nextValue = `${textarea.value.slice(0, start)}${snippet.text}${textarea.value.slice(end)}`;
    if (codePointLength(nextValue) > MAX_QUEUED_MESSAGE_LENGTH) {
      throw new Error("This snippet does not fit within the message limit.");
    }
    textarea.setRangeText(snippet.text, start, end, "end");
    if (snippetTarget === "edit") setEditLength(codePointLength(textarea.value));
    else setAddLength(codePointLength(textarea.value));
    textarea.focus();
  };

  const addIsValid = addLength > 0 && addLength <= MAX_QUEUED_MESSAGE_LENGTH
    && Boolean(addTextareaRef.current?.value.trim());

  return (
    <>
    <div className="mq-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="mq-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-queue-heading"
        aria-describedby="message-queue-session"
        aria-busy={loading || Boolean(pending)}
        tabIndex={-1}
        onKeyDown={stopDialogKeyPropagation}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mq-header">
          <div className="mq-heading-copy">
            <p className="mq-eyebrow">MEMORANDUM · {messages.length} QUEUED</p>
            <h2 id="message-queue-heading">Queued messages</h2>
            <p id="message-queue-session" className="mq-session-name">
              {sessionTitle ? <><span>{sessionTitle}</span> · </> : null}<code>{sessionName}</code>
            </p>
          </div>
          <div className="mq-header-actions">
            <button
              type="button"
              className="mq-icon-button"
              onClick={() => void refresh()}
              disabled={loading || refreshing || Boolean(pending)}
              aria-label={refreshing ? "Refreshing queued messages" : "Refresh queued messages"}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="mq-icon-button"
              onClick={onClose}
              disabled={Boolean(pending)}
              aria-label="Close queued messages"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <form className="mq-add-form" onSubmit={(event) => void addMessage(event)}>
          <div className="mq-field-heading">
            <label htmlFor="message-queue-add">Add a message</label>
            <div>
              <button type="button" className="mq-snippet-button" onClick={() => setSnippetTarget("add")} disabled={loading || Boolean(pending)}>
                <SnippetIcon /> Insert snippet
              </button>
              <span className={addLength > MAX_QUEUED_MESSAGE_LENGTH ? "mq-count mq-count-over" : "mq-count"}>
                {addLength.toLocaleString()} / {MAX_QUEUED_MESSAGE_LENGTH.toLocaleString()}
              </span>
            </div>
          </div>
          <textarea
            ref={addTextareaRef}
            id="message-queue-add"
            defaultValue=""
            rows={3}
            placeholder="Dictate, paste, or type a prompt to keep for later..."
            disabled={loading || Boolean(pending)}
            aria-describedby="message-queue-add-hint"
            aria-invalid={addLength > MAX_QUEUED_MESSAGE_LENGTH}
            onInput={(event) => setAddLength(codePointLength(event.currentTarget.value))}
          />
          <div className="mq-add-footer">
            <p id="message-queue-add-hint">Saved exactly as written. Adding it does not send it to tmux.</p>
            <button type="submit" className="mq-button mq-button-primary" disabled={!addIsValid || loading || Boolean(pending)}>
              {pending === "add" ? "Adding..." : "Add to queue"}
            </button>
          </div>
        </form>

        <div className="mq-announcements" aria-live="polite" aria-atomic="true">
          {actionError && <p className="mq-alert" role="alert">{actionError}</p>}
          {!actionError && notice && <p className="mq-notice">{notice}</p>}
        </div>

        <div className="mq-list-region">
          {loading ? (
            <div className="mq-state" role="status">Loading queued messages...</div>
          ) : loadError ? (
            <div className="mq-state mq-state-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="mq-button" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Retrying..." : "Try again"}
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="mq-state mq-state-empty">
              <strong>The queue is empty.</strong>
              <span>Add a prompt above, then reuse it whenever this session needs it.</span>
            </div>
          ) : (
            <ol className="mq-list" aria-label="Queued messages">
              {messages.map((message, index) => {
                const isEditing = editingId === message.id;
                const isConfirmingDelete = confirmDeleteId === message.id;
                const itemPending = pending?.endsWith(`:${message.id}`) ?? false;
                const editIsValid = editLength > 0
                  && editLength <= MAX_QUEUED_MESSAGE_LENGTH
                  && Boolean(editTextareaRef.current?.value.trim());

                return (
                  <li className="mq-item" key={message.id}>
                    <div className="mq-item-meta">
                      <span className="mq-position">{String(index + 1).padStart(2, "0")}</span>
                      <time dateTime={new Date(message.updatedAt || message.createdAt).toISOString()}>
                        Updated {formatMessageTime(message)}
                      </time>
                    </div>

                    {isEditing ? (
                      <form className="mq-edit-form" onSubmit={(event) => void saveEdit(event, message.id)}>
                        <label className="mq-sr-only" htmlFor={`message-queue-edit-${message.id}`}>
                          Edit queued message {index + 1}
                        </label>
                        <textarea
                          ref={editTextareaRef}
                          id={`message-queue-edit-${message.id}`}
                          key={message.id}
                          defaultValue={editingInitialText}
                          rows={5}
                          disabled={itemPending}
                          aria-invalid={editLength > MAX_QUEUED_MESSAGE_LENGTH}
                          onInput={(event) => setEditLength(codePointLength(event.currentTarget.value))}
                        />
                        <div className="mq-edit-footer">
                          <div className="mq-edit-snippet-tools">
                            <button type="button" className="mq-snippet-button" onClick={() => setSnippetTarget("edit")} disabled={itemPending}>
                              <SnippetIcon /> Insert snippet
                            </button>
                            <span className={editLength > MAX_QUEUED_MESSAGE_LENGTH ? "mq-count mq-count-over" : "mq-count"}>
                              {editLength.toLocaleString()} / {MAX_QUEUED_MESSAGE_LENGTH.toLocaleString()}
                            </span>
                          </div>
                          <div className="mq-actions">
                            <button type="button" className="mq-button" onClick={() => setEditingId(null)} disabled={itemPending}>Cancel</button>
                            <button type="submit" className="mq-button mq-button-primary" disabled={!editIsValid || itemPending}>
                              {pending === `edit:${message.id}` ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <>
                        <pre className="mq-message-text">{message.text}</pre>
                        {isConfirmingDelete ? (
                          <div className="mq-delete-confirm" role="group" aria-label={`Delete queued message ${index + 1}?`}>
                            <span>Delete this message?</span>
                            <button type="button" className="mq-button" onClick={() => setConfirmDeleteId(null)} disabled={itemPending}>Cancel</button>
                            <button type="button" className="mq-button mq-button-danger" onClick={() => void removeMessage(message)} disabled={itemPending}>
                              {pending === `delete:${message.id}` ? "Deleting..." : "Confirm delete"}
                            </button>
                          </div>
                        ) : (
                          <div className="mq-actions mq-item-actions">
                            {onChoose && (
                              <button type="button" className="mq-button mq-button-primary" onClick={() => void chooseMessage(message)} disabled={Boolean(pending)}>
                                {pending === `choose:${message.id}` ? "Using..." : "Use"}
                              </button>
                            )}
                            {onSend && (
                              <button type="button" className="mq-button mq-button-send" onClick={() => void sendMessage(message)} disabled={Boolean(pending)}>
                                {pending === `send:${message.id}` ? "Sending..." : "Send now"}
                              </button>
                            )}
                            <button type="button" className="mq-button" onClick={() => startEditing(message)} disabled={Boolean(pending)}>Edit</button>
                            <button type="button" className="mq-button mq-button-quiet-danger" onClick={() => setConfirmDeleteId(message.id)} disabled={Boolean(pending)}>Delete</button>
                          </div>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>
    {snippetTarget && (
      <SnippetPickerDialog
        title={snippetTarget === "edit" ? "Insert into queued message" : "Insert into new memorandum"}
        onClose={() => setSnippetTarget(null)}
        onChoose={insertSnippet}
      />
    )}
    </>
  );
}
