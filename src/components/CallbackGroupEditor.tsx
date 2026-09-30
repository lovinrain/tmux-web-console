import { useState } from "react";
import type { CallbackCustomGroup, SaveCallbackGroupInput } from "../api";
import { sessionDisplayName, type CallbackListEntry } from "../callbackListView";

interface CallbackGroupEditorProps {
  groupId: string | null;
  workspaceId: string | null;
  groups: readonly CallbackCustomGroup[];
  revision: number;
  entries: readonly CallbackListEntry[];
  onSave: (input: SaveCallbackGroupInput) => Promise<void>;
  onDelete: (group: CallbackCustomGroup, revision: number) => Promise<void>;
  onClose: () => void;
}

export function CallbackGroupEditor({
  groupId, workspaceId, groups, revision, entries, onSave, onDelete, onClose,
}: CallbackGroupEditorProps) {
  const group = groups.find((candidate) => candidate.id === groupId);
  const [name, setName] = useState(group?.name ?? "");
  const [selected, setSelected] = useState(() => new Set(group?.sessions ?? []));
  const [editRevision, setEditRevision] = useState(revision);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stale = revision !== editRevision;
  const deleted = groupId !== null && !group;
  const trimmedName = name.trim();
  const duplicate = groups.some((candidate) => candidate.id !== groupId
    && candidate.name.toLowerCase() === trimmedName.toLowerCase());
  const nameError = trimmedName.toLowerCase() === "ungrouped" ? "Choose a name other than Ungrouped."
    : duplicate ? "A group with that name already exists." : "";
  const members = new Map(entries.map((entry) => [entry.name, entry]));
  const names = [...new Set([...members.keys(), ...(group?.sessions ?? []), ...selected])];
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const choices = names.filter((sessionName) => {
    const entry = members.get(sessionName);
    const text = `${sessionName} ${sessionDisplayName(entry?.session, sessionName)}`.toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
  const changeSelection = (sessionNames: readonly string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    sessionNames.forEach((sessionName) => checked ? next.add(sessionName) : next.delete(sessionName));
    return next;
  });
  const reload = () => {
    if (groupId !== null) {
      setName(group?.name ?? "");
      setSelected(new Set(group?.sessions ?? []));
    }
    setEditRevision(revision);
    setError("");
  };
  const commit = async (remove = false) => {
    if (busy || stale || deleted || (!remove && (!trimmedName || nameError))) return;
    setBusy(true);
    setError("");
    try {
      if (remove && group) await onDelete(group, editRevision);
      else await onSave({
        id: groupId ?? undefined, workspaceId, name: trimmedName,
        sessions: [...selected], expectedRevision: editRevision,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save callback group.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="workspace-callback-group-editor" aria-label={groupId ? "Edit custom callback group" : "New custom callback group"}
      onSubmit={(event) => { event.preventDefault(); void commit(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        }
      }}>
      <header>
        <strong>{groupId ? "Edit group" : "New group"}</strong>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </header>
      <label className="workspace-callback-view-field">
        <span>Name</span>
        <input aria-label="Custom callback group name" autoFocus maxLength={40} value={name}
          disabled={busy || deleted} placeholder="e.g. Release review"
          onChange={(event) => { setName(event.target.value); setError(""); }} />
      </label>
      <p>Choose callbacks for this group. Selecting one from another group moves it here.</p>
      {deleted ? <p role="alert">This group was deleted in another window.</p> : stale && (
        <div className="workspace-callback-group-notice" role="alert">
          <span>Groups changed in another window. Reload the latest groups before saving.</span>
          <button type="button" disabled={busy} onClick={reload}>Reload groups</button>
        </div>
      )}
      {(error || nameError) && <p className="workspace-callback-group-error" role="alert">{error || nameError}</p>}
      <input type="search" aria-label="Find callbacks to group" placeholder="Find callbacks…"
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="workspace-callback-group-selection">
        <span>{selected.size} selected</span>
        <button type="button" disabled={busy || deleted || choices.every((sessionName) => selected.has(sessionName))}
          onClick={() => changeSelection(choices, true)}>Select shown</button>
        <button type="button" disabled={busy || deleted || !choices.some((sessionName) => selected.has(sessionName))}
          onClick={() => changeSelection(choices, false)}>Deselect shown</button>
      </div>
      <div className="workspace-callback-group-members" role="group" aria-label="Choose callbacks for group">
        {choices.map((sessionName) => {
          const entry = members.get(sessionName);
          const title = sessionDisplayName(entry?.session, sessionName);
          const owner = groups.find((candidate) => candidate.sessions.includes(sessionName));
          return <label key={sessionName}>
            <input type="checkbox" checked={selected.has(sessionName)} disabled={busy || deleted}
              aria-label={`Include ${title} in group`}
              onChange={(event) => changeSelection([sessionName], event.target.checked)} />
            <span>
              <strong>{title}</strong>
              <small>{entry ? title === sessionName ? "" : sessionName : "Not currently queued"}
                {owner && owner.id !== groupId ? ` · In ${owner.name}` : ""}</small>
            </span>
          </label>;
        })}
        {choices.length === 0 && <p>{query ? "No callbacks match this search." : "No callbacks in this scope yet."}</p>}
      </div>
      <footer>
        {groupId && <button type="button" className="workspace-callback-group-delete" disabled={busy || stale || deleted}
          title="Delete this group and leave its callbacks in Ungrouped"
          onClick={() => void commit(true)}>Delete group</button>}
        <button type="submit" className="workspace-callback-group-save" disabled={busy || stale || deleted || !trimmedName || Boolean(nameError)}>
          {busy ? "Saving…" : "Save group"}
        </button>
      </footer>
    </form>
  );
}
