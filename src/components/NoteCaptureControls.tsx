import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { getCommonNotebook, getSessionNotebook, getWorkspaceNotebook, type ScopedNotePage } from "../api";
import {
  captureIdentity, deleteNoteCapture, newCaptureId, openCapturedNote, rememberedCapturePage,
  rememberCapturePage, saveNoteCapture, type NoteCaptureDestination, type NoteCaptureScope,
} from "../noteCaptures";
import type { Session } from "../types";
import { cropCapture, type CaptureRectangle, type TerminalCaptureSnapshot } from "../terminalCapture";
import type { LiveTerminalHandle } from "./LiveTerminal";
import { CloseIcon, MemoIcon } from "../icons";
import { useNoteDialog } from "./useNoteDialog";
import "./NoteCaptures.css";

type Mode = "image" | "both" | "text";
interface PendingCapture { image?: Blob; text: string; id: string; destination: NoteCaptureDestination; source: Session }

export function NoteCaptureControls({ session, workspaceId, terminal, selectedText = "", focus = false }: {
  session: Session; workspaceId: string | null; terminal: RefObject<LiveTerminalHandle | null>;
  selectedText?: string; focus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("image");
  const [scope, setScope] = useState<NoteCaptureScope>("session");
  const [pages, setPages] = useState<ScopedNotePage[]>([]);
  const [pageId, setPageId] = useState("main");
  const [snapshot, setSnapshot] = useState<TerminalCaptureSnapshot | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [rectangle, setRectangle] = useState<CaptureRectangle | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ id: string; destination: NoteCaptureDestination } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef<PendingCapture | null>(null);
  const source = useRef(session);
  const generation = useRef(0);
  const dialog = useNoteDialog(open, cancel);
  const identity = captureIdentity(session);
  const target = scope === "common" ? "common" : scope === "workspace" ? workspaceId || "" : source.current.name;

  useEffect(() => {
    generation.current += 1;
    setOpen(false); setNotice(null); setBusy(false);
  }, [identity, workspaceId]);
  useEffect(() => () => { generation.current += 1; }, []);

  useEffect(() => {
    if (!open || !target) return;
    const controller = new AbortController();
    setPages([]); setError("");
    const request = scope === "common" ? getCommonNotebook(controller.signal)
      : scope === "workspace" ? getWorkspaceNotebook(target, controller.signal)
      : getSessionNotebook(target, controller.signal);
    void request.then((notebook) => {
      if (controller.signal.aborted) return;
      setPages(notebook.pages);
      const preferred = rememberedCapturePage(scope, target);
      setPageId(notebook.pages.find((page) => page.id === preferred)?.id ?? notebook.pages[0].id);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load note pages");
    });
    return () => controller.abort();
  }, [open, scope, target]);

  useEffect(() => {
    if (!open || mode === "text" || snapshot) return;
    let cancelled = false;
    setBusy(true);
    const request = terminal.current?.capture() ?? Promise.reject(new Error("Terminal is not ready to capture"));
    void request.then((value) => {
      if (cancelled) return;
      setSnapshot(value); setImageUrl(value.canvas.toDataURL("image/png")); setBusy(false);
    }).catch((failure: unknown) => {
      if (!cancelled) { setError(failure instanceof Error ? failure.message : "Unable to capture this terminal"); setBusy(false); }
    });
    return () => { cancelled = true; };
  }, [open, mode, snapshot, terminal]);

  const begin = (nextMode: Mode) => {
    generation.current += 1;
    source.current = session;
    pending.current = null;
    setBusy(false); start.current = null;
    setSnapshot(null); setImageUrl(""); setRectangle(null); setError("");
    setText(selectedText); setMode(nextMode); setOpen(true);
    try {
      const saved = localStorage.getItem(`muxdeck.capture-scope:${workspaceId || session.name}`);
      setScope(saved === "common" || (saved === "workspace" && workspaceId) ? saved : "session");
    } catch { setScope("session"); }
  };
  function cancel() {
    generation.current += 1;
    setOpen(false); setBusy(false); pending.current = null; start.current = null;
  }
  const save = async (area?: CaptureRectangle, retry = false) => {
    if (busy || !pages.length) return;
    const currentGeneration = generation.current;
    setBusy(true); setError("");
    try {
      let operation = retry ? pending.current : null;
      if (!operation) {
        const destination = { scope, target, pageId };
        const captureSource = source.current;
        let image: Blob | undefined;
        let capturedText = text;
        if (mode !== "text") {
          if (!snapshot || !area) throw new Error("Select a region to capture");
          image = await cropCapture(snapshot, area);
          capturedText = mode === "both" ? snapshot.textForArea(area) : "";
        }
        if (generation.current !== currentGeneration) return;
        operation = { image, text: capturedText, id: newCaptureId(), destination, source: captureSource };
        pending.current = operation;
      }
      const capture = await saveNoteCapture(operation.destination, operation.source, operation.text, operation.image, operation.id);
      if (generation.current !== currentGeneration) return;
      rememberCapturePage(operation.destination);
      try { localStorage.setItem(`muxdeck.capture-scope:${workspaceId || session.name}`, operation.destination.scope); } catch { /* optional */ }
      setNotice({ id: capture.id, destination: operation.destination });
      setOpen(false); setSnapshot(null); setImageUrl("");
    } catch (failure) {
      if (generation.current === currentGeneration) setError(failure instanceof Error ? failure.message : "Capture could not be saved");
    } finally { if (generation.current === currentGeneration) setBusy(false); }
  };
  const point = (event: PointerEvent) => {
    const box = frame.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(snapshot!.width, (event.clientX - box.left) / box.width * snapshot!.width)),
      y: Math.max(0, Math.min(snapshot!.height, (event.clientY - box.top) / box.height * snapshot!.height)) };
  };
  const areaAt = (event: PointerEvent): CaptureRectangle => {
    const end = point(event); const first = start.current!;
    return { x: Math.min(first.x, end.x), y: Math.min(first.y, end.y),
      width: Math.abs(first.x - end.x), height: Math.abs(first.y - end.y) };
  };
  return <>
    <button type="button" className={focus ? "desktop-terminal-focus-input" : "key-button"}
      aria-label="Capture to notes" title="Capture a screenshot or selected text into a sticky note"
      onMouseDown={(event) => event.preventDefault()} onClick={() => begin("image")}><MemoIcon /><span>Capture</span></button>
    {selectedText && <button type="button" className={focus ? "desktop-terminal-focus-input" : "key-button"}
      aria-label="Add selected text to note" onMouseDown={(event) => event.preventDefault()}
      onClick={() => begin("text")}>＋ Text</button>}
    {notice && createPortal(<aside className="note-capture-toast" role="status">
      Saved to {notice.destination.scope === "common" ? "Global" : notice.destination.scope} note
      <button type="button" onClick={() => openCapturedNote(notice.destination)}>Open note</button>
      <button type="button" onClick={() => void deleteNoteCapture(notice.id).then(() => setNotice(null)).catch((failure: Error) => setError(failure.message))}>Undo</button>
      <button type="button" aria-label="Dismiss capture notification" onClick={() => setNotice(null)}>×</button>
    </aside>, document.body)}
    {open && createPortal(<section ref={dialog} tabIndex={-1} className="note-capture-overlay" role="dialog" aria-label="Capture to notes" aria-modal="true"
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") cancel(); }}
      onKeyUp={(event) => event.stopPropagation()}>
      <div className="note-capture-toolbar">
        <strong>Capture to notes</strong>
        <label>Format<select aria-label="Capture format" value={mode} disabled={busy} onChange={(event) => {
          setMode(event.target.value as Mode); setRectangle(null); pending.current = null;
        }}><option value="image">Screenshot</option><option value="both">Screenshot + original text</option><option value="text">Selected text</option></select></label>
        <span>→</span><label>Note<select aria-label="Capture note scope" value={scope} disabled={busy} onChange={(event) => {
          setScope(event.target.value as NoteCaptureScope); pending.current = null;
        }}><option value="session">Session</option><option value="workspace" disabled={!workspaceId}>Workspace</option><option value="common">Global</option></select></label>
        <label>Page<select aria-label="Capture note page" value={pageId} disabled={busy || !pages.length}
          onChange={(event) => { setPageId(event.target.value); pending.current = null; }}>
          {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
        <button type="button" aria-label="Cancel note capture" onClick={cancel}><CloseIcon /></button>
      </div>
      {error && <p className="note-capture-error" role="alert">{error} {pending.current && <button disabled={busy} type="button" onClick={() => void save(undefined, true)}>Retry</button>}</p>}
      {mode === "text" ? <div className="note-capture-text-preview">
        <textarea aria-label="Text to capture" value={text} onChange={(event) => setText(event.target.value)} placeholder="Select terminal text, or paste it here" />
        <button type="button" disabled={busy || !text.trim() || !pages.length} onClick={() => void save()}>Add text to note</button>
      </div> : <>
        <p>{busy ? "Preparing / saving capture…" : "Drag a rectangle to save it. The terminal keeps running."}</p>
        {snapshot && <div className="note-capture-frame" ref={frame}
          onPointerDown={(event) => { if (busy || !pages.length || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); setRectangle(null); }}
          onPointerMove={(event) => { if (start.current) setRectangle(areaAt(event)); }}
          onPointerCancel={() => { start.current = null; setRectangle(null); }}
          onPointerUp={(event) => { if (!start.current) return; const area = areaAt(event); start.current = null;
            setRectangle(area); if (area.width >= 4 && area.height >= 4) void save(area); }}>
          <img src={imageUrl} alt="Frozen terminal view for cropping" draggable={false} />
          {rectangle && <span className="note-capture-rectangle" style={{ left: `${rectangle.x / snapshot.width * 100}%`,
            top: `${rectangle.y / snapshot.height * 100}%`, width: `${rectangle.width / snapshot.width * 100}%`,
            height: `${rectangle.height / snapshot.height * 100}%` }} />}
        </div>}
        <button type="button" disabled={!snapshot || busy || !pages.length} onClick={() => snapshot && void save({ x: 0, y: 0, width: snapshot.width, height: snapshot.height })}>Capture visible pane</button>
      </>}
    </section>, document.body)}
  </>;
}
