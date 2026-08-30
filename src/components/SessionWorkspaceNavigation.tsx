import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SavedWorkspace } from "../api";
import { acquireBodyScrollLock } from "../bodyScrollLock";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  FolderIcon,
  GridIcon,
  HistoryIcon,
  ListIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  WindowCopyIcon,
  WindowMoveIcon,
} from "../icons";
import { paneCommandKind, sessionDisplayTitle, sortSessions } from "../sessionDashboardModel";
import { requestThemeToggle } from "../theme";
import {
  directShortcutAria,
  directShortcutLabel,
  dispatchShortcutAction,
  useShortcutSettings,
  type ShortcutActionId,
} from "../shortcutSettings";
import type { AgentState, Pane, Session } from "../types";
import {
  MAX_WORKSPACE_TAB_GROUPS,
  type WorkspaceTabGroup,
} from "../workspaceState";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import {
  DESKTOP_COMMAND_PALETTE_SHORTCUT,
  DESKTOP_SHORTCUT_LAUNCHER_SHORTCUT,
  WorkspaceCommandPalette,
  type WorkspaceCommand,
} from "./WorkspaceCommandPalette";
import { WorkspaceQuickSwitcher } from "./WorkspaceQuickSwitcher";
import { WorkspaceGroupDialog } from "./WorkspaceGroupDialog";
import { WorkspaceSaveDialog } from "./WorkspaceSaveDialog";

export interface SessionWorkspaceNavigationProps {
  activeSession: string | null;
  openSessions: string[];
  recentSessions: string[];
  groups?: WorkspaceTabGroup[];
  sessions: Session[];
  recentsOpen: boolean;
  orientation?: WorkspaceTabOrientation;
  desktopTabRailWidth?: number;
  onDesktopTabRailWidthChange?: (width: number) => void;
  tabsVisible?: boolean;
  tabActionsVisible?: boolean;
  newSessionActive?: boolean;
  onSelect: (sessionName: string) => void;
  onCloseTab: (sessionName: string) => void;
  onMoveTab?: (sessionName: string, targetIndex: number) => void;
  onSortTabsByWorkingState?: () => void;
  onToggleTabActions?: () => void;
  onOpenTabInNewWindow?: (
    sessionName: string,
    mode: OpenTabInNewWindowMode,
  ) => OpenTabInNewWindowResult;
  onSaveTabGroup?: (group: WorkspaceTabGroup) => void;
  onDeleteTabGroup?: (groupId: string) => void;
  onToggleTabGroup?: (groupId: string, collapsed: boolean) => void;
  onMoveTabGroup?: (groupId: string, direction: -1 | 1) => void;
  onCloseNewSession?: () => void;
  onOpenRecents: () => void;
  onCloseRecents: () => void;
  onClearRecents: () => void;
  onOpenDashboard: () => void;
  onNewSession?: () => void;
  onOpenTabSearch?: () => void;
  workspacePersistenceState?: WorkspacePersistenceState;
  activeWorkspaceId?: string | null;
  workspaceName?: string | null;
  onSwitchWorkspace?: (workspace: SavedWorkspace) => void;
  onSaveWorkspace?: (name: string) => Promise<void>;
  onSessionTerminated?: (
    sessionName: string,
    sessionId: string,
    sessionCreated: number,
    serverStarted: number,
    serverPid: number,
  ) => Promise<void>;
}

export type WorkspaceTabOrientation = "horizontal" | "vertical";
export type OpenTabInNewWindowMode = "move" | "copy";
export type OpenTabInNewWindowResult =
  | "opened"
  | "blocked"
  | "failed"
  | "workspace-sync-pending";

export const MIN_DESKTOP_TAB_RAIL_WIDTH = 72;
export const MAX_DESKTOP_TAB_RAIL_WIDTH = 480;
export const DEFAULT_DESKTOP_TAB_RAIL_WIDTH = 288;
export const COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH = 176;

const DESKTOP_TAB_RAIL_MAIN_CONTENT_MIN_WIDTH = 360;
const DESKTOP_TAB_RAIL_KEYBOARD_STEP = 8;
const DESKTOP_TAB_RAIL_KEYBOARD_LARGE_STEP = 32;

export function clampDesktopTabRailWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DESKTOP_TAB_RAIL_WIDTH;
  return Math.min(
    MAX_DESKTOP_TAB_RAIL_WIDTH,
    Math.max(MIN_DESKTOP_TAB_RAIL_WIDTH, Math.round(width)),
  );
}

export type WorkspacePersistenceState =
  | "unsaved"
  | "loading"
  | "saved"
  | "limited"
  | "error";

export const WORKSPACE_TAB_SHORTCUTS = {
  previous: "Ctrl+Shift+,",
  next: "Ctrl+Shift+.",
  search: "Ctrl+Shift+;",
  direct: "Ctrl+Shift+1-9",
} as const;

export const DESKTOP_CONSOLE_SHORTCUTS = {
  commandPalette: DESKTOP_COMMAND_PALETTE_SHORTCUT,
  shortcutLauncher: DESKTOP_SHORTCUT_LAUNCHER_SHORTCUT,
  newSession: "Ctrl+Shift+B",
  endSession: "Ctrl+Shift+E",
  renameSession: "Ctrl+Shift+R",
  returnLive: "Ctrl+Shift+L",
  copyMode: "Ctrl+Shift+C",
  tabActions: "Ctrl+Shift+A",
  pageUp: "Ctrl+Shift+U",
  pageDown: "Ctrl+Shift+D",
  sessionTabs: "Ctrl+Shift+S",
  focus: "Ctrl+Shift+F",
  theme: "Ctrl+Shift+Z, then T",
  copyNew: "Ctrl+Shift+M",
} as const;

export const MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID = "muxdeck-mobile-workspace-overview";

export function isCompactWorkspaceViewport(): boolean {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return viewportWidth <= 640
    || (viewportWidth <= 1024 && (coarsePointer || viewportHeight <= 500));
}

function useWorkspaceTabOrientation(
  preferredOrientation: WorkspaceTabOrientation,
): {
  orientation: WorkspaceTabOrientation;
  compactViewport: boolean;
} {
  const [compactViewport, setCompactViewport] = useState(isCompactWorkspaceViewport);

  useEffect(() => {
    const syncViewport = () => setCompactViewport(isCompactWorkspaceViewport());
    const viewport = window.visualViewport;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)");
    syncViewport();
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener?.("resize", syncViewport);
    coarsePointer?.addEventListener?.("change", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener?.("resize", syncViewport);
      coarsePointer?.removeEventListener?.("change", syncViewport);
    };
  }, []);

  return {
    orientation: compactViewport ? "horizontal" : preferredOrientation,
    compactViewport,
  };
}

function desktopTabRailMaxWidth(): number {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  return Math.max(
    MIN_DESKTOP_TAB_RAIL_WIDTH,
    Math.min(
      MAX_DESKTOP_TAB_RAIL_WIDTH,
      Math.floor(viewportWidth - DESKTOP_TAB_RAIL_MAIN_CONTENT_MIN_WIDTH),
    ),
  );
}

function useDesktopTabRailMaxWidth(): number {
  const [maxWidth, setMaxWidth] = useState(desktopTabRailMaxWidth);

  useEffect(() => {
    const syncViewport = () => setMaxWidth(desktopTabRailMaxWidth());
    const viewport = window.visualViewport;
    syncViewport();
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener?.("resize", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener?.("resize", syncViewport);
    };
  }, []);

  return maxWidth;
}

function clampDesktopTabRailWidthForViewport(width: number, maxWidth: number): number {
  return Math.min(maxWidth, clampDesktopTabRailWidth(width));
}

const STATE_LABELS: Record<AgentState, string> = {
  working: "Working",
  waiting_human: "Needs input",
  waiting_command: "Background work",
  unknown: "Unclear",
  other: "Other",
};

const WORKSPACE_PERSISTENCE_COPY: Record<
  Exclude<WorkspacePersistenceState, "unsaved">,
  { label: string; accessibleLabel: string; description: string }
> = {
  saved: {
    label: "Saved",
    accessibleLabel: "Workspace saved automatically",
    description: "Tab order and your active session save automatically.",
  },
  loading: {
    label: "Opening",
    accessibleLabel: "Opening saved workspace",
    description: "Opening this saved workspace from the server.",
  },
  limited: {
    label: "Tabs saved",
    accessibleLabel: "Workspace tabs saved; tab groups are not stored by this server",
    description: "Tabs and your active session save automatically. Tab groups are not stored by this server yet.",
  },
  error: {
    label: "Sync issue",
    accessibleLabel: "Workspace sync issue",
    description: "This saved workspace has a sync issue.",
  },
};

function workspaceIdentityName(
  workspacePersistenceState: WorkspacePersistenceState,
  workspaceName?: string | null,
): string {
  if (workspacePersistenceState === "unsaved") return "Temporary workspace";
  const normalizedName = workspaceName?.trim();
  if (normalizedName) return normalizedName;
  return workspacePersistenceState === "loading" ? "Opening workspace" : "Saved workspace";
}

function workspaceIdentityStateLabel(
  workspacePersistenceState: WorkspacePersistenceState,
): string {
  return workspacePersistenceState === "unsaved"
    ? "Not saved"
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState].label;
}

function moveToNewWindowDisabledReason(
  workspacePersistenceState: WorkspacePersistenceState,
): string | null {
  if (workspacePersistenceState === "loading") {
    return "Move is unavailable until the saved workspace finishes opening.";
  }
  if (workspacePersistenceState === "error") {
    return "Move is unavailable until the workspace sync issue is resolved.";
  }
  return null;
}

function newWindowFailureMessage(
  result: Exclude<OpenTabInNewWindowResult, "opened">,
  title: string,
): string {
  if (result === "workspace-sync-pending") {
    return `Muxdeck is finishing an earlier workspace save before moving ${title}. The source tab is unchanged. Try Move again when the save finishes.`;
  }
  if (result === "blocked") {
    return `The browser blocked a new window for ${title}. Allow pop-ups and try again.`;
  }
  return `Muxdeck could not open ${title} in a new window. The source tab is unchanged. Try again.`;
}

function WorkspaceWindowActionError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div className="workspace-window-action-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss new window error">
        <CloseIcon />
      </button>
    </div>
  );
}

function activePane(session: Session): Pane | undefined {
  return session.panes.find((pane) => pane.id === session.activePaneId) || session.panes[0];
}

function paneLabel(pane?: Pane): string {
  switch (paneCommandKind(pane?.command || "", pane?.title || "")) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "cursor": return "Cursor";
    case "grok": return "Grok";
    case "shells": return "Shell";
    default: return pane?.command || "Process";
  }
}

function tabTitle(sessionName: string, sessionsByName: Map<string, Session>): string {
  const session = sessionsByName.get(sessionName);
  return session ? sessionDisplayTitle(session) : sessionName;
}

interface WorkspaceCommandContext {
  activeSession: string | null;
  newSessionActive: boolean;
  openSessions: readonly string[];
  sessionsByName: Map<string, Session>;
  tabsVisible: boolean;
  tabActionsVisible: boolean;
  workspacePersistenceState: WorkspacePersistenceState;
  newSessionDisabled: boolean;
  onNewSession?: () => void;
  onOpenTabSearch?: () => void;
  onOpenRecents: () => void;
  onOpenDashboard: () => void;
  onSelect: (sessionName: string) => void;
  onRequestSaveWorkspace?: () => void;
  onCreateTabGroup?: () => void;
  onSortTabsByWorkingState?: () => void;
  onToggleTabActions?: () => void;
  onCloseActiveTab?: () => void;
}

function shortcutCommand(
  command: Omit<WorkspaceCommand, "run">,
  shortcutId: ShortcutActionId,
): WorkspaceCommand {
  return {
    ...command,
    shortcutId,
    run: () => dispatchShortcutAction(shortcutId),
  };
}

function buildWorkspaceCommands({
  activeSession,
  newSessionActive,
  openSessions,
  sessionsByName,
  tabsVisible,
  tabActionsVisible,
  workspacePersistenceState,
  newSessionDisabled,
  onNewSession,
  onOpenTabSearch,
  onOpenRecents,
  onOpenDashboard,
  onSelect,
  onRequestSaveWorkspace,
  onCreateTabGroup,
  onSortTabsByWorkingState,
  onToggleTabActions,
  onCloseActiveTab,
}: WorkspaceCommandContext): WorkspaceCommand[] {
  const activeSessionLoaded = Boolean(
    activeSession
    && !newSessionActive
    && sessionsByName.has(activeSession),
  );
  const activeTitle = activeSession ? tabTitle(activeSession, sessionsByName) : "this session";
  const commands: WorkspaceCommand[] = [
    {
      id: "workspace-new-session",
      label: "Open New session",
      description: "Create another tmux session from the workspace.",
      category: "Workspace",
      shortcutId: "workspace-new-session",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.newSession,
      launcherKey: "B",
      keywords: ["create", "start", "tmux"],
      disabled: !onNewSession || newSessionDisabled,
      disabledReason: newSessionActive
        ? "The New session view is already open."
        : "Wait for the workspace to finish loading.",
      run: () => onNewSession?.(),
    },
    shortcutCommand({
      id: "session-copy-new",
      label: "Create session from current directory",
      description: `Copy New beside ${activeTitle}.`,
      category: "Session",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.copyNew,
      keywords: ["copy new", "clone", "duplicate", "cwd", "pwd"],
      disabled: !activeSessionLoaded || workspacePersistenceState === "loading",
      disabledReason: "Open a live session and wait for the workspace to finish loading.",
    }, "session-copy-new"),
    {
      id: "workspace-find-tab",
      label: "Find an open tab",
      description: "Search the sessions already open in this workspace.",
      category: "Workspace",
      shortcutId: "workspace-find-tab",
      shortcut: WORKSPACE_TAB_SHORTCUTS.search,
      launcherKey: ";",
      keywords: ["switch", "jump", "search session"],
      disabled: !onOpenTabSearch || openSessions.length === 0,
      disabledReason: "There are no open session tabs to search.",
      run: () => onOpenTabSearch?.(),
    },
    shortcutCommand({
      id: "terminal-return-live",
      label: "Return to live output",
      description: "Leave tmux scrollback and follow current terminal output.",
      category: "Terminal",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.returnLive,
      keywords: ["exit scrollback", "bottom", "follow"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "terminal-return-live"),
    shortcutCommand({
      id: "terminal-page-up",
      label: "Preferred page up",
      description: "Use the highlighted paging method for the current agent.",
      category: "Terminal",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.pageUp,
      keywords: ["scroll up", "tmux page up", "pgup", "history"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "terminal-page-up"),
    shortcutCommand({
      id: "terminal-page-down",
      label: "Preferred page down",
      description: "Use the highlighted paging method for the current agent.",
      category: "Terminal",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.pageDown,
      keywords: ["scroll down", "tmux page down", "pgdn", "history"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "terminal-page-down"),
    shortcutCommand({
      id: "session-rename",
      label: "Rename tmux session",
      description: `Change the native tmux name for ${activeTitle}.`,
      category: "Session",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.renameSession,
      keywords: ["rename session", "change name", "tmux name"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "session-rename"),
    shortcutCommand({
      id: "session-end",
      label: "Open End session confirmation",
      description: `Review before terminating ${activeTitle} and all of its panes.`,
      category: "Session",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.endSession,
      keywords: ["end", "terminate", "kill", "stop session"],
      danger: true,
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "session-end"),
    shortcutCommand({
      id: "terminal-copy-mode",
      label: "Toggle browser Copy mode",
      description: "Switch mouse handling between text selection and the terminal app.",
      category: "Terminal",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.copyMode,
      keywords: ["select", "clipboard", "mouse"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "terminal-copy-mode"),
    {
      id: "view-tab-actions",
      label: tabActionsVisible ? "Hide tab action buttons" : "Show tab action buttons",
      description: "Toggle move, copy, reorder, terminate, and close controls on tabs.",
      category: "View",
      shortcutId: "view-tab-actions",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.tabActions,
      keywords: ["toggle actions", "tab buttons", "controls"],
      disabled: !onToggleTabActions,
      disabledReason: "Tab action controls are unavailable in this view.",
      run: () => onToggleTabActions?.(),
    },
    shortcutCommand({
      id: "view-session-tabs",
      label: tabsVisible ? "Hide session tabs" : "Show session tabs",
      description: "Toggle the workspace tab strip or side rail.",
      category: "View",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.sessionTabs,
      keywords: ["sidebar", "tab strip", "rail"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "view-session-tabs"),
    shortcutCommand({
      id: "view-terminal-focus",
      label: "Enter or exit terminal Focus",
      description: "Fill the desktop viewport with the live terminal.",
      category: "View",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.focus,
      keywords: ["fullscreen", "distraction free", "terminal"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "view-terminal-focus"),
    {
      id: "view-theme",
      label: "Toggle light or dark theme",
      description: "Switch the Muxdeck color theme.",
      category: "View",
      shortcutId: "view-theme",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.theme,
      launcherKey: "T",
      keywords: ["appearance", "light", "dark"],
      run: requestThemeToggle,
    },
    {
      id: "workspace-previous-tab",
      label: "Previous tab",
      description: "Move to the previous open session, wrapping at the start.",
      category: "Workspace",
      shortcutId: "workspace-previous-tab",
      shortcut: WORKSPACE_TAB_SHORTCUTS.previous,
      keywords: ["back", "cycle", "switch session"],
      disabled: openSessions.length < 2,
      disabledReason: "Open at least two session tabs first.",
      run: () => {
        const currentIndex = activeSession ? openSessions.indexOf(activeSession) : -1;
        const nextIndex = currentIndex < 0 ? openSessions.length - 1 : (
          currentIndex - 1 + openSessions.length
        ) % openSessions.length;
        if (openSessions[nextIndex]) onSelect(openSessions[nextIndex]);
      },
    },
    {
      id: "workspace-next-tab",
      label: "Next tab",
      description: "Move to the next open session, wrapping at the end.",
      category: "Workspace",
      shortcutId: "workspace-next-tab",
      shortcut: WORKSPACE_TAB_SHORTCUTS.next,
      keywords: ["forward", "cycle", "switch session"],
      disabled: openSessions.length < 2,
      disabledReason: "Open at least two session tabs first.",
      run: () => {
        const currentIndex = activeSession ? openSessions.indexOf(activeSession) : -1;
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % openSessions.length;
        if (openSessions[nextIndex]) onSelect(openSessions[nextIndex]);
      },
    },
    {
      id: "workspace-recents",
      label: "Open session overview",
      description: "Browse open, recent, and other live tmux sessions.",
      category: "Workspace",
      keywords: ["recents", "switcher", "overview", "tmux server"],
      run: onOpenRecents,
    },
    {
      id: "workspace-all-sessions",
      label: "Browse all sessions",
      description: "Return to the full session dashboard.",
      category: "Workspace",
      keywords: ["dashboard", "home", "landing page"],
      run: onOpenDashboard,
    },
  ];
  if (onRequestSaveWorkspace) {
    commands.push({
      id: "workspace-save",
      label: "Save this workspace",
      description: "Name and persist the current tabs and groups.",
      category: "Workspace",
      keywords: ["persist", "resume", "workspace name"],
      run: onRequestSaveWorkspace,
    });
  }
  if (onCreateTabGroup) {
    commands.push({
      id: "workspace-new-tab-group",
      label: "Create tab group",
      description: "Organize contiguous workspace tabs into a named group.",
      category: "Workspace",
      keywords: ["group tabs", "organize", "folder"],
      run: onCreateTabGroup,
    });
  }
  if (onSortTabsByWorkingState) {
    commands.push({
      id: "workspace-sort-working-state",
      label: "Sort non-working tabs first",
      description: "Stable-sort tabs by working state while preserving groups.",
      category: "Workspace",
      keywords: ["status", "stable sort", "working last"],
      run: onSortTabsByWorkingState,
    });
  }
  if (onCloseActiveTab) {
    commands.push({
      id: "workspace-close-active-tab",
      label: "Close current workspace tab",
      description: `Remove ${activeTitle} from this tab list without ending tmux.`,
      category: "Workspace",
      keywords: ["hide tab", "remove tab", "keep session running"],
      run: onCloseActiveTab,
    });
  }
  openSessions.forEach((sessionName, index) => {
    const title = tabTitle(sessionName, sessionsByName);
    const session = sessionsByName.get(sessionName);
    commands.push({
      id: `open-tab-${sessionName}`,
      label: `Switch to ${title}`,
      description: title === sessionName
        ? `Open workspace tab ${index + 1}.`
        : `${sessionName} - workspace tab ${index + 1}.`,
      category: "Open tabs",
      shortcutId: index < 9
        ? `workspace-tab-${index + 1}` as ShortcutActionId
        : undefined,
      shortcut: index < 9 ? `Ctrl+Shift+${index + 1}` : undefined,
      launcherKey: index < 9 ? String(index + 1) : undefined,
      keywords: [
        sessionName,
        session?.agentState || "",
        session ? activePane(session)?.command || "" : "",
        "open tab",
        "switch session",
      ],
      disabled: sessionName === activeSession && !newSessionActive,
      disabledReason: "This session is already active.",
      run: () => onSelect(sessionName),
    });
  });
  return commands;
}

function tabMoveResultIndex(
  openSessions: readonly string[],
  groups: readonly WorkspaceTabGroup[],
  sessionName: string,
  targetIndex: number,
): number {
  const currentIndex = openSessions.indexOf(sessionName);
  const targetSession = openSessions[targetIndex];
  if (currentIndex < 0 || !targetSession) return targetIndex;
  const sourceGroup = groups.find((group) => group.tabs.includes(sessionName));
  const targetGroup = groups.find((group) => group.tabs.includes(targetSession));
  if (sourceGroup || !targetGroup) return targetIndex;
  return currentIndex < targetIndex
    ? openSessions.indexOf(targetGroup.tabs.at(-1)!)
    : openSessions.indexOf(targetGroup.tabs[0]);
}

type WorkspaceTabDropEdge = "before" | "after";

interface WorkspaceTabDragTarget {
  kind: "tab" | "group";
  id: string;
  edge: WorkspaceTabDropEdge;
  targetIndex: number;
}

interface WorkspaceTabDragState {
  sessionName: string;
  target: WorkspaceTabDragTarget | null;
}

function workspaceTabDropEdge(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  orientation: WorkspaceTabOrientation,
): WorkspaceTabDropEdge {
  const bounds = element.getBoundingClientRect();
  const coordinate = orientation === "vertical" ? clientY : clientX;
  const midpoint = orientation === "vertical"
    ? bounds.top + bounds.height / 2
    : bounds.left + bounds.width / 2;
  return coordinate < midpoint ? "before" : "after";
}

function workspaceTabDropIndex(
  sourceIndex: number,
  boundaryIndex: number,
  tabCount: number,
): number {
  const targetIndex = boundaryIndex - (sourceIndex < boundaryIndex ? 1 : 0);
  return Math.max(0, Math.min(tabCount - 1, targetIndex));
}

interface WorkspaceTabSearchDialogProps {
  activeSession: string | null;
  openSessions: string[];
  groups?: readonly WorkspaceTabGroup[];
  sessions: Session[];
  onSelect: (sessionName: string) => void;
  onClose: () => void;
}

interface TabSearchResult {
  sessionName: string;
  title: string;
  session: Session | undefined;
  group: WorkspaceTabGroup | undefined;
  position: number;
  score: number;
}

function searchScore(
  title: string,
  sessionName: string,
  groupName: string | undefined,
  query: string,
): number | null {
  if (!query) return 0;
  const normalizedTitle = title.toLowerCase();
  const normalizedName = sessionName.toLowerCase();
  const normalizedGroup = groupName?.toLowerCase() ?? "";
  if (normalizedTitle === query) return 0;
  if (normalizedName === query) return 1;
  if (normalizedTitle.startsWith(query)) return 2;
  if (normalizedName.startsWith(query)) return 3;
  if (normalizedTitle.includes(query)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedGroup === query) return 6;
  if (normalizedGroup.startsWith(query)) return 7;
  if (normalizedGroup.includes(query)) return 8;
  return null;
}

export function WorkspaceTabSearchDialog({
  activeSession,
  openSessions,
  groups = [],
  sessions,
  onSelect,
  onClose,
}: WorkspaceTabSearchDialogProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const findTabShortcut = directShortcutLabel(shortcutBindings["workspace-find-tab"]);
  const previousTabShortcut = directShortcutLabel(
    shortcutBindings["workspace-previous-tab"],
  );
  const nextTabShortcut = directShortcutLabel(shortcutBindings["workspace-next-tab"]);
  const directTabShortcuts = Array.from({ length: 9 }, (_, index) => (
    directShortcutLabel(shortcutBindings[
      `workspace-tab-${index + 1}` as keyof typeof shortcutBindings
    ])
  )).filter((shortcut): shortcut is string => Boolean(shortcut));
  const [query, setQuery] = useState("");
  const [highlightedSession, setHighlightedSession] = useState<string | null>(activeSession);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const groupsBySession = useMemo(() => {
    const memberships = new Map<string, WorkspaceTabGroup>();
    for (const group of groups) {
      for (const sessionName of group.tabs) {
        if (!memberships.has(sessionName)) memberships.set(sessionName, group);
      }
    }
    return memberships;
  }, [groups]);
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo<TabSearchResult[]>(() => openSessions
    .map((sessionName, position) => {
      const session = sessionsByName.get(sessionName);
      const title = tabTitle(sessionName, sessionsByName);
      const group = groupsBySession.get(sessionName);
      const score = searchScore(title, sessionName, group?.name, normalizedQuery);
      return score === null
        ? null
        : { sessionName, title, session, group, position, score };
    })
    .filter((result): result is TabSearchResult => result !== null)
    .sort((left, right) => left.score - right.score || left.position - right.position), [
    normalizedQuery,
    openSessions,
    groupsBySession,
    sessionsByName,
  ]);
  const resultNames = results.map((result) => result.sessionName).join("\u0000");

  useEffect(() => {
    const activeResult = normalizedQuery
      ? undefined
      : results.find((result) => result.sessionName === activeSession);
    setHighlightedSession(activeResult?.sessionName ?? results[0]?.sessionName ?? null);
  }, [activeSession, normalizedQuery, resultNames, results]);

  useEffect(() => {
    if (!highlightedSession) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(
        `${listId}-${encodeURIComponent(highlightedSession)}`,
      )?.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedSession, listId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const closeOnCompactLayout = () => {
      if (isCompactWorkspaceViewport()) onClose();
    };
    const handleDialogKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.hasAttribute("hidden") && element.tabIndex >= 0);
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

    window.addEventListener("resize", closeOnCompactLayout);
    window.addEventListener("keydown", handleDialogKeyDown, true);
    window.visualViewport?.addEventListener("resize", closeOnCompactLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", closeOnCompactLayout);
      window.removeEventListener("keydown", handleDialogKeyDown, true);
      window.visualViewport?.removeEventListener("resize", closeOnCompactLayout);
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  const moveHighlight = (offset: number) => {
    if (results.length === 0) return;
    const currentIndex = results.findIndex((result) => (
      result.sessionName === highlightedSession
    ));
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + offset + results.length) % results.length;
    setHighlightedSession(results[nextIndex].sessionName);
  };

  const chooseSession = (sessionName: string) => {
    onClose();
    onSelect(sessionName);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Enter" && highlightedSession) {
      event.preventDefault();
      chooseSession(highlightedSession);
    }
  };

  return (
    <div className="workspace-tab-search-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        ref={dialogRef}
        className="workspace-tab-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-tab-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-tab-search-header">
          <div>
            <p className="eyebrow">OPEN WORKSPACE TABS</p>
            <h2 id="workspace-tab-search-title">Jump to tab</h2>
          </div>
          <div className="workspace-tab-search-header-actions">
            <kbd>{findTabShortcut || "Button only"}</kbd>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close tab search">
              <CloseIcon />
            </button>
          </div>
        </header>

        <label className="workspace-tab-search-field">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Type a title, tmux name, or group"
            aria-label="Search open tabs by title or tmux name"
            aria-description="Search by title, tmux session name, or tab group name."
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={highlightedSession
              ? `${listId}-${encodeURIComponent(highlightedSession)}`
              : undefined}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear tab search">
              Clear
            </button>
          )}
        </label>

        <p className="workspace-sr-only" role="status" aria-live="polite">
          {results.length} {results.length === 1 ? "tab" : "tabs"} found
        </p>

        <div className="workspace-tab-search-results" id={listId} role="listbox" aria-label="Open tabs">
          {results.map((result) => {
            const highlighted = result.sessionName === highlightedSession;
            const active = result.sessionName === activeSession;
            const state = result.session?.agentState || "unavailable";
            return (
              <button
                type="button"
                id={`${listId}-${encodeURIComponent(result.sessionName)}`}
                key={result.sessionName}
                className={highlighted ? "workspace-tab-search-result highlighted" : "workspace-tab-search-result"}
                role="option"
                aria-selected={highlighted}
                tabIndex={-1}
                onMouseEnter={() => setHighlightedSession(result.sessionName)}
                onClick={() => chooseSession(result.sessionName)}
              >
                <span className={`workspace-state-dot ${state}`} aria-hidden="true" />
                <span className="workspace-tab-search-result-copy">
                  <strong>{result.title}</strong>
                  <span>{result.title === result.sessionName ? "tmux session" : result.sessionName}</span>
                  {result.group && (
                    <span
                      className="workspace-tab-search-result-group"
                      data-tab-group-color={result.group.color}
                      aria-label={`Tab group ${result.group.name}, color ${result.group.color}`}
                    >
                      <FolderIcon
                        width="12"
                        height="12"
                        style={{ color: "var(--tab-group-color)" }}
                      />
                      {result.group.name}
                    </span>
                  )}
                </span>
                <span className={`workspace-tab-search-result-state ${state}`}>
                  {active ? "Current" : result.session ? STATE_LABELS[result.session.agentState] : "Unavailable"}
                </span>
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="workspace-tab-search-empty">
              <SearchIcon />
              <strong>No matching open tabs</strong>
              <span>Search by custom title, tmux session name, or tab group name.</span>
            </div>
          )}
        </div>

        <footer className="workspace-tab-search-footer">
          <span>
            {previousTabShortcut && <kbd>{previousTabShortcut}</kbd>}
            {nextTabShortcut && <kbd>{nextTabShortcut}</kbd>}
            cycle tabs
          </span>
          {directTabShortcuts.length > 0 && (
            <span className="workspace-tab-direct-shortcuts">
              {directTabShortcuts.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)}
              direct
            </span>
          )}
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
          <span><kbd>Enter</kbd> jump</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </aside>
    </div>
  );
}

function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  const tabList = event.currentTarget.closest("[role='tablist']");
  const orientation = tabList?.getAttribute("aria-orientation") === "vertical"
    ? "vertical"
    : "horizontal";
  const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
  const tabs = tabList
    ? Array.from(tabList.querySelectorAll<HTMLButtonElement>("[role='tab']"))
    : [];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) return;

  event.preventDefault();
  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  if (event.key === previousKey) nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === nextKey) nextIndex = (currentIndex + 1) % tabs.length;
  tabs[nextIndex]?.focus();
}

interface WorkspaceSessionRowProps {
  sessionName: string;
  session?: Session;
  group?: WorkspaceTabGroup;
  active: boolean;
  open: boolean;
  onSelect: () => void;
  openIndex?: number;
  openCount?: number;
  reorderStartIndex?: number;
  reorderEndIndex?: number;
  onMoveTab?: (targetIndex: number) => void;
  onCopyToNewWindow?: () => void;
  onMoveToNewWindow?: () => void;
  moveToNewWindowDisabledReason?: string | null;
  onClose?: () => void;
  onTerminate?: () => void;
}

function WorkspaceSessionRow({
  sessionName,
  session,
  group,
  active,
  open,
  onSelect,
  openIndex,
  openCount,
  reorderStartIndex = 0,
  reorderEndIndex,
  onMoveTab,
  onCopyToNewWindow,
  onMoveToNewWindow,
  moveToNewWindowDisabledReason = null,
  onClose,
  onTerminate,
}: WorkspaceSessionRowProps) {
  const pane = session ? activePane(session) : undefined;
  const displayTitle = session ? sessionDisplayTitle(session) : sessionName;
  const stateLabel = session ? STATE_LABELS[session.agentState] : "Unavailable";
  const canReorder = (
    open
    && onMoveTab
    && openIndex !== undefined
    && openCount !== undefined
    && openCount > 1
  );
  const lastReorderIndex = reorderEndIndex ?? ((openCount ?? 1) - 1);
  const hasWindowActions = Boolean(onCopyToNewWindow && onMoveToNewWindow);

  return (
    <div
      className={`workspace-session-row${active ? " active" : ""}${open && (onTerminate || hasWindowActions) ? " stacked-actions" : ""}`}
      data-workspace-session-name={sessionName}
    >
      <button
        type="button"
        className="workspace-session-select"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
      >
        <span
          className={`workspace-state-dot ${session?.agentState || "unavailable"}`}
          aria-hidden="true"
        />
        <span className="workspace-session-copy">
          <strong>{displayTitle}</strong>
          <span>
            {displayTitle !== sessionName ? `${sessionName} / ` : ""}
            {session ? paneLabel(pane) : "tmux session ended"}
          </span>
          {group && (
            <span
              className="workspace-session-group-label"
              data-tab-group-color={group.color}
            >
              <span aria-hidden="true" />
              Group: {group.name}
            </span>
          )}
        </span>
        <span className="workspace-session-indicators">
          <span className={`workspace-session-status ${session?.agentState || "unavailable"}`}>
            {active ? `Active \u00b7 ${stateLabel}` : stateLabel}
          </span>
          {session && session.queuedMessageCount > 0 && (
            <span
              className="workspace-session-memo-queue"
              aria-label={`${session.queuedMessageCount} queued memo ${session.queuedMessageCount === 1 ? "item" : "items"}`}
            >
              Q {session.queuedMessageCount}
            </span>
          )}
        </span>
      </button>
      {(canReorder || hasWindowActions || onClose || onTerminate) && (
        <span className="workspace-session-actions">
          {canReorder && (
            <span
              className="workspace-session-reorder"
              role="group"
              aria-label={`Reorder ${displayTitle} tab`}
            >
              <button
                type="button"
                className="workspace-session-move workspace-session-move-up"
                onClick={() => onMoveTab(openIndex - 1)}
                disabled={openIndex === reorderStartIndex}
                aria-label={`Move ${displayTitle} tab up`}
                title="Move tab up"
              >
                <ArrowLeftIcon />
              </button>
              <button
                type="button"
                className="workspace-session-move workspace-session-move-down"
                onClick={() => onMoveTab(openIndex + 1)}
                disabled={openIndex === lastReorderIndex}
                aria-label={`Move ${displayTitle} tab down`}
                title="Move tab down"
              >
                <ArrowLeftIcon />
              </button>
            </span>
          )}
          {hasWindowActions && (
            <span
              className="workspace-session-window-actions"
              role="group"
              aria-label={`${displayTitle} tab window actions`}
            >
              <button
                type="button"
                className="workspace-session-window-move"
                onClick={onMoveToNewWindow}
                disabled={Boolean(moveToNewWindowDisabledReason)}
                aria-label={`Move ${displayTitle} tab to new window`}
                aria-description={moveToNewWindowDisabledReason
                  ?? "Opens this session in a separate browser window and removes this quick tab here. The tmux session keeps running."}
                title={moveToNewWindowDisabledReason ?? "Move tab to new window"}
              >
                <WindowMoveIcon />
              </button>
              <button
                type="button"
                className="workspace-session-window-copy"
                onClick={onCopyToNewWindow}
                aria-label={`Copy ${displayTitle} tab to new window`}
                aria-description="Opens this session in a separate browser window and keeps this quick tab here."
                title="Copy tab to new window"
              >
                <WindowCopyIcon />
              </button>
            </span>
          )}
          {onTerminate && (
            <button
              type="button"
              className="workspace-session-terminate"
              onClick={onTerminate}
              aria-label={`Terminate ${displayTitle} tmux session`}
              aria-haspopup="dialog"
              title="Terminate tmux session"
            >
              <TrashIcon />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="workspace-session-close"
              onClick={onClose}
              aria-label={`Close ${displayTitle} quick tab`}
              title="Close quick tab"
            >
              <CloseIcon />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

interface WorkspaceRecentsDialogProps extends SessionWorkspaceNavigationProps {
  sessionsByName: Map<string, Session>;
  query: string;
  initialScrollTop: number;
  onQueryChange: (query: string) => void;
  onScrollPositionChange: (scrollTop: number) => void;
  onRequestSaveWorkspace: () => void;
  onRequestTerminateSession: (session: Session) => void;
  onRequestNewTabGroup: (initialSession?: string | null) => void;
  onRequestEditTabGroup: (groupId: string) => void;
}

function WorkspaceRecentsDialog({
  activeSession,
  openSessions,
  recentSessions,
  groups = [],
  sessions,
  sessionsByName,
  query,
  initialScrollTop,
  onQueryChange,
  onScrollPositionChange,
  onSelect,
  onCloseTab,
  onMoveTab,
  onOpenTabInNewWindow,
  onSaveTabGroup,
  onDeleteTabGroup,
  onMoveTabGroup,
  onCloseRecents,
  onClearRecents,
  onOpenDashboard,
  workspacePersistenceState = "unsaved",
  workspaceName,
  onSaveWorkspace,
  onRequestSaveWorkspace,
  onRequestTerminateSession,
  onRequestNewTabGroup,
  onRequestEditTabGroup,
  onSessionTerminated,
}: WorkspaceRecentsDialogProps) {
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [windowActionError, setWindowActionError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "up" | "down";
  } | null>(null);
  const openSet = useMemo(() => new Set(openSessions), [openSessions]);
  const recentSet = useMemo(() => new Set(recentSessions), [recentSessions]);
  const groupsBySession = useMemo(() => {
    const result = new Map<string, WorkspaceTabGroup>();
    groups.forEach((group) => group.tabs.forEach((sessionName) => {
      result.set(sessionName, group);
    }));
    return result;
  }, [groups]);
  const normalizedQuery = query.trim().toLowerCase();
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];
  const identityName = workspaceIdentityName(workspacePersistenceState, workspaceName);
  const identityStateLabel = workspaceIdentityStateLabel(workspacePersistenceState);
  const windowMoveDisabledReason = moveToNewWindowDisabledReason(
    workspacePersistenceState,
  );

  const matchesQuery = (sessionName: string): boolean => {
    if (!normalizedQuery) return true;
    const session = sessionsByName.get(sessionName);
    const pane = session ? activePane(session) : undefined;
    return [
      sessionName,
      session?.customTitle,
      pane?.command,
      pane?.path,
      pane?.title,
      groupsBySession.get(sessionName)?.name,
    ]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedQuery));
  };

  const filteredOpen = openSessions.filter(matchesQuery);
  const filteredRecent = recentSessions
    .filter((sessionName) => !openSet.has(sessionName))
    .filter(matchesQuery);
  const filteredAvailable = sortSessions(sessions, ["state", "activity", "tmux-name"])
    .sort((left, right) => Number(left.ignored) - Number(right.ignored))
    .map((session) => session.name)
    .filter((sessionName) => !openSet.has(sessionName) && !recentSet.has(sessionName))
    .filter(matchesQuery);
  const resultCount = filteredOpen.length + filteredRecent.length + filteredAvailable.length;

  const closeDialogTab = (sessionName: string) => {
    onCloseTab(sessionName);
    window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog?.isConnected && !dialog.contains(document.activeElement)) {
        searchRef.current?.focus();
      }
    });
  };

  const moveDialogTab = (sessionName: string, targetIndex: number) => {
    if (!onMoveTab || targetIndex < 0 || targetIndex >= openSessions.length) return;
    const resultIndex = tabMoveResultIndex(openSessions, groups, sessionName, targetIndex);
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "up" : "down",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${tabTitle(sessionName, sessionsByName)} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  };

  const openDialogTabInNewWindow = (
    sessionName: string,
    move: boolean,
  ) => {
    if (!onOpenTabInNewWindow) return;
    const title = tabTitle(sessionName, sessionsByName);
    const result = onOpenTabInNewWindow(sessionName, move ? "move" : "copy");
    if (result !== "opened") {
      setReorderAnnouncement("");
      setWindowActionError(newWindowFailureMessage(result, title));
      return;
    }
    setWindowActionError("");
    setReorderAnnouncement(
      move
        ? `${title} moved to a new window. The tmux session keeps running.`
        : `${title} copied to a new window and remains open here.`,
    );
    if (move) closeDialogTab(sessionName);
  };

  useEffect(() => {
    const intent = reorderFocusIntent.current;
    if (!intent) return;
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(".workspace-session-row") ?? [],
      ).find((item) => item.dataset.workspaceSessionName === intent.sessionName);
      const controls = Array.from(
        row?.querySelectorAll<HTMLButtonElement>(".workspace-session-move") ?? [],
      );
      const preferred = controls[intent.direction === "up" ? 0 : 1];
      const target = preferred && !preferred.disabled
        ? preferred
        : controls.find((control) => !control.disabled)
          ?? row?.querySelector<HTMLButtonElement>(".workspace-session-select");
      target?.focus();
      reorderFocusIntent.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openSessions, reorderAnnouncement]);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop;
  }, [initialScrollTop]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScroll = acquireBodyScrollLock();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const compactTouchLayout = viewportWidth <= 640
      || (viewportWidth <= 1024 && (coarsePointer || viewportHeight <= 500));
    const frame = window.requestAnimationFrame(() => {
      if (compactTouchLayout) dialogRef.current?.focus();
      else searchRef.current?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRecents();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      releaseBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onCloseRecents]);

  return (
    <div className="workspace-recents-backdrop" role="presentation" onMouseDown={onCloseRecents}>
      <aside
        ref={dialogRef}
        className="workspace-recents-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-recents-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-recents-header">
          <div className="workspace-recents-heading">
            <p className="eyebrow">THIS BROWSER PAGE / WORKSPACE</p>
            <h2 id="workspace-recents-title">Switch sessions</h2>
            <div
              className={`workspace-recents-identity ${workspacePersistenceState}`}
              role="group"
              aria-label={`Workspace: ${identityName}. ${identityStateLabel}`}
              title={identityName}
            >
              <span className="workspace-recents-identity-name">{identityName}</span>
              <span className="workspace-recents-identity-state" aria-hidden="true">
                {identityStateLabel}
              </span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onCloseRecents} aria-label="Close session switcher">
            <CloseIcon />
          </button>
        </header>

        <label className="workspace-session-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Find an open, recent, or live session"
            aria-label="Find a workspace session"
          />
          {query && (
            <button type="button" onClick={() => onQueryChange("")} aria-label="Clear workspace search">
              Clear
            </button>
          )}
        </label>

        <WorkspaceWindowActionError
          message={windowActionError}
          onDismiss={() => setWindowActionError("")}
        />

        <p className="workspace-sr-only" role="status" aria-live="polite">
          {resultCount} {resultCount === 1 ? "session" : "sessions"} found
        </p>
        {reorderAnnouncement && (
          <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement}
          </p>
        )}

        <div
          ref={scrollRef}
          className="workspace-recents-scroll"
          onScroll={(event) => onScrollPositionChange(event.currentTarget.scrollTop)}
        >
          {filteredOpen.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-open-heading">
              <header>
                <div>
                  <p className="eyebrow">QUICK SWITCH</p>
                  <h3 id="workspace-open-heading">Open tabs</h3>
                </div>
                <span>{filteredOpen.length}</span>
              </header>
              {onSaveTabGroup && (
                (onDeleteTabGroup && groups.length > 0)
                || (openSessions.length > 0 && groups.length < MAX_WORKSPACE_TAB_GROUPS)
              ) && (
                <div className="workspace-recents-tab-groups" aria-label="Workspace tab groups">
                  {onDeleteTabGroup && groups.map((group) => {
                    const groupStart = openSessions.indexOf(group.tabs[0]);
                    const groupEnd = openSessions.indexOf(group.tabs.at(-1)!);
                    return (
                    <div
                      className="workspace-recents-tab-group"
                      data-tab-group-color={group.color}
                      key={group.id}
                    >
                      <button
                        type="button"
                        className="workspace-recents-tab-group-edit"
                        onClick={() => onRequestEditTabGroup(group.id)}
                        aria-label={`Edit ${group.name} tab group`}
                      >
                        <span aria-hidden="true" />
                        <strong>{group.name}</strong>
                        <small>{group.tabs.length}</small>
                        <EditIcon />
                      </button>
                      {onMoveTabGroup && (
                        <span role="group" aria-label={`Move ${group.name} tab group`}>
                          <button
                            type="button"
                            onClick={() => {
                              onMoveTabGroup(group.id, -1);
                              setReorderAnnouncement(`${group.name} group moved up.`);
                            }}
                            disabled={groupStart === 0}
                            aria-label={`Move ${group.name} group up`}
                          >
                            <ArrowUpIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onMoveTabGroup(group.id, 1);
                              setReorderAnnouncement(`${group.name} group moved down.`);
                            }}
                            disabled={groupEnd === openSessions.length - 1}
                            aria-label={`Move ${group.name} group down`}
                          >
                            <ArrowDownIcon />
                          </button>
                        </span>
                      )}
                    </div>
                    );
                  })}
                  {openSessions.length > 0
                    && groups.length < MAX_WORKSPACE_TAB_GROUPS && (
                    <button
                      type="button"
                      className="workspace-recents-new-group"
                      onClick={() => onRequestNewTabGroup(activeSession)}
                    >
                      <PlusIcon /> New group
                    </button>
                  )}
                </div>
              )}
              <div className="workspace-session-list">
                {filteredOpen.map((sessionName) => {
                  const openIndex = openSessions.indexOf(sessionName);
                  const session = sessionsByName.get(sessionName);
                  const group = groupsBySession.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      group={group}
                      active={sessionName === activeSession}
                      open
                      openIndex={openIndex}
                      openCount={openSessions.length}
                      reorderStartIndex={group
                        ? openSessions.indexOf(group.tabs[0])
                        : undefined}
                      reorderEndIndex={group
                        ? openSessions.indexOf(group.tabs.at(-1)!)
                        : undefined}
                      onSelect={() => onSelect(sessionName)}
                      onMoveTab={onMoveTab
                        ? (targetIndex) => moveDialogTab(sessionName, targetIndex)
                        : undefined}
                      onMoveToNewWindow={onOpenTabInNewWindow
                        ? () => openDialogTabInNewWindow(sessionName, true)
                        : undefined}
                      onCopyToNewWindow={onOpenTabInNewWindow
                        ? () => openDialogTabInNewWindow(sessionName, false)
                        : undefined}
                      moveToNewWindowDisabledReason={windowMoveDisabledReason}
                      onClose={() => closeDialogTab(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {filteredRecent.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-recent-heading">
              <header>
                <div>
                  <p className="eyebrow">VISIT TRAIL</p>
                  <h3 id="workspace-recent-heading">Recently visited</h3>
                </div>
                <button type="button" className="workspace-clear-recents" onClick={onClearRecents}>
                  Clear closed
                </button>
              </header>
              <div className="workspace-session-list">
                {filteredRecent.map((sessionName) => {
                  const session = sessionsByName.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      active={false}
                      open={false}
                      onSelect={() => onSelect(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {filteredAvailable.length > 0 && (
            <section className="workspace-session-group" aria-labelledby="workspace-available-heading">
              <header>
                <div>
                  <p className="eyebrow">TMUX SERVER</p>
                  <h3 id="workspace-available-heading">Other live sessions</h3>
                </div>
                <span>{filteredAvailable.length}</span>
              </header>
              <div className="workspace-session-list">
                {filteredAvailable.map((sessionName) => {
                  const session = sessionsByName.get(sessionName);
                  return (
                    <WorkspaceSessionRow
                      key={sessionName}
                      sessionName={sessionName}
                      session={session}
                      active={false}
                      open={false}
                      onSelect={() => onSelect(sessionName)}
                      onTerminate={session && onSessionTerminated
                        ? () => onRequestTerminateSession(session)
                        : undefined}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {resultCount === 0 && (
            <div className="workspace-recents-empty">
              <TerminalIcon />
              <h3>{normalizedQuery ? "No matching sessions" : "No other sessions yet"}</h3>
              <p>{normalizedQuery ? "Try a different title, command, or path." : "Open a session from the dashboard to start a visit trail."}</p>
            </div>
          )}
        </div>

        <footer className="workspace-recents-footer">
          <p>
            {persistenceCopy?.description
              ?? "Save these open tabs to resume them here or on another device."}
          </p>
          <div className="workspace-recents-footer-actions">
            {workspacePersistenceState === "unsaved" ? onSaveWorkspace && (
              <button
                type="button"
                className="secondary-button workspace-recents-save-button"
                onClick={onRequestSaveWorkspace}
                aria-haspopup="dialog"
                aria-controls="workspace-save-dialog"
              >
                <SaveIcon /> Save
              </button>
            ) : persistenceCopy && (
              <span
                className={`workspace-recents-saved-status ${workspacePersistenceState}`}
                role="status"
                tabIndex={-1}
                aria-label={persistenceCopy.accessibleLabel}
                title={persistenceCopy.accessibleLabel}
              >
                {workspacePersistenceState === "saved"
                  ? <CheckIcon />
                  : workspacePersistenceState === "loading"
                    ? <HistoryIcon />
                    : <SaveIcon />}
                {persistenceCopy.label}
              </span>
            )}
            <button type="button" className="secondary-button" onClick={onOpenDashboard}>
              <GridIcon /> Browse all
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

export function SessionWorkspaceNavigation(props: SessionWorkspaceNavigationProps) {
  const {
    activeSession,
    openSessions,
    recentSessions,
    groups = [],
    sessions,
    recentsOpen,
    orientation: preferredOrientation = "horizontal",
    desktopTabRailWidth,
    onDesktopTabRailWidthChange,
    tabsVisible = true,
    tabActionsVisible = true,
    newSessionActive = false,
    onSelect,
    onCloseTab,
    onMoveTab,
    onSortTabsByWorkingState,
    onToggleTabActions,
    onOpenTabInNewWindow,
    onSaveTabGroup,
    onDeleteTabGroup,
    onToggleTabGroup,
    onMoveTabGroup,
    onCloseNewSession,
    onOpenRecents,
    onCloseRecents,
    onOpenDashboard,
    onNewSession,
    onOpenTabSearch,
    workspacePersistenceState = "unsaved",
    activeWorkspaceId = null,
    workspaceName,
    onSwitchWorkspace,
    onSaveWorkspace,
    onSessionTerminated,
  } = props;
  const { orientation, compactViewport } = useWorkspaceTabOrientation(
    preferredOrientation,
  );
  const { bindings: shortcutBindings } = useShortcutSettings();
  const desktopTabRailMaxWidth = useDesktopTabRailMaxWidth();
  const [internalDesktopTabRailWidth, setInternalDesktopTabRailWidth] = useState(() => (
    clampDesktopTabRailWidth(desktopTabRailWidth ?? DEFAULT_DESKTOP_TAB_RAIL_WIDTH)
  ));
  const committedDesktopTabRailWidth = clampDesktopTabRailWidthForViewport(
    desktopTabRailWidth ?? internalDesktopTabRailWidth,
    desktopTabRailMaxWidth,
  );
  const [liveDesktopTabRailWidth, setLiveDesktopTabRailWidth] = useState(
    committedDesktopTabRailWidth,
  );
  const liveDesktopTabRailWidthRef = useRef(liveDesktopTabRailWidth);
  const desktopTabRailDragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const visibleDesktopTabRailWidth = clampDesktopTabRailWidthForViewport(
    liveDesktopTabRailWidth,
    desktopTabRailMaxWidth,
  );
  liveDesktopTabRailWidthRef.current = visibleDesktopTabRailWidth;
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const persistenceStatusRef = useRef<HTMLSpanElement>(null);
  const recentsOpenRef = useRef(recentsOpen);
  recentsOpenRef.current = recentsOpen;
  const recentsScrollTopRef = useRef(0);
  const completedTerminationRef = useRef<Session | null>(null);
  const focusActiveTabAfterClose = useRef(false);
  const reorderFocusIntent = useRef<{
    sessionName: string;
    direction: "previous" | "next";
  } | null>(null);
  const groupReorderFocusIntent = useRef<{
    groupId: string;
    direction: "previous" | "next";
  } | null>(null);
  const groupDialogTriggerRef = useRef<HTMLElement | null>(null);
  const workspaceTabDragSessionRef = useRef<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAfterRecents, setSaveAfterRecents] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<Session | null>(null);
  const [recentsQuery, setRecentsQuery] = useState("");
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [windowActionError, setWindowActionError] = useState("");
  const [workspaceTabDrag, setWorkspaceTabDrag] = useState<WorkspaceTabDragState | null>(
    null,
  );
  const [groupDialog, setGroupDialog] = useState<{
    groupId: string | null;
    initialSession: string | null;
  } | null>(null);
  const sessionsByName = useMemo(
    () => new Map(sessions.map((session) => [session.name, session])),
    [sessions],
  );
  const groupsBySession = useMemo(() => {
    const result = new Map<string, WorkspaceTabGroup>();
    groups.forEach((group) => group.tabs.forEach((sessionName) => {
      result.set(sessionName, group);
    }));
    return result;
  }, [groups]);
  const workspaceTabItems = useMemo<Array<
    { kind: "tab"; sessionName: string } | { kind: "group"; group: WorkspaceTabGroup }
  >>(() => {
    const items: Array<
      { kind: "tab"; sessionName: string } | { kind: "group"; group: WorkspaceTabGroup }
    > = [];
    openSessions.forEach((sessionName) => {
      const group = groupsBySession.get(sessionName);
      if (!group) items.push({ kind: "tab", sessionName });
      else if (group.tabs[0] === sessionName) items.push({ kind: "group", group });
    });
    return items;
  }, [groupsBySession, openSessions]);
  const closedRecentCount = recentSessions.filter((name) => !openSessions.includes(name)).length;
  const persistenceCopy = workspacePersistenceState === "unsaved"
    ? null
    : WORKSPACE_PERSISTENCE_COPY[workspacePersistenceState];
  const identityName = workspaceIdentityName(workspacePersistenceState, workspaceName);
  const newSessionDisabled = newSessionActive || workspacePersistenceState === "loading";
  const windowMoveDisabledReason = moveToNewWindowDisabledReason(
    workspacePersistenceState,
  );
  const canCreateGroup = Boolean(
    onSaveTabGroup
    && openSessions.length > 0
    && groups.length < MAX_WORKSPACE_TAB_GROUPS,
  );
  const desktopTabDragEnabled = Boolean(
    onMoveTab
    && openSessions.length > 1
    && !compactViewport
    && tabsVisible,
  );

  const finishWorkspaceTabDrag = useCallback(() => {
    workspaceTabDragSessionRef.current = null;
    setWorkspaceTabDrag(null);
  }, []);

  const clearWorkspaceTabDropTarget = useCallback(() => {
    setWorkspaceTabDrag((current) => (
      current?.target ? { ...current, target: null } : current
    ));
  }, []);

  const previewWorkspaceTabDrop = useCallback((target: WorkspaceTabDragTarget) => {
    const sessionName = workspaceTabDragSessionRef.current;
    if (!sessionName) return;
    setWorkspaceTabDrag((current) => {
      if (
        current?.sessionName === sessionName
        && current.target?.kind === target.kind
        && current.target.id === target.id
        && current.target.edge === target.edge
        && current.target.targetIndex === target.targetIndex
      ) return current;
      return { sessionName, target };
    });
  }, []);

  const startWorkspaceTabDrag = useCallback((
    event: ReactDragEvent<HTMLButtonElement>,
    sessionName: string,
  ) => {
    if (!desktopTabDragEnabled) {
      event.preventDefault();
      return;
    }
    workspaceTabDragSessionRef.current = sessionName;
    setWorkspaceTabDrag({ sessionName, target: null });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionName);
  }, [desktopTabDragEnabled]);

  const tabDragTarget = useCallback((
    targetSessionName: string,
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): WorkspaceTabDragTarget | null => {
    const sourceSessionName = workspaceTabDragSessionRef.current;
    if (!sourceSessionName) return null;
    const sourceIndex = openSessions.indexOf(sourceSessionName);
    const targetIndex = openSessions.indexOf(targetSessionName);
    if (sourceIndex < 0 || targetIndex < 0) return null;

    const sourceGroup = groupsBySession.get(sourceSessionName);
    const targetGroup = groupsBySession.get(targetSessionName);
    if (sourceGroup?.id !== targetGroup?.id || targetGroup?.collapsed) return null;

    const edge = workspaceTabDropEdge(element, clientX, clientY, orientation);
    const boundaryIndex = targetIndex + (edge === "after" ? 1 : 0);
    return {
      kind: "tab",
      id: targetSessionName,
      edge,
      targetIndex: workspaceTabDropIndex(
        sourceIndex,
        boundaryIndex,
        openSessions.length,
      ),
    };
  }, [groupsBySession, openSessions, orientation]);

  const groupDragTarget = useCallback((
    group: WorkspaceTabGroup,
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): WorkspaceTabDragTarget | null => {
    const sourceSessionName = workspaceTabDragSessionRef.current;
    if (!sourceSessionName || groupsBySession.has(sourceSessionName)) return null;
    const sourceIndex = openSessions.indexOf(sourceSessionName);
    const groupStart = openSessions.indexOf(group.tabs[0]);
    const groupEnd = openSessions.indexOf(group.tabs.at(-1)!);
    if (sourceIndex < 0 || groupStart < 0 || groupEnd < groupStart) return null;

    const edge = workspaceTabDropEdge(element, clientX, clientY, orientation);
    const boundaryIndex = edge === "before" ? groupStart : groupEnd + 1;
    return {
      kind: "group",
      id: group.id,
      edge,
      targetIndex: workspaceTabDropIndex(
        sourceIndex,
        boundaryIndex,
        openSessions.length,
      ),
    };
  }, [groupsBySession, openSessions, orientation]);

  const nudgeWorkspaceTabViewport = useCallback((
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    const viewport = element.closest<HTMLElement>(".workspace-tab-viewport");
    if (!viewport?.scrollBy) return;
    const bounds = viewport.getBoundingClientRect();
    const coordinate = orientation === "vertical" ? clientY : clientX;
    const start = orientation === "vertical" ? bounds.top : bounds.left;
    const end = orientation === "vertical" ? bounds.bottom : bounds.right;
    const threshold = Math.min(48, Math.max(24, (end - start) * 0.15));
    const delta = coordinate < start + threshold
      ? -20
      : coordinate > end - threshold
        ? 20
        : 0;
    if (!delta) return;
    viewport.scrollBy(orientation === "vertical" ? { top: delta } : { left: delta });
  }, [orientation]);

  const dragOverWorkspaceTab = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    targetSessionName: string,
  ) => {
    const target = tabDragTarget(
      targetSessionName,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    previewWorkspaceTabDrop(target);
    nudgeWorkspaceTabViewport(event.currentTarget, event.clientX, event.clientY);
  }, [nudgeWorkspaceTabViewport, previewWorkspaceTabDrop, tabDragTarget]);

  const dragOverWorkspaceTabGroup = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    group: WorkspaceTabGroup,
  ) => {
    const target = groupDragTarget(
      group,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    previewWorkspaceTabDrop(target);
    nudgeWorkspaceTabViewport(event.currentTarget, event.clientX, event.clientY);
  }, [groupDragTarget, nudgeWorkspaceTabViewport, previewWorkspaceTabDrop]);

  const commitWorkspaceTabDrop = useCallback((target: WorkspaceTabDragTarget) => {
    const sourceSessionName = workspaceTabDragSessionRef.current;
    const sourceIndex = sourceSessionName
      ? openSessions.indexOf(sourceSessionName)
      : -1;
    finishWorkspaceTabDrag();
    if (
      !sourceSessionName
      || !onMoveTab
      || sourceIndex < 0
      || sourceIndex === target.targetIndex
    ) return;
    onMoveTab(sourceSessionName, target.targetIndex);
    const resultIndex = tabMoveResultIndex(
      openSessions,
      groups,
      sourceSessionName,
      target.targetIndex,
    );
    setReorderAnnouncement(
      `${tabTitle(sourceSessionName, sessionsByName)} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  }, [finishWorkspaceTabDrag, groups, onMoveTab, openSessions, sessionsByName]);

  const dropOnWorkspaceTab = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    targetSessionName: string,
  ) => {
    const target = tabDragTarget(
      targetSessionName,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    commitWorkspaceTabDrop(target);
  }, [commitWorkspaceTabDrop, tabDragTarget]);

  const dropOnWorkspaceTabGroup = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    group: WorkspaceTabGroup,
  ) => {
    const target = groupDragTarget(
      group,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    commitWorkspaceTabDrop(target);
  }, [commitWorkspaceTabDrop, groupDragTarget]);

  useEffect(() => {
    const draggedSession = workspaceTabDragSessionRef.current;
    const draggedGroup = draggedSession
      ? groupsBySession.get(draggedSession)
      : undefined;
    if (
      desktopTabDragEnabled
      && (!draggedSession || openSessions.includes(draggedSession))
      && (!draggedGroup || (!draggedGroup.collapsed && draggedGroup.tabs.length > 1))
    ) return;
    finishWorkspaceTabDrag();
  }, [desktopTabDragEnabled, finishWorkspaceTabDrag, groupsBySession, openSessions]);

  const previewDesktopTabRailWidth = useCallback((width: number) => {
    const nextWidth = clampDesktopTabRailWidthForViewport(width, desktopTabRailMaxWidth);
    liveDesktopTabRailWidthRef.current = nextWidth;
    setLiveDesktopTabRailWidth(nextWidth);
    return nextWidth;
  }, [desktopTabRailMaxWidth]);

  const commitDesktopTabRailWidth = useCallback((width: number) => {
    const nextWidth = previewDesktopTabRailWidth(width);
    if (desktopTabRailWidth === undefined) setInternalDesktopTabRailWidth(nextWidth);
    if (nextWidth !== committedDesktopTabRailWidth) {
      onDesktopTabRailWidthChange?.(nextWidth);
    }
  }, [
    committedDesktopTabRailWidth,
    desktopTabRailWidth,
    onDesktopTabRailWidthChange,
    previewDesktopTabRailWidth,
  ]);

  const stopDesktopTabRailDrag = useCallback(() => {
    desktopTabRailDragRef.current = null;
    document.documentElement.classList.remove("workspace-tab-rail-resizing");
  }, []);

  const commitDesktopTabRailDrag = useCallback((pointerId: number) => {
    const drag = desktopTabRailDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const nextWidth = liveDesktopTabRailWidthRef.current;
    stopDesktopTabRailDrag();
    commitDesktopTabRailWidth(nextWidth);
  }, [commitDesktopTabRailWidth, stopDesktopTabRailDrag]);

  useEffect(() => {
    if (desktopTabRailDragRef.current) return;
    previewDesktopTabRailWidth(committedDesktopTabRailWidth);
  }, [committedDesktopTabRailWidth, previewDesktopTabRailWidth]);

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const drag = desktopTabRailDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      previewDesktopTabRailWidth(drag.startWidth + event.clientX - drag.startX);
    };
    const pointerUp = (event: PointerEvent) => {
      commitDesktopTabRailDrag(event.pointerId);
    };
    const pointerCancel = (event: PointerEvent) => {
      const drag = desktopTabRailDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      stopDesktopTabRailDrag();
      previewDesktopTabRailWidth(committedDesktopTabRailWidth);
    };

    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [
    commitDesktopTabRailDrag,
    committedDesktopTabRailWidth,
    previewDesktopTabRailWidth,
    stopDesktopTabRailDrag,
  ]);

  useEffect(() => {
    if (orientation === "vertical") return;
    stopDesktopTabRailDrag();
    previewDesktopTabRailWidth(committedDesktopTabRailWidth);
  }, [
    committedDesktopTabRailWidth,
    orientation,
    previewDesktopTabRailWidth,
    stopDesktopTabRailDrag,
  ]);

  useEffect(() => () => {
    document.documentElement.classList.remove("workspace-tab-rail-resizing");
  }, []);

  const startDesktopTabRailDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      desktopTabRailDragRef.current
      || event.button !== 0
      || event.isPrimary === false
    ) return;
    event.preventDefault();
    event.currentTarget.focus();
    desktopTabRailDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: liveDesktopTabRailWidthRef.current,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners still keep the drag usable without pointer capture.
    }
    document.documentElement.classList.add("workspace-tab-rail-resizing");
  }, []);

  const desktopTabRailKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey
      ? DESKTOP_TAB_RAIL_KEYBOARD_LARGE_STEP
      : DESKTOP_TAB_RAIL_KEYBOARD_STEP;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = visibleDesktopTabRailWidth - step;
    if (event.key === "ArrowRight") nextWidth = visibleDesktopTabRailWidth + step;
    if (event.key === "Home") nextWidth = MIN_DESKTOP_TAB_RAIL_WIDTH;
    if (event.key === "End") nextWidth = desktopTabRailMaxWidth;
    if (event.key === "Enter") nextWidth = DEFAULT_DESKTOP_TAB_RAIL_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    commitDesktopTabRailWidth(nextWidth);
  }, [
    commitDesktopTabRailWidth,
    desktopTabRailMaxWidth,
    visibleDesktopTabRailWidth,
  ]);

  const navigationStyle = orientation === "vertical"
    ? {
      position: "relative",
      width: `${visibleDesktopTabRailWidth}px`,
      "--desktop-tab-rail-width": `${visibleDesktopTabRailWidth}px`,
    } as CSSProperties
    : undefined;
  const navigationStackStyle = orientation === "vertical"
    ? {
      width: `${visibleDesktopTabRailWidth}px`,
      "--desktop-tab-rail-width": `${visibleDesktopTabRailWidth}px`,
    } as CSSProperties
    : undefined;
  const compactDesktopTabRail = orientation === "vertical"
    && visibleDesktopTabRailWidth <= COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH;

  const focusSaveReplacement = useCallback(() => {
    if (isCompactWorkspaceViewport()) {
      const overviewControl = document.getElementById(MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID);
      if (overviewControl instanceof HTMLElement) {
        overviewControl.focus();
        return;
      }
    }
    const target = persistenceStatusRef.current || saveButtonRef.current;
    target?.focus();
  }, []);

  const focusTerminateDestination = useCallback((): boolean => {
    const focusAvailable = (target: HTMLElement | null | undefined): boolean => {
      if (!target?.isConnected || target.hasAttribute("disabled")) return false;
      for (let element: HTMLElement | null = target; element; element = element.parentElement) {
        if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      target.focus();
      return document.activeElement === target;
    };

    if (recentsOpenRef.current) {
      const overview = document.querySelector<HTMLElement>(".workspace-recents-sheet");
      if (overview) {
        const search = overview.querySelector<HTMLInputElement>(
          "input[aria-label='Find a workspace session']",
        );
        const preferred = isCompactWorkspaceViewport() ? overview : search;
        if (focusAvailable(preferred) || focusAvailable(overview)) return true;
      }
    }

    const candidates: Array<HTMLElement | null | undefined> = [
      activeTabRef.current,
      navigationRef.current?.querySelector<HTMLButtonElement>("[role='tab']"),
      document.querySelector<HTMLButtonElement>(".mobile-console-focus-button.terminal"),
      document.querySelector<HTMLButtonElement>(".console-header .back-button"),
      document.querySelector<HTMLButtonElement>(".console-bar-toggle"),
      document.querySelector<HTMLTextAreaElement>(".terminal-host .xterm-helper-textarea"),
      navigationRef.current?.querySelector<HTMLButtonElement>(".workspace-dashboard-button"),
      document.querySelector<HTMLInputElement>(".search-field input"),
    ];
    return candidates.some(focusAvailable);
  }, []);

  const focusTerminateReplacement = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusTerminateDestination();
      // Route-driven session switches can remove the first target one frame later.
      window.requestAnimationFrame(focusTerminateDestination);
    });
  }, [focusTerminateDestination]);

  useEffect(() => {
    if (recentsOpen) return;
    setRecentsQuery("");
    recentsScrollTopRef.current = 0;
  }, [recentsOpen]);

  useEffect(() => {
    if (workspacePersistenceState === "unsaved") return;
    setSaveDialogOpen(false);
    setSaveAfterRecents(false);
  }, [workspacePersistenceState]);

  useEffect(() => {
    if (
      recentsOpen
      || !saveAfterRecents
      || workspacePersistenceState !== "unsaved"
      || !onSaveWorkspace
    ) return;
    setSaveAfterRecents(false);
    setSaveDialogOpen(true);
  }, [onSaveWorkspace, recentsOpen, saveAfterRecents, workspacePersistenceState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTab = activeTabRef.current;
      if (activeTab && orientation === "vertical") {
        const viewport = activeTab.closest<HTMLElement>(".workspace-tab-viewport");
        if (viewport) {
          const viewportBounds = viewport.getBoundingClientRect();
          const tabBounds = activeTab.getBoundingClientRect();
          const viewportCenter = viewportBounds.top + viewportBounds.height / 2;
          const tabCenter = tabBounds.top + tabBounds.height / 2;
          viewport.scrollTop += tabCenter - viewportCenter;
        } else {
          activeTab.scrollIntoView?.({ block: "center", inline: "nearest" });
        }
      } else {
        activeTab?.scrollIntoView?.({ block: "nearest", inline: "center" });
      }
      if (focusActiveTabAfterClose.current && activeTab) {
        focusActiveTabAfterClose.current = false;
        activeTab.focus({ preventScroll: true });
      }
      const intent = reorderFocusIntent.current;
      if (intent) {
        const tab = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>(".workspace-tab") ?? [],
        ).find((item) => item.dataset.workspaceSessionName === intent.sessionName);
        const controls = Array.from(
          tab?.querySelectorAll<HTMLButtonElement>(".workspace-tab-move") ?? [],
        );
        const preferred = controls[intent.direction === "previous" ? 0 : 1];
        const target = preferred && !preferred.disabled
          ? preferred
          : controls.find((control) => !control.disabled)
            ?? tab?.querySelector<HTMLButtonElement>("[role='tab']");
        target?.focus();
        reorderFocusIntent.current = null;
      }
      const groupIntent = groupReorderFocusIntent.current;
      if (groupIntent) {
        const groupElement = Array.from(
          navigationRef.current?.querySelectorAll<HTMLElement>(
            "[data-workspace-tab-group-id]",
          ) ?? [],
        ).find((element) => element.dataset.workspaceTabGroupId === groupIntent.groupId);
        const controls = Array.from(
          groupElement?.querySelectorAll<HTMLButtonElement>(".workspace-tab-group-move") ?? [],
        );
        const preferred = controls[groupIntent.direction === "previous" ? 0 : 1];
        const target = preferred && !preferred.disabled
          ? preferred
          : controls.find((control) => !control.disabled)
            ?? groupElement?.querySelector<HTMLButtonElement>(".workspace-tab-group-toggle");
        target?.focus();
        groupReorderFocusIntent.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeSession,
    newSessionActive,
    openSessions,
    groups,
    orientation,
    reorderAnnouncement,
    tabsVisible,
  ]);

  const closeQuickTab = (sessionName: string) => {
    focusActiveTabAfterClose.current = true;
    onCloseTab(sessionName);
  };

  const openQuickTabInNewWindow = (
    sessionName: string,
    title: string,
    move: boolean,
  ) => {
    if (!onOpenTabInNewWindow) return;
    const result = onOpenTabInNewWindow(sessionName, move ? "move" : "copy");
    if (result !== "opened") {
      setReorderAnnouncement("");
      setWindowActionError(newWindowFailureMessage(result, title));
      return;
    }
    setWindowActionError("");
    setReorderAnnouncement(
      move
        ? `${title} moved to a new window. The tmux session keeps running.`
        : `${title} copied to a new window and remains open here.`,
    );
    if (move) closeQuickTab(sessionName);
  };

  const closeNewSession = () => {
    onCloseNewSession?.();
  };

  const moveQuickTab = (sessionName: string, title: string, targetIndex: number) => {
    if (!onMoveTab || targetIndex < 0 || targetIndex >= openSessions.length) return;
    const resultIndex = tabMoveResultIndex(openSessions, groups, sessionName, targetIndex);
    reorderFocusIntent.current = {
      sessionName,
      direction: targetIndex < openSessions.indexOf(sessionName) ? "previous" : "next",
    };
    onMoveTab(sessionName, targetIndex);
    setReorderAnnouncement(
      `${title} moved to position ${resultIndex + 1} of ${openSessions.length}.`,
    );
  };

  const sortTabsByWorkingState = () => {
    if (!onSortTabsByWorkingState) return;
    onSortTabsByWorkingState();
    setReorderAnnouncement(
      "Tabs sorted with non-working sessions first and working sessions second. Relative order within each status was preserved.",
    );
  };

  const openGroupDialog = (
    groupId: string | null,
    initialSession: string | null,
    trigger?: HTMLElement | null,
  ) => {
    if (!onSaveTabGroup) return;
    groupDialogTriggerRef.current = trigger ?? null;
    setGroupDialog({ groupId, initialSession });
  };

  const closeGroupDialog = () => {
    setGroupDialog(null);
    if (recentsOpen) return;
    window.requestAnimationFrame(() => {
      const trigger = groupDialogTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else activeTabRef.current?.focus();
    });
  };

  const moveGroup = (group: WorkspaceTabGroup, direction: -1 | 1) => {
    if (!onMoveTabGroup) return;
    groupReorderFocusIntent.current = {
      groupId: group.id,
      direction: direction < 0 ? "previous" : "next",
    };
    onMoveTabGroup(group.id, direction);
    setReorderAnnouncement(
      `${group.name} group moved ${direction < 0 ? "back" : "forward"}.`,
    );
  };

  const requestSaveFromRecents = () => {
    if (!onSaveWorkspace || workspacePersistenceState !== "unsaved") return;
    setSaveAfterRecents(true);
    onCloseRecents();
  };

  const terminateSelectedSession = useCallback(async () => {
    if (!terminateTarget || !onSessionTerminated) {
      throw new Error("This tmux session is no longer available.");
    }
    const completedTarget = terminateTarget;
    await onSessionTerminated(
      completedTarget.name,
      completedTarget.id,
      completedTarget.created,
      completedTarget.serverStarted,
      completedTarget.serverPid,
    );
    completedTerminationRef.current = completedTarget;
  }, [onSessionTerminated, terminateTarget]);

  useLayoutEffect(() => {
    const completedTarget = completedTerminationRef.current;
    if (!completedTarget || terminateTarget) return;
    const currentSession = sessionsByName.get(completedTarget.name);
    if (
      currentSession
      && currentSession.id === completedTarget.id
      && currentSession.created === completedTarget.created
      && currentSession.serverStarted === completedTarget.serverStarted
      && currentSession.serverPid === completedTarget.serverPid
    ) return;

    let followupFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (focusTerminateDestination()) {
        completedTerminationRef.current = null;
        return;
      }
      followupFrame = window.requestAnimationFrame(() => {
        if (focusTerminateDestination()) completedTerminationRef.current = null;
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (followupFrame) window.cancelAnimationFrame(followupFrame);
    };
  }, [
    activeSession,
    focusTerminateDestination,
    openSessions,
    recentsOpen,
    sessionsByName,
    tabsVisible,
    terminateTarget,
  ]);

  const renderWorkspaceTab = (
    sessionName: string,
    group?: WorkspaceTabGroup,
  ) => {
    const index = openSessions.indexOf(sessionName);
    const session = sessionsByName.get(sessionName);
    const title = tabTitle(sessionName, sessionsByName);
    const active = !newSessionActive && sessionName === activeSession;
    const groupTabIndex = group?.tabs.indexOf(sessionName) ?? -1;
    const canMovePrevious = group ? groupTabIndex > 0 : index > 0;
    const canMoveNext = group
      ? groupTabIndex >= 0 && groupTabIndex < group.tabs.length - 1
      : index < openSessions.length - 1;
    const canDragTab = desktopTabDragEnabled && (
      !group || (!group.collapsed && group.tabs.length > 1)
    );
    const dropEdge = workspaceTabDrag?.target?.kind === "tab"
      && workspaceTabDrag.target.id === sessionName
      ? workspaceTabDrag.target.edge
      : undefined;
    const tabShortcutBinding = index < 9
      ? shortcutBindings[
        `workspace-tab-${index + 1}` as keyof typeof shortcutBindings
      ]
      : undefined;
    const tabShortcut = directShortcutLabel(tabShortcutBinding);
    return (
      <div
        className={active ? "workspace-tab active" : "workspace-tab"}
        data-workspace-session-name={sessionName}
        data-tab-group-color={group?.color}
        data-tab-dragging={workspaceTabDrag?.sessionName === sessionName
          ? "true"
          : undefined}
        data-tab-drop-edge={dropEdge}
        key={sessionName}
        onDragOver={desktopTabDragEnabled
          ? (event) => dragOverWorkspaceTab(event, sessionName)
          : undefined}
        onDrop={desktopTabDragEnabled
          ? (event) => dropOnWorkspaceTab(event, sessionName)
          : undefined}
      >
        <button
          ref={active ? activeTabRef : undefined}
          type="button"
          role="tab"
          aria-selected={active}
          aria-controls={active ? "muxdeck-active-console" : undefined}
          aria-label={`${title}${group ? `, ${group.name} group` : ""}${session ? `, ${STATE_LABELS[session.agentState]}` : ", unavailable"}`}
          aria-keyshortcuts={directShortcutAria(tabShortcutBinding)}
          title={tabShortcut ? `${title} (${tabShortcut})` : title}
          tabIndex={active ? 0 : -1}
          draggable={canDragTab ? true : undefined}
          aria-description={canDragTab
            ? "Drag to reorder this tab. Reorder buttons are also available in Actions."
            : undefined}
          onKeyDown={tabKeyDown}
          onClick={() => onSelect(sessionName)}
          onDragStart={canDragTab
            ? (event) => startWorkspaceTabDrag(event, sessionName)
            : undefined}
          onDragEnd={canDragTab ? finishWorkspaceTabDrag : undefined}
        >
          <span className={`workspace-state-dot ${session?.agentState || "unavailable"}`} aria-hidden="true" />
          <span
            className="workspace-tab-compact-index"
            data-index={index + 1}
            aria-hidden="true"
          />
          <span className="workspace-tab-title">{title}</span>
        </button>
        {tabActionsVisible && onMoveTab && openSessions.length > 1 && (
          <span
            className="workspace-tab-reorder"
            role="group"
            aria-label={`Reorder ${title} tab${group ? ` inside ${group.name}` : ""}`}
          >
            <button
              type="button"
              className={`workspace-tab-move workspace-tab-move-${orientation === "vertical" ? "up" : "left"}`}
              onClick={() => moveQuickTab(sessionName, title, index - 1)}
              disabled={!canMovePrevious}
              aria-label={`Move ${title} tab ${orientation === "vertical" ? "up" : "left"}`}
              title={`Move tab ${orientation === "vertical" ? "up" : "left"}`}
            >
              {orientation === "vertical" ? <ArrowUpIcon /> : <ArrowLeftIcon />}
            </button>
            <button
              type="button"
              className={`workspace-tab-move workspace-tab-move-${orientation === "vertical" ? "down" : "right"}`}
              onClick={() => moveQuickTab(sessionName, title, index + 1)}
              disabled={!canMoveNext}
              aria-label={`Move ${title} tab ${orientation === "vertical" ? "down" : "right"}`}
              title={`Move tab ${orientation === "vertical" ? "down" : "right"}`}
            >
              {orientation === "vertical" ? <ArrowDownIcon /> : <ArrowLeftIcon />}
            </button>
          </span>
        )}
        {tabActionsVisible && onOpenTabInNewWindow && (
          <span
            className="workspace-tab-window-actions"
            role="group"
            aria-label={`${title} tab window actions`}
          >
            <button
              type="button"
              className="workspace-tab-window-move"
              onClick={() => openQuickTabInNewWindow(sessionName, title, true)}
              disabled={Boolean(windowMoveDisabledReason)}
              aria-label={`Move ${title} tab to new window`}
              aria-description={windowMoveDisabledReason
                ?? "Opens this session in a separate browser window and removes this quick tab here. The tmux session keeps running."}
              title={windowMoveDisabledReason ?? "Move tab to new window"}
            >
              <WindowMoveIcon />
            </button>
            <button
              type="button"
              className="workspace-tab-window-copy"
              onClick={() => openQuickTabInNewWindow(sessionName, title, false)}
              aria-label={`Copy ${title} tab to new window`}
              aria-description="Opens this session in a separate browser window and keeps this quick tab here."
              title="Copy tab to new window"
            >
              <WindowCopyIcon />
            </button>
          </span>
        )}
        {tabActionsVisible && session && onSessionTerminated && (
          <button
            type="button"
            className="workspace-tab-terminate"
            onClick={() => setTerminateTarget(session)}
            aria-label={`Terminate ${title} tmux session`}
            aria-haspopup="dialog"
            title="Terminate tmux session"
          >
            <TrashIcon />
          </button>
        )}
        {tabActionsVisible && (
          <button
            type="button"
            className="workspace-tab-close"
            onClick={() => closeQuickTab(sessionName)}
            aria-label={`Close ${title} quick tab`}
            title="Close quick tab"
          >
            <CloseIcon />
          </button>
        )}
      </div>
    );
  };

  const commandPaletteCommands = buildWorkspaceCommands({
    activeSession,
    newSessionActive,
    openSessions,
    sessionsByName,
    tabsVisible,
    tabActionsVisible,
    workspacePersistenceState,
    newSessionDisabled,
    onNewSession,
    onOpenTabSearch,
    onOpenRecents,
    onOpenDashboard,
    onSelect,
    onRequestSaveWorkspace: workspacePersistenceState === "unsaved" && onSaveWorkspace
      ? () => setSaveDialogOpen(true)
      : undefined,
    onCreateTabGroup: canCreateGroup
      ? () => openGroupDialog(null, activeSession, null)
      : undefined,
    onSortTabsByWorkingState: onSortTabsByWorkingState && openSessions.length > 1
      ? sortTabsByWorkingState
      : undefined,
    onToggleTabActions,
    onCloseActiveTab: activeSession && onCloseTab
      ? () => onCloseTab(activeSession)
      : undefined,
  });

  return (
    <>
      <div
        className={`workspace-navigation-stack workspace-navigation-stack-${orientation}`}
        data-orientation={orientation}
        data-compact={compactDesktopTabRail ? "true" : undefined}
        style={navigationStackStyle}
        hidden={!tabsVisible}
      >
        <nav
          ref={navigationRef}
          id="muxdeck-session-tabs"
          className={`workspace-navigation workspace-navigation-${orientation}`}
          data-orientation={orientation}
          data-compact={compactDesktopTabRail ? "true" : undefined}
          data-tab-actions-visible={tabActionsVisible ? "true" : "false"}
          data-tab-drag-active={workspaceTabDrag ? "true" : undefined}
          style={navigationStyle}
          aria-label="Session workspace"
          hidden={!tabsVisible}
        >
          <button
            type="button"
            className="workspace-dashboard-button"
            onClick={onOpenDashboard}
            aria-label="All sessions"
            title="All sessions"
          >
            <GridIcon />
            <span>Sessions</span>
          </button>
          {onNewSession && (
            <button
              type="button"
              className={newSessionActive
                ? "workspace-new-session-button active"
                : "workspace-new-session-button"}
              onClick={onNewSession}
              disabled={newSessionDisabled}
              aria-label="New session"
              aria-keyshortcuts={directShortcutAria(
                shortcutBindings["workspace-new-session"],
              )}
              aria-current={newSessionActive ? "page" : undefined}
              title={newSessionActive
                ? "New session is already open"
                : workspacePersistenceState === "loading"
                  ? "Wait for workspace to finish opening"
                  : `New session${directShortcutLabel(
                    shortcutBindings["workspace-new-session"],
                  ) ? ` (${directShortcutLabel(
                      shortcutBindings["workspace-new-session"],
                    )})` : ""}`}
            >
              <PlusIcon />
              <span>New session</span>
            </button>
          )}
          {orientation === "vertical" && onSortTabsByWorkingState && openSessions.length > 1 && (
            <button
              type="button"
              className="workspace-tab-status-sort"
              onClick={sortTabsByWorkingState}
              aria-label="Stable sort tabs: non-working first, then working"
              aria-description="Preserves the existing relative order within each status. Tab groups stay together."
              title="Stable sort: non-working first, then working"
            >
              <ListIcon />
              <span>Non-working first</span>
              <small>Stable</small>
            </button>
          )}
          <div className="workspace-tab-viewport">
            <div
              className="workspace-tab-list"
              role="tablist"
              aria-label="Session workspace tabs"
              aria-orientation={orientation}
              onDragOver={desktopTabDragEnabled
                ? clearWorkspaceTabDropTarget
                : undefined}
              onDragLeave={desktopTabDragEnabled
                ? (event) => {
                  const relatedTarget = event.relatedTarget;
                  if (
                    relatedTarget instanceof Node
                    && event.currentTarget.contains(relatedTarget)
                  ) return;
                  clearWorkspaceTabDropTarget();
                }
                : undefined}
              onDrop={desktopTabDragEnabled ? finishWorkspaceTabDrag : undefined}
            >
              {workspaceTabItems.map((item) => {
                if (item.kind === "tab") return renderWorkspaceTab(item.sessionName);
                const { group } = item;
                const groupStart = openSessions.indexOf(group.tabs[0]);
                const groupEnd = groupStart + group.tabs.length - 1;
                const visibleTabs = group.collapsed
                  ? group.tabs.filter((sessionName) => sessionName === activeSession)
                  : group.tabs;
                const dropEdge = workspaceTabDrag?.target?.kind === "group"
                  && workspaceTabDrag.target.id === group.id
                  ? workspaceTabDrag.target.edge
                  : undefined;
                return (
                  <div
                    className={group.collapsed
                      ? "workspace-tab-group collapsed"
                      : "workspace-tab-group"}
                    data-workspace-tab-group-id={group.id}
                    data-tab-group-color={group.color}
                    data-tab-drop-edge={dropEdge}
                    key={group.id}
                    onDragOver={desktopTabDragEnabled
                      ? (event) => dragOverWorkspaceTabGroup(event, group)
                      : undefined}
                    onDrop={desktopTabDragEnabled
                      ? (event) => dropOnWorkspaceTabGroup(event, group)
                      : undefined}
                  >
                    <div className="workspace-tab-group-chip">
                      {onToggleTabGroup ? (
                        <button
                          type="button"
                          className="workspace-tab-group-toggle"
                          onClick={() => onToggleTabGroup(group.id, !group.collapsed)}
                          aria-expanded={!group.collapsed}
                          aria-controls={`workspace-tab-group-tabs-${group.id}`}
                          aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name} tab group`}
                          title={`${group.collapsed ? "Expand" : "Collapse"} ${group.name}`}
                        >
                          <span className="workspace-tab-group-color" aria-hidden="true" />
                          <FolderIcon />
                          <strong>{group.name}</strong>
                          <small>{group.tabs.length}</small>
                          <ArrowDownIcon aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="workspace-tab-group-toggle">
                          <span className="workspace-tab-group-color" aria-hidden="true" />
                          <FolderIcon />
                          <strong>{group.name}</strong>
                          <small>{group.tabs.length}</small>
                        </span>
                      )}
                      {onMoveTabGroup && (
                        <span className="workspace-tab-group-reorder" role="group" aria-label={`Move ${group.name} group`}>
                          <button
                            type="button"
                            className="workspace-tab-group-move workspace-tab-group-move-previous"
                            onClick={() => moveGroup(group, -1)}
                            disabled={groupStart === 0}
                            aria-label={`Move ${group.name} group ${orientation === "vertical" ? "up" : "left"}`}
                            title={`Move group ${orientation === "vertical" ? "up" : "left"}`}
                          >
                            {orientation === "vertical" ? <ArrowUpIcon /> : <ArrowLeftIcon />}
                          </button>
                          <button
                            type="button"
                            className="workspace-tab-group-move workspace-tab-group-move-next"
                            onClick={() => moveGroup(group, 1)}
                            disabled={groupEnd === openSessions.length - 1}
                            aria-label={`Move ${group.name} group ${orientation === "vertical" ? "down" : "right"}`}
                            title={`Move group ${orientation === "vertical" ? "down" : "right"}`}
                          >
                            {orientation === "vertical" ? <ArrowDownIcon /> : <ArrowLeftIcon />}
                          </button>
                        </span>
                      )}
                      {onSaveTabGroup && onDeleteTabGroup && (
                        <button
                          type="button"
                          className="workspace-tab-group-edit"
                          onClick={(event) => openGroupDialog(
                            group.id,
                            null,
                            event.currentTarget,
                          )}
                          aria-label={`Edit ${group.name} tab group`}
                          title="Edit tab group"
                        >
                          <EditIcon />
                        </button>
                      )}
                    </div>
                    <div
                      id={`workspace-tab-group-tabs-${group.id}`}
                      className="workspace-tab-group-tabs"
                    >
                      {visibleTabs.map((sessionName) => renderWorkspaceTab(sessionName, group))}
                    </div>
                  </div>
                );
              })}
              {canCreateGroup && (
                <button
                  type="button"
                  className="workspace-new-group-button"
                  onClick={(event) => openGroupDialog(
                    null,
                    activeSession,
                    event.currentTarget,
                  )}
                  aria-label="Create tab group"
                  title="Create tab group"
                >
                  <PlusIcon />
                  <span>New group</span>
                </button>
              )}
              {newSessionActive && (
                <div className="workspace-tab workspace-new-session-tab active">
                  <button
                    ref={activeTabRef}
                    type="button"
                    role="tab"
                    aria-selected="true"
                    aria-controls={NEW_SESSION_PANEL_ID}
                    aria-label="New session, not created yet"
                    tabIndex={0}
                    onKeyDown={tabKeyDown}
                  >
                    <span className="workspace-state-dot new-session" aria-hidden="true" />
                    <span
                      className="workspace-tab-compact-index"
                      data-index="+"
                      aria-hidden="true"
                    />
                    <span className="workspace-tab-title">New session</span>
                  </button>
                  {tabActionsVisible && onCloseNewSession && (
                    <button
                      type="button"
                      className="workspace-tab-close"
                      onClick={closeNewSession}
                      aria-label="Close New session tab"
                      title="Close new session"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {workspacePersistenceState === "unsaved" ? onSaveWorkspace && (
            <button
              ref={saveButtonRef}
              type="button"
              className="workspace-save-button"
              onClick={() => setSaveDialogOpen(true)}
              aria-haspopup="dialog"
              aria-controls="workspace-save-dialog"
              aria-expanded={saveDialogOpen}
              aria-label="Save workspace"
              aria-description={`Workspace: ${identityName}`}
              title={`${identityName} - Save workspace`}
            >
              <SaveIcon />
              <span className="workspace-identity-copy">
                <span className="workspace-identity-name" title={identityName}>
                  {identityName}
                </span>
                <span className="workspace-identity-state">Save</span>
              </span>
            </button>
          ) : persistenceCopy && (
            <span
              ref={persistenceStatusRef}
              className={`workspace-saved-indicator ${workspacePersistenceState}`}
              role="status"
              tabIndex={-1}
              aria-label={persistenceCopy.accessibleLabel}
              aria-description={`Workspace: ${identityName}`}
              title={`${identityName} - ${persistenceCopy.label}`}
            >
              {workspacePersistenceState === "saved"
                ? <CheckIcon />
                : workspacePersistenceState === "loading"
                  ? <HistoryIcon />
                  : <SaveIcon />}
              <span className="workspace-identity-copy">
                <span className="workspace-identity-name" title={identityName}>
                  {identityName}
                </span>
                <span className="workspace-identity-state">{persistenceCopy.label}</span>
              </span>
            </span>
          )}
          {!compactViewport && onSwitchWorkspace && (
            <WorkspaceQuickSwitcher
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceName={identityName}
              disabled={workspacePersistenceState === "loading"}
              onSwitch={onSwitchWorkspace}
            />
          )}
          {onOpenTabSearch && openSessions.length > 0 && (
            <button
              type="button"
              className="workspace-tab-search-button"
              onClick={onOpenTabSearch}
              aria-label="Search open tabs"
              aria-keyshortcuts={directShortcutAria(
                shortcutBindings["workspace-find-tab"],
              )}
              title={`Search open tabs${directShortcutLabel(
                shortcutBindings["workspace-find-tab"],
              ) ? ` (${directShortcutLabel(shortcutBindings["workspace-find-tab"])})` : ""}`}
            >
              <SearchIcon />
              <span>Find tab</span>
              {directShortcutLabel(shortcutBindings["workspace-find-tab"]) && (
                <kbd>{directShortcutLabel(shortcutBindings["workspace-find-tab"])}</kbd>
              )}
            </button>
          )}
          <WorkspaceCommandPalette
            commands={commandPaletteCommands}
            compactViewport={compactViewport}
          />
          <button
            type="button"
            className={recentsOpen ? "workspace-recents-button active" : "workspace-recents-button"}
            onClick={onOpenRecents}
            aria-haspopup="dialog"
            aria-expanded={recentsOpen}
            aria-label={`Open session switcher${closedRecentCount > 0 ? `, ${closedRecentCount} recently visited` : ""}`}
          >
            <HistoryIcon />
            <span>Recents</span>
            {closedRecentCount > 0 && <strong>{closedRecentCount}</strong>}
          </button>
          {orientation === "vertical" && (
            <div
              className="workspace-tab-rail-resize-handle"
              role="separator"
              tabIndex={0}
              aria-label="Resize vertical session tabs"
              aria-orientation="vertical"
              aria-valuemin={MIN_DESKTOP_TAB_RAIL_WIDTH}
              aria-valuemax={desktopTabRailMaxWidth}
              aria-valuenow={visibleDesktopTabRailWidth}
              aria-valuetext={`${visibleDesktopTabRailWidth} pixels`}
              title="Drag to resize. Use Left/Right, Shift for larger steps, Home/End, or Enter to reset."
              onPointerDown={startDesktopTabRailDrag}
              onLostPointerCapture={(event) => commitDesktopTabRailDrag(event.pointerId)}
              onDoubleClick={() => commitDesktopTabRailWidth(DEFAULT_DESKTOP_TAB_RAIL_WIDTH)}
              onKeyDown={desktopTabRailKeyDown}
            >
              <span className="workspace-tab-rail-resize-grip" aria-hidden="true" />
            </div>
          )}
        </nav>
      </div>

      <WorkspaceWindowActionError
        message={windowActionError}
        onDismiss={() => setWindowActionError("")}
      />

      <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {newSessionActive
          ? "Active view: New session"
          : `Active session: ${activeSession
            ? tabTitle(activeSession, sessionsByName)
            : "None"}`}
      </p>

      {reorderAnnouncement && (
        <p className="workspace-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement}
        </p>
      )}

      {recentsOpen && !terminateTarget && !groupDialog && (
        <WorkspaceRecentsDialog
          {...props}
          sessionsByName={sessionsByName}
          query={recentsQuery}
          initialScrollTop={recentsScrollTopRef.current}
          onQueryChange={setRecentsQuery}
          onScrollPositionChange={(scrollTop) => {
            recentsScrollTopRef.current = scrollTop;
          }}
          onRequestSaveWorkspace={requestSaveFromRecents}
          onRequestTerminateSession={setTerminateTarget}
          onRequestNewTabGroup={(initialSession) => openGroupDialog(
            null,
            initialSession ?? activeSession,
            null,
          )}
          onRequestEditTabGroup={(groupId) => openGroupDialog(
            groupId,
            null,
            null,
          )}
        />
      )}

      {terminateTarget && onSessionTerminated && (
        <SessionTerminateDialog
          sessionName={terminateTarget.name}
          sessionTitle={terminateTarget.customTitle}
          onClose={() => setTerminateTarget(null)}
          onTerminate={terminateSelectedSession}
          onFallbackFocus={focusTerminateReplacement}
        />
      )}

      {saveDialogOpen && onSaveWorkspace && workspacePersistenceState === "unsaved" && (
        <WorkspaceSaveDialog
          tabs={openSessions}
          activeSession={activeSession}
          onSave={onSaveWorkspace}
          onClose={() => setSaveDialogOpen(false)}
          onFallbackFocus={focusSaveReplacement}
        />
      )}

      {groupDialog && onSaveTabGroup && (
        <WorkspaceGroupDialog
          groups={groups}
          openSessions={openSessions}
          sessions={sessions}
          groupId={groupDialog.groupId}
          initialSession={groupDialog.initialSession}
          onSave={onSaveTabGroup}
          onDelete={(groupId) => onDeleteTabGroup?.(groupId)}
          onClose={closeGroupDialog}
        />
      )}
    </>
  );
}
