import {
  loadAgentTranscript,
  type AgentTranscriptMessage,
  type AgentTranscriptSource,
  type SavedScrollbackTarget,
} from "./api";
import { agentDisplayLabel, type RecoveryAgentType } from "./agentResume";

export type TranscriptView = "conversation" | "all";

export interface TranscriptExport {
  source: AgentTranscriptSource;
  messages: AgentTranscriptMessage[];
  view: TranscriptView;
  notices: string[];
  exportedAt: number;
}

// Export stays in browser memory. Bounds include activity and metadata-only
// pages; reaching a limit fails explicitly instead of saving an incomplete file.
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_EXPORT_MESSAGES = 50_000;
export const MAX_EXPORT_PAGES = 2_000;

export async function collectTranscript(
  target: SavedScrollbackTarget,
  source: string,
  view: TranscriptView,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<TranscriptExport> {
  const messages: AgentTranscriptMessage[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const notices = new Set<string>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let cursor: string | null = null;
  let selected: AgentTranscriptSource | undefined;
  for (let pages = 0; pages < MAX_EXPORT_PAGES; pages++) {
    signal.throwIfAborted();
    const page = await loadAgentTranscript(target, source, cursor, signal, view);
    signal.throwIfAborted();
    if (page.status !== "available") throw new Error(page.notice || "The transcript is no longer available. Refresh and try again.");
    if (page.selectedSource !== source) throw new Error("The selected conversation changed. Refresh and try again.");
    selected ??= page.sources.find((item) => item.key === source);
    if (!selected) throw new Error("The selected conversation could not be identified.");
    if (page.notice) notices.add(page.notice);
    if (page.partial) notices.add("Some native records could not be read or were too large. This export may be incomplete.");
    for (const message of page.messages) {
      if (ids.has(message.id)) continue;
      bytes += encoder.encode(message.text).byteLength;
      if (bytes > MAX_EXPORT_BYTES || messages.length >= MAX_EXPORT_MESSAGES) {
        throw new Error("This conversation exceeds the export limit (32 MiB or 50,000 messages). No incomplete file was saved.");
      }
      ids.add(message.id);
      messages.push(message);
      if (message.truncated) notices.add("Long entries were shortened and are marked individually.");
    }
    onProgress(messages.length);
    if (!page.nextCursor) return { source: selected, messages, notices: [...notices], view, exportedAt: Date.now() };
    if (cursors.has(page.nextCursor)) throw new Error("Transcript paging stopped advancing. Refresh and try again.");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("The transcript exceeded the export scan limit. No incomplete file was saved.");
}

export function transcriptKind(message: AgentTranscriptMessage) {
  return message.kind ?? (message.role === "user" ? "prompt" : message.role === "tool" ? "tool" : "response");
}

export function transcriptRole(message: AgentTranscriptMessage, source: AgentTranscriptSource): string {
  return {
    prompt: "You",
    response: agentDisplayLabel(source.agentType as RecoveryAgentType),
    progress: "Progress update",
    tool: "Tool activity",
    context: "Session context",
  }[transcriptKind(message)];
}

export function transcriptTimestamp(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function markdownLabel(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>#|~]/g, "\\$&");
}

function literalBlock(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export function transcriptMarkdown(transcript: TranscriptExport, title: string): string {
  const lines = [
    `# ${markdownLabel(title || "Session transcript")}`, "",
    `- Agent: ${markdownLabel(agentDisplayLabel(transcript.source.agentType as RecoveryAgentType))}`,
    `- Conversation: ${markdownLabel(transcript.source.agentSessionId || "Not recorded")}`,
    `- Exported: ${transcriptTimestamp(transcript.exportedAt)} (UTC)`,
    `- Scope: ${transcript.view === "all" ? "Prompts, replies and activity" : "Prompts and replies"}`,
    `- Messages: ${transcript.messages.length}`, "",
    "All saved messages in the selected conversation at export start. Later messages require a new export.", "",
  ];
  for (const notice of transcript.notices) lines.push(`> Export notice: ${markdownLabel(notice)}`, "");
  for (const message of transcript.messages) {
    lines.push("---", "", `## ${markdownLabel(transcriptRole(message, transcript.source))}`, "");
    const timestamp = transcriptTimestamp(message.timestamp);
    if (timestamp) lines.push(`_${timestamp} (UTC)_`, "");
    const activity = !["prompt", "response"].includes(transcriptKind(message));
    lines.push(activity ? literalBlock(message.text) : message.text, "");
    if (message.truncated) lines.push("> This long entry was shortened.", "");
  }
  return lines.join("\n");
}

export function transcriptFilename(title: string, source: AgentTranscriptSource): string {
  const safe = (text: string) => text.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 120);
  return `${safe(title) || "session-transcript"}-${safe(source.agentType)}-${safe(source.agentSessionId || "conversation").slice(0, 12)}`;
}

export function downloadTranscriptMarkdown(transcript: TranscriptExport, title: string): void {
  const blob = new Blob([transcriptMarkdown(transcript, title)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${transcriptFilename(title, transcript.source)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  // Let the browser consume the download before releasing its backing storage.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
