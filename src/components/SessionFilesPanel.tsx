import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  listSessionFiles,
  previewSessionFile,
  sessionFileDownloadUrl,
  sessionFileImageUrl,
  uploadSessionFile,
  type SessionDirectoryListing,
  type SessionFileEntry,
  type SessionFilePreview,
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
  ChevronRightIcon,
  CloseIcon,
  ExternalLinkIcon,
  FolderIcon,
  ImageIcon,
  RefreshIcon,
  SearchIcon,
  TerminalIcon,
  WindowCopyIcon,
} from "../icons";
import "./SessionFilesPanel.css";

const PANEL_MARGIN = 12;
const PANEL_DEFAULT_WIDTH = 760;
const PANEL_DEFAULT_HEIGHT = 560;
const PANEL_KEY_STEP = 16;
const PANEL_KEY_LARGE_STEP = 48;

interface PanelPosition {
  x: number;
  y: number;
}

interface PanelDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: PanelPosition;
}

interface PathTarget {
  absolutePath: string;
  terminalText: string;
}

type FileUploadStatus = "queued" | "uploading" | "uploaded" | "error";
type ImagePreviewStatus = "loading" | "ready" | "error";

interface FileUploadItem {
  id: string;
  name: string;
  status: FileUploadStatus;
  message: string;
}

interface SessionFilesPanelProps {
  sessionName: string;
  sessionId: string;
  paneId: string;
  panePath: string;
  onClose: () => void;
  onInsertPath: (terminalText: string) => boolean;
}

function viewportSize(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function defaultPosition(): PanelPosition {
  const viewport = viewportSize();
  return {
    x: Math.max(PANEL_MARGIN, viewport.width - PANEL_DEFAULT_WIDTH - 24),
    y: Math.max(PANEL_MARGIN, Math.min(84, viewport.height - PANEL_MARGIN)),
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
  return {
    x: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.x),
      Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN),
    )),
    y: Math.round(Math.min(
      Math.max(PANEL_MARGIN, position.y),
      Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
    )),
  };
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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

function fileBadge(entry: SessionFileEntry): string {
  if (entry.kind === "other") return entry.symlink ? "LINK" : "OTHER";
  const extension = entry.name.includes(".")
    ? entry.name.split(".").pop()?.slice(0, 4).toUpperCase()
    : "FILE";
  return extension || "FILE";
}

async function copyPath(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser");
  }
  await navigator.clipboard.writeText(text);
}

export function SessionFilesPanel({
  sessionName,
  sessionId,
  paneId,
  panePath,
  onClose,
  onInsertPath,
}: SessionFilesPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<PanelDrag | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileDragDepthRef = useRef(0);
  const pendingSelectionPathRef = useRef<string | null>(null);
  const [position, setPosition] = useState(defaultPosition);
  const [directoryPath, setDirectoryPath] = useState("");
  const [listing, setListing] = useState<SessionDirectoryListing | null>(null);
  const [listingLoading, setListingLoading] = useState(true);
  const [listingError, setListingError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionFileEntry | null>(null);
  const [preview, setPreview] = useState<SessionFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imagePreviewStatus, setImagePreviewStatus] = useState<ImagePreviewStatus>("loading");
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [uploadItems, setUploadItems] = useState<FileUploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const identity = `${sessionName}\u0000${sessionId}\u0000${paneId}\u0000${panePath}`;

  const keepVisible = useCallback(() => {
    setPosition((current) => clampPosition(current, panelRef.current));
  }, []);

  useEffect(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    fileDragDepthRef.current = 0;
    pendingSelectionPathRef.current = null;
    setDirectoryPath("");
    setListing(null);
    setSelected(null);
    setPreview(null);
    setListingError(null);
    setPreviewError(null);
    setFilter("");
    setActionStatus(null);
    setUploadItems([]);
    setUploading(false);
    setFileDropActive(false);
  }, [identity]);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    setListingLoading(true);
    setListingError(null);
    setSelected(null);
    setPreview(null);
    setPreviewError(null);
    void listSessionFiles(
      sessionName,
      sessionId,
      paneId,
      directoryPath,
      controller.signal,
    ).then((nextListing) => {
      setListing(nextListing);
      setDirectoryPath(nextListing.path);
      const pendingPath = pendingSelectionPathRef.current;
      if (pendingPath) {
        const uploadedEntry = nextListing.entries.find(
          (entry) => entry.path === pendingPath,
        );
        pendingSelectionPathRef.current = null;
        if (uploadedEntry) setSelected(uploadedEntry);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setListing(null);
      setListingError(error instanceof Error ? error.message : "Unable to list this directory");
    }).finally(() => {
      if (!controller.signal.aborted) setListingLoading(false);
    });
    return () => controller.abort();
  }, [directoryPath, identity, paneId, refreshToken, sessionId, sessionName]);

  useEffect(() => {
    if (!selected || selected.kind !== "file" || !selected.accessible) {
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
      sessionName,
      sessionId,
      paneId,
      selected.path,
      controller.signal,
    ).then(setPreview).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setPreviewError(error instanceof Error ? error.message : "Unable to preview this file");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false);
    });
    return () => controller.abort();
  }, [identity, paneId, selected, sessionId, sessionName]);

  useEffect(() => {
    setImagePreviewStatus("loading");
  }, [preview?.kind, preview?.path]);

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
      document.documentElement.classList.remove("session-files-panel-moving");
    };
  }, [keepVisible]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const filteredEntries = useMemo(() => {
    const normalizedFilter = filter.trim().toLocaleLowerCase();
    return (listing?.entries ?? []).filter((entry) => (
      (showHidden || !entry.hidden)
      && (!normalizedFilter || entry.name.toLocaleLowerCase().includes(normalizedFilter))
    ));
  }, [filter, listing?.entries, showHidden]);

  const breadcrumbs = useMemo(() => {
    const parts = directoryPath.split("/").filter(Boolean);
    return parts.map((name, index) => ({
      name,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [directoryPath]);

  const pathTarget: PathTarget | null = selected ?? listing;
  const imagePreviewUrl = preview?.kind === "image" && !preview.truncated
    ? sessionFileImageUrl(sessionName, sessionId, paneId, preview.path)
    : null;

  const navigateTo = useCallback((path: string) => {
    if (uploading) {
      setActionStatus("Wait for the current upload to finish before changing folders");
      return;
    }
    setDirectoryPath(path);
    setFilter("");
    setActionStatus(null);
    setUploadItems([]);
  }, [uploading]);

  const refresh = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!listing || listingLoading || listingError) {
      setActionStatus("Open a readable folder before uploading files");
      return;
    }
    if (uploading) {
      setActionStatus("Wait for the current upload to finish");
      return;
    }
    if (files.length === 0) return;

    const selectedFiles = files.slice(0, MAX_ATTACHMENT_UPLOAD_BATCH);
    const omittedCount = files.length - selectedFiles.length;
    const items = selectedFiles.map((file, index): FileUploadItem => ({
      id: `${index}:${file.name}:${file.lastModified}`,
      name: file.name,
      status: "queued",
      message: "Waiting",
    }));
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    setUploadItems(items);
    setUploading(true);
    setActionStatus(null);

    const destinationPath = directoryPath;
    const uploadedEntries: SessionFileEntry[] = [];
    let failureCount = 0;
    const updateItem = (
      id: string,
      status: FileUploadStatus,
      message: string,
    ) => {
      setUploadItems((current) => current.map((item) => (
        item.id === id ? { ...item, status, message } : item
      )));
    };

    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        if (controller.signal.aborted) break;
        const file = selectedFiles[index];
        const item = items[index];
        if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
          failureCount += 1;
          updateItem(
            item.id,
            "error",
            `Too large; maximum ${formatBytes(MAX_ATTACHMENT_UPLOAD_BYTES)}`,
          );
          continue;
        }

        updateItem(
          item.id,
          "uploading",
          `Uploading ${index + 1} of ${selectedFiles.length}`,
        );
        try {
          const uploaded = await uploadSessionFile(
            sessionName,
            sessionId,
            paneId,
            destinationPath,
            file,
            controller.signal,
          );
          uploadedEntries.push(uploaded);
          updateItem(item.id, "uploaded", `${formatBytes(uploaded.size)} uploaded`);
        } catch (error) {
          if (controller.signal.aborted) break;
          failureCount += 1;
          updateItem(
            item.id,
            "error",
            error instanceof Error ? error.message : "Upload failed",
          );
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
    directoryPath,
    listing,
    listingError,
    listingLoading,
    paneId,
    sessionId,
    sessionName,
    uploading,
  ]);

  const handleFileDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    if (listing && !listingLoading && !listingError && !uploading) {
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

  const copyCurrentPath = async () => {
    if (!pathTarget) return;
    setActionStatus(null);
    try {
      await copyPath(pathTarget.absolutePath);
      setActionStatus("Path copied");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Unable to copy the path");
    }
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

  const panelStyle = {
    "--session-files-x": `${position.x}px`,
    "--session-files-y": `${position.y}px`,
  } as CSSProperties;
  const rootName = listing?.root || panePath;

  return createPortal(
    <section
      id="muxdeck-session-files"
      ref={panelRef}
      className="session-files-panel"
      style={panelStyle}
      role="dialog"
      aria-modal="false"
      aria-labelledby="session-files-title"
      aria-busy={listingLoading || uploading}
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
          disabled={!directoryPath || listingLoading || uploading}
          aria-label="Go to parent directory"
          title="Go up"
          onClick={() => navigateTo(parentPath(directoryPath))}
        >
          <ArrowLeftIcon />
        </button>
        <nav className="session-files-breadcrumbs" aria-label="Current directory">
          <button
            type="button"
            disabled={uploading}
            aria-current={!directoryPath ? "page" : undefined}
            onClick={() => navigateTo("")}
          >
            <FolderIcon />
            <span>cwd</span>
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path}>
              <ChevronRightIcon />
              <button
                type="button"
                disabled={uploading}
                aria-current={crumb.path === directoryPath ? "page" : undefined}
                onClick={() => navigateTo(crumb.path)}
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
          className="session-files-upload"
          aria-label="Upload files to current directory"
          title="Upload files here (no overwrite)"
          disabled={!listing || listingLoading || Boolean(listingError) || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <ArrowUpIcon />
          <span>Upload</span>
        </button>
        <button
          type="button"
          className="session-files-refresh"
          aria-label="Refresh directory"
          title="Refresh"
          disabled={listingLoading || uploading}
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="session-files-tools">
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
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((current) => !current)}
        >
          {showHidden ? "Hide dotfiles" : "Show dotfiles"}
        </button>
      </div>

      {uploadItems.length > 0 && (
        <div className="session-file-uploads" role="status" aria-live="polite">
          <div className="session-file-uploads-heading">
            <span>{uploading ? "UPLOADING" : "UPLOAD RESULTS"}</span>
            <code title={listing?.absolutePath || panePath}>
              {listing?.absolutePath || panePath}
            </code>
          </div>
          <div className="session-file-upload-items">
            {uploadItems.map((item) => (
              <div key={item.id} className={`session-file-upload-item ${item.status}`}>
                <strong title={item.name}>{item.name}</strong>
                <span>{item.message}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            aria-label="Dismiss upload results"
            disabled={uploading}
            onClick={() => setUploadItems([])}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      <div className="session-files-content">
        <div className="session-files-list" aria-label="Directory contents">
          {listingLoading && (
            <div className="session-files-state" role="status">Reading directory...</div>
          )}
          {!listingLoading && listingError && (
            <div className="session-files-state error" role="alert">
              <strong>Could not open this directory</strong>
              <span>{listingError}</span>
              <button type="button" onClick={directoryPath
                ? () => navigateTo(parentPath(directoryPath))
                : refresh}>
                {directoryPath ? "Back to parent" : "Try again"}
              </button>
            </div>
          )}
          {!listingLoading && !listingError && filteredEntries.length === 0 && (
            <div className="session-files-state">
              <strong>{filter ? "No matching files" : "This folder is empty"}</strong>
              <span>{!showHidden && listing?.entries.some((entry) => entry.hidden)
                ? "Hidden entries are available."
                : "Nothing to show here."}</span>
            </div>
          )}
          {!listingLoading && !listingError && filteredEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`session-file-row ${entry.kind}${selected?.path === entry.path ? " selected" : ""}`}
              disabled={!entry.accessible || uploading}
              aria-label={`${entry.kind === "directory" ? "Folder" : "File"} ${entry.name}${entry.symlink ? ", symbolic link" : ""}`}
              aria-pressed={entry.kind === "file" ? selected?.path === entry.path : undefined}
              title={!entry.accessible
                ? "This link or special file cannot be opened from the pane working directory"
                : entry.absolutePath}
              onClick={() => {
                if (entry.kind === "directory") navigateTo(entry.path);
                else {
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
          ))}
          {listing?.truncated && !listingLoading && (
            <p className="session-files-limit" role="status">
              Showing the first {listing.limit.toLocaleString()} entries.
            </p>
          )}
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
                href={sessionFileDownloadUrl(
                  sessionName,
                  sessionId,
                  paneId,
                  selected.path,
                )}
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
              </div>
              {preview.kind === "text" ? (
                <pre tabIndex={0}>{preview.content || ""}</pre>
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

      {fileDropActive && (
        <div className="session-files-drop-overlay" role="status">
          <ArrowUpIcon />
          <strong>Drop to upload</strong>
          <code>{listing?.absolutePath || panePath}</code>
          <span>Up to {MAX_ATTACHMENT_UPLOAD_BATCH} files, 12 MiB each. Existing names stay untouched.</span>
        </div>
      )}

      <div className="session-files-resize-corner" aria-hidden="true" />
    </section>,
    document.body,
  );
}
