import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
  type SavedWorkspace,
} from "../api";
import {
  ChevronRightIcon,
  EditIcon,
  GridIcon,
  RefreshIcon,
  TrashIcon,
} from "../icons";
import {
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_TABS,
  uniqueWorkspaceTabs,
  workspaceNameError,
} from "../workspaceValidation";
import {
  normalizeWorkspaceTabGroups,
  type WorkspaceTabGroup,
} from "../workspaceState";
import "./SavedWorkspaceList.css";

export interface SavedWorkspaceListProps {
  currentTabs?: readonly string[];
  currentWorkspaceGroups?: readonly WorkspaceTabGroup[];
  activeSession?: string | null;
  activeWorkspaceId?: string | null;
  onOpen: (workspace: SavedWorkspace) => void;
  onDeleted?: (workspaceId: string) => void;
  onUpdated?: (workspace: SavedWorkspace) => void;
}

type WorkspaceCreationMode = "fresh" | "copy";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function approximateWorkspaceActivity(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Activity time unavailable";
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "Active just now";
  if (elapsedSeconds < 3_600) {
    return `Active ${Math.floor(elapsedSeconds / 60)}m ago`;
  }
  if (elapsedSeconds < 86_400) {
    return `Active ${Math.floor(elapsedSeconds / 3_600)}h ago`;
  }
  if (elapsedSeconds < 604_800) {
    return `Active ${Math.floor(elapsedSeconds / 86_400)}d ago`;
  }
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === new Date(now).getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `Active ${new Intl.DateTimeFormat(undefined, options).format(date)}`;
}

function exactActivityTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function SavedWorkspaceList({
  currentTabs = [],
  currentWorkspaceGroups = [],
  activeSession = null,
  activeWorkspaceId = null,
  onOpen,
  onDeleted,
  onUpdated,
}: SavedWorkspaceListProps) {
  const [workspaces, setWorkspaces] = useState<SavedWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [createMode, setCreateMode] = useState<WorkspaceCreationMode>("fresh");
  const [createSaving, setCreateSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const createInputRef = useRef<HTMLInputElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const deleteTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const mutationVersionRef = useRef(0);

  const tabsToSave = useMemo(() => uniqueWorkspaceTabs(currentTabs), [currentTabs]);
  const groupsToSave = useMemo(
    () => normalizeWorkspaceTabGroups(currentWorkspaceGroups, tabsToSave),
    [currentWorkspaceGroups, tabsToSave],
  );
  const validActiveSession = activeSession && tabsToSave.includes(activeSession)
    ? activeSession
    : null;
  const tooManyTabs = tabsToSave.length > MAX_WORKSPACE_TABS;
  const copyUnavailable = tabsToSave.length === 0 || tooManyTabs;

  useEffect(() => {
    const controller = new AbortController();
    const mutationVersion = mutationVersionRef.current;
    setLoading(true);
    setLoadError(null);
    void listWorkspaces(controller.signal)
      .then((loaded) => {
        if (mutationVersion === mutationVersionRef.current) setWorkspaces(loaded);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (mutationVersion !== mutationVersionRef.current) {
          setLoading(false);
          return;
        }
        setLoadError(errorMessage(error, "Unable to load saved workspaces"));
        setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!confirmingDeleteId) return;
    const frame = window.requestAnimationFrame(() => deleteDialogRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmingDeleteId]);

  const orderedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => (
      right.lastActiveAt - left.lastActiveAt || right.createdAt - left.createdAt
    )),
    [workspaces],
  );

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nameError = workspaceNameError(createDraft);
    if (nameError || (createMode === "copy" && copyUnavailable) || createSaving) return;

    setCreateSaving(true);
    setActionError(null);
    try {
      const created = await createWorkspace({
        name: createDraft.trim(),
        tabs: createMode === "copy" ? tabsToSave : [],
        groups: createMode === "copy" ? groupsToSave : [],
        activeSession: createMode === "copy" ? validActiveSession : null,
      });
      mutationVersionRef.current += 1;
      setWorkspaces((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setCreateDraft("");
      setCreateMode("fresh");
      setCreating(false);
      setCreateSaving(false);
      onOpen(created);
    } catch (error) {
      setActionError(errorMessage(error, "Unable to create the workspace"));
      setCreateSaving(false);
    }
  };

  const submitRename = async (
    event: FormEvent<HTMLFormElement>,
    workspace: SavedWorkspace,
  ) => {
    event.preventDefault();
    const nameError = workspaceNameError(renameDraft);
    const nextName = renameDraft.trim();
    if (nameError || nextName === workspace.name || busyId) return;

    setBusyId(workspace.id);
    setActionError(null);
    try {
      const updated = await updateWorkspace(workspace.id, { name: nextName });
      mutationVersionRef.current += 1;
      setWorkspaces((current) => current.map((item) => (
        item.id === updated.id ? updated : item
      )));
      setEditingId(null);
      setRenameDraft("");
      onUpdated?.(updated);
    } catch (error) {
      setActionError(errorMessage(error, "Unable to rename the workspace"));
    } finally {
      setBusyId(null);
    }
  };

  const closeDeleteConfirmation = (workspaceId: string) => {
    setConfirmingDeleteId(null);
    window.requestAnimationFrame(() => deleteTriggerRefs.current.get(workspaceId)?.focus());
  };

  const confirmDelete = async (workspace: SavedWorkspace) => {
    if (busyId) return;
    setBusyId(workspace.id);
    setActionError(null);
    try {
      await deleteWorkspace(workspace.id);
      mutationVersionRef.current += 1;
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
      setConfirmingDeleteId(null);
      if (editingId === workspace.id) setEditingId(null);
      onDeleted?.(workspace.id);
    } catch (error) {
      setActionError(errorMessage(error, "Unable to delete the workspace"));
      closeDeleteConfirmation(workspace.id);
    } finally {
      setBusyId(null);
    }
  };

  const createValidationError = creating ? workspaceNameError(createDraft) : null;
  const createError = createDraft.length > 0 ? createValidationError : null;

  return (
    <section
      className="saved-workspaces"
      aria-labelledby="saved-workspaces-heading"
      aria-busy={loading}
    >
      <header className="saved-workspaces-header">
        <div>
          <p className="eyebrow">02 / WORKSPACES</p>
          <h2 id="saved-workspaces-heading">Saved workspaces</h2>
          <p className="saved-workspaces-lede">
            Keep a set of terminal tabs together and continue it from any device.
          </p>
        </div>
        <button
          type="button"
          className="saved-workspace-create-trigger"
          aria-expanded={creating}
          aria-controls="saved-workspace-create-form"
          onClick={() => {
            setCreating((current) => !current);
            setActionError(null);
          }}
          disabled={createSaving}
        >
          <GridIcon /> {creating ? "Close" : "New workspace"}
        </button>
      </header>

      {creating && (
        <form
          id="saved-workspace-create-form"
          className="saved-workspace-create-form"
          aria-busy={createSaving}
          onSubmit={(event) => void submitCreate(event)}
        >
          <div className="saved-workspace-create-copy">
            <span className="saved-workspace-form-index">NEW</span>
            <div>
              <label htmlFor="saved-workspace-name">Workspace name</label>
              <p>
                Start empty or carry over the tabs open in this browser. Running tmux
                sessions stay exactly where they are.
              </p>
              <fieldset className="saved-workspace-create-modes">
                <legend>Starting tabs</legend>
                <label className={createMode === "fresh" ? "selected" : undefined}>
                  <input
                    type="radio"
                    name="saved-workspace-starting-tabs"
                    value="fresh"
                    checked={createMode === "fresh"}
                    disabled={createSaving}
                    onChange={() => {
                      setCreateMode("fresh");
                      setActionError(null);
                    }}
                  />
                  <span>
                    <strong>Start fresh</strong>
                    <small>Begin with an empty workspace and add sessions after opening it.</small>
                  </span>
                </label>
                <label
                  className={createMode === "copy" ? "selected" : undefined}
                  data-unavailable={copyUnavailable || undefined}
                >
                  <input
                    type="radio"
                    name="saved-workspace-starting-tabs"
                    value="copy"
                    checked={createMode === "copy"}
                    disabled={createSaving || copyUnavailable}
                    onChange={() => {
                      setCreateMode("copy");
                      setActionError(null);
                    }}
                  />
                  <span>
                    <strong>Copy current tabs</strong>
                    <small>
                      {tabsToSave.length === 0
                        ? "No tabs are open to copy."
                        : tooManyTabs
                          ? `${tabsToSave.length} tabs are open; saved workspaces support up to ${MAX_WORKSPACE_TABS}.`
                          : `Copy ${tabsToSave.length} open ${tabsToSave.length === 1 ? "tab" : "tabs"} in the current order.`}
                    </small>
                  </span>
                </label>
              </fieldset>
            </div>
          </div>
          <div className="saved-workspace-create-fields">
            <input
              ref={createInputRef}
              id="saved-workspace-name"
              value={createDraft}
              maxLength={MAX_WORKSPACE_NAME_LENGTH}
              autoComplete="off"
              disabled={createSaving}
              placeholder="Release room"
              aria-invalid={Boolean(createError) || undefined}
              aria-describedby="saved-workspace-create-hint"
              onChange={(event) => {
                setCreateDraft(event.target.value);
                setActionError(null);
              }}
            />
            <button
              type="submit"
              className="saved-workspace-submit"
              disabled={Boolean(createValidationError)
                || (createMode === "copy" && copyUnavailable)
                || createSaving}
            >
              {createSaving ? "Creating..." : "Create & open"}
            </button>
          </div>
          <p
            id="saved-workspace-create-hint"
            className={createError ? "saved-workspace-field-error" : "saved-workspace-field-hint"}
            role={createError ? "alert" : undefined}
          >
            {createError || `${createDraft.trim().length} / ${MAX_WORKSPACE_NAME_LENGTH} characters`}
          </p>
        </form>
      )}

      {actionError && (
        <div className="saved-workspaces-error" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {loading && workspaces.length === 0 && (
        <div className="saved-workspaces-loading" role="status">
          <span className="saved-workspaces-loader" />
          <span>Loading saved workspaces...</span>
        </div>
      )}

      {!loading && loadError && (
        <div className="saved-workspaces-load-error" role="alert">
          <div>
            <strong>Workspaces are unavailable.</strong>
            <span>{loadError}</span>
          </div>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshIcon /> Retry
          </button>
        </div>
      )}

      {!loading && !loadError && orderedWorkspaces.length === 0 && (
        <div className="saved-workspaces-empty">
          <span className="saved-workspaces-empty-mark"><GridIcon /></span>
          <div>
            <h3>No saved workspaces yet.</h3>
            <p>Create one here; your running tmux sessions are never moved or restarted.</p>
          </div>
        </div>
      )}

      {orderedWorkspaces.length > 0 && (
        <ol className="saved-workspace-grid">
          {orderedWorkspaces.map((workspace, index) => {
            const active = workspace.id === activeWorkspaceId;
            const busy = workspace.id === busyId;
            const editing = workspace.id === editingId;
            const confirmingDelete = workspace.id === confirmingDeleteId;
            const renameError = editing ? workspaceNameError(renameDraft) : null;
            const exactTime = exactActivityTime(workspace.lastActiveAt);
            return (
              <li
                key={workspace.id}
                className={active ? "saved-workspace-card active" : "saved-workspace-card"}
                style={{ "--workspace-index": Math.min(index, 12) } as CSSProperties}
              >
                <div className="saved-workspace-card-rail" aria-hidden="true">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <div className="saved-workspace-card-body">
                  <div className="saved-workspace-card-topline">
                    <span className="saved-workspace-activity" title={exactTime}>
                      {approximateWorkspaceActivity(workspace.lastActiveAt, now)}
                    </span>
                    {active && <span className="saved-workspace-current">Current</span>}
                  </div>

                  {editing ? (
                    <form
                      className="saved-workspace-rename-form"
                      aria-busy={busy}
                      onSubmit={(event) => void submitRename(event, workspace)}
                    >
                      <label htmlFor={`workspace-rename-${workspace.id}`}>New workspace name</label>
                      <div>
                        <input
                          id={`workspace-rename-${workspace.id}`}
                          value={renameDraft}
                          maxLength={MAX_WORKSPACE_NAME_LENGTH}
                          autoFocus
                          disabled={busy}
                          aria-invalid={Boolean(renameError) || undefined}
                          onChange={(event) => {
                            setRenameDraft(event.target.value);
                            setActionError(null);
                          }}
                        />
                        <button
                          type="submit"
                          disabled={Boolean(renameError) || renameDraft.trim() === workspace.name || busy}
                        >
                          {busy ? "Saving..." : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </div>
                      {renameError && <p role="alert">{renameError}</p>}
                    </form>
                  ) : (
                    <h3>{workspace.name}</h3>
                  )}

                  <div className="saved-workspace-tab-summary">
                    <div className="saved-workspace-tab-heading">
                      <span className="saved-workspace-tab-metrics">
                        <span>{workspace.tabs.length} {workspace.tabs.length === 1 ? "session" : "sessions"}</span>
                      </span>
                      {workspace.activeSession && (
                        <span
                          className="saved-workspace-resume-target"
                          title={workspace.activeSession}
                        >
                          Resume / {workspace.activeSession}
                        </span>
                      )}
                    </div>
                    {workspace.tabs.length > 0 ? (
                      <ol aria-label={`Ordered sessions in ${workspace.name}`}>
                        {workspace.tabs.map((tab, tabIndex) => (
                          <li key={`${tab}-${tabIndex}`} title={tab}>
                            <span aria-hidden="true">{String(tabIndex + 1).padStart(2, "0")}</span>
                            {tab}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>No sessions yet</p>
                    )}
                  </div>

                  {confirmingDelete ? (
                    <div
                      ref={deleteDialogRef}
                      className="saved-workspace-delete-confirm"
                      role="alertdialog"
                      aria-labelledby={`workspace-delete-${workspace.id}`}
                      tabIndex={-1}
                    >
                      <p id={`workspace-delete-${workspace.id}`}>
                        Delete <strong>{workspace.name}</strong>? Tmux sessions keep running.
                      </p>
                      <div>
                        <button
                          type="button"
                          onClick={() => closeDeleteConfirmation(workspace.id)}
                          disabled={busy}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void confirmDelete(workspace)}
                          disabled={busy}
                        >
                          {busy ? "Deleting..." : "Delete workspace"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="saved-workspace-card-actions">
                      <button
                        type="button"
                        className="saved-workspace-open"
                        onClick={() => onOpen(workspace)}
                        disabled={busy}
                        aria-label={`${workspace.tabs.length > 0 ? "Resume" : "Open"} workspace ${workspace.name}`}
                      >
                        {workspace.tabs.length > 0 ? "Resume" : "Open empty"}
                        <ChevronRightIcon />
                      </button>
                      <div>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(workspace.id);
                            setRenameDraft(workspace.name);
                            setConfirmingDeleteId(null);
                            setActionError(null);
                          }}
                          disabled={busy || editing}
                          aria-label={`Rename workspace ${workspace.name}`}
                          title="Rename workspace"
                        >
                          <EditIcon />
                        </button>
                        <button
                          ref={(button) => {
                            if (button) deleteTriggerRefs.current.set(workspace.id, button);
                            else deleteTriggerRefs.current.delete(workspace.id);
                          }}
                          type="button"
                          onClick={() => {
                            setConfirmingDeleteId(workspace.id);
                            setEditingId(null);
                            setActionError(null);
                          }}
                          disabled={busy}
                          aria-label={`Delete workspace ${workspace.name}`}
                          title="Delete workspace"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
