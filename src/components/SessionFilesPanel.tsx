import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ApiRequestError,
  copySessionFileEntry,
  createSessionFileEntry,
  deleteSessionFileEntry,
  downloadSessionFileEntries,
  listSessionFiles,
  moveSessionFileEntry,
  previewSessionFile,
  resolveSessionFilePath,
  saveSessionFileContent,
  searchSessionFiles,
  sessionFileDownloadUrl,
  sessionFileImageUrl,
  sessionFilePdfUrl,
  uploadSessionFile,
  type SessionDirectoryListing,
  type SessionFileEntry,
  type SessionFilePreview,
  type SessionFileSearchResults,
  type SessionFileTarget,
} from "../api";
import {
  MAX_ATTACHMENT_UPLOAD_BATCH,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  transferHasFiles,
} from "../attachments";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  EditIcon,
  ExternalLinkIcon,
  FolderIcon,
  HistoryIcon,
  ImageIcon,
  MoveIcon,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  WindowCopyIcon,
} from "../icons";
import "./SessionFilesPanel.css";

const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

const PANEL_MARGIN = 12;
const PANEL_DEFAULT_WIDTH = 760;
const PANEL_DEFAULT_HEIGHT = 560;
const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 260;
const PANEL_KEY_STEP = 16;
const PANEL_KEY_LARGE_STEP = 48;
const PANEL_RESIZE_STEP = 12;
const PANEL_RESIZE_LARGE_STEP = 36;
const PANEL_DEFAULT_SPLIT = 0.4;
const PANEL_MIN_SPLIT = 0.18;
const PANEL_MAX_SPLIT = 0.82;
const PANEL_SPLIT_STEP = 0.02;
const PANEL_SPLIT_LARGE_STEP = 0.08;
const INTERNAL_DRAG_TYPE = "application/x-muxdeck-file-path";
const SESSION_FILE_RECENT_LIMIT = 32;
const SESSION_FILE_RECENT_BUCKET_LIMIT = 48;
const SESSION_FILE_RECENT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/i;

export const SESSION_FILES_LAYOUT_STORAGE_KEY = "muxdeck.session-files-layout.v1";
export const SESSION_FILES_RECENTS_STORAGE_KEY = "muxdeck.session-files-recents.v1";

interface PanelPosition {
  x: number;
  y: number;
}

interface PanelSize {
  width: number;
  height: number;
}

interface PanelLayout {
  size: PanelSize;
  split: number;
}

interface PanelDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: PanelPosition;
}

type PanelResizeDirection = "bottom-right" | "left" | "bottom-left";

interface PanelResizeDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: PanelPosition;
  startSize: PanelSize;
  direction: PanelResizeDirection;
}

interface PanelSplitDrag {
  pointerId: number;
  startClientX: number;
  startSplit: number;
  contentWidth: number;
}

interface PathTarget {
  absolutePath: string;
  terminalText: string;
}

type SessionFileRecentKind = "file" | "directory";

interface SessionFileRecentEntry {
  kind: SessionFileRecentKind;
  absolutePath: string;
  name: string;
  visitedAt: number;
}

interface SessionFileRecentBucket {
  sessionName: string;
  updatedAt: number;
  entries: SessionFileRecentEntry[];
}

interface SessionFileRecentStore {
  version: 1;
  sessions: Record<string, SessionFileRecentBucket>;
}

type TaskStatus = "queued" | "running" | "done" | "error";
type ImagePreviewStatus = "loading" | "ready" | "error";
type SortKey = "name" | "size" | "modified";
type SortDirection = "asc" | "desc";
type PromptMode =
  | "create-directory"
  | "create-file"
  | "rename"
  | "duplicate"
  | "move"
  | "bulk-move";

interface TaskItem {
  id: string;
  name: string;
  status: TaskStatus;
  message: string;
  uploadedEntry?: SessionFileEntry;
}

interface TaskHeadings {
  active: string;
  done: string;
}

interface PromptState {
  mode: PromptMode;
  entries: SessionFileEntry[];
  value: string;
  error: string | null;
}

interface ConfirmState {
  entries: SessionFileEntry[];
  recursive: boolean;
  message: string;
}

export interface SessionFileOpenRequest {
  id: number;
  path: string;
}

interface SessionFilesPanelProps {
  sessionName: string;
  sessionId: string;
  paneId: string;
  panePath: string;
  openPathRequest?: SessionFileOpenRequest | null;
  onClose: () => void;
  onInsertPath: (terminalText: string) => boolean;
}

function viewportSize(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function clampPanelSize(size: PanelSize): PanelSize {
  const viewport = viewportSize();
  const maxWidth = Math.max(1, viewport.width - PANEL_MARGIN * 2);
  const maxHeight = Math.max(1, viewport.height - PANEL_MARGIN * 2);
  const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
  return {
    width: Math.round(Math.min(Math.max(minWidth, size.width), maxWidth)),
    height: Math.round(Math.min(Math.max(minHeight, size.height), maxHeight)),
  };
}

function clampSplit(split: number): number {
  return Math.min(PANEL_MAX_SPLIT, Math.max(PANEL_MIN_SPLIT, split));
}

function defaultPanelLayout(): PanelLayout {
  return {
    size: clampPanelSize({
      width: PANEL_DEFAULT_WIDTH,
      height: PANEL_DEFAULT_HEIGHT,
    }),
    split: PANEL_DEFAULT_SPLIT,
  };
}

function readPanelLayout(): PanelLayout {
  const fallback = defaultPanelLayout();
  try {
    const raw = window.localStorage.getItem(SESSION_FILES_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<PanelLayout>;
    const width = saved.size?.width;
    const height = saved.size?.height;
    const split = saved.split;
    return {
      size: typeof width === "number" && Number.isFinite(width)
        && typeof height === "number" && Number.isFinite(height)
        ? clampPanelSize({ width, height })
        : fallback.size,
      split: typeof split === "number" && Number.isFinite(split)
        ? clampSplit(split)
        : fallback.split,
    };
  } catch {
    return fallback;
  }
}

function writePanelLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(
      SESSION_FILES_LAYOUT_STORAGE_KEY,
      JSON.stringify(layout),
    );
  } catch {
    // Resizing remains available when browser storage is disabled.
  }
}

function emptyRecentStore(): SessionFileRecentStore {
  return { version: 1, sessions: {} };
}

function validRecentEntry(value: unknown): value is SessionFileRecentEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionFileRecentEntry>;
  return (candidate.kind === "file" || candidate.kind === "directory")
    && typeof candidate.absolutePath === "string"
    && candidate.absolutePath.startsWith("/")
    && candidate.absolutePath.length <= 4_096
    && typeof candidate.name === "string"
    && candidate.name.length > 0
    && candidate.name.length <= 512
    && typeof candidate.visitedAt === "number"
    && Number.isFinite(candidate.visitedAt)
    && candidate.visitedAt > 0;
}

function readRecentStore(): SessionFileRecentStore {
  try {
    const raw = window.localStorage.getItem(SESSION_FILES_RECENTS_STORAGE_KEY);
    if (!raw) return emptyRecentStore();
    const parsed = JSON.parse(raw) as Partial<SessionFileRecentStore>;
    if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      return emptyRecentStore();
    }
    const sessions: Record<string, SessionFileRecentBucket> = {};
    for (const [sessionId, rawBucket] of Object.entries(parsed.sessions)) {
      if (!rawBucket || typeof rawBucket !== "object") continue;
      const bucket = rawBucket as Partial<SessionFileRecentBucket>;
      if (
        typeof bucket.sessionName !== "string"
        || typeof bucket.updatedAt !== "number"
        || !Number.isFinite(bucket.updatedAt)
        || !Array.isArray(bucket.entries)
      ) continue;
      sessions[sessionId] = {
        sessionName: bucket.sessionName,
        updatedAt: bucket.updatedAt,
        entries: bucket.entries.filter(validRecentEntry).slice(0, SESSION_FILE_RECENT_LIMIT),
      };
    }
    return { version: 1, sessions };
  } catch {
    return emptyRecentStore();
  }
}

function readSessionFileRecents(sessionId: string): SessionFileRecentEntry[] {
  return readRecentStore().sessions[sessionId]?.entries ?? [];
}

function writeSessionFileRecents(
  sessionId: string,
  sessionName: string,
  entries: SessionFileRecentEntry[],
): void {
  try {
    const now = Date.now();
    const store = readRecentStore();
    if (entries.length > 0) {
      store.sessions[sessionId] = {
        sessionName,
        updatedAt: now,
        entries: entries.slice(0, SESSION_FILE_RECENT_LIMIT),
      };
    } else {
      delete store.sessions[sessionId];
    }
    const retained = Object.entries(store.sessions)
      .filter(([, bucket]) => now - bucket.updatedAt <= SESSION_FILE_RECENT_MAX_AGE_MS)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, SESSION_FILE_RECENT_BUCKET_LIMIT);
    window.localStorage.setItem(
      SESSION_FILES_RECENTS_STORAGE_KEY,
      JSON.stringify({ version: 1, sessions: Object.fromEntries(retained) }),
    );
  } catch {
    // Recents still work for this open panel when browser storage is blocked.
  }
}

function defaultPosition(size: PanelSize): PanelPosition {
  const viewport = viewportSize();
  return {
    x: Math.max(PANEL_MARGIN, viewport.width - size.width - 24),
    y: Math.max(PANEL_MARGIN, Math.min(84, viewport.height - PANEL_MARGIN)),
  };
}

function clampPositionForSize(
  position: PanelPosition,
  size: PanelSize,
): PanelPosition {
  const viewport = viewportSize();
  return {
    x: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.x),
      Math.max(PANEL_MARGIN, viewport.width - size.width - PANEL_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.y),
      Math.max(PANEL_MARGIN, viewport.height - size.height - PANEL_MARGIN),
    )),
  };
}

function clampPosition(
  position: PanelPosition,
  panel?: HTMLElement | null,
): PanelPosition {
  const viewport = viewportSize();
  const rect = panel?.getBoundingClientRect();
  const width = Math.min(rect?.width || PANEL_DEFAULT_WIDTH, viewport.width - 2 * PANEL_MARGIN);
  const height = Math.min(rect?.height || PANEL_DEFAULT_HEIGHT, viewport.height - 2 * PANEL_MARGIN);
  return clampPositionForSize(position, { width, height });
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinPath(directory: string, name: string): string {
  const trimmed = directory.split("/").filter(Boolean).join("/");
  return trimmed ? `${trimmed}/${name}` : name;
}

function duplicateName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0) return `${name.slice(0, dotIndex)} copy${name.slice(dotIndex)}`;
  return `${name} copy`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "--";
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1_024; index += 1) {
    amount /= 1_024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatModified(value: number | null): string {
  if (value === null) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

function fileNameBadge(name: string): string {
  const extension = name.includes(".")
    ? name.split(".").pop()?.slice(0, 4).toUpperCase()
    : "FILE";
  return extension || "FILE";
}

function fileBadge(entry: SessionFileEntry): string {
  if (entry.kind === "other") return entry.symlink ? "LINK" : "OTHER";
  return fileNameBadge(entry.name);
}

function formatRecentAge(visitedAt: number): string {
  const elapsed = Math.max(0, Date.now() - visitedAt);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  if (elapsed < 7 * 24 * 60 * 60_000) {
    return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(visitedAt));
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isNotEmptyError(error: unknown): boolean {
  return error instanceof ApiRequestError
    && error.status === 409
    && /not empty/i.test(error.message);
}

function describeEntries(entries: SessionFileEntry[]): string {
  if (entries.length === 1) return entries[0].name;
  return `${entries.length} items`;
}

function pathRelativeToPaneCwd(
  absolutePath: string,
  panePath: string,
): { text: string; relative: boolean } {
  const cwd = panePath.replace(/\/+$/, "") || "/";
  if (!absolutePath.startsWith("/") || !cwd.startsWith("/")) {
    return { text: absolutePath, relative: false };
  }
  if (absolutePath === cwd) return { text: ".", relative: true };

  const cwdPrefix = cwd === "/" ? "/" : `${cwd}/`;
  if (!absolutePath.startsWith(cwdPrefix)) {
    return { text: absolutePath, relative: false };
  }
  return { text: absolutePath.slice(cwdPrefix.length), relative: true };
}

async function copyPath(text: string): Promise<boolean> {
  // The async clipboard needs a secure context, which a console reached over
  // plain HTTP on a LAN or tunnel does not have. Report that rather than
  // throwing, so the caller can offer the path instead of an error.
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SessionFilesPanel({
  sessionName,
  sessionId,
  paneId,
  panePath,
  openPathRequest = null,
  onClose,
  onInsertPath,
}: SessionFilesPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PanelDrag | null>(null);
  const resizeRef = useRef<PanelResizeDrag | null>(null);
  const splitRef = useRef<PanelSplitDrag | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const locatorInputRef = useRef<HTMLInputElement>(null);
  const manualCopyRef = useRef<HTMLInputElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const layerTriggerRef = useRef<HTMLElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const archiveAbortRef = useRef<AbortController | null>(null);
  const addressAbortRef = useRef<AbortController | null>(null);
  const listingAbortRef = useRef<AbortController | null>(null);
  const locatorAbortRef = useRef<AbortController | null>(null);
  const locatorResultRefs = useRef(new Map<string, HTMLButtonElement>());
  const handledOpenPathRequestRef = useRef<number | null>(null);
  const recentEntriesRef = useRef<SessionFileRecentEntry[]>([]);
  const fileDragDepthRef = useRef(0);
  const pendingSelectionPathRef = useRef<string | null>(null);
  const directSelectionEntryRef = useRef<SessionFileEntry | null>(null);
  const internalDragRef = useRef<SessionFileEntry | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const identityRef = useRef("");
  const [panelLayout, setPanelLayout] = useState(readPanelLayout);
  const [position, setPosition] = useState(
    () => defaultPosition(panelLayout.size),
  );
  // Absolute directory the relative paths below are resolved against. It
  // starts at the pane's own working directory and can be pointed anywhere the
  // server's configured boundary still contains.
  const [browseRoot, setBrowseRoot] = useState(panePath);
  const [addressValue, setAddressValue] = useState(panePath);
  const [addressEdited, setAddressEdited] = useState(false);
  const [addressResolving, setAddressResolving] = useState(false);
  const [manualCopyPath, setManualCopyPath] = useState<string | null>(null);
  const [directoryPath, setDirectoryPath] = useState("");
  const [listing, setListing] = useState<SessionDirectoryListing | null>(null);
  const [listingLoading, setListingLoading] = useState(true);
  const [listingError, setListingError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionFileEntry | null>(null);
  const [preview, setPreview] = useState<SessionFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [markdownRendered, setMarkdownRendered] = useState(false);
  const [imagePreviewStatus, setImagePreviewStatus] = useState<ImagePreviewStatus>("loading");
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [locatorOpen, setLocatorOpen] = useState(false);
  const [locatorQuery, setLocatorQuery] = useState("");
  const [locatorResults, setLocatorResults] = useState<SessionFileSearchResults | null>(null);
  const [locatorLoading, setLocatorLoading] = useState(false);
  const [locatorError, setLocatorError] = useState<string | null>(null);
  const [locatorHighlightedPath, setLocatorHighlightedPath] = useState<string | null>(null);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [recentEntries, setRecentEntries] = useState<SessionFileRecentEntry[]>(
    () => readSessionFileRecents(sessionId),
  );
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [taskItems, setTaskItems] = useState<TaskItem[]>([]);
  const [taskHeadings, setTaskHeadings] = useState<TaskHeadings>({
    active: "UPLOADING",
    done: "UPLOAD RESULTS",
  });
  const [uploading, setUploading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [working, setWorking] = useState(false);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [dropFolderPath, setDropFolderPath] = useState<string | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [editing, setEditing] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  // The text the buffer started from, and the modification time the save must
  // be checked against. Both are pinned when editing begins: adopting a newer
  // timestamp under an untouched buffer would let a save overwrite whoever
  // wrote the file in between, which is exactly what the check exists to stop.
  const [editorOrigin, setEditorOrigin] = useState("");
  const [editorBaseline, setEditorBaseline] = useState<number | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const identity = `${sessionName}\u0000${sessionId}\u0000${paneId}\u0000${panePath}`;

  // Sending no root at all keeps the default view working against a backend
  // that predates this field.
  const fileTarget = useMemo<SessionFileTarget>(() => ({
    session: sessionName,
    sessionId,
    paneId,
    ...(browseRoot === panePath ? {} : { root: browseRoot }),
  }), [browseRoot, paneId, panePath, sessionId, sessionName]);

  const busy = uploading || archiving || working || addressResolving;
  const editorDirty = editing && editorValue !== editorOrigin;

  const keepVisible = useCallback(() => {
    setPosition((current) => clampPosition(current, panelRef.current));
  }, []);

  useEffect(() => {
    writePanelLayout(panelLayout);
  }, [panelLayout]);

  // The panel is a portal at the end of <body>, so leaving focus on <body>
  // after a layer closes restarts tabbing at the top of the document.
  const openLayerFrom = useCallback(() => {
    const active = document.activeElement;
    layerTriggerRef.current = active instanceof HTMLElement ? active : null;
  }, []);

  const restoreLayerFocus = useCallback(() => {
    const trigger = layerTriggerRef.current;
    layerTriggerRef.current = null;
    if (!trigger) return;
    // The listing may still be re-rendering, so the row is looked up again on
    // the next frame and skipped if the refresh replaced it.
    requestAnimationFrame(() => {
      if (document.contains(trigger)) trigger.focus();
    });
  }, []);

  const closePrompt = useCallback(() => {
    setPrompt(null);
    restoreLayerFocus();
  }, [restoreLayerFocus]);

  const closeConfirm = useCallback(() => {
    setConfirm(null);
    restoreLayerFocus();
  }, [restoreLayerFocus]);

  const closeLocator = useCallback(() => {
    locatorAbortRef.current?.abort();
    locatorAbortRef.current = null;
    setLocatorOpen(false);
    setLocatorLoading(false);
    setLocatorError(null);
    setLocatorResults(null);
    setLocatorHighlightedPath(null);
  }, []);

  const closeRecents = useCallback(() => {
    setRecentsOpen(false);
  }, []);

  const rememberRecentPath = useCallback((entry: SessionFileRecentEntry) => {
    const persisted = readSessionFileRecents(sessionId);
    const combined = [entry, ...persisted, ...recentEntriesRef.current];
    const seen = new Set<string>();
    const next = combined.filter((candidate) => {
      if (seen.has(candidate.absolutePath)) return false;
      seen.add(candidate.absolutePath);
      return true;
    }).slice(0, SESSION_FILE_RECENT_LIMIT);
    recentEntriesRef.current = next;
    setRecentEntries(next);
    writeSessionFileRecents(sessionId, sessionName, next);
  }, [sessionId, sessionName]);

  const forgetRecentPath = useCallback((absolutePath: string) => {
    const next = recentEntriesRef.current.filter(
      (entry) => entry.absolutePath !== absolutePath,
    );
    recentEntriesRef.current = next;
    setRecentEntries(next);
    writeSessionFileRecents(sessionId, sessionName, next);
  }, [sessionId, sessionName]);

  const clearRecentPaths = useCallback(() => {
    recentEntriesRef.current = [];
    setRecentEntries([]);
    writeSessionFileRecents(sessionId, sessionName, []);
    setActionStatus("Recent paths cleared for this session");
  }, [sessionId, sessionName]);

  useEffect(() => {
    identityRef.current = identity;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    archiveAbortRef.current?.abort();
    archiveAbortRef.current = null;
    addressAbortRef.current?.abort();
    addressAbortRef.current = null;
    listingAbortRef.current?.abort();
    listingAbortRef.current = null;
    locatorAbortRef.current?.abort();
    locatorAbortRef.current = null;
    fileDragDepthRef.current = 0;
    pendingSelectionPathRef.current = null;
    directSelectionEntryRef.current = null;
    internalDragRef.current = null;
    setBrowseRoot(panePath);
    setAddressValue(panePath);
    setAddressEdited(false);
    setAddressResolving(false);
    setDirectoryPath("");
    setListing(null);
    setSelected(null);
    setPreview(null);
    setMarkdownRendered(false);
    setListingError(null);
    setPreviewError(null);
    setFilter("");
    setLocatorOpen(false);
    setLocatorQuery("");
    setLocatorResults(null);
    setLocatorLoading(false);
    setLocatorError(null);
    setLocatorHighlightedPath(null);
    setRecentsOpen(false);
    const storedRecents = readSessionFileRecents(sessionId);
    recentEntriesRef.current = storedRecents;
    setRecentEntries(storedRecents);
    setActionStatus(null);
    setTaskItems([]);
    setUploading(false);
    setArchiving(false);
    setWorking(false);
    setFileDropActive(false);
    setPrompt(null);
    setConfirm(null);
    setCheckedPaths([]);
    setEditing(false);
    setEditorError(null);
    setDropFolderPath(null);
    setManualCopyPath(null);
    handledOpenPathRequestRef.current = null;
  }, [identity, panePath, sessionId]);

  useEffect(() => {
    const syncRecents = (event: StorageEvent) => {
      if (event.key !== SESSION_FILES_RECENTS_STORAGE_KEY) return;
      const storedRecents = readSessionFileRecents(sessionId);
      recentEntriesRef.current = storedRecents;
      setRecentEntries(storedRecents);
    };
    window.addEventListener("storage", syncRecents);
    return () => window.removeEventListener("storage", syncRecents);
  }, [sessionId]);

  useEffect(() => () => {
    uploadAbortRef.current?.abort();
    archiveAbortRef.current?.abort();
    addressAbortRef.current?.abort();
    listingAbortRef.current?.abort();
    locatorAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listingAbortRef.current?.abort();
    listingAbortRef.current = controller;
    setListingLoading(true);
    setListingError(null);
    void listSessionFiles(
      fileTarget,
      directoryPath,
      controller.signal,
    ).then((nextListing) => {
      if (controller.signal.aborted) return;
      setListing(nextListing);
      rememberRecentPath({
        kind: "directory",
        absolutePath: nextListing.absolutePath,
        name: nextListing.absolutePath.split("/").filter(Boolean).pop() ?? "/",
        visitedAt: Date.now(),
      });
      setDirectoryPath(nextListing.path);
      // The server resolves "~" and symlinks, so the browser adopts the path it
      // actually landed on rather than the one that was typed.
      setBrowseRoot(nextListing.root);
      const available = new Map(
        nextListing.entries.map((item) => [item.path, item] as const),
      );
      setCheckedPaths((current) => current.filter((path) => available.has(path)));
      const pendingPath = pendingSelectionPathRef.current;
      pendingSelectionPathRef.current = null;
      const directEntry = directSelectionEntryRef.current;
      // Keeping the previous selection across a refresh avoids blanking an open
      // preview; an entry that no longer exists here is dropped instead.
      setSelected((current) => {
        const wantedPath = pendingPath ?? current?.path ?? null;
        if (!wantedPath) return null;
        const listedMatch = available.get(wantedPath);
        const match = listedMatch
          ?? (directEntry?.path === wantedPath ? directEntry : undefined);
        if (listedMatch && directEntry?.path === wantedPath) {
          directSelectionEntryRef.current = listedMatch;
        }
        return match && match.kind === "file" ? match : null;
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setListing(null);
      setSelected((current) => {
        const directEntry = directSelectionEntryRef.current;
        return directEntry && directEntry.path === current?.path ? directEntry : null;
      });
      setListingError(errorMessage(error, "Unable to list this directory"));
    }).finally(() => {
      if (!controller.signal.aborted) setListingLoading(false);
      if (listingAbortRef.current === controller) listingAbortRef.current = null;
    });
    return () => {
      controller.abort();
      if (listingAbortRef.current === controller) listingAbortRef.current = null;
    };
  }, [directoryPath, fileTarget, refreshToken, rememberRecentPath]);

  // Keyed on the path and the refresh token rather than the entry object, so a
  // reloaded listing that hands back an identical object still refetches.
  const previewPath = selected && selected.kind === "file" && selected.accessible
    ? selected.path
    : null;

  useEffect(() => {
    if (!previewPath) {
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError(null);
    void previewSessionFile(
      fileTarget,
      previewPath,
      controller.signal,
    ).then((nextPreview) => {
      if (controller.signal.aborted) return;
      setPreview(nextPreview);
      rememberRecentPath({
        kind: "file",
        absolutePath: nextPreview.absolutePath,
        name: nextPreview.name,
        visitedAt: Date.now(),
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setPreviewError(errorMessage(error, "Unable to preview this file"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false);
    });
    return () => controller.abort();
  }, [fileTarget, previewPath, refreshToken, rememberRecentPath]);

  useEffect(() => {
    selectedPathRef.current = selected?.path ?? null;
  }, [selected]);

  useEffect(() => {
    setImagePreviewStatus("loading");
  }, [preview?.kind, preview?.path]);

  useEffect(() => {
    setEditing(false);
    setEditorError(null);
    setMarkdownRendered(false);
  }, [previewPath]);

  useEffect(() => {
    // A reload under an untouched buffer adopts the new content and timestamp;
    // an edited buffer keeps both, so saving it conflicts rather than clobbers.
    if (!editing || !preview || editorValue !== editorOrigin) return;
    const reloaded = preview.content ?? "";
    if (reloaded === editorOrigin && preview.modified === editorBaseline) return;
    setEditorValue(reloaded);
    setEditorOrigin(reloaded);
    setEditorBaseline(preview.modified);
  }, [editing, editorBaseline, editorOrigin, editorValue, preview]);

  useEffect(() => {
    if (prompt) promptInputRef.current?.focus();
  }, [prompt?.mode, prompt?.entries]);

  useEffect(() => {
    if (!locatorOpen) return;
    requestAnimationFrame(() => {
      locatorInputRef.current?.focus();
      locatorInputRef.current?.select();
    });
  }, [locatorOpen]);

  useEffect(() => {
    if (!locatorOpen) return;
    locatorAbortRef.current?.abort();
    locatorAbortRef.current = null;
    setLocatorLoading(false);
    setLocatorResults(null);
    setLocatorError(null);
    setLocatorHighlightedPath(null);
  }, [locatorOpen, showHidden]);

  useEffect(() => {
    if (!locatorHighlightedPath) return;
    locatorResultRefs.current.get(locatorHighlightedPath)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [locatorHighlightedPath]);

  // Focus lands on Cancel, never on the destructive button, and moves again
  // when a non-empty folder escalates the confirmation to a recursive delete.
  useEffect(() => {
    if (confirm) confirmCancelRef.current?.focus();
  }, [confirm?.entries, confirm?.recursive]);

  useEffect(() => {
    if (!manualCopyPath) return;
    const field = manualCopyRef.current;
    field?.focus();
    field?.select();
  }, [manualCopyPath]);

  useEffect(() => {
    const panel = panelRef.current;
    const observer = panel && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(keepVisible)
      : null;
    if (panel) observer?.observe(panel);
    window.addEventListener("resize", keepVisible);
    window.visualViewport?.addEventListener("resize", keepVisible);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", keepVisible);
      window.visualViewport?.removeEventListener("resize", keepVisible);
      document.documentElement.classList.remove(
        "session-files-panel-moving",
        "session-files-panel-resizing",
        "session-files-panel-splitting",
      );
    };
  }, [keepVisible]);

  useEffect(() => {
    // Captured so the topmost layer wins, and unwound one layer at a time:
    // Escape over an open prompt, confirmation, or editor must not discard the
    // work by closing the whole panel.
    //
    // The key is only swallowed when there is a layer to unwind. This panel is
    // non-modal and floats over a live terminal, so an unconditional consume
    // here would stop Escape ever reaching the pane -- no leaving vim insert
    // mode, no interrupting an agent, no exiting tmux copy-mode.
    const unwindOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (addressInputRef.current && document.activeElement === addressInputRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setAddressEdited(false);
        addressInputRef.current.blur();
        return;
      }
      if (locatorOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeLocator();
        return;
      }
      if (recentsOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeRecents();
        return;
      }
      if (prompt) {
        event.preventDefault();
        event.stopPropagation();
        closePrompt();
        return;
      }
      if (confirm) {
        event.preventDefault();
        event.stopPropagation();
        closeConfirm();
        return;
      }
      if (editing) {
        event.preventDefault();
        event.stopPropagation();
        if (editorDirty) {
          setEditorError("Choose Discard to throw these edits away");
          return;
        }
        setEditing(false);
        setEditorError(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", unwindOnEscape, true);
    return () => window.removeEventListener("keydown", unwindOnEscape, true);
  }, [
    busy,
    closeConfirm,
    closeLocator,
    closePrompt,
    closeRecents,
    confirm,
    editing,
    editorDirty,
    locatorOpen,
    onClose,
    prompt,
    recentsOpen,
  ]);

  const visibleEntries = useMemo(() => {
    const normalizedFilter = filter.trim().toLocaleLowerCase();
    const matching = (listing?.entries ?? []).filter((entry) => (
      (showHidden || !entry.hidden)
      && (!normalizedFilter || entry.name.toLocaleLowerCase().includes(normalizedFilter))
    ));
    const factor = sortDirection === "asc" ? 1 : -1;
    return matching.sort((left, right) => {
      if ((left.kind === "directory") !== (right.kind === "directory")) {
        return left.kind === "directory" ? -1 : 1;
      }
      let comparison = 0;
      if (sortKey === "size") comparison = (left.size ?? -1) - (right.size ?? -1);
      else if (sortKey === "modified") comparison = (left.modified ?? 0) - (right.modified ?? 0);
      if (comparison === 0) comparison = compareNames(left.name, right.name);
      return comparison * factor;
    });
  }, [filter, listing?.entries, showHidden, sortDirection, sortKey]);

  const checkedEntries = useMemo(() => {
    const wanted = new Set(checkedPaths);
    return (listing?.entries ?? []).filter((entry) => wanted.has(entry.path));
  }, [checkedPaths, listing?.entries]);

  const selectableEntries = useMemo(
    () => visibleEntries.filter((entry) => entry.accessible),
    [visibleEntries],
  );
  const allVisibleChecked = selectableEntries.length > 0
    && selectableEntries.every((entry) => checkedPaths.includes(entry.path));

  const breadcrumbs = useMemo(() => {
    const parts = directoryPath.split("/").filter(Boolean);
    return parts.map((name, index) => ({
      name,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [directoryPath]);

  const pathTarget: PathTarget | null = selected ?? listing;
  const imagePreviewUrl = preview?.kind === "image" && !preview.truncated
    ? sessionFileImageUrl(fileTarget, preview.path)
    : null;
  const pdfPreviewUrl = preview?.kind === "pdf" && !preview.truncated
    ? sessionFilePdfUrl(fileTarget, preview.path)
    : null;
  const canEditPreview = preview?.kind === "text"
    && !preview.truncated
    && (preview.editable ?? !selected?.symlink);
  const canRenderMarkdown = preview?.kind === "text"
    && !preview.truncated
    && MARKDOWN_FILE_PATTERN.test(preview.name);

  const guardEditor = useCallback((): boolean => {
    if (!editorDirty) return true;
    setActionStatus("Save or cancel the open edit first");
    return false;
  }, [editorDirty]);

  const guardBusy = useCallback((message: string): boolean => {
    if (!busy) return true;
    setActionStatus(message);
    return false;
  }, [busy]);

  const navigateTo = useCallback((path: string) => {
    if (!guardBusy("Wait for the current operation to finish before changing folders")) return;
    if (!guardEditor()) return;
    closeLocator();
    closeRecents();
    setDirectoryPath(path);
    directSelectionEntryRef.current = null;
    setFilter("");
    setActionStatus(null);
    setTaskItems([]);
    setPrompt(null);
    setConfirm(null);
    setCheckedPaths([]);
    setManualCopyPath(null);
    // Navigating elsewhere abandons a half-typed path rather than leaving the
    // field showing somewhere the browser is not.
    setAddressEdited(false);
  }, [closeLocator, closeRecents, guardBusy, guardEditor]);

  const refresh = useCallback(() => {
    if (!guardEditor()) return;
    setRefreshToken((current) => current + 1);
  }, [guardEditor]);

  // Points the browser at a different absolute directory. Relative navigation
  // inside a root stays in `directoryPath`; this is what steps outside it.
  const navigateToRoot = useCallback((absolute: string) => {
    if (!guardBusy("Wait for the current operation to finish before changing folders")) return;
    if (!guardEditor()) return;
    closeLocator();
    closeRecents();
    setBrowseRoot(absolute);
    setDirectoryPath("");
    directSelectionEntryRef.current = null;
    setSelected(null);
    setFilter("");
    setActionStatus(null);
    setTaskItems([]);
    setPrompt(null);
    setConfirm(null);
    setCheckedPaths([]);
    setManualCopyPath(null);
    setAddressEdited(false);
  }, [closeLocator, closeRecents, guardBusy, guardEditor]);

  const toggleLocator = useCallback(() => {
    if (locatorOpen) {
      closeLocator();
      return;
    }
    if (!guardBusy("Wait for the current operation to finish before locating files")) return;
    if (!guardEditor()) return;
    closeRecents();
    setLocatorOpen(true);
    setLocatorError(null);
    setLocatorResults(null);
    setLocatorHighlightedPath(null);
  }, [closeLocator, closeRecents, guardBusy, guardEditor, locatorOpen]);

  const toggleRecents = useCallback(() => {
    if (recentsOpen) {
      closeRecents();
      return;
    }
    if (!guardBusy("Wait for the current operation to finish before opening recent paths")) return;
    if (!guardEditor()) return;
    closeLocator();
    setActionStatus(null);
    setRecentsOpen(true);
  }, [closeLocator, closeRecents, guardBusy, guardEditor, recentsOpen]);

  const runLocatorSearch = useCallback(() => {
    const query = locatorQuery.trim();
    if (!query) {
      setLocatorError("Enter a filename or fuzzy abbreviation");
      setLocatorResults(null);
      setLocatorHighlightedPath(null);
      return;
    }
    const controller = new AbortController();
    locatorAbortRef.current?.abort();
    locatorAbortRef.current = controller;
    setLocatorLoading(true);
    setLocatorError(null);
    setLocatorResults(null);
    setLocatorHighlightedPath(null);
    void searchSessionFiles(
      fileTarget,
      query,
      showHidden,
      controller.signal,
    ).then((results) => {
      if (controller.signal.aborted) return;
      setLocatorResults(results);
      setLocatorHighlightedPath(results.results[0]?.path ?? null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setLocatorError(errorMessage(error, "Unable to search files"));
      }
    }).finally(() => {
      if (locatorAbortRef.current === controller) locatorAbortRef.current = null;
      if (!controller.signal.aborted) setLocatorLoading(false);
    });
  }, [fileTarget, locatorQuery, showHidden]);

  const openLocatedEntry = useCallback((entry: SessionFileEntry) => {
    if (!guardBusy("Wait for the current operation to finish before opening a result")) return;
    if (!guardEditor()) return;
    if (entry.kind === "directory") {
      navigateTo(entry.path);
      setActionStatus(`Opened ${entry.name}`);
      return;
    }
    listingAbortRef.current?.abort();
    closeLocator();
    directSelectionEntryRef.current = entry;
    pendingSelectionPathRef.current = entry.path;
    setDirectoryPath(parentPath(entry.path));
    setSelected(entry);
    setFilter("");
    setTaskItems([]);
    setPrompt(null);
    setConfirm(null);
    setCheckedPaths([]);
    setManualCopyPath(null);
    if (entry.hidden) setShowHidden(true);
    setAddressEdited(false);
    setActionStatus(`Located ${entry.name}`);
  }, [closeLocator, guardBusy, guardEditor, navigateTo]);

  const moveLocatorHighlight = useCallback((direction: -1 | 1) => {
    const results = locatorResults?.results ?? [];
    if (results.length === 0) return;
    const currentIndex = results.findIndex(
      (entry) => entry.path === locatorHighlightedPath,
    );
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : results.length - 1
      : (currentIndex + direction + results.length) % results.length;
    setLocatorHighlightedPath(results[nextIndex].path);
  }, [locatorHighlightedPath, locatorResults?.results]);

  const updateTask = useCallback((
    id: string,
    status: TaskStatus,
    message: string,
    uploadedEntry?: SessionFileEntry,
  ) => {
    setTaskItems((current) => current.map((item) => (
      item.id === id ? { ...item, status, message, uploadedEntry } : item
    )));
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!listing || listingLoading || listingError) {
      setActionStatus("Open a readable folder before uploading files");
      return;
    }
    if (busy) {
      setActionStatus("Wait for the current operation to finish");
      return;
    }
    // An upload refreshes the listing, which would close the editor and drop
    // whatever was typed into it.
    if (!guardEditor()) return;
    if (files.length === 0) return;

    const selectedFiles = files.slice(0, MAX_ATTACHMENT_UPLOAD_BATCH);
    const omittedCount = files.length - selectedFiles.length;
    const items = selectedFiles.map((file, index): TaskItem => ({
      id: `${index}:${file.name}:${file.lastModified}`,
      name: file.name,
      status: "queued",
      message: "Waiting",
    }));
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setTaskHeadings({ active: "UPLOADING", done: "UPLOAD RESULTS" });
    setTaskItems(items);
    setUploading(true);
    setActionStatus(null);

    const destinationPath = directoryPath;
    const uploadedEntries: SessionFileEntry[] = [];
    let failureCount = 0;

    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        if (controller.signal.aborted) break;
        const file = selectedFiles[index];
        const item = items[index];
        if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
          failureCount += 1;
          updateTask(
            item.id,
            "error",
            `Too large; maximum ${formatBytes(MAX_ATTACHMENT_UPLOAD_BYTES)}`,
          );
          continue;
        }

        updateTask(
          item.id,
          "running",
          `Uploading ${index + 1} of ${selectedFiles.length}`,
        );
        try {
          const uploaded = await uploadSessionFile(
            fileTarget,
            destinationPath,
            file,
            controller.signal,
          );
          uploadedEntries.push(uploaded);
          updateTask(item.id, "done", `${formatBytes(uploaded.size)} uploaded`, uploaded);
        } catch (error) {
          if (controller.signal.aborted) break;
          failureCount += 1;
          updateTask(item.id, "error", errorMessage(error, "Upload failed"));
        }
      }

      if (controller.signal.aborted) return;
      if (uploadedEntries.length > 0) {
        const lastUploaded = uploadedEntries[uploadedEntries.length - 1];
        pendingSelectionPathRef.current = lastUploaded.path;
        if (lastUploaded.hidden) setShowHidden(true);
        setFilter("");
        setRefreshToken((current) => current + 1);
      }

      const uploadedCount = uploadedEntries.length;
      const skippedText = omittedCount > 0
        ? ` ${omittedCount} more skipped; upload at most ${MAX_ATTACHMENT_UPLOAD_BATCH} at once.`
        : "";
      if (failureCount > 0) {
        setActionStatus(
          `${uploadedCount} uploaded, ${failureCount} failed.${skippedText}`,
        );
      } else {
        setActionStatus(
          `${uploadedCount} file${uploadedCount === 1 ? "" : "s"} uploaded.${skippedText}`,
        );
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (!controller.signal.aborted) setUploading(false);
    }
  }, [
    busy,
    directoryPath,
    fileTarget,
    guardEditor,
    listing,
    listingError,
    listingLoading,
    updateTask,
  ]);

  const downloadCheckedEntries = useCallback(async (
    entries: SessionFileEntry[],
  ) => {
    if (entries.length === 0) return;
    if (!guardBusy("Wait for the current operation to finish")) return;

    const archiveIdentity = identityRef.current;
    const controller = new AbortController();
    archiveAbortRef.current?.abort();
    archiveAbortRef.current = controller;
    setArchiving(true);
    setActionStatus("Preparing ZIP...");

    try {
      const archive = await downloadSessionFileEntries(
        fileTarget,
        directoryPath,
        entries.map((entry) => entry.name),
        controller.signal,
      );
      if (controller.signal.aborted || identityRef.current !== archiveIdentity) return;
      if (typeof URL.createObjectURL !== "function") {
        throw new Error("This browser cannot prepare local downloads");
      }

      const objectUrl = URL.createObjectURL(archive.blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = archive.name;
      link.style.display = "none";
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      }

      const packed: string[] = [];
      if (archive.fileCount > 0) {
        packed.push(
          `${archive.fileCount} file${archive.fileCount === 1 ? "" : "s"}`,
        );
      }
      if (archive.directoryCount > 0) {
        packed.push(
          `${archive.directoryCount} folder${archive.directoryCount === 1 ? "" : "s"}`,
        );
      }
      const skipped = archive.skippedCount > 0
        ? ` ${archive.skippedCount} link or special item${archive.skippedCount === 1 ? "" : "s"} skipped.`
        : "";
      setActionStatus(
        `Download started: ${packed.join(" and ")} in ${archive.name}.${skipped}`,
      );
    } catch (error) {
      if (controller.signal.aborted || identityRef.current !== archiveIdentity) return;
      setActionStatus(errorMessage(error, "Could not prepare the ZIP download"));
    } finally {
      if (archiveAbortRef.current === controller) {
        archiveAbortRef.current = null;
        if (identityRef.current === archiveIdentity) setArchiving(false);
      }
    }
  }, [directoryPath, fileTarget, guardBusy]);

  const runBatch = useCallback(async (
    entries: SessionFileEntry[],
    headings: TaskHeadings,
    operation: (entry: SessionFileEntry) => Promise<string>,
  ): Promise<{
    succeeded: SessionFileEntry[];
    failures: unknown[];
    stale: boolean;
  }> => {
    const batchIdentity = identityRef.current;
    const items = entries.map((entry): TaskItem => ({
      id: entry.path,
      name: entry.name,
      status: "queued",
      message: "Waiting",
    }));
    setTaskHeadings(headings);
    setTaskItems(items);
    setWorking(true);
    setActionStatus(null);

    const succeeded: SessionFileEntry[] = [];
    const failures: unknown[] = [];
    try {
      for (const entry of entries) {
        if (identityRef.current !== batchIdentity) break;
        updateTask(entry.path, "running", "Working");
        try {
          const message = await operation(entry);
          succeeded.push(entry);
          updateTask(entry.path, "done", message);
        } catch (error) {
          failures.push(error);
          updateTask(entry.path, "error", errorMessage(error, "Operation failed"));
        }
      }
    } finally {
      setWorking(false);
    }

    // The panel was pointed at another pane while this ran; its state has
    // already been reset and must not be overwritten with these results.
    if (identityRef.current !== batchIdentity) {
      return { succeeded, failures, stale: true };
    }
    if (succeeded.length > 0) {
      const done = new Set(succeeded.map((entry) => entry.path));
      if (directSelectionEntryRef.current
        && done.has(directSelectionEntryRef.current.path)) {
        directSelectionEntryRef.current = null;
      }
      setCheckedPaths((current) => current.filter((path) => !done.has(path)));
      // Reloading the listing clears the selection, so an open preview that
      // this batch did not touch is restored once the new entries arrive.
      const openPath = selectedPathRef.current;
      if (openPath && !done.has(openPath)) {
        pendingSelectionPathRef.current = openPath;
      }
      setRefreshToken((current) => current + 1);
    }
    return { succeeded, failures, stale: false };
  }, [updateTask]);

  const performDelete = useCallback(async (
    entries: SessionFileEntry[],
    recursive: boolean,
  ) => {
    const notEmpty: SessionFileEntry[] = [];
    let notEmptyMessage = "";
    const { succeeded, failures, stale } = await runBatch(
      entries,
      { active: "DELETING", done: "DELETE RESULTS" },
      async (entry) => {
        try {
          const removal = await deleteSessionFileEntry(
            fileTarget,
            entry.path,
            recursive,
          );
          return removal.removedEntries > 0
            ? `Deleted with ${removal.removedEntries} nested item${removal.removedEntries === 1 ? "" : "s"}`
            : "Deleted";
        } catch (error) {
          if (isNotEmptyError(error)) {
            notEmpty.push(entry);
            notEmptyMessage = errorMessage(error, "Folder is not empty");
          }
          throw error;
        }
      },
    );

    if (stale) return;
    if (notEmpty.length > 0) {
      setConfirm({
        entries: notEmpty,
        recursive: true,
        message: notEmpty.length === 1
          ? `${notEmpty[0].name}: ${notEmptyMessage}. Delete it and everything inside?`
          : `${notEmpty.length} folders are not empty. Delete them and everything inside?`,
      });
      return;
    }

    setConfirm(null);
    if (failures.length === 0) {
      setActionStatus(
        `Deleted ${succeeded.length} item${succeeded.length === 1 ? "" : "s"}.`,
      );
    } else {
      setActionStatus(`${succeeded.length} deleted, ${failures.length} failed.`);
    }
  }, [fileTarget, runBatch]);

  const performMove = useCallback(async (
    entries: SessionFileEntry[],
    destinationDirectory: string,
    skippedCount = 0,
  ) => {
    const { succeeded, failures, stale } = await runBatch(
      entries,
      { active: "MOVING", done: "MOVE RESULTS" },
      async (entry) => {
        const moved = await moveSessionFileEntry(
          fileTarget,
          entry.path,
          joinPath(destinationDirectory, entry.name),
        );
        return `Moved to ${moved.path}`;
      },
    );
    if (stale) return;
    const skippedText = skippedCount > 0
      ? ` ${skippedCount} already there or not movable here.`
      : "";
    if (failures.length === 0) {
      setActionStatus(
        `Moved ${succeeded.length} item${succeeded.length === 1 ? "" : "s"}.${skippedText}`,
      );
    } else {
      setActionStatus(
        `${succeeded.length} moved, ${failures.length} failed.${skippedText}`,
      );
    }
  }, [fileTarget, runBatch]);

  // Returns the entries worth sending, or a message explaining why none are.
  // Selecting the destination folder alongside its contents is ordinary, so
  // that folder is dropped from the batch rather than failing the whole move.
  const planMove = useCallback((
    entries: SessionFileEntry[],
    destinationDirectory: string,
  ): { movable: SessionFileEntry[]; skipped: number; error: string | null } => {
    const containsDestination = (entry: SessionFileEntry) => (
      entry.kind === "directory"
      && (destinationDirectory === entry.path
        || destinationDirectory.startsWith(`${entry.path}/`))
    );
    const movable = entries.filter((entry) => (
      !containsDestination(entry)
      && parentPath(entry.path) !== destinationDirectory
    ));
    if (movable.length > 0) {
      return { movable, skipped: entries.length - movable.length, error: null };
    }
    const blocked = entries.find(containsDestination);
    return {
      movable,
      skipped: 0,
      error: blocked
        ? `${blocked.name} cannot be moved inside itself`
        : "Those items are already in that folder",
    };
  }, []);

  const moveEntriesTo = useCallback((
    entries: SessionFileEntry[],
    destinationDirectory: string,
  ) => {
    if (entries.length === 0) return;
    if (!guardBusy("Wait for the current operation to finish")) return;
    if (!guardEditor()) return;
    const { movable, skipped, error } = planMove(entries, destinationDirectory);
    if (error) {
      setActionStatus(error);
      return;
    }
    setPrompt(null);
    void performMove(movable, destinationDirectory, skipped);
  }, [guardBusy, guardEditor, performMove, planMove]);

  const openPrompt = useCallback((
    mode: PromptMode,
    entries: SessionFileEntry[] = [],
  ) => {
    if (!guardBusy("Wait for the current operation to finish")) return;
    if (!guardEditor()) return;
    const value = mode === "rename"
      ? entries[0]?.name ?? ""
      : mode === "duplicate"
        ? duplicateName(entries[0]?.name ?? "")
        : "";
    openLayerFrom();
    setConfirm(null);
    setActionStatus(null);
    setPrompt({ mode, entries, value, error: null });
  }, [guardBusy, guardEditor, openLayerFrom]);

  const submitPrompt = useCallback(async () => {
    if (!prompt || busy) return;
    // The editor may have been dirtied after this prompt was opened, and every
    // branch below reloads the listing.
    if (!guardEditor()) return;
    const trimmed = prompt.value.trim();
    const target = prompt.entries[0] ?? null;

    if (prompt.mode === "move" || prompt.mode === "bulk-move") {
      const destination = trimmed.split("/").filter(Boolean).join("/");
      const { movable, skipped, error } = planMove(prompt.entries, destination);
      if (error) {
        setPrompt({ ...prompt, error });
        return;
      }
      closePrompt();
      void performMove(movable, destination, skipped);
      return;
    }
    if (!trimmed) {
      setPrompt({ ...prompt, error: "Enter a name" });
      return;
    }
    if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
      setPrompt({ ...prompt, error: "A name cannot contain / or navigate folders" });
      return;
    }
    if (prompt.mode === "rename" && target && trimmed === target.name) {
      closePrompt();
      return;
    }

    setWorking(true);
    setActionStatus(null);
    try {
      if (prompt.mode === "create-directory" || prompt.mode === "create-file") {
        const kind = prompt.mode === "create-directory" ? "directory" : "file";
        const created = await createSessionFileEntry(
          fileTarget,
          directoryPath,
          trimmed,
          kind,
        );
        if (created.hidden) setShowHidden(true);
        if (kind === "file") pendingSelectionPathRef.current = created.path;
        setFilter("");
        closePrompt();
        setActionStatus(`Created ${created.name}`);
        setRefreshToken((current) => current + 1);
      } else if (prompt.mode === "rename" && target) {
        const renamed = await moveSessionFileEntry(
          fileTarget,
          target.path,
          joinPath(parentPath(target.path), trimmed),
        );
        if (renamed.hidden) setShowHidden(true);
        if (renamed.kind === "file") pendingSelectionPathRef.current = renamed.path;
        // The path is the selection key, so a checked entry follows its rename.
        setCheckedPaths((current) => current.map((path) => (
          path === target.path ? renamed.path : path
        )));
        closePrompt();
        setActionStatus(`Renamed to ${renamed.name}`);
        setRefreshToken((current) => current + 1);
      } else if (prompt.mode === "duplicate" && target) {
        const copied = await copySessionFileEntry(
          fileTarget,
          target.path,
          joinPath(parentPath(target.path), trimmed),
        );
        if (copied.hidden) setShowHidden(true);
        pendingSelectionPathRef.current = copied.path;
        closePrompt();
        setActionStatus(`Duplicated as ${copied.name}`);
        setRefreshToken((current) => current + 1);
      }
    } catch (error) {
      setPrompt((current) => (current
        ? { ...current, error: errorMessage(error, "The operation failed") }
        : current));
    } finally {
      setWorking(false);
    }
  }, [
    busy,
    closePrompt,
    directoryPath,
    fileTarget,
    guardEditor,
    performMove,
    planMove,
    prompt,
  ]);

  const requestDelete = useCallback((entries: SessionFileEntry[]) => {
    if (entries.length === 0) return;
    if (!guardBusy("Wait for the current operation to finish")) return;
    if (!guardEditor()) return;
    openLayerFrom();
    setPrompt(null);
    setActionStatus(null);
    setConfirm({
      entries,
      recursive: false,
      message: `Permanently delete ${describeEntries(entries)} from the pane working directory?`,
    });
  }, [guardBusy, guardEditor, openLayerFrom]);

  const saveEditor = useCallback(async () => {
    if (!preview || editorSaving) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      const saved = await saveSessionFileContent(
        fileTarget,
        preview.path,
        editorValue,
        editorBaseline ?? preview.modified,
      );
      pendingSelectionPathRef.current = saved.path;
      setEditing(false);
      setActionStatus(`Saved ${saved.name} (${formatBytes(saved.size)})`);
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setEditorError(errorMessage(error, "Unable to save this file"));
    } finally {
      setEditorSaving(false);
    }
  }, [editorBaseline, editorSaving, editorValue, fileTarget, preview]);

  const handleFileDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    if (listing && !listingLoading && !listingError && !busy) {
      setFileDropActive(true);
    }
  };

  const handleFileDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleFileDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDropActive(false);
  };

  const handleFileDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setFileDropActive(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const beginEntryDrag = (
    event: ReactDragEvent<HTMLElement>,
    entry: SessionFileEntry,
  ) => {
    if (busy || !entry.accessible) {
      event.preventDefault();
      return;
    }
    internalDragRef.current = entry;
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData(INTERNAL_DRAG_TYPE, entry.path);
      event.dataTransfer.setData("text/plain", entry.absolutePath);
    } catch {
      // Some browsers restrict custom data types during drag start.
    }
  };

  const entriesForDrop = (): SessionFileEntry[] => {
    const dragged = internalDragRef.current;
    if (!dragged) return [];
    return checkedPaths.includes(dragged.path) && checkedEntries.length > 0
      ? checkedEntries
      : [dragged];
  };

  const allowEntryDrop = (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectory: string,
  ) => {
    const dragged = internalDragRef.current;
    if (!dragged || transferHasFiles(event.dataTransfer)) return;
    if (parentPath(dragged.path) === destinationDirectory) return;
    if (dragged.kind === "directory"
      && (destinationDirectory === dragged.path
        || destinationDirectory.startsWith(`${dragged.path}/`))) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropFolderPath(destinationDirectory);
  };

  const handleEntryDrop = (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectory: string,
  ) => {
    if (!internalDragRef.current || transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const moving = entriesForDrop();
    internalDragRef.current = null;
    setDropFolderPath(null);
    moveEntriesTo(moving, destinationDirectory);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.button !== 0
      || event.isPrimary === false
      || (event.target as Element).closest("button")
    ) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: position,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add("session-files-panel-moving");
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPosition(clampPosition({
      x: drag.startPosition.x + event.clientX - drag.startClientX,
      y: drag.startPosition.y + event.clientY - drag.startClientY,
    }, panelRef.current));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    document.documentElement.classList.remove("session-files-panel-moving");
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const moveFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? PANEL_KEY_LARGE_STEP : PANEL_KEY_STEP;
    let deltaX = 0;
    let deltaY = 0;
    if (event.key === "ArrowLeft") deltaX = -step;
    else if (event.key === "ArrowRight") deltaX = step;
    else if (event.key === "ArrowUp") deltaY = -step;
    else if (event.key === "ArrowDown") deltaY = step;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setPosition((current) => clampPosition(
      { x: current.x + deltaX, y: current.y + deltaY },
      panelRef.current,
    ));
  };

  const applyPanelSize = (requested: PanelSize) => {
    const size = clampPanelSize(requested);
    setPanelLayout((current) => ({ ...current, size }));
    setPosition((current) => clampPositionForSize(current, size));
  };

  const applyLeftAnchoredPanelSize = (
    requested: PanelSize,
    anchoredRight: number,
    requestedTop: number,
  ) => {
    const viewport = viewportSize();
    const viewportMaxWidth = Math.max(1, viewport.width - PANEL_MARGIN * 2);
    const maxWidth = Math.max(
      1,
      Math.min(viewportMaxWidth, anchoredRight - PANEL_MARGIN),
    );
    const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
    const normalized = clampPanelSize(requested);
    const size = {
      width: Math.round(Math.min(Math.max(minWidth, requested.width), maxWidth)),
      height: normalized.height,
    };
    setPanelLayout((current) => ({ ...current, size }));
    setPosition(clampPositionForSize({
      x: anchoredRight - size.width,
      y: requestedTop,
    }, size));
  };

  const beginPanelResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    direction: PanelResizeDirection,
  ) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: position,
      startSize: panelLayout.size,
      direction,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add(
      "session-files-panel-resizing",
      `session-files-panel-resizing-${direction}`,
    );
  };

  const resizePanel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (drag.direction !== "bottom-right") {
      applyLeftAnchoredPanelSize({
        width: drag.startSize.width - deltaX,
        height: drag.direction === "bottom-left"
          ? drag.startSize.height + deltaY
          : drag.startSize.height,
      }, drag.startPosition.x + drag.startSize.width, drag.startPosition.y);
      return;
    }
    applyPanelSize({
      width: drag.startSize.width + deltaX,
      height: drag.startSize.height + deltaY,
    });
  };

  const finishPanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    document.documentElement.classList.remove(
      "session-files-panel-resizing",
      "session-files-panel-resizing-bottom-right",
      "session-files-panel-resizing-left",
      "session-files-panel-resizing-bottom-left",
    );
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const resizePanelFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "Enter",
    ].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? PANEL_RESIZE_LARGE_STEP : PANEL_RESIZE_STEP;
    const viewport = viewportSize();
    let size = panelLayout.size;
    if (event.key === "ArrowLeft") size = { ...size, width: size.width - step };
    if (event.key === "ArrowRight") size = { ...size, width: size.width + step };
    if (event.key === "ArrowUp") size = { ...size, height: size.height - step };
    if (event.key === "ArrowDown") size = { ...size, height: size.height + step };
    if (event.key === "Home") {
      size = { width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT };
    }
    if (event.key === "End") {
      size = {
        width: viewport.width - PANEL_MARGIN * 2,
        height: viewport.height - PANEL_MARGIN * 2,
      };
    }
    if (event.key === "Enter") {
      size = { width: PANEL_DEFAULT_WIDTH, height: PANEL_DEFAULT_HEIGHT };
    }
    applyPanelSize(size);
  };

  const resizePanelFromLeftKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    includeHeight: boolean,
  ) => {
    const supportedKeys = includeHeight
      ? ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter"]
      : ["ArrowLeft", "ArrowRight", "Home", "End", "Enter"];
    if (!supportedKeys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? PANEL_RESIZE_LARGE_STEP : PANEL_RESIZE_STEP;
    const viewport = viewportSize();
    const anchoredRight = position.x + panelLayout.size.width;
    let size = panelLayout.size;
    if (event.key === "ArrowLeft") size = { ...size, width: size.width + step };
    if (event.key === "ArrowRight") size = { ...size, width: size.width - step };
    if (event.key === "ArrowUp") size = { ...size, height: size.height - step };
    if (event.key === "ArrowDown") size = { ...size, height: size.height + step };
    if (event.key === "Home") {
      size = {
        width: PANEL_MIN_WIDTH,
        height: includeHeight ? PANEL_MIN_HEIGHT : size.height,
      };
    }
    if (event.key === "End") {
      size = {
        width: anchoredRight - PANEL_MARGIN,
        height: includeHeight
          ? viewport.height - PANEL_MARGIN * 2
          : size.height,
      };
    }
    if (event.key === "Enter") {
      size = {
        width: PANEL_DEFAULT_WIDTH,
        height: includeHeight ? PANEL_DEFAULT_HEIGHT : size.height,
      };
    }
    applyLeftAnchoredPanelSize(size, anchoredRight, position.y);
  };

  const beginSplitResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    const contentWidth = contentRef.current?.getBoundingClientRect().width
      || panelLayout.size.width;
    splitRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSplit: panelLayout.split,
      contentWidth,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.classList.add("session-files-panel-splitting");
  };

  const resizeSplit = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = splitRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const split = clampSplit(
      drag.startSplit + (event.clientX - drag.startClientX) / drag.contentWidth,
    );
    setPanelLayout((current) => ({ ...current, split }));
  };

  const finishSplitResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (splitRef.current?.pointerId !== event.pointerId) return;
    splitRef.current = null;
    document.documentElement.classList.remove("session-files-panel-splitting");
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const resizeSplitFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? PANEL_SPLIT_LARGE_STEP : PANEL_SPLIT_STEP;
    let split = panelLayout.split;
    if (event.key === "ArrowLeft") split -= step;
    if (event.key === "ArrowRight") split += step;
    if (event.key === "Home") split = PANEL_MIN_SPLIT;
    if (event.key === "End") split = PANEL_MAX_SPLIT;
    if (event.key === "Enter") split = PANEL_DEFAULT_SPLIT;
    setPanelLayout((current) => ({ ...current, split: clampSplit(split) }));
  };

  const handleRowKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    entry: SessionFileEntry,
  ) => {
    if (event.key === "F2") {
      event.preventDefault();
      openPrompt("rename", [entry]);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestDelete([entry]);
    } else if (event.key === "Backspace" && directoryPath) {
      event.preventDefault();
      navigateTo(parentPath(directoryPath));
    }
  };

  const toggleChecked = (entry: SessionFileEntry) => {
    setCheckedPaths((current) => (current.includes(entry.path)
      ? current.filter((path) => path !== entry.path)
      : [...current, entry.path]));
  };

  const toggleAllChecked = () => {
    // Only the rows on screen are toggled; a filtered-out entry keeps whatever
    // state it had rather than being silently dropped from the selection.
    const visible = selectableEntries.map((entry) => entry.path);
    setCheckedPaths((current) => {
      if (allVisibleChecked) {
        const removing = new Set(visible);
        return current.filter((path) => !removing.has(path));
      }
      return [...new Set([...current, ...visible])];
    });
  };

  const copyPathIntoAddress = async (
    text: string,
    copiedMessage: string,
    fallbackMessage: string,
  ) => {
    // The address field doubles as an always-available handoff when browser
    // clipboard APIs are missing or reject the write.
    setAddressValue(text);
    setAddressEdited(true);
    setActionStatus(null);
    if (await copyPath(text)) {
      setManualCopyPath(null);
      setActionStatus(copiedMessage);
      return;
    }
    setManualCopyPath(text);
    setActionStatus(fallbackMessage);
  };

  const copyCurrentPath = async () => {
    if (!pathTarget) return;
    await copyPathIntoAddress(
      pathTarget.absolutePath,
      "Path copied",
      "Path is ready in the PATH bar",
    );
  };

  const copyEntryPath = async (
    entry: SessionFileEntry,
    mode: "full" | "relative",
  ) => {
    if (mode === "full") {
      await copyPathIntoAddress(
        entry.absolutePath,
        "Full path copied",
        "Full path is ready in the PATH bar",
      );
      return;
    }

    const relativePath = pathRelativeToPaneCwd(entry.absolutePath, panePath);
    await copyPathIntoAddress(
      relativePath.text,
      relativePath.relative
        ? "Relative path copied"
        : "Outside pane cwd; full path copied",
      relativePath.relative
        ? "Relative path is ready in the PATH bar"
        : "Outside pane cwd; full path is ready in the PATH bar",
    );
  };

  const insertCurrentPath = () => {
    if (!pathTarget) return;
    setActionStatus(null);
    if (!onInsertPath(pathTarget.terminalText)) {
      setActionStatus("The path does not fit or the current draft is busy");
      return;
    }
    setActionStatus("Path added to staged input");
  };

  const promptLabel = (): string => {
    if (!prompt) return "";
    const target = prompt.entries[0];
    switch (prompt.mode) {
      case "create-directory":
        return "New folder name";
      case "create-file":
        return "New file name";
      case "rename":
        return `New name for ${target?.name ?? ""}`;
      case "duplicate":
        return `Name for the copy of ${target?.name ?? ""}`;
      case "move":
        return `Destination folder for ${target?.name ?? ""}`;
      case "bulk-move":
        return `Destination folder for ${prompt.entries.length} items`;
      default:
        return "";
    }
  };

  // Stepping above the current root is only offered when the server says the
  // configured boundary still contains the directory above it.
  const rootParent = listing?.rootParent ?? null;
  const canLeaveRoot = !directoryPath && Boolean(rootParent);
  const canGoUp = Boolean(directoryPath) || canLeaveRoot;
  const atPaneDirectory = browseRoot === panePath;
  const rootLabel = atPaneDirectory
    ? "cwd"
    : browseRoot.split("/").filter(Boolean).pop() ?? "/";

  // Where the browser is trying to be. Used only when there is no listing to
  // read it from, so a failed navigation does not leave the address bar and the
  // breadcrumbs disagreeing about which folder is open.
  // The field shows the draft while one is being typed and the live location
  // otherwise. Deriving it leaves no window in which an effect scheduled before
  // a keystroke can land after it and swallow the character.
  const attemptedPath = !directoryPath
    ? browseRoot
    : browseRoot === "/"
      ? `/${directoryPath}`
      : `${browseRoot}/${directoryPath}`;
  const addressShown = addressEdited
    ? addressValue
    : listing?.absolutePath ?? attemptedPath;

  const goUp = () => {
    if (directoryPath) navigateTo(parentPath(directoryPath));
    else if (rootParent) navigateToRoot(rootParent);
  };

  const openAbsolutePath = useCallback((requestedPath: string): boolean => {
    const trimmed = requestedPath.trim();
    if (!trimmed) return false;
    if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
      setActionStatus("Enter an absolute path, starting with / or ~");
      return false;
    }
    if (!guardBusy("Wait for the current operation to finish before opening a path")) return false;
    if (!guardEditor()) return false;

    const controller = new AbortController();
    addressAbortRef.current?.abort();
    addressAbortRef.current = controller;
    const resolvingIdentity = identityRef.current;
    setAddressResolving(true);
    setActionStatus(null);
    void resolveSessionFilePath(
      { session: sessionName, sessionId, paneId },
      trimmed,
      controller.signal,
    ).then((resolved) => {
      if (controller.signal.aborted || identityRef.current !== resolvingIdentity) return;
      closeRecents();
      if (resolved.kind === "directory") {
        navigateToRoot(resolved.root);
        return;
      }
      if (!resolved.entry) {
        throw new Error("The server did not return the file to open");
      }
      // A listing for the previously open directory may finish in the same
      // tick as this resolver. Abort it before changing roots so its canonical
      // root cannot overwrite the file's parent and misroute the preview.
      listingAbortRef.current?.abort();
      directSelectionEntryRef.current = resolved.entry;
      pendingSelectionPathRef.current = resolved.path;
      setBrowseRoot(resolved.root);
      setDirectoryPath("");
      setSelected(resolved.entry);
      setFilter("");
      setTaskItems([]);
      setPrompt(null);
      setConfirm(null);
      setCheckedPaths([]);
      setManualCopyPath(null);
      if (resolved.entry.hidden) setShowHidden(true);
      setAddressEdited(false);
      setActionStatus(`Opened ${resolved.entry.name}`);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && identityRef.current === resolvingIdentity) {
        setActionStatus(errorMessage(error, "Unable to open that path"));
      }
    }).finally(() => {
      if (addressAbortRef.current !== controller) return;
      addressAbortRef.current = null;
      setAddressResolving(false);
    });
    return true;
  }, [
    closeRecents,
    guardBusy,
    guardEditor,
    navigateToRoot,
    paneId,
    sessionId,
    sessionName,
  ]);

  useEffect(() => {
    if (
      !openPathRequest
      || handledOpenPathRequestRef.current === openPathRequest.id
    ) return;
    setAddressValue(openPathRequest.path);
    setAddressEdited(true);
    if (openAbsolutePath(openPathRequest.path)) {
      handledOpenPathRequestRef.current = openPathRequest.id;
    }
  }, [openAbsolutePath, openPathRequest]);

  const submitAddress = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openAbsolutePath(addressShown);
  };

  const openRecentPath = (entry: SessionFileRecentEntry) => {
    setAddressValue(entry.absolutePath);
    setAddressEdited(true);
    openAbsolutePath(entry.absolutePath);
  };

  const submitLocator = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runLocatorSearch();
  };

  const handleLocatorKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveLocatorHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      event.key === "Enter"
      && locatorResults
      && locatorQuery.trim() === locatorResults.query
      && locatorHighlightedPath
    ) {
      const highlighted = locatorResults.results.find(
        (entry) => entry.path === locatorHighlightedPath,
      );
      if (highlighted) {
        event.preventDefault();
        openLocatedEntry(highlighted);
      }
    }
  };

  const promptIsMove = prompt?.mode === "move" || prompt?.mode === "bulk-move";
  const promptAction = promptIsMove
    ? "Move"
    : prompt?.mode === "rename"
      ? "Rename"
      : prompt?.mode === "duplicate"
        ? "Duplicate"
        : "Create";
  const panelStyle = {
    "--session-files-x": `${position.x}px`,
    "--session-files-y": `${position.y}px`,
    "--session-files-list-share": `${panelLayout.split}fr`,
    "--session-files-preview-share": `${1 - panelLayout.split}fr`,
    width: `${panelLayout.size.width}px`,
    height: `${panelLayout.size.height}px`,
  } as CSSProperties;
  const rootName = listing?.root || panePath;
  const listReady = Boolean(listing) && !listingLoading && !listingError;
  const recentUnderCwd = recentEntries.filter(
    (entry) => pathRelativeToPaneCwd(entry.absolutePath, panePath).relative,
  );
  const currentRecentPath = selected?.absolutePath ?? listing?.absolutePath ?? null;
  const locatorHighlightedIndex = locatorResults?.results.findIndex(
    (entry) => entry.path === locatorHighlightedPath,
  ) ?? -1;

  return createPortal(
    <section
      id="muxdeck-session-files"
      ref={panelRef}
      className="session-files-panel"
      style={panelStyle}
      role="dialog"
      aria-modal="false"
      aria-labelledby="session-files-title"
      aria-busy={listingLoading || busy || locatorLoading}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <header
        className="session-files-header"
        tabIndex={0}
        title="Drag to move. Use arrow keys while focused; hold Shift for larger steps."
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onKeyDown={moveFromKeyboard}
      >
        <span className="session-files-heading-icon"><FolderIcon /></span>
        <div>
          <span>LIVE FILES / PANE CWD</span>
          <h2 id="session-files-title">Files</h2>
        </div>
        <code title={rootName}>{rootName}</code>
        <button type="button" aria-label="Close file browser" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="session-files-toolbar">
        <button
          type="button"
          className="session-files-up"
          disabled={!canGoUp || listingLoading || busy}
          aria-label="Go to parent directory"
          title={canLeaveRoot ? `Go up to ${rootParent}` : "Go up"}
          onClick={goUp}
        >
          <ArrowLeftIcon />
        </button>
        <nav className="session-files-breadcrumbs" aria-label="Current directory">
          <button
            type="button"
            disabled={busy}
            aria-current={!directoryPath ? "page" : undefined}
            className={dropFolderPath === "" ? "drop-target" : undefined}
            title={browseRoot}
            onClick={() => navigateTo("")}
            onDragOver={(event) => allowEntryDrop(event, "")}
            onDragLeave={() => {
              if (dropFolderPath === "") setDropFolderPath(null);
            }}
            onDrop={(event) => handleEntryDrop(event, "")}
          >
            <FolderIcon />
            <span>{rootLabel}</span>
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path}>
              <ChevronRightIcon />
              <button
                type="button"
                disabled={busy}
                aria-current={crumb.path === directoryPath ? "page" : undefined}
                className={dropFolderPath === crumb.path ? "drop-target" : undefined}
                onClick={() => navigateTo(crumb.path)}
                onDragOver={(event) => allowEntryDrop(event, crumb.path)}
                onDragLeave={() => setDropFolderPath(null)}
                onDrop={(event) => handleEntryDrop(event, crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <input
          ref={fileInputRef}
          className="session-files-upload-input"
          type="file"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadFiles(files);
          }}
        />
        <button
          type="button"
          className="session-files-new"
          aria-label="Create a folder here"
          title="New folder"
          disabled={!listReady || busy}
          onClick={() => openPrompt("create-directory")}
        >
          <FolderIcon />
          <PlusIcon />
          <span>New folder</span>
        </button>
        <button
          type="button"
          className="session-files-new"
          aria-label="Create an empty file here"
          title="Create an empty text file in the current directory"
          disabled={!listReady || busy}
          onClick={() => openPrompt("create-file")}
        >
          <EditIcon />
          <PlusIcon />
          <span>New text file</span>
        </button>
        <button
          type="button"
          className="session-files-upload"
          aria-label="Upload files to current directory"
          title="Upload files here (no overwrite)"
          disabled={!listReady || busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <ArrowUpIcon />
          <span>Upload</span>
        </button>
        <button
          type="button"
          className="session-files-locate-button"
          aria-label="Open fuzzy file locator"
          aria-expanded={locatorOpen}
          aria-controls="session-files-locator"
          title={`Fuzzy-locate files and folders under ${browseRoot}`}
          disabled={busy}
          onClick={toggleLocator}
        >
          <SearchIcon />
          <span>Find</span>
        </button>
        <button
          type="button"
          className="session-files-recents-button"
          aria-label="Open session file history"
          aria-expanded={recentsOpen}
          aria-controls="session-files-recents"
          title={`Recent files and folders for ${sessionName}`}
          disabled={busy}
          onClick={toggleRecents}
        >
          <HistoryIcon />
          <span>Recent</span>
          {recentEntries.length > 0 && (
            <small aria-hidden="true">{recentEntries.length}</small>
          )}
        </button>
        <button
          type="button"
          className="session-files-refresh"
          aria-label="Refresh directory"
          title="Refresh"
          disabled={listingLoading || busy}
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
      </div>

      <form className="session-files-address" onSubmit={submitAddress}>
        <label>
          <span>PATH</span>
          <input
            ref={addressInputRef}
            type="text"
            aria-label="File or directory path"
            spellCheck={false}
            autoComplete="off"
            value={addressShown}
            disabled={busy}
            placeholder="/absolute/path/to/folder-or-file"
            onChange={(event) => {
              setAddressValue(event.target.value);
              setAddressEdited(true);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          {addressResolving ? "Opening..." : "Go"}
        </button>
        {!atPaneDirectory && (
          <button
            type="button"
            disabled={busy}
            title={`Back to the pane working directory (${panePath})`}
            onClick={() => navigateToRoot(panePath)}
          >
            <FolderIcon />
            <span>Pane cwd</span>
          </button>
        )}
      </form>

      <div className="session-files-tools">
        <label className="session-files-select-all">
          <input
            type="checkbox"
            aria-label="Select every listed entry"
            checked={allVisibleChecked}
            disabled={selectableEntries.length === 0 || busy}
            onChange={toggleAllChecked}
          />
        </label>
        <label>
          <SearchIcon />
          <input
            type="search"
            aria-label="Filter files"
            value={filter}
            placeholder="Filter this folder..."
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <select
          className="session-files-sort"
          aria-label="Sort entries by"
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SortKey)}
        >
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="modified">Modified</option>
        </select>
        <button
          type="button"
          aria-label={sortDirection === "asc" ? "Sort descending" : "Sort ascending"}
          title={sortDirection === "asc" ? "Sort descending" : "Sort ascending"}
          onClick={() => setSortDirection(
            (current) => (current === "asc" ? "desc" : "asc"),
          )}
        >
          {sortDirection === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
        </button>
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((current) => !current)}
        >
          {showHidden ? "Hide dotfiles" : "Show dotfiles"}
        </button>
      </div>

      {prompt && (
        <form
          className="session-files-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPrompt();
          }}
        >
          <label>
            <span>{promptLabel()}</span>
            <input
              ref={promptInputRef}
              type="text"
              value={prompt.value}
              disabled={busy}
              placeholder={promptIsMove
                ? "Folder relative to the pane cwd; empty for the root"
                : prompt.mode === "create-file" ? "notes.txt" : "name"}
              onChange={(event) => setPrompt({
                ...prompt,
                value: event.target.value,
                error: null,
              })}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            <CheckIcon />
            <span>{promptAction}</span>
          </button>
          <button type="button" disabled={busy} onClick={closePrompt}>
            Cancel
          </button>
          {prompt.error && <p role="alert">{prompt.error}</p>}
        </form>
      )}

      {confirm && (
        <div
          className="session-files-confirm"
          role="alertdialog"
          aria-label={confirm.message}
        >
          <strong>{confirm.message}</strong>
          <button
            // Keyed so the escalation renders a new button rather than widening
            // what the already-focused one does.
            key={confirm.recursive ? "recursive" : "initial"}
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void performDelete(confirm.entries, confirm.recursive)}
          >
            <TrashIcon />
            <span>
              {confirm.recursive ? "Delete everything" : "Delete permanently"}
            </span>
          </button>
          <button
            ref={confirmCancelRef}
            type="button"
            disabled={busy}
            onClick={closeConfirm}
          >
            Cancel
          </button>
        </div>
      )}

      {checkedEntries.length > 0 && (
        <div className="session-files-bulk">
          <strong>{checkedEntries.length} selected</strong>
          <button
            type="button"
            className="download"
            disabled={busy}
            onClick={() => void downloadCheckedEntries(checkedEntries)}
          >
            <ArrowDownIcon />
            <span>{archiving ? "Preparing ZIP..." : "Download ZIP"}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openPrompt("bulk-move", checkedEntries)}
          >
            <MoveIcon />
            <span>Move selected</span>
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => requestDelete(checkedEntries)}
          >
            <TrashIcon />
            <span>Delete selected</span>
          </button>
          <button type="button" disabled={busy} onClick={() => setCheckedPaths([])}>
            Clear
          </button>
        </div>
      )}

      {taskItems.length > 0 && (
        <div className="session-file-uploads" role="status" aria-live="polite">
          <div className="session-file-uploads-heading">
            <span>{busy ? taskHeadings.active : taskHeadings.done}</span>
            <code title={listing?.absolutePath || panePath}>
              {listing?.absolutePath || panePath}
            </code>
          </div>
          <div className="session-file-upload-items">
            {taskItems.map((item) => (
              <div key={item.id} className={`session-file-upload-item ${item.status}`}>
                <strong title={item.name}>{item.name}</strong>
                <span>{item.message}</span>
                {item.status === "done" && item.uploadedEntry && (
                  <div className="session-file-upload-path-actions">
                    <button
                      type="button"
                      aria-label={`Copy full path for uploaded ${item.name}`}
                      title={`Copy full path: ${item.uploadedEntry.absolutePath}`}
                      onClick={() => void copyEntryPath(item.uploadedEntry!, "full")}
                    >FULL</button>
                    <button
                      type="button"
                      aria-label={`Copy relative path for uploaded ${item.name}`}
                      title={pathRelativeToPaneCwd(item.uploadedEntry.absolutePath, panePath).relative
                        ? `Copy relative to pane cwd: ${pathRelativeToPaneCwd(item.uploadedEntry.absolutePath, panePath).text}`
                        : `Outside pane cwd - copy full path: ${item.uploadedEntry.absolutePath}`}
                      onClick={() => void copyEntryPath(item.uploadedEntry!, "relative")}
                    >REL</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            aria-label="Dismiss operation results"
            disabled={busy}
            onClick={() => setTaskItems([])}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {locatorOpen && (
        <section
          id="session-files-locator"
          className="session-files-locator"
          aria-label="Fuzzy file locator"
        >
          <div className="session-files-locator-heading">
            <div>
              <span>FUZZY LOCATOR</span>
              <strong>Find anywhere under this root</strong>
            </div>
            <code title={browseRoot}>{browseRoot}</code>
            <button
              type="button"
              aria-label="Close fuzzy file locator"
              title="Close locator (Esc)"
              onClick={closeLocator}
            >
              <CloseIcon />
            </button>
          </div>
          <form className="session-files-locator-form" onSubmit={submitLocator}>
            <label>
              <SearchIcon />
              <input
                ref={locatorInputRef}
                type="search"
                role="combobox"
                aria-label="Fuzzy file search"
                aria-autocomplete="list"
                aria-controls="session-files-locator-results"
                aria-expanded={Boolean(locatorResults?.results.length)}
                aria-activedescendant={locatorHighlightedIndex >= 0
                  ? `session-file-locator-result-${locatorHighlightedIndex}`
                  : undefined}
                autoComplete="off"
                spellCheck={false}
                value={locatorQuery}
                placeholder="Try sfp, read deploy, or package json..."
                onKeyDown={handleLocatorKeyDown}
                onChange={(event) => {
                  locatorAbortRef.current?.abort();
                  locatorAbortRef.current = null;
                  setLocatorQuery(event.target.value);
                  setLocatorLoading(false);
                  setLocatorResults(null);
                  setLocatorError(null);
                  setLocatorHighlightedPath(null);
                }}
              />
            </label>
            <button type="submit" className="primary" disabled={locatorLoading}>
              <SearchIcon />
              <span>{locatorLoading ? "Searching" : "Locate"}</span>
            </button>
          </form>
          <p className="session-files-locator-hint">
            Type an abbreviation, then press Enter. Arrow keys choose a result;
            Enter opens it. {showHidden
              ? "Dotfiles are included."
              : "Dotfiles are skipped unless Show dotfiles is enabled."}
          </p>

          <div
            id="session-files-locator-results"
            className="session-files-locator-results"
            role="listbox"
            aria-label="Located files and folders"
          >
            {locatorLoading && (
              <div className="session-files-locator-state" role="status">
                <span className="session-files-spinner" />
                <strong>Searching the file tree</strong>
                <span>Large dependency and build folders are searched last.</span>
              </div>
            )}
            {!locatorLoading && locatorError && (
              <div className="session-files-locator-state error" role="alert">
                <strong>Search unavailable</strong>
                <span>{locatorError}</span>
              </div>
            )}
            {!locatorLoading && !locatorError && !locatorResults && (
              <div className="session-files-locator-state">
                <SearchIcon />
                <strong>Locate by fragments or initials</strong>
                <span>
                  Results include regular files and folders. Directory symlinks
                  are never followed.
                </span>
              </div>
            )}
            {!locatorLoading && !locatorError && locatorResults
              && locatorResults.results.length === 0 && (
                <div className="session-files-locator-state">
                  <strong>No fuzzy matches</strong>
                  <span>Try fewer characters or enable dotfiles and search again.</span>
                </div>
              )}
            {!locatorLoading && !locatorError && locatorResults?.results.map(
              (entry, index) => (
                <button
                  key={entry.path}
                  id={`session-file-locator-result-${index}`}
                  ref={(node) => {
                    if (node) locatorResultRefs.current.set(entry.path, node);
                    else locatorResultRefs.current.delete(entry.path);
                  }}
                  type="button"
                  role="option"
                  aria-selected={entry.path === locatorHighlightedPath}
                  className={entry.path === locatorHighlightedPath ? "highlighted" : undefined}
                  title={entry.absolutePath}
                  onMouseEnter={() => setLocatorHighlightedPath(entry.path)}
                  onFocus={() => setLocatorHighlightedPath(entry.path)}
                  onClick={() => openLocatedEntry(entry)}
                >
                  <span className={`session-file-locator-kind ${entry.kind}`} aria-hidden="true">
                    {entry.kind === "directory" ? <FolderIcon /> : fileBadge(entry)}
                  </span>
                  <span className="session-file-locator-name">
                    <strong>{entry.name}</strong>
                    <code>{parentPath(entry.path) || "."}</code>
                  </span>
                  <small>{entry.kind === "directory" ? "FOLDER" : formatBytes(entry.size)}</small>
                  <ChevronRightIcon />
                </button>
              ),
            )}
          </div>

          {locatorResults && !locatorLoading && !locatorError && (
            <footer>
              <span>
                {locatorResults.results.length.toLocaleString()} match{
                  locatorResults.results.length === 1 ? "" : "es"
                } from {locatorResults.scannedEntries.toLocaleString()} scanned entries
              </span>
              {locatorResults.truncated && (
                <strong>
                  Best matches shown; refine the query for a narrower scan.
                </strong>
              )}
            </footer>
          )}
        </section>
      )}

      {recentsOpen && (
        <section
          id="session-files-recents"
          className="session-files-recents"
          aria-label="Recent session files and folders"
        >
          <div className="session-files-recents-heading">
            <div>
              <span>SESSION HISTORY</span>
              <strong>Pick up where you left off</strong>
            </div>
            <code title={sessionName}>{sessionName}</code>
            <span className="session-files-recents-heading-actions">
              <button
                type="button"
                disabled={recentEntries.length === 0 || busy}
                onClick={clearRecentPaths}
              >
                Clear
              </button>
              <button
                type="button"
                aria-label="Close session file history"
                title="Close recent paths (Esc)"
                onClick={closeRecents}
              >
                <CloseIcon />
              </button>
            </span>
          </div>

          {actionStatus && (
            <p className="session-files-recents-status" role="status">
              {actionStatus}
            </p>
          )}

          {recentEntries.length === 0 ? (
            <div className="session-files-recents-empty">
              <HistoryIcon />
              <strong>No recent paths yet</strong>
              <span>
                Open a folder or preview a file. It will appear here for this
                tmux session.
              </span>
            </div>
          ) : (
            <div className="session-files-recents-groups">
              {[
                { label: "All recent paths", entries: recentEntries, cwd: false },
                { label: "Under current CWD", entries: recentUnderCwd, cwd: true },
              ].map((group) => (
                <section key={group.label} className="session-files-recents-group" aria-label={group.label}>
                  <header>
                    <span>{group.label}</span>
                    <small>{group.entries.length}</small>
                  </header>
                  {group.cwd && <code className="session-files-recents-cwd" title={panePath}>{panePath}</code>}
                  {group.entries.length === 0 ? (
                    <p>{group.cwd ? "No recent paths under this CWD yet." : "Nothing opened yet."}</p>
                  ) : (
                    <ol>
                      {group.entries.map((entry) => {
                        const relative = pathRelativeToPaneCwd(
                          entry.absolutePath,
                          panePath,
                        );
                        const entryLabel = entry.kind === "directory" ? "folder" : "file";
                        return (
                          <li
                            key={`${entry.kind}:${entry.absolutePath}`}
                            className={currentRecentPath === entry.absolutePath
                              ? "current"
                              : undefined}
                          >
                            <button
                              type="button"
                              className="session-file-recent-open"
                              aria-label={`Open recent ${entryLabel} ${entry.absolutePath}`}
                              aria-current={currentRecentPath === entry.absolutePath
                                ? "page"
                                : undefined}
                              title={entry.absolutePath}
                              disabled={busy}
                              onClick={() => openRecentPath(entry)}
                            >
                              <span
                                className={`session-file-recent-kind ${entry.kind}`}
                                aria-hidden="true"
                              >
                                {entry.kind === "directory"
                                  ? <FolderIcon />
                                  : fileNameBadge(entry.name)}
                              </span>
                              <span className="session-file-recent-name">
                                <strong>{entry.name}</strong>
                                <code>
                                  {relative.relative
                                    ? relative.text === "." ? "pane cwd" : `./${relative.text}`
                                    : entry.absolutePath}
                                </code>
                              </span>
                              <time
                                dateTime={new Date(entry.visitedAt).toISOString()}
                                title={new Date(entry.visitedAt).toLocaleString()}
                              >
                                {formatRecentAge(entry.visitedAt)}
                              </time>
                              <ChevronRightIcon />
                            </button>
                            <button
                              type="button"
                              className="session-file-recent-forget"
                              aria-label={`Forget recent path ${entry.absolutePath}`}
                              title="Remove from this session's recents"
                              disabled={busy}
                              onClick={() => forgetRecentPath(entry.absolutePath)}
                            >
                              <CloseIcon />
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              ))}
            </div>
          )}

          <footer>
            <span>Saved in this browser, separately for each tmux session.</span>
            <strong>{recentEntries.length} / {SESSION_FILE_RECENT_LIMIT} paths</strong>
          </footer>
        </section>
      )}

      {!locatorOpen && !recentsOpen && (
        <div ref={contentRef} className="session-files-content">
        <div className="session-files-list" aria-label="Directory contents">
          {listingLoading && (
            <div className="session-files-state" role="status">Reading directory...</div>
          )}
          {!listingLoading && listingError && (
            <div className="session-files-state error" role="alert">
              <strong>Could not open this directory</strong>
              <span>{listingError}</span>
              {directoryPath ? (
                <button
                  type="button"
                  onClick={() => navigateTo(parentPath(directoryPath))}
                >
                  Back to parent
                </button>
              ) : (
                <>
                  <button type="button" onClick={refresh}>Try again</button>
                  {/* Retrying cannot help when the folder itself is refused,
                      and at the root there is nothing else left enabled. */}
                  <button
                    type="button"
                    onClick={() => {
                      addressInputRef.current?.focus();
                      addressInputRef.current?.select();
                    }}
                  >
                    Choose another folder
                  </button>
                </>
              )}
            </div>
          )}
          {!listingLoading && !listingError && visibleEntries.length === 0 && (
            <div className="session-files-state">
              <strong>{filter ? "No matching files" : "This folder is empty"}</strong>
              <span>{!showHidden && listing?.entries.some((entry) => entry.hidden)
                ? "Hidden entries are available."
                : "Nothing to show here."}</span>
            </div>
          )}
          {!listingLoading && !listingError && visibleEntries.map((entry) => {
            const relativePath = pathRelativeToPaneCwd(entry.absolutePath, panePath);
            return (
              <div
                key={entry.path}
                className={[
                  "session-file-row",
                  entry.kind,
                  selected?.path === entry.path ? "selected" : "",
                  checkedPaths.includes(entry.path) ? "checked" : "",
                  entry.kind === "directory" && dropFolderPath === entry.path
                    ? "drop-target"
                    : "",
                  !entry.accessible || busy ? "inert" : "",
                ].filter(Boolean).join(" ")}
                draggable={entry.accessible && !busy}
                onDragStart={(event) => beginEntryDrag(event, entry)}
                onDragEnd={() => {
                  internalDragRef.current = null;
                  setDropFolderPath(null);
                }}
                onDragOver={(event) => {
                  if (entry.kind !== "directory") return;
                  allowEntryDrop(event, entry.path);
                }}
                onDragLeave={() => {
                  if (dropFolderPath === entry.path) setDropFolderPath(null);
                }}
                onDrop={(event) => {
                  if (entry.kind !== "directory") return;
                  handleEntryDrop(event, entry.path);
                }}
              >
                <input
                  type="checkbox"
                  className="session-file-check"
                  aria-label={`Select ${entry.name}`}
                  checked={checkedPaths.includes(entry.path)}
                  disabled={!entry.accessible || busy}
                  onChange={() => toggleChecked(entry)}
                />
                <button
                  type="button"
                  className="session-file-open"
                  disabled={!entry.accessible || busy}
                  aria-label={`${entry.kind === "directory" ? "Folder" : "File"} ${entry.name}${entry.symlink ? ", symbolic link" : ""}`}
                  aria-pressed={entry.kind === "file" ? selected?.path === entry.path : undefined}
                  title={!entry.accessible
                    ? "This link or special file cannot be opened from the pane working directory"
                    : entry.absolutePath}
                  onKeyDown={(event) => handleRowKeyDown(event, entry)}
                  onClick={() => {
                    if (entry.kind === "directory") navigateTo(entry.path);
                    else if (guardEditor()) {
                      directSelectionEntryRef.current = null;
                      setSelected(entry);
                      setActionStatus(null);
                    }
                  }}
                >
                  <span className="session-file-kind" aria-hidden="true">
                    {entry.kind === "directory" ? <FolderIcon /> : fileBadge(entry)}
                  </span>
                  <span className="session-file-name">
                    <strong>{entry.name}</strong>
                    <small>{entry.kind === "directory"
                      ? entry.symlink ? "linked folder" : "folder"
                      : `${formatBytes(entry.size)}${entry.symlink ? " / link" : ""}`}</small>
                  </span>
                  {entry.kind === "directory" && <ChevronRightIcon />}
                </button>
                <span className="session-file-row-actions">
                  <button
                    type="button"
                    className="session-file-copy-path"
                    aria-label={`Copy full path for ${entry.name}`}
                    title={`Copy full path: ${entry.absolutePath}`}
                    disabled={busy}
                    onClick={() => void copyEntryPath(entry, "full")}
                  >
                    <span aria-hidden="true">FULL</span>
                  </button>
                  <button
                    type="button"
                    className="session-file-copy-path"
                    aria-label={`Copy relative path for ${entry.name}`}
                    title={relativePath.relative
                      ? `Copy relative to pane cwd: ${relativePath.text}`
                      : `Outside pane cwd - copy full path: ${relativePath.text}`}
                    disabled={busy}
                    onClick={() => void copyEntryPath(entry, "relative")}
                  >
                    <span aria-hidden="true">REL</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${entry.name}`}
                    title="Rename (F2)"
                    disabled={busy}
                    onClick={() => openPrompt("rename", [entry])}
                  >
                    <EditIcon />
                  </button>
                  {entry.kind === "file" && (
                    <button
                      type="button"
                      aria-label={`Duplicate ${entry.name}`}
                      title="Duplicate"
                      disabled={busy || !entry.accessible}
                      onClick={() => openPrompt("duplicate", [entry])}
                    >
                      <WindowCopyIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Move ${entry.name}`}
                    title="Move to another folder"
                    disabled={busy}
                    onClick={() => openPrompt("move", [entry])}
                  >
                    <MoveIcon />
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Delete ${entry.name}`}
                    title="Delete (Del)"
                    disabled={busy}
                    onClick={() => requestDelete([entry])}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
            );
          })}
          {listing?.truncated && !listingLoading && (
            <p className="session-files-limit" role="status">
              Showing the first {listing.limit.toLocaleString()} entries.
            </p>
          )}
        </div>

        <div
          className="session-files-splitter"
          role="separator"
          tabIndex={0}
          aria-label="Resize file list and preview"
          aria-orientation="vertical"
          aria-valuemin={Math.round(PANEL_MIN_SPLIT * 100)}
          aria-valuemax={Math.round(PANEL_MAX_SPLIT * 100)}
          aria-valuenow={Math.round(panelLayout.split * 100)}
          aria-valuetext={`${Math.round(panelLayout.split * 100)}% file list`}
          title="Drag to resize the file list and preview. Arrow keys adjust; Enter resets."
          onPointerDown={beginSplitResize}
          onPointerMove={resizeSplit}
          onPointerUp={finishSplitResize}
          onPointerCancel={finishSplitResize}
          onLostPointerCapture={finishSplitResize}
          onDoubleClick={() => setPanelLayout((current) => ({
            ...current,
            split: PANEL_DEFAULT_SPLIT,
          }))}
          onKeyDown={resizeSplitFromKeyboard}
        >
          <span aria-hidden="true" />
        </div>

        <div className="session-file-preview">
          <div className="session-file-path-actions">
            <div>
              <span>{selected ? "SELECTED PATH" : "CURRENT FOLDER"}</span>
              <code title={pathTarget?.absolutePath}>{pathTarget?.absolutePath || panePath}</code>
            </div>
            <button
              type="button"
              disabled={!pathTarget}
              aria-label="Copy server path"
              title="Copy the absolute server path"
              onClick={() => void copyCurrentPath()}
            >
              <WindowCopyIcon />
              <span>Copy path</span>
            </button>
            {selected?.kind === "file" && selected.accessible && (
              <a
                className="session-file-download"
                href={sessionFileDownloadUrl(fileTarget, selected.path)}
                download={selected.name}
                aria-label="Download selected file"
                title={`Download ${selected.name}`}
                onClick={() => setActionStatus(`Download started for ${selected.name}`)}
              >
                <ArrowDownIcon />
                <span>Download</span>
              </a>
            )}
            <button
              type="button"
              className="primary"
              disabled={!pathTarget}
              aria-label="Insert server path into staged input"
              title="Insert a shell-safe path without sending it"
              onClick={insertCurrentPath}
            >
              <TerminalIcon />
              <span>Stage path</span>
            </button>
          </div>
          {actionStatus && (
            <p className="session-file-action-status" role="status">{actionStatus}</p>
          )}
          {manualCopyPath && (
            <div className="session-file-manual-copy" role="group" aria-label="Copy this path">
              <label>
                <span>COPY THIS PATH</span>
                <input
                  ref={manualCopyRef}
                  type="text"
                  readOnly
                  aria-label="Path, selected for copying"
                  value={manualCopyPath}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <p>
                This browser will not copy for you - a console served over plain
                HTTP has no clipboard access. The path is selected; press
                Ctrl/Cmd+C.
              </p>
              <button
                type="button"
                aria-label="Dismiss the path to copy"
                onClick={() => setManualCopyPath(null)}
              >
                <CloseIcon />
              </button>
            </div>
          )}

          {!selected && (
            <div className="session-file-preview-empty">
              <FolderIcon />
              <strong>Select a file to preview</strong>
              <span>Folders open in place. Upload writes only to the folder shown.</span>
            </div>
          )}
          {selected && previewLoading && (
            <div className="session-file-preview-empty" role="status">
              <span className="session-files-spinner" />
              <strong>Reading {selected.name}</strong>
            </div>
          )}
          {selected && previewError && !previewLoading && (
            <div className="session-file-preview-empty error" role="alert">
              <strong>Preview unavailable</strong>
              <span>{previewError}</span>
            </div>
          )}
          {selected && !selected.accessible && (
            <div className="session-file-preview-empty locked">
              <strong>Outside the browsable root</strong>
              <span>Symlinks leaving this pane's working directory are not followed.</span>
            </div>
          )}
          {preview && !previewLoading && !previewError && (
            <>
              <div className="session-file-preview-meta">
                <strong>{preview.name}</strong>
                <span>{formatBytes(preview.size)}</span>
                <span>{preview.mediaType}</span>
                <span>{formatModified(preview.modified)}</span>
                {canRenderMarkdown && !editing && (
                  <button
                    type="button"
                    className="session-file-preview-mode"
                    aria-label={markdownRendered
                      ? `Show raw Markdown for ${preview.name}`
                      : `Preview ${preview.name} as rendered Markdown`}
                    aria-pressed={markdownRendered}
                    title={markdownRendered
                      ? "Return to the raw Markdown source"
                      : "Render this Markdown file"}
                    onClick={() => setMarkdownRendered((current) => !current)}
                  >
                    {markdownRendered ? "Raw" : "Preview Markdown"}
                  </button>
                )}
                {canEditPreview && !editing && (
                  <button
                    type="button"
                    className="session-file-edit"
                    aria-label={`Edit ${preview.name}`}
                    title="Edit this file in place"
                    disabled={busy}
                    onClick={() => {
                      setEditorValue(preview.content ?? "");
                      setEditorOrigin(preview.content ?? "");
                      setEditorBaseline(preview.modified);
                      setEditorError(null);
                      setMarkdownRendered(false);
                      setEditing(true);
                    }}
                  >
                    <EditIcon />
                    <span>Edit</span>
                  </button>
                )}
              </div>
              {preview.kind === "text" ? (
                editing ? (
                  <div className="session-file-editor">
                    <textarea
                      aria-label={`Contents of ${preview.name}`}
                      spellCheck={false}
                      wrap="soft"
                      value={editorValue}
                      disabled={editorSaving || busy}
                      onChange={(event) => setEditorValue(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                          event.preventDefault();
                          void saveEditor();
                        }
                      }}
                    />
                    <div className="session-file-editor-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={editorSaving || !editorDirty}
                        onClick={() => void saveEditor()}
                      >
                        <SaveIcon />
                        <span>{editorSaving ? "Saving" : "Save"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={editorSaving}
                        onClick={() => {
                          setEditing(false);
                          setEditorError(null);
                        }}
                      >
                        Discard
                      </button>
                      {editorError && <p role="alert">{editorError}</p>}
                    </div>
                  </div>
                ) : markdownRendered && canRenderMarkdown ? (
                  <Suspense
                    fallback={(
                      <div className="session-file-markdown-loading" role="status">
                        <span className="session-files-spinner" />
                        <strong>Rendering Markdown</strong>
                      </div>
                    )}
                  >
                    <MarkdownPreview content={preview.content ?? ""} />
                  </Suspense>
                ) : (
                  <pre tabIndex={0}>{preview.content || ""}</pre>
                )
              ) : preview.kind === "image" ? (
                preview.truncated ? (
                  <div className="session-file-preview-empty image-limit">
                    <ImageIcon />
                    <strong>Image is too large to preview</strong>
                    <span>
                      Inline viewing is limited to {formatBytes(preview.previewBytes)}.
                      Download the original file instead.
                    </span>
                  </div>
                ) : imagePreviewUrl ? (
                  <div
                    className="session-file-image-preview"
                    data-image-status={imagePreviewStatus}
                  >
                    <a
                      className="session-file-image-link"
                      href={imagePreviewUrl}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Open ${preview.name} full size`}
                      title="Open the original image in a new tab"
                    >
                      <img
                        src={imagePreviewUrl}
                        alt={`Preview of ${preview.name}`}
                        draggable={false}
                        decoding="async"
                        onLoad={() => setImagePreviewStatus("ready")}
                        onError={() => setImagePreviewStatus("error")}
                      />
                      {imagePreviewStatus === "ready" && (
                        <span className="session-file-image-open">
                          <ExternalLinkIcon /> Open full size
                        </span>
                      )}
                    </a>
                    {imagePreviewStatus === "loading" && (
                      <div className="session-file-image-message" role="status">
                        <span className="session-files-spinner" />
                        <strong>Decoding image</strong>
                      </div>
                    )}
                    {imagePreviewStatus === "error" && (
                      <div className="session-file-image-message error" role="alert">
                        <ImageIcon />
                        <strong>Image preview unavailable</strong>
                        <span>The file may have changed or the browser cannot decode it. Download remains available.</span>
                      </div>
                    )}
                  </div>
                ) : null
              ) : preview.kind === "pdf" ? (
                preview.truncated ? (
                  <div className="session-file-preview-empty pdf-limit">
                    <strong>PDF is too large to preview</strong>
                    <span>
                      Inline viewing is limited to {formatBytes(preview.previewBytes)}.
                      Download the original file instead.
                    </span>
                  </div>
                ) : pdfPreviewUrl ? (
                  <div className="session-file-pdf-preview">
                    <iframe
                      src={pdfPreviewUrl}
                      title={`Preview of ${preview.name}`}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                    <a
                      href={pdfPreviewUrl}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Open ${preview.name} in browser PDF viewer`}
                      title="Open the PDF in a new tab"
                    >
                      <ExternalLinkIcon />
                      <span>Open PDF</span>
                    </a>
                    <p>
                      Uses the browser's built-in PDF viewer. Download remains
                      available when inline PDF viewing is disabled.
                    </p>
                  </div>
                ) : null
              ) : (
                <div className="session-file-preview-empty binary">
                  <strong>Binary file</strong>
                  <span>Preview is disabled; download it or copy and stage its path.</span>
                </div>
              )}
              {preview.kind === "text" && preview.truncated && (
                <p className="session-file-preview-truncated" role="status">
                  Preview capped at {formatBytes(preview.previewBytes)} of {formatBytes(preview.size)}.
                </p>
              )}
            </>
          )}
        </div>
        </div>
      )}

      {fileDropActive && (
        <div className="session-files-drop-overlay" role="status">
          <ArrowUpIcon />
          <strong>Drop to upload</strong>
          <code>{listing?.absolutePath || panePath}</code>
          <span>Up to {MAX_ATTACHMENT_UPLOAD_BATCH} files, 12 MiB each. Existing names stay untouched.</span>
        </div>
      )}

      <button
        type="button"
        className="session-files-resize-left-edge"
        aria-label="Resize file browser from left edge"
        aria-description="Drag left or right while the right edge stays fixed. Arrow keys resize; Home minimizes, End maximizes, and Enter resets the width."
        title="Drag the left edge to resize. Arrow keys resize; Enter resets the width."
        onPointerDown={(event) => beginPanelResize(event, "left")}
        onPointerMove={resizePanel}
        onPointerUp={finishPanelResize}
        onPointerCancel={finishPanelResize}
        onLostPointerCapture={finishPanelResize}
        onDoubleClick={() => applyLeftAnchoredPanelSize({
          width: PANEL_DEFAULT_WIDTH,
          height: panelLayout.size.height,
        }, position.x + panelLayout.size.width, position.y)}
        onKeyDown={(event) => resizePanelFromLeftKeyboard(event, false)}
      >
        <span aria-hidden="true" />
      </button>

      <button
        type="button"
        className="session-files-resize-bottom-left"
        aria-label="Resize file browser from bottom-left corner"
        aria-description="Drag to resize in both directions while the right edge stays fixed. Arrow keys resize; Home minimizes, End maximizes, and Enter resets."
        title="Drag the bottom-left corner to resize. Arrow keys resize; Enter resets."
        onPointerDown={(event) => beginPanelResize(event, "bottom-left")}
        onPointerMove={resizePanel}
        onPointerUp={finishPanelResize}
        onPointerCancel={finishPanelResize}
        onLostPointerCapture={finishPanelResize}
        onDoubleClick={() => applyLeftAnchoredPanelSize({
          width: PANEL_DEFAULT_WIDTH,
          height: PANEL_DEFAULT_HEIGHT,
        }, position.x + panelLayout.size.width, position.y)}
        onKeyDown={(event) => resizePanelFromLeftKeyboard(event, true)}
      >
        <span aria-hidden="true" />
      </button>

      <button
        type="button"
        className="session-files-resize-corner"
        aria-label="Resize file browser window"
        aria-description="Drag to resize in both directions. Arrow keys resize one dimension; Home minimizes, End maximizes, and Enter resets."
        title="Drag to resize. Arrow keys resize; Home minimizes; End maximizes; Enter resets."
        onPointerDown={(event) => beginPanelResize(event, "bottom-right")}
        onPointerMove={resizePanel}
        onPointerUp={finishPanelResize}
        onPointerCancel={finishPanelResize}
        onLostPointerCapture={finishPanelResize}
        onDoubleClick={() => applyPanelSize({
          width: PANEL_DEFAULT_WIDTH,
          height: PANEL_DEFAULT_HEIGHT,
        })}
        onKeyDown={resizePanelFromKeyboard}
      >
        <span aria-hidden="true" />
      </button>
    </section>,
    document.body,
  );
}
