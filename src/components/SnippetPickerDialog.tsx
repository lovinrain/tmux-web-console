import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getSnippetTree } from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  childrenForFolder,
  findSnippetNode,
  flattenSnippets,
  snippetFolderPath,
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

function matchesSearch(entry: SnippetSearchEntry, query: string): boolean {
  const searchable = [entry.snippet.name, entry.snippet.text, ...entry.path]
    .join("\n")
    .toLocaleLowerCase();
  return searchable.includes(query.toLocaleLowerCase());
}

export function SnippetPickerDialog({
  onClose,
  onChoose,
  onManage,
  title = "Insert a snippet",
}: SnippetPickerDialogProps) {
  const [tree, setTree] = useState<SnippetNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!choosing) onClose();
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
  }, [choosing, onClose]);

  const allSnippets = useMemo(() => flattenSnippets(tree), [tree]);
  const normalizedQuery = query.trim();
  const searchResults = useMemo(
    () => normalizedQuery ? allSnippets.filter((entry) => matchesSearch(entry, normalizedQuery)) : [],
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
  const selectedNode = selectedId ? findSnippetNode(tree, selectedId) : null;
  const selected = selectedNode?.type === "snippet" ? selectedNode : null;
  const selectedEntry = selected
    ? allSnippets.find((entry) => entry.snippet.id === selected.id) ?? null
    : null;

  const openFolder = (id: string | null) => {
    setFolderId(id);
    setSelectedId(null);
    setActionError(null);
  };

  const selectSnippet = (snippet: SnippetLeaf) => {
    setSelectedId(snippet.id);
    setActionError(null);
  };

  const chooseSnippet = async () => {
    if (!selected || choosing) return;
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
    if (!onManage || choosing) return;
    onManage();
    restoreFocusRef.current = false;
    onClose();
  };

  const closeFromBackdrop = () => {
    if (!choosing) onClose();
  };

  const stopKeyPropagation = (event: ReactKeyboardEvent) => {
    // Keep terminal-level keyboard listeners from receiving picker input.
    event.stopPropagation();
  };

  const renderSnippetButton = (entry: SnippetSearchEntry) => {
    const snippet = entry.snippet;
    const active = snippet.id === selectedId;
    return (
      <button
        type="button"
        className={active ? "sp-snippet-row active" : "sp-snippet-row"}
        key={snippet.id}
        onClick={() => selectSnippet(snippet)}
        aria-label={`Preview snippet ${snippet.name}`}
        aria-pressed={active}
      >
        <span className="sp-node-mark" aria-hidden="true">$</span>
        <span className="sp-node-copy">
          <strong>{snippet.name}</strong>
          <span>{snippetPath(entry)}</span>
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
        aria-busy={loading || choosing}
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
              <button type="button" className="sp-button" onClick={manageSnippets} disabled={choosing}>
                Manage
              </button>
            )}
            <button type="button" className="sp-close" onClick={onClose} disabled={choosing} aria-label="Close snippets">
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
              }}
              placeholder="Name, text, or folder path"
              autoComplete="off"
              disabled={loading}
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
              >
                Clear
              </button>
            )}
          </div>
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
          <div className="sp-content">
            <section className="sp-browser" aria-label="Snippet browser">
              <nav className="sp-breadcrumbs" aria-label="Snippet folder">
                <button
                  type="button"
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
                <>
                  <div className="sp-preview-heading">
                    <div>
                      <p>PREVIEW</p>
                      <h3>{selected.name}</h3>
                    </div>
                    <span>{selected.text.length.toLocaleString()} chars</span>
                  </div>
                  <p className="sp-preview-path">{snippetPath(selectedEntry)}</p>
                  <pre>{selected.text}</pre>
                  {actionError && <p className="sp-action-error" role="alert">{actionError}</p>}
                  <div className="sp-preview-actions">
                    <p>Insertion only updates the current draft. It never sends to tmux.</p>
                    <button
                      type="button"
                      className="sp-button sp-button-primary"
                      onClick={() => void chooseSnippet()}
                      disabled={choosing}
                    >
                      {choosing ? "Inserting..." : "Insert"}
                    </button>
                  </div>
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
