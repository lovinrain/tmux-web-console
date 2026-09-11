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
  getCommonNotebook,
  getSessionNotebook,
  getWorkspaceNotebook,
  replaceCommonNotebook,
  replaceSessionNotebook,
  replaceWorkspaceNotebook,
  type ScopedNoteNotebook,
  type ScopedNotePage,
} from "../api";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ListIcon,
  MemoIcon,
  PinIcon,
  PlusIcon,
  TrashIcon,
} from "../icons";

export const MAX_SCOPED_NOTE_PAGES = 128;
export const MAX_SCOPED_NOTE_PAGE_NAME_LENGTH = 80;
export const DEFAULT_SCOPED_NOTE_WINDOW_WIDTH = 430;
export const DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT = 430;
export const MIN_SCOPED_NOTE_WINDOW_WIDTH = 220;
export const MIN_SCOPED_NOTE_WINDOW_HEIGHT = 168;
const NOTE_AUTOSAVE_DELAY_MS = 650;
const NOTE_WINDOW_MARGIN = 12;
const NOTE_WINDOW_KEYBOARD_STEP = 12;
const NOTE_WINDOW_KEYBOARD_LARGE_STEP = 32;
const DESKTOP_SCOPED_NOTE_QUERY = "(min-width: 1025px), (min-width: 641px) and (min-height: 501px) and (pointer: fine)";
const LEGACY_SCOPED_NOTE_WINDOW_STORAGE_PREFIX = "muxdeck.scoped-note-window.v1:";
export const SCOPED_NOTE_WINDOW_STORAGE_PREFIX = "muxdeck.scoped-note-window.v2:";

type NoteScope = "common" | "workspace" | "session";
type SaveState = "saved" | "pending" | "saving" | "error";

interface FloatingNotePosition {
  x: number;
  y: number;
}

interface FloatingNoteSize {
  width: number;
  height: number;
}

interface NoteWindowPreference {
  open: boolean;
  floating: boolean;
  pinned: boolean;
  position: FloatingNotePosition | null;
  size: FloatingNoteSize | null;
  selectedPageId: string | null;
  sidebarOpen: boolean;
}

interface OpenNoteEditor {
  key: string;
  scope: NoteScope;
  identity: string;
  scopeName: string;
  notebook: ScopedNoteNotebook;
  pinned: boolean;
  position: FloatingNotePosition;
  size: FloatingNoteSize;
  focusOnMount: boolean;
  selectedPageId: string;
  sidebarOpen: boolean;
}

interface ScopedStickyNotesProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

interface NoteSnapshot {
  identity: string | null;
  notebook: ScopedNoteNotebook;
  loading: boolean;
  error: string | null;
}

interface StickyNoteEditorProps {
  editorKey: string;
  scope: NoteScope;
  scopeName: string;
  notebook: ScopedNoteNotebook;
  pinned: boolean;
  position: FloatingNotePosition;
  size: FloatingNoteSize;
  focusOnMount: boolean;
  active: boolean;
  selectedPageId: string;
  sidebarOpen: boolean;
  onSave: (notebook: ScopedNoteNotebook) => Promise<void>;
  onClose: () => void;
  onPinnedChange: (pinned: boolean) => void;
  onPositionChange: (position: FloatingNotePosition) => void;
  onPositionCommit: (position: FloatingNotePosition) => void;
  onSizeChange: (size: FloatingNoteSize) => void;
  onSizeCommit: (size: FloatingNoteSize) => void;
  onSelectedPageChange: (pageId: string) => void;
  onSidebarOpenChange: (open: boolean) => void;
  onActivate: () => void;
}

function emptyNotebook(): ScopedNoteNotebook {
  return { pages: [{ id: "main", name: "Page 1", content: "" }] };
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

function validFloatingNoteSize(value: unknown): value is FloatingNoteSize {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FloatingNoteSize>;
  return Number.isFinite(candidate.width)
    && Number.isFinite(candidate.height)
    && Number(candidate.width) > 0
    && Number(candidate.height) > 0;
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
      size: validFloatingNoteSize(candidate.size) ? candidate.size : null,
      selectedPageId: typeof candidate.selectedPageId === "string"
        && candidate.selectedPageId
        ? candidate.selectedPageId
        : null,
      sidebarOpen: candidate.sidebarOpen === true,
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
    size: null,
    selectedPageId: null,
    sidebarOpen: false,
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

function floatingNoteViewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function clampFloatingNoteSize(
  size: FloatingNoteSize,
  position?: FloatingNotePosition,
): FloatingNoteSize {
  const viewport = floatingNoteViewport();
  const maxWidth = Math.max(
    MIN_SCOPED_NOTE_WINDOW_WIDTH,
    viewport.width - (position?.x ?? NOTE_WINDOW_MARGIN) - NOTE_WINDOW_MARGIN,
  );
  const maxHeight = Math.max(
    MIN_SCOPED_NOTE_WINDOW_HEIGHT,
    viewport.height - (position?.y ?? NOTE_WINDOW_MARGIN) - NOTE_WINDOW_MARGIN,
  );
  return {
    width: Math.round(Math.min(
      maxWidth,
      Math.max(MIN_SCOPED_NOTE_WINDOW_WIDTH, size.width),
    )),
    height: Math.round(Math.min(
      maxHeight,
      Math.max(MIN_SCOPED_NOTE_WINDOW_HEIGHT, size.height),
    )),
  };
}

function preferredFloatingNoteSize(preference: NoteWindowPreference): FloatingNoteSize {
  return clampFloatingNoteSize(preference.size ?? {
    width: DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
    height: DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
  });
}

function defaultFloatingNotePosition(
  scope: NoteScope,
  size: FloatingNoteSize,
): FloatingNotePosition {
  const index = scope === "common" ? 0 : scope === "workspace" ? 1 : 2;
  return {
    x: Math.max(
      NOTE_WINDOW_MARGIN,
      floatingNoteViewport().width - size.width - 24 - index * 34,
    ),
    y: 92 + index * 54,
  };
}

function clampFloatingNotePosition(
  position: FloatingNotePosition,
  size?: FloatingNoteSize,
  element?: HTMLElement | null,
): FloatingNotePosition {
  const viewport = floatingNoteViewport();
  const rect = element?.getBoundingClientRect();
  const width = size?.width || rect?.width || DEFAULT_SCOPED_NOTE_WINDOW_WIDTH;
  const height = size?.height || rect?.height || DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT;
  return {
    x: Math.round(Math.min(
      Math.max(NOTE_WINDOW_MARGIN, position.x),
      Math.max(NOTE_WINDOW_MARGIN, viewport.width - width - NOTE_WINDOW_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(NOTE_WINDOW_MARGIN, position.y),
      Math.max(NOTE_WINDOW_MARGIN, viewport.height - height - NOTE_WINDOW_MARGIN),
    )),
  };
}

function preferredFloatingNotePosition(
  scope: NoteScope,
  preference: NoteWindowPreference,
  size: FloatingNoteSize,
): FloatingNotePosition {
  return clampFloatingNotePosition(
    preference.position ?? defaultFloatingNotePosition(scope, size),
    size,
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

function notebookHasContent(notebook: ScopedNoteNotebook): boolean {
  return notebook.pages.some((page) => Boolean(page.content.trim()));
}

function notebookPreview(notebook: ScopedNoteNotebook): string {
  const page = notebook.pages.find((candidate) => candidate.content.trim());
  const preview = page?.content.trim().replace(/\s+/g, " ") || "Add note";
  return notebook.pages.length > 1
    ? `${notebook.pages.length} pages - ${preview}`
    : preview;
}

function newPageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function notebookSignature(notebook: ScopedNoteNotebook): string {
  return JSON.stringify(notebook);
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
      : disabledReason || notebookPreview(snapshot.notebook);
  const disabled = snapshot.loading || Boolean(snapshot.error) || Boolean(disabledReason);
  const hasContent = notebookHasContent(snapshot.notebook);
  const hasNotebook = hasContent || snapshot.notebook.pages.length > 1;
  const windowState = pinned ? "PIN" : open ? "OPEN" : null;
  const actionLabel = open
    ? `Hide ${label.toLowerCase()} note`
    : `${hasNotebook ? "Edit" : "Add"} ${label.toLowerCase()} note`;

  return (
    <button
      type="button"
      className={[
        "scoped-sticky-note",
        scope,
        hasNotebook ? "has-note" : "empty",
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
        : `${label}: ${notebookPreview(snapshot.notebook)}`)}
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
  notebook,
  pinned,
  position,
  size,
  focusOnMount,
  active,
  selectedPageId,
  sidebarOpen,
  onSave,
  onClose,
  onPinnedChange,
  onPositionChange,
  onPositionCommit,
  onSizeChange,
  onSizeCommit,
  onSelectedPageChange,
  onSidebarOpenChange,
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
  const draftRef = useRef(notebook);
  const lastQueuedRef = useRef(notebookSignature(notebook));
  const failedValueRef = useRef<string | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const latestRequestRef = useRef<{
    signature: string;
    promise: Promise<boolean>;
  } | null>(null);
  const requestVersionRef = useRef(0);
  const queuedRequestCountRef = useRef(0);
  const autosaveTimerRef = useRef<number | null>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState(notebook);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const label = scope === "common" ? "Common" : scopeName;
  const selectedIndex = Math.max(
    0,
    draft.pages.findIndex((page) => page.id === selectedPageId),
  );
  const selectedPage = draft.pages[selectedIndex] ?? draft.pages[0];
  const pageNameRef = useRef(selectedPage.name);
  const [pageName, setPageName] = useState(selectedPage.name);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current === null) return;
    window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  const enqueueSave = useCallback((
    value: ScopedNoteNotebook,
    forceRetry = false,
  ): Promise<boolean> => {
    const signature = notebookSignature(value);
    const latestRequest = latestRequestRef.current;
    if (
      !forceRetry
      && signature === lastQueuedRef.current
      && failedValueRef.current !== signature
    ) {
      return latestRequest?.signature === signature
        ? latestRequest.promise
        : Promise.resolve(true);
    }

    const version = ++requestVersionRef.current;
    lastQueuedRef.current = signature;
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
        if (failedValueRef.current === signature) failedValueRef.current = null;
        if (mountedRef.current && version === requestVersionRef.current) {
          setSaveState(
            notebookSignature(draftRef.current) === signature ? "saved" : "pending",
          );
          setSaveError(null);
        }
        return true;
      },
      (error: unknown) => {
        queuedRequestCountRef.current -= 1;
        failedValueRef.current = signature;
        if (mountedRef.current && version === requestVersionRef.current) {
          setSaveState("error");
          setSaveError(errorMessage(error, "Unable to save this note."));
        }
        return false;
      },
    );
    latestRequestRef.current = { signature, promise: result };
    return result;
  }, []);

  const scheduleSave = useCallback((value: ScopedNoteNotebook) => {
    const signature = notebookSignature(value);
    clearAutosaveTimer();
    if (
      signature === lastQueuedRef.current
      && failedValueRef.current !== signature
    ) {
      setSaveState(queuedRequestCountRef.current > 0 ? "saving" : "saved");
      setSaveError(null);
      return;
    }
    setSaveState("pending");
    setSaveError(null);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void enqueueSave(value, failedValueRef.current === signature);
    }, NOTE_AUTOSAVE_DELAY_MS);
  }, [clearAutosaveTimer, enqueueSave]);

  const commitPageName = useCallback((): ScopedNoteNotebook => {
    const current = draftRef.current;
    const pageIndex = current.pages.findIndex((page) => page.id === selectedPageId);
    if (pageIndex < 0) return current;
    const existing = current.pages[pageIndex];
    const normalized = pageNameRef.current.trim() || existing.name;
    pageNameRef.current = normalized;
    setPageName(normalized);
    if (normalized === existing.name) return current;
    const next = {
      pages: current.pages.map((page, index) => (
        index === pageIndex ? { ...page, name: normalized } : page
      )),
    };
    draftRef.current = next;
    setDraft(next);
    scheduleSave(next);
    return next;
  }, [scheduleSave, selectedPageId]);

  const finish = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearAutosaveTimer();
    setClosing(true);
    const value = commitPageName();
    const signature = notebookSignature(value);
    const saved = await enqueueSave(value, failedValueRef.current === signature);
    if (!mountedRef.current) return;
    if (saved) {
      onClose();
      return;
    }
    closingRef.current = false;
    setClosing(false);
  }, [clearAutosaveTimer, commitPageName, enqueueSave, onClose]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAutosaveTimer();
      interactionCleanupRef.current?.();
      document.documentElement.classList.remove(
        "scoped-note-moving",
        "scoped-note-resizing",
      );
      const latestDraft = draftRef.current;
      const latestSignature = notebookSignature(latestDraft);
      if (
        latestSignature !== lastQueuedRef.current
        || failedValueRef.current === latestSignature
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
    const page = draftRef.current.pages.find(
      (candidate) => candidate.id === selectedPageId,
    ) ?? draftRef.current.pages[0];
    pageNameRef.current = page.name;
    setPageName(page.name);
  }, [selectedPageId]);

  useEffect(() => {
    const keepWindowVisible = () => {
      const next = clampFloatingNotePosition(position, undefined, formRef.current);
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
    interactionCleanupRef.current?.();

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
      if (interactionCleanupRef.current === cleanupDrag) {
        interactionCleanupRef.current = null;
      }
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      latestPosition = clampFloatingNotePosition({
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY,
      }, size, formRef.current);
      onPositionChange(latestPosition);
    };
    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanupDrag();
      onPositionCommit(latestPosition);
    };

    interactionCleanupRef.current = cleanupDrag;
    document.documentElement.classList.add("scoped-note-moving");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
  }, [onActivate, onPositionChange, onPositionCommit, position, size]);

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
    }, size, formRef.current);
    onActivate();
    onPositionChange(next);
    onPositionCommit(next);
  }, [onActivate, onPositionChange, onPositionCommit, position, size]);

  const commitSize = useCallback((candidate: FloatingNoteSize) => {
    const next = clampFloatingNoteSize(candidate, position);
    onActivate();
    onSizeChange(next);
    onSizeCommit(next);
  }, [onActivate, onSizeChange, onSizeCommit, position]);

  const startResizing = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate();
    interactionCleanupRef.current?.();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;
    let latestSize = size;

    const cleanupResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.documentElement.classList.remove("scoped-note-resizing");
      if (interactionCleanupRef.current === cleanupResize) {
        interactionCleanupRef.current = null;
      }
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      latestSize = clampFloatingNoteSize({
        width: startSize.width + moveEvent.clientX - startX,
        height: startSize.height + moveEvent.clientY - startY,
      }, position);
      onSizeChange(latestSize);
    };
    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanupResize();
      onSizeCommit(latestSize);
    };

    interactionCleanupRef.current = cleanupResize;
    document.documentElement.classList.add("scoped-note-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
  }, [onActivate, onSizeChange, onSizeCommit, position, size]);

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey
      ? NOTE_WINDOW_KEYBOARD_LARGE_STEP
      : NOTE_WINDOW_KEYBOARD_STEP;
    let next: FloatingNoteSize | null = null;
    if (event.key === "ArrowLeft") next = { ...size, width: size.width - step };
    if (event.key === "ArrowRight") next = { ...size, width: size.width + step };
    if (event.key === "ArrowUp") next = { ...size, height: size.height - step };
    if (event.key === "ArrowDown") next = { ...size, height: size.height + step };
    if (event.key === "Home") {
      next = {
        width: MIN_SCOPED_NOTE_WINDOW_WIDTH,
        height: MIN_SCOPED_NOTE_WINDOW_HEIGHT,
      };
    }
    if (event.key === "End") {
      next = { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
    }
    if (event.key === "Enter") {
      next = {
        width: DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
        height: DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
      };
    }
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    commitSize(next);
  }, [commitSize, size]);

  const selectPage = useCallback((pageId: string) => {
    const current = commitPageName();
    const page = current.pages.find((candidate) => candidate.id === pageId);
    if (!page || page.id === selectedPageId) return;
    pageNameRef.current = page.name;
    setPageName(page.name);
    onSelectedPageChange(page.id);
  }, [commitPageName, onSelectedPageChange, selectedPageId]);

  const addPage = useCallback(() => {
    const current = commitPageName();
    if (current.pages.length >= MAX_SCOPED_NOTE_PAGES) return;
    const existingIds = new Set(current.pages.map((page) => page.id));
    let id = newPageId();
    while (existingIds.has(id)) id = newPageId();
    const existingNames = new Set(current.pages.map((page) => page.name));
    let number = current.pages.length + 1;
    while (existingNames.has(`Page ${number}`)) number += 1;
    const page: ScopedNotePage = { id, name: `Page ${number}`, content: "" };
    const next = { pages: [...current.pages, page] };
    draftRef.current = next;
    setDraft(next);
    scheduleSave(next);
    pageNameRef.current = page.name;
    setPageName(page.name);
    onSelectedPageChange(page.id);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [commitPageName, onSelectedPageChange, scheduleSave]);

  const deleteSelectedPage = useCallback(() => {
    const current = commitPageName();
    if (current.pages.length <= 1) return;
    const pageIndex = current.pages.findIndex((page) => page.id === selectedPageId);
    if (pageIndex < 0) return;
    const page = current.pages[pageIndex];
    if (
      page.content.trim()
      && !window.confirm(`Delete note page "${page.name}" and all of its text?`)
    ) return;
    const pages = current.pages.filter((candidate) => candidate.id !== page.id);
    const nextPage = pages[Math.min(pageIndex, pages.length - 1)];
    const next = { pages };
    draftRef.current = next;
    setDraft(next);
    scheduleSave(next);
    pageNameRef.current = nextPage.name;
    setPageName(nextPage.name);
    onSelectedPageChange(nextPage.id);
  }, [commitPageName, onSelectedPageChange, scheduleSave, selectedPageId]);

  const updateSelectedPageContent = useCallback((content: string) => {
    const current = draftRef.current;
    const next = {
      pages: current.pages.map((page) => (
        page.id === selectedPageId ? { ...page, content } : page
      )),
    };
    draftRef.current = next;
    setDraft(next);
    scheduleSave(next);
  }, [scheduleSave, selectedPageId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void finish();
  };

  const editorStyle: CSSProperties = {
    left: position.x,
    top: position.y,
    width: size.width,
    height: size.height,
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
      <nav className="scoped-note-page-toolbar" aria-label="Note pages">
        <button
          type="button"
          className="scoped-note-page-control"
          aria-label="Previous note page"
          title="Previous page"
          disabled={selectedIndex === 0 || closing}
          onClick={() => selectPage(draft.pages[selectedIndex - 1]?.id)}
        >
          <ArrowLeftIcon />
        </button>
        <input
          className="scoped-note-page-name"
          value={pageName}
          maxLength={MAX_SCOPED_NOTE_PAGE_NAME_LENGTH}
          aria-label="Page name"
          title="Name this page"
          disabled={closing}
          onChange={(event) => {
            pageNameRef.current = event.target.value;
            setPageName(event.target.value);
          }}
          onBlur={() => commitPageName()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
        <span className="scoped-note-page-position" aria-label={`Page ${selectedIndex + 1} of ${draft.pages.length}`}>
          {selectedIndex + 1} / {draft.pages.length}
        </span>
        <button
          type="button"
          className="scoped-note-page-control"
          aria-label="Next note page"
          title="Next page"
          disabled={selectedIndex >= draft.pages.length - 1 || closing}
          onClick={() => selectPage(draft.pages[selectedIndex + 1]?.id)}
        >
          <ChevronRightIcon />
        </button>
        <button
          type="button"
          className="scoped-note-page-control"
          aria-label="Add note page"
          title="Add page"
          disabled={draft.pages.length >= MAX_SCOPED_NOTE_PAGES || closing}
          onClick={addPage}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="scoped-note-page-control"
          aria-label={`${sidebarOpen ? "Hide" : "Show"} page sidebar`}
          aria-pressed={sidebarOpen}
          title={`${sidebarOpen ? "Hide" : "Show"} page list`}
          disabled={closing}
          onClick={() => onSidebarOpenChange(!sidebarOpen)}
        >
          <ListIcon />
        </button>
        <button
          type="button"
          className="scoped-note-page-control danger"
          aria-label="Delete current note page"
          title={draft.pages.length === 1
            ? "A notebook must keep one page"
            : "Delete current page"}
          disabled={draft.pages.length === 1 || closing}
          onClick={deleteSelectedPage}
        >
          <TrashIcon />
        </button>
      </nav>

      <div className={`scoped-note-book ${sidebarOpen ? "sidebar-open" : ""}`}>
        {sidebarOpen && (
          <aside className="scoped-note-page-sidebar" aria-label="Notebook pages">
            <div className="scoped-note-page-sidebar-heading">
              <span>PAGES</span>
              <button
                type="button"
                aria-label="Add note page from sidebar"
                title="Add page"
                disabled={draft.pages.length >= MAX_SCOPED_NOTE_PAGES || closing}
                onClick={addPage}
              >
                <PlusIcon />
              </button>
            </div>
            <div className="scoped-note-page-list">
              {draft.pages.map((page, index) => (
                <button
                  key={page.id}
                  type="button"
                  className={page.id === selectedPage.id ? "active" : ""}
                  aria-current={page.id === selectedPage.id ? "page" : undefined}
                  onClick={() => selectPage(page.id)}
                  title={`${index + 1}. ${page.name}`}
                >
                  <span>{index + 1}</span>
                  <strong>{page.id === selectedPage.id ? pageName || page.name : page.name}</strong>
                  {page.content.trim() && <i aria-label="Has content" />}
                </button>
              ))}
            </div>
          </aside>
        )}
        <div className="scoped-note-page-canvas">
          <label className="scoped-note-textarea-label" htmlFor={textareaId}>
            Note
          </label>
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={selectedPage.content}
            placeholder="Pin a reminder, command, handoff, or next step..."
            onChange={(event) => updateSelectedPageContent(event.target.value)}
          />
        </div>
      </div>

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
        <span>{selectedPage.content.length.toLocaleString()} characters</span>
      </div>

      <div className="title-actions scoped-note-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!selectedPage.content || closing}
          onClick={() => {
            updateSelectedPageContent("");
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
      <button
        type="button"
        className="scoped-note-resize-handle"
        aria-label={`Resize ${scope} note window`}
        aria-description="Drag to resize in both directions. Arrow keys resize one dimension; Home minimizes and Enter resets."
        title="Drag to resize. Arrow keys resize; Home minimizes; Enter resets."
        onPointerDown={startResizing}
        onDoubleClick={() => commitSize({
          width: DEFAULT_SCOPED_NOTE_WINDOW_WIDTH,
          height: DEFAULT_SCOPED_NOTE_WINDOW_HEIGHT,
        })}
        onKeyDown={resizeWithKeyboard}
      >
        <span aria-hidden="true" />
      </button>
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
    notebook: emptyNotebook(),
    loading: true,
    error: null,
  });
  const [workspace, setWorkspace] = useState<NoteSnapshot>({
    identity: workspaceId,
    notebook: emptyNotebook(),
    loading: Boolean(workspaceId),
    error: null,
  });
  const [session, setSession] = useState<NoteSnapshot>({
    identity: sessionName,
    notebook: emptyNotebook(),
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
    void getCommonNotebook(controller.signal).then((notebook) => {
      if (!controller.signal.aborted) {
        setCommon({ identity: "common", notebook, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setCommon({
          identity: "common",
          notebook: emptyNotebook(),
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
      notebook: emptyNotebook(),
      loading: Boolean(workspaceId),
      error: null,
    });
    if (!workspaceId) return;
    const controller = new AbortController();
    void getWorkspaceNotebook(workspaceId, controller.signal).then((notebook) => {
      if (!controller.signal.aborted) {
        setWorkspace({ identity: workspaceId, notebook, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setWorkspace({
          identity: workspaceId,
          notebook: emptyNotebook(),
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
        size: editor.size,
        selectedPageId: editor.selectedPageId,
        sidebarOpen: editor.sidebarOpen,
      });
      return false;
    }));
    previousSessionNameRef.current = sessionName;
  }, [sessionName, workspaceId]);

  useEffect(() => {
    setSession({
      identity: sessionName,
      notebook: emptyNotebook(),
      loading: true,
      error: null,
    });
    const controller = new AbortController();
    void getSessionNotebook(sessionName, controller.signal).then((notebook) => {
      if (!controller.signal.aborted) {
        setSession({ identity: sessionName, notebook, loading: false, error: null });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setSession({
          identity: sessionName,
          notebook: emptyNotebook(),
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

  const saveNote = async (
    scope: NoteScope,
    identity: string,
    notebook: ScopedNoteNotebook,
  ) => {
    if (scope === "common") {
      const saved = await replaceCommonNotebook(notebook);
      setCommon({ identity: "common", notebook: saved, loading: false, error: null });
      return;
    }
    if (scope === "workspace") {
      const saved = await replaceWorkspaceNotebook(identity, notebook);
      if (workspaceId === identity) {
        setWorkspace({ identity, notebook: saved, loading: false, error: null });
      }
      return;
    }
    const saved = await replaceSessionNotebook(identity, notebook);
    if (sessionName === identity) {
      setSession({ identity, notebook: saved, loading: false, error: null });
    }
  };

  const currentWorkspace: NoteSnapshot = workspace.identity === workspaceId
    ? workspace
    : {
        identity: workspaceId,
        notebook: emptyNotebook(),
        loading: Boolean(workspaceId),
        error: null,
      };
  const currentSession: NoteSnapshot = session.identity === sessionName
    ? session
    : {
        identity: sessionName,
        notebook: emptyNotebook(),
        loading: true,
        error: null,
      };

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
    const size = preferredFloatingNoteSize(preference);
    const position = preferredFloatingNotePosition(scope, preference, size);
    const selectedPageId = snapshot.notebook.pages.some(
      (page) => page.id === preference.selectedPageId,
    )
      ? preference.selectedPageId!
      : snapshot.notebook.pages[0].id;
    writeNoteWindowPreference(key, {
      open: true,
      floating: true,
      pinned: preference.pinned,
      position,
      size,
      selectedPageId,
      sidebarOpen: preference.sidebarOpen,
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
      notebook: snapshot.notebook,
      pinned: preference.pinned,
      position,
      size,
      focusOnMount: !restoreOnly,
      selectedPageId,
      sidebarOpen: preference.sidebarOpen,
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
      size: editor.size,
      selectedPageId: editor.selectedPageId,
      sidebarOpen: editor.sidebarOpen,
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
          notebook={editor.notebook}
          pinned={editor.pinned}
          position={editor.position}
          size={editor.size}
          focusOnMount={editor.focusOnMount}
          active={activeEditorKey === editor.key}
          selectedPageId={editor.selectedPageId}
          sidebarOpen={editor.sidebarOpen}
          onSave={(notebook) => saveNote(editor.scope, editor.identity, notebook)}
          onClose={() => closeEditor(editor)}
          onPinnedChange={(pinned) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned,
              position: editor.position,
              size: editor.size,
              selectedPageId: editor.selectedPageId,
              sidebarOpen: editor.sidebarOpen,
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
              size: editor.size,
              selectedPageId: editor.selectedPageId,
              sidebarOpen: editor.sidebarOpen,
            });
          }}
          onSizeChange={(size) => {
            setOpenEditors((current) => current.map((candidate) => (
              candidate.key === editor.key ? { ...candidate, size } : candidate
            )));
          }}
          onSizeCommit={(size) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned: editor.pinned,
              position: editor.position,
              size,
              selectedPageId: editor.selectedPageId,
              sidebarOpen: editor.sidebarOpen,
            });
          }}
          onSelectedPageChange={(selectedPageId) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned: editor.pinned,
              position: editor.position,
              size: editor.size,
              selectedPageId,
              sidebarOpen: editor.sidebarOpen,
            });
            setOpenEditors((current) => current.map((candidate) => (
              candidate.key === editor.key
                ? { ...candidate, selectedPageId }
                : candidate
            )));
          }}
          onSidebarOpenChange={(sidebarOpen) => {
            writeNoteWindowPreference(editor.key, {
              open: true,
              floating: true,
              pinned: editor.pinned,
              position: editor.position,
              size: editor.size,
              selectedPageId: editor.selectedPageId,
              sidebarOpen,
            });
            setOpenEditors((current) => current.map((candidate) => (
              candidate.key === editor.key ? { ...candidate, sidebarOpen } : candidate
            )));
            bringEditorToFront(editor.key);
          }}
          onActivate={() => bringEditorToFront(editor.key)}
        />
      ))}
    </>
  );
}
