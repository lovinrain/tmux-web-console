import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { listWorkspaces, type SavedWorkspace } from "../api";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  GridIcon,
  RefreshIcon,
  SearchIcon,
} from "../icons";

interface WorkspaceQuickSwitcherProps {
  activeWorkspaceId: string | null;
  activeWorkspaceName: string;
  disabled?: boolean;
  onSwitch: (workspace: SavedWorkspace) => void;
}

function compareWorkspaces(left: SavedWorkspace, right: SavedWorkspace): number {
  const nameOrder = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return nameOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function sessionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

export function WorkspaceQuickSwitcher({
  activeWorkspaceId,
  activeWorkspaceName,
  disabled = false,
  onSwitch,
}: WorkspaceQuickSwitcherProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = `${useId()}-workspace-list`;
  const [workspaces, setWorkspaces] = useState<SavedWorkspace[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void listWorkspaces(controller.signal).then((items) => {
      setWorkspaces([...items].sort(compareWorkspaces));
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Unable to load workspaces");
      setLoading(false);
    });
    return () => controller.abort();
  }, [reloadToken]);

  const activeIndex = workspaces.findIndex((workspace) => (
    workspace.id === activeWorkspaceId
  ));
  const hasAlternative = activeIndex < 0
    ? workspaces.length > 0
    : workspaces.length > 1;
  const previousWorkspace = hasAlternative
    ? workspaces[(activeIndex < 0
      ? workspaces.length - 1
      : activeIndex - 1 + workspaces.length)
      % workspaces.length]
    : null;
  const nextWorkspace = hasAlternative
    ? workspaces[(activeIndex < 0 ? 0 : activeIndex + 1) % workspaces.length]
    : null;
  const positionLabel = activeIndex >= 0
    ? `${activeIndex + 1}/${workspaces.length}`
    : `0/${workspaces.length}`;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredWorkspaces = useMemo(() => workspaces.filter((workspace) => (
    !normalizedQuery
    || workspace.name.toLocaleLowerCase().includes(normalizedQuery)
    || workspace.tabs.some((tab) => tab.toLocaleLowerCase().includes(normalizedQuery))
  )), [normalizedQuery, workspaces]);
  const filteredIds = filteredWorkspaces.map((workspace) => workspace.id).join("\u0000");

  useEffect(() => {
    if (!open) return;
    const current = filteredWorkspaces.find((workspace) => (
      workspace.id === activeWorkspaceId
    ));
    setHighlightedId(current?.id ?? filteredWorkspaces[0]?.id ?? null);
  }, [activeWorkspaceId, filteredIds, filteredWorkspaces, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const closeFromOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("keydown", closeFromEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !highlightedId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`${listId}-${highlightedId}`)?.scrollIntoView?.({
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedId, listId, open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setQuery("");
  }, [disabled]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const switchTo = useCallback((workspace: SavedWorkspace) => {
    close();
    if (workspace.id !== activeWorkspaceId) onSwitch(workspace);
  }, [activeWorkspaceId, close, onSwitch]);

  const cycleTo = (workspace: SavedWorkspace | null) => {
    if (!workspace || disabled || loading || loadError) return;
    switchTo(workspace);
  };

  const toggle = () => {
    if (disabled) return;
    if (open) {
      close(true);
      return;
    }
    setOpen(true);
    setQuery("");
    if (!loading) setReloadToken((current) => current + 1);
  };

  const navigateResults = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") return;
    if (event.key === "Enter" && highlightedId) {
      const highlighted = filteredWorkspaces.find((workspace) => (
        workspace.id === highlightedId
      ));
      if (highlighted) {
        event.preventDefault();
        switchTo(highlighted);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (filteredWorkspaces.length === 0) return;
    event.preventDefault();
    const currentIndex = filteredWorkspaces.findIndex((workspace) => (
      workspace.id === highlightedId
    ));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? filteredWorkspaces.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + filteredWorkspaces.length) % filteredWorkspaces.length
          : (currentIndex - 1 + filteredWorkspaces.length) % filteredWorkspaces.length;
    setHighlightedId(filteredWorkspaces[nextIndex].id);
  };

  return (
    <div
      ref={containerRef}
      className="workspace-quick-switcher"
      aria-label="Workspace quick switcher"
    >
      <button
        type="button"
        className="workspace-quick-switcher-cycle previous"
        onClick={() => cycleTo(previousWorkspace)}
        disabled={disabled || loading || Boolean(loadError) || !previousWorkspace}
        aria-label={previousWorkspace
          ? `Switch to previous workspace: ${previousWorkspace.name}`
          : "No previous workspace"}
        title={previousWorkspace
          ? `Previous workspace: ${previousWorkspace.name}`
          : "No other saved workspace"}
      >
        <ArrowLeftIcon />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className={open
          ? "workspace-quick-switcher-toggle active"
          : "workspace-quick-switcher-toggle"}
        onClick={toggle}
        disabled={disabled}
        aria-label="Choose workspace"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="muxdeck-workspace-quick-switcher"
        title={`Switch workspace - ${activeWorkspaceName}`}
      >
        <GridIcon />
        <span>Switch</span>
        <small>{loading && workspaces.length === 0 ? "..." : positionLabel}</small>
        <ArrowDownIcon />
      </button>
      <button
        type="button"
        className="workspace-quick-switcher-cycle next"
        onClick={() => cycleTo(nextWorkspace)}
        disabled={disabled || loading || Boolean(loadError) || !nextWorkspace}
        aria-label={nextWorkspace
          ? `Switch to next workspace: ${nextWorkspace.name}`
          : "No next workspace"}
        title={nextWorkspace
          ? `Next workspace: ${nextWorkspace.name}`
          : "No other saved workspace"}
      >
        <ChevronRightIcon />
      </button>

      {open && (
        <section
          id="muxdeck-workspace-quick-switcher"
          className="workspace-quick-switcher-panel"
          role="dialog"
          aria-label="Switch workspace"
          aria-busy={loading}
          onKeyDown={navigateResults}
        >
          <header>
            <div>
              <span>WORKSPACE HOP</span>
              <h2>Switch in this tab</h2>
            </div>
            <strong>{activeWorkspaceName}</strong>
          </header>

          <label className="workspace-quick-switcher-search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or session"
              aria-label="Search saved workspaces"
              aria-controls={listId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={highlightedId
                ? `${listId}-${highlightedId}`
                : undefined}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear workspace search"
              >
                Clear
              </button>
            )}
          </label>

          {loadError ? (
            <div className="workspace-quick-switcher-message" role="alert">
              <p>{loadError}</p>
              <button type="button" onClick={() => setReloadToken((current) => current + 1)}>
                <RefreshIcon /> Retry
              </button>
            </div>
          ) : loading && workspaces.length === 0 ? (
            <div className="workspace-quick-switcher-message" role="status">
              <RefreshIcon /> Loading saved workspaces...
            </div>
          ) : filteredWorkspaces.length === 0 ? (
            <div className="workspace-quick-switcher-message" role="status">
              {workspaces.length === 0
                ? "No saved workspaces yet."
                : `No workspace matches "${query.trim()}".`}
            </div>
          ) : (
            <div
              id={listId}
              className="workspace-quick-switcher-list"
              role="listbox"
              aria-label="Saved workspaces"
            >
              {filteredWorkspaces.map((workspace, index) => {
                const current = workspace.id === activeWorkspaceId;
                const highlighted = workspace.id === highlightedId;
                return (
                  <button
                    id={`${listId}-${workspace.id}`}
                    key={workspace.id}
                    type="button"
                    role="option"
                    className={current
                      ? "workspace-quick-switcher-option current"
                      : "workspace-quick-switcher-option"}
                    data-highlighted={highlighted ? "true" : undefined}
                    aria-selected={highlighted}
                    aria-current={current ? "true" : undefined}
                    tabIndex={-1}
                    onMouseEnter={() => setHighlightedId(workspace.id)}
                    onClick={() => switchTo(workspace)}
                  >
                    <span className="workspace-quick-switcher-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="workspace-quick-switcher-option-copy">
                      <strong>{workspace.name}</strong>
                      <small>{sessionCountLabel(workspace.tabs.length)}</small>
                    </span>
                    {current && <em>Current</em>}
                    <ChevronRightIcon />
                  </button>
                );
              })}
            </div>
          )}

          <footer>
            <span>Alphabetical order</span>
            <span>Up/Down + Enter</span>
            <span>Previous/Next wraps</span>
          </footer>
        </section>
      )}
    </div>
  );
}
