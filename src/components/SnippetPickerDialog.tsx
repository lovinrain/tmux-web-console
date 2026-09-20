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
  descendantFolderIds,
  findSnippetNode,
  flattenSnippets,
  folderOptions,
  insertSnippetNode,
  moveSnippetNode,
  newSnippetId,
  parseSnippetAliases,
  removeSnippetNode,
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

interface SnippetEditorState {
  mode: "create" | "edit";
  type: "snippet" | "folder";
  id: string;
}

function parentFolderId(tree: SnippetNode[], id: string): string | null {
  for (const folder of folderOptions(tree)) {
    if (childrenForFolder(tree, folder.id).some((node) => node.id === id)) return folder.id;
  }
  return null;
}

function nodeHeight(node: SnippetNode | null): number {
  return node?.type === "folder" && node.children.length
    ? 1 + Math.max(...node.children.map(nodeHeight)) : 1;
}

function descendantCount(node: SnippetNode): number {
  return node.type === "folder"
    ? node.children.reduce((count, child) => count + 1 + descendantCount(child), 0) : 0;
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
  const [editor, setEditor] = useState<SnippetEditorState | null>(null);
  const editing = editor !== null;
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [editAliases, setEditAliases] = useState("");
  const [editFolderId, setEditFolderId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleting = deleteId !== null;
  const [saving, setSaving] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (deleting) cancelDeleteRef.current?.focus();
  }, [deleting]);

  const cancelEditing = useCallback(() => {
    setEditor(null);
    setDeleteId(null);
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
          if (editing || deleting) cancelEditing();
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
  }, [cancelEditing, choosing, deleting, editing, onClose, saving]);

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
  const currentFolder = folderId ? findSnippetNode(tree, folderId) : null;
  const editorNode = editor?.mode === "edit" ? findSnippetNode(tree, editor.id) : null;
  const destinations = folderOptions(tree, editorNode ? descendantFolderIds(editorNode) : undefined)
    .filter((option) => option.depth + nodeHeight(editorNode) <= 12);
  const validDestination = destinations.some((option) => option.id === editFolderId);
  const deleteTarget = deleteId ? findSnippetNode(tree, deleteId) : null;
  const controlsLocked = editing || deleting || saving || choosing;

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
    if (!selected || controlsLocked) return;
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
    if (!onManage || controlsLocked) return;
    onManage();
    restoreFocusRef.current = false;
    onClose();
  };

  const closeFromBackdrop = () => {
    if (!controlsLocked) onClose();
  };

  const beginEditing = (node: SnippetNode) => {
    if (controlsLocked) return;
    if (node.type === "snippet") setSelectedId(node.id);
    setEditName(node.name);
    setEditText(node.type === "snippet" ? node.text : "");
    setEditAliases(node.type === "snippet" ? (node.aliases ?? []).join(", ") : "");
    setEditFolderId(parentFolderId(tree, node.id));
    setActionError(null);
    setNotice(null);
    setReloadRequired(false);
    setEditor({ mode: "edit", type: node.type, id: node.id });
  };

  const beginCreating = (type: "snippet" | "folder") => {
    if (controlsLocked || breadcrumbs.length >= 12) return;
    setEditName("");
    setEditText("");
    setEditAliases("");
    setEditFolderId(folderId);
    setActionError(null);
    setNotice(null);
    setReloadRequired(false);
    setEditor({ mode: "create", type, id: newSnippetId(type) });
  };

  const beginDeleting = (node: SnippetNode) => {
    if (controlsLocked) return;
    setDeleteId(node.id);
    setActionError(null);
    setNotice(null);
    setReloadRequired(false);
  };

  const persist = async (next: SnippetNode[], onSaved: () => void) => {
    setSaving(true);
    setActionError(null);
    try {
      const saved = await saveSnippetTree(next, revision);
      if (!mountedRef.current) return;
      setTree(saved.tree);
      setRevision(saved.revision);
      onSaved();
      window.requestAnimationFrame(() => searchRef.current?.focus());
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof ApiRequestError && error.status === 409) {
        setReloadRequired(true);
        setActionError(editing
          ? "The library changed in another tab. Reload the latest library before saving again. Your edits will be kept."
          : "The library changed in another tab. Reload it and review the item before confirming deletion again.");
      } else {
        setActionError(errorMessage(error, "Unable to update the snippet library."));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editor || saving || reloadRequired || !validDestination) return;
    setActionError(null);
    const name = editName.trim();
    if (!name || (editor.type === "snippet" && !editText.trim())) return;
    let next: SnippetNode[];
    try {
      const aliases = editor.type === "snippet" ? parseSnippetAliases(editAliases) : [];
      if (editor.mode === "create") {
        const node: SnippetNode = editor.type === "folder"
          ? { id: editor.id, type: "folder", name, children: [] }
          : { id: editor.id, type: "snippet", name, text: editText, aliases };
        next = insertSnippetNode(tree, editFolderId, node);
      } else {
        if (!editorNode || editorNode.type !== editor.type) throw new Error("This item no longer exists. Copy your edits before canceling.");
        next = updateSnippetNode(tree, editor.id, (node) => (
          node.type === "snippet" ? { ...node, name, text: editText, aliases } : { ...node, name }
        ));
        if (parentFolderId(tree, editor.id) !== editFolderId) {
          next = moveSnippetNode(next, editor.id, editFolderId);
        }
      }
    } catch (error) {
      setActionError(errorMessage(error, "Check the snippet fields."));
      return;
    }
    await persist(next, () => {
      setQuery("");
      setFolderId(editor.type === "folder" ? editor.id : editFolderId);
      setSelectedId(editor.type === "snippet" ? editor.id : null);
      setEditor(null);
      setNotice(`${editor.type === "snippet" ? "Snippet" : "Folder"} saved to the shared library.`);
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget || saving || reloadRequired) return;
    const removedFolders = descendantFolderIds(deleteTarget);
    await persist(removeSnippetNode(tree, deleteTarget.id).tree, () => {
      if (folderId && removedFolders.has(folderId)) setFolderId(parentFolderId(tree, deleteTarget.id));
      setSelectedId(null);
      setDeleteId(null);
      setNotice(`${deleteTarget.type === "snippet" ? "Snippet" : "Folder"} deleted from the shared library.`);
    });
  };

  const reloadForEdit = async () => {
    if (saving || (!editor && !deleteId)) return;
    setSaving(true);
    try {
      const snapshot = await getSnippetTree();
      if (!mountedRef.current) return;
      setTree(snapshot.tree);
      setRevision(snapshot.revision);
      if (folderId && findSnippetNode(snapshot.tree, folderId)?.type !== "folder") setFolderId(null);
      if (selectedId && findSnippetNode(snapshot.tree, selectedId)?.type !== "snippet") setSelectedId(null);
      if (editor?.mode === "edit" && findSnippetNode(snapshot.tree, editor.id)?.type !== editor.type) {
        setActionError("This item was deleted elsewhere. Copy your edits before canceling.");
        return;
      }
      setReloadRequired(false);
      setActionError(null);
      if (deleteId && !findSnippetNode(snapshot.tree, deleteId)) {
        setDeleteId(null);
        setSelectedId(null);
        setNotice("This item was already deleted elsewhere.");
      } else {
        setNotice(editor
          ? "Latest library loaded. Review the location and save your edits when ready."
          : "Latest library loaded. Review the item before confirming deletion.");
      }
    } catch (error) {
      if (mountedRef.current) setActionError(errorMessage(error, "Unable to reload snippets."));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || controlsLocked || loading) return;
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
        disabled={controlsLocked}
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
            <p id="snippet-picker-description">Create, edit, and organize snippets, then insert into your draft.</p>
          </div>
          <div className="sp-header-actions">
            {onManage && (
              <button type="button" className="sp-button" onClick={manageSnippets} disabled={controlsLocked}>
                Manage
              </button>
            )}
            <button type="button" className="sp-close" onClick={onClose} disabled={controlsLocked} aria-label="Close snippets">
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
              disabled={loading || controlsLocked}
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
                disabled={controlsLocked}
              >
                Clear
              </button>
            )}
          </div>
          <p className="sp-search-help">Shortcut matches come first. ↑ ↓ to preview · Enter to insert.</p>
        </div>

        {!loading && !loadError && <div className="sp-library-tools" role="toolbar" aria-label="Snippet library actions">
          <button type="button" className="sp-button sp-button-primary" onClick={() => beginCreating("snippet")} disabled={controlsLocked || breadcrumbs.length >= 12}>New snippet</button>
          <button type="button" className="sp-button" onClick={() => beginCreating("folder")} disabled={controlsLocked || breadcrumbs.length >= 12}>New folder</button>
          {currentFolder?.type === "folder" && !normalizedQuery && <>
            <button type="button" className="sp-button" onClick={() => beginEditing(currentFolder)} disabled={controlsLocked}>Edit folder</button>
            <button type="button" className="sp-button sp-button-danger" onClick={() => beginDeleting(currentFolder)} disabled={controlsLocked}>Delete folder</button>
          </>}
          {breadcrumbs.length >= 12 && <span>Folder nesting limit reached. Choose a parent folder to add items.</span>}
        </div>}
        {notice && <p className="sp-notice sp-library-notice" role="status">{notice}</p>}

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
          <div className={editing || deleting ? "sp-content sp-content-editing" : "sp-content"}>
            <section className="sp-browser" aria-label="Snippet browser">
              <nav className="sp-breadcrumbs" aria-label="Snippet folder">
                <button
                  type="button"
                  disabled={controlsLocked}
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
                      disabled={controlsLocked}
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
                            disabled={controlsLocked}
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
                    <span>Use New snippet or New folder above to build your library here.</span>
                  </div>
                )}
              </div>
            </section>

            <aside className={selected || editor || deleteTarget ? "sp-preview selected" : "sp-preview"} aria-label="Snippet preview">
              {editor ? (
                <form className="sp-editor" onSubmit={(event) => {
                  event.preventDefault();
                  void saveEdit();
                }}>
                  <div className="sp-preview-heading"><div>
                    <p>SHARED LIBRARY</p>
                    <h3>{editor.mode === "create" ? "New" : "Edit"} {editor.type}</h3>
                  </div></div>
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
                  {editor.type === "snippet" && <>
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
                  </>}
                  <label htmlFor="snippet-edit-location">Location</label>
                  <select
                    id="snippet-edit-location"
                    value={editFolderId ?? ""}
                    onChange={(event) => setEditFolderId(event.target.value || null)}
                    disabled={saving}
                  >
                    {!validDestination && <option value={editFolderId ?? ""} disabled>Choose an available folder</option>}
                    {destinations.map((option) => <option key={option.id ?? "root"} value={option.id ?? ""}>{option.label}</option>)}
                  </select>
                  {actionError && <div className="sp-action-error" role="alert">
                    <p>{actionError}</p>
                    {reloadRequired && <button type="button" className="sp-button" disabled={saving} onClick={() => void reloadForEdit()}>Reload library</button>}
                  </div>}
                  <div className="sp-editor-actions">
                    <button type="button" className="sp-button" onClick={cancelEditing} disabled={saving}>Cancel</button>
                    <button type="submit" className="sp-button sp-button-primary" disabled={saving || reloadRequired || !validDestination || !editName.trim() || (editor.type === "snippet" && !editText.trim())}>
                      {saving ? "Saving..." : `Save ${editor.type}`}
                    </button>
                  </div>
                  <p className="sp-editor-help">Saved to the shared library for every session.</p>
                </form>
              ) : deleteTarget ? (
                <section className="sp-delete-confirmation" role="alertdialog" aria-labelledby="snippet-delete-heading" aria-describedby="snippet-delete-description">
                  <h3 id="snippet-delete-heading">Delete {deleteTarget.type}</h3>
                  <p id="snippet-delete-description">
                    Delete <strong>{deleteTarget.name}</strong>{deleteTarget.type === "folder" ? ` and all ${descendantCount(deleteTarget)} items inside it` : ""} from the shared library? This cannot be undone.
                  </p>
                  {deleteTarget.type === "snippet" && <pre>{deleteTarget.text}</pre>}
                  {actionError && <div className="sp-action-error" role="alert">
                    <p>{actionError}</p>
                    {reloadRequired && <button type="button" className="sp-button" disabled={saving} onClick={() => void reloadForEdit()}>Reload library</button>}
                  </div>}
                  <div className="sp-editor-actions">
                    <button ref={cancelDeleteRef} type="button" className="sp-button" onClick={cancelEditing} disabled={saving}>Cancel</button>
                    <button type="button" className="sp-button sp-button-danger" onClick={() => void confirmDelete()} disabled={saving || reloadRequired}>
                      {saving ? "Deleting..." : `Delete ${deleteTarget.type}`}
                    </button>
                  </div>
                </section>
              ) : selected && selectedEntry ? (
                <>
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
                  <div className="sp-preview-actions">
                    <button type="button" className="sp-button" onClick={() => beginEditing(selected)} disabled={choosing}>Edit snippet</button>
                    <button type="button" className="sp-button sp-button-danger" onClick={() => beginDeleting(selected)} disabled={choosing}>Delete snippet</button>
                    <button type="button" className="sp-button sp-button-primary" onClick={() => void chooseSnippet()} disabled={choosing}>
                      {choosing ? "Inserting..." : "Insert"}
                    </button>
                  </div>
                  <p className="sp-editor-help">Insertion only updates the current draft. It never sends to tmux.</p>
                </>
              ) : (
                <div className="sp-preview-empty">
                  <span aria-hidden="true">_</span>
                  <strong>Select a snippet to preview it.</strong>
                  <p>Create a snippet here, or choose an existing one to edit, delete, or insert.</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}
