import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  BASE_PATH,
  copySession,
  createQueuedMessage,
  deleteQueuedMessage,
  listSessions,
  renameSession,
  uploadSessionAttachment,
  updateSessionDetails,
  updateSessionWorkspacePin,
  updateSessionTags,
  updateSessionTitle,
  type WorkspaceSessionTransferOperation,
  type WorkspaceSessionTransferResult,
} from "../api";
import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ContractIcon,
  ExpandIcon,
  ExternalLinkIcon,
  FolderIcon,
  GridIcon,
  HistoryIcon,
  KeyboardIcon,
  ListIcon,
  MoveIcon,
  PinIcon,
  RefreshIcon,
  TerminalIcon,
  TrashIcon,
  WindowCopyIcon,
  WindowMoveIcon,
} from "../icons";
import {
  AGENT_SCROLL_PREFERENCES_STORAGE_KEY,
  loadAgentScrollPreferences,
  preferredAgentScrollMode,
  rememberAgentScrollMode,
  type AgentScrollMode,
} from "../agentScrollPreferences";
import { paneCommandKind } from "../sessionDashboardModel";
import { resolveTerminalFileLinkPath } from "../terminalFileLinks";
import {
  SHORTCUT_ACTION_EVENT,
  directShortcutAria,
  directShortcutLabel,
  matchesDirectShortcut,
  useShortcutSettings,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../shortcutSettings";
import { useTheme } from "../theme";
import type { ConnectionState, Pane, Session, SessionTag } from "../types";
import { AccountLink } from "./AccountLink";
import { DEFAULT_HISTORY_PANEL_WIDTH, HistoryPanel } from "./HistoryPanel";
import {
  FloatingStagedInput,
  type FloatingStagedInputHandle,
  type FloatingStagedInputPanelState,
} from "./FloatingStagedInput";
import {
  handoffRenamedSessionDraft,
  InputBar,
  type InputBarHandle,
  type MemoDraftSource,
} from "./InputBar";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";
import { MessageQueueDialog } from "./MessageQueueDialog";
import { activePane, classifyPane } from "./SessionDashboard";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import { SessionTitleDialog } from "./SessionTitleDialog";
import { SessionRenameDialog } from "./SessionRenameDialog";
import {
  SessionFilesPanel,
  type SessionFileOpenRequest,
} from "./SessionFilesPanel";
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import { SessionWorkspaceTransferDialog } from "./SessionWorkspaceTransferDialog";
import {
  DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
  MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID,
  clampDesktopTabRailWidth,
  type OpenTabInNewWindowResult,
  type WorkspaceTabOrientation,
} from "./SessionWorkspaceNavigation";
import { ThemeToggle } from "./ThemeToggle";

interface ConsoleScreenProps {
  sessionName: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  onBack: () => void;
  dashboardWindowHref?: string;
  headerNotes?: ReactNode;
  workspaceLinks?: ReactNode;
  sessionNavigation?: ReactNode;
  workspaceOverlayOpen?: boolean;
  mobileMode?: MobileConsoleMode;
  onMobileModeChange?: (mode: MobileConsoleMode) => void;
  onOpenWorkspaceOverview?: () => void;
  onCloseWorkspaceOverview?: () => void;
  barVisibility?: ConsoleBarVisibility;
  onBarVisibilityChange?: (bar: ConsoleBar, visible: boolean) => void;
  desktopTabOrientation?: WorkspaceTabOrientation;
  onDesktopTabOrientationChange?: (orientation: WorkspaceTabOrientation) => void;
  tabActionsVisible?: boolean;
  onTabActionsVisibilityChange?: (visible: boolean) => void;
  desktopTabRailWidth?: number;
  onDesktopTabRailWidthChange?: (width: number) => void;
  historyPanelWidth?: number;
  onHistoryPanelWidthChange?: (width: number) => void;
  onSessionsChange?: (sessions: Session[]) => void;
  onSessionUpdate?: (session: Session) => void;
  onWorkspacePinChange?: (
    sessionName: string,
    pinned: boolean,
    sessionRevision: number,
  ) => void | Promise<void>;
  onSessionWorkspaceTransfer?: (
    sessionName: string,
    destinationWorkspaceId: string,
    operation: WorkspaceSessionTransferOperation,
    sessionRevision: number,
  ) => Promise<WorkspaceSessionTransferResult>;
  workspaceTransferDisabled?: boolean;
  onSessionRenamed?: (
    previousName: string,
    nextName: string,
    sessionId: string,
    warnings?: readonly string[],
  ) => void;
  onSessionTerminated?: (
    sessionName: string,
    sessionId: string,
    sessionCreated: number,
    serverStarted: number,
    serverPid: number,
  ) => Promise<void>;
  onSessionCopied?: (
    sourceName: string,
    sessionName: string,
    sessionId: string,
  ) => void;
  onSplitWorkspace?: (sessionName: string) => OpenTabInNewWindowResult;
  copySessionDisabled?: boolean;
  renameWarning?: SessionRenameWarning | null;
  onDismissRenameWarning?: (sessionId: string) => void;
}

export interface SessionRenameWarning {
  sessionId: string;
  sessionName: string;
  messages: string[];
}

export interface ConsoleBarVisibility {
  sessionTabs: boolean;
  stagedInput: boolean;
  shortcuts: boolean;
}

export type ConsoleBar = keyof ConsoleBarVisibility;

export type MobileConsoleMode = "terminal" | "input";

export const DEFAULT_CONSOLE_BAR_VISIBILITY: ConsoleBarVisibility = {
  sessionTabs: true,
  stagedInput: true,
  shortcuts: true,
};

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  ended: "Ended",
  error: "Connection error",
};

const RAW_PAGE_UP_SEQUENCE = "\x1b[5~";
const RAW_PAGE_DOWN_SEQUENCE = "\x1b[6~";
const MOBILE_CONSOLE_LAYOUT_QUERY = [
  "(max-width: 640px)",
  "(max-width: 1024px) and (pointer: coarse)",
  "(max-width: 1024px) and (max-height: 500px)",
].join(", ");
const DESKTOP_FOCUS_SHORTCUTS_GUTTER = 12;
const DESKTOP_FOCUS_SHORTCUTS_KEY_STEP = 16;
const DESKTOP_FOCUS_SHORTCUTS_KEY_LARGE_STEP = 64;

interface DesktopFocusShortcutsPosition {
  x: number;
  y: number;
}

interface DesktopFocusShortcutsDrag {
  pointerId: number;
  captureTarget: HTMLButtonElement;
  startClientX: number;
  startClientY: number;
  startPosition: DesktopFocusShortcutsPosition;
  minDeltaX: number;
  maxDeltaX: number;
  minDeltaY: number;
  maxDeltaY: number;
}

type DesktopSessionShortcut = "end" | "rename";
type DesktopConsoleShortcutAction =
  | "view-terminal-focus"
  | "view-floating-input"
  | "view-session-tabs"
  | "session-end"
  | "session-rename"
  | "terminal-return-live"
  | "terminal-copy-mode"
  | "session-copy-new"
  | "terminal-page-up"
  | "terminal-page-down";

function desktopSessionShortcut(
  event: KeyboardEvent,
  bindings: ShortcutBindings,
): DesktopSessionShortcut | null {
  if (matchesDirectShortcut(event, bindings["session-end"])) return "end";
  if (matchesDirectShortcut(event, bindings["session-rename"])) return "rename";
  return null;
}

function clampDelta(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}

interface ConsoleBarToolbarProps {
  visibility: ConsoleBarVisibility;
  availability?: Partial<Record<ConsoleBar, boolean>>;
  onChange: (bar: ConsoleBar, visible: boolean) => void;
  workspaceLinks?: ReactNode;
  desktopCopyMode?: boolean;
  onDesktopCopyModeChange?: (enabled: boolean) => void;
  onEnterDesktopFocus?: () => void;
  floatingInputOpen?: boolean;
  floatingInputPinned?: boolean;
  onToggleFloatingInput?: () => void;
  desktopTabOrientation?: WorkspaceTabOrientation;
  onDesktopTabOrientationChange?: (orientation: WorkspaceTabOrientation) => void;
  tabActionsVisible?: boolean;
  onTabActionsVisibilityChange?: (visible: boolean) => void;
}

const CONSOLE_BARS: Array<{
  bar: ConsoleBar;
  label: string;
  shortLabel: string;
  controls: string;
}> = [
  {
    bar: "sessionTabs",
    label: "Session tabs",
    shortLabel: "Tabs",
    controls: "muxdeck-session-tabs",
  },
  {
    bar: "stagedInput",
    label: "Staged input",
    shortLabel: "Input",
    controls: "muxdeck-staged-input",
  },
  {
    bar: "shortcuts",
    label: "Terminal shortcut buttons",
    shortLabel: "Keys",
    controls: "muxdeck-terminal-shortcuts",
  },
];

function ConsoleBarToolbar({
  visibility,
  availability,
  onChange,
  workspaceLinks,
  desktopCopyMode = false,
  onDesktopCopyModeChange,
  onEnterDesktopFocus,
  floatingInputOpen = false,
  floatingInputPinned = false,
  onToggleFloatingInput,
  desktopTabOrientation = "horizontal",
  onDesktopTabOrientationChange,
  tabActionsVisible = true,
  onTabActionsVisibilityChange,
}: ConsoleBarToolbarProps) {
  const { bindings: shortcutBindings } = useShortcutSettings();
  const sessionTabsShortcut = directShortcutLabel(shortcutBindings["view-session-tabs"]);
  const tabActionsShortcut = directShortcutLabel(shortcutBindings["view-tab-actions"]);
  const copyModeShortcut = directShortcutLabel(shortcutBindings["terminal-copy-mode"]);
  const focusShortcut = directShortcutLabel(shortcutBindings["view-terminal-focus"]);
  const floatingInputShortcut = directShortcutLabel(
    shortcutBindings["view-floating-input"],
  );
  return (
    <div
      className={workspaceLinks
        ? "console-bar-toolbar has-workspace-links"
        : "console-bar-toolbar"}
      role="group"
      aria-label="Console bars"
    >
      <span className="console-bar-toolbar-label" aria-hidden="true">VIEW</span>
      {workspaceLinks && (
        <div className="console-bar-toolbar-links">{workspaceLinks}</div>
      )}
      <div className="console-bar-toggle-group">
        {CONSOLE_BARS.map(({ bar, label, shortLabel, controls }) => {
          const visible = visibility[bar];
          const available = availability?.[bar] ?? true;
          const shortcut = bar === "sessionTabs" && available
            ? directShortcutAria(shortcutBindings["view-session-tabs"])
            : undefined;
          return (
            <button
              key={bar}
              type="button"
              className="console-bar-toggle"
              aria-label={label}
              aria-pressed={available && visible}
              aria-controls={available ? controls : undefined}
              aria-keyshortcuts={shortcut}
              disabled={!available}
              title={available
                ? `${visible ? "Hide" : "Show"} ${label.toLowerCase()}${shortcut
                  ? ` (${sessionTabsShortcut})`
                  : ""}`
                : `${label} unavailable for this session`}
              onClick={() => onChange(bar, !visible)}
            >
              <span>{shortLabel}</span>
            </button>
          );
        })}
      </div>
      {onToggleFloatingInput && (
        <button
          type="button"
          className="console-bar-toggle floating-staged-input-toggle"
          aria-label={floatingInputOpen
            ? "Hide floating staged input"
            : "Show floating staged input"}
          aria-controls="muxdeck-floating-staged-input"
          aria-expanded={floatingInputOpen}
          aria-pressed={floatingInputOpen}
          aria-keyshortcuts={directShortcutAria(shortcutBindings["view-floating-input"])}
          title={`${floatingInputOpen ? "Hide" : "Show"} the movable staged-input window${floatingInputPinned ? " pinned to this workspace" : ""}${floatingInputShortcut ? ` (${floatingInputShortcut})` : ""}`}
          onClick={onToggleFloatingInput}
        >
          <KeyboardIcon />
          <span>Float input</span>
        </button>
      )}
      {onDesktopTabOrientationChange && (availability?.sessionTabs ?? true) && (
        <button
          type="button"
          className="console-bar-toggle desktop-tab-orientation-toggle"
          aria-label="Vertical session tabs"
          aria-controls="muxdeck-session-tabs"
          aria-pressed={desktopTabOrientation === "vertical"}
          title={desktopTabOrientation === "vertical"
            ? "Move session tabs back to the top"
            : "Move session tabs to the left side"}
          onClick={() => onDesktopTabOrientationChange(
            desktopTabOrientation === "vertical" ? "horizontal" : "vertical",
          )}
        >
          <ListIcon />
          <span>Side tabs</span>
        </button>
      )}
      {onTabActionsVisibilityChange && (availability?.sessionTabs ?? true) && (
        <button
          type="button"
          className="console-bar-toggle desktop-tab-actions-toggle"
          aria-label="Tab action buttons"
          aria-controls="muxdeck-session-tabs"
          aria-pressed={tabActionsVisible}
          aria-keyshortcuts={directShortcutAria(shortcutBindings["view-tab-actions"])}
          title={tabActionsVisible
            ? `Hide action buttons on every session tab${tabActionsShortcut ? ` (${tabActionsShortcut})` : ""}`
            : `Show action buttons on every session tab${tabActionsShortcut ? ` (${tabActionsShortcut})` : ""}`}
          onClick={() => onTabActionsVisibilityChange(!tabActionsVisible)}
        >
          <span>Actions</span>
        </button>
      )}
      {onDesktopCopyModeChange && (
        <button
          type="button"
          className="console-bar-toggle desktop-terminal-copy-toggle"
          aria-label="Browser terminal copy mode"
          aria-controls="muxdeck-active-console"
          aria-pressed={desktopCopyMode}
          aria-keyshortcuts={directShortcutAria(shortcutBindings["terminal-copy-mode"])}
          title={desktopCopyMode
            ? `Browser selection is active. Click to return mouse control to the terminal application${copyModeShortcut ? ` (${copyModeShortcut})` : ""}`
            : `Select terminal text with the browser; TUI mouse actions are temporarily blocked${copyModeShortcut ? ` (${copyModeShortcut})` : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onDesktopCopyModeChange(!desktopCopyMode)}
        >
          <span>Copy</span>
        </button>
      )}
      {onEnterDesktopFocus && (
        <button
          type="button"
          className="console-bar-toggle desktop-terminal-focus-key"
          onClick={onEnterDesktopFocus}
          aria-label="Enter desktop terminal focus"
          aria-controls="muxdeck-active-console"
          aria-pressed="false"
          aria-keyshortcuts={directShortcutAria(shortcutBindings["view-terminal-focus"])}
          title={`Fill the browser viewport with this live terminal${focusShortcut ? ` (${focusShortcut})` : ""}`}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ExpandIcon /> <span>Focus</span>
        </button>
      )}
    </div>
  );
}

export function ConsoleScreen({
  sessionName,
  workspaceId = null,
  workspaceName = null,
  onBack,
  dashboardWindowHref,
  headerNotes,
  workspaceLinks,
  sessionNavigation,
  workspaceOverlayOpen = false,
  mobileMode,
  onMobileModeChange,
  onOpenWorkspaceOverview,
  onCloseWorkspaceOverview,
  barVisibility,
  onBarVisibilityChange,
  desktopTabOrientation = "horizontal",
  onDesktopTabOrientationChange,
  tabActionsVisible = true,
  onTabActionsVisibilityChange,
  desktopTabRailWidth = DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
  historyPanelWidth,
  onHistoryPanelWidthChange,
  onSessionsChange,
  onSessionUpdate,
  onWorkspacePinChange,
  onSessionWorkspaceTransfer,
  workspaceTransferDisabled = false,
  onSessionRenamed,
  onSessionTerminated,
  onSessionCopied,
  onSplitWorkspace,
  copySessionDisabled = false,
  renameWarning,
  onDismissRenameWarning,
}: ConsoleScreenProps) {
  const { theme } = useTheme();
  const { bindings: shortcutBindings } = useShortcutSettings();
  const resolvedDashboardWindowHref = dashboardWindowHref
    ?? `${BASE_PATH}/${window.location.search}`;
  const consoleShellRef = useRef<HTMLElement>(null);
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const inputBarRef = useRef<InputBarHandle>(null);
  const floatingInputRef = useRef<FloatingStagedInputHandle>(null);
  const [loadedSession, setLoadedSession] = useState<Session | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<{
    sessionName: string;
    state: ConnectionState;
  }>({ sessionName, state: "connecting" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileOpenRequest, setFileOpenRequest] = useState<SessionFileOpenRequest | null>(null);
  const [titleEditorOpen, setTitleEditorOpen] = useState(false);
  const [renameEditorOpen, setRenameEditorOpen] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<{
    name: string;
    id: string;
    created: number;
    serverStarted: number;
    serverPid: number;
    title: string | null;
  } | null>(null);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [copyingSource, setCopyingSource] = useState<string | null>(null);
  const [copySessionError, setCopySessionError] = useState<{
    sourceName: string;
    message: string;
  } | null>(null);
  const [splitWorkspaceError, setSplitWorkspaceError] = useState<{
    sessionName: string;
    message: string;
  } | null>(null);
  const [workspacePinSource, setWorkspacePinSource] = useState<string | null>(null);
  const [workspacePinError, setWorkspacePinError] = useState<{
    sessionName: string;
    message: string;
  } | null>(null);
  const [workspaceTransferOpen, setWorkspaceTransferOpen] = useState(false);
  const [ignoreSize, setIgnoreSize] = useState(false);
  const [localBarVisibility, setLocalBarVisibility] = useState(
    DEFAULT_CONSOLE_BAR_VISIBILITY,
  );
  const [localMobileMode, setLocalMobileMode] = useState<MobileConsoleMode>("terminal");
  const [mobileLayout, setMobileLayout] = useState(() => (
    typeof window.matchMedia === "function"
      && window.matchMedia(MOBILE_CONSOLE_LAYOUT_QUERY).matches
  ));
  const [mobileDistractionFreeMode, setMobileDistractionFreeMode] = useState<
    MobileConsoleMode | null
  >(null);
  const [desktopCopyMode, setDesktopCopyMode] = useState(false);
  const [agentScrollPreferences, setAgentScrollPreferences] = useState(
    loadAgentScrollPreferences,
  );
  const [desktopTerminalFocus, setDesktopTerminalFocus] = useState(false);
  const [floatingDraftSnapshot, setFloatingDraftSnapshot] = useState({
    sessionName,
    value: "",
  });
  const [floatingInputPanelState, setFloatingInputPanelState] = useState<
    FloatingStagedInputPanelState
  >({ open: false, pinned: false });
  const [desktopFocusShortcutsOpen, setDesktopFocusShortcutsOpen] = useState(false);
  const [desktopFocusShortcutsPosition, setDesktopFocusShortcutsPosition] = useState<
    DesktopFocusShortcutsPosition
  >({ x: 0, y: 0 });
  const desktopFocusShortcutsPositionRef = useRef(desktopFocusShortcutsPosition);
  const desktopFocusShortcutsDragRef = useRef<DesktopFocusShortcutsDrag | null>(null);
  const handledSessionShortcutRef = useRef<DesktopSessionShortcut | null>(null);
  const copyingSessionRef = useRef(false);
  const fileOpenRequestIdRef = useRef(0);
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;
  const [localHistoryPanelWidth, setLocalHistoryPanelWidth] = useState(
    DEFAULT_HISTORY_PANEL_WIDTH,
  );
  const [lookupError, setLookupError] = useState<{
    sessionName: string;
    message: string;
  } | null>(null);
  const clampedDesktopTabRailWidth = clampDesktopTabRailWidth(desktopTabRailWidth);
  const consoleShellStyle = {
    "--desktop-tab-rail-width": `${clampedDesktopTabRailWidth}px`,
    "--desktop-focus-shortcuts-x": `${desktopFocusShortcutsPosition.x}px`,
    "--desktop-focus-shortcuts-y": `${desktopFocusShortcutsPosition.y}px`,
  } as CSSProperties;

  const session = loadedSession?.name === sessionName ? loadedSession : null;
  const pane: Pane | undefined = session?.panes.find((item) => item.id === paneId)
    || (session ? activePane(session) : undefined);
  const classification = classifyPane(pane);
  const scrollAgentKind = paneCommandKind(pane?.command || "", pane?.title || "");
  const preferredScrollMode = preferredAgentScrollMode(
    scrollAgentKind,
    agentScrollPreferences,
  );
  const visibleRenameWarning = renameWarning?.sessionName === sessionName
    && renameWarning.sessionId === session?.id
    ? renameWarning
    : null;
  const connection = connectionSnapshot.sessionName === sessionName
    ? connectionSnapshot.state
    : "connecting";
  const currentLookupError = lookupError?.sessionName === sessionName
    ? lookupError.message
    : null;
  const visibleBars = barVisibility ?? localBarVisibility;
  const visibleMobileMode = mobileMode ?? localMobileMode;
  const activeMobileFocus = workspaceOverlayOpen ? "overview" : visibleMobileMode;
  const mobileTerminalDistractionFree = mobileDistractionFreeMode === "terminal";
  const mobileInputDistractionFree = mobileDistractionFreeMode === "input";
  const mobileDistractionFree = mobileDistractionFreeMode === activeMobileFocus;
  const visibleHistoryPanelWidth = historyPanelWidth ?? localHistoryPanelWidth;
  const memorandumCount = session?.memorandumCount ?? session?.queuedMessageCount ?? 0;
  const queuedMemorandumCount = session?.queuedMessageCount ?? 0;
  const floatingDraft = floatingDraftSnapshot.sessionName === sessionName
    ? floatingDraftSnapshot.value
    : "";

  const openTerminalFilePath = useCallback((candidate: string) => {
    if (mobileLayout || workspaceOverlayOpen || !pane?.path) return;
    const path = resolveTerminalFileLinkPath(candidate, pane.path);
    if (!path) return;
    fileOpenRequestIdRef.current += 1;
    setFileOpenRequest({ id: fileOpenRequestIdRef.current, path });
    setFilesOpen(true);
  }, [mobileLayout, pane?.path, workspaceOverlayOpen]);

  const copyNewSession = useCallback(async () => {
    if (
      copyingSessionRef.current
      || copySessionDisabled
      || !session
      || !onSessionCopied
    ) return;

    const sourceName = session.name;
    copyingSessionRef.current = true;
    setCopyingSource(sourceName);
    setCopySessionError(null);
    let created;
    try {
      created = await copySession(sourceName, session.id, theme);
    } catch (error) {
      copyingSessionRef.current = false;
      setCopyingSource(null);
      if (sessionNameRef.current === sourceName) {
        setCopySessionError({
          sourceName,
          message: error instanceof Error
            ? error.message
            : "Unable to create a session copy",
        });
      }
      return;
    }
    copyingSessionRef.current = false;
    setCopyingSource(null);
    onSessionCopied(sourceName, created.name, created.id);
  }, [copySessionDisabled, onSessionCopied, session, theme]);

  const splitIntoNewWorkspace = useCallback(() => {
    if (!session || mobileLayout || !onSplitWorkspace) return;
    const sourceName = session.name;
    setSplitWorkspaceError(null);
    let result: OpenTabInNewWindowResult;
    try {
      result = onSplitWorkspace(sourceName);
    } catch {
      result = "failed";
    }
    if (result === "opened") return;
    const message = result === "blocked"
      ? "The browser blocked the new workspace window. Allow pop-ups and try again."
      : result === "workspace-sync-pending"
        ? "Wait for the current workspace to finish syncing, then try again."
        : "Muxdeck could not open the temporary workspace. The current workspace is unchanged.";
    setSplitWorkspaceError({ sessionName: sourceName, message });
  }, [mobileLayout, onSplitWorkspace, session]);

  const toggleWorkspacePin = useCallback(async () => {
    if (workspacePinSource !== null || !session) return;
    const sourceName = session.name;
    const previous = Boolean(session.workspacePinned);
    const next = !previous;
    setWorkspacePinSource(sourceName);
    setWorkspacePinError(null);
    setLoadedSession((current) => current?.name === sourceName
      ? { ...current, workspacePinned: next }
      : current);
    try {
      const result = await updateSessionWorkspacePin(sourceName, next);
      const updatedSession = { ...session, workspacePinned: result.workspacePinned };
      setLoadedSession((current) => current?.name === sourceName
        ? { ...current, workspacePinned: result.workspacePinned }
        : current);
      onSessionUpdate?.(updatedSession);
      await onWorkspacePinChange?.(
        result.session,
        result.workspacePinned,
        result.sessionRevision,
      );
    } catch (error) {
      setLoadedSession((current) => current?.name === sourceName
        ? { ...current, workspacePinned: previous }
        : current);
      if (sessionNameRef.current === sourceName) {
        setWorkspacePinError({
          sessionName: sourceName,
          message: error instanceof Error
            ? error.message
            : "Unable to update the workspace pin",
        });
      }
    } finally {
      setWorkspacePinSource(null);
    }
  }, [onSessionUpdate, onWorkspacePinChange, session, workspacePinSource]);

  const setBarVisible = useCallback((bar: ConsoleBar, visible: boolean) => {
    if (onBarVisibilityChange) {
      onBarVisibilityChange(bar, visible);
      return;
    }
    setLocalBarVisibility((current) => ({ ...current, [bar]: visible }));
  }, [onBarVisibilityChange]);

  const updateDesktopFocusShortcutsPosition = useCallback((
    position: DesktopFocusShortcutsPosition,
  ) => {
    desktopFocusShortcutsPositionRef.current = position;
    setDesktopFocusShortcutsPosition(position);
  }, []);

  const finishDesktopFocusShortcutsDrag = useCallback((
    pointerId: number,
    cancelled: boolean,
  ) => {
    const drag = desktopFocusShortcutsDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;

    desktopFocusShortcutsDragRef.current = null;
    document.documentElement.classList.remove("desktop-focus-shortcuts-moving");
    if (cancelled) updateDesktopFocusShortcutsPosition(drag.startPosition);
    try {
      if (drag.captureTarget.hasPointerCapture?.(pointerId)) {
        drag.captureTarget.releasePointerCapture(pointerId);
      }
    } catch {
      // Window-level pointer listeners still finish the move if capture is lost.
    }
  }, [updateDesktopFocusShortcutsPosition]);

  const resetDesktopFocusShortcutsPosition = useCallback(() => {
    const drag = desktopFocusShortcutsDragRef.current;
    desktopFocusShortcutsDragRef.current = null;
    document.documentElement.classList.remove("desktop-focus-shortcuts-moving");
    if (drag) {
      try {
        if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // The position reset does not depend on pointer capture cleanup.
      }
    }
    updateDesktopFocusShortcutsPosition({ x: 0, y: 0 });
  }, [updateDesktopFocusShortcutsPosition]);

  const startDesktopFocusShortcutsDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (
      desktopFocusShortcutsDragRef.current
      || event.button !== 0
      || event.isPrimary === false
    ) return;
    const panel = event.currentTarget.closest<HTMLElement>(".input-dock");
    const shell = consoleShellRef.current;
    if (!panel || !shell) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    const panelRect = panel.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    desktopFocusShortcutsDragRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition: desktopFocusShortcutsPositionRef.current,
      minDeltaX: shellRect.left + DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.left,
      maxDeltaX: shellRect.right - DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.right,
      minDeltaY: shellRect.top + DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.top,
      maxDeltaY: shellRect.bottom - DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.bottom,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners keep the panel movable without pointer capture.
    }
    document.documentElement.classList.add("desktop-focus-shortcuts-moving");
  }, []);

  useEffect(() => {
    const movePanel = (event: PointerEvent) => {
      const drag = desktopFocusShortcutsDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const deltaX = clampDelta(
        event.clientX - drag.startClientX,
        drag.minDeltaX,
        drag.maxDeltaX,
      );
      const deltaY = clampDelta(
        event.clientY - drag.startClientY,
        drag.minDeltaY,
        drag.maxDeltaY,
      );
      updateDesktopFocusShortcutsPosition({
        x: drag.startPosition.x + deltaX,
        y: drag.startPosition.y + deltaY,
      });
    };
    const finishPanelMove = (event: PointerEvent) => {
      finishDesktopFocusShortcutsDrag(event.pointerId, false);
    };
    const cancelPanelMove = (event: PointerEvent) => {
      finishDesktopFocusShortcutsDrag(event.pointerId, true);
    };

    window.addEventListener("pointermove", movePanel);
    window.addEventListener("pointerup", finishPanelMove);
    window.addEventListener("pointercancel", cancelPanelMove);
    return () => {
      window.removeEventListener("pointermove", movePanel);
      window.removeEventListener("pointerup", finishPanelMove);
      window.removeEventListener("pointercancel", cancelPanelMove);
      desktopFocusShortcutsDragRef.current = null;
      document.documentElement.classList.remove("desktop-focus-shortcuts-moving");
    };
  }, [finishDesktopFocusShortcutsDrag, updateDesktopFocusShortcutsPosition]);

  const moveDesktopFocusShortcutsBy = useCallback((deltaX: number, deltaY: number) => {
    const shell = consoleShellRef.current;
    const panel = shell?.querySelector<HTMLElement>(".input-dock");
    if (!shell || !panel) return;
    const panelRect = panel.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const nextDeltaX = clampDelta(
      deltaX,
      shellRect.left + DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.left,
      shellRect.right - DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.right,
    );
    const nextDeltaY = clampDelta(
      deltaY,
      shellRect.top + DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.top,
      shellRect.bottom - DESKTOP_FOCUS_SHORTCUTS_GUTTER - panelRect.bottom,
    );
    const current = desktopFocusShortcutsPositionRef.current;
    updateDesktopFocusShortcutsPosition({
      x: current.x + nextDeltaX,
      y: current.y + nextDeltaY,
    });
  }, [updateDesktopFocusShortcutsPosition]);

  const moveDesktopFocusShortcutsFromKeyboard = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const step = event.shiftKey
      ? DESKTOP_FOCUS_SHORTCUTS_KEY_LARGE_STEP
      : DESKTOP_FOCUS_SHORTCUTS_KEY_STEP;
    let deltaX = 0;
    let deltaY = 0;
    if (event.key === "ArrowLeft") deltaX = -step;
    else if (event.key === "ArrowRight") deltaX = step;
    else if (event.key === "ArrowUp") deltaY = -step;
    else if (event.key === "ArrowDown") deltaY = step;
    else if (event.key === "Enter" || event.key === "Home") {
      event.preventDefault();
      resetDesktopFocusShortcutsPosition();
      return;
    } else return;

    event.preventDefault();
    event.stopPropagation();
    moveDesktopFocusShortcutsBy(deltaX, deltaY);
  }, [moveDesktopFocusShortcutsBy, resetDesktopFocusShortcutsPosition]);

  const setMobileMode = useCallback((mode: MobileConsoleMode) => {
    if (onMobileModeChange) {
      onMobileModeChange(mode);
      return;
    }
    setLocalMobileMode(mode);
  }, [onMobileModeChange]);

  const showComposer = useCallback(() => {
    setDesktopFocusShortcutsOpen(false);
    setDesktopTerminalFocus(false);
    resetDesktopFocusShortcutsPosition();
    setBarVisible("stagedInput", true);
  }, [resetDesktopFocusShortcutsPosition, setBarVisible]);

  const replaceFloatingDraft = useCallback((value: string) => (
    inputBarRef.current?.replaceDraft(value) ?? false
  ), []);

  const mirrorStagedDraft = useCallback((value: string) => {
    setFloatingDraftSnapshot({ sessionName, value });
  }, [sessionName]);

  const toggleFloatingInput = useCallback(() => {
    floatingInputRef.current?.toggle();
  }, []);

  const setHistoryPanelWidth = useCallback((width: number) => {
    if (historyPanelWidth === undefined) setLocalHistoryPanelWidth(width);
    onHistoryPanelWidthChange?.(width);
  }, [historyPanelWidth, onHistoryPanelWidthChange]);

  const revealAndFocusComposer = useCallback(() => {
    setMobileMode("input");
    showComposer();
    window.requestAnimationFrame(() => inputBarRef.current?.focus());
  }, [setMobileMode, showComposer]);

  const selectMobileFocus = useCallback((focus: "overview" | MobileConsoleMode) => {
    setMobileDistractionFreeMode(null);
    if (focus === "overview") {
      inputBarRef.current?.blur();
      setMobileMode("terminal");
      if (onOpenWorkspaceOverview) onOpenWorkspaceOverview();
      else onBack();
      return;
    }

    if (workspaceOverlayOpen) onCloseWorkspaceOverview?.();
    setMobileMode(focus);
    if (focus === "input") {
      setBarVisible("stagedInput", true);
      setBarVisible("shortcuts", true);
      window.requestAnimationFrame(() => inputBarRef.current?.focus());
    } else {
      inputBarRef.current?.blur();
    }
  }, [
    onBack,
    onCloseWorkspaceOverview,
    onOpenWorkspaceOverview,
    setBarVisible,
    setMobileMode,
    workspaceOverlayOpen,
  ]);

  useEffect(() => {
    if (!desktopTerminalFocus || !desktopFocusShortcutsOpen) return;
    let frame = 0;
    const keepPanelInViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        moveDesktopFocusShortcutsBy(0, 0);
      });
    };
    const panel = consoleShellRef.current?.querySelector<HTMLElement>(".input-dock");
    const observer = panel && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(keepPanelInViewport)
      : null;
    if (panel) observer?.observe(panel);
    keepPanelInViewport();
    window.addEventListener("resize", keepPanelInViewport);
    window.visualViewport?.addEventListener("resize", keepPanelInViewport);
    window.visualViewport?.addEventListener("scroll", keepPanelInViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", keepPanelInViewport);
      window.visualViewport?.removeEventListener("resize", keepPanelInViewport);
      window.visualViewport?.removeEventListener("scroll", keepPanelInViewport);
    };
  }, [
    desktopFocusShortcutsOpen,
    desktopTerminalFocus,
    moveDesktopFocusShortcutsBy,
  ]);

  useEffect(() => {
    const shell = consoleShellRef.current;
    const viewport = window.visualViewport;
    if (!shell || !viewport) return;

    const syncViewport = () => {
      shell.style.setProperty("--console-viewport-height", `${viewport.height}px`);
      shell.style.setProperty("--console-viewport-top", `${viewport.offsetTop}px`);
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
    };
  }, [currentLookupError, sessionName]);

  useEffect(() => {
    const syncAgentScrollPreferences = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage
        && event.key === AGENT_SCROLL_PREFERENCES_STORAGE_KEY
      ) setAgentScrollPreferences(loadAgentScrollPreferences());
    };
    window.addEventListener("storage", syncAgentScrollPreferences);
    return () => window.removeEventListener("storage", syncAgentScrollPreferences);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sessions = await listSessions();
        if (cancelled) return;
        onSessionsChange?.(sessions);
        const match = sessions.find((item) => item.name === sessionName);
        if (!match) {
          setLoadedSession(null);
          setPaneId(null);
          setHistoryOpen(false);
          setFilesOpen(false);
          setTitleEditorOpen(false);
          setRenameEditorOpen(false);
          setTerminateTarget(null);
          setMessagesOpen(false);
          setSnippetsOpen(false);
          setWorkspaceTransferOpen(false);
          setLookupError({
            sessionName,
            message: "This tmux session no longer exists.",
          });
          return;
        }
        setLoadedSession(match);
        // tmux pane/window switches can happen inside the attached terminal.
        // Follow the inventory so header actions never target a stale pane.
        setPaneId(match.activePaneId);
        setLookupError(null);
      } catch (error) {
        if (!cancelled) {
          setLookupError({
            sessionName,
            message: error instanceof Error ? error.message : "Unable to load session",
          });
        }
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [onSessionsChange, sessionName]);

  useEffect(() => {
    setPaneId(null);
    setMobileDistractionFreeMode(null);
    setDesktopCopyMode(false);
    setDesktopTerminalFocus(false);
    setDesktopFocusShortcutsOpen(false);
    resetDesktopFocusShortcutsPosition();
    setHistoryOpen(false);
    setFilesOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
    setWorkspaceTransferOpen(false);
    setSplitWorkspaceError(null);
  }, [resetDesktopFocusShortcutsPosition, sessionName]);

  useEffect(() => {
    setFilesOpen(false);
  }, [pane?.path, paneId, sessionName]);

  useEffect(() => {
    if (!filesOpen) setFileOpenRequest(null);
  }, [filesOpen]);

  useEffect(() => {
    if (!workspaceOverlayOpen) return;
    setMobileDistractionFreeMode(null);
    setDesktopCopyMode(false);
    setDesktopTerminalFocus(false);
    setDesktopFocusShortcutsOpen(false);
    resetDesktopFocusShortcutsPosition();
    setHistoryOpen(false);
    setFilesOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
    setWorkspaceTransferOpen(false);
  }, [resetDesktopFocusShortcutsPosition, workspaceOverlayOpen]);

  useEffect(() => {
    if (
      mobileDistractionFreeMode
      && activeMobileFocus !== mobileDistractionFreeMode
    ) setMobileDistractionFreeMode(null);
  }, [activeMobileFocus, mobileDistractionFreeMode]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobileQuery = window.matchMedia(MOBILE_CONSOLE_LAYOUT_QUERY);
    const leaveDesktopFocus = () => {
      setMobileLayout(mobileQuery.matches);
      if (mobileQuery.matches) {
        setDesktopCopyMode(false);
        setDesktopTerminalFocus(false);
        setDesktopFocusShortcutsOpen(false);
        setWorkspaceTransferOpen(false);
        setFilesOpen(false);
        resetDesktopFocusShortcutsPosition();
      }
    };
    leaveDesktopFocus();
    mobileQuery.addEventListener("change", leaveDesktopFocus);
    return () => mobileQuery.removeEventListener("change", leaveDesktopFocus);
  }, [resetDesktopFocusShortcutsPosition]);

  useEffect(() => {
    const sessionTitle = session?.name === sessionName
      ? session.customTitle || sessionName
      : sessionName;
    const savedWorkspaceName = workspaceName?.trim();
    document.title = savedWorkspaceName
      ? `${savedWorkspaceName} - ${sessionTitle}`
      : `${sessionTitle} - Muxdeck`;
  }, [session, sessionName, workspaceName]);

  const grokThemeName = theme === "light" ? "grokday" : "groknight";
  const grokThemeCommand = `/theme ${grokThemeName}`;
  const stageGrokTheme = useCallback(() => {
    if (!inputBarRef.current?.loadDraft(grokThemeCommand)) return;
    revealAndFocusComposer();
  }, [grokThemeCommand, revealAndFocusComposer]);
  const stateChange = useCallback((state: ConnectionState) => {
    setConnectionSnapshot({ sessionName, state });
  }, [sessionName]);
  const paneChange = useCallback((nextPaneId: string | null) => setPaneId(nextPaneId), []);
  const returnToLiveTerminal = useCallback(() => {
    terminalRef.current?.navigateHistory("exit");
    terminalRef.current?.jumpToLive();
    terminalRef.current?.focus();
  }, []);
  const rememberScrollMode = useCallback((mode: AgentScrollMode) => {
    setAgentScrollPreferences((current) => (
      rememberAgentScrollMode(current, scrollAgentKind, mode)
    ));
  }, [scrollAgentKind]);
  const scrollTerminal = useCallback((
    direction: "up" | "down",
    mode: AgentScrollMode,
    remember = false,
  ) => {
    const accepted = mode === "tmux"
      ? terminalRef.current?.navigateHistory(direction === "up" ? "page-up" : "page-down")
      : terminalRef.current?.send(
        direction === "up" ? RAW_PAGE_UP_SEQUENCE : RAW_PAGE_DOWN_SEQUENCE,
      );
    if (accepted && remember) rememberScrollMode(mode);
    return accepted ?? false;
  }, [rememberScrollMode]);
  const scrollTerminalWithPreference = useCallback((direction: "up" | "down") => {
    scrollTerminal(direction, preferredScrollMode);
  }, [preferredScrollMode, scrollTerminal]);
  const redrawTerminal = useCallback(() => {
    terminalRef.current?.redraw();
  }, []);
  const toggleMobileTerminalDistractionFree = useCallback(() => {
    const next = mobileDistractionFreeMode !== "terminal";
    if (next) {
      inputBarRef.current?.blur();
      setHistoryOpen(false);
      setTitleEditorOpen(false);
      setRenameEditorOpen(false);
      setTerminateTarget(null);
      setMessagesOpen(false);
      setSnippetsOpen(false);
    }
    setMobileDistractionFreeMode(next ? "terminal" : null);
  }, [mobileDistractionFreeMode]);
  const toggleMobileInputDistractionFree = useCallback(() => {
    const next = mobileDistractionFreeMode !== "input";
    if (next) {
      setHistoryOpen(false);
      setTitleEditorOpen(false);
      setRenameEditorOpen(false);
      setTerminateTarget(null);
      setMessagesOpen(false);
      setSnippetsOpen(false);
    }
    setMobileDistractionFreeMode(next ? "input" : null);
    window.requestAnimationFrame(() => inputBarRef.current?.focus());
  }, [mobileDistractionFreeMode]);
  const enterDesktopTerminalFocus = useCallback(() => {
    inputBarRef.current?.blur();
    setMobileDistractionFreeMode(null);
    setDesktopCopyMode(false);
    setHistoryOpen(false);
    setFilesOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
    setDesktopFocusShortcutsOpen(false);
    resetDesktopFocusShortcutsPosition();
    setDesktopTerminalFocus(true);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, [resetDesktopFocusShortcutsPosition]);
  const insertFilePath = useCallback((terminalText: string) => {
    if (!inputBarRef.current?.insertText(terminalText)) return false;
    revealAndFocusComposer();
    return true;
  }, [revealAndFocusComposer]);
  const exitDesktopTerminalFocus = useCallback(() => {
    setDesktopFocusShortcutsOpen(false);
    setDesktopTerminalFocus(false);
    resetDesktopFocusShortcutsPosition();
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, [resetDesktopFocusShortcutsPosition]);
  const openTerminateEditor = useCallback(() => {
    if (!session) return;
    setTerminateTarget({
      name: session.name,
      id: session.id,
      created: session.created,
      serverStarted: session.serverStarted,
      serverPid: session.serverPid,
      title: session.customTitle,
    });
  }, [session]);
  const openRenameEditor = useCallback(() => {
    if (!session || !onSessionRenamed) return;
    setRenameEditorOpen(true);
  }, [onSessionRenamed, session]);
  useEffect(() => {
    const blockedDesktopShortcut = () => (
      workspaceOverlayOpen
      || Boolean(document.querySelector('[aria-modal="true"]'))
      || (window.matchMedia?.(MOBILE_CONSOLE_LAYOUT_QUERY).matches ?? false)
    );
    const actionForKeyboardEvent = (
      event: KeyboardEvent,
    ): DesktopConsoleShortcutAction | null => {
      const candidates: DesktopConsoleShortcutAction[] = [
        "view-terminal-focus",
        "view-floating-input",
        "view-session-tabs",
        "session-end",
        "session-rename",
        "terminal-return-live",
        "terminal-copy-mode",
        "session-copy-new",
        "terminal-page-up",
        "terminal-page-down",
      ];
      return candidates.find((action) => (
        matchesDirectShortcut(event, shortcutBindings[action])
      )) ?? null;
    };
    const runDesktopAction = (
      action: DesktopConsoleShortcutAction,
      repeated = false,
      rememberKeyDown = false,
    ) => {
      if (action === "view-session-tabs") {
        if (sessionNavigation) setBarVisible("sessionTabs", !visibleBars.sessionTabs);
        return;
      }
      if (action === "view-floating-input") {
        if (!repeated) toggleFloatingInput();
        return;
      }
      if (action === "session-end") {
        if (repeated) return;
        if (rememberKeyDown) handledSessionShortcutRef.current = "end";
        openTerminateEditor();
        return;
      }
      if (action === "session-rename") {
        if (repeated || !session || !onSessionRenamed) return;
        if (rememberKeyDown) handledSessionShortcutRef.current = "rename";
        openRenameEditor();
        return;
      }
      if (action === "terminal-return-live") {
        returnToLiveTerminal();
        return;
      }
      if (action === "terminal-copy-mode") {
        setDesktopCopyMode((enabled) => !enabled);
        return;
      }
      if (action === "session-copy-new") {
        if (!repeated && onSessionCopied) void copyNewSession();
        return;
      }
      if (action === "terminal-page-up" || action === "terminal-page-down") {
        scrollTerminalWithPreference(
          action === "terminal-page-up" ? "up" : "down",
        );
        return;
      }
      if (desktopTerminalFocus) exitDesktopTerminalFocus();
      else enterDesktopTerminalFocus();
    };
    const handleDesktopViewShortcut = (event: KeyboardEvent) => {
      const sessionShortcut = desktopSessionShortcut(event, shortcutBindings);
      if ((event.isComposing || event.keyCode === 229) && !sessionShortcut) return;
      const action = actionForKeyboardEvent(event);
      if (!action) return;
      if (action === "view-session-tabs" && !sessionNavigation) return;
      if (action === "session-rename" && (!session || !onSessionRenamed)) return;
      if (action === "session-copy-new" && !onSessionCopied) return;
      if (blockedDesktopShortcut()) return;

      event.preventDefault();
      event.stopPropagation();
      runDesktopAction(action, event.repeat, true);
    };

    const handleDesktopSessionShortcutKeyUp = (event: KeyboardEvent) => {
      const sessionShortcut = desktopSessionShortcut(event, shortcutBindings);
      if (!sessionShortcut) return;
      if (handledSessionShortcutRef.current === sessionShortcut) {
        handledSessionShortcutRef.current = null;
        return;
      }
      if (
        !event.ctrlKey
        || !event.shiftKey
        || event.altKey
        || event.metaKey
        || blockedDesktopShortcut()
        || (sessionShortcut === "rename" && (!session || !onSessionRenamed))
      ) return;

      event.preventDefault();
      event.stopPropagation();
      if (sessionShortcut === "end") openTerminateEditor();
      else openRenameEditor();
    };

    const handleShortcutAction = (event: Event) => {
      const action = (event as CustomEvent<ShortcutActionId>).detail;
      const supportedActions: DesktopConsoleShortcutAction[] = [
        "view-terminal-focus",
        "view-floating-input",
        "view-session-tabs",
        "session-end",
        "session-rename",
        "terminal-return-live",
        "terminal-copy-mode",
        "session-copy-new",
        "terminal-page-up",
        "terminal-page-down",
      ];
      if (!supportedActions.includes(action as DesktopConsoleShortcutAction)) return;
      if (blockedDesktopShortcut()) return;
      runDesktopAction(action as DesktopConsoleShortcutAction);
    };

    // Capture app-level view chords before xterm turns them into terminal input.
    window.addEventListener("keydown", handleDesktopViewShortcut, true);
    window.addEventListener("keyup", handleDesktopSessionShortcutKeyUp, true);
    window.addEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
    return () => {
      window.removeEventListener("keydown", handleDesktopViewShortcut, true);
      window.removeEventListener("keyup", handleDesktopSessionShortcutKeyUp, true);
      window.removeEventListener(SHORTCUT_ACTION_EVENT, handleShortcutAction);
    };
  }, [
    desktopTerminalFocus,
    enterDesktopTerminalFocus,
    exitDesktopTerminalFocus,
    openRenameEditor,
    openTerminateEditor,
    copyNewSession,
    onSessionCopied,
    returnToLiveTerminal,
    scrollTerminalWithPreference,
    sessionNavigation,
    setBarVisible,
    shortcutBindings,
    toggleFloatingInput,
    visibleBars.sessionTabs,
    workspaceOverlayOpen,
  ]);
  const saveSessionDetails = useCallback(async (title: string, tags: SessionTag[]) => {
    if (!session) return;
    let updatedSession = session;
    const titleChanged = (session.customTitle ?? "") !== title.trim();
    const tagsChanged = (session.tags ?? []).join("\0") !== tags.join("\0");
    if (titleChanged && tagsChanged) {
      const details = await updateSessionDetails(sessionName, title, tags);
      updatedSession = { ...updatedSession, ...details };
      setLoadedSession((current) => current?.name === sessionName
        ? { ...current, ...details }
        : current);
      onSessionUpdate?.(updatedSession);
    } else if (titleChanged) {
      const customTitle = await updateSessionTitle(sessionName, title);
      updatedSession = { ...updatedSession, customTitle };
      setLoadedSession((current) => current?.name === sessionName
        ? { ...current, customTitle }
        : current);
      onSessionUpdate?.(updatedSession);
    } else if (tagsChanged) {
      const savedTags = await updateSessionTags(sessionName, tags);
      updatedSession = { ...updatedSession, tags: savedTags };
      setLoadedSession((current) => current?.name === sessionName
        ? { ...current, tags: savedTags }
        : current);
      onSessionUpdate?.(updatedSession);
    }
    setTitleEditorOpen(false);
  }, [onSessionUpdate, session, sessionName]);
  const updateMemorandumCounts = useCallback((counts: { total: number; queued: number }) => {
    if (!session) return;
    const updatedSession = {
      ...session,
      memorandumCount: counts.total,
      queuedMessageCount: counts.queued,
    };
    setLoadedSession(updatedSession);
    onSessionUpdate?.(updatedSession);
  }, [onSessionUpdate, session]);

  const addDraftToMemo = useCallback(async (text: string) => {
    if (!session) throw new Error("This tmux session is no longer available.");
    const message = await createQueuedMessage(session.name, text, "queued");
    updateMemorandumCounts({
      total: Math.max(memorandumCount + 1, message.position + 1),
      queued: queuedMemorandumCount + 1,
    });
  }, [memorandumCount, queuedMemorandumCount, session, updateMemorandumCounts]);
  const consumeStagedMemo = useCallback(async (source: MemoDraftSource) => {
    if (!session) throw new Error("This tmux session is no longer available.");
    try {
      await deleteQueuedMessage(session.name, source.messageId);
    } catch (error) {
      const wasAlreadyRemoved = typeof error === "object"
        && error !== null
        && "status" in error
        && error.status === 404;
      if (!wasAlreadyRemoved) throw error;
    }
    const total = Math.max(0, memorandumCount - 1);
    updateMemorandumCounts({
      total,
      queued: Math.min(queuedMemorandumCount, total),
    });
  }, [memorandumCount, queuedMemorandumCount, session, updateMemorandumCounts]);
  const saveSessionName = useCallback(async (name: string) => {
    if (!session) throw new Error("This tmux session is no longer available.");
    const visibleDraft = inputBarRef.current?.getDraft() ?? "";
    const result = await renameSession(sessionName, name);
    handoffRenamedSessionDraft(sessionName, result.session, session.id, visibleDraft);
    setRenameEditorOpen(false);
    onSessionRenamed?.(sessionName, result.session, session.id, result.warnings);
  }, [onSessionRenamed, session, sessionName]);
  const terminateCurrentSession = useCallback(async () => {
    if (!terminateTarget || !onSessionTerminated) {
      throw new Error("This tmux session is no longer available.");
    }
    await onSessionTerminated(
      terminateTarget.name,
      terminateTarget.id,
      terminateTarget.created,
      terminateTarget.serverStarted,
      terminateTarget.serverPid,
    );
  }, [onSessionTerminated, terminateTarget]);

  if (currentLookupError && !session) {
    return (
      <main className={sessionNavigation
        ? "workspace-missing-session has-session-navigation"
        : "workspace-missing-session"}
        style={consoleShellStyle}
        data-desktop-tabs={desktopTabOrientation}
        data-desktop-tab-rail-width={clampedDesktopTabRailWidth}
        data-session-tabs-visible={sessionNavigation && visibleBars.sessionTabs ? "true" : "false"}
      >
        <ConsoleBarToolbar
          visibility={visibleBars}
          availability={{
            sessionTabs: Boolean(sessionNavigation),
            stagedInput: false,
            shortcuts: false,
          }}
          onChange={setBarVisible}
          workspaceLinks={workspaceLinks}
          desktopTabOrientation={desktopTabOrientation}
          onDesktopTabOrientationChange={sessionNavigation
            ? onDesktopTabOrientationChange
            : undefined}
          tabActionsVisible={tabActionsVisible}
          onTabActionsVisibilityChange={sessionNavigation
            ? onTabActionsVisibilityChange
            : undefined}
        />
        {sessionNavigation && (
          <div className="console-session-navigation">{sessionNavigation}</div>
        )}
        <section
          id="muxdeck-active-console"
          className="missing-session-content"
          role={sessionNavigation ? "tabpanel" : undefined}
          aria-label={`${sessionName} session unavailable`}
        >
          <div className="missing-session-theme"><ThemeToggle /></div>
          <TerminalIcon />
          <p className="eyebrow">SESSION UNAVAILABLE</p>
          <h1>{sessionName}</h1>
          <p>{currentLookupError}</p>
          <button type="button" className="primary-button" onClick={onBack}>Back to sessions</button>
        </section>
      </main>
    );
  }

  const uploadAttachment = session
    ? (file: File, signal: AbortSignal) => (
      uploadSessionAttachment(session.name, session.id, file, signal)
    )
    : undefined;

  return (
    <main
      ref={consoleShellRef}
      className={sessionNavigation ? "console-shell has-session-navigation" : "console-shell"}
      style={consoleShellStyle}
      data-composer-visible={visibleBars.stagedInput || visibleMobileMode === "input"}
      data-shortcuts-visible={visibleBars.shortcuts || visibleMobileMode === "input"}
      data-mobile-focus={activeMobileFocus}
      data-mobile-distraction-free={mobileDistractionFree ? "true" : "false"}
      data-desktop-copy-mode={desktopCopyMode ? "true" : "false"}
      data-desktop-focus={desktopTerminalFocus ? "true" : "false"}
      data-desktop-focus-shortcuts={desktopFocusShortcutsOpen ? "true" : "false"}
      data-scroll-agent={scrollAgentKind}
      data-scroll-mode={preferredScrollMode}
      data-desktop-tabs={desktopTabOrientation}
      data-desktop-tab-rail-width={clampedDesktopTabRailWidth}
      data-session-tabs-visible={sessionNavigation && visibleBars.sessionTabs ? "true" : "false"}
    >
      <ConsoleBarToolbar
        visibility={visibleBars}
        availability={{ sessionTabs: Boolean(sessionNavigation) }}
        onChange={setBarVisible}
        workspaceLinks={workspaceLinks}
        desktopTabOrientation={desktopTabOrientation}
        onDesktopTabOrientationChange={sessionNavigation
          ? onDesktopTabOrientationChange
          : undefined}
        tabActionsVisible={tabActionsVisible}
        onTabActionsVisibilityChange={sessionNavigation
          ? onTabActionsVisibilityChange
          : undefined}
        desktopCopyMode={desktopCopyMode}
        onDesktopCopyModeChange={setDesktopCopyMode}
        onEnterDesktopFocus={enterDesktopTerminalFocus}
        floatingInputOpen={floatingInputPanelState.open}
        floatingInputPinned={floatingInputPanelState.pinned}
        onToggleFloatingInput={toggleFloatingInput}
      />
      <nav className="mobile-console-focus" aria-label="Mobile console focus">
        <button
          id={MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID}
          type="button"
          className="mobile-console-focus-button overview"
          aria-pressed={activeMobileFocus === "overview"}
          aria-haspopup="dialog"
          aria-expanded={workspaceOverlayOpen}
          onClick={() => selectMobileFocus("overview")}
        >
          <GridIcon />
          <span>Overview</span>
        </button>
        <button
          type="button"
          className="mobile-console-focus-button terminal"
          aria-pressed={activeMobileFocus === "terminal"}
          aria-controls="muxdeck-active-console"
          onClick={() => selectMobileFocus("terminal")}
        >
          <TerminalIcon />
          <span>Terminal</span>
        </button>
        <button
          type="button"
          className={[
            "mobile-console-focus-button input",
            session?.agentState === "waiting_human" ? "needs-input" : "",
            queuedMemorandumCount > 0 ? "has-queued-memos" : "",
          ].filter(Boolean).join(" ")}
          aria-label={queuedMemorandumCount > 0
            ? `Input, ${queuedMemorandumCount} queued memo ${queuedMemorandumCount === 1 ? "item" : "items"}`
            : "Input"}
          aria-pressed={activeMobileFocus === "input"}
          aria-controls="muxdeck-staged-input"
          title={session?.agentState === "waiting_human"
            ? "This session needs input"
            : "Focus the staged input"}
          onClick={() => selectMobileFocus("input")}
        >
          <KeyboardIcon />
          <span>Input</span>
          {queuedMemorandumCount > 0 && (
            <strong className="mobile-console-memo-count" aria-hidden="true">
              Q {queuedMemorandumCount}
            </strong>
          )}
          {session?.agentState === "waiting_human" && (
            <span className="mobile-console-focus-attention" aria-hidden="true" />
          )}
        </button>
      </nav>
      <header className="console-header">
        <div
          className="console-dashboard-navigation"
          role="group"
          aria-label="Sessions and workspaces navigation"
        >
          <button
            type="button"
            className="icon-button back-button"
            onClick={onBack}
            aria-label="Back to sessions"
            title="Open landing page in this window"
          >
            <ArrowLeftIcon />
          </button>
          <a
            className="icon-button console-dashboard-new-window"
            href={resolvedDashboardWindowHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open sessions and workspaces in new window"
            title="Open landing page in new window"
          >
            <ExternalLinkIcon />
          </a>
        </div>
        <div className="console-identity">
          <div className="console-title-line">
            <h1>{session?.customTitle || sessionName}</h1>
            <span className={`agent-badge ${classification.tone}`}>{classification.label}</span>
          </div>
          <button
            type="button"
            className="console-cwd-button"
            aria-label={pane?.path && !mobileLayout
              ? `Browse files in ${pane.path}`
              : `Pane working directory: ${pane?.path || "unavailable"}`}
            aria-controls="muxdeck-session-files"
            aria-expanded={filesOpen}
            disabled={!session || !pane?.path || mobileLayout}
            title={pane?.path
              ? mobileLayout
                ? "File browsing is available in the desktop layout"
                : "Browse this pane's working directory"
              : undefined}
            onClick={() => setFilesOpen((open) => !open)}
          >
            <FolderIcon />
            <span>{session?.customTitle
              ? `${sessionName} / ${pane?.path || "loading"}`
              : pane?.path || "Loading tmux session..."}</span>
          </button>
        </div>
        {headerNotes}
        <div className="console-actions">
          <span className={`connection-badge ${connection}`}><span />{STATE_LABEL[connection]}</span>
          <button
            type="button"
            className={ignoreSize ? "size-mode protected" : "size-mode"}
            onClick={() => setIgnoreSize((current) => !current)}
            title={ignoreSize ? "This browser will not resize the shared tmux window" : "This browser controls the shared tmux window size"}
          >
            {ignoreSize ? "Size protected" : "Fit active"}
          </button>
          <button type="button" className="history-button" onClick={() => setHistoryOpen(true)} disabled={!pane} aria-label="Pane scrollback">
            <HistoryIcon /><span>Scrollback</span>
          </button>
          {onSessionCopied && (
            <button
              type="button"
              className="copy-new-button"
              aria-keyshortcuts={directShortcutAria(shortcutBindings["session-copy-new"])}
              aria-busy={copyingSource === sessionName}
              disabled={copySessionDisabled || !session || copyingSource !== null}
              title={`Create and open a fresh session in this pane's working directory${directShortcutLabel(shortcutBindings["session-copy-new"])
                ? ` (${directShortcutLabel(shortcutBindings["session-copy-new"])})`
                : ""}`}
              onClick={() => void copyNewSession()}
            >
              <WindowCopyIcon />
              <span>{copyingSource === sessionName ? "Creating..." : "Copy New"}</span>
            </button>
          )}
          {!mobileLayout && onSplitWorkspace && (
            <button
              type="button"
              className="split-workspace-button"
              disabled={!session}
              aria-label={`Split ${sessionName} into a new temporary workspace`}
              title="Open this session alone in a new temporary workspace window"
              onClick={splitIntoNewWorkspace}
            >
              <ExternalLinkIcon />
              <span>Split workspace</span>
            </button>
          )}
          <button
            type="button"
            className={session?.workspacePinned
              ? "workspace-pin-button active"
              : "workspace-pin-button"}
            aria-label={session?.workspacePinned
              ? `Unpin ${sessionName} from every workspace`
              : `Pin ${sessionName} to every workspace`}
            aria-pressed={Boolean(session?.workspacePinned)}
            aria-busy={workspacePinSource === sessionName}
            disabled={!session || workspacePinSource !== null}
            title={session?.workspacePinned
              ? "Stop adding this session to every workspace"
              : "Add this session once to every saved and future workspace"}
            onClick={() => void toggleWorkspacePin()}
          >
            <PinIcon filled={Boolean(session?.workspacePinned)} />
            <span>{session?.workspacePinned ? "Pinned all" : "Pin all"}</span>
          </button>
          {onSessionWorkspaceTransfer && (
            <button
              type="button"
              className="workspace-transfer-button"
              aria-label={`Move or copy ${sessionName} to a workspace`}
              aria-haspopup="dialog"
              aria-expanded={workspaceTransferOpen}
              disabled={!session || workspaceTransferDisabled}
              title={workspaceTransferDisabled
                ? "Wait for the current workspace to finish syncing"
                : "Move or copy this session to a saved workspace"}
              onClick={() => setWorkspaceTransferOpen(true)}
            >
              <WindowMoveIcon />
              <span>Move / Copy</span>
            </button>
          )}
          <AccountLink />
          <ThemeToggle />
          {pane?.command === "grok" && !pane.dead && (
            <button
              type="button"
              className="grok-theme-stage"
              aria-label={`Stage ${grokThemeName} theme command for Grok`}
              aria-controls="muxdeck-staged-input"
              aria-describedby="muxdeck-grok-theme-help"
              title={`Stage "${grokThemeCommand}" to match full-screen Grok to Muxdeck. Review it, then use Send + Enter; Grok saves this choice globally.`}
              onClick={stageGrokTheme}
            >
              <RefreshIcon />
              <span>Apply to Grok</span>
              <span id="muxdeck-grok-theme-help" className="grok-theme-help">
                Stages a command without sending it. Sending changes Grok's saved user theme globally; Grok minimal mode does not support this command.
              </span>
            </button>
          )}
        </div>
      </header>

      {copySessionError?.sourceName === sessionName && (
        <aside className="copy-new-error" role="alert">
          <span>Copy New failed: {copySessionError.message}</span>
          <button type="button" onClick={() => setCopySessionError(null)}>Dismiss</button>
        </aside>
      )}

      {splitWorkspaceError?.sessionName === sessionName && (
        <aside className="copy-new-error split-workspace-error" role="alert">
          <span>{splitWorkspaceError.message}</span>
          <button type="button" onClick={() => setSplitWorkspaceError(null)}>Dismiss</button>
        </aside>
      )}

      {workspacePinError?.sessionName === sessionName && (
        <aside className="copy-new-error workspace-pin-error" role="alert">
          <span>Workspace pin failed: {workspacePinError.message}</span>
          <button type="button" onClick={() => setWorkspacePinError(null)}>Dismiss</button>
        </aside>
      )}

      {visibleRenameWarning && (
        <aside
          className="console-rename-warning"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div>
            <strong>Tmux session renamed with warnings</strong>
            <ul>
              {visibleRenameWarning.messages.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onDismissRenameWarning?.(visibleRenameWarning.sessionId)}
            aria-label="Dismiss rename warning"
          >
            Dismiss
          </button>
        </aside>
      )}

      {sessionNavigation && (
        <div className="console-session-navigation">{sessionNavigation}</div>
      )}

      <div className="terminal-coordinate top-left">{pane ? `${pane.width}x${pane.height}` : "--x--"}</div>
      <div className="terminal-view">
        <LiveTerminal
          ref={terminalRef}
          session={sessionName}
          ignoreSize={ignoreSize}
          layoutSuspended={mobileInputDistractionFree}
          browserCopyMode={desktopCopyMode}
          layoutRefreshToken={[
            activeMobileFocus,
            mobileDistractionFree ? "focus" : "standard",
            desktopTerminalFocus ? "desktop-focus" : "desktop-standard",
            `desktop-tabs-${desktopTabOrientation}`,
            `desktop-tab-rail-${clampedDesktopTabRailWidth}`,
          ].join(":")}
          theme={theme}
          onUploadAttachment={uploadAttachment}
          onOpenFilePath={mobileLayout ? undefined : openTerminalFilePath}
          onStateChange={stateChange}
          onPaneChange={paneChange}
        />
        <nav className="terminal-view-controls" aria-label="Terminal view controls">
          <button
            type="button"
            className={preferredScrollMode === "application"
              ? "terminal-view-control preferred-scroll-control"
              : "terminal-view-control"}
            aria-label="Raw terminal Page Up"
            aria-controls="muxdeck-active-console"
            aria-keyshortcuts={preferredScrollMode === "application"
              ? directShortcutAria(shortcutBindings["terminal-page-up"])
              : undefined}
            data-scroll-preferred={preferredScrollMode === "application" ? "true" : undefined}
            title={preferredScrollMode === "application"
              ? `Send Page Up to the foreground terminal application; preferred for ${classification.label}${directShortcutLabel(shortcutBindings["terminal-page-up"])
                ? ` (${directShortcutLabel(shortcutBindings["terminal-page-up"])})`
                : ""}`
              : "Send Page Up to the foreground terminal application"}
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => scrollTerminal("up", "application", true)}
          >
            <ArrowUpIcon />
            <span>PgUp</span>
          </button>
          <button
            type="button"
            className={preferredScrollMode === "application"
              ? "terminal-view-control preferred-scroll-control"
              : "terminal-view-control"}
            aria-label="Raw terminal Page Down"
            aria-controls="muxdeck-active-console"
            aria-keyshortcuts={preferredScrollMode === "application"
              ? directShortcutAria(shortcutBindings["terminal-page-down"])
              : undefined}
            data-scroll-preferred={preferredScrollMode === "application" ? "true" : undefined}
            title={preferredScrollMode === "application"
              ? `Send Page Down to the foreground terminal application; preferred for ${classification.label}${directShortcutLabel(shortcutBindings["terminal-page-down"])
                ? ` (${directShortcutLabel(shortcutBindings["terminal-page-down"])})`
                : ""}`
              : "Send Page Down to the foreground terminal application"}
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => scrollTerminal("down", "application", true)}
          >
            <ArrowDownIcon />
            <span>PgDn</span>
          </button>
          <button
            type="button"
            className={preferredScrollMode === "tmux"
              ? "terminal-view-control tmux-history preferred-scroll-control"
              : "terminal-view-control tmux-history"}
            aria-label="Tmux Page Up"
            aria-controls="muxdeck-active-console"
            aria-keyshortcuts={preferredScrollMode === "tmux"
              ? directShortcutAria(shortcutBindings["terminal-page-up"])
              : undefined}
            data-scroll-preferred={preferredScrollMode === "tmux" ? "true" : undefined}
            title={preferredScrollMode === "tmux"
              ? `Enter tmux copy mode one page up; preferred for ${classification.label}${directShortcutLabel(shortcutBindings["terminal-page-up"])
                ? ` (${directShortcutLabel(shortcutBindings["terminal-page-up"])})`
                : ""}`
              : "Enter tmux copy mode one page up"}
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => scrollTerminal("up", "tmux", true)}
          >
            <HistoryIcon />
            <span>T Up</span>
          </button>
          <button
            type="button"
            className={preferredScrollMode === "tmux"
              ? "terminal-view-control tmux-history preferred-scroll-control"
              : "terminal-view-control tmux-history"}
            aria-label="Tmux Page Down"
            aria-controls="muxdeck-active-console"
            aria-keyshortcuts={preferredScrollMode === "tmux"
              ? directShortcutAria(shortcutBindings["terminal-page-down"])
              : undefined}
            data-scroll-preferred={preferredScrollMode === "tmux" ? "true" : undefined}
            title={preferredScrollMode === "tmux"
              ? `Page down while tmux copy mode is active; preferred for ${classification.label}${directShortcutLabel(shortcutBindings["terminal-page-down"])
                ? ` (${directShortcutLabel(shortcutBindings["terminal-page-down"])})`
                : ""}`
              : "Page down while tmux copy mode is active"}
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => scrollTerminal("down", "tmux", true)}
          >
            <HistoryIcon />
            <span>T Dn</span>
          </button>
          <button
            type="button"
            className="terminal-view-control live-toggle"
            aria-label="Return to live terminal"
            aria-controls="muxdeck-active-console"
            aria-keyshortcuts={directShortcutAria(shortcutBindings["terminal-return-live"])}
            title={`Leave tmux copy mode and return to live output${directShortcutLabel(shortcutBindings["terminal-return-live"])
              ? ` (${directShortcutLabel(shortcutBindings["terminal-return-live"])})`
              : ""}`}
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={returnToLiveTerminal}
          >
            <TerminalIcon />
            <span>Live</span>
          </button>
          <button
            type="button"
            className="terminal-view-control terminate-session-control"
            aria-label="Terminate tmux session"
            aria-haspopup="dialog"
            aria-keyshortcuts={directShortcutAria(shortcutBindings["session-end"])}
            title={`End this entire tmux session and all of its panes${directShortcutLabel(shortcutBindings["session-end"])
              ? ` (${directShortcutLabel(shortcutBindings["session-end"])})`
              : ""}`}
            disabled={!session || !onSessionTerminated}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openTerminateEditor}
          >
            <TrashIcon />
            <span>End</span>
          </button>
          <button
            type="button"
            className="terminal-view-control distraction-toggle"
            aria-label={mobileTerminalDistractionFree
              ? "Exit distraction-free terminal"
              : "Enter distraction-free terminal"}
            aria-controls="muxdeck-active-console"
            aria-pressed={mobileTerminalDistractionFree}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleMobileTerminalDistractionFree}
          >
            {mobileTerminalDistractionFree ? <ContractIcon /> : <ExpandIcon />}
            <span>{mobileTerminalDistractionFree ? "Exit" : "Focus"}</span>
          </button>
        </nav>
        {desktopTerminalFocus && (
          <div
            className="desktop-terminal-focus-actions"
            role="group"
            aria-label="Desktop terminal focus controls"
          >
            <button
              type="button"
              className="desktop-terminal-focus-redraw"
              aria-label="Redraw terminal display"
              aria-controls="muxdeck-active-console"
              title="Repaint the local terminal display without reconnecting or changing the tmux session"
              onMouseDown={(event) => event.preventDefault()}
              onClick={redrawTerminal}
            >
              <RefreshIcon />
              <span>Redraw</span>
            </button>
            <button
              type="button"
              className="desktop-terminal-focus-input"
              aria-label={floatingInputPanelState.open
                ? "Hide floating staged input"
                : "Show floating staged input"}
              aria-controls="muxdeck-floating-staged-input"
              aria-expanded={floatingInputPanelState.open}
              aria-keyshortcuts={directShortcutAria(
                shortcutBindings["view-floating-input"],
              )}
              title={`${floatingInputPanelState.open ? "Hide" : "Show"} the movable staged-input window${directShortcutLabel(shortcutBindings["view-floating-input"])
                ? ` (${directShortcutLabel(shortcutBindings["view-floating-input"])})`
                : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleFloatingInput}
            >
              <KeyboardIcon />
              <span>{floatingInputPanelState.open ? "Hide input" : "Float input"}</span>
            </button>
            <button
              type="button"
              className="desktop-terminal-focus-shortcuts"
              aria-label={desktopFocusShortcutsOpen
                ? "Hide all buttons"
                : "Show all buttons"}
              aria-controls="muxdeck-terminal-shortcuts"
              aria-expanded={desktopFocusShortcutsOpen}
              title={desktopFocusShortcutsOpen
                ? "Hide the floating terminal shortcut panel"
                : "Show all bottom terminal shortcuts in a floating panel"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDesktopFocusShortcutsOpen((open) => !open);
                if (desktopFocusShortcutsOpen) {
                  window.requestAnimationFrame(() => terminalRef.current?.focus());
                }
              }}
            >
              <KeyboardIcon />
              <span>{desktopFocusShortcutsOpen ? "Hide all buttons" : "Show all buttons"}</span>
            </button>
            <button
              type="button"
              className="desktop-terminal-focus-exit"
              aria-label="Exit desktop terminal focus"
              aria-controls="muxdeck-active-console"
              aria-pressed="true"
              aria-keyshortcuts={directShortcutAria(shortcutBindings["view-terminal-focus"])}
              title={`Return to the full console${directShortcutLabel(shortcutBindings["view-terminal-focus"])
                ? ` (${directShortcutLabel(shortcutBindings["view-terminal-focus"])})`
                : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={exitDesktopTerminalFocus}
            >
              <ContractIcon />
              <span>Exit</span>
            </button>
          </div>
        )}
      </div>
      <InputBar
        key={sessionName}
        ref={inputBarRef}
        sessionName={sessionName}
        sessionId={session?.id}
        enabled={connection === "live"}
        composerVisible={visibleBars.stagedInput || visibleMobileMode === "input"}
        shortcutsVisible={
          visibleBars.shortcuts
          || visibleMobileMode === "input"
          || (desktopTerminalFocus && desktopFocusShortcutsOpen)
        }
        shortcutPanelHeader={desktopTerminalFocus && desktopFocusShortcutsOpen ? (
          <button
            type="button"
            className="desktop-focus-shortcuts-drag-handle"
            aria-label="Move floating button panel"
            title="Drag to move. Use arrow keys; hold Shift for larger steps. Enter resets the position."
            onPointerDown={startDesktopFocusShortcutsDrag}
            onLostPointerCapture={(event) => {
              finishDesktopFocusShortcutsDrag(event.pointerId, false);
            }}
            onDoubleClick={resetDesktopFocusShortcutsPosition}
            onKeyDown={moveDesktopFocusShortcutsFromKeyboard}
          >
            <MoveIcon />
            <span>Move panel</span>
            <span className="desktop-focus-shortcuts-drag-hint" aria-hidden="true">
              Drag / arrows <kbd>Enter</kbd> resets
            </span>
          </button>
        ) : undefined}
        preferredScrollMode={preferredScrollMode}
        preferredScrollLabel={classification.label}
        onScrollModeUsed={rememberScrollMode}
        onSend={(data) => terminalRef.current?.send(data) ?? false}
        onSubmit={(data, terminator) => (
          terminalRef.current?.submit(data, terminator) ?? Promise.resolve(false)
        )}
        onAddToMemo={session ? addDraftToMemo : undefined}
        onConsumeMemo={session ? consumeStagedMemo : undefined}
        onReturnToLive={returnToLiveTerminal}
        mobileDistractionFree={mobileInputDistractionFree}
        onToggleMobileDistractionFree={toggleMobileInputDistractionFree}
        onFocus={() => terminalRef.current?.focus()}
        onRedraw={redrawTerminal}
        onRevealComposer={showComposer}
        onEditSessionTitle={session ? () => setTitleEditorOpen(true) : undefined}
        onRenameSession={session && onSessionRenamed
          ? openRenameEditor
          : undefined}
        onTerminateSession={session && onSessionTerminated
          ? openTerminateEditor
          : undefined}
        onOpenMessages={session ? () => setMessagesOpen(true) : undefined}
        onOpenSnippets={() => setSnippetsOpen(true)}
        onUploadAttachment={uploadAttachment}
        onDraftChange={mirrorStagedDraft}
        messageCount={memorandumCount}
        queuedMessageCount={queuedMemorandumCount}
      />
      <FloatingStagedInput
        ref={floatingInputRef}
        sessionName={sessionName}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        value={floatingDraft}
        onChange={replaceFloatingDraft}
        onOpenFullInput={revealAndFocusComposer}
        onPanelStateChange={setFloatingInputPanelState}
      />
      {!workspaceOverlayOpen && filesOpen && session && pane?.path && (
        <SessionFilesPanel
          sessionName={session.name}
          sessionId={session.id}
          paneId={pane.id}
          panePath={pane.path}
          openPathRequest={fileOpenRequest}
          onClose={() => setFilesOpen(false)}
          onInsertPath={insertFilePath}
        />
      )}
      {!workspaceOverlayOpen && historyOpen && pane && (
        <HistoryPanel
          pane={pane}
          onClose={() => setHistoryOpen(false)}
          preferredWidth={visibleHistoryPanelWidth}
          onPreferredWidthChange={setHistoryPanelWidth}
        />
      )}
      {!workspaceOverlayOpen && titleEditorOpen && session && (
        <SessionTitleDialog
          session={session}
          onClose={() => setTitleEditorOpen(false)}
          onSave={saveSessionDetails}
        />
      )}
      {!workspaceOverlayOpen && renameEditorOpen && session && (
        <SessionRenameDialog
          sessionName={session.name}
          onClose={() => setRenameEditorOpen(false)}
          onRename={saveSessionName}
        />
      )}
      {!workspaceOverlayOpen
        && workspaceTransferOpen
        && session
        && onSessionWorkspaceTransfer && (
          <SessionWorkspaceTransferDialog
            sessionName={session.name}
            sourceWorkspaceId={workspaceId}
            sourceWorkspaceName={workspaceName}
            workspacePinned={Boolean(session.workspacePinned)}
            onClose={() => setWorkspaceTransferOpen(false)}
            onTransfer={(destinationWorkspaceId, operation, sessionRevision) => (
              onSessionWorkspaceTransfer(
                session.name,
                destinationWorkspaceId,
                operation,
                sessionRevision,
              )
            )}
          />
        )}
      {!workspaceOverlayOpen && terminateTarget && (
        <SessionTerminateDialog
          sessionName={terminateTarget.name}
          sessionTitle={terminateTarget.title}
          onClose={() => setTerminateTarget(null)}
          onTerminate={terminateCurrentSession}
        />
      )}
      {!workspaceOverlayOpen && messagesOpen && session && (
        <MessageQueueDialog
          sessionName={session.name}
          sessionTitle={session.customTitle}
          onClose={() => setMessagesOpen(false)}
          onCountsChange={updateMemorandumCounts}
          onChoose={(message) => {
            if (!inputBarRef.current?.loadDraft(message.text, {
              messageId: message.id,
              text: message.text,
            })) {
              throw new Error("The current staged draft was left unchanged.");
            }
            revealAndFocusComposer();
          }}
          onSend={async (message) => {
            const accepted = await terminalRef.current?.submit(message.text, "enter");
            if (!accepted) {
              throw new Error("Delivery was not confirmed; check the terminal before retrying.");
            }
          }}
        />
      )}
      {!workspaceOverlayOpen && snippetsOpen && (
        <SnippetPickerDialog
          title="Insert into staged input"
          onClose={() => setSnippetsOpen(false)}
          onChoose={(snippet) => {
            if (!inputBarRef.current?.insertText(snippet.text)) {
              throw new Error("The snippet does not fit or the current draft is busy.");
            }
            revealAndFocusComposer();
          }}
        />
      )}
    </main>
  );
}
