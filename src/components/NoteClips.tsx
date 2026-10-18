import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCommonNotebook, listSessions, getSessionNotebook, getWorkspaceNotebook } from "../api";
import {
  NOTE_CAPTURES_CHANGED, captureImageUrl, cleanEndedNoteImages, deleteNoteCapture,
  extractCaptureText, getNoteCaptureStorage, listNoteCaptures, noteImageBytes,
  rememberedCapturePage, saveNoteCapture, updateNoteCapture,
  type NoteCapture, type NoteCaptureDestination, type NoteCaptureScope, type NoteCaptureStorage,
} from "../noteCaptures";
import { CloseIcon } from "../icons";
import { useNoteDialog } from "./useNoteDialog";
import "./NoteCaptures.css";

export function useNoteStorage(active: boolean) {
  const [storage, setStorage] = useState<NoteCaptureStorage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const load = () => {
      if (document.hidden) return;
      controller?.abort(); controller = new AbortController();
      const current = controller;
      void getNoteCaptureStorage(current.signal).then((value) => {
        if (!disposed && !current.signal.aborted) { setStorage(value); setError(""); }
      }).catch((failure: unknown) => {
        if (!disposed && !current.signal.aborted) setError(failure instanceof Error ? failure.message : "Image storage unavailable");
      });
    };
    load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener(NOTE_CAPTURES_CHANGED, load);
    document.addEventListener("visibilitychange", load);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener(NOTE_CAPTURES_CHANGED, load); document.removeEventListener("visibilitychange", load); };
  }, [active]);
  return { storage, error };
}

export function NoteStorageButton({ storage, error }: { storage: NoteCaptureStorage | null; error: string }) {
  const [open, setOpen] = useState(false);
  const [cleanupIds, setCleanupIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const dialog = useNoteDialog(open, () => { setOpen(false); setCleanupIds(null); });
  const summary = storage?.summary;
  const candidates = storage?.captures.filter((item) => item.sourceEndedAt !== null && !item.kept) ?? [];
  const usage = summary ? `${noteImageBytes(summary.usedBytes)} / ${noteImageBytes(summary.limitBytes)}` : "Loading image usage";
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure("");
    try { await action(); setCleanupIds(null); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : "Storage action failed"); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`note-storage-button ${error ? "critical" : summary?.warning || "normal"}`}
      aria-label="Manage note image storage" title={error || `${usage}; ${summary?.endedImageCount ?? 0} images from ended sessions`}
      onClick={() => setOpen(true)}>
      <span aria-hidden="true">{error || summary?.warning !== "normal" && summary ? "⚠" : "▧"}</span>
      <span>{summary?.endedImageCount ? `${summary.endedImageCount} ended` : summary ? noteImageBytes(summary.usedBytes) : "Images"}</span>
    </button>
    {open && createPortal(<section className="note-storage-backdrop" onKeyDown={(event) => {
      event.stopPropagation(); if (event.key === "Escape") setOpen(false);
    }} onKeyUp={(event) => event.stopPropagation()}>
      <section ref={dialog} tabIndex={-1} className="note-storage-panel" role="dialog" aria-label="Note image storage" aria-modal="true">
        <header><h2>Note image storage</h2><button type="button" aria-label="Close note image storage" onClick={() => { setOpen(false); setCleanupIds(null); }}><CloseIcon /></button></header>
        {(error || failure) && <p className="note-capture-error" role="alert">{failure || error}</p>}
        <strong>{usage}</strong>
        {summary && <meter min={0} max={summary.limitBytes} value={summary.usedBytes} aria-label="Note image storage usage" />}
        <p>Images from ended sessions expire after {summary?.retentionDays ?? 7} days unless marked Keep. Text remains.
          Removing a note page removes its captures. Image storage warns at 80% and becomes critical at 95%.</p>
        <p>{summary?.endedImageCount ?? 0} images from ended sessions · {noteImageBytes(summary?.endedBytes ?? 0)}.
          {summary?.unreferencedBytes ? ` ${noteImageBytes(summary.unreferencedBytes)} of interrupted uploads will clear after a one-hour grace period.` : ""}</p>
        {cleanupIds ? <div className="note-storage-confirm">
          Delete images for {cleanupIds.length} ended captures? Their text stays.
          <button type="button" disabled={busy} onClick={() => void perform(() => cleanEndedNoteImages(cleanupIds))}>Delete ended images</button>
          <button type="button" onClick={() => setCleanupIds(null)}>Cancel</button>
        </div> : candidates.length > 0 && <button type="button" disabled={busy}
          onClick={() => setCleanupIds(candidates.map((item) => item.id))}>Review cleanup of {candidates.length} ended images</button>}
        <div className="note-storage-list">
          {storage?.captures.map((item) => <article key={item.id}>
            <div><strong>{item.sourceSession}</strong><small>{item.scope === "common" ? "Global" : item.scope} · {noteImageBytes(item.imageBytes)}</small>
              <small>{item.sourceEndedAt === null ? "Source session active" : item.kept ? "Source ended · Kept" : `Source ended · Expires ${new Date(item.expiresAt! * 1000).toLocaleDateString()}`}</small></div>
            <button type="button" disabled={busy} onClick={() => void perform(() => updateNoteCapture(item, { kept: !item.kept }))}>{item.kept ? "Stop keeping" : "Keep"}</button>
            <button type="button" disabled={busy} onClick={() => void perform(() => deleteNoteCapture(item.id, true))}>Delete image</button>
          </article>)}
          {storage?.captures.length === 0 && <p>No stored note images.</p>}
          {storage?.captures.length === 200 && <p>Showing the 200 largest images. Removing these reveals the next entries.</p>}
        </div>
      </section>
    </section>, document.body)}
  </>;
}

function MoveCapture({ capture, sourceSessionName, workspaceId, onMove, onCancel }: {
  capture: NoteCapture; sourceSessionName: string; workspaceId: string | null;
  onMove: (changes: NoteCaptureDestination) => Promise<void>; onCancel: () => void;
}) {
  const [scope, setScope] = useState<NoteCaptureScope>(capture.scope);
  const [pages, setPages] = useState<Array<{ id: string; name: string }>>([]);
  const [pageId, setPageId] = useState(capture.pageId);
  const [error, setError] = useState("");
  const target = scope === "common" ? "common" : scope === "workspace" ? workspaceId || "" : sourceSessionName;
  useEffect(() => {
    const controller = new AbortController(); setPages([]);
    const request = scope === "common" ? getCommonNotebook(controller.signal)
      : scope === "workspace" ? getWorkspaceNotebook(target, controller.signal) : getSessionNotebook(target, controller.signal);
    void request.then((notebook) => { if (controller.signal.aborted) return;
      setPages(notebook.pages); setPageId(notebook.pages.find((page) => page.id === rememberedCapturePage(scope, target))?.id ?? notebook.pages[0].id);
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [scope, target]);
  return <div className="note-clip-move">
    <select aria-label="Move capture to scope" value={scope} onChange={(event) => setScope(event.target.value as NoteCaptureScope)}>
      <option value="common">Global</option><option value="workspace" disabled={!workspaceId}>Workspace</option><option value="session">Session</option>
    </select>
    <select aria-label="Move capture to page" value={pageId} onChange={(event) => setPageId(event.target.value)}>
      {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select>
    <button type="button" disabled={!pages.length} onClick={() => void onMove({ scope, target, pageId })}>Move</button>
    <button type="button" onClick={onCancel}>Cancel</button>{error && <span role="alert">{error}</span>}
  </div>;
}

function CaptureCard({ capture, sourceSessionName, workspaceId }: {
  capture: NoteCapture; sourceSessionName: string; workspaceId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const editRevision = useRef(capture.revision);
  const captionRevision = useRef(capture.revision);
  const [moving, setMoving] = useState(false);
  const [text, setText] = useState(capture.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!editing) setText(capture.text); }, [capture.text, editing]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Capture action failed"); }
    finally { setBusy(false); }
  };
  return <article className={`note-clip ${capture.sourceEndedAt !== null && capture.imageBytes ? "source-ended" : ""}`}>
    <header><span>{capture.sourceSession} · {new Date(capture.createdAt * 1000).toLocaleString()}</span>
      {capture.sourceEndedAt === null && <a href={`${import.meta.env.BASE_URL}session/${encodeURIComponent(capture.sourceSession)}`} target="_blank" rel="noopener noreferrer">Open session</a>}</header>
    {capture.imageBytes > 0 && <a href={captureImageUrl(capture)} target="_blank" rel="noopener noreferrer" title="Open full-size capture">
      <img src={`${captureImageUrl(capture)}&thumbnail=true`} alt={capture.caption || `Capture from ${capture.sourceSession}`} loading="lazy" /></a>}
    {capture.imageExpiredAt !== null && !capture.imageBytes && <p className="note-clip-expired">Image removed · {new Date(capture.imageExpiredAt * 1000).toLocaleDateString()}. Saved text remains below.</p>}
    {capture.sourceEndedAt !== null && capture.imageBytes > 0 && <p className="note-clip-warning">
      Source ended · {capture.kept ? "Kept until you delete it" : `Image expires ${new Date(capture.expiresAt! * 1000).toLocaleDateString()}`}</p>}
    <input aria-label="Capture caption" placeholder="Add a caption…" defaultValue={capture.caption} maxLength={1000}
      onFocus={() => { captionRevision.current = capture.revision; }}
      onBlur={(event) => { if (event.target.value !== capture.caption) void perform(() => updateNoteCapture({ ...capture, revision: captionRevision.current }, { caption: event.target.value })); }} />
    {editing ? <div className="note-clip-edit">
      <textarea aria-label="Capture text" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" disabled={busy} onClick={() => void perform(async () => { await updateNoteCapture({ ...capture, revision: editRevision.current }, { text }); setEditing(false); })}>Save text</button>
      <button type="button" onClick={() => setEditing(false)}>Cancel</button>
    </div> : capture.text && <pre>{capture.text}</pre>}
    {error && <p className="note-capture-error" role="alert">{error}</p>}
    <div className="note-clip-actions">
      {capture.imageBytes > 0 && <>
        <button type="button" disabled={busy} onClick={() => void perform(async () => {
          if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Use Open full-size capture to copy the image in this browser");
          await navigator.clipboard.write([new ClipboardItem({ "image/png": fetch(captureImageUrl(capture)).then(async (response) => {
            if (!response.ok) throw new Error("Image is no longer available"); return response.blob();
          }) })]);
        })}>Copy image</button>
        <button type="button" disabled={busy} onClick={() => void perform(async () => {
          const recognized = await extractCaptureText(capture.id); editRevision.current = capture.revision; setText(recognized); setEditing(true);
        })}>Extract text</button>
        <button type="button" aria-pressed={capture.kept} disabled={busy} onClick={() => void perform(() => updateNoteCapture(capture, { kept: !capture.kept }))}>{capture.kept ? "Kept" : "Keep image"}</button>
      </>}
      {capture.text && <button type="button" onClick={() => void perform(() => navigator.clipboard.writeText(capture.text))}>Copy text</button>}
      {!editing && <button type="button" onClick={() => { editRevision.current = capture.revision; setEditing(true); }}>Edit text</button>}
      <button type="button" onClick={() => setMoving(!moving)}>Move…</button>
      <button type="button" disabled={busy} onClick={() => void perform(() => deleteNoteCapture(capture.id))}>Delete capture</button>
    </div>
    {moving && <MoveCapture capture={capture} sourceSessionName={sourceSessionName} workspaceId={workspaceId}
      onMove={async (destination) => { await perform(async () => { await updateNoteCapture(capture, destination); setMoving(false); }); }} onCancel={() => setMoving(false)} />}
  </article>;
}

export function NoteClips({ destination, sourceSessionName, workspaceId }: {
  destination: NoteCaptureDestination; sourceSessionName: string; workspaceId: string | null;
}) {
  const [clips, setClips] = useState<NoteCapture[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const { scope, target, pageId } = destination;
  useEffect(() => { setClips([]); }, [scope, target, pageId]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void listNoteCaptures({ scope, target, pageId }, controller.signal).then((value) => {
      if (!controller.signal.aborted) setClips(value);
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [scope, target, pageId, version]);
  useEffect(() => {
    window.addEventListener(NOTE_CAPTURES_CHANGED, reload);
    const interval = window.setInterval(() => { if (!document.hidden) reload(); }, 30_000);
    return () => { window.removeEventListener(NOTE_CAPTURES_CHANGED, reload); window.clearInterval(interval); };
  }, [reload]);
  const attach = async (files: File[]) => {
    if (busy || !files.length) return;
    setBusy(true); setError("");
    try {
      if (files.length > 8) throw new Error("Attach at most eight images at a time");
      const source = (await listSessions()).find((session) => session.name === sourceSessionName);
      if (!source) throw new Error("Source session ended; open another session before attaching images");
      for (const file of files.slice(0, 8)) {
        if (!file.type.startsWith("image/")) throw new Error("Choose PNG, JPEG or WebP images");
        await saveNoteCapture({ scope, target, pageId }, source, "", file);
      }
      reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Image could not be saved"); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    // The enclosing note canvas includes its textarea, so OS screenshots can be pasted there too.
    const handle = (event: Event) => {
      const custom = event as CustomEvent<{ destination: NoteCaptureDestination; files: File[] }>;
      const candidate = custom.detail.destination;
      if (candidate.scope === scope && candidate.target === target && candidate.pageId === pageId) void attach(custom.detail.files);
    };
    window.addEventListener("muxdeck:note-image-paste", handle);
    return () => window.removeEventListener("muxdeck:note-image-paste", handle);
  });
  return <section className="note-clips" aria-label="Note captures"
    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void attach(Array.from(event.dataTransfer.files)); }}>
    <div className="note-clip-import"><strong>Captures{clips.length ? ` · ${clips.length}` : ""}</strong>
      <label>{busy ? "Saving image…" : "＋ Image"}<input aria-label="Attach image to note" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy}
        onChange={(event) => { void attach(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>
      <small>Paste or drop screenshots here</small></div>
    {error && <p className="note-capture-error" role="alert">{error}</p>}
    {clips.map((capture) => <CaptureCard key={capture.id} capture={capture} sourceSessionName={sourceSessionName} workspaceId={workspaceId} />)}
  </section>;
}
