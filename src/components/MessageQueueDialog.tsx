import {
  useCallback,
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
  onCountsChange?: (counts: { total: number; queued: number }) => void;
}

function sortMessages(messages: QueuedMessage[]): QueuedMessage[] {
  return [...messages].sort(
    (left, right) => Number(right.state === "queued") - Number(left.state === "queued")
      || left.position - right.position
      || left.createdAt - right.createdAt,
  );
}

function memoCounts(messages: QueuedMessage[]): { total: number; queued: number } {
  return {
    total: messages.length,
    queued: messages.filter((message) => message.state === "queued").length,
  };
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
  onCountsChange,
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
  const [addQueued, setAddQueued] = useState(false);
  const [snippetTarget, setSnippetTarget] = useState<"add" | "edit" | null>(null);
  const [completedActions, setCompletedActions] = useState<Record<string, "staged" | "sent">>({});
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const requestNumberRef = useRef(0);
  const refreshingRef = useRef(false);
  const sessionNameRef = useRef(sessionName);
  const messagesRef = useRef<QueuedMessage[]>([]);
  const onCountsChangeRef = useRef(onCountsChange);

  sessionNameRef.current = sessionName;
  onCountsChangeRef.current = onCountsChange;

  const publishMessages = useCallback((nextMessages: QueuedMessage[]) => {
    const sorted = sortMessages(nextMessages);
    messagesRef.current = sorted;
    setMessages(sorted);
    onCountsChangeRef.current?.(memoCounts(sorted));
  }, []);

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
    messagesRef.current = [];
    setMessages([]);
    setLoading(true);
    refreshingRef.current = false;
    setRefreshing(false);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    setPending(null);
    setEditingId(null);
    setConfirmDeleteId(null);
    setAddLength(0);
    setAddQueued(false);
    setCompletedActions({});
    if (addTextareaRef.current) addTextareaRef.current.value = "";

    void listQueuedMessages(sessionName, controller.signal)
      .then((queue) => {
        if (requestNumber !== requestNumberRef.current) return;
        publishMessages(queue.messages);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestNumber !== requestNumberRef.current) return;
        setLoadError(errorMessage(error, "Unable to load memo"));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestNumber === requestNumberRef.current) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [publishMessages, sessionName]);

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
    if (refreshingRef.current) return;
    const requestedSession = sessionName;
    const requestNumber = ++requestNumberRef.current;
    refreshingRef.current = true;
    setRefreshing(true);
    setLoadError(null);
    setActionError(null);
    try {
      const queue = await listQueuedMessages(requestedSession);
      if (requestNumber !== requestNumberRef.current || sessionNameRef.current !== requestedSession) {
        return;
      }
      publishMessages(queue.messages);
      setNotice("Memo refreshed.");
    } catch (error) {
      if (requestNumber !== requestNumberRef.current) return;
      setLoadError(errorMessage(error, "Unable to refresh memo"));
    } finally {
      if (requestNumber === requestNumberRef.current) {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  };

  const addMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (refreshingRef.current) return;
    const text = addTextareaRef.current?.value ?? "";
    const length = codePointLength(text);
    if (!text.trim() || length > MAX_QUEUED_MESSAGE_LENGTH) return;

    setPending("add");
    setActionError(null);
    setNotice(null);
    const requestedSession = sessionName;
    const state = addQueued ? "queued" : "note";
    try {
      const message = await createQueuedMessage(requestedSession, text, state);
      if (sessionNameRef.current !== requestedSession) return;
      publishMessages([...messagesRef.current, message]);
      if (addTextareaRef.current) addTextareaRef.current.value = "";
      setAddLength(0);
      setAddQueued(false);
      setNotice(state === "queued"
        ? "Memo saved and queued as the next planned input."
        : "Note saved to this session's memo.");
    } catch (error) {
      if (sessionNameRef.current === requestedSession) {
        setActionError(errorMessage(error, "Unable to save memo"));
      }
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
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
    if (refreshingRef.current) return;
    const text = editTextareaRef.current?.value ?? "";
    const length = codePointLength(text);
    if (!text.trim() || length > MAX_QUEUED_MESSAGE_LENGTH) return;

    setPending(`edit:${messageId}`);
    setActionError(null);
    setNotice(null);
    const requestedSession = sessionName;
    try {
      const updated = await updateQueuedMessage(requestedSession, messageId, { text });
      if (sessionNameRef.current !== requestedSession) return;
      publishMessages(messagesRef.current.map(
        (message) => message.id === messageId ? updated : message,
      ));
      setEditingId(null);
      setNotice("Memo updated.");
    } catch (error) {
      if (sessionNameRef.current === requestedSession) {
        setActionError(errorMessage(error, "Unable to update memo"));
      }
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
    }
  };

  const removeMessage = async (message: QueuedMessage) => {
    if (refreshingRef.current) return;
    setPending(`delete:${message.id}`);
    setActionError(null);
    setNotice(null);
    const requestedSession = sessionName;
    try {
      await deleteQueuedMessage(requestedSession, message.id);
      if (sessionNameRef.current !== requestedSession) return;
      publishMessages(messagesRef.current
        .filter((candidate) => candidate.id !== message.id)
        .map((candidate, position) => ({ ...candidate, position })));
      setConfirmDeleteId(null);
      setCompletedActions((current) => {
        const next = { ...current };
        delete next[message.id];
        return next;
      });
      setNotice("Memo deleted.");
    } catch (error) {
      if (sessionNameRef.current === requestedSession) {
        setActionError(errorMessage(error, "Unable to delete memo"));
      }
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
    }
  };

  const reclassifyMessage = async (
    message: QueuedMessage,
    state: QueuedMessage["state"],
  ) => {
    if (refreshingRef.current) return;
    const requestedSession = sessionName;
    setPending(`state:${message.id}`);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await updateQueuedMessage(requestedSession, message.id, { state });
      if (sessionNameRef.current !== requestedSession) return;
      publishMessages(messagesRef.current.map(
        (candidate) => candidate.id === message.id ? updated : candidate,
      ));
      setCompletedActions((current) => {
        const next = { ...current };
        delete next[message.id];
        return next;
      });
      setNotice(state === "queued"
        ? "Memo added to the input queue."
        : "Memo moved to notes.");
    } catch (error) {
      if (sessionNameRef.current === requestedSession) {
        setActionError(errorMessage(error, state === "queued"
          ? "Unable to queue memo"
          : "Unable to move memo to notes"));
      }
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
    }
  };

  const chooseMessage = async (message: QueuedMessage) => {
    if (!onChoose || refreshingRef.current) return;
    setPending(`choose:${message.id}`);
    setActionError(null);
    setNotice(null);
    const requestedSession = sessionName;
    try {
      await onChoose(message);
      if (sessionNameRef.current !== requestedSession) return;
      if (message.state === "queued") {
        try {
          const updated = await updateQueuedMessage(requestedSession, message.id, { state: "note" });
          if (sessionNameRef.current !== requestedSession) return;
          publishMessages(messagesRef.current.map(
            (candidate) => candidate.id === message.id ? updated : candidate,
          ));
        } catch (error) {
          if (sessionNameRef.current !== requestedSession) return;
          setCompletedActions((current) => ({ ...current, [message.id]: "staged" }));
          setActionError(
            `This memo was staged, but it could not be moved out of the queue. ${errorMessage(
              error,
              "Use Move to notes before acting on it again.",
            )}`,
          );
          return;
        }
      }
      onClose();
    } catch (error) {
      if (sessionNameRef.current === requestedSession) {
        setActionError(errorMessage(error, "Unable to stage memo"));
      }
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
    }
  };

  const sendMessage = async (message: QueuedMessage) => {
    if (!onSend || refreshingRef.current) return;
    setPending(`send:${message.id}`);
    setActionError(null);
    setNotice(null);
    const requestedSession = sessionName;
    try {
      if (message.state === "queued") {
        let updated: QueuedMessage;
        try {
          updated = await updateQueuedMessage(requestedSession, message.id, { state: "note" });
        } catch (error) {
          if (sessionNameRef.current !== requestedSession) return;
          setActionError(
            `This memo was not sent because it could not first be moved out of the queue. It remains queued. ${errorMessage(
              error,
              "The memo update failed; try again when storage is available.",
            )}`,
          );
          return;
        }
        if (sessionNameRef.current !== requestedSession) return;
        publishMessages(messagesRef.current.map(
          (candidate) => candidate.id === message.id ? updated : candidate,
        ));
      }

      try {
        await onSend(message);
      } catch (error) {
        if (sessionNameRef.current !== requestedSession) return;
        if (message.state === "queued") {
          setActionError(
            `Delivery was not confirmed. This memo remains a note and was not re-queued. Check the terminal before manually choosing Queue next. ${errorMessage(
              error,
              "The terminal did not confirm delivery.",
            )}`,
          );
        } else {
          setActionError(errorMessage(error, "Unable to send memo"));
        }
        return;
      }

      try {
        await deleteQueuedMessage(requestedSession, message.id);
      } catch (error) {
        const wasAlreadyRemoved = typeof error === "object"
          && error !== null
          && "status" in error
          && error.status === 404;
        if (!wasAlreadyRemoved) {
          if (sessionNameRef.current === requestedSession) {
            setCompletedActions((current) => ({ ...current, [message.id]: "sent" }));
            setActionError(
              `This memo was sent, but it could not be removed automatically. Delete it manually; do not send it again. ${errorMessage(
                error,
                "Memo cleanup failed.",
              )}`,
            );
          }
          return;
        }
      }

      if (sessionNameRef.current !== requestedSession) return;
      publishMessages(messagesRef.current
        .filter((candidate) => candidate.id !== message.id)
        .map((candidate, position) => ({ ...candidate, position })));
      setCompletedActions((current) => {
        const next = { ...current };
        delete next[message.id];
        return next;
      });
      setNotice("Memo sent and removed.");
    } finally {
      if (sessionNameRef.current === requestedSession) setPending(null);
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
  const counts = memoCounts(messages);
  let queuePosition = 0;

  return (
    <>
    <div className="mq-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="mq-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-queue-heading"
        aria-describedby="message-queue-purpose message-queue-session"
        aria-busy={loading || refreshing || Boolean(pending)}
        tabIndex={-1}
        onKeyDown={stopDialogKeyPropagation}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mq-header">
          <div className="mq-heading-copy">
            <p className="mq-eyebrow">MEMO · {counts.total} SAVED · {counts.queued} QUEUED</p>
            <h2 id="message-queue-heading">Memo</h2>
            <p id="message-queue-purpose" className="mq-purpose">
              Draft freely. Queue only what you plan to use next.
            </p>
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
              aria-label={refreshing ? "Refreshing memo" : "Refresh memo"}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="mq-icon-button"
              onClick={onClose}
              disabled={Boolean(pending)}
              aria-label="Close memo"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <form className="mq-add-form" onSubmit={(event) => void addMessage(event)}>
          <div className="mq-field-heading">
            <label htmlFor="message-queue-add">New memo</label>
            <div>
              <button type="button" className="mq-snippet-button" onClick={() => setSnippetTarget("add")} disabled={loading || refreshing || Boolean(pending)}>
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
            placeholder="Draft a thought, paste a prompt, or keep a scratch note..."
            disabled={loading || refreshing || Boolean(pending)}
            aria-describedby="message-queue-add-hint"
            aria-invalid={addLength > MAX_QUEUED_MESSAGE_LENGTH}
            onInput={(event) => setAddLength(codePointLength(event.currentTarget.value))}
          />
          <div className="mq-add-footer">
            <p id="message-queue-add-hint">Saved exactly as written. Nothing is sent to tmux until you choose Stage or Send now.</p>
            <div className="mq-add-actions">
              <button
                type="button"
                className="mq-queue-toggle"
                aria-pressed={addQueued}
                onClick={() => setAddQueued((current) => !current)}
                disabled={loading || refreshing || Boolean(pending)}
              >
                <span aria-hidden="true" />
                Queue next
              </button>
              <button type="submit" className="mq-button mq-button-primary" disabled={!addIsValid || loading || refreshing || Boolean(pending)}>
                {pending === "add" ? "Saving..." : "Save memo"}
              </button>
            </div>
          </div>
        </form>

        <div className="mq-announcements" aria-live="polite" aria-atomic="true">
          {actionError && <p className="mq-alert" role="alert">{actionError}</p>}
          {!actionError && notice && <p className="mq-notice">{notice}</p>}
        </div>

        <div className="mq-list-region">
          {loading ? (
            <div className="mq-state" role="status">Loading memo...</div>
          ) : loadError ? (
            <div className="mq-state mq-state-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="mq-button" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Retrying..." : "Try again"}
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="mq-state mq-state-empty">
              <strong>Your memo is empty.</strong>
              <span>Keep a draft, scratch note, or queued input for this session.</span>
            </div>
          ) : (
            <ol className="mq-list" aria-label="Memo entries">
              {messages.map((message, index) => {
                const isQueued = message.state === "queued";
                const currentQueuePosition = isQueued ? ++queuePosition : null;
                const isEditing = editingId === message.id;
                const isConfirmingDelete = confirmDeleteId === message.id;
                const itemPending = pending?.endsWith(`:${message.id}`) ?? false;
                const completedAction = completedActions[message.id];
                const editIsValid = editLength > 0
                  && editLength <= MAX_QUEUED_MESSAGE_LENGTH
                  && Boolean(editTextareaRef.current?.value.trim());

                return (
                  <li className={isQueued ? "mq-item queued" : "mq-item note"} key={message.id}>
                    <div className="mq-item-meta">
                      <span className={isQueued ? "mq-state-chip queued" : "mq-state-chip note"}>
                        {isQueued
                          ? `Queued · ${String(currentQueuePosition).padStart(2, "0")}`
                          : "Note"}
                      </span>
                      <time dateTime={new Date(message.updatedAt || message.createdAt).toISOString()}>
                        Updated {formatMessageTime(message)}
                      </time>
                    </div>

                    {isEditing ? (
                      <form className="mq-edit-form" onSubmit={(event) => void saveEdit(event, message.id)}>
                        <label className="mq-sr-only" htmlFor={`message-queue-edit-${message.id}`}>
                          Edit memo {index + 1}
                        </label>
                        <textarea
                          ref={editTextareaRef}
                          id={`message-queue-edit-${message.id}`}
                          key={message.id}
                          defaultValue={editingInitialText}
                          rows={5}
                          disabled={refreshing || itemPending}
                          aria-invalid={editLength > MAX_QUEUED_MESSAGE_LENGTH}
                          onInput={(event) => setEditLength(codePointLength(event.currentTarget.value))}
                        />
                        <div className="mq-edit-footer">
                          <div className="mq-edit-snippet-tools">
                            <button type="button" className="mq-snippet-button" onClick={() => setSnippetTarget("edit")} disabled={refreshing || itemPending}>
                              <SnippetIcon /> Insert snippet
                            </button>
                            <span className={editLength > MAX_QUEUED_MESSAGE_LENGTH ? "mq-count mq-count-over" : "mq-count"}>
                              {editLength.toLocaleString()} / {MAX_QUEUED_MESSAGE_LENGTH.toLocaleString()}
                            </span>
                          </div>
                          <div className="mq-actions">
                            <button type="button" className="mq-button" onClick={() => setEditingId(null)} disabled={refreshing || itemPending}>Cancel</button>
                            <button type="submit" className="mq-button mq-button-primary" disabled={!editIsValid || refreshing || itemPending}>
                              {pending === `edit:${message.id}` ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <>
                        <pre className="mq-message-text">{message.text}</pre>
                        {isConfirmingDelete ? (
                          <div className="mq-delete-confirm" role="group" aria-label={`Delete memo ${index + 1}?`}>
                            <span>Delete this memo?</span>
                            <button type="button" className="mq-button" onClick={() => setConfirmDeleteId(null)} disabled={refreshing || itemPending}>Cancel</button>
                            <button type="button" className="mq-button mq-button-danger" onClick={() => void removeMessage(message)} disabled={refreshing || itemPending}>
                              {pending === `delete:${message.id}` ? "Deleting..." : "Confirm delete"}
                            </button>
                          </div>
                        ) : (
                          <div className="mq-actions mq-item-actions">
                            {onChoose && (
                              <button type="button" className="mq-button mq-button-primary" onClick={() => void chooseMessage(message)} disabled={refreshing || Boolean(pending) || Boolean(completedAction)}>
                                {pending === `choose:${message.id}`
                                  ? "Staging..."
                                  : completedAction === "staged" ? "Staged" : "Stage"}
                              </button>
                            )}
                            {onSend && (
                              <button type="button" className="mq-button mq-button-send" onClick={() => void sendMessage(message)} disabled={refreshing || Boolean(pending) || Boolean(completedAction)}>
                                {pending === `send:${message.id}`
                                  ? "Sending..."
                                  : completedAction === "sent" ? "Sent" : "Send now"}
                              </button>
                            )}
                            <button
                              type="button"
                              className={isQueued ? "mq-button mq-button-queue active" : "mq-button mq-button-queue"}
                              aria-pressed={isQueued}
                              onClick={() => void reclassifyMessage(message, isQueued ? "note" : "queued")}
                              disabled={refreshing || Boolean(pending) || completedAction === "sent"}
                            >
                              {pending === `state:${message.id}`
                                ? "Updating..."
                                : isQueued ? "Move to notes" : "Queue next"}
                            </button>
                            <button type="button" className="mq-button" onClick={() => startEditing(message)} disabled={refreshing || Boolean(pending) || completedAction === "sent"}>Edit</button>
                            <button type="button" className="mq-button mq-button-quiet-danger" onClick={() => setConfirmDeleteId(message.id)} disabled={refreshing || Boolean(pending)}>Delete</button>
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
        title={snippetTarget === "edit" ? "Insert into memo" : "Insert into new memo"}
        onClose={() => setSnippetTarget(null)}
        onChoose={insertSnippet}
      />
    )}
    </>
  );
}
