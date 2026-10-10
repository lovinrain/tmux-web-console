import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown from "./TranscriptMarkdown";
import {
  transcriptFilename,
  transcriptKind,
  transcriptRole,
  transcriptTimestamp,
  type TranscriptExport,
} from "../transcriptExport";

const printStyles = `
@page { margin: 16mm; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 28px; max-width: 980px; color: #17212b; background: white; font: 14px/1.6 system-ui, sans-serif; overflow-wrap: anywhere; }
h1 { font-size: 24px; line-height: 1.3; margin: 0 0 12px; }
h2 { font-size: 17px; }
header { border-bottom: 2px solid #64748b; padding-bottom: 18px; margin-bottom: 24px; }
header p { margin: 4px 0; }
article { border-top: 1px solid #cbd5e1; padding: 16px 0; }
.message-heading { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; margin: 0 0 12px; }
.message-heading h2 { margin: 0; }
time, .export-meta { color: #475569; font-size: 12px; }
.notice { padding: 10px 12px; background: #fff7db; border: 1px solid #d7bd66; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; padding: 12px; border: 1px solid #cbd5e1; font: 12px/1.6 ui-monospace, monospace; }
code { font-family: ui-monospace, monospace; }
blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid #64748b; }
a { color: #075985; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; }
th, td { text-align: left; border: 1px solid #94a3b8; padding: 6px; overflow-wrap: anywhere; }
img { display: none; }
.screen-controls { position: sticky; top: 0; padding: 12px 0; background: white; border-bottom: 1px solid #cbd5e1; }
button { padding: 10px 16px; border: 1px solid #64748b; border-radius: 6px; background: #f1f5f9; color: #17212b; font: inherit; cursor: pointer; }
@media print {
  body { max-width: none; padding: 0; font-size: 11pt; }
  .screen-controls { display: none; }
  h1, h2, .message-heading { break-after: avoid; }
  pre, blockquote, tr { break-inside: avoid; }
  .notice { background: white; }
}
`;

export function writeTranscriptPrint(popup: Window, transcript: TranscriptExport, title: string): void {
  if (popup.closed) throw new Error("The PDF window was closed. Open the export again.");
  const html = renderToStaticMarkup(<main>
    <div className="screen-controls"><button type="button" id="print-transcript">Print / Save as PDF</button>
      <p>Choose “Save as PDF” in the print dialog.</p></div>
    <header><h1>{title || "Session transcript"}</h1>
      <p className="export-meta">Conversation: {transcript.source.agentSessionId || "Not recorded"}</p>
      <p className="export-meta">Exported {transcriptTimestamp(transcript.exportedAt)} (UTC) · {transcript.messages.length.toLocaleString()} messages</p>
      <p>{transcript.view === "all" ? "Prompts, replies and activity" : "Prompts and replies"} · All saved messages at export start.</p>
      {transcript.notices.map((notice) => <p className="notice" key={notice}>{notice}</p>)}
    </header>
    {transcript.messages.map((message) => <article key={message.id}>
      <div className="message-heading"><h2>{transcriptRole(message, transcript.source)}</h2>
        {transcriptTimestamp(message.timestamp) && <time>{transcriptTimestamp(message.timestamp)} (UTC)</time>}</div>
      {["prompt", "response"].includes(transcriptKind(message))
        ? <TranscriptMarkdown text={message.text} /> : <pre>{message.text}</pre>}
      {message.truncated && <p className="notice">This long entry was shortened.</p>}
    </article>)}
  </main>);
  const doc = popup.document;
  doc.open();
  doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Session transcript</title></head><body></body></html>');
  doc.close();
  doc.title = transcriptFilename(title, transcript.source);
  const style = doc.createElement("style");
  style.textContent = printStyles;
  doc.head.append(style);
  // The only HTML inserted here is React's escaped static output with the same
  // skipHtml/no-image Markdown renderer used by the transcript dialog.
  doc.body.innerHTML = html;
  doc.getElementById("print-transcript")?.addEventListener("click", () => popup.print());
}
