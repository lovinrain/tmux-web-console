import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type AgentTranscriptMessage,
  type AgentTranscriptSource,
  type SavedScrollbackTarget,
} from "../api";
import { agentDisplayLabel, type RecoveryAgentType } from "../agentResume";
import { RefreshIcon } from "../icons";
import { useTranscriptPages } from "../useTranscriptPages";
import { useTranscriptSearch } from "../useTranscriptSearch";
import { createTranscriptMatcher, type TranscriptSearchMode } from "../transcriptSearch";
import { TranscriptText } from "./TranscriptText";
import "./AgentTranscript.css";

const TranscriptMarkdown = lazy(() => import("./TranscriptMarkdown"));

interface Props {
  target: SavedScrollbackTarget;
  title?: string;
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

const AUTO_LOAD_PREFERENCE = "muxdeck.transcript.auto-load";
function readAutoLoadPreference() {
  try { return localStorage.getItem(AUTO_LOAD_PREFERENCE) !== "false"; }
  catch { return true; }
}

export function AgentTranscript(props: Props) {
  const key = "paneId" in props.target
    ? `${props.target.paneId}:${props.target.identity ?? ""}` : props.target.historyId;
  return <TranscriptContent key={key} {...props} />;
}

function TranscriptContent({ target, title = "Session transcript", onShowScrollback, onShowBeginning }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [showActivity, setShowActivity] = useState(false);
  const [plainText, setPlainText] = useState(false);
  const [autoLoad, setAutoLoad] = useState(readAutoLoadPreference);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<TranscriptSearchMode>("phrase");
  const [searchScope, setSearchScope] = useState<"full" | "loaded">("full");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [searchRole, setSearchRole] = useState("all");
  const [currentMatch, setCurrentMatch] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [exporting, setExporting] = useState<"markdown" | "pdf" | null>(null);
  const [exportCount, setExportCount] = useState(0);
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const exportRequest = useRef<{ controller: AbortController; popup: Window | null } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const laterButton = useRef<HTMLButtonElement>(null);
  const pendingJump = useRef<{ id: string; focus: boolean; edge?: "top" | "bottom" } | null>(null);
  const scrollAnchor = useRef<{ id: string; top: number } | null>(null);
  const paneId = "paneId" in target ? target.paneId : undefined;
  const identity = "identity" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;
  const view = showActivity ? "all" : "conversation";
  const transcript = useTranscriptPages(target, source, view, revision);
  const { page, sources, messages, loading, loadingMore, error, hasLater, hasEarlier,
    loadMore, loadEarlier, readFull, cancelFull, showWindow, full, fullPurpose, fullError, fullCancelled } = transcript;
  const fullLoading = fullPurpose !== null;

  useEffect(() => {
    try { localStorage.setItem(AUTO_LOAD_PREFERENCE, String(autoLoad)); } catch { /* Optional browser preference. */ }
  }, [autoLoad]);

  useEffect(() => {
    setCopyStatus("");
    setCurrentMatch(null);
    pendingJump.current = null;
    scrollAnchor.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
    exportRequest.current?.controller.abort();
    exportRequest.current?.popup?.close();
    exportRequest.current = null;
    setExporting(null);
    setExportCount(0);
    setExportStatus("");
    setExportError(null);
    return () => {
      exportRequest.current?.controller.abort();
      exportRequest.current?.popup?.close();
    };
  }, [paneId, identity, historyId, source, revision, view]);

  const loadAtBottom = () => {
    const element = scroll.current;
    if (autoLoad && hasLater && messages.length && !error && !loading && !loadingMore && !fullLoading
      && element && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight <= 120) void loadMore();
  };
  useEffect(() => {
    if (!autoLoad || !hasLater || !messages.length || loading || loadingMore || fullLoading || error
      || !laterButton.current || !scroll.current || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (active && entries.some((entry) => entry.isIntersecting) && scroll.current && scroll.current.clientHeight > 0) void loadMore();
    }, { root: scroll.current, rootMargin: "0px 0px 120px 0px" });
    observer.observe(laterButton.current);
    return () => { active = false; observer.disconnect(); };
  }, [autoLoad, hasLater, messages.length, loading, loadingMore, fullLoading, error, loadMore]);

  useEffect(() => {
    if (query.trim() && searchScope === "full" && hasLater && !full && !loading && !fullLoading && !fullError && !fullCancelled) {
      const timeout = window.setTimeout(() => void readFull("search"), 250);
      return () => window.clearTimeout(timeout);
    }
  }, [query, searchScope, hasLater, full, loading, fullLoading, fullError, fullCancelled, readFull]);
  useEffect(() => {
    if ((!query.trim() || searchScope === "loaded") && fullPurpose === "search") cancelFull();
  }, [query, searchScope, fullPurpose, cancelFull]);
  useEffect(() => {
    if (!showActivity && !["all", "prompt", "response"].includes(searchRole)) setSearchRole("all");
  }, [showActivity, searchRole]);

  const refresh = () => setRevision((value) => value + 1);
  const selected = sources.find((item) => item.key === page?.selectedSource);
  const shown = useMemo(() => messages.filter((message) => showActivity || !isActivity(message)), [messages, showActivity]);
  const matcher = useMemo(() => createTranscriptMatcher(query, { mode: searchMode, caseSensitive, wholeWords }),
    [query, searchMode, caseSensitive, wholeWords]);
  const searchPool = searchScope === "full" && full ? full.messages : shown;
  const searchMessages = useMemo(() => searchPool
    .filter((message) => (showActivity || !isActivity(message)) && (searchRole === "all" || kindOf(message) === searchRole)),
    [searchPool, showActivity, searchRole]);
  const { matches, pending: searching } = useTranscriptSearch(searchMessages, matcher);
  const matchIndex = matches.findIndex((message) => message.id === currentMatch);
  const matchedIds = useMemo(() => new Set(matches.map((message) => message.id)), [matches]);
  const groups: Array<{ activity: boolean; messages: AgentTranscriptMessage[] }> = [];
  for (const message of shown) {
    const activity = isActivity(message);
    const previous = groups.at(-1);
    if (activity && previous?.activity) previous.messages.push(message);
    else groups.push({ activity, messages: [message] });
  }
  const firstPrompt = shown.find((message) => kindOf(message) === "prompt");
  const lastReply = [...shown].reverse().find((message) => kindOf(message) === "response");
  const jump = (id: string | undefined, focus = true) => {
    if (!id || !scroll.current) return;
    const entry = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === id);
    if (entry) {
      const activity = entry.closest("details");
      if (activity) activity.open = true;
      scroll.current.scrollTop += entry.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 12;
      if (focus) entry.focus({ preventScroll: true });
    }
  };
  useLayoutEffect(() => {
    if (scrollAnchor.current && scroll.current) {
      const anchor = scrollAnchor.current;
      const element = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-message-id]"))
        .find((item) => item.dataset.messageId === anchor.id);
      if (element) scroll.current.scrollTop += element.getBoundingClientRect().top - anchor.top;
      scrollAnchor.current = null;
    }
    if (pendingJump.current) {
      const { id, focus, edge } = pendingJump.current;
      jump(id, focus);
      if (edge && scroll.current) scroll.current.scrollTop = edge === "top" ? 0 : scroll.current.scrollHeight;
      pendingJump.current = null;
    }
  }, [messages, currentMatch]);
  const navigateMatch = (direction: number) => {
    if (!matches.length) return;
    if (fullPurpose === "end") cancelFull();
    const index = matchIndex < 0 ? (direction > 0 ? 0 : matches.length - 1)
      : (matchIndex + direction + matches.length) % matches.length;
    const message = matches[index];
    setCurrentMatch(message.id);
    if (!shown.some((item) => item.id === message.id) && full) {
      pendingJump.current = { id: message.id, focus: false };
      showWindow(full.messages.findIndex((item) => item.id === message.id));
    } else jump(message.id, false);
  };
  const viewEdge = (edge: "top" | "bottom") => {
    if (fullPurpose === "end") cancelFull();
    if (scroll.current) {
      scroll.current.scrollTop = edge === "top" ? 0 : scroll.current.scrollHeight;
      scroll.current.focus({ preventScroll: true });
    }
  };
  const beginning = () => {
    if (fullPurpose === "end") cancelFull();
    if (full) {
      showWindow(0, "start");
      const first = full.messages[0];
      if (first) pendingJump.current = { id: first.id, focus: true, edge: "top" };
    } else { viewEdge("top"); }
  };
  const end = async () => {
    const result = full ?? (!hasLater ? null : await readFull("end"));
    if (result) {
      const last = result.messages.at(-1);
      if (!last) return;
      pendingJump.current = { id: last.id, focus: true, edge: "bottom" };
      showWindow(result.messages.length - 1, "end");
    } else if (!hasLater) viewEdge("bottom");
  };
  const earlier = () => {
    const top = scroll.current?.getBoundingClientRect().top ?? 0;
    const first = Array.from(scroll.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
      .find((item) => item.getBoundingClientRect().bottom > top);
    if (first?.dataset.messageId) scrollAnchor.current = { id: first.dataset.messageId, top: first.getBoundingClientRect().top };
    loadEarlier();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown.map((message) => `${roleLabel(message)}\n${message.text}${message.truncated ? "\n[Entry shortened]" : ""}`).join("\n\n"));
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Unable to copy. Select the text to copy it manually.");
    }
  };
  const cancelExport = () => {
    exportRequest.current?.controller.abort();
    exportRequest.current?.popup?.close();
    exportRequest.current = null;
    setExporting(null);
    setExportStatus("Export cancelled.");
  };
  const exportTranscript = async (format: "markdown" | "pdf") => {
    if (exportRequest.current || loading || page?.status !== "available" || !page.selectedSource) return;
    const controller = new AbortController();
    let popup: Window | null = null;
    setExportError(null);
    setExportStatus("");
    try {
      if (format === "pdf") {
        // Open inside the click gesture, before fetching the remaining pages.
        popup = window.open("", "_blank");
        if (!popup) throw new Error("Allow pop-ups for Muxdeck to open the PDF print view.");
        popup.opener = null;
        popup.document.title = "Preparing transcript";
        popup.document.body.textContent = "Preparing the full conversation… You can cancel in Muxdeck.";
      }
      exportRequest.current = { controller, popup };
      setExporting(format);
      setExportCount(0);
      const exporter = await import("../transcriptExport");
      const transcript = await exporter.collectTranscript(target, page.selectedSource, view, controller.signal, setExportCount);
      controller.signal.throwIfAborted();
      if (popup) {
        const { writeTranscriptPrint } = await import("./TranscriptPrint");
        controller.signal.throwIfAborted();
        writeTranscriptPrint(popup, transcript, title);
        setExportStatus("PDF view ready. Choose Print / Save as PDF in the new tab.");
      } else {
        exporter.downloadTranscriptMarkdown(transcript, title);
        setExportStatus(`Markdown exported · ${transcript.messages.length.toLocaleString()} messages.`);
      }
      if (transcript.notices.length) setExportStatus((status) => `${status} Includes notices about incomplete or shortened records.`);
    } catch (failure) {
      popup?.close();
      if (!controller.signal.aborted) setExportError(failure instanceof Error ? failure.message : "Unable to export the transcript.");
    } finally {
      if (exportRequest.current?.controller === controller) {
        exportRequest.current = null;
        setExporting(null);
      }
    }
  };
  const entry = (message: AgentTranscriptMessage) => {
    const highlight = matchedIds.has(message.id) ? matcher : null;
    return <article key={message.id} className="agent-transcript-message"
    data-role={message.role} data-kind={kindOf(message)} data-message-id={message.id} tabIndex={-1}
    data-search-match={matchedIds.has(message.id) || undefined} data-search-current={currentMatch === message.id || undefined}>
    <div className="agent-transcript-message-heading"><strong>{kindOf(message) === "response" && selected ? label(selected) : roleLabel(message)}</strong>
      {kindOf(message) === "response" && <span className="agent-transcript-reply-label">Reply</span>}
      {message.timestamp !== null && <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleString()}</time>}
    </div>
    {plainText || isActivity(message) ? <pre className="agent-transcript-plain"><TranscriptText text={message.text} matcher={highlight} /></pre>
      : <Suspense fallback={<pre className="agent-transcript-plain"><TranscriptText text={message.text} matcher={highlight} /></pre>}>
        <TranscriptMarkdown text={message.text} matcher={highlight} />
      </Suspense>}
    {message.truncated && <p className="agent-transcript-notice">This long entry was shortened.</p>}
  </article>;
  };

  return <section className="agent-transcript" aria-label="Agent transcript" onKeyDownCapture={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); searchInput.current?.select();
    }
  }}>
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
    <p className="agent-transcript-description">Your prompts and agent replies from the local conversation, starting with the first saved prompt. Refresh for new messages.</p>
    <div className="agent-transcript-options">
      <div className="agent-transcript-format" role="group" aria-label="Transcript format">
        <button type="button" aria-pressed={!plainText} onClick={() => setPlainText(false)}>Formatted</button>
        <button type="button" aria-pressed={plainText} onClick={() => setPlainText(true)}>Plain text</button>
      </div>
      <label className="agent-transcript-tools"><input type="checkbox" checked={showActivity}
        onChange={(event) => setShowActivity(event.target.checked)} />Show activity</label>
      <label className="agent-transcript-tools" title="Load later messages automatically when you approach the bottom">
        <input type="checkbox" aria-label="Auto-load later messages" checked={autoLoad}
          onChange={(event) => setAutoLoad(event.target.checked)} />
        <span className="agent-transcript-auto-full">Auto-load later messages</span><span className="agent-transcript-auto-compact">Auto-load</span></label>
    </div>
    <div className="agent-transcript-navigation" role="group" aria-label="Transcript navigation">
      <div className="agent-transcript-navigation-set"><span>Loaded view</span>
        <button type="button" className="secondary-button" disabled={loading || !shown.length} onClick={() => viewEdge("top")}>View top</button>
        <button type="button" className="secondary-button" disabled={loading || !shown.length} onClick={() => viewEdge("bottom")}>View bottom</button>
      </div>
      <div className="agent-transcript-navigation-set"><span>Full transcript</span>
        <button type="button" className="secondary-button" disabled={loading || !shown.length} onClick={beginning}>Transcript start</button>
        <button type="button" className="secondary-button" disabled={loading || fullLoading || page?.status !== "available"}
          onClick={() => void end()}>Transcript end</button>
      </div>
    </div>
    <div className="agent-transcript-search" role="search" aria-label="Search transcript">
      <div className="agent-transcript-search-row">
        <input ref={searchInput} type="search" aria-label="Search transcript" placeholder="Search transcript…" maxLength={500}
          title="Ctrl/Cmd+F to search; Enter for next match, Shift+Enter for previous"
          value={query} onChange={(event) => { setQuery(event.target.value); setCurrentMatch(null); }} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); navigateMatch(event.shiftKey ? -1 : 1); }
          }} />
        <button type="button" className="secondary-button" aria-label="Previous transcript match" disabled={!matches.length} onClick={() => navigateMatch(-1)}>↑</button>
        <button type="button" className="secondary-button" aria-label="Next transcript match" disabled={!matches.length} onClick={() => navigateMatch(1)}>↓</button>
        {query && <button type="button" className="secondary-button" onClick={() => { setQuery(""); setCurrentMatch(null); searchInput.current?.focus(); }}>Clear search</button>}
      </div>
      {query && <div className="agent-transcript-search-options">
        <label>Match <select aria-label="Transcript search mode" value={searchMode} title="Fuzzy accepts abbreviations and small spelling mistakes"
          onChange={(event) => { setSearchMode(event.target.value as TranscriptSearchMode); setCurrentMatch(null); }}>
          <option value="phrase">Exact phrase</option><option value="words">All words</option><option value="fuzzy">Fuzzy</option>
        </select></label>
        <label>Search <select aria-label="Transcript search scope" value={searchScope} onChange={(event) => { setSearchScope(event.target.value as "full" | "loaded"); setCurrentMatch(null); }}>
          <option value="full">Whole transcript</option><option value="loaded">Loaded messages</option>
        </select></label>
        <label>Messages <select aria-label="Transcript search message type" value={searchRole} onChange={(event) => { setSearchRole(event.target.value); setCurrentMatch(null); }}>
          <option value="all">All shown types</option><option value="prompt">Your prompts</option><option value="response">Agent replies</option>
          {showActivity && <><option value="progress">Progress updates</option><option value="tool">Tool activity</option><option value="context">Session context</option></>}
        </select></label>
        <label><input type="checkbox" checked={caseSensitive} onChange={(event) => { setCaseSensitive(event.target.checked); setCurrentMatch(null); }} />Match case</label>
        <label><input type="checkbox" checked={wholeWords} onChange={(event) => { setWholeWords(event.target.checked); setCurrentMatch(null); }} />Whole words</label>
      </div>}
      {query && <p role="status">{loading ? "Loading transcript for search…" : matches.length
        ? `${matchIndex >= 0 ? `${matchIndex + 1} of ` : ""}${matches.length.toLocaleString()} matching ${matches.length === 1 ? "message" : "messages"}`
        : searching ? "Searching messages…" : "No matching messages"}
        {searchScope === "loaded" || (!full && hasLater) ? " · loaded messages" : " · whole transcript"}
        {fullPurpose === "search" || searching ? " · searching the rest…" : ""}
        {fullCancelled && !full && searchScope === "full" && hasLater && <> · full search stopped <button type="button" className="secondary-button"
          onClick={() => void readFull("search")}>Search whole transcript</button></>}
      </p>}
    </div>
    {fullLoading && <p className="agent-transcript-progress" role="status">{fullPurpose === "end" ? "Finding the transcript end" : "Searching the whole transcript"}
      {` · ${transcript.fullCount.toLocaleString()} messages read… `}<button type="button" className="secondary-button" onClick={cancelFull}>Stop loading</button></p>}
    {fullError && <p className="agent-transcript-error" role="alert">{fullError} <button type="button" className="secondary-button" onClick={() => void readFull("search")}>Retry full transcript</button></p>}
    {full?.notices.length ? <p className="agent-transcript-notice" role="status">{full.notices.join(" ")}</p> : null}
    {page?.notice && <p className="agent-transcript-notice" role="status">{page.notice}</p>}
    {error && <p className="agent-transcript-error" role="alert">{error} <button type="button" onClick={refresh}>Refresh</button></p>}
    {exportError && <p className="agent-transcript-error" role="alert">{exportError}</p>}
    <div className="agent-transcript-messages" ref={scroll} aria-label="Transcript messages" tabIndex={0} aria-busy={loading || loadingMore} onScroll={loadAtBottom}>
      {loading && <p role="status">Finding the first saved prompt...</p>}
      {hasEarlier && <button type="button" className="secondary-button agent-transcript-earlier" onClick={earlier}>Load earlier messages</button>}
      {groups.map((group) => group.activity
        ? <details className="agent-transcript-activity" key={group.messages[0].id}>
          <summary>Activity · {group.messages.length} {group.messages.length === 1 ? "entry" : "entries"}</summary>
          {group.messages.map(entry)}
        </details> : entry(group.messages[0]))}
      {!loading && page?.status === "available" && shown.length === 0 && <p>{hasLater
        ? "Still searching this large transcript. Continue to find the first saved prompt."
        : "No prompts or replies were found in this saved conversation. Show activity to inspect other visible records."}</p>}
      {hasLater && <button ref={laterButton} type="button" className="secondary-button" disabled={loadingMore || fullLoading} onClick={() => void loadMore()}>
        {loadingMore ? "Loading..." : shown.length ? "Load later messages" : "Continue searching"}</button>}
      {!loading && page?.status === "available" && !hasLater && messages.length > 0 && <p className="agent-transcript-end">End of saved conversation. Refresh for new messages.</p>}
    </div>
    {!loading && shown.length > 0 && <p className="agent-transcript-range">{full
      ? `Messages ${(transcript.start + 1).toLocaleString()}–${transcript.end.toLocaleString()} of ${full.messages.length.toLocaleString()}`
      : `${shown.length.toLocaleString()} loaded messages${hasLater ? " · later messages available" : ""}`}</p>}
    <div className="agent-transcript-actions">
      <button type="button" className="secondary-button" disabled={!firstPrompt || loading}
        onClick={() => { if (fullPurpose === "end") cancelFull(); jump(firstPrompt?.id); }}>First prompt</button>
      <button type="button" className="secondary-button" disabled={!lastReply || loading}
        onClick={() => { if (fullPurpose === "end") cancelFull(); jump(lastReply?.id); }}>Latest loaded reply</button>
      <button type="button" className="secondary-button" disabled={!shown.length || loading} onClick={() => void copy()}>Copy loaded transcript</button>
      <button type="button" className="secondary-button" disabled={loading || page?.status !== "available" || !page.selectedSource || Boolean(exporting)}
        title="Download all saved messages in this conversation" onClick={() => void exportTranscript("markdown")}>Export Markdown</button>
      <button type="button" className="secondary-button" disabled={loading || page?.status !== "available" || !page.selectedSource || Boolean(exporting)}
        title="Open the full conversation for Print / Save as PDF" onClick={() => void exportTranscript("pdf")}>Export PDF</button>
      {exporting && <button type="button" className="secondary-button" onClick={cancelExport}>Cancel export</button>}
      {onShowScrollback && <button type="button" className="secondary-button" onClick={onShowScrollback}>Terminal scrollback</button>}
      {onShowBeginning && <button type="button" className="secondary-button" onClick={onShowBeginning}>Recorded terminal output</button>}
      <span role="status">{copyStatus}</span>
      <span role="status">{exporting ? `Preparing ${exporting === "pdf" ? "PDF" : "Markdown"} · ${exportCount.toLocaleString()} messages…` : exportStatus}</span>
    </div>
  </section>;
}
