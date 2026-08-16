import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listSessions, renameSession, updateSessionTitle } from "../api";
import { ArrowLeftIcon, HistoryIcon, TerminalIcon } from "../icons";
import { useTheme } from "../theme";
import type { ConnectionState, Pane, Session } from "../types";
import { DEFAULT_HISTORY_PANEL_WIDTH, HistoryPanel } from "./HistoryPanel";
import {
  handoffRenamedSessionDraft,
  InputBar,
  type InputBarHandle,
} from "./InputBar";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";
import { MessageQueueDialog } from "./MessageQueueDialog";
import { activePane, classifyPane } from "./SessionDashboard";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import { SessionTitleDialog } from "./SessionTitleDialog";
import { SessionRenameDialog } from "./SessionRenameDialog";
import { ThemeToggle } from "./ThemeToggle";

interface ConsoleScreenProps {
  sessionName: string;
  onBack: () => void;
  sessionNavigation?: ReactNode;
  workspaceOverlayOpen?: boolean;
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
  barVisibility,
  onBarVisibilityChange,
  historyPanelWidth,
  onHistoryPanelWidthChange,
  onSessionsChange,
  onSessionUpdate,
  onSessionRenamed,
  renameWarning,
  onDismissRenameWarning,
}: ConsoleScreenProps) {
  const { theme } = useTheme();
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
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [ignoreSize, setIgnoreSize] = useState(false);
  const [localBarVisibility, setLocalBarVisibility] = useState(
    DEFAULT_CONSOLE_BAR_VISIBILITY,
  );
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
  const visibleHistoryPanelWidth = historyPanelWidth ?? localHistoryPanelWidth;

  const setBarVisible = useCallback((bar: ConsoleBar, visible: boolean) => {
    if (onBarVisibilityChange) {
      onBarVisibilityChange(bar, visible);
      return;
    }
    setLocalBarVisibility((current) => ({ ...current, [bar]: visible }));
  }, [onBarVisibilityChange]);

  const showComposer = useCallback(() => {
    setBarVisible("stagedInput", true);
  }, [setBarVisible]);

  const setHistoryPanelWidth = useCallback((width: number) => {
    if (historyPanelWidth === undefined) setLocalHistoryPanelWidth(width);
    onHistoryPanelWidthChange?.(width);
  }, [historyPanelWidth, onHistoryPanelWidthChange]);

  const revealAndFocusComposer = useCallback(() => {
    showComposer();
    window.requestAnimationFrame(() => inputBarRef.current?.focus());
  }, [showComposer]);

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
    setHistoryOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setMessagesOpen(false);
    setSnippetsOpen(false);
  }, [sessionName]);

  useEffect(() => {
    if (!workspaceOverlayOpen) return;
    setHistoryOpen(false);
    setTitleEditorOpen(false);
    setRenameEditorOpen(false);
    setMessagesOpen(false);
    setSnippetsOpen(false);
  }, [workspaceOverlayOpen]);

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
  const saveSessionTitle = useCallback(async (title: string) => {
    const customTitle = await updateSessionTitle(sessionName, title);
    if (session) onSessionUpdate?.({ ...session, customTitle });
    setLoadedSession((current) => current?.name === sessionName ? { ...current, customTitle } : current);
    setTitleEditorOpen(false);
  }, [onSessionUpdate, session, sessionName]);
  const saveSessionName = useCallback(async (name: string) => {
    if (!session) throw new Error("This tmux session is no longer available.");
    const visibleDraft = inputBarRef.current?.getDraft() ?? "";
    const result = await renameSession(sessionName, name);
    handoffRenamedSessionDraft(sessionName, result.session, session.id, visibleDraft);
    setRenameEditorOpen(false);
    onSessionRenamed?.(sessionName, result.session, session.id, result.warnings);
  }, [onSessionRenamed, session, sessionName]);

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
      className={sessionNavigation ? "console-shell has-session-navigation" : "console-shell"}
      data-composer-visible={visibleBars.stagedInput}
      data-shortcuts-visible={visibleBars.shortcuts}
    >
      <ConsoleBarToolbar
        visibility={visibleBars}
        availability={{ sessionTabs: Boolean(sessionNavigation) }}
        onChange={setBarVisible}
      />
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
      <LiveTerminal
        ref={terminalRef}
        session={sessionName}
        ignoreSize={ignoreSize}
        theme={theme}
        onStateChange={stateChange}
        onPaneChange={paneChange}
      />
      <InputBar
        key={sessionName}
        ref={inputBarRef}
        sessionName={sessionName}
        sessionId={session?.id}
        enabled={connection === "live"}
        composerVisible={visibleBars.stagedInput}
        shortcutsVisible={visibleBars.shortcuts}
        onSend={(data) => terminalRef.current?.send(data) ?? false}
        onSubmit={(data, withEnter) => (
          terminalRef.current?.submit(data, withEnter) ?? Promise.resolve(false)
        )}
        onFocus={() => terminalRef.current?.focus()}
        onRevealComposer={showComposer}
        onEditSessionTitle={session ? () => setTitleEditorOpen(true) : undefined}
        onRenameSession={session && onSessionRenamed
          ? () => setRenameEditorOpen(true)
          : undefined}
        onOpenMessages={session ? () => setMessagesOpen(true) : undefined}
        onOpenSnippets={() => setSnippetsOpen(true)}
        messageCount={session?.queuedMessageCount ?? 0}
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
      {!workspaceOverlayOpen && messagesOpen && session && (
        <MessageQueueDialog
          sessionName={session.name}
          sessionTitle={session.customTitle}
          onClose={() => setMessagesOpen(false)}
          onChoose={(message) => {
            if (!inputBarRef.current?.loadDraft(message.text)) {
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
