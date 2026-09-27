import { useEffect, useState } from "react";
import {
  listSubmittedMessages,
  type SubmittedMessagePage,
  type SubmittedMessageTarget,
} from "../api";
import { RefreshIcon } from "../icons";
import "./SubmittedMessages.css";

const agentLabel = (agent: string) => agent === "claude" ? "Claude Code" : "Codex";

export function SubmittedMessages({ target }: { target: SubmittedMessageTarget }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SubmittedMessagePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const sessionName = "sessionName" in target ? target.sessionName : undefined;
  const identity = "sessionName" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCopied(null);
    if (cursor === null) setPage(null);
    const source: SubmittedMessageTarget = sessionName !== undefined
      ? { sessionName, identity } : { historyId: historyId! };
    void listSubmittedMessages(source, search, cursor, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPage((previous) => ({
        ...result,
        messages: cursor === null ? result.messages : [
          ...(previous?.messages ?? []),
          ...result.messages.filter((item) => !previous?.messages.some((existing) => existing.id === item.id)),
        ],
      }));
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load submitted messages");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [sessionName, identity, historyId, cursor, revision, search]);

  const refresh = () => { setCursor(null); setRevision((value) => value + 1); };
  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setError("Unable to copy. Select the message text to copy it manually.");
    }
  };

  return <section className="submitted-messages" aria-label="Submitted messages">
    <p className="submitted-messages-description">Input saved after submission in Claude Code and Codex. Saved messages remain when tmux scrollback is cleared.</p>
    <form className="submitted-messages-search" onSubmit={(event) => {
      event.preventDefault(); setSearch(query.trim()); refresh();
    }}>
      <input type="search" aria-label="Search submitted messages" placeholder="Search submitted messages" maxLength={256}
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit" className="secondary-button">Search</button>
      <button type="button" className="icon-button" aria-label="Refresh submitted messages" disabled={loading} onClick={refresh}><RefreshIcon /></button>
    </form>
    {page?.sources.filter((source) => source.status !== "available").map((source) => <p className="submitted-messages-notice" key={source.agentType}>
      {source.status === "partial"
        ? `Some ${agentLabel(source.agentType)} history entries could not be read.`
        : `${agentLabel(source.agentType)} input history is currently unavailable.`} Previously saved messages are retained.
    </p>)}
    {error && <p className="submitted-messages-error" role="alert">{error} <button type="button" onClick={refresh}>Retry</button></p>}
    <div className="submitted-messages-list" aria-busy={loading}>
      {!loading && !error && page?.messages.length === 0 && <p className="submitted-messages-empty">
        {search ? "No submitted messages match your search."
          : page.sources.length ? "No submitted messages recorded yet."
            : "No Claude Code or Codex conversation ID has been recorded for this session yet."}
      </p>}
      {page?.messages.map((message) => <article className="submitted-message" key={message.id}>
        <header>
          <span title={`Conversation ${message.agentSessionId}`}>{agentLabel(message.agentType)}</span>
          <time dateTime={new Date(message.submittedAt).toISOString()}>{new Date(message.submittedAt).toLocaleString()}</time>
          <button type="button" className="secondary-button" aria-label="Copy message" onClick={() => void copy(message.text, message.id)}>Copy</button>
        </header>
        {!message.complete && <p className="submitted-messages-notice">Some pasted content or image attachments are unavailable.</p>}
        <pre>{message.text}</pre>
      </article>)}
      {loading && <p role="status">Loading submitted messages...</p>}
      {page?.nextCursor && <button type="button" className="load-older" disabled={loading} onClick={() => setCursor(page.nextCursor)}>Load older messages</button>}
    </div>
    <div className="submitted-messages-actions">
      <button type="button" className="secondary-button" disabled={!page?.messages.length}
        onClick={() => void copy(page!.messages.map((message) => message.text).join("\n\n"), "all")}>Copy loaded messages</button>
      <span role="status">{copied ? "Copied" : "Newest first"}</span>
    </div>
  </section>;
}
