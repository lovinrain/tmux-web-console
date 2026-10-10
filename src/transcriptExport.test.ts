import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentTranscript, type AgentTranscriptMessage, type AgentTranscriptPage } from "./api";
import {
  collectTranscript,
  MAX_EXPORT_BYTES,
  transcriptFilename,
  transcriptMarkdown,
  transcriptTimestamp,
  type TranscriptExport,
} from "./transcriptExport";

vi.mock("./api", () => ({ loadAgentTranscript: vi.fn() }));
const source = { key: "codex:conversation", agentType: "codex", agentSessionId: "conversation" };
const message = (id: string, text: string, role: AgentTranscriptMessage["role"] = "user"): AgentTranscriptMessage =>
  ({ id, text, role, timestamp: 0, truncated: false });
const page = (messages: AgentTranscriptMessage[], extra: Partial<AgentTranscriptPage> = {}): AgentTranscriptPage =>
  ({ sources: [source], selectedSource: source.key, messages, status: "available", nextCursor: null, partial: false, notice: null, ...extra });

beforeEach(() => vi.resetAllMocks());

describe("complete transcript export", () => {
  it("starts from the beginning, traverses metadata-only pages, and preserves ordered messages and notices", async () => {
    const first = message("first", "Original prompt");
    const last = { ...message("last", "Unloaded final reply", "assistant"), truncated: true };
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([], { nextCursor: "metadata" }))
      .mockResolvedValueOnce(page([first], { nextCursor: "later", partial: true, notice: "Unreadable record skipped." }))
      .mockResolvedValueOnce(page([first, last]));
    const progress = vi.fn();
    const controller = new AbortController();
    const result = await collectTranscript({ historyId: "history" }, source.key, "all", controller.signal, progress);
    expect(result.messages).toEqual([first, last]);
    expect(result.notices).toContain("Unreadable record skipped.");
    expect(result.notices.join(" ")).toContain("incomplete");
    expect(result.notices.join(" ")).toContain("shortened");
    expect(loadAgentTranscript).toHaveBeenNthCalledWith(1, { historyId: "history" }, source.key, null, controller.signal, "all");
    expect(loadAgentTranscript).toHaveBeenNthCalledWith(3, { historyId: "history" }, source.key, "later", controller.signal, "all");
    expect(progress.mock.calls.map(([count]) => count)).toEqual([0, 1, 2]);
  });

  it("refuses an unavailable or changed source and repeated paging cursors", async () => {
    const collect = () => collectTranscript({ paneId: "%1", identity: "stable" }, source.key, "conversation", new AbortController().signal, vi.fn());
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([], { status: "missing", notice: "Native transcript was removed." }));
    await expect(collect()).rejects.toThrow("Native transcript was removed");
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([], { selectedSource: "other" }));
    await expect(collect()).rejects.toThrow("conversation changed");
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([], { nextCursor: "same" }));
    await expect(collect()).rejects.toThrow("stopped advancing");
  });

  it("honors cancellation after a late request and rejects oversized exports instead of saving a partial file", async () => {
    const controller = new AbortController();
    vi.mocked(loadAgentTranscript).mockImplementationOnce(async () => {
      controller.abort();
      return page([message("late", "Stale response")]);
    });
    const progress = vi.fn();
    await expect(collectTranscript({ historyId: "history" }, source.key, "conversation", controller.signal, progress)).rejects.toHaveProperty("name", "AbortError");
    expect(progress).not.toHaveBeenCalled();
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("huge", "x".repeat(MAX_EXPORT_BYTES + 1))]));
    await expect(collectTranscript({ historyId: "history" }, source.key, "conversation", new AbortController().signal, progress)).rejects.toThrow("export limit");
  });

  it("bounds scanning when a transcript never finishes returning metadata", async () => {
    let cursor = 0;
    vi.mocked(loadAgentTranscript).mockImplementation(async () => page([], { nextCursor: String(++cursor) }));
    await expect(collectTranscript({ historyId: "history" }, source.key, "conversation", new AbortController().signal, vi.fn())).rejects.toThrow("scan limit");
  });
});

describe("transcript Markdown", () => {
  it("keeps Markdown/code, role order, UTC timestamps, and partial notices with literal activity", () => {
    const reply = "## Result\n\n**Done**\n\n```ts\nconst value = 1;\n```";
    const tool = "Tool: inspect\n```\n<dangerous output>";
    const transcript: TranscriptExport = {
      source, view: "all", exportedAt: 0, notices: ["Some records were skipped."],
      messages: [message("first", "My prompt"), message("reply", reply, "assistant"),
        { ...message("tool", tool, "tool"), truncated: true }],
    };
    const output = transcriptMarkdown(transcript, "Research [work]\nTitle");
    expect(output).toContain("# Research \\[work\\] Title");
    expect(output).toContain("- Scope: Prompts, replies and activity");
    expect(output).toContain("1970-01-01T00:00:00.000Z (UTC)");
    expect(output).toContain(reply);
    expect(output).toContain("````text\nTool: inspect\n```\n<dangerous output>\n````");
    expect(output).toContain("Export notice: Some records were skipped.");
    expect(output).toContain("This long entry was shortened.");
    expect(output.indexOf("## You")).toBeLessThan(output.indexOf("## Codex"));
    expect(output.indexOf("## Codex")).toBeLessThan(output.indexOf("## Tool activity"));
    expect(transcriptTimestamp(Number.NaN)).toBeNull();
  });

  it("sanitizes portable names, keeps a conversation discriminator, and bounds title length", () => {
    expect(transcriptFilename('../research:<done>\n', source)).not.toMatch(/[/\\<>:\n]/);
    expect(transcriptFilename("  . ", source)).toBe("session-transcript-codex-conversation");
    expect(transcriptFilename("a".repeat(500), source).length).toBeLessThan(150);
  });
});
