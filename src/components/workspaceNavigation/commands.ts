import {
  dispatchShortcutAction,
  PANE_NAVIGATION_ACTION,
  type ShortcutActionId
} from "../../shortcutSettings";
import { requestThemeToggle } from "../../theme";
import type { Session } from "../../types";
import {
  type WorkspaceCommand
} from "../WorkspaceCommandPalette";


import { DESKTOP_CONSOLE_SHORTCUTS, WORKSPACE_TAB_SHORTCUTS } from "./constants";
import { activePane, tabTitle } from "./presentation";
import type { WorkspacePersistenceState } from "./types";

export interface WorkspaceCommandContext {
  activeSession: string | null;
  snippetSessionAvailable: boolean;
  newSessionActive: boolean;
  openSessions: readonly string[];
  sessionsByName: Map<string, Session>;
  tabsVisible: boolean;
  tabActionsVisible: boolean;
  paneLayoutActive: boolean;
  workspacePersistenceState: WorkspacePersistenceState;
  newSessionDisabled: boolean;
  quickNewSessionDisabled: boolean;
  onNewSession?: () => void;
  onQuickNewSession?: () => void | Promise<void>;
  onToggleCallbackSession?: () => void | Promise<void>;
  onOpenTabSearch?: () => void;
  onOpenRecents: () => void;
  onOpenDashboard: () => void;
  onSelect: (sessionName: string) => void;
  onRequestSaveWorkspace?: () => void;
  onRequestRenameWorkspace?: () => void;
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

export function buildWorkspaceCommands({
  activeSession,
  snippetSessionAvailable,
  newSessionActive,
  openSessions,
  sessionsByName,
  tabsVisible,
  tabActionsVisible,
  paneLayoutActive,
  workspacePersistenceState,
  newSessionDisabled,
  quickNewSessionDisabled,
  onNewSession,
  onQuickNewSession,
  onToggleCallbackSession,
  onOpenTabSearch,
  onOpenRecents,
  onOpenDashboard,
  onSelect,
  onRequestSaveWorkspace,
  onRequestRenameWorkspace,
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
    {
      id: "workspace-quick-new-session",
      label: "Quick temporary session",
      description: "Start an assigned-name session from the best remembered workspace path.",
      category: "Workspace",
      shortcutId: "workspace-quick-new-session",
      shortcut: "Ctrl+Shift+K",
      launcherKey: "K",
      keywords: ["quick create", "temporary", "random name", "workspace memory"],
      disabled: !onQuickNewSession || quickNewSessionDisabled,
      disabledReason: "Wait for the current quick session or workspace load to finish.",
      run: () => void onQuickNewSession?.(),
    },
    {
      id: "workspace-callback",
      label: "Add or remove current session from callback list",
      description: "Keep this session in the workspace callback queue for later review.",
      category: "Workspace",
      shortcutId: "workspace-callback",
      shortcut: "Ctrl+Shift+K",
      keywords: ["callback", "watch", "follow up", "later", "queue"],
      disabled: !onToggleCallbackSession || !activeSessionLoaded,
      disabledReason: "Open a live session first.",
      run: () => void onToggleCallbackSession?.(),
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
    shortcutCommand({
      id: "input-insert-snippet",
      label: "Insert snippet",
      description: "Search or edit a saved snippet and insert it into staged input.",
      category: "Session",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.insertSnippet,
      keywords: ["snippet", "prompt", "template", "draft", "staged input"],
      disabled: !snippetSessionAvailable,
      disabledReason: "Open a live session first.",
    }, "input-insert-snippet"),
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
      id: "terminal-scrollback",
      label: "Open scrollback",
      description: "Open the current pane's scrollback and recorded session output.",
      category: "Terminal",
      keywords: ["history", "transcript", "past output", "scrollback"],
      disabled: !snippetSessionAvailable,
      disabledReason: "Open a session first.",
    }, "terminal-scrollback"),
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
    shortcutCommand({
      id: PANE_NAVIGATION_ACTION,
      label: "Navigate between panes",
      description: "Arm the pane grid, then use arrow keys to move terminal focus.",
      category: "View",
      keywords: ["pane", "grid", "focus", "arrow", "tmux"],
      disabled: !paneLayoutActive,
      disabledReason: "Open a multi-pane view first.",
    }, PANE_NAVIGATION_ACTION),
    shortcutCommand({
      id: "view-floating-input",
      label: "Show or hide floating staged input",
      description: "Edit the active session's staged draft in a movable, pinnable window.",
      category: "View",
      shortcut: DESKTOP_CONSOLE_SHORTCUTS.floatingInput,
      keywords: ["prompt", "composer", "draft", "focus mode", "pin"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "view-floating-input"),
    shortcutCommand({
      id: "view-floating-terminal",
      label: "Show or hide utility terminal",
      description: "Open an independent shell in a movable, resizable workspace window.",
      category: "View",
      keywords: ["shell", "floating", "terminal", "pin"],
      disabled: !activeSessionLoaded,
      disabledReason: "Open a live session first.",
    }, "view-floating-terminal"),
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
  if (onRequestRenameWorkspace) {
    commands.push({
      id: "workspace-rename",
      label: "Rename this workspace",
      description: "Open workspace details and update its shared name.",
      category: "Workspace",
      keywords: ["workspace settings", "workspace attributes", "edit name", "details"],
      run: onRequestRenameWorkspace,
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
