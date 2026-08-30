import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createSession, listSessions, type CreatedSession } from "../api";
import { FolderIcon, StarIcon, TerminalIcon, TrashIcon } from "../icons";
import {
  LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY,
  MAX_PINNED_WORKSPACES,
  NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY,
  formatWorkspaceRecency,
  hideWorkspace,
  loadWorkspaceMemory,
  observeSessionWorkspaces,
  persistWorkspaceMemory,
  pinWorkspace,
  rankWorkspaceSuggestions,
  recordWorkspaceLaunch,
  restoreHiddenWorkspaces,
  unpinWorkspace,
  workspacePathError,
  type WorkspaceMemory,
  type WorkspaceSuggestion,
} from "../newSessionWorkspaceMemory";
import { useTheme } from "../theme";
import type { Session } from "../types";
import { AccountLink } from "./AccountLink";
import type { WorkspaceTabOrientation } from "./SessionWorkspaceNavigation";
import { ThemeToggle } from "./ThemeToggle";

export const NEW_SESSION_PANEL_ID = "muxdeck-new-session";
export const NEW_SESSION_DIRECTORIES_STORAGE_KEY =
  LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY;
export { NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY };
const MAX_SESSION_NAME_LENGTH = 256;
const SUGGESTION_LABELS = {
  pinned: "PINNED",
  active: "LIVE NOW",
  frequent: "FREQUENT",
  recent: "RECENT",
} as const;

function sessionNameError(name: string): string | null {
  if (!name) return null;
  if (!name.trim()) {
    return "A custom session name cannot be blank. Clear the field to use an assigned name.";
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    return `A tmux session name must be ${MAX_SESSION_NAME_LENGTH} characters or fewer.`;
  }
  if (name.includes(":") || name.includes(".")) {
    return "A tmux session name cannot contain a colon or period.";
  }
  if (name.includes("\\")) {
    return "A tmux session name cannot contain a backslash.";
  }
  if (name.endsWith(";")) {
    return "A tmux session name cannot end with a semicolon.";
  }
  return null;
}

function suggestionDetail(suggestion: WorkspaceSuggestion): string {
  const recency = formatWorkspaceRecency(suggestion.lastTouchedAt);
  if (suggestion.activeSessions > 0) {
    const sessions = `${suggestion.activeSessions} live session${
      suggestion.activeSessions === 1 ? "" : "s"
    }`;
    return suggestion.launches > 0
      ? `${sessions} · launched ${suggestion.launches}x`
      : `${sessions} · seen ${recency}`;
  }
  if (suggestion.launches > 0) {
    return `Launched ${suggestion.launches}x · used ${recency}`;
  }
  if (suggestion.observedSessions > 1) {
    return `Seen in ${suggestion.observedSessions} sessions · ${recency}`;
  }
  return `Last seen ${recency}`;
}

export interface NewSessionScreenProps {
  onCreated: (name: string, sessionId: string) => void;
  onCancel: () => void;
  sessionNavigation?: ReactNode;
  workspaceLoading?: boolean;
  desktopTabOrientation?: WorkspaceTabOrientation;
}

export function NewSessionScreen({
  onCreated,
  onCancel,
  sessionNavigation,
  workspaceLoading = false,
  desktopTabOrientation = "horizontal",
}: NewSessionScreenProps) {
  const { theme } = useTheme();
  const [draftName, setDraftName] = useState("");
  const [draftDirectory, setDraftDirectory] = useState("");
  const [workspaceMemory, setWorkspaceMemory] = useState(() => (
    loadWorkspaceMemory(window.localStorage)
  ));
  const workspaceMemoryRef = useRef(workspaceMemory);
  const [knownSessions, setKnownSessions] = useState<Session[]>([]);
  const [workspaceDiscovery, setWorkspaceDiscovery] =
    useState<"loading" | "ready" | "unavailable">("loading");
  const [directoryStatus, setDirectoryStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameError = sessionNameError(draftName);
  const directoryError = workspacePathError(draftDirectory);
  const suggestions = useMemo(
    () => rankWorkspaceSuggestions(workspaceMemory, knownSessions),
    [knownSessions, workspaceMemory],
  );
  const pinnedCount = workspaceMemory.entries.filter((entry) => entry.pinned).length;

  const commitWorkspaceMemory = useCallback((
    update: (current: WorkspaceMemory) => WorkspaceMemory,
  ) => {
    const next = update(workspaceMemoryRef.current);
    if (next === workspaceMemoryRef.current) return;
    workspaceMemoryRef.current = next;
    setWorkspaceMemory(next);
    persistWorkspaceMemory(window.localStorage, next);
  }, []);

  const replaceWorkspaceMemory = useCallback((next: WorkspaceMemory) => {
    workspaceMemoryRef.current = next;
    setWorkspaceMemory(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    document.title = "New session - Muxdeck";
    headingRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const syncWorkspaceMemory = (event: StorageEvent) => {
      if (
        event.key === NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY
        || event.key === LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY
        || event.key === null
      ) {
        replaceWorkspaceMemory(loadWorkspaceMemory(window.localStorage));
      }
    };
    window.addEventListener("storage", syncWorkspaceMemory);
    return () => window.removeEventListener("storage", syncWorkspaceMemory);
  }, [replaceWorkspaceMemory]);

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaceDiscovery("loading");
    void listSessions(controller.signal).then((sessions) => {
      if (controller.signal.aborted) return;
      setKnownSessions(sessions);
      commitWorkspaceMemory((current) => observeSessionWorkspaces(current, sessions));
      setWorkspaceDiscovery("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setWorkspaceDiscovery("unavailable");
    });
    return () => controller.abort();
  }, [commitWorkspaceMemory]);

  useEffect(() => {
    if (!creating) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [creating]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current || workspaceLoading || nameError || directoryError) return;

    creatingRef.current = true;
    setCreating(true);
    setError(null);

    let createdSession: CreatedSession;
    try {
      createdSession = await createSession(
        draftName === "" ? undefined : draftName,
        theme,
        draftDirectory === "" ? undefined : draftDirectory,
      );
    } catch (creationError) {
      if (!mountedRef.current) return;
      creatingRef.current = false;
      setCreating(false);
      setError(
        creationError instanceof Error
          ? creationError.message
          : "Unable to create a tmux session",
      );
      return;
    }

    if (mountedRef.current) {
      creatingRef.current = false;
      setCreating(false);
    }
    if (draftDirectory) {
      commitWorkspaceMemory((current) => (
        recordWorkspaceLaunch(current, draftDirectory)
      ));
    }
    onCreated(createdSession.name, createdSession.id);
  };

  const saveDirectory = () => {
    if (!draftDirectory || directoryError) return;
    if (pinnedCount >= MAX_PINNED_WORKSPACES) {
      setDirectoryStatus(
        `The ${MAX_PINNED_WORKSPACES}-workspace pin limit is full. Remove or unpin one first.`,
      );
      return;
    }
    commitWorkspaceMemory((current) => pinWorkspace(current, draftDirectory));
    setDirectoryStatus(`Pinned workspace ${draftDirectory}.`);
  };

  const removeDirectory = (directory: string) => {
    commitWorkspaceMemory((current) => hideWorkspace(current, directory));
    setDirectoryStatus(`Removed workspace ${directory} from suggestions.`);
  };

  const toggleDirectoryPin = (suggestion: WorkspaceSuggestion) => {
    if (suggestion.pinned) {
      commitWorkspaceMemory((current) => unpinWorkspace(current, suggestion.path));
      setDirectoryStatus(`Unpinned workspace ${suggestion.path}.`);
      return;
    }
    if (pinnedCount >= MAX_PINNED_WORKSPACES) {
      setDirectoryStatus(
        `The ${MAX_PINNED_WORKSPACES}-workspace pin limit is full. Remove or unpin one first.`,
      );
      return;
    }
    commitWorkspaceMemory((current) => pinWorkspace(current, suggestion.path));
    setDirectoryStatus(`Pinned workspace ${suggestion.path}.`);
  };

  return (
    <main className={sessionNavigation
      ? "new-session-screen has-session-navigation"
      : "new-session-screen"}
      data-desktop-tabs={desktopTabOrientation}
    >
      {sessionNavigation && (
        <div className="console-session-navigation">{sessionNavigation}</div>
      )}
      <section
        id={NEW_SESSION_PANEL_ID}
        className="new-session-panel"
        role={sessionNavigation ? "tabpanel" : undefined}
        aria-labelledby="new-session-heading"
      >
        <div className="new-session-theme">
          <AccountLink />
          <ThemeToggle />
        </div>
        <div className="new-session-card">
          <header className="new-session-card-header">
            <span className="new-session-mark"><TerminalIcon /></span>
            <div>
              <p className="eyebrow">NEW TMUX WORKSPACE</p>
              <h1 id="new-session-heading" ref={headingRef} tabIndex={-1}>
                Start a new session.
              </h1>
              <p>
                Muxdeck will start a detached shell on this tmux server, then open it
                as the active tab in this browser workspace.
              </p>
            </div>
          </header>

          <form
            className="new-session-form"
            aria-busy={creating || workspaceLoading}
            onSubmit={(event) => void submit(event)}
          >
            <div className="new-session-default">
              <span>DEFAULT SESSION</span>
              <strong>Fresh shell</strong>
              <p>
                Name it below or let the server assign one. On tmux 3.2+, Grok
                Build launched here follows the current {theme} appearance.
              </p>
            </div>

            <div className="new-session-name-field">
              <label htmlFor="new-session-name-input">
                TMUX SESSION NAME
                <em>OPTIONAL</em>
              </label>
              <input
                id="new-session-name-input"
                name="session-name"
                value={draftName}
                maxLength={MAX_SESSION_NAME_LENGTH}
                disabled={creating}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="muxdeck-generated-name"
                aria-describedby={nameError
                  ? "new-session-name-hint new-session-name-error"
                  : "new-session-name-hint"}
                aria-invalid={nameError ? "true" : undefined}
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setError(null);
                }}
              />
              <small id="new-session-name-hint">
                Leave blank for an assigned name. Colons, periods, backslashes, and a
                final semicolon are not allowed; leading and trailing spaces are preserved.
              </small>
            </div>

            <div className="new-session-directory-field">
              <div className="new-session-directory-label">
                <label htmlFor="new-session-directory-input">
                  STARTING DIRECTORY
                  <em>OPTIONAL</em>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setDraftDirectory("");
                    setError(null);
                    setDirectoryStatus("Using the server home directory.");
                  }}
                  disabled={creating || draftDirectory === ""}
                >
                  Use home
                </button>
              </div>
              <div className="new-session-directory-entry">
                <div className="new-session-directory-input-wrap">
                  <FolderIcon />
                  <input
                    id="new-session-directory-input"
                    name="working-directory"
                    value={draftDirectory}
                    disabled={creating}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="/srv/projects/my-repo"
                    aria-describedby={directoryError
                      ? "new-session-directory-hint new-session-directory-error"
                      : "new-session-directory-hint"}
                    aria-invalid={directoryError ? "true" : undefined}
                    onChange={(event) => {
                      setDraftDirectory(event.target.value);
                      setError(null);
                      setDirectoryStatus("");
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="new-session-save-directory"
                  onClick={saveDirectory}
                  disabled={
                    creating
                    || !draftDirectory
                    || Boolean(directoryError)
                    || workspaceMemory.entries.some((entry) => (
                      entry.path === draftDirectory && entry.pinned
                    ))
                  }
                >
                  Save path
                </button>
              </div>
              <small id="new-session-directory-hint">
                Enter an absolute path on the tmux server. Leave blank to start in
                the service user&apos;s home directory.
              </small>

              <div className="new-session-saved-directories">
                <div className="new-session-saved-directories-heading">
                  <strong id="new-session-saved-directories-heading">WORKSPACE MEMORY</strong>
                  <span>
                    {workspaceDiscovery === "loading"
                      ? "Scanning known sessions..."
                      : workspaceDiscovery === "unavailable"
                        ? "Using browser memory"
                        : "Ranked by recency + frequency"}
                  </span>
                </div>
                {suggestions.length > 0 ? (
                  <ul aria-labelledby="new-session-saved-directories-heading">
                    {suggestions.map((suggestion) => (
                      <li key={suggestion.path} data-reason={suggestion.reason}>
                        <button
                          type="button"
                          className="new-session-saved-directory"
                          aria-label={`Use workspace ${suggestion.path}`}
                          aria-pressed={draftDirectory === suggestion.path}
                          title={suggestion.path}
                          disabled={creating}
                          onClick={() => {
                            setDraftDirectory(suggestion.path);
                            setError(null);
                            setDirectoryStatus(`Selected workspace ${suggestion.path}.`);
                          }}
                        >
                          <FolderIcon />
                          <span className="new-session-workspace-copy">
                            <strong>{suggestion.path}</strong>
                            <small>
                              <em>{SUGGESTION_LABELS[suggestion.reason]}</em>
                              {suggestionDetail(suggestion)}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="new-session-pin-directory"
                          aria-pressed={suggestion.pinned}
                          aria-label={`${suggestion.pinned ? "Unpin" : "Pin"} workspace ${
                            suggestion.path
                          }`}
                          title={`${suggestion.pinned ? "Unpin" : "Pin"} ${suggestion.path}`}
                          disabled={
                            creating
                            || (!suggestion.pinned && pinnedCount >= MAX_PINNED_WORKSPACES)
                          }
                          onClick={() => toggleDirectoryPin(suggestion)}
                        >
                          <StarIcon filled={suggestion.pinned} />
                        </button>
                        <button
                          type="button"
                          className="new-session-remove-directory"
                          aria-label={`Remove workspace ${suggestion.path} from suggestions`}
                          title={`Remove ${suggestion.path} from suggestions`}
                          disabled={creating}
                          onClick={() => removeDirectory(suggestion.path)}
                        >
                          <TrashIcon />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No known paths yet. Open a tmux session or enter one above;
                    Muxdeck will remember successful launches.
                  </p>
                )}
                <div className="new-session-memory-footer">
                  <p>
                    Learns from active tmux sessions and successful launches.
                    Pins and history stay in this browser.
                  </p>
                  {workspaceMemory.hiddenPaths.length > 0 && (
                    <button
                      type="button"
                      disabled={creating}
                      onClick={() => {
                        commitWorkspaceMemory(restoreHiddenWorkspaces);
                        setDirectoryStatus("Restored hidden workspace suggestions.");
                      }}
                    >
                      Restore {workspaceMemory.hiddenPaths.length} hidden
                    </button>
                  )}
                </div>
              </div>
              {directoryStatus && (
                <p className="new-session-directory-status" role="status">
                  {directoryStatus}
                </p>
              )}
            </div>

            {nameError && (
              <p id="new-session-name-error" className="new-session-error" role="alert">
                {nameError}
              </p>
            )}
            {directoryError && (
              <p id="new-session-directory-error" className="new-session-error" role="alert">
                {directoryError}
              </p>
            )}
            {error && <p className="new-session-error" role="alert">{error}</p>}
            {workspaceLoading && (
              <p className="new-session-waiting" role="status">
                Opening the saved workspace. Create becomes available when its tabs are ready.
              </p>
            )}

            <div className="new-session-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onCancel}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  creating
                  || workspaceLoading
                  || Boolean(nameError)
                  || Boolean(directoryError)
                }
              >
                <TerminalIcon />
                {creating ? "Creating..." : "Create session"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
