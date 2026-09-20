import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ApiRequestError, getSnippetTree, saveSnippetTree } from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  childrenForFolder,
  findSnippetNode,
  flattenSnippets,
  parseSnippetAliases,
  searchSnippets,
  snippetFolderPath,
  updateSnippetNode,
  type SnippetSearchEntry,
} from "../snippets";
import type { SnippetLeaf, SnippetNode } from "../types";
import "./SnippetPickerDialog.css";

export interface SnippetPickerDialogProps {
  onClose: () => void;
  onChoose: (snippet: SnippetLeaf) => boolean | void | Promise<boolean | void>;
  onManage?: () => void;
  title?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function snippetPath(entry: SnippetSearchEntry): string {
  return ["Library", ...entry.path].join(" / ");
}

export function SnippetPickerDialog({
  onClose,
  onChoose,
  onManage,
  title = "Insert a snippet",
}: SnippetPickerDialogProps) {
  const [tree, setTree] = useState<SnippetNode[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [editAliases, setEditAliases] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const initialFocusSetRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const requestNumberRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestNumber = ++requestNumberRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await getSnippetTree(signal);
      if (!mountedRef.current || requestNumber !== requestNumberRef.current) return;
      setTree(snapshot.tree);
      setRevision(snapshot.revision);
      setFolderId(null);
      setSelectedId(null);
    } catch (error) {
      if (signal?.aborted || !mountedRef.current || requestNumber !== requestNumberRef.current) {
        return;
      }
      setLoadError(errorMessage(error, "Unable to load snippets"));
    } finally {
      if (mountedRef.current && requestNumber === requestNumberRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mountedRef.current = false;
      requestNumberRef.current += 1;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    dialogRef.current?.focus();

    return () => {
      releaseBodyScroll();
      if (restoreFocusRef.current && previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!loading && !initialFocusSetRef.current) {
      initialFocusSetRef.current = true;
      searchRef.current?.focus();
    }
  }, [loading]);

  useEffect(() => {
    if (editing) editNameRef.current?.focus();
  }, [editing]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setActionError(null);
    setReloadRequired(false);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!choosing && !saving) {
          if (editing) cancelEditing();
          else onClose();
        }
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), "
          + "select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelEditing, choosing, editing, onClose, saving]);

  const allSnippets = useMemo(() => flattenSnippets(tree), [tree]);
  const normalizedQuery = query.trim();
  const searchResults = useMemo(
    () => normalizedQuery ? searchSnippets(allSnippets, normalizedQuery) : [],
    [allSnippets, normalizedQuery],
  );
  const currentChildren = useMemo(
    () => childrenForFolder(tree, folderId),
    [folderId, tree],
  );
  const breadcrumbs = useMemo(
    () => snippetFolderPath(tree, folderId),
    [folderId, tree],
  );
  const effectiveSelectedId = selectedId ?? (normalizedQuery ? searchResults[0]?.snippet.id : null);
  const selectedNode = effectiveSelectedId ? findSnippetNode(tree, effectiveSelectedId) : null;
  const selected = selectedNode?.type === "snippet" ? selectedNode : null;
  const selectedEntry = selected
    ? allSnippets.find((entry) => entry.snippet.id === selected.id) ?? null
    : null;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(".sp-snippet-row.active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [effectiveSelectedId]);

  const openFolder = (id: string | null) => {
    setFolderId(id);
    setSelectedId(null);
    setActionError(null);
    setNotice(null);
  };

  const selectSnippet = (snippet: SnippetLeaf) => {
    setSelectedId(snippet.id);
    setActionError(null);
    setNotice(null);
  };

  const chooseSnippet = async () => {
    if (!selected || choosing || editing || saving) return;
    setChoosing(true);
    setActionError(null);
    try {
      const accepted = await onChoose(selected);
      if (mountedRef.current) {
        if (accepted === false) {
          setChoosing(false);
          return;
        }
        // Insertion callbacks focus their destination; do not jump back to the picker trigger.
        restoreFocusRef.current = false;
        onClose();
      }
    } catch (error) {
      if (mountedRef.current) {
        setActionError(errorMessage(error, "Unable to insert this snippet"));
        setChoosing(false);
      }
    }
  };

  const manageSnippets = () => {
    if (!onManage || choosing || editing || saving) return;
    onManage();
    restoreFocusRef.current = false;
    onClose();
  };

  const closeFromBackdrop = () => {
    if (!choosing && !editing && !saving) onClose();
  };

  const beginEditing = () => {
    if (!selected) return;
    setSelectedId(selected.id);
    setEditName(selected.name);
    setEditText(selected.text);
    setEditAliases((selected.aliases ?? []).join(", "));
    setActionError(null);
    setNotice(null);
    setReloadRequired(false);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selected || saving || reloadRequired) return;
    setActionError(null);
    let aliases: string[];
    try {
      aliases = parseSnippetAliases(editAliases);
    } catch (error) {
      setActionError(errorMessage(error, "Check the snippet shortcuts."));
      return;
    }
    const name = editName.trim();
    if (!name || !editText.trim()) return;
    setSaving(true);
    try {
      const saved = await saveSnippetTree(updateSnippetNode(tree, selected.id, (node) => (
        node.type === "snippet" ? { ...node, name, text: editText, aliases } : node
      )), revision);
      if (!mountedRef.current) return;
      setTree(saved.tree);
      setRevision(saved.revision);
      setEditing(false);
      setNotice("Snippet saved to the shared library.");
      window.requestAnimationFrame(() => searchRef.current?.focus());
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof ApiRequestError && error.status === 409) {
        setReloadRequired(true);
        setActionError("The library changed in another tab. Reload the latest library before saving again. Your edits will be kept.");
      } else {
        setActionError(errorMessage(error, "Unable to save this snippet."));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const reloadForEdit = async () => {
    if (saving || !selected) return;
    setSaving(true);
    try {
      const snapshot = await getSnippetTree();
      if (!mountedRef.current) return;
      const latest = findSnippetNode(snapshot.tree, selected.id);
      if (latest?.type !== "snippet") {
        setActionError("This snippet was deleted elsewhere. Copy your edits before canceling.");
        return;
      }
      setTree(snapshot.tree);
      setRevision(snapshot.revision);
      setReloadRequired(false);
      setActionError(null);
      setNotice("Latest library loaded. Saving will replace this snippet with your edits.");
    } catch (error) {
      if (mountedRef.current) setActionError(errorMessage(error, "Unable to reload snippets."));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || editing || saving || loading || choosing) return;
    const entries = normalizedQuery ? searchResults : currentChildren.flatMap((node) => (
      node.type === "snippet" ? [{ snippet: node, path: [] }] : []
    ));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return;
      event.preventDefault();
      const index = entries.findIndex((entry) => entry.snippet.id === effectiveSelectedId);
      const next = index < 0
        ? event.key === "ArrowDown" ? 0 : entries.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      selectSnippet(entries[next].snippet);
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      void chooseSnippet();
    }
  };

  const stopKeyPropagation = (event: ReactKeyboardEvent) => {
    // Keep terminal-level keyboard listeners from receiving picker input.
    event.stopPropagation();
  };

  const renderSnippetButton = (entry: SnippetSearchEntry) => {
    const snippet = entry.snippet;
    const active = snippet.id === effectiveSelectedId;
    return (
      <button
        type="button"
        className={active ? "sp-snippet-row active" : "sp-snippet-row"}
        key={snippet.id}
        onClick={() => selectSnippet(snippet)}
        aria-label={`Preview snippet ${snippet.name}`}
        aria-pressed={active}
        disabled={editing || saving || choosing}
      >
        <span className="sp-node-mark" aria-hidden="true">$</span>
        <span className="sp-node-copy">
          <strong>{snippet.name}</strong>
          <span>{snippetPath(entry)}</span>
          {Boolean(snippet.aliases?.length) && <span className="sp-aliases">{snippet.aliases?.join(" · ")}</span>}
          <code>{snippet.text}</code>
        </span>
      </button>
    );
  };

  return (
    <div className="sp-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section
        ref={dialogRef}
        className="sp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snippet-picker-heading"
        aria-describedby="snippet-picker-description"
        aria-busy={loading || choosing || saving}
        tabIndex={-1}
        onKeyDown={stopKeyPropagation}
        onKeyUp={stopKeyPropagation}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sp-header">
          <div>
            <p className="sp-eyebrow">SNIPPET LIBRARY</p>
            <h2 id="snippet-picker-heading">{title}</h2>
            <p id="snippet-picker-description">Preview first, then insert into the current draft.</p>
          </div>
          <div className="sp-header-actions">
            {onManage && (
              <button type="button" className="sp-button" onClick={manageSnippets} disabled={choosing || editing || saving}>
                Manage
              </button>
            )}
            <button type="button" className="sp-close" onClick={onClose} disabled={choosing || editing || saving} aria-label="Close snippets">
              Close
            </button>
          </div>
        </header>

        <div className="sp-search-row">
          <label htmlFor="snippet-picker-search">Search all snippets</label>
          <div className="sp-search-field">
            <span aria-hidden="true">?</span>
            <input
              ref={searchRef}
              id="snippet-picker-search"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedId(null);
                setActionError(null);
                setNotice(null);
              }}
              onKeyDown={searchKeyDown}
              placeholder="Fuzzy title or shortcut; text or folder"
              autoComplete="off"
              disabled={loading || editing || saving || choosing}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSelectedId(null);
                  searchRef.current?.focus();
                }}
                aria-label="Clear snippet search"
                disabled={editing || saving || choosing}
              >
                Clear
              </button>
            )}
          </div>
          <p className="sp-search-help">Shortcut matches come first. ↑ ↓ to preview · Enter to insert.</p>
        </div>

        {loading ? (
          <div className="sp-state" role="status">
            <span className="sp-loader" aria-hidden="true" />
            <strong>Loading snippets...</strong>
            <p>Opening the shared snippet library.</p>
          </div>
        ) : loadError ? (
          <div className="sp-state sp-state-error" role="alert">
            <strong>Snippets are unavailable.</strong>
            <p>{loadError}</p>
            <button type="button" className="sp-button sp-button-primary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className={editing ? "sp-content sp-content-editing" : "sp-content"}>
            <section className="sp-browser" aria-label="Snippet browser">
              <nav className="sp-breadcrumbs" aria-label="Snippet folder">
                <button
                  type="button"
                  disabled={editing || saving || choosing}
                  onClick={() => {
                    setQuery("");
                    openFolder(null);
                  }}
                  aria-current={folderId === null && !normalizedQuery ? "location" : undefined}
                >
                  Library
                </button>
                {!normalizedQuery && breadcrumbs.map((folder) => (
                  <span key={folder.id}>
                    <span aria-hidden="true">/</span>
                    <button
                      type="button"
                      disabled={editing || saving || choosing}
                      onClick={() => openFolder(folder.id)}
                      aria-current={folder.id === folderId ? "location" : undefined}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
                {normalizedQuery && <span className="sp-search-scope">/ Search results</span>}
              </nav>

              <div className="sp-browser-scroll">
                {normalizedQuery ? (
                  searchResults.length > 0 ? (
                    <div className="sp-node-list" aria-label="Matching snippets">
                      {searchResults.map(renderSnippetButton)}
                    </div>
                  ) : (
                    <div className="sp-inline-empty">
                      <strong>No snippets match.</strong>
                      <span>Try a name, phrase, or folder path.</span>
                    </div>
                  )
                ) : currentChildren.length > 0 ? (
                  <div className="sp-node-list" aria-label="Folder contents">
                    {currentChildren.map((node) => {
                      if (node.type === "folder") {
                        return (
                          <button
                            type="button"
                            className="sp-folder-row"
                            key={node.id}
                            disabled={editing || saving || choosing}
                            onClick={() => openFolder(node.id)}
                            aria-label={`Open folder ${node.name}`}
                          >
                            <span className="sp-node-mark folder" aria-hidden="true" />
                            <span className="sp-node-copy">
                              <strong>{node.name}</strong>
                              <span>{node.children.length} {node.children.length === 1 ? "item" : "items"}</span>
                            </span>
                            <span className="sp-folder-arrow" aria-hidden="true">&gt;</span>
                          </button>
                        );
                      }
                      const entry = allSnippets.find((candidate) => candidate.snippet.id === node.id);
                      return entry ? renderSnippetButton(entry) : null;
                    })}
                  </div>
                ) : (
                  <div className="sp-inline-empty">
                    <strong>{tree.length === 0 ? "No snippets yet." : "This folder is empty."}</strong>
                    <span>{onManage ? "Open Manage to build your snippet tree." : "Add snippets from the library manager."}</span>
                    {onManage && (
                      <button type="button" className="sp-button" onClick={manageSnippets}>Manage snippets</button>
                    )}
                  </div>
                )}
              </div>
            </section>

            <aside className={selected ? "sp-preview selected" : "sp-preview"} aria-label="Snippet preview">
              {selected && selectedEntry ? (
                editing ? (
                  <form className="sp-editor" onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit();
                  }}>
                    <div className="sp-preview-heading"><div><p>EDIT SNIPPET</p><h3>Edit in place</h3></div></div>
                    <label htmlFor="snippet-edit-name">Name</label>
                    <input
                      ref={editNameRef}
                      id="snippet-edit-name"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      maxLength={120}
                      required
                      disabled={saving}
                    />
                    <label htmlFor="snippet-edit-shortcuts">Shortcuts</label>
                    <input
                      id="snippet-edit-shortcuts"
                      value={editAliases}
                      onChange={(event) => setEditAliases(event.target.value)}
                      placeholder="deploy, ship"
                      aria-describedby="snippet-edit-shortcuts-help"
                      autoComplete="off"
                      disabled={saving}
                    />
                    <p id="snippet-edit-shortcuts-help" className="sp-editor-help">
                      Short words that rank first in search. Separate with spaces or commas.
                    </p>
                    <label htmlFor="snippet-edit-text">Snippet text</label>
                    <textarea
                      id="snippet-edit-text"
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      maxLength={65_536}
                      rows={10}
                      required
                      disabled={saving}
                      spellCheck={false}
                    />
                    {actionError && <div className="sp-action-error" role="alert">
                      <p>{actionError}</p>
                      {reloadRequired && <button type="button" className="sp-button" disabled={saving} onClick={() => void reloadForEdit()}>Reload library</button>}
                    </div>}
                    {notice && <p className="sp-notice" role="status">{notice}</p>}
                    <div className="sp-editor-actions">
                      <button type="button" className="sp-button" onClick={cancelEditing} disabled={saving}>Cancel</button>
                      <button type="submit" className="sp-button sp-button-primary" disabled={saving || reloadRequired || !editName.trim() || !editText.trim()}>
                        {saving ? "Saving..." : "Save snippet"}
                      </button>
                    </div>
                    <p className="sp-editor-help">Saved to the shared library for every session.</p>
                  </form>
                ) : <>
                  <div className="sp-preview-heading">
                    <div>
                      <p>PREVIEW</p>
                      <h3>{selected.name}</h3>
                    </div>
                    <span>{selected.text.length.toLocaleString()} chars</span>
                  </div>
                  <p className="sp-preview-path">{snippetPath(selectedEntry)}</p>
                  {Boolean(selected.aliases?.length) && <p className="sp-aliases">Shortcuts: {selected.aliases?.join(" · ")}</p>}
                  <pre>{selected.text}</pre>
                  {actionError && <p className="sp-action-error" role="alert">{actionError}</p>}
                  {notice && <p className="sp-notice" role="status">{notice}</p>}
                  <div className="sp-preview-actions">
                    <button type="button" className="sp-button" onClick={beginEditing} disabled={choosing}>Edit snippet</button>
                    <button
                      type="button"
                      className="sp-button sp-button-primary"
                      onClick={() => void chooseSnippet()}
                      disabled={choosing}
                    >
                      {choosing ? "Inserting..." : "Insert"}
                    </button>
                  </div>
                  <p className="sp-editor-help">Insertion only updates the current draft. It never sends to tmux.</p>
                </>
              ) : (
                <div className="sp-preview-empty">
                  <span aria-hidden="true">_</span>
                  <strong>Select a snippet to preview it.</strong>
                  <p>Folders organize the library; only snippet leaves can be inserted.</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}
