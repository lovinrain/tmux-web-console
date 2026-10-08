import type { RecoverableSession, SavedWorkspace, WorkspacePaneLayout } from "../../api";
import type { Session } from "../../types";
import type { SeparatorCrossing } from "../../workspaceSeparatorMovement";
import type { WorkspaceSessionParents, WorkspaceTabGroup } from "../../workspaceState";

export interface SessionWorkspaceNavigationProps {
  activeSession: string | null;
  openSessions: string[];
  recentSessions: string[];
  groups?: WorkspaceTabGroup[];
  sessionParents?: WorkspaceSessionParents;
  separators?: string[];
  separatorsBefore?: string[];
  separatorsBusy?: boolean;
  separatorsError?: string;
  onChangeSeparator?: (sessionName: string, add: boolean, side?: "before" | "after") => void;
  onCrossSeparator?: (crossing: SeparatorCrossing) => void;
  sessions: Session[];
  uncheckedReadySessions?: ReadonlySet<string>;
  onMarkSessionUnread?: (sessionName: string) => void;
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
  onMoveTabs?: (sessionNames: string[], targetIndex: number) => void;
  onReparentSession?: (sessionName: string, parentName: string | null) => void;
  onTabSelectionChange?: (sessionNames: string[]) => void;
  onTransferSelectedSessions?: (sessionNames: string[]) => void;
  onBulkSessionAction?: (action: "close" | "end", sessionNames: string[]) => void;
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
  dashboardWindowHref?: string;
  onNewSession?: () => void;
  onAddSession?: (sessionName: string, open: boolean) => void;
  onQuickNewSession?: () => void | Promise<void>;
  onToggleCallbackSession?: () => void | Promise<void>;
  quickNewSessionBusy?: boolean;
  quickNewSessionError?: string | null;
  onDismissQuickNewSessionError?: () => void;
  onOpenTabSearch?: () => void;
  missingSessionCount?: number;
  onRecreateAllMissing?: () => void;
  recoverableSessions?: RecoverableSession[];
  onRecreateSession?: (sessionName: string) => void | Promise<void>;
  paneLayouts?: WorkspacePaneLayout[];
  activePaneLayoutId?: string | null;
  paneLayoutsBusy?: boolean;
  onSelectPaneLayout?: (layoutId: string) => void;
  onCreatePaneLayout?: () => void | Promise<void>;
  workspacePersistenceState?: WorkspacePersistenceState;
  activeWorkspaceId?: string | null;
  workspaceName?: string | null;
  onSwitchWorkspace?: (workspace: SavedWorkspace) => void;
  onSaveWorkspace?: (name: string) => Promise<void>;
  onRenameWorkspace?: (name: string) => Promise<void>;
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

export type WorkspacePersistenceState =
  | "unsaved"
  | "loading"
  | "saved"
  | "limited"
  | "error";
