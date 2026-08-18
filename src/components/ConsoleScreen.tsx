import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createQueuedMessage,
  deleteQueuedMessage,
  listSessions,
  renameSession,
  updateSessionTitle,
} from "../api";
import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ContractIcon,
  ExpandIcon,
  GridIcon,
  HistoryIcon,
  KeyboardIcon,
  TerminalIcon,
  TrashIcon,
} from "../icons";
import { useTheme } from "../theme";
import type { ConnectionState, Pane, Session } from "../types";
import { DEFAULT_HISTORY_PANEL_WIDTH, HistoryPanel } from "./HistoryPanel";
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
import { SessionTerminateDialog } from "./SessionTerminateDialog";
import { MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID } from "./SessionWorkspaceNavigation";
import { ThemeToggle } from "./ThemeToggle";

interface ConsoleScreenProps {
  sessionName: string;
  onBack: () => void;
  sessionNavigation?: ReactNode;
  workspaceOverlayOpen?: boolean;
  mobileMode?: MobileConsoleMode;
  onMobileModeChange?: (mode: MobileConsoleMode) => void;
  onOpenWorkspaceOverview?: () => void;
  onCloseWorkspaceOverview?: () => void;
  barVisibility?: ConsoleBarVisibility;
  onBarVisibilityChange?: (bar: ConsoleBar, visible: boolean) => void;
  historyPanelWidth?: number;
  onHistoryPanelWidthChange?: (width: number) => void;
  onSessionsChange?: (sessions: Session[]) => void;
  onSessionUpdate?: (session: Session) => void;
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

interface ConsoleBarToolbarProps {
  visibility: ConsoleBarVisibility;
  availability?: Partial<Record<ConsoleBar, boolean>>;
  onChange: (bar: ConsoleBar, visible: boolean) => void;
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
}: ConsoleBarToolbarProps) {
  return (
    <div className="console-bar-toolbar" role="group" aria-label="Console bars">
      <span className="console-bar-toolbar-label" aria-hidden="true">VIEW</span>
      <div className="console-bar-toggle-group">
        {CONSOLE_BARS.map(({ bar, label, shortLabel, controls }) => {
          const visible = visibility[bar];
          const available = availability?.[bar] ?? true;
          return (
            <button
              key={bar}
              type="button"
              className="console-bar-toggle"
              aria-label={label}
              aria-pressed={available && visible}
              aria-controls={available ? controls : undefined}
              disabled={!available}
              title={available
                ? `${visible ? "Hide" : "Show"} ${label.toLowerCase()}`
                : `${label} unavailable for this session`}
              onClick={() => onChange(bar, !visible)}
            >
              <span>{shortLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ConsoleScreen({
  sessionName,
  onBack,
  sessionNavigation,
  workspaceOverlayOpen = false,
  mobileMode,
  onMobileModeChange,
  onOpenWorkspaceOverview,
  onCloseWorkspaceOverview,
  barVisibility,
  onBarVisibilityChange,
  historyPanelWidth,
  onHistoryPanelWidthChange,
  onSessionsChange,
  onSessionUpdate,
  onSessionRenamed,
  onSessionTerminated,
  renameWarning,
  onDismissRenameWarning,
}: ConsoleScreenProps) {
  const { theme } = useTheme();
  const consoleShellRef = useRef<HTMLElement>(null);
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const inputBarRef = useRef<InputBarHandle>(null);
  const [loadedSession, setLoadedSession] = useState<Session | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<{
    sessionName: string;
    state: ConnectionState;
  }>({ sessionName, state: "connecting" });
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const [ignoreSize, setIgnoreSize] = useState(false);
  const [localBarVisibility, setLocalBarVisibility] = useState(
    DEFAULT_CONSOLE_BAR_VISIBILITY,
  );
  const [localMobileMode, setLocalMobileMode] = useState<MobileConsoleMode>("terminal");
  const [mobileDistractionFreeMode, setMobileDistractionFreeMode] = useState<
    MobileConsoleMode | null
  >(null);
  const [desktopTerminalFocus, setDesktopTerminalFocus] = useState(false);
  const [localHistoryPanelWidth, setLocalHistoryPanelWidth] = useState(
    DEFAULT_HISTORY_PANEL_WIDTH,
  );
  const [lookupError, setLookupError] = useState<{
    sessionName: string;
    message: string;
  } | null>(null);

  const session = loadedSession?.name === sessionName ? loadedSession : null;
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

  const setBarVisible = useCallback((bar: ConsoleBar, visible: boolean) => {
    if (onBarVisibilityChange) {
      onBarVisibilityChange(bar, visible);
      return;
    }
    setLocalBarVisibility((current) => ({ ...current, [bar]: visible }));
  }, [onBarVisibilityChange]);

  const setMobileMode = useCallback((mode: MobileConsoleMode) => {
    if (onMobileModeChange) {
      onMobileModeChange(mode);
      return;
    }
    setLocalMobileMode(mode);
  }, [onMobileModeChange]);

  const showComposer = useCallback(() => {
    setBarVisible("stagedInput", true);
  }, [setBarVisible]);

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
          setTitleEditorOpen(false);
          setRenameEditorOpen(false);
          setTerminateTarget(null);
          setMessagesOpen(false);
          setSnippetsOpen(false);
          setLookupError({
            sessionName,
            message: "This tmux session no longer exists.",
          });
          return;
        }
        setLoadedSession(match);
        setPaneId((current) => current || match.activePaneId);
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
    setDesktopTerminalFocus(false);
    setHistoryOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
  }, [sessionName]);

  useEffect(() => {
    if (!workspaceOverlayOpen) return;
    setMobileDistractionFreeMode(null);
    setDesktopTerminalFocus(false);
    setHistoryOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
  }, [workspaceOverlayOpen]);

  useEffect(() => {
    if (
      mobileDistractionFreeMode
      && activeMobileFocus !== mobileDistractionFreeMode
    ) setMobileDistractionFreeMode(null);
  }, [activeMobileFocus, mobileDistractionFreeMode]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobileLayout = window.matchMedia(MOBILE_CONSOLE_LAYOUT_QUERY);
    const leaveDesktopFocus = () => {
      if (mobileLayout.matches) setDesktopTerminalFocus(false);
    };
    leaveDesktopFocus();
    mobileLayout.addEventListener("change", leaveDesktopFocus);
    return () => mobileLayout.removeEventListener("change", leaveDesktopFocus);
  }, []);

  useEffect(() => {
    const title = session?.name === sessionName ? session.customTitle || sessionName : sessionName;
    document.title = `${title} - Muxdeck`;
  }, [session, sessionName]);

  const pane: Pane | undefined = session?.panes.find((item) => item.id === paneId) || (session ? activePane(session) : undefined);
  const classification = classifyPane(pane);
  const stateChange = useCallback((state: ConnectionState) => {
    setConnectionSnapshot({ sessionName, state });
  }, [sessionName]);
  const paneChange = useCallback((nextPaneId: string | null) => setPaneId(nextPaneId), []);
  const returnToLiveTerminal = useCallback(() => {
    terminalRef.current?.navigateHistory("exit");
    terminalRef.current?.jumpToLive();
    terminalRef.current?.focus();
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
    setHistoryOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setTerminateTarget(null);
    setMessagesOpen(false);
    setSnippetsOpen(false);
    setDesktopTerminalFocus(true);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, []);
  const exitDesktopTerminalFocus = useCallback(() => {
    setDesktopTerminalFocus(false);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!desktopTerminalFocus) return;

    const handleDesktopFocusShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || event.code !== "KeyF"
        || !event.ctrlKey
        || !event.shiftKey
        || event.altKey
        || event.metaKey
      ) return;
      event.preventDefault();
      event.stopPropagation();
      exitDesktopTerminalFocus();
    };

    // Capture the chord before xterm turns it into terminal input.
    window.addEventListener("keydown", handleDesktopFocusShortcut, true);
    return () => window.removeEventListener("keydown", handleDesktopFocusShortcut, true);
  }, [desktopTerminalFocus, exitDesktopTerminalFocus]);
  const saveSessionTitle = useCallback(async (title: string) => {
    const customTitle = await updateSessionTitle(sessionName, title);
    if (session) onSessionUpdate?.({ ...session, customTitle });
    setLoadedSession((current) => current?.name === sessionName ? { ...current, customTitle } : current);
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
      >
        <ConsoleBarToolbar
          visibility={visibleBars}
          availability={{
            sessionTabs: Boolean(sessionNavigation),
            stagedInput: false,
            shortcuts: false,
          }}
          onChange={setBarVisible}
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

  return (
    <main
      ref={consoleShellRef}
      className={sessionNavigation ? "console-shell has-session-navigation" : "console-shell"}
      data-composer-visible={visibleBars.stagedInput || visibleMobileMode === "input"}
      data-shortcuts-visible={visibleBars.shortcuts || visibleMobileMode === "input"}
      data-mobile-focus={activeMobileFocus}
      data-mobile-distraction-free={mobileDistractionFree ? "true" : "false"}
      data-desktop-focus={desktopTerminalFocus ? "true" : "false"}
    >
      <ConsoleBarToolbar
        visibility={visibleBars}
        availability={{ sessionTabs: Boolean(sessionNavigation) }}
        onChange={setBarVisible}
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
        <button type="button" className="icon-button back-button" onClick={onBack} aria-label="Back to sessions"><ArrowLeftIcon /></button>
        <div className="console-identity">
          <div className="console-title-line">
            <h1>{session?.customTitle || sessionName}</h1>
            <span className={`agent-badge ${classification.tone}`}>{classification.label}</span>
          </div>
          <p>{session?.customTitle ? `${sessionName} / ${pane?.path || "loading"}` : pane?.path || "Loading tmux session..."}</p>
        </div>
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
          <ThemeToggle />
        </div>
      </header>

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
          layoutRefreshToken={[
            activeMobileFocus,
            mobileDistractionFree ? "focus" : "standard",
            desktopTerminalFocus ? "desktop-focus" : "desktop-standard",
          ].join(":")}
          theme={theme}
          onStateChange={stateChange}
          onPaneChange={paneChange}
        />
        <nav className="terminal-view-controls" aria-label="Terminal view controls">
          <button
            type="button"
            className="terminal-view-control"
            aria-label="Raw terminal Page Up"
            aria-controls="muxdeck-active-console"
            title="Send Page Up to the foreground terminal application"
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminalRef.current?.send(RAW_PAGE_UP_SEQUENCE)}
          >
            <ArrowUpIcon />
            <span>PgUp</span>
          </button>
          <button
            type="button"
            className="terminal-view-control"
            aria-label="Raw terminal Page Down"
            aria-controls="muxdeck-active-console"
            title="Send Page Down to the foreground terminal application"
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminalRef.current?.send(RAW_PAGE_DOWN_SEQUENCE)}
          >
            <ArrowDownIcon />
            <span>PgDn</span>
          </button>
          <button
            type="button"
            className="terminal-view-control tmux-history"
            aria-label="Tmux Page Up"
            aria-controls="muxdeck-active-console"
            title="Enter tmux copy mode one page up"
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminalRef.current?.navigateHistory("page-up")}
          >
            <HistoryIcon />
            <span>T Up</span>
          </button>
          <button
            type="button"
            className="terminal-view-control tmux-history"
            aria-label="Tmux Page Down"
            aria-controls="muxdeck-active-console"
            title="Page down while tmux copy mode is active"
            disabled={connection !== "live"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminalRef.current?.navigateHistory("page-down")}
          >
            <HistoryIcon />
            <span>T Dn</span>
          </button>
          <button
            type="button"
            className="terminal-view-control live-toggle"
            aria-label="Return to live terminal"
            aria-controls="muxdeck-active-console"
            title="Leave tmux copy mode and return to live output"
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
            title="End this entire tmux session and all of its panes"
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
          <button
            type="button"
            className="desktop-terminal-focus-exit"
            aria-label="Exit desktop terminal focus"
            aria-controls="muxdeck-active-console"
            aria-pressed="true"
            aria-keyshortcuts="Control+Shift+F"
            title="Return to the full console (Ctrl+Shift+F)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={exitDesktopTerminalFocus}
          >
            <ContractIcon />
            <span>Exit</span>
          </button>
        )}
      </div>
      <InputBar
        key={sessionName}
        ref={inputBarRef}
        sessionName={sessionName}
        sessionId={session?.id}
        enabled={connection === "live"}
        composerVisible={visibleBars.stagedInput || visibleMobileMode === "input"}
        shortcutsVisible={visibleBars.shortcuts || visibleMobileMode === "input"}
        onSend={(data) => terminalRef.current?.send(data) ?? false}
        onSubmit={(data, withEnter) => (
          terminalRef.current?.submit(data, withEnter) ?? Promise.resolve(false)
        )}
        onAddToMemo={session ? addDraftToMemo : undefined}
        onConsumeMemo={session ? consumeStagedMemo : undefined}
        onReturnToLive={returnToLiveTerminal}
        onEnterDesktopFocus={enterDesktopTerminalFocus}
        mobileDistractionFree={mobileInputDistractionFree}
        onToggleMobileDistractionFree={toggleMobileInputDistractionFree}
        onFocus={() => terminalRef.current?.focus()}
        onRevealComposer={showComposer}
        onEditSessionTitle={session ? () => setTitleEditorOpen(true) : undefined}
        onRenameSession={session && onSessionRenamed
          ? () => setRenameEditorOpen(true)
          : undefined}
        onTerminateSession={session && onSessionTerminated
          ? openTerminateEditor
          : undefined}
        onOpenMessages={session ? () => setMessagesOpen(true) : undefined}
        onOpenSnippets={() => setSnippetsOpen(true)}
        messageCount={memorandumCount}
        queuedMessageCount={queuedMemorandumCount}
      />
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
          onSave={saveSessionTitle}
        />
      )}
      {!workspaceOverlayOpen && renameEditorOpen && session && (
        <SessionRenameDialog
          sessionName={session.name}
          onClose={() => setRenameEditorOpen(false)}
          onRename={saveSessionName}
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
            const accepted = await terminalRef.current?.submit(message.text, true);
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
