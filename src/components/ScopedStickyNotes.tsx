import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  getCommonNote,
  getSessionNote,
  getWorkspaceNote,
  replaceCommonNote,
  replaceSessionNote,
  replaceWorkspaceNote,
} from "../api";
import {
  CloseIcon,
  MemoIcon,
  PinIcon,
  TrashIcon,
} from "../icons";

export const MAX_SCOPED_NOTE_LENGTH = 8_000;
const NOTE_AUTOSAVE_DELAY_MS = 650;
const DESKTOP_SCOPED_NOTE_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const LEGACY_SCOPED_NOTE_WINDOW_STORAGE_PREFIX = "muxdeck.scoped-note-window.v1:";
export const SCOPED_NOTE_WINDOW_STORAGE_PREFIX = "muxdeck.scoped-note-window.v2:";

type NoteScope = "common" | "workspace" | "session";
type SaveState = "saved" | "pending" | "saving" | "error";

interface FloatingNotePosition {
  x: number;
  y: number;
}

interface NoteWindowPreference {
  open: boolean;
  floating: boolean;
  pinned: boolean;
  position: FloatingNotePosition | null;
}

interface OpenNoteEditor {
  key: string;
  scope: NoteScope;
  identity: string;
  scopeName: string;
  note: string;
  pinned: boolean;
  position: FloatingNotePosition;
  focusOnMount: boolean;
}

interface ScopedStickyNotesProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

interface NoteSnapshot {
  identity: string | null;
  note: string;
  loading: boolean;
  error: string | null;
}

interface StickyNoteEditorProps {
  editorKey: string;
  scope: NoteScope;
  scopeName: string;
  note: string;
  pinned: boolean;
  position: FloatingNotePosition;
  focusOnMount: boolean;
  active: boolean;
  onSave: (note: string) => Promise<void>;
  onClose: () => void;
  onPinnedChange: (pinned: boolean) => void;
  onPositionChange: (position: FloatingNotePosition) => void;
  onPositionCommit: (position: FloatingNotePosition) => void;
  onActivate: () => void;
}

function noteEditorKey(scope: NoteScope, identity: string): string {
  return `${scope}:${identity}`;
}

function noteWorkspaceIdentity(
  workspaceId: string | null,
  sessionName: string,
): string {
  return workspaceId ? `workspace:${workspaceId}` : `temporary:${sessionName}`;
}

function noteWindowKey(
  workspaceIdentity: string,
  scope: NoteScope,
  identity: string,
): string {
  return `${workspaceIdentity}:${noteEditorKey(scope, identity)}`;
}

function validFloatingNotePosition(value: unknown): value is FloatingNotePosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FloatingNotePosition>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function parseNoteWindowPreference(raw: string): NoteWindowPreference | null {
  try {
    const candidate = JSON.parse(raw) as Partial<NoteWindowPreference>;
    const pinned = candidate.pinned === true;
    const open = candidate.open === true || (candidate.open === undefined && pinned);
    return {
      open,
      floating: true,
      pinned: open && pinned,
      position: validFloatingNotePosition(candidate.position)
        ? candidate.position
        : null,
    };
  } catch {
    return null;
  }
}

function readNoteWindowPreference(
  key: string,
  legacyKey: string,
): NoteWindowPreference {
  const fallback: NoteWindowPreference = {
    open: false,
    floating: true,
    pinned: false,
    position: null,
  };
  try {
    const raw = window.localStorage.getItem(`${SCOPED_NOTE_WINDOW_STORAGE_PREFIX}${key}`);
    if (raw) return parseNoteWindowPreference(raw) ?? fallback;
    const legacyRaw = window.localStorage.getItem(
      `${LEGACY_SCOPED_NOTE_WINDOW_STORAGE_PREFIX}${legacyKey}`,
    );
    return legacyRaw ? parseNoteWindowPreference(legacyRaw) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

function writeNoteWindowPreference(
  key: string,
  preference: NoteWindowPreference,
): void {
  try {
    window.localStorage.setItem(
      `${SCOPED_NOTE_WINDOW_STORAGE_PREFIX}${key}`,
      JSON.stringify(preference),
    );
  } catch {
    // Layout preferences are optional; note content still saves to the server.
  }
}

function defaultFloatingNotePosition(scope: NoteScope): FloatingNotePosition {
  const index = scope === "common" ? 0 : scope === "workspace" ? 1 : 2;
  const width = Math.min(430, Math.max(320, window.innerWidth - 32));
  return {
    x: Math.max(12, window.innerWidth - width - 24 - index * 34),
    y: 92 + index * 54,
  };
}

function clampFloatingNotePosition(
  position: FloatingNotePosition,
  element?: HTMLElement | null,
): FloatingNotePosition {
  const margin = 12;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const rect = element?.getBoundingClientRect();
  const width = rect?.width || Math.min(430, Math.max(320, viewportWidth - margin * 2));
  const height = rect?.height || Math.min(470, Math.max(280, viewportHeight - margin * 2));
  return {
    x: Math.round(Math.min(
      Math.max(margin, position.x),
      Math.max(margin, viewportWidth - width - margin),
    )),
    y: Math.round(Math.min(
      Math.max(margin, position.y),
      Math.max(margin, viewportHeight - height - margin),
    )),
  };
}

function preferredFloatingNotePosition(
  scope: NoteScope,
  preference: NoteWindowPreference,
): FloatingNotePosition {
  return clampFloatingNotePosition(
    preference.position ?? defaultFloatingNotePosition(scope),
  );
}

function desktopScopedNotesViewport(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(DESKTOP_SCOPED_NOTE_QUERY).matches;
  }
  const width = window.visualViewport?.width ?? window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  return width > 640 && height > 500;
}

function useDesktopScopedNotes(): boolean {
  const [desktop, setDesktop] = useState(desktopScopedNotesViewport);

  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_SCOPED_NOTE_QUERY);
    const viewport = window.visualViewport;
    const update = () => setDesktop(desktopScopedNotesViewport());
    update();
    query?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    viewport?.addEventListener?.("resize", update);
    return () => {
      query?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener?.("resize", update);
    };
  }, []);

  return desktop;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function notePreview(note: string): string {
  return note.trim().replace(/\s+/g, " ") || "Add note";
}

function scopeDescription(scope: NoteScope, scopeName: string): string {
  if (scope === "common") return "Shared in every workspace on this Muxdeck server.";
  if (scope === "workspace") return `Saved only with ${scopeName}.`;
  return `Follows the native tmux session ${scopeName} across workspaces.`;
}

function StickyNoteCard({
  scope,
  snapshot,
  disabledReason,
  open,
  pinned,
  onToggle,
}: {
  scope: NoteScope;
  snapshot: NoteSnapshot;
  disabledReason?: string;
  open: boolean;
  pinned: boolean;
  onToggle: () => void;
}) {
  const label = scope === "common"
    ? "Common"
    : scope === "workspace"
      ? "Workspace"
      : "Session";
  const preview = snapshot.loading
    ? "Loading"
    : snapshot.error
      ? "Unavailable"
      : disabledReason || notePreview(snapshot.note);
  const disabled = snapshot.loading || Boolean(snapshot.error) || Boolean(disabledReason);
  const windowState = pinned ? "PIN" : open ? "OPEN" : null;
  const actionLabel = open
    ? `Hide ${label.toLowerCase()} note`
    : `${snapshot.note ? "Edit" : "Add"} ${label.toLowerCase()} note`;

  return (
    <button
      type="button"
      className={[
        "scoped-sticky-note",
        scope,
        snapshot.note ? "has-note" : "empty",
        snapshot.error ? "error" : "",
        open ? "window-open" : "",
        pinned ? "window-pinned" : "",
      ].filter(Boolean).join(" ")}
      onClick={onToggle}
      disabled={disabled}
      aria-label={actionLabel}
      aria-expanded={open}
      title={disabledReason || snapshot.error || (open
        ? `Hide ${label.toLowerCase()} note`
        : `${label}: ${notePreview(snapshot.note)}`)}
    >
      <MemoIcon />
      <span>
        <strong>{label}</strong>
        <small>{preview}</small>
      </span>
      {windowState && (
        <em className="scoped-sticky-note-window-state" aria-hidden="true">
          {windowState}
        </em>
      )}
    </button>
  );
}

function StickyNoteEditor({
  editorKey,
  scope,
  scopeName,
  note,
  pinned,
  position,
  focusOnMount,
  active,
  onSave,
  onClose,
  onPinnedChange,
  onPositionChange,
  onPositionCommit,
  onActivate,
}: StickyNoteEditorProps) {
  const headingId = useId();
  const descriptionId = useId();
  const textareaId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const closingRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const draftRef = useRef(note);
  const lastQueuedRef = useRef(note);
  const failedValueRef = useRef<string | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const latestRequestRef = useRef<{ value: string; promise: Promise<boolean> } | null>(null);
  const requestVersionRef = useRef(0);
  const queuedRequestCountRef = useRef(0);
  const autosaveTimerRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState(note);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const label = scope === "common" ? "Common" : scopeName;

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current === null) return;
    window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  const enqueueSave = useCallback((value: string, forceRetry = false): Promise<boolean> => {
    const latestRequest = latestRequestRef.current;
    if (
      !forceRetry
      && value === lastQueuedRef.current
      && failedValueRef.current !== value
    ) {
      return latestRequest?.value === value
        ? latestRequest.promise
        : Promise.resolve(true);
    }

    const version = ++requestVersionRef.current;
    lastQueuedRef.current = value;
    failedValueRef.current = null;
    queuedRequestCountRef.current += 1;
    if (mountedRef.current) {
      setSaveState("saving");
      setSaveError(null);
    }

    const operation = queueRef.current
      .catch(() => undefined)
      .then(() => onSaveRef.current(value));
    queueRef.current = operation.then(() => undefined, () => undefined);
    const result = operation.then(
      () => {
        queuedRequestCountRef.current -= 1;
        if (failedValueRef.current === value) failedValueRef.current = null;
        if (mountedRef.current && version === requestVersionRef.current) {
          setSaveState(draftRef.current === value ? "saved" : "pending");
          setSaveError(null);
        }
        return true;
      },
      (error: unknown) => {
        queuedRequestCountRef.current -= 1;
        failedValueRef.current = value;
        if (mountedRef.current && version === requestVersionRef.current) {
          setSaveState("error");
          setSaveError(errorMessage(error, "Unable to save this note."));
        }
        return false;
      },
    );
    latestRequestRef.current = { value, promise: result };
    return result;
  }, []);

  const scheduleSave = useCallback((value: string) => {
    clearAutosaveTimer();
    if (
      value === lastQueuedRef.current
      && failedValueRef.current !== value
    ) {
      setSaveState(queuedRequestCountRef.current > 0 ? "saving" : "saved");
      setSaveError(null);
      return;
    }
    setSaveState("pending");
    setSaveError(null);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void enqueueSave(value, failedValueRef.current === value);
    }, NOTE_AUTOSAVE_DELAY_MS);
  }, [clearAutosaveTimer, enqueueSave]);

  const finish = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearAutosaveTimer();
    setClosing(true);
    const value = draftRef.current;
    const saved = await enqueueSave(value, failedValueRef.current === value);
    if (!mountedRef.current) return;
    if (saved) {
      onClose();
      return;
    }
    closingRef.current = false;
    setClosing(false);
  }, [clearAutosaveTimer, enqueueSave, onClose]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAutosaveTimer();
      dragCleanupRef.current?.();
      const latestDraft = draftRef.current;
      if (
        latestDraft !== lastQueuedRef.current
        || failedValueRef.current === latestDraft
      ) {
        void queueRef.current
          .catch(() => undefined)
          .then(() => onSaveRef.current(latestDraft))
          .catch(() => undefined);
      }
    };
  }, [clearAutosaveTimer]);

  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    const keepWindowVisible = () => {
      const next = clampFloatingNotePosition(position, formRef.current);
      if (next.x === position.x && next.y === position.y) return;
      onPositionChange(next);
      onPositionCommit(next);
    };
    const viewport = window.visualViewport;
    window.addEventListener("resize", keepWindowVisible);
    viewport?.addEventListener?.("resize", keepWindowVisible);
    return () => {
      window.removeEventListener("resize", keepWindowVisible);
      viewport?.removeEventListener?.("resize", keepWindowVisible);
    };
  }, [onPositionChange, onPositionCommit, position]);

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button, input, textarea, select, a")) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    dragCleanupRef.current?.();

    const pointerId = event.pointerId;
    const rect = formRef.current?.getBoundingClientRect();
    const hasMeasuredWindow = Boolean(rect?.width && rect?.height);
    const offsetX = event.clientX - (hasMeasuredWindow ? rect!.left : position.x);
    const offsetY = event.clientY - (hasMeasuredWindow ? rect!.top : position.y);
    let latestPosition = position;

    const cleanupDrag = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.documentElement.classList.remove("scoped-note-moving");
      if (dragCleanupRef.current === cleanupDrag) dragCleanupRef.current = null;
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      latestPosition = clampFloatingNotePosition({
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY,
      }, formRef.current);
      onPositionChange(latestPosition);
    };
    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanupDrag();
      onPositionCommit(latestPosition);
    };

    dragCleanupRef.current = cleanupDrag;
    document.documentElement.classList.add("scoped-note-moving");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
  }, [onActivate, onPositionChange, onPositionCommit, position]);

  const moveWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? 32 : 12;
    const next = clampFloatingNotePosition({
      x: position.x + direction[0] * distance,
      y: position.y + direction[1] * distance,
    }, formRef.current);
    onActivate();
    onPositionChange(next);
    onPositionCommit(next);
  }, [onActivate, onPositionChange, onPositionCommit, position]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void finish();
  };

  const editorStyle: CSSProperties = {
    left: position.x,
    top: position.y,
    zIndex: active ? 39 : 35,
  };

  const editor = (
    <form
      ref={formRef}
      className={[
        "title-sheet",
        "scoped-note-sheet",
        scope,
        "floating",
        active ? "active" : "",
        pinned ? "pinned" : "",
      ].filter(Boolean).join(" ")}
      style={editorStyle}
      role="dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={saveState === "saving" || closing}
      data-editor-key={editorKey}
      data-pinned={pinned ? "true" : "false"}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void finish();
          return;
        }
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      <header
        className="scoped-note-floating-header"
        tabIndex={0}
        aria-label={`Move ${scope} note window`}
        title="Drag this title strip to move the note. Arrow keys also move it."
        onPointerDown={startDragging}
        onKeyDown={moveWithKeyboard}
      >
        <div className="scoped-note-heading">
          <p className="eyebrow">{scope.toUpperCase()} NOTE</p>
          <h2 id={headingId}>{label}</h2>
        </div>
        <div className="scoped-note-window-controls">
          {pinned && (
            <span className="scoped-note-pinned-badge" aria-hidden="true">
              PINNED
            </span>
          )}
          <button
            type="button"
            className="scoped-note-window-control"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${scope} note`}
            aria-pressed={pinned}
            title={pinned
              ? "Stop keeping this note open"
              : scope === "session"
                ? "Keep this note open while this session is active"
                : "Keep this note visible across session switches"}
            onClick={() => onPinnedChange(!pinned)}
          >
            <PinIcon filled={pinned} />
          </button>
          <button
            type="submit"
            className="scoped-note-window-control"
            aria-label="Save and close note"
            disabled={closing}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <p id={descriptionId} className="scoped-note-description">
        {scopeDescription(scope, scopeName)} Changes save automatically.
      </p>
      <label htmlFor={textareaId}>Note</label>
      <textarea
        ref={textareaRef}
        id={textareaId}
        value={draft}
        maxLength={MAX_SCOPED_NOTE_LENGTH}
        placeholder="Pin a reminder, command, handoff, or next step..."
        onChange={(event) => {
          const value = event.target.value;
          draftRef.current = value;
          setDraft(value);
          scheduleSave(value);
        }}
      />

      <div className="scoped-note-editor-meta">
        <span
          className={`scoped-note-save-state ${saveState}`}
          role="status"
          aria-live="polite"
        >
          {saveState === "saved"
            ? "Saved"
            : saveState === "pending"
              ? "Waiting to save..."
              : saveState === "saving"
                ? "Saving..."
                : saveError || "Save failed"}
        </span>
        <span>{draft.length.toLocaleString()} / {MAX_SCOPED_NOTE_LENGTH.toLocaleString()}</span>
      </div>

      <div className="title-actions scoped-note-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!draft || closing}
          onClick={() => {
            draftRef.current = "";
            setDraft("");
            scheduleSave("");
            textareaRef.current?.focus();
          }}
        >
          <TrashIcon /> Clear
        </button>
        {saveState === "error" && (
          <button
            type="button"
            className="secondary-button"
            disabled={closing}
            onClick={() => void enqueueSave(draftRef.current, true)}
          >
            Retry
          </button>
        )}
        <button type="submit" className="primary-button" disabled={closing}>
          {closing ? "Saving..." : "Done"}
        </button>
      </div>
    </form>
  );

  return createPortal(editor, document.body);
}

export function ScopedStickyNotes({
  sessionName,
  workspaceId = null,
  workspaceName = null,
}: ScopedStickyNotesProps) {
  const desktop = useDesktopScopedNotes();
  const windowWorkspaceIdentity = noteWorkspaceIdentity(workspaceId, sessionName);
  const [common, setCommon] = useState<NoteSnapshot>({
    identity: "common",
    note: "",
    loading: true,
    error: null,
  });
  const [workspace, setWorkspace] = useState<NoteSnapshot>({
    identity: workspaceId,
    note: "",
    loading: Boolean(workspaceId),
    error: null,
  });
  const [session, setSession] = useState<NoteSnapshot>({
    identity: sessionName,
    note: "",
    loading: true,
    error: null,
  });
  const [openEditors, setOpenEditors] = useState<OpenNoteEditor[]>([]);
  const [activeEditorKey, setActiveEditorKey] = useState<string | null>(null);
  const previousWindowWorkspaceRef = useRef(windowWorkspaceIdentity);
  const previousSessionNameRef = useRef(sessionName);
  const restoredWorkspaceRef = useRef<string | null>(null);
  const restoredSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getCommonNote(controller.signal).then((note) => {
      if (!controller.signal.aborted) {
        setCommon({ identity: "common", note, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setCommon({
          identity: "common",
          note: "",
          loading: false,
          error: errorMessage(error, "Unable to load the common note."),
        });
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (previousWindowWorkspaceRef.current === windowWorkspaceIdentity) return;
    setOpenEditors([]);
    setActiveEditorKey(null);
    restoredWorkspaceRef.current = null;
    restoredSessionRef.current = null;
    previousWindowWorkspaceRef.current = windowWorkspaceIdentity;
  }, [windowWorkspaceIdentity]);

  useEffect(() => {
    setWorkspace({
      identity: workspaceId,
      note: "",
      loading: Boolean(workspaceId),
      error: null,
    });
    if (!workspaceId) return;
    const controller = new AbortController();
    void getWorkspaceNote(workspaceId, controller.signal).then((note) => {
      if (!controller.signal.aborted) {
        setWorkspace({ identity: workspaceId, note, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setWorkspace({
          identity: workspaceId,
          note: "",
          loading: false,
          error: errorMessage(error, "Unable to load the workspace note."),
        });
      }
    });
    return () => controller.abort();
  }, [workspaceId]);

  useEffect(() => {
    if (previousSessionNameRef.current === sessionName) return;
    setOpenEditors((current) => current.filter((editor) => {
      const keepVisible = editor.pinned
        && (
          editor.scope === "common"
          || (editor.scope === "workspace" && editor.identity === workspaceId)
        );
      if (keepVisible) return true;

      const reopenWithSession = editor.scope === "session"
        && editor.pinned;
      writeNoteWindowPreference(editor.key, {
        open: reopenWithSession,
        floating: true,
        pinned: reopenWithSession,
        position: editor.position,
      });
      return false;
    }));
    previousSessionNameRef.current = sessionName;
  }, [sessionName, workspaceId]);

  useEffect(() => {
    setSession({ identity: sessionName, note: "", loading: true, error: null });
    const controller = new AbortController();
    void getSessionNote(sessionName, controller.signal).then((note) => {
      if (!controller.signal.aborted) {
        setSession({ identity: sessionName, note, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setSession({
          identity: sessionName,
          note: "",
          loading: false,
          error: errorMessage(error, "Unable to load the session note."),
        });
      }
    });
    return () => controller.abort();
  }, [sessionName]);

  useEffect(() => {
    if (desktop) return;
    setOpenEditors([]);
    setActiveEditorKey(null);
    restoredWorkspaceRef.current = null;
    restoredSessionRef.current = null;
  }, [desktop]);

  useEffect(() => {
    if (
      activeEditorKey
      && openEditors.some((editor) => editor.key === activeEditorKey)
    ) return;
    setActiveEditorKey(openEditors.at(-1)?.key ?? null);
  }, [activeEditorKey, openEditors]);

  const saveNote = async (scope: NoteScope, identity: string, note: string) => {
    if (scope === "common") {
      const saved = await replaceCommonNote(note);
      setCommon({ identity: "common", note: saved, loading: false, error: null });
      return;
    }
    if (scope === "workspace") {
      const saved = await replaceWorkspaceNote(identity, note);
      if (workspaceId === identity) {
        setWorkspace({ identity, note: saved, loading: false, error: null });
      }
      return;
    }
    const saved = await replaceSessionNote(identity, note);
    if (sessionName === identity) {
      setSession({ identity, note: saved, loading: false, error: null });
    }
  };

  const currentWorkspace: NoteSnapshot = workspace.identity === workspaceId
    ? workspace
    : {
        identity: workspaceId,
        note: "",
        loading: Boolean(workspaceId),
        error: null,
      };
  const currentSession: NoteSnapshot = session.identity === sessionName
    ? session
    : { identity: sessionName, note: "", loading: true, error: null };

  const openEditor = useCallback((scope: NoteScope, restoreOnly = false) => {
    if (!desktop) return;
    const identity = scope === "common"
      ? "common"
      : scope === "workspace"
        ? workspaceId
        : sessionName;
    const snapshot = scope === "common"
      ? common
      : scope === "workspace"
        ? currentWorkspace
        : currentSession;
    if (!identity || snapshot.loading || snapshot.error) return;

    const legacyKey = noteEditorKey(scope, identity);
    const key = noteWindowKey(windowWorkspaceIdentity, scope, identity);
    const preference = readNoteWindowPreference(key, legacyKey);
    if (restoreOnly && !preference.open) return;
    const position = preferredFloatingNotePosition(scope, preference);
    writeNoteWindowPreference(key, {
      open: true,
      floating: true,
      pinned: preference.pinned,
      position,
    });
    const editor: OpenNoteEditor = {
      key,
      scope,
      identity,
      scopeName: scope === "common"
        ? "Every workspace"
        : scope === "workspace"
          ? workspaceName?.trim() || "This workspace"
          : sessionName,
      note: snapshot.note,
      pinned: preference.pinned,
      position,
      focusOnMount: !restoreOnly,
    };
    setOpenEditors((current) => (
      current.some((candidate) => candidate.key === key)
        ? current
        : [...current, editor]
    ));
    if (!restoreOnly) setActiveEditorKey(key);
  }, [
    common,
    currentSession,
    currentWorkspace,
    desktop,
    sessionName,
    windowWorkspaceIdentity,
    workspaceId,
    workspaceName,
  ]);

  useEffect(() => {
    if (!desktop) return;
    if (restoredWorkspaceRef.current === windowWorkspaceIdentity) return;
    if (common.loading || currentWorkspace.loading) return;
    restoredWorkspaceRef.current = windowWorkspaceIdentity;
    openEditor("common", true);
    openEditor("workspace", true);
  }, [
    common.loading,
    currentWorkspace.loading,
    desktop,
    openEditor,
    windowWorkspaceIdentity,
  ]);

  useEffect(() => {
    if (!desktop || currentSession.loading) return;
    const restoreKey = `${windowWorkspaceIdentity}:${sessionName}`;
    if (restoredSessionRef.current === restoreKey) return;
    restoredSessionRef.current = restoreKey;
    openEditor("session", true);
  }, [
    currentSession.loading,
    desktop,
    openEditor,
    sessionName,
    windowWorkspaceIdentity,
  ]);

  const editorForScope = (scope: NoteScope): OpenNoteEditor | undefined => {
    const identity = scope === "common"
      ? "common"
      : scope === "workspace"
        ? workspaceId
        : sessionName;
    if (!identity) return undefined;
    return openEditors.find((editor) => (
      editor.key === noteWindowKey(windowWorkspaceIdentity, scope, identity)
    ));
  };

  const bringEditorToFront = useCallback((key: string) => {
    setActiveEditorKey(key);
  }, []);

  const closeEditor = useCallback((editor: OpenNoteEditor) => {
    writeNoteWindowPreference(editor.key, {
      open: false,
      floating: true,
      pinned: false,
      position: editor.position,
    });
    setOpenEditors((current) => current.filter((candidate) => (
      candidate.key !== editor.key
    )));
  }, []);

  const commonEditor = editorForScope("common");
  const workspaceEditor = editorForScope("workspace");
  const sessionEditor = editorForScope("session");

  return (
    <>
      <section className="scoped-sticky-notes" aria-label="Sticky notes">
        <span className="scoped-sticky-notes-label" aria-hidden="true">NOTES</span>
        <StickyNoteCard
          scope="common"
          snapshot={common}
          open={Boolean(commonEditor)}
          pinned={commonEditor?.pinned ?? false}
          onToggle={() => commonEditor
            ? closeEditor(commonEditor)
            : openEditor("common")}
        />
        <StickyNoteCard
          scope="workspace"
          snapshot={currentWorkspace}
          disabledReason={workspaceId ? undefined : "Save workspace first"}
          open={Boolean(workspaceEditor)}
          pinned={workspaceEditor?.pinned ?? false}
          onToggle={() => workspaceEditor
            ? closeEditor(workspaceEditor)
            : openEditor("workspace")}
        />
        <StickyNoteCard
          scope="session"
          snapshot={currentSession}
          open={Boolean(sessionEditor)}
          pinned={sessionEditor?.pinned ?? false}
          onToggle={() => sessionEditor
            ? closeEditor(sessionEditor)
            : openEditor("session")}
        />
      </section>

      {desktop && openEditors.map((editor) => (
        <StickyNoteEditor
          key={editor.key}
          editorKey={editor.key}
          scope={editor.scope}
          scopeName={editor.scopeName}
          note={editor.note}
          pinned={editor.pinned}
          position={editor.position}
          focusOnMount={editor.focusOnMount}
          active={activeEditorKey === editor.key}
          onSave={(note) => saveNote(editor.scope, editor.identity, note)}
          onClose={() => closeEditor(editor)}
          onPinnedChange={(pinned) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned,
              position: editor.position,
            });
            setOpenEditors((current) => current.map((candidate) => (
              candidate.key === editor.key ? { ...candidate, pinned } : candidate
            )));
            bringEditorToFront(editor.key);
          }}
          onPositionChange={(position) => {
            setOpenEditors((current) => current.map((candidate) => (
              candidate.key === editor.key ? { ...candidate, position } : candidate
            )));
          }}
          onPositionCommit={(position) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned: editor.pinned,
              position,
            });
          }}
          onActivate={() => bringEditorToFront(editor.key)}
        />
      ))}
    </>
  );
}
