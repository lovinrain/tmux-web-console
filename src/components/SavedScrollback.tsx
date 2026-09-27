import { useEffect, useRef, useState } from "react";
import { loadSavedScrollback, type SavedScrollbackTarget } from "../api";
import { RefreshIcon } from "../icons";
import type { SavedScrollbackPage, SavedScrollbackPart } from "../types";
import "./SavedScrollback.css";

interface Props {
  target: SavedScrollbackTarget;
  /** A fixed region for the live pane's Beginning tab. History offers both. */
  part?: SavedScrollbackPart;
}

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString();

export function SavedScrollback(props: Props) {
  const key = "paneId" in props.target
    ? `${props.target.paneId}:${props.target.identity ?? ""}` : props.target.historyId;
  return <SavedScrollbackContent key={key} {...props} />;
}

function SavedScrollbackContent({ target, part: fixedPart }: Props) {
  const [choice, setChoice] = useState<SavedScrollbackPart>("beginning");
  const part = fixedPart ?? choice;
  const [savedPane, setSavedPane] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SavedScrollbackPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<HTMLPreElement>(null);
  const paneId = "paneId" in target ? target.paneId : undefined;
  const identity = "paneId" in target ? target.identity : undefined;
  const historyId = "historyId" in target ? target.historyId : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCopyError(null);
    setCopied(false);
    const source: SavedScrollbackTarget = paneId !== undefined
      ? { paneId, identity } : { historyId: historyId! };
    void loadSavedScrollback(source, part, savedPane, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load saved output");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [paneId, identity, historyId, part, savedPane, revision]);

  useEffect(() => {
    if (!loading && scroll.current) {
      scroll.current.scrollTop = part === "recent" ? scroll.current.scrollHeight : 0;
    }
  }, [loading, page, part]);

  const visible = !loading && !error && page?.part === part
    && (savedPane === null || page.selectedPane === savedPane) ? page : null;
  const refresh = () => setRevision((value) => value + 1);
  const copy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(visible!.lines.join("\n"));
      setCopied(true);
    } catch {
      setCopyError("Unable to copy. Select the output text to copy it manually.");
    }
  };

  return <section className="saved-scrollback" aria-label="Saved scrollback">
    <div className="saved-scrollback-controls">
      {!fixedPart && <label>Output
        <select aria-label="Output" value={part} onChange={(event) => setChoice(event.target.value as SavedScrollbackPart)}>
          <option value="beginning">Beginning</option><option value="recent">Recent</option>
        </select>
      </label>}
      {(page?.panes.length ?? 0) > 1 && <label>Saved pane
        <select aria-label="Saved pane" value={savedPane ?? page?.selectedPane ?? ""} onChange={(event) => setSavedPane(event.target.value)}>
          {page?.panes.map((pane) => <option key={pane.id} value={pane.id}>{pane.paneId} · {date(pane.firstCapturedAt)}</option>)}
        </select>
      </label>}
      <button type="button" className="icon-button" aria-label="Refresh saved scrollback" disabled={loading} onClick={refresh}><RefreshIcon /></button>
    </div>
    <p className="saved-scrollback-description">{part === "beginning"
      ? "The earliest output Muxdeck saved. Output already lost before recording began is unavailable."
      : "The most recently saved output. Output between the beginning and recent sections may be omitted."}
      {" "}Submitted messages are kept separately, including input from the omitted middle.</p>
    {page?.firstCapturedAt != null && <p className="saved-scrollback-meta">
      Recording began {date(page.firstCapturedAt)}{visible?.capturedAt != null && <> · Saved {date(visible.capturedAt)}</>}
    </p>}
    {visible?.limited && <p className="saved-scrollback-meta">This section reached its saved output limit.</p>}
    {error && <p role="alert" className="saved-scrollback-error">{error} <button type="button" onClick={refresh}>Retry</button></p>}
    {copyError && <p role="alert" className="saved-scrollback-error">{copyError}</p>}
    <div className="saved-scrollback-content" aria-busy={loading}>
      {loading && <p role="status">Loading saved output...</p>}
      {visible && (visible.lines.length
        ? <pre ref={scroll} tabIndex={0} aria-label={`${part === "beginning" ? "Beginning" : "Recent"} output`}>{visible.lines.join("\n")}</pre>
        : <p>No output was saved for this pane yet.</p>)}
    </div>
    <div className="saved-scrollback-actions">
      <button type="button" className="secondary-button" disabled={!visible?.lines.length} onClick={() => void copy()}>Copy saved output</button>
      <div>
        <button type="button" className="secondary-button" disabled={!visible?.lines.length}
          onClick={() => { if (scroll.current) scroll.current.scrollTop = 0; }}>Top</button>
        <button type="button" className="secondary-button" disabled={!visible?.lines.length}
          onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>Bottom</button>
      </div>
      <span role="status">{copied ? "Copied" : ""}</span>
    </div>
  </section>;
}
