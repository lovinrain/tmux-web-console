import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ApiRequestError, getSnippetTree, saveSnippetTree } from "../api";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  EditIcon,
  FolderIcon,
  SearchIcon,
  SnippetIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import {
  childrenForFolder,
  descendantFolderIds,
  findSnippetFolder,
  findSnippetNode,
  flattenSnippets,
  folderOptions,
  insertSnippetNode,
  moveSnippetNode,
  newSnippetId,
  removeSnippetNode,
  reorderSnippetNode,
  snippetFolderPath,
  updateSnippetNode,
} from "../snippets";
import type { SnippetLeaf, SnippetNode, SnippetTree } from "../types";
import { AppTabs } from "./AppTabs";
import { ThemeToggle } from "./ThemeToggle";
import "./SnippetLibrary.css";

const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 65_536;
// Keep client-side destinations within the validator limit enforced by the API.
const MAX_TREE_DEPTH = 12;

interface SnippetLibraryProps {
  onOpenSessions: () => void;
}

interface EditorState {
  mode: "add" | "edit";
  type: "folder" | "snippet";
  nodeId: string | null;
  parentId: string | null;
}

interface EditorResult {
  name: string;
  text: string;
  destinationId: string | null;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function countDescendants(node: SnippetNode): number {
  if (node.type === "snippet") return 0;
  return node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
}

function nodeTreeHeight(node: SnippetNode): number {
  if (node.type === "snippet" || node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(nodeTreeHeight));
}

function folderParentId(tree: SnippetNode[], nodeId: string): string | null {
  const walk = (nodes: SnippetNode[], parentId: string | null): string | null | undefined => {
    for (const node of nodes) {
      if (node.id === nodeId) return parentId;
      if (node.type === "folder") {
        const found = walk(node.children, node.id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(tree, null) ?? null;
}

function FolderOutline({
  nodes,
  activeId,
  onOpen,
}: {
  nodes: SnippetNode[];
  activeId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const folders = nodes.filter((node) => node.type === "folder");
  if (folders.length === 0) return null;
  return (
    <ul className="snippet-outline-list">
      {folders.map((node) => node.type === "folder" && (
        <li key={node.id}>
          <button
            type="button"
            className={activeId === node.id ? "active" : ""}
            onClick={() => onOpen(node.id)}
          >
            <FolderIcon />
            <span>{node.name}</span>
            <small>{node.children.length}</small>
          </button>
          <FolderOutline nodes={node.children} activeId={activeId} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function SnippetEditorDialog({
  state,
  tree,
  saving,
  saveError,
  reloadRequired,
  onClose,
  onReload,
  onSave,
}: {
  state: EditorState;
  tree: SnippetNode[];
  saving: boolean;
  saveError: string | null;
  reloadRequired: boolean;
  onClose: () => void;
  onReload: () => void;
  onSave: (result: EditorResult) => void | Promise<void>;
}) {
  const node = state.nodeId ? findSnippetNode(tree, state.nodeId) : null;
  const nameRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const destinationRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [nameLength, setNameLength] = useState(node?.name.length ?? 0);
  const [textLength, setTextLength] = useState(node?.type === "snippet" ? node.text.length : 0);
  const [textHasContent, setTextHasContent] = useState(
    node?.type === "snippet" ? Boolean(node.text.trim()) : false,
  );
  const excluded = node ? descendantFolderIds(node) : new Set<string>();
  const movingHeight = node ? nodeTreeHeight(node) : 1;
  const destinations = folderOptions(tree, excluded).filter(
    (destination) => destination.depth + movingHeight <= MAX_TREE_DEPTH,
  );
  const initialDestination = state.mode === "add"
    ? state.parentId
    : state.nodeId
      ? folderParentId(tree, state.nodeId)
      : null;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>(".snippet-root-button")?.focus();
    };
  }, [onClose, saving]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    const text = textRef.current?.value ?? "";
    if (!name || name.length > MAX_NAME_LENGTH) return;
    if (state.type === "snippet" && (!text || text.length > MAX_TEXT_LENGTH)) return;
    const rawDestination = destinationRef.current?.value ?? "";
    const destinationId = rawDestination || null;
    if (!destinations.some((destination) => destination.id === destinationId)) return;
    void onSave({
      name,
      text,
      destinationId,
    });
  };

  const stopPropagation = (event: ReactKeyboardEvent) => event.stopPropagation();
  const valid = nameLength > 0
    && nameLength <= MAX_NAME_LENGTH
    && (state.type === "folder" || (
      textHasContent && textLength > 0 && textLength <= MAX_TEXT_LENGTH
    ));

  return (
    <div className="snippet-editor-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <section
        ref={dialogRef}
        className="snippet-editor-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snippet-editor-heading"
        onKeyDown={stopPropagation}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{state.mode === "add" ? "CREATE" : "CONFIGURE"} / {state.type.toUpperCase()}</p>
            <h2 id="snippet-editor-heading">
              {state.mode === "add" ? `New ${state.type}` : `Edit ${state.type}`}
            </h2>
          </div>
          <button type="button" className="snippet-icon-button" onClick={onClose} disabled={saving} aria-label="Close snippet editor">
            <CloseIcon />
          </button>
        </header>
        <form onSubmit={submit}>
          <label htmlFor="snippet-node-name">Name</label>
          <input
            ref={nameRef}
            id="snippet-node-name"
            defaultValue={node?.name ?? ""}
            maxLength={MAX_NAME_LENGTH + 1}
            onInput={(event) => setNameLength(event.currentTarget.value.trim().length)}
            placeholder={state.type === "folder" ? "Deployment" : "Review the current diff"}
          />
          <span className="snippet-field-count">{nameLength} / {MAX_NAME_LENGTH}</span>

          {state.type === "snippet" && (
            <>
              <label htmlFor="snippet-node-text">Snippet text</label>
              <textarea
                ref={textRef}
                id="snippet-node-text"
                defaultValue={node?.type === "snippet" ? node.text : ""}
                rows={9}
                maxLength={MAX_TEXT_LENGTH + 1}
                onInput={(event) => {
                  setTextLength(event.currentTarget.value.length);
                  setTextHasContent(Boolean(event.currentTarget.value.trim()));
                }}
                placeholder="Type, paste, or dictate the reusable input exactly as it should be staged..."
              />
              <span className="snippet-field-count">{textLength.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}</span>
            </>
          )}

          <label htmlFor="snippet-node-destination">Location</label>
          <select ref={destinationRef} id="snippet-node-destination" defaultValue={initialDestination ?? ""}>
            {destinations.map((option) => (
              <option key={option.id ?? "root"} value={option.id ?? ""}>{option.label}</option>
            ))}
          </select>

          {saveError && (
            <div className="snippet-editor-error" role="alert">
              <div>
                <strong>{reloadRequired ? "The library changed elsewhere." : "The save did not finish."}</strong>
                <span>{saveError}</span>
              </div>
              {reloadRequired ? (
                <button type="button" onClick={onReload} disabled={saving}>Reload library</button>
              ) : (
                <span>Check the connection, then choose Save to retry.</span>
              )}
            </div>
          )}

          <footer>
            <p>Saved globally. Choosing a snippet later only stages it; it never sends automatically.</p>
            <div>
              <button type="button" className="snippet-secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="snippet-primary-button" disabled={!valid || saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function SnippetDeleteDialog({
  target,
  saving,
  saveError,
  reloadRequired,
  onClose,
  onReload,
  onConfirm,
}: {
  target: SnippetNode;
  saving: boolean;
  saveError: string | null;
  reloadRequired: boolean;
  onClose: () => void;
  onReload: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);
  closeRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      if (cancelRef.current) cancelRef.current.focus();
      else dialogRef.current?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (savingRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ));
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
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>(".snippet-root-button")?.focus();
    };
  }, []);

  return (
    <div className="snippet-delete-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="snippet-delete-heading"
        aria-describedby="snippet-delete-description"
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">DESTRUCTIVE ACTION</p>
        <h2 id="snippet-delete-heading">Delete {target.name}?</h2>
        <p id="snippet-delete-description">
          {target.type === "folder"
            ? `This removes the folder and all ${countDescendants(target)} descendant nodes.`
            : "This removes the reusable snippet from the global library."}
        </p>
        {saveError && (
          <div className="snippet-editor-error snippet-delete-error" role="alert">
            <div>
              <strong>{reloadRequired ? "The library changed elsewhere." : "The delete did not finish."}</strong>
              <span>{saveError}</span>
            </div>
            {reloadRequired ? (
              <button type="button" onClick={onReload} disabled={saving}>Reload library</button>
            ) : (
              <span>Check the connection, then choose Delete to retry.</span>
            )}
          </div>
        )}
        <div className="snippet-delete-actions">
          <button ref={cancelRef} type="button" className="snippet-secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="snippet-danger-button" onClick={() => void onConfirm()} disabled={saving}>{saving ? "Deleting..." : "Delete"}</button>
        </div>
      </section>
    </div>
  );
}

export function SnippetLibrary({ onOpenSessions }: SnippetLibraryProps) {
  const [library, setLibrary] = useState<SnippetTree>({ revision: 0, tree: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await getSnippetTree(signal);
      setLibrary(next);
      setSaveError(null);
      setReloadRequired(false);
      setCurrentFolderId((current) => (
        current && !findSnippetFolder(next.tree, current) ? null : current
      ));
    } catch (loadError) {
      if (!signal?.aborted) setError(errorText(loadError, "Unable to load snippets"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Snippets - Muxdeck";
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const persist = async (tree: SnippetNode[], message: string): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    setReloadRequired(false);
    setNotice(null);
    try {
      const saved = await saveSnippetTree(tree, library.revision);
      setLibrary(saved);
      setNotice(message);
      return true;
    } catch (saveFailure) {
      if (saveFailure instanceof ApiRequestError && saveFailure.status === 409) {
        setSaveError("This library changed in another browser. Reload it before saving again.");
        setReloadRequired(true);
      } else {
        setSaveError(errorText(saveFailure, "Unable to save the snippet library"));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const currentFolder = findSnippetFolder(library.tree, currentFolderId);
  const currentItems = childrenForFolder(library.tree, currentFolderId);
  const breadcrumbs = snippetFolderPath(library.tree, currentFolderId);
  const canCreateInCurrentFolder = breadcrumbs.length < MAX_TREE_DEPTH;
  const allSnippets = useMemo(() => flattenSnippets(library.tree), [library.tree]);
  const folderCount = useMemo(() => folderOptions(library.tree).length - 1, [library.tree]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchResults = normalizedQuery
    ? allSnippets.filter(({ snippet, path }) => (
      `${path.join(" ")} ${snippet.name} ${snippet.text}`.toLocaleLowerCase().includes(normalizedQuery)
    ))
    : [];

  const saveEditor = async ({ name, text, destinationId }: EditorResult) => {
    if (!editor) return;
    let nextTree = library.tree;
    if (editor.mode === "add") {
      const node: SnippetNode = editor.type === "folder"
        ? { id: newSnippetId("folder"), type: "folder", name, children: [] }
        : { id: newSnippetId("snippet"), type: "snippet", name, text };
      nextTree = insertSnippetNode(nextTree, destinationId, node);
    } else if (editor.nodeId) {
      nextTree = updateSnippetNode(nextTree, editor.nodeId, (node): SnippetNode => (
        node.type === "folder"
          ? { ...node, name }
          : { ...node, name, text }
      ));
      const currentParent = folderParentId(nextTree, editor.nodeId);
      if (currentParent !== destinationId) {
        nextTree = moveSnippetNode(nextTree, editor.nodeId, destinationId);
      }
    }
    if (await persist(nextTree, `${editor.type === "folder" ? "Folder" : "Snippet"} saved.`)) {
      setEditor(null);
    }
  };

  const deleteTarget = deleteTargetId ? findSnippetNode(library.tree, deleteTargetId) : null;
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const next = removeSnippetNode(library.tree, deleteTarget.id).tree;
    if (await persist(next, `${deleteTarget.type === "folder" ? "Folder" : "Snippet"} deleted.`)) {
      if (currentFolderId === deleteTarget.id) setCurrentFolderId(null);
      setDeleteTargetId(null);
    }
  };

  const reorder = async (id: string, direction: -1 | 1) => {
    const next = reorderSnippetNode(library.tree, id, direction);
    if (next !== library.tree) await persist(next, "Order updated.");
  };

  const openEditor = (type: "folder" | "snippet", nodeId: string | null = null) => {
    if (!nodeId && !canCreateInCurrentFolder) return;
    setEditor({
      mode: nodeId ? "edit" : "add",
      type,
      nodeId,
      parentId: currentFolderId,
    });
    setNotice(null);
    setSaveError(null);
    setReloadRequired(false);
  };

  const reloadFromEditor = () => {
    setEditor(null);
    setSaveError(null);
    setReloadRequired(false);
    void load();
  };

  return (
    <main className="snippet-library-shell">
      <div className="ambient-grid" />
      <header className="snippet-library-header">
        <div className="brand-lockup">
          <div className="brand-mark"><TerminalIcon /></div>
          <div>
            <p className="eyebrow">TMUX FIELD CONSOLE</p>
            <h1>Muxdeck</h1>
          </div>
        </div>
        <div className="snippet-library-header-tools">
          <AppTabs active="snippets" onSessions={onOpenSessions} onSnippets={() => undefined} />
          <ThemeToggle />
        </div>
      </header>

      <section className="snippet-library-intro">
        <div>
          <p className="section-index">02 / REUSABLE INPUT</p>
          <h2>Keep the good<br />instructions close.</h2>
        </div>
        <p>Build a shared tree of prompts, commands, and recurring instructions. Folders can nest; snippets remain leaves, ready to stage in any tmux session.</p>
      </section>

      <section className="snippet-library-toolbar" aria-label="Snippet library controls">
        <label className="snippet-search-field">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search names, paths, or snippet text"
            aria-label="Search snippets"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query && (
            <button type="button" onClick={() => {
              if (searchRef.current) searchRef.current.value = "";
              setQuery("");
              searchRef.current?.focus();
            }}>Clear</button>
          )}
        </label>
        <div className="snippet-create-actions">
          <button
            type="button"
            onClick={() => openEditor("folder")}
            disabled={loading || saving || !canCreateInCurrentFolder}
            title={!canCreateInCurrentFolder ? `Folders cannot be nested deeper than ${MAX_TREE_DEPTH} levels` : undefined}
          >
            <FolderIcon /> New folder
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => openEditor("snippet")}
            disabled={loading || saving || !canCreateInCurrentFolder}
            title={!canCreateInCurrentFolder ? `Snippets cannot be nested deeper than ${MAX_TREE_DEPTH} levels` : undefined}
          >
            <SnippetIcon /> New snippet
          </button>
        </div>
      </section>

      {error && (
        <div className="snippet-library-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {saveError && !editor && !deleteTarget && (
        <div className="snippet-library-alert conflict" role="alert">
          <span>{saveError}</span>
          <button type="button" onClick={() => void load()}>Reload library</button>
        </div>
      )}
      {notice && <div className="snippet-library-notice" role="status">{notice}</div>}

      <section className="snippet-workspace" aria-busy={loading || saving}>
        <aside className="snippet-outline" aria-label="Folder outline">
          <header>
            <div>
              <p className="eyebrow">TREE ROOT</p>
              <h2>Library</h2>
            </div>
            <span>{folderCount} folder / {allSnippets.length} snippet</span>
          </header>
          <button
            type="button"
            className={currentFolderId === null ? "snippet-root-button active" : "snippet-root-button"}
            onClick={() => setCurrentFolderId(null)}
          >
            <span className="snippet-root-glyph">/</span>
            <span>Library root</span>
            <small>{library.tree.length}</small>
          </button>
          <FolderOutline nodes={library.tree} activeId={currentFolderId} onOpen={setCurrentFolderId} />
        </aside>

        <div className="snippet-browser">
          <header className="snippet-browser-header">
            <nav aria-label="Snippet folder path" className="snippet-breadcrumbs">
              <button type="button" onClick={() => setCurrentFolderId(null)}>Root</button>
              {breadcrumbs.map((folder) => (
                <span key={folder.id}>
                  <b>/</b>
                  <button type="button" onClick={() => setCurrentFolderId(folder.id)}>{folder.name}</button>
                </span>
              ))}
            </nav>
            <div>
              <p className="eyebrow">{normalizedQuery ? "SEARCH RESULTS" : "CURRENT NODE"}</p>
              <h2>{normalizedQuery ? `${searchResults.length} matches` : currentFolder?.name || "Library root"}</h2>
            </div>
          </header>

          {loading ? (
            <div className="snippet-browser-state">Loading the snippet tree...</div>
          ) : normalizedQuery ? (
            searchResults.length === 0 ? (
              <div className="snippet-browser-state">
                <SearchIcon /><strong>No snippets found</strong><span>Try a name, folder, or phrase from the snippet text.</span>
              </div>
            ) : (
              <ol className="snippet-search-results">
                {searchResults.map(({ snippet, path }) => (
                  <li key={snippet.id}>
                    <div>
                      <p>{path.length ? `Root / ${path.join(" / ")}` : "Root"}</p>
                      <h3><SnippetIcon />{snippet.name}</h3>
                      <pre>{snippet.text}</pre>
                    </div>
                    <button type="button" onClick={() => openEditor("snippet", snippet.id)}><EditIcon /> Edit</button>
                  </li>
                ))}
              </ol>
            )
          ) : currentItems.length === 0 ? (
            <div className="snippet-browser-state empty">
              <span className="snippet-empty-mark">{"{}"}</span>
              <strong>This node is empty.</strong>
              <span>Add a child folder or a snippet here.</span>
              {!canCreateInCurrentFolder && (
                <span>This folder is at the maximum nesting depth. Move up to add another node.</span>
              )}
              <div>
                <button type="button" onClick={() => openEditor("folder")} disabled={!canCreateInCurrentFolder}><FolderIcon /> New folder</button>
                <button type="button" onClick={() => openEditor("snippet")} disabled={!canCreateInCurrentFolder}><SnippetIcon /> New snippet</button>
              </div>
            </div>
          ) : (
            <ol className="snippet-node-list">
              {currentItems.map((node, index) => (
                <li className={`snippet-node-row ${node.type}`} key={node.id}>
                  <button
                    type="button"
                    className="snippet-node-main"
                    onClick={() => node.type === "folder" ? setCurrentFolderId(node.id) : openEditor("snippet", node.id)}
                    aria-label={`${node.type === "folder" ? "Open folder" : "Edit snippet"} ${node.name}`}
                  >
                    <span className="snippet-node-icon">{node.type === "folder" ? <FolderIcon /> : <SnippetIcon />}</span>
                    <span className="snippet-node-copy">
                      <small>{node.type === "folder" ? `NODE / ${node.children.length} CHILDREN` : "LEAF / REUSABLE INPUT"}</small>
                      <strong>{node.name}</strong>
                      {node.type === "snippet" && <span>{node.text}</span>}
                    </span>
                  </button>
                  <div className="snippet-node-actions">
                    <button type="button" onClick={() => void reorder(node.id, -1)} disabled={saving || index === 0} aria-label={`Move ${node.name} up`}><ArrowUpIcon /></button>
                    <button type="button" onClick={() => void reorder(node.id, 1)} disabled={saving || index === currentItems.length - 1} aria-label={`Move ${node.name} down`}><ArrowDownIcon /></button>
                    <button type="button" onClick={() => openEditor(node.type, node.id)} disabled={saving} aria-label={`Edit ${node.name}`}><EditIcon /></button>
                    <button type="button" className="danger" onClick={() => setDeleteTargetId(node.id)} disabled={saving} aria-label={`Delete ${node.name}`}><TrashIcon /></button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      {editor && (
        <SnippetEditorDialog
          key={`${editor.mode}:${editor.nodeId ?? editor.parentId ?? "root"}:${editor.type}`}
          state={editor}
          tree={library.tree}
          saving={saving}
          saveError={saveError}
          reloadRequired={reloadRequired}
          onClose={() => setEditor(null)}
          onReload={reloadFromEditor}
          onSave={saveEditor}
        />
      )}

      {deleteTarget && (
        <SnippetDeleteDialog
          target={deleteTarget}
          saving={saving}
          saveError={saveError}
          reloadRequired={reloadRequired}
          onClose={() => setDeleteTargetId(null)}
          onReload={() => {
            setDeleteTargetId(null);
            setSaveError(null);
            setReloadRequired(false);
            void load();
          }}
          onConfirm={confirmDelete}
        />
      )}
    </main>
  );
}
