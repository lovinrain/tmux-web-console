import { useCallback, useEffect, useRef, useState } from "react";
import { listSessions, updateSessionTitle } from "../api";
import { ArrowLeftIcon, HistoryIcon, TerminalIcon } from "../icons";
import type { ConnectionState, Pane, Session } from "../types";
import { HistoryPanel } from "./HistoryPanel";
import { InputBar, type InputBarHandle } from "./InputBar";
import { LiveTerminal, type LiveTerminalHandle } from "./LiveTerminal";
import { MessageQueueDialog } from "./MessageQueueDialog";
import { activePane, classifyPane } from "./SessionDashboard";
import { SnippetPickerDialog } from "./SnippetPickerDialog";
import { SessionTitleDialog } from "./SessionTitleDialog";

interface ConsoleScreenProps {
  sessionName: string;
  onBack: () => void;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  ended: "Ended",
  error: "Connection error",
};

export function ConsoleScreen({ sessionName, onBack }: ConsoleScreenProps) {
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const inputBarRef = useRef<InputBarHandle>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [titleEditorOpen, setTitleEditorOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [ignoreSize, setIgnoreSize] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sessions = await listSessions();
        if (cancelled) return;
        const match = sessions.find((item) => item.name === sessionName);
        if (!match) {
          setLookupError("This tmux session no longer exists.");
          return;
        }
        setSession(match);
        setPaneId((current) => current || match.activePaneId);
        setLookupError(null);
      } catch (error) {
        if (!cancelled) setLookupError(error instanceof Error ? error.message : "Unable to load session");
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionName]);

  useEffect(() => {
    const title = session?.name === sessionName ? session.customTitle || sessionName : sessionName;
    document.title = `${title} - Muxdeck`;
  }, [session, sessionName]);

  const pane: Pane | undefined = session?.panes.find((item) => item.id === paneId) || (session ? activePane(session) : undefined);
  const classification = classifyPane(pane);
  const stateChange = useCallback((state: ConnectionState) => setConnection(state), []);
  const paneChange = useCallback((nextPaneId: string | null) => setPaneId(nextPaneId), []);
  const saveSessionTitle = useCallback(async (title: string) => {
    const customTitle = await updateSessionTitle(sessionName, title);
    setSession((current) => current?.name === sessionName ? { ...current, customTitle } : current);
    setTitleEditorOpen(false);
  }, [sessionName]);

  if (lookupError && !session) {
    return (
      <main className="missing-session">
        <TerminalIcon />
        <p className="eyebrow">SESSION UNAVAILABLE</p>
        <h1>{sessionName}</h1>
        <p>{lookupError}</p>
        <button type="button" className="primary-button" onClick={onBack}>Back to sessions</button>
      </main>
    );
  }

  return (
    <main className="console-shell">
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
          <button type="button" className="history-button" onClick={() => setHistoryOpen(true)} disabled={!pane} aria-label="History">
            <HistoryIcon /><span>History</span>
          </button>
        </div>
      </header>

      <div className="terminal-coordinate top-left">{pane ? `${pane.width}x${pane.height}` : "--x--"}</div>
      <LiveTerminal
        ref={terminalRef}
        session={sessionName}
        ignoreSize={ignoreSize}
        onStateChange={stateChange}
        onPaneChange={paneChange}
      />
      <InputBar
        key={sessionName}
        ref={inputBarRef}
        sessionName={sessionName}
        enabled={connection === "live"}
        onSend={(data) => terminalRef.current?.send(data) ?? false}
        onSubmit={(data, withEnter) => (
          terminalRef.current?.submit(data, withEnter) ?? Promise.resolve(false)
        )}
        onFocus={() => terminalRef.current?.focus()}
        onEditSessionTitle={session ? () => setTitleEditorOpen(true) : undefined}
        onOpenMessages={session ? () => setMessagesOpen(true) : undefined}
        onOpenSnippets={() => setSnippetsOpen(true)}
        messageCount={session?.queuedMessageCount ?? 0}
      />
      {historyOpen && pane && <HistoryPanel pane={pane} onClose={() => setHistoryOpen(false)} />}
      {titleEditorOpen && session && (
        <SessionTitleDialog
          session={session}
          onClose={() => setTitleEditorOpen(false)}
          onSave={saveSessionTitle}
        />
      )}
      {messagesOpen && session && (
        <MessageQueueDialog
          sessionName={session.name}
          sessionTitle={session.customTitle}
          onClose={() => setMessagesOpen(false)}
          onChoose={(message) => {
            if (!inputBarRef.current?.loadDraft(message.text)) {
              throw new Error("The current staged draft was left unchanged.");
            }
          }}
          onSend={async (message) => {
            const accepted = await terminalRef.current?.submit(message.text, true);
            if (!accepted) {
              throw new Error("Delivery was not confirmed; check the terminal before retrying.");
            }
          }}
        />
      )}
      {snippetsOpen && (
        <SnippetPickerDialog
          title="Insert into staged input"
          onClose={() => setSnippetsOpen(false)}
          onChoose={(snippet) => {
            if (!inputBarRef.current?.insertText(snippet.text)) {
              throw new Error("The snippet does not fit or the current draft is busy.");
            }
          }}
        />
      )}
    </main>
  );
}
