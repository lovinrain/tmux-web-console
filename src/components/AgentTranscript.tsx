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
const kindOf = (message: AgentTranscriptMessage) => message.kind
  ?? (message.role === "user" ? "prompt" : message.role === "tool" ? "tool" : "response");
const isActivity = (message: AgentTranscriptMessage) => !["prompt", "response"].includes(kindOf(message));
const roleLabel = (message: AgentTranscriptMessage) => ({
  prompt: "You", response: "Assistant", progress: "Progress update", tool: "Tool activity", context: "Session context",
})[kindOf(message)];

// Native files can begin with many metadata records. Continue past empty scan
// windows automatically, with a bound and an explicit continuation for huge files.
async function readVisiblePage(
  target: SavedScrollbackTarget, source: string | null, cursor: string | null,
  signal: AbortSignal, view: "conversation" | "all",
): Promise<AgentTranscriptPage> {
  let result = await loadAgentTranscript(target, source, cursor, signal, view);
  const cursors = new Set<string>();
  for (let scans = 1; scans < 8 && result.status === "available" && !result.messages.length && result.nextCursor; scans++) {
    if (signal.aborted || cursors.has(result.nextCursor)) break;
    cursors.add(result.nextCursor);
    const next = await loadAgentTranscript(target, result.selectedSource, result.nextCursor, signal, view);
    result = { ...next, partial: result.partial || next.partial, notice: next.notice ?? result.notice };
  }
  return result;
}

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
  const [showActivity, setShowActivity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const morePending = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const paneId = "paneId" in target ? target.paneId : undefined;
  const identity = "identity" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;
  const view = showActivity ? "all" : "conversation";

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
    void readVisiblePage(selectedTarget, source, null, controller.signal, view).then((result) => {
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
  }, [paneId, identity, historyId, source, revision, view]);

  const loadMore = async () => {
    if (!page?.nextCursor || loading || morePending.current) return;
    morePending.current = true;
    setLoadingMore(true);
    setError(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await readVisiblePage(target, page.selectedSource, page.nextCursor, controller.signal, view);
      if (controller.signal.aborted) return;
      setPage({ ...result, partial: page.partial || result.partial, notice: result.notice ?? page.notice });
      setMessages((current) => {
        const ids = new Set(current.map((entry) => entry.id));
        return [...current, ...result.messages.filter((entry) => !ids.has(entry.id))];
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load later messages");
    } finally {
      if (!controller.signal.aborted) { morePending.current = false; setLoadingMore(false); }
    }
  };

  const refresh = () => setRevision((value) => value + 1);
  const selected = sources.find((item) => item.key === page?.selectedSource);
  const shown = messages.filter((message) => showActivity || !isActivity(message));
  const groups: Array<{ activity: boolean; messages: AgentTranscriptMessage[] }> = [];
  for (const message of shown) {
    const activity = isActivity(message);
    const previous = groups.at(-1);
    if (activity && previous?.activity) previous.messages.push(message);
    else groups.push({ activity, messages: [message] });
  }
  const firstPrompt = shown.find((message) => kindOf(message) === "prompt");
  const lastReply = [...shown].reverse().find((message) => kindOf(message) === "response");
  const jump = (id: string | undefined) => {
    if (!id || !scroll.current) return;
    const entry = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === id);
    if (entry) {
      scroll.current.scrollTop += entry.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 12;
      entry.focus({ preventScroll: true });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.map((message) => `${roleLabel(message)}\n${message.text}${message.truncated ? "\n[Entry shortened]" : ""}`).join("\n\n"));
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Unable to copy. Select the text to copy it manually.");
    }
  };
  const entry = (message: AgentTranscriptMessage) => <article key={message.id} className="agent-transcript-message"
    data-role={message.role} data-kind={kindOf(message)} data-message-id={message.id} tabIndex={-1}>
    <div className="agent-transcript-message-heading"><strong>{kindOf(message) === "response" && selected ? label(selected) : roleLabel(message)}</strong>
      {kindOf(message) === "response" && <span className="agent-transcript-reply-label">Reply</span>}
      {message.timestamp !== null && <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleString()}</time>}
    </div>
    <pre>{message.text}</pre>
    {message.truncated && <p className="agent-transcript-notice">This long entry was shortened.</p>}
  </article>;

  return <section className="agent-transcript" aria-label="Agent transcript">
    <div className="agent-transcript-controls">
      {sources.length > 1 ? <label>Conversation
        <select aria-label="Transcript conversation" value={source ?? page?.selectedSource ?? ""} disabled={loading}
          onChange={(event) => setSource(event.target.value)}>
          {!page?.selectedSource && <option value="" disabled>Choose a recorded conversation</option>}
          {sources.map((item) => <option key={item.key} value={item.key}>{label(item)} · {item.agentSessionId || "ID not recorded"}</option>)}
        </select>
      </label> : selected && <span className="agent-transcript-source"><strong>{label(selected)}</strong>
        {selected.agentSessionId && <code>{selected.agentSessionId}</code>}</span>}
      <button type="button" className="icon-button" aria-label="Refresh transcript" disabled={loading} onClick={refresh}><RefreshIcon /></button>
    </div>
    <p className="agent-transcript-description">Your prompts and agent replies, starting with the first saved prompt. Refresh to include new messages.</p>
    <label className="agent-transcript-tools"><input type="checkbox" checked={showActivity}
      onChange={(event) => setShowActivity(event.target.checked)} />Show activity</label>
    {page?.notice && <p className="agent-transcript-notice" role="status">{page.notice}</p>}
    {error && <p className="agent-transcript-error" role="alert">{error} <button type="button" onClick={refresh}>Refresh</button></p>}
    <div className="agent-transcript-messages" ref={scroll} aria-label="Transcript messages" tabIndex={0} aria-busy={loading || loadingMore}>
      {loading && <p role="status">Finding the first saved prompt...</p>}
      {groups.map((group) => group.activity
        ? <details className="agent-transcript-activity" key={group.messages[0].id}>
          <summary>Activity · {group.messages.length} {group.messages.length === 1 ? "entry" : "entries"}</summary>
          {group.messages.map(entry)}
        </details> : entry(group.messages[0]))}
      {!loading && page?.status === "available" && shown.length === 0 && <p>{page.nextCursor
        ? "Still searching this large transcript. Continue to find the first saved prompt."
        : "No prompts or replies were found in this saved conversation. Show activity to inspect other visible records."}</p>}
      {page?.nextCursor && <button type="button" className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? "Loading..." : shown.length ? "Load later messages" : "Continue searching"}</button>}
      {!loading && page?.status === "available" && !page.nextCursor && messages.length > 0 && <p className="agent-transcript-end">End of saved conversation. Refresh for new messages.</p>}
    </div>
    <div className="agent-transcript-actions">
      <button type="button" className="secondary-button" disabled={!firstPrompt || loading} onClick={() => jump(firstPrompt?.id)}>First prompt</button>
      <button type="button" className="secondary-button" disabled={!lastReply || loading} onClick={() => jump(lastReply?.id)}>Latest loaded reply</button>
      <button type="button" className="secondary-button" disabled={!shown.length || loading} onClick={() => void copy()}>Copy loaded transcript</button>
      {onShowScrollback && <button type="button" className="secondary-button" onClick={onShowScrollback}>Terminal scrollback</button>}
      {onShowBeginning && <button type="button" className="secondary-button" onClick={onShowBeginning}>Recorded terminal output</button>}
      <span role="status">{copyStatus}</span>
    </div>
  </section>;
}
