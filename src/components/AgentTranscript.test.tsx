import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentTranscript, type AgentTranscriptMessage, type AgentTranscriptPage } from "../api";
import { AgentTranscript } from "./AgentTranscript";
import { collectTranscript, downloadTranscriptMarkdown } from "../transcriptExport";
import { writeTranscriptPrint } from "./TranscriptPrint";

vi.mock("../api", () => ({ loadAgentTranscript: vi.fn() }));
vi.mock("../transcriptExport", () => ({ collectTranscript: vi.fn(), downloadTranscriptMarkdown: vi.fn() }));
vi.mock("./TranscriptPrint", () => ({ writeTranscriptPrint: vi.fn() }));

const source = { key: "codex:conversation", agentType: "codex", agentSessionId: "conversation" };
const other = { key: "claude:other", agentType: "claude", agentSessionId: "other" };
const message = (id: string, text: string, role: AgentTranscriptMessage["role"] = "user"): AgentTranscriptMessage => ({ id, text, role, timestamp: null, truncated: false });
const page = (messages: AgentTranscriptMessage[], extra: Partial<AgentTranscriptPage> = {}): AgentTranscriptPage => ({
  sources: [source], selectedSource: source.key, status: "available", messages, nextCursor: null, partial: false, notice: null, ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("AgentTranscript", () => {
  it("formats Markdown safely and switches to original text without refetching or altering copies", async () => {
    const markdown = [
      "## Release notes", "", "A **formatted** answer with `inline code`.", "",
      "- First item", "- Second item", "", "```ts", 'const value = "<safe>";', "```", "",
      "| Check | Result |", "| --- | --- |", "| Tests | Passed |", "",
      "[Documentation](https://example.test/docs)", "[Unsafe](javascript:alert%281%29)",
      "![Private image](https://example.test/private.png)", '<script>window.secret = true</script>',
    ].join("\n");
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([message("answer", markdown, "assistant")]));
    render(<AgentTranscript target={{ paneId: "%1" }} />);
    await screen.findByRole("heading", { name: "Release notes", level: 2 });
    expect(screen.getByText("formatted").tagName).toBe("STRONG");
    expect(screen.getByRole("list")).toHaveTextContent("First item");
    expect(screen.getByRole("table")).toHaveTextContent("TestsPassed");
    expect(screen.getByText('const value = "<safe>";').closest("pre")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Unsafe").getAttribute("href")).not.toMatch(/^javascript:/);
    expect(document.querySelector("img, script")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Image: Private image");
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(screen.queryByRole("heading", { name: "Release notes" })).not.toBeInTheDocument();
    expect(document.querySelector(".agent-transcript-plain")?.textContent).toBe(markdown);
    fireEvent.click(screen.getByRole("button", { name: "Copy loaded transcript" }));
    await screen.findByText("Copied");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`Assistant\n${markdown}`);
    fireEvent.click(screen.getByRole("button", { name: "Formatted" }));
    await screen.findByRole("heading", { name: "Release notes" });
    expect(loadAgentTranscript).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search transcript" }), { target: { value: "formatted" } });
    await waitFor(() => expect(document.querySelector("strong mark")).toHaveTextContent("formatted"));
    expect(document.querySelector("img, script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(document.querySelector(".agent-transcript-plain mark")).toHaveTextContent("formatted");
    fireEvent.click(screen.getByRole("button", { name: "Copy loaded transcript" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(`Assistant\n${markdown}`));
  });

  it("pages through prompts and replies, expands activity, and copies selectable text without rendering HTML", async () => {
    const first = message("one", "First request <img src='https://example.test/private'>");
    const answer = { ...message("two", "Answer", "assistant"), kind: "response" as const };
    const progress = { ...message("progress", "Checking things", "assistant"), kind: "progress" as const };
    vi.mocked(loadAgentTranscript).mockImplementation(async (_target, _source, cursor, _signal, view) => (
      view === "all" ? page([first, progress, message("tool", "Tool: test\nPassed", "tool"), answer])
        : cursor ? page([first, answer]) : page([first], { nextCursor: "later" })
    ));
    render(<AgentTranscript target={{ paneId: "%1", identity: "identity" }} />);
    await screen.findByText(/First request/);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByText(/Tool: test/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("Answer");
    expect(loadAgentTranscript).toHaveBeenLastCalledWith({ paneId: "%1", identity: "identity" }, source.key, "later", expect.any(AbortSignal), "conversation");
    expect(screen.getAllByText(/First request/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Copy loaded transcript" }));
    await screen.findByText("Copied");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Assistant\nAnswer"));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining("Checking things"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show activity" }));
    const group = await screen.findByText("Activity · 2 entries", { selector: "summary" });
    expect(screen.getByText("Checking things")).not.toBeVisible();
    fireEvent.click(group);
    expect(screen.getByText("Checking things")).toBeVisible();
    expect(screen.getByText(/Tool: test/)).toBeVisible();
    expect(loadAgentTranscript).toHaveBeenLastCalledWith({ paneId: "%1", identity: "identity" }, null, null, expect.any(AbortSignal), "all");
    fireEvent.click(screen.getByRole("button", { name: "First prompt" }));
    expect(document.activeElement).toHaveAttribute("data-message-id", "one");
    fireEvent.click(screen.getByRole("button", { name: "Latest loaded reply" }));
    expect(document.activeElement).toHaveAttribute("data-message-id", "two");
  });

  it("ignores a late page after switching recorded conversations", async () => {
    let resolveLater!: (value: AgentTranscriptPage) => void;
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("one", "Original chat")], { sources: [source, other], nextCursor: "later" }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLater = resolve; }))
      .mockResolvedValueOnce(page([message("other", "Other conversation")], { sources: [source, other], selectedSource: other.key }));
    render(<AgentTranscript target={{ historyId: "record" }} />);
    await screen.findByText("Original chat");
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    const previousSignal = vi.mocked(loadAgentTranscript).mock.calls[1][3]!;
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript conversation" }), { target: { value: other.key } });
    await screen.findByText("Other conversation");
    expect(previousSignal.aborted).toBe(true);
    await act(async () => resolveLater(page([message("late", "Stale response")])));
    expect(screen.queryByText("Original chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
  });

  it("clears loaded conversation text on a new pane identity and shows an explicit unavailable source", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("one", "Old incarnation")]))
      .mockResolvedValueOnce(page([], { status: "missing", notice: "Transcript file not found." }));
    const view = render(<AgentTranscript target={{ paneId: "%1", identity: "old" }} />);
    await screen.findByText("Old incarnation");
    view.rerender(<AgentTranscript target={{ paneId: "%1", identity: "new" }} />);
    expect(screen.queryByText("Old incarnation")).not.toBeInTheDocument();
    await screen.findByText("Transcript file not found.");
    expect(screen.getByRole("button", { name: "Copy loaded transcript" })).toBeDisabled();
  });

  it("keeps loaded messages on a paging error and refreshes from the beginning", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("one", "Original")], { nextCursor: "later" }))
      .mockRejectedValueOnce(new Error("Transcript rotated. Refresh to retry."))
      .mockResolvedValueOnce(page([message("two", "Refreshed conversation")]));
    render(<AgentTranscript target={{ historyId: "record" }} />);
    await screen.findByText("Original");
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Original")).toBeVisible();
    const viewport = screen.getByLabelText("Transcript messages");
    Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
    viewport.scrollTop = 800;
    fireEvent.scroll(viewport);
    expect(loadAgentTranscript).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh transcript" }));
    await screen.findByText("Refreshed conversation");
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await waitFor(() => expect(loadAgentTranscript).toHaveBeenLastCalledWith({ historyId: "record" }, null, null, expect.any(AbortSignal), "conversation"));
  });

  it("automatically scans metadata-only pages until the first prompt is found", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([], { nextCursor: "metadata" }))
      .mockResolvedValueOnce(page([], { nextCursor: "more-metadata" }))
      .mockResolvedValueOnce(page([message("first", "The real first prompt")]));
    render(<AgentTranscript target={{ paneId: "%1" }} />);
    await screen.findByText("The real first prompt");
    expect(loadAgentTranscript).toHaveBeenCalledTimes(3);
    expect(loadAgentTranscript).toHaveBeenLastCalledWith({ paneId: "%1", identity: undefined }, source.key, "more-metadata", expect.any(AbortSignal), "conversation");
  });

  it("bounds empty-page scanning and offers an explicit continuation", async () => {
    let cursor = 0;
    vi.mocked(loadAgentTranscript).mockImplementation(async () => page([], { nextCursor: `scan-${++cursor}` }));
    render(<AgentTranscript target={{ historyId: "record" }} />);
    await screen.findByText(/Still searching this large transcript/);
    expect(loadAgentTranscript).toHaveBeenCalledTimes(8);
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("first", "First prompt after metadata")]));
    fireEvent.click(screen.getByRole("button", { name: "Continue searching" }));
    await screen.findByText("First prompt after metadata");
  });

  it("auto-loads at the bottom by default without duplicate requests or moving a reader who scrolls away", async () => {
    let finish!: (value: AgentTranscriptPage) => void;
    const first = message("first", "First saved prompt");
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([first], { nextCursor: "later" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentTranscript target={{ paneId: "%1" }} />);
    await screen.findByText("First saved prompt");
    expect(screen.getByRole("checkbox", { name: "Auto-load later messages" })).toBeChecked();
    const viewport = screen.getByLabelText("Transcript messages");
    Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);
    expect(loadAgentTranscript).toHaveBeenCalledOnce();
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);
    expect(loadAgentTranscript).toHaveBeenCalledTimes(2);
    viewport.scrollTop = 100;
    await act(async () => finish(page([first, message("later", "A later reply", "assistant")])));
    expect(screen.getAllByText("First saved prompt")).toHaveLength(1);
    expect(screen.getByText("A later reply")).toBeInTheDocument();
    expect(viewport.scrollTop).toBe(100);
  });

  it("remembers disabling auto-load while retaining manual paging", async () => {
    vi.mocked(loadAgentTranscript).mockImplementation(async (_target, _source, cursor) => cursor
      ? page([message("later", "Manual later reply", "assistant")]) : page([message("first", "First prompt")], { nextCursor: "later" }));
    const first = render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("First prompt");
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-load later messages" }));
    first.unmount();
    render(<AgentTranscript target={{ historyId: "another-history" }} />);
    await screen.findByText("First prompt");
    expect(screen.getByRole("checkbox", { name: "Auto-load later messages" })).not.toBeChecked();
    const viewport = screen.getByLabelText("Transcript messages");
    Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
    viewport.scrollTop = 800;
    fireEvent.scroll(viewport);
    expect(loadAgentTranscript).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("Manual later reply");
    expect(loadAgentTranscript).toHaveBeenCalledTimes(3);
  });

  it("jumps to the full end in a bounded window and distinguishes view edges from transcript edges", async () => {
    const entries = Array.from({ length: 180 }, (_, index) => message(`entry-${index}`, `Entry ${index}`, index ? "assistant" : "user"));
    vi.mocked(loadAgentTranscript).mockResolvedValue(page(entries.slice(0, 2), { nextCursor: "later" }));
    vi.mocked(collectTranscript).mockResolvedValue({ source, messages: entries, view: "conversation", notices: [], exportedAt: 0 });
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("Entry 0");
    fireEvent.click(screen.getByRole("button", { name: "Transcript end" }));
    await screen.findByText("Entry 179");
    expect(document.activeElement).toHaveAttribute("data-message-id", "entry-179");
    expect(screen.queryByText("Entry 0")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".agent-transcript-message")).toHaveLength(60);
    expect(screen.getByText("Messages 121–180 of 180")).toBeInTheDocument();
    const viewport = screen.getByLabelText("Transcript messages");
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "View bottom" }));
    expect(viewport.scrollTop).toBe(5000);
    fireEvent.click(screen.getByRole("button", { name: "View top" }));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByText("Entry 0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("Entry 60");
    fireEvent.click(screen.getByRole("button", { name: "Transcript start" }));
    await screen.findByText("Entry 0");
    expect(document.querySelectorAll(".agent-transcript-message")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("Entry 119");
    fireEvent.click(screen.getByRole("button", { name: "Transcript end" }));
    await screen.findByText("Entry 179");
    expect(collectTranscript).toHaveBeenCalledOnce();
    expect(collectTranscript).toHaveBeenCalledWith({ historyId: "history" }, source.key, "conversation", expect.any(AbortSignal), expect.any(Function), "browse");
  });

  it("searches beyond loaded messages, reveals bounded context, and navigates with Enter and Shift+Enter", async () => {
    const entries = Array.from({ length: 180 }, (_, index) => message(`entry-${index}`, [140, 170].includes(index) ? `Needle result ${index}` : `Entry ${index}`, "assistant"));
    vi.mocked(loadAgentTranscript).mockResolvedValue(page(entries.slice(0, 2), { nextCursor: "later" }));
    vi.mocked(collectTranscript).mockResolvedValue({ source, messages: entries, view: "conversation", notices: [], exportedAt: 0 });
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("Entry 0");
    const input = screen.getByRole("searchbox", { name: "Search transcript" });
    fireEvent.keyDown(screen.getByLabelText("Transcript messages"), { key: "f", ctrlKey: true });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "needle" } });
    await screen.findByText("2 matching messages · whole transcript");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector('[data-message-id="entry-140"]')).toHaveAttribute("data-search-current", "true"));
    expect(screen.getByText("1 of 2 matching messages · whole transcript")).toBeInTheDocument();
    expect(document.querySelector('[data-message-id="entry-140"] mark')).toHaveTextContent("Needle");
    expect(document.querySelectorAll(".agent-transcript-message")).toHaveLength(60);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(document.querySelector('[data-message-id="entry-170"]')).toHaveAttribute("data-search-current", "true"));
    expect(screen.getByText("2 of 2 matching messages · whole transcript")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.querySelector("mark")).toBeNull();
    expect(document.querySelector('[data-search-current="true"]')).toBeNull();
    expect(collectTranscript).toHaveBeenCalledOnce();
  });

  it("wires fuzzy and type filters and opens collapsed activity for a matching result", async () => {
    const entries = [message("prompt", "Please deploy"), { ...message("tool", "Missing deployment flag", "tool"), kind: "tool" as const }, message("reply", "Deploy the new release", "assistant")];
    vi.mocked(loadAgentTranscript).mockImplementation(async (_target, _source, _cursor, _signal, view) => page(view === "all" ? entries : [entries[0], entries[2]]));
    render(<AgentTranscript target={{ paneId: "%1" }} />);
    await screen.findByText("Please deploy");
    const input = screen.getByRole("searchbox", { name: "Search transcript" });
    fireEvent.change(input, { target: { value: "dply" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript search mode" }), { target: { value: "fuzzy" } });
    expect(screen.getByText("2 matching messages · whole transcript")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript search message type" }), { target: { value: "response" } });
    expect(screen.getByText("1 matching message · whole transcript")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(document.querySelector('[data-message-id="reply"]')).toHaveAttribute("data-search-current", "true");
    expect(document.querySelector('[data-message-id="prompt"] mark')).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show activity" }));
    await screen.findByText("Activity · 1 entry", { selector: "summary" });
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript search message type" }), { target: { value: "tool" } });
    expect(document.querySelector(".agent-transcript-activity")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(document.querySelector(".agent-transcript-activity")).toHaveAttribute("open");
    expect(document.querySelector('[data-message-id="tool"] mark')).toHaveTextContent("Missing");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show activity" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Transcript search message type" })).toHaveValue("all"));
  });

  it.each(["stop", "source switch"])("ignores late full-transcript results after %s", async (action) => {
    let finish!: (value: Awaited<ReturnType<typeof collectTranscript>>) => void;
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("first", "Original conversation")], { sources: [source, other], nextCursor: "later" }))
      .mockResolvedValueOnce(page([message("other", "Other conversation")], { sources: [source, other], selectedSource: other.key }));
    vi.mocked(collectTranscript).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("Original conversation");
    fireEvent.click(screen.getByRole("button", { name: "Transcript end" }));
    await waitFor(() => expect(collectTranscript).toHaveBeenCalledOnce());
    const signal = vi.mocked(collectTranscript).mock.calls[0][3];
    if (action === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop loading" }));
    else {
      fireEvent.change(screen.getByRole("combobox", { name: "Transcript conversation" }), { target: { value: other.key } });
      await screen.findByText("Other conversation");
    }
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ source, messages: [message("late", "Late stale reply")], view: "conversation", notices: [], exportedAt: 0 }));
    expect(screen.queryByText("Late stale reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop loading" })).not.toBeInTheDocument();
  });

  it("discards an older batched search as soon as the query changes", async () => {
    const entries = Array.from({ length: 500 }, (_, index) => message(`entry-${index}`, index === 499 ? "New needle" : `Old result ${index}`, "assistant"));
    vi.mocked(loadAgentTranscript).mockResolvedValue(page(entries.slice(0, 2), { nextCursor: "later" }));
    vi.mocked(collectTranscript).mockResolvedValue({ source, messages: entries, view: "conversation", notices: [], exportedAt: 0 });
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("Old result 0");
    fireEvent.click(screen.getByRole("button", { name: "Transcript end" }));
    await screen.findByText("New needle");
    const input = screen.getByRole("searchbox", { name: "Search transcript" });
    fireEvent.change(input, { target: { value: "Old" } });
    expect(screen.getByText(/matching messages · whole transcript · searching the rest/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "New" } });
    await screen.findByText("1 matching message · whole transcript");
    expect(document.querySelectorAll('[data-search-match="true"]')).toHaveLength(1);
    expect(document.querySelector('[data-message-id="entry-499"] mark')).toHaveTextContent("New");
  });

  it("stops a paging cycle and preserves the previously loaded messages", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("first", "First saved prompt")], { nextCursor: "a" }))
      .mockResolvedValueOnce(page([message("second", "Second saved reply", "assistant")], { nextCursor: "b" }))
      .mockResolvedValueOnce(page([message("invalid", "Invalid cycle reply", "assistant")], { nextCursor: "a" }));
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("First saved prompt");
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("Second saved reply");
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("paging stopped advancing");
    expect(screen.getByText("First saved prompt")).toBeInTheDocument();
    expect(screen.getByText("Second saved reply")).toBeInTheDocument();
    expect(screen.queryByText("Invalid cycle reply")).not.toBeInTheDocument();
    expect(loadAgentTranscript).toHaveBeenCalledTimes(3);
  });

  it("keeps loaded search available when full-transcript reading fails", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([message("first", "Loaded needle")], { nextCursor: "later" }));
    vi.mocked(collectTranscript).mockRejectedValue(new Error("This conversation exceeds the full-transcript limit."));
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("Loaded needle");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search transcript" }), { target: { value: "needle" } });
    await screen.findByRole("alert");
    expect(screen.getByText("1 matching message · loaded messages")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Transcript search scope" }), { target: { value: "loaded" } });
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(document.querySelector('[data-message-id="first"]')).toHaveAttribute("data-search-current", "true");
    expect(collectTranscript).toHaveBeenCalledOnce();
  });

  it("exports the whole selected conversation with progress, activity scope, and a named download", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([message("first", "Loaded first prompt")]));
    const transcript = { source, view: "all" as const, messages: [message("first", "Loaded first prompt"), message("unloaded", "Last saved reply", "assistant")],
      notices: [], exportedAt: 0 };
    vi.mocked(collectTranscript).mockImplementation(async (_target, _source, _view, _signal, progress) => {
      progress(2);
      return transcript;
    });
    render(<AgentTranscript target={{ historyId: "history" }} title="Project conversation" />);
    await screen.findByText("Loaded first prompt");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show activity" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export Markdown" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await screen.findByText("Markdown exported · 2 messages.");
    expect(collectTranscript).toHaveBeenCalledWith({ historyId: "history" }, source.key, "all", expect.any(AbortSignal), expect.any(Function));
    expect(downloadTranscriptMarkdown).toHaveBeenCalledWith(transcript, "Project conversation");
    expect(screen.queryByText("Last saved reply")).not.toBeInTheDocument();
  });

  it("cancels an export and ignores its late result when the selected conversation changes", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([message("first", "First conversation")], { sources: [source, other] }));
    let finish!: (value: Awaited<ReturnType<typeof collectTranscript>>) => void;
    vi.mocked(collectTranscript).mockImplementationOnce((_target, _source, _view, _signal, progress) => {
      progress(50);
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<AgentTranscript target={{ historyId: "history" }} />);
    await screen.findByText("First conversation");
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await screen.findByText("Preparing Markdown · 50 messages…");
    const signal = vi.mocked(collectTranscript).mock.calls[0][3];
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([message("other", "Other conversation")], { sources: [source, other], selectedSource: other.key }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: other.key } });
    await screen.findByText("Other conversation");
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ source, view: "conversation", messages: [], notices: [], exportedAt: 0 }));
    expect(downloadTranscriptMarkdown).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel export" })).not.toBeInTheDocument();
  });

  it("opens the PDF window synchronously, removes its opener, and shows pop-up failures", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue(page([message("first", "Prompt")]));
    const transcript = { source, view: "conversation" as const, messages: [], notices: [], exportedAt: 0 };
    vi.mocked(collectTranscript).mockResolvedValue(transcript);
    const popup = { document: document.implementation.createHTMLDocument(), closed: false, opener: window, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    render(<AgentTranscript target={{ paneId: "%1" }} title="PDF conversation" />);
    await screen.findByText("Prompt");
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(popup.opener).toBeNull();
    await screen.findByText(/PDF view ready/);
    expect(writeTranscriptPrint).toHaveBeenCalledWith(popup, transcript, "PDF conversation");
    open.mockReturnValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Allow pop-ups");
    expect(collectTranscript).toHaveBeenCalledOnce();
    open.mockRestore();
  });
});
