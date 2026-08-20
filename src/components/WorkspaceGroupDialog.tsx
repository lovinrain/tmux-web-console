import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import { CheckIcon, CloseIcon, FolderIcon, TrashIcon } from "../icons";
import { sessionDisplayTitle } from "../sessionDashboardModel";
import type { Session } from "../types";
import {
  MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH,
  WORKSPACE_TAB_GROUP_COLORS,
  workspaceTabGroupNameError,
  type WorkspaceTabGroup,
  type WorkspaceTabGroupColor,
} from "../workspaceState";
import "./WorkspaceGroupDialog.css";

interface WorkspaceGroupDialogProps {
  groups: readonly WorkspaceTabGroup[];
  openSessions: readonly string[];
  sessions: readonly Session[];
  groupId?: string | null;
  initialSession?: string | null;
  onSave: (group: WorkspaceTabGroup) => void;
  onDelete: (groupId: string) => void;
  onClose: () => void;
}

function newGroupId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hidden);
}

export function WorkspaceGroupDialog({
  groups,
  openSessions,
  sessions,
  groupId = null,
  initialSession = null,
  onSave,
  onDelete,
  onClose,
}: WorkspaceGroupDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const existing = groups.find((group) => group.id === groupId) ?? null;
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<WorkspaceTabGroupColor>(
    existing?.color ?? "blue",
  );
  const [selectedTabs, setSelectedTabs] = useState<Set<string>>(() => new Set(
    existing?.tabs
      ?? (initialSession && openSessions.includes(initialSession)
        ? [initialSession]
        : openSessions.slice(0, 1)),
  ));
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const memberships = useMemo(() => {
    const result = new Map<string, WorkspaceTabGroup>();
    for (const group of groups) {
      if (group.id === existing?.id) continue;
      group.tabs.forEach((tab) => result.set(tab, group));
    }
    return result;
  }, [existing?.id, groups]);
  const nameError = name.length > 0 ? workspaceTabGroupNameError(name) : null;
  const selectionError = selectedTabs.size === 0 ? "Choose at least one open tab." : null;
  const canSave = !workspaceTabGroupNameError(name) && !selectionError;

  useEffect(() => acquireBodyScrollLock(), []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>("input[name='group-name']")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const toggleTab = (sessionName: string) => {
    setSelectedTabs((current) => {
      const next = new Set(current);
      if (next.has(sessionName)) next.delete(sessionName);
      else next.add(sessionName);
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    onSave({
      id: existing?.id ?? newGroupId(),
      name: name.trim(),
      color,
      collapsed: existing?.collapsed ?? false,
      tabs: openSessions.filter((tab) => selectedTabs.has(tab)),
    });
    onClose();
  };

  const ungroup = () => {
    if (!existing) return;
    onDelete(existing.id);
    onClose();
  };

  return (
    <div
      className="workspace-group-backdrop"
      role="presentation"
      onMouseDown={closeFromBackdrop}
    >
      <div
        ref={dialogRef}
        className="workspace-group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onKeyDown={keyDown}
      >
        <header className="workspace-group-dialog-header">
          <span className="workspace-group-dialog-mark" data-tab-group-color={color}>
            <FolderIcon />
          </span>
          <div>
            <p className="eyebrow">Tab group</p>
            <h2 id={headingId}>{existing ? `Edit ${existing.name}` : "Create a group"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close tab group editor">
            <CloseIcon />
          </button>
        </header>

        <form onSubmit={submit}>
          <p id={descriptionId} className="workspace-group-description">
            Keep related sessions together. Group order, membership, and collapse state travel
            with this workspace; tmux sessions keep running independently.
          </p>

          <label className="workspace-group-name-field">
            <span>Group name</span>
            <input
              name="group-name"
              aria-label="Group name"
              value={name}
              maxLength={MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(nameError) || undefined}
              placeholder="Review lane"
              autoComplete="off"
            />
            <small className={nameError ? "error" : undefined}>
              {nameError ?? `${name.length}/${MAX_WORKSPACE_TAB_GROUP_NAME_LENGTH}`}
            </small>
          </label>

          <fieldset className="workspace-group-palette">
            <legend>Color</legend>
            <div>
              {WORKSPACE_TAB_GROUP_COLORS.map((candidate) => (
                <label key={candidate} data-tab-group-color={candidate} title={candidate}>
                  <input
                    type="radio"
                    name="group-color"
                    value={candidate}
                    checked={color === candidate}
                    onChange={() => setColor(candidate)}
                  />
                  <span aria-hidden="true">{color === candidate && <CheckIcon />}</span>
                  <span className="workspace-sr-only">{candidate}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="workspace-group-tabs">
            <legend>Tabs <span>{selectedTabs.size} selected</span></legend>
            <div className="workspace-group-tab-options">
              {openSessions.map((sessionName, index) => {
                const session = sessionsByName.get(sessionName);
                const title = session ? sessionDisplayTitle(session) : sessionName;
                const currentGroup = memberships.get(sessionName);
                return (
                  <label key={sessionName}>
                    <input
                      type="checkbox"
                      checked={selectedTabs.has(sessionName)}
                      onChange={() => toggleTab(sessionName)}
                    />
                    <span className="workspace-group-tab-check" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span className="workspace-group-tab-copy">
                      <strong>{title}</strong>
                      <small>
                        {index + 1}. {sessionName}
                        {currentGroup ? ` / move from ${currentGroup.name}` : ""}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            {selectionError && <p className="workspace-group-selection-error">{selectionError}</p>}
          </fieldset>

          <footer className="workspace-group-dialog-actions">
            {existing && (
              <button type="button" className="workspace-group-ungroup" onClick={ungroup}>
                <TrashIcon /> Ungroup tabs
              </button>
            )}
            <span />
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={!canSave}>
              <CheckIcon /> {existing ? "Save group" : "Create group"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
