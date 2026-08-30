import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  directShortcutAria,
  directShortcutLabel,
  launcherShortcutLabel,
  matchesDirectShortcut,
  matchesShortcutCode,
  useShortcutSettings,
  type ShortcutActionId,
} from "../shortcutSettings";
import {
  CloseIcon,
  KeyboardIcon,
  SearchIcon,
  TerminalIcon,
} from "../icons";
import { ShortcutSettingsDialog } from "./ShortcutSettingsDialog";

export const DESKTOP_COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+H";
export const DESKTOP_SHORTCUT_LAUNCHER_SHORTCUT = "Ctrl+Shift+Z";

export interface WorkspaceCommand {
  id: string;
  shortcutId?: ShortcutActionId;
  label: string;
  description: string;
  category: "Session" | "Terminal" | "Workspace" | "View" | "Open tabs";
  shortcut?: string;
  launcherKey?: string;
  launcherCode?: string;
  keywords?: readonly string[];
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

interface RankedWorkspaceCommand {
  command: WorkspaceCommand;
  score: number;
  sourceIndex: number;
}

interface WorkspaceCommandPaletteProps {
  commands: readonly WorkspaceCommand[];
  compactViewport: boolean;
}

const MAX_VISIBLE_COMMANDS = 60;
const COMMAND_LABEL_SCORE_BONUS = 2_200;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyTokenScore(token: string, candidate: string): number | null {
  if (!token || !candidate) return null;
  if (candidate === token) return 5_000;
  if (candidate.startsWith(token)) return 4_000 - (candidate.length - token.length);

  const substringIndex = candidate.indexOf(token);
  if (substringIndex >= 0) {
    const boundaryBonus = substringIndex === 0 || candidate[substringIndex - 1] === " "
      ? 300
      : 0;
    return 3_000 + boundaryBonus - substringIndex * 3 - (candidate.length - token.length);
  }

  let tokenIndex = 0;
  let previousMatch = -2;
  let score = 1_000;
  for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
    if (candidate[candidateIndex] !== token[tokenIndex]) continue;
    score += candidateIndex === previousMatch + 1 ? 45 : 12;
    if (candidateIndex === 0 || candidate[candidateIndex - 1] === " ") score += 35;
    score -= Math.max(0, candidateIndex - previousMatch - 1) * 2;
    previousMatch = candidateIndex;
    tokenIndex += 1;
    if (tokenIndex === token.length) {
      return score - Math.max(0, candidate.length - token.length);
    }
  }
  return null;
}

export function rankWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  query: string,
): RankedWorkspaceCommand[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  return commands
    .flatMap((command, sourceIndex) => {
      if (tokens.length === 0) return [{ command, score: 0, sourceIndex }];
      const fields = [
        command.label,
        command.description,
        command.category,
        command.shortcut || "",
        ...(command.keywords || []),
      ].map(normalizeSearchText).filter(Boolean);
      let score = 0;
      for (const token of tokens) {
        let bestScore: number | null = null;
        fields.forEach((field, fieldIndex) => {
          const fieldScore = fuzzyTokenScore(token, field);
          if (fieldScore === null) return;
          const weightedScore = fieldScore
            + (fieldIndex === 0 ? COMMAND_LABEL_SCORE_BONUS : 0);
          bestScore = bestScore === null ? weightedScore : Math.max(bestScore, weightedScore);
        });
        if (bestScore === null) return [];
        score += bestScore;
      }
      return [{ command, score, sourceIndex }];
    })
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .slice(0, MAX_VISIBLE_COMMANDS);
}

export function WorkspaceCommandPalette({
  commands,
  compactViewport,
}: WorkspaceCommandPaletteProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const dialogId = useId();
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const handledShortcutRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const resolvedCommands = useMemo(() => commands.map((command) => {
    if (!command.shortcutId) return command;
    const binding = shortcutBindings[command.shortcutId];
    const direct = directShortcutLabel(binding);
    const launcher = launcherShortcutLabel(binding);
    const launcherChord = directShortcutLabel(shortcutBindings["shortcut-launcher"]);
    return {
      ...command,
      shortcut: direct || (launcher && launcherChord
        ? `${launcherChord}, then ${launcher}`
        : undefined),
      launcherKey: launcher || undefined,
      launcherCode: binding.launcher || undefined,
    };
  }), [commands, shortcutBindings]);
  const results = useMemo(
    () => rankWorkspaceCommands(resolvedCommands, query),
    [query, resolvedCommands],
  );
  const enabledResults = results.filter(({ command }) => !command.disabled);
  const highlightedIndex = results.findIndex(({ command }) => command.id === highlightedId);

  useEffect(() => {
    if (compactViewport && settingsOpen) setSettingsOpen(false);
  }, [compactViewport, settingsOpen]);

  const closePalette = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setHighlightedId(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => previousFocusRef.current?.focus());
    }
  }, []);

  const openPalette = useCallback(() => {
    if (
      compactViewport
      || document.querySelector('[aria-modal="true"]')
    ) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    setQuery("");
    setHighlightedId(resolvedCommands.find((command) => !command.disabled)?.id ?? null);
    setOpen(true);
  }, [compactViewport, resolvedCommands]);

  const runCommand = useCallback((command: WorkspaceCommand) => {
    if (command.disabled) return;
    closePalette(false);
    window.requestAnimationFrame(() => command.run());
  }, [closePalette]);

  useEffect(() => {
    const blockedShortcut = () => (
      compactViewport
      || (!open && Boolean(document.querySelector('[aria-modal="true"]')))
    );
    const togglePalette = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (open) closePalette(true);
      else openPalette();
    };
    const handleShortcutKeyDown = (event: KeyboardEvent) => {
      if (
        !matchesDirectShortcut(event, shortcutBindings["command-palette"])
        || blockedShortcut()
      ) return;
      handledShortcutRef.current = true;
      togglePalette(event);
    };
    const handleShortcutKeyUp = (event: KeyboardEvent) => {
      if (!matchesDirectShortcut(event, shortcutBindings["command-palette"])) return;
      if (handledShortcutRef.current) {
        handledShortcutRef.current = false;
        return;
      }
      if (blockedShortcut()) return;
      togglePalette(event);
    };
    window.addEventListener("keydown", handleShortcutKeyDown, true);
    window.addEventListener("keyup", handleShortcutKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleShortcutKeyDown, true);
      window.removeEventListener("keyup", handleShortcutKeyUp, true);
    };
  }, [closePalette, compactViewport, open, openPalette, shortcutBindings]);

  useEffect(() => {
    if (!open) return;
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePalette(true);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
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
    window.addEventListener("keydown", handleDialogKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      releaseBodyScroll();
    };
  }, [closePalette, open]);

  useEffect(() => {
    if (!open) return;
    if (enabledResults.some(({ command }) => command.id === highlightedId)) return;
    setHighlightedId(enabledResults[0]?.command.id ?? null);
  }, [enabledResults, highlightedId, open]);

  useEffect(() => {
    if (!open || !compactViewport) return;
    closePalette(false);
  }, [closePalette, compactViewport, open]);

  const moveHighlight = (offset: -1 | 1) => {
    if (enabledResults.length === 0) return;
    const currentIndex = enabledResults.findIndex(({ command }) => (
      command.id === highlightedId
    ));
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + offset + enabledResults.length) % enabledResults.length;
    const nextId = enabledResults[nextIndex].command.id;
    setHighlightedId(nextId);
    window.requestAnimationFrame(() => {
      document.getElementById(`${listboxId}-${nextId}`)?.scrollIntoView({ block: "nearest" });
    });
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    const nextResult = rankWorkspaceCommands(resolvedCommands, value)
      .find(({ command }) => !command.disabled);
    setHighlightedId(nextResult?.command.id ?? null);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      const highlighted = results.find(({ command }) => command.id === highlightedId);
      if (!highlighted || highlighted.command.disabled) return;
      event.preventDefault();
      runCommand(highlighted.command);
    }
  };

  return (
    <div className="workspace-keymap">
      <button
        ref={triggerRef}
        type="button"
        className="workspace-keymap-toggle"
        aria-label="Open command palette"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-keyshortcuts={directShortcutAria(shortcutBindings["command-palette"])}
        title={`Search and run commands${directShortcutLabel(
          shortcutBindings["command-palette"],
        ) ? ` (${directShortcutLabel(shortcutBindings["command-palette"])})` : ""}`}
        onClick={open ? () => closePalette(true) : openPalette}
      >
        <SearchIcon />
        <span>Commands</span>
      </button>
      {open && createPortal(
        <div
          className="workspace-tab-search-backdrop workspace-command-palette-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePalette(true);
          }}
        >
          <aside
            ref={dialogRef}
            id={dialogId}
            className="workspace-tab-search-dialog workspace-command-palette-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${dialogId}-title`}
          >
            <header className="workspace-tab-search-header">
              <div>
                <p className="eyebrow">COMMAND DECK</p>
                <h2 id={`${dialogId}-title`}>Run a command</h2>
              </div>
              <div className="workspace-tab-search-header-actions">
                <kbd>{directShortcutLabel(shortcutBindings["command-palette"]) || "Button only"}</kbd>
                <button
                  type="button"
                  className="workspace-keymap-close"
                  aria-label="Close command palette"
                  onClick={() => closePalette(true)}
                >
                  <CloseIcon />
                </button>
              </div>
            </header>

            <label className="workspace-tab-search-field">
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                role="combobox"
                aria-label="Search commands"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={highlightedIndex >= 0
                  ? `${listboxId}-${results[highlightedIndex].command.id}`
                  : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder="Try rename, tmux page, theme, or a session name"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {query && (
                <button type="button" onClick={() => updateQuery("")}>Clear</button>
              )}
            </label>

            <div
              id={listboxId}
              className="workspace-tab-search-results workspace-command-palette-results"
              role="listbox"
              aria-label="Matching commands"
            >
              {results.map(({ command }, index) => {
                const highlighted = command.id === highlightedId;
                return (
                  <button
                    id={`${listboxId}-${command.id}`}
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={highlighted}
                    aria-disabled={command.disabled || undefined}
                    disabled={command.disabled}
                    className={[
                      "workspace-tab-search-result",
                      "workspace-command-palette-result",
                      highlighted ? "highlighted" : "",
                      command.danger ? "danger" : "",
                    ].filter(Boolean).join(" ")}
                    onMouseMove={() => {
                      if (!command.disabled) setHighlightedId(command.id);
                    }}
                    onFocus={() => {
                      if (!command.disabled) setHighlightedId(command.id);
                    }}
                    onClick={() => runCommand(command)}
                  >
                    <span className="workspace-command-palette-category">
                      {String(index + 1).padStart(2, "0")}
                      <small>{command.category}</small>
                    </span>
                    <span className="workspace-tab-search-result-copy">
                      <strong>{command.label}</strong>
                      <span>{command.disabled
                        ? command.disabledReason || "Unavailable right now"
                        : command.description}</span>
                    </span>
                    {command.shortcut ? <kbd>{command.shortcut}</kbd> : <small>RUN</small>}
                  </button>
                );
              })}
              {results.length === 0 && (
                <div className="workspace-tab-search-empty">
                  <TerminalIcon />
                  <strong>No matching command</strong>
                  <span>Fuzzy search accepts partial words, initials, and session names.</span>
                </div>
              )}
            </div>

            <footer className="workspace-tab-search-footer workspace-command-palette-footer">
              <span><kbd>UP</kbd><kbd>DOWN</kbd> Navigate</span>
              <span><kbd>ENTER</kbd> Run</span>
              <span><kbd>ESC</kbd> Close</span>
              <strong>{results.length} {results.length === 1 ? "match" : "matches"}</strong>
            </footer>
          </aside>
        </div>,
        document.body,
      )}
      <WorkspaceShortcutLauncher
        commands={resolvedCommands}
        compactViewport={compactViewport}
        onOpenCommandPalette={openPalette}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <ShortcutSettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

interface ShortcutLauncherEntry {
  id: string;
  key: string;
  code?: string;
  label: string;
  description: string;
  category: WorkspaceCommand["category"] | "Search";
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

interface WorkspaceShortcutLauncherProps {
  commands: readonly WorkspaceCommand[];
  compactViewport: boolean;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

function launcherEventKey(event: KeyboardEvent): string {
  if (event.code.startsWith("Key")) return event.code.slice(3).toUpperCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  if (event.code.startsWith("Numpad")) return event.code.slice(6);
  if (event.code === "Semicolon") return ";";
  if (event.code === "Comma") return ",";
  if (event.code === "Period") return ".";
  return event.key.length === 1 ? event.key.toUpperCase() : "";
}

function WorkspaceShortcutLauncher({
  commands,
  compactViewport,
  onOpenCommandPalette,
  onOpenSettings,
}: WorkspaceShortcutLauncherProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const dialogId = useId();
  const descriptionId = `${dialogId}-description`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const handledShortcutRef = useRef(false);
  const paletteTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const entries = useMemo<ShortcutLauncherEntry[]>(() => {
    const paletteKey = launcherShortcutLabel(shortcutBindings["command-palette"]);
    return [
      ...(paletteKey ? [{
      id: "open-command-palette",
      key: paletteKey,
      code: shortcutBindings["command-palette"].launcher || undefined,
      label: "Fuzzy command search",
      description: "Search every command, session tab, and workspace action.",
      category: "Search" as const,
      shortcut: directShortcutLabel(shortcutBindings["command-palette"]) || undefined,
      run: onOpenCommandPalette,
      }] : []),
    ...commands.flatMap((command) => command.launcherKey ? [{
      id: command.id,
      key: command.launcherKey,
      code: command.launcherCode,
      label: command.label,
      description: command.description,
      category: command.category,
      shortcut: command.shortcut,
      danger: command.danger,
      disabled: command.disabled,
      disabledReason: command.disabledReason,
      run: command.run,
    }] : []),
    ];
  }, [commands, onOpenCommandPalette, shortcutBindings]);

  const closeLauncher = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => previousFocusRef.current?.focus());
    }
  }, []);

  const openLauncher = useCallback(() => {
    if (compactViewport || document.querySelector('[aria-modal="true"]')) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    setOpen(true);
  }, [compactViewport]);

  const runEntry = useCallback((entry: ShortcutLauncherEntry) => {
    if (entry.disabled) return;
    closeLauncher(false);
    if (entry.id === "open-command-palette") {
      paletteTimerRef.current = window.setTimeout(() => {
        paletteTimerRef.current = null;
        entry.run();
      }, 0);
      return;
    }
    window.requestAnimationFrame(() => entry.run());
  }, [closeLauncher]);

  useEffect(() => () => {
    if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current);
  }, []);

  useEffect(() => {
    const blockedShortcut = () => (
      compactViewport
      || (!open && Boolean(document.querySelector('[aria-modal="true"]')))
    );
    const toggleLauncher = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (open) closeLauncher(true);
      else openLauncher();
    };
    const handleShortcutKeyDown = (event: KeyboardEvent) => {
      if (
        !matchesDirectShortcut(event, shortcutBindings["shortcut-launcher"])
        || blockedShortcut()
      ) return;
      handledShortcutRef.current = true;
      toggleLauncher(event);
    };
    const handleShortcutKeyUp = (event: KeyboardEvent) => {
      if (!matchesDirectShortcut(event, shortcutBindings["shortcut-launcher"])) return;
      if (handledShortcutRef.current) {
        handledShortcutRef.current = false;
        return;
      }
      if (blockedShortcut()) return;
      toggleLauncher(event);
    };
    window.addEventListener("keydown", handleShortcutKeyDown, true);
    window.addEventListener("keyup", handleShortcutKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleShortcutKeyDown, true);
      window.removeEventListener("keyup", handleShortcutKeyUp, true);
    };
  }, [closeLauncher, compactViewport, open, openLauncher, shortcutBindings]);

  useEffect(() => {
    if (!open) return;
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-shortcut-key]:not(:disabled)")
        ?.focus();
    });
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLauncher(true);
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ));
        if (focusable.length === 0) return;
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
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const key = launcherEventKey(event);
      const entry = entries.find((candidate) => candidate.code
        ? matchesShortcutCode(event, candidate.code)
        : candidate.key.toUpperCase() === key);
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (entry.disabled) {
        Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          "[data-shortcut-key]",
        ) || []).find((element) => element.dataset.shortcutKey === entry.key)?.focus();
        return;
      }
      runEntry(entry);
    };
    window.addEventListener("keydown", handleDialogKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      releaseBodyScroll();
    };
  }, [closeLauncher, entries, open, runEntry]);

  useEffect(() => {
    if (!open || !compactViewport) return;
    closeLauncher(false);
  }, [closeLauncher, compactViewport, open]);

  const launcherShortcut = directShortcutLabel(shortcutBindings["shortcut-launcher"]);
  const endEntry = entries.find((entry) => entry.id === "session-end");
  const renameEntry = entries.find((entry) => entry.id === "session-rename");
  const paletteEntry = entries.find((entry) => entry.id === "open-command-palette");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-keymap-toggle workspace-shortcut-toggle"
        aria-label="Open shortcut window"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-keyshortcuts={directShortcutAria(shortcutBindings["shortcut-launcher"])}
        title={`Open the shortcut window${launcherShortcut ? ` (${launcherShortcut})` : ""}`}
        onClick={open ? () => closeLauncher(true) : openLauncher}
      >
        <KeyboardIcon />
        <span>Shortcuts</span>
      </button>
      {open && createPortal(
        <div
          className="workspace-tab-search-backdrop workspace-shortcut-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeLauncher(true);
          }}
        >
          <aside
            ref={dialogRef}
            id={dialogId}
            className="workspace-tab-search-dialog workspace-shortcut-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${dialogId}-title`}
            aria-describedby={descriptionId}
            tabIndex={-1}
          >
            <header className="workspace-tab-search-header">
              <div>
                <p className="eyebrow">SHORTCUT LAYER</p>
                <h2 id={`${dialogId}-title`}>Keyboard shortcuts</h2>
              </div>
              <div className="workspace-tab-search-header-actions">
                <kbd>{launcherShortcut || "Button only"}</kbd>
                <button
                  type="button"
                  className="workspace-keymap-close"
                  aria-label="Close shortcut window"
                  onClick={() => closeLauncher(true)}
                >
                  <CloseIcon />
                </button>
              </div>
            </header>

            <p id={descriptionId} className="workspace-shortcut-intro">
              Release the opening chord, then press any listed key. The keymap is
              shared by every browser and can be customized below.
            </p>

            <div className="workspace-shortcut-grid">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={[
                    "workspace-shortcut-entry",
                    entry.danger ? "danger" : "",
                  ].filter(Boolean).join(" ")}
                  data-shortcut-key={entry.key}
                  aria-keyshortcuts={entry.key}
                  disabled={entry.disabled}
                  title={entry.disabled ? entry.disabledReason : undefined}
                  onClick={() => runEntry(entry)}
                >
                  <kbd>{entry.key}</kbd>
                  <span>
                    <strong>{entry.label}</strong>
                    <small>{entry.disabled
                      ? entry.disabledReason || "Unavailable right now"
                      : entry.description}</small>
                  </span>
                  <em>{entry.shortcut || entry.category}</em>
                </button>
              ))}
            </div>

            <footer className="workspace-tab-search-footer workspace-shortcut-footer">
              {endEntry && <span><kbd>{endEntry.key}</kbd> End safely</span>}
              {renameEntry && <span><kbd>{renameEntry.key}</kbd> Rename</span>}
              {paletteEntry && <span><kbd>{paletteEntry.key}</kbd> Fuzzy search</span>}
              <span><kbd>ESC</kbd> Close</span>
              <button
                type="button"
                className="shortcut-settings-open"
                onClick={() => {
                  closeLauncher(false);
                  onOpenSettings();
                }}
              >
                Customize
              </button>
            </footer>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
