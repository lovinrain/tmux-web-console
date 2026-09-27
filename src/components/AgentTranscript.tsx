import { useEffect, useRef, useState } from "react";
import {
  loadAgentTranscript,
  type AgentTranscriptMessage,
  type AgentTranscriptPage,
  type AgentTranscriptSource,
  type SavedScrollbackTarget,
} from "../api";
import { agentDisplayLabel, type RecoveryAgentType } from "../agentResume";
import { RefreshIcon } from "../icons";
import "./AgentTranscript.css";

interface Props {
  target: SavedScrollbackTarget;
  onShowScrollback?: () => void;
  onShowBeginning?: () => void;
}

const label = (source: AgentTranscriptSource) => agentDisplayLabel(source.agentType as RecoveryAgentType);
const roleLabel = (role: AgentTranscriptMessage["role"]) => role === "user" ? "You" : role === "tool" ? "Tool activity" : "Assistant";

export function AgentTranscript(props: Props) {
  const key = "paneId" in props.target
    ? `${props.target.paneId}:${props.target.identity ?? ""}` : props.target.historyId;
  return <TranscriptContent key={key} {...props} />;
}

function TranscriptContent({ target, onShowScrollback, onShowBeginning }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [sources, setSources] = useState<AgentTranscriptSource[]>([]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<AgentTranscriptPage | null>(null);
  const [messages, setMessages] = useState<AgentTranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const morePending = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const paneId = "paneId" in target ? target.paneId : undefined;
  const identity = "paneId" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    morePending.current = false;
    setLoading(true);
    setLoadingMore(false);
    setPage(null);
    setMessages([]);
    setError(null);
    setCopyStatus("");
    const selectedTarget: SavedScrollbackTarget = paneId !== undefined ? { paneId, identity } : { historyId: historyId! };
    void loadAgentTranscript(selectedTarget, source, null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPage(result);
      setSources(result.sources);
      setMessages(result.messages);
      if (scroll.current) scroll.current.scrollTop = 0;
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load transcript");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [paneId, identity, historyId, source, revision]);

  const loadMore = async () => {
    if (!page?.nextCursor || loading || morePending.current) return;
    morePending.current = true;
    setLoadingMore(true);
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await loadAgentTranscript(target, page.selectedSource, page.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setPage({ ...result, partial: page.partial || result.partial, notice: result.notice ?? page.notice });
      setMessages((current) => [...current, ...result.messages.filter((entry) => !current.some((item) => item.id === entry.id))]);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load later messages");
    } finally {
      if (!controller.signal.aborted) { morePending.current = false; setLoadingMore(false); }
    }
  };

  const refresh = () => setRevision((value) => value + 1);
  const selected = sources.find((item) => item.key === page?.selectedSource);
  const shown = messages.filter((message) => showTools || message.role !== "tool");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.map((message) => `${roleLabel(message.role)}\n${message.text}${message.truncated ? "\n[Entry shortened]" : ""}`).join("\n\n"));
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Unable to copy. Select the text to copy it manually.");
    }
  };

  return <section className="agent-transcript" aria-label="Agent transcript">
    <div className="agent-transcript-controls">
      {sources.length > 1 ? <label>Conversation
        <select aria-label="Transcript conversation" value={source ?? page?.selectedSource ?? ""} disabled={loading}
          onChange={(event) => setSource(event.target.value)}>
          {sources.map((item) => <option key={item.key} value={item.key}>{label(item)} · {item.agentSessionId || "ID not recorded"}</option>)}
        </select>
      </label> : selected && <span className="agent-transcript-source"><strong>{label(selected)}</strong>
        {selected.agentSessionId && <code>{selected.agentSessionId}</code>}</span>}
      <button type="button" className="icon-button" aria-label="Refresh transcript" disabled={loading} onClick={refresh}><RefreshIcon /></button>
    </div>
    <p className="agent-transcript-description">Local conversation, earliest messages first. Refresh to include new messages.</p>
    <label className="agent-transcript-tools"><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} />Show tool activity</label>
    {page?.notice && <p className="agent-transcript-notice" role="status">{page.notice}</p>}
    {error && <p className="agent-transcript-error" role="alert">{error} <button type="button" onClick={refresh}>Refresh</button></p>}
    <div className="agent-transcript-messages" ref={scroll} aria-label="Transcript messages" tabIndex={0} aria-busy={loading || loadingMore}>
      {loading && <p role="status">Loading local transcript...</p>}
      {shown.map((message) => <article key={message.id} className="agent-transcript-message" data-role={message.role}>
        {message.role === "tool" ? <details><summary>Tool activity</summary><pre>{message.text}</pre></details> : <>
          <div className="agent-transcript-message-heading"><strong>{roleLabel(message.role)}</strong>
            {message.timestamp !== null && <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleString()}</time>}
          </div><pre>{message.text}</pre>
        </>}
        {message.truncated && <p className="agent-transcript-notice">This long entry was shortened.</p>}
      </article>)}
      {!loading && page?.status === "available" && shown.length === 0 && <p>{page.nextCursor
        ? "No conversation messages loaded yet. Load later messages or show tool activity."
        : "No readable conversation messages were found in this transcript."}</p>}
      {page?.nextCursor && <button type="button" className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? "Loading..." : "Load later messages"}</button>}
      {!loading && page?.status === "available" && !page.nextCursor && messages.length > 0 && <p className="agent-transcript-end">End of saved conversation. Refresh for new messages.</p>}
    </div>
    <div className="agent-transcript-actions">
      <button type="button" className="secondary-button" disabled={!shown.length || loading} onClick={() => void copy()}>Copy loaded transcript</button>
      {onShowScrollback && <button type="button" className="secondary-button" onClick={onShowScrollback}>Terminal scrollback</button>}
      {onShowBeginning && <button type="button" className="secondary-button" onClick={onShowBeginning}>Saved beginning</button>}
      <span role="status">{copyStatus}</span>
    </div>
  </section>;
}
