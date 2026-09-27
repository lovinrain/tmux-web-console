import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentTranscript, type AgentTranscriptMessage, type AgentTranscriptPage } from "../api";
import { AgentTranscript } from "./AgentTranscript";

vi.mock("../api", () => ({ loadAgentTranscript: vi.fn() }));

const source = { key: "codex:conversation", agentType: "codex", agentSessionId: "conversation" };
const other = { key: "claude:other", agentType: "claude", agentSessionId: "other" };
const message = (id: string, text: string, role: AgentTranscriptMessage["role"] = "user"): AgentTranscriptMessage => ({ id, text, role, timestamp: null, truncated: false });
const page = (messages: AgentTranscriptMessage[], extra: Partial<AgentTranscriptPage> = {}): AgentTranscriptPage => ({
  sources: [source], selectedSource: source.key, status: "available", messages, nextCursor: null, partial: false, notice: null, ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("AgentTranscript", () => {
  it("pages from the beginning, exposes tool details, and copies text without rendering embedded HTML", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValueOnce(page([
      message("one", "First request <img src='https://example.test/private'>"),
      message("tool", "Tool: test\nPassed", "tool"),
    ], { nextCursor: "later" })).mockResolvedValueOnce(page([
      message("one", "First request <img src='https://example.test/private'>"),
      message("two", "Answer", "assistant"),
    ]));
    render(<AgentTranscript target={{ paneId: "%1", identity: "identity" }} />);
    await screen.findByText(/First request/);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByText(/Tool: test/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show tool activity" }));
    fireEvent.click(screen.getByText("Tool activity", { selector: "summary" }));
    expect(screen.getByText(/Tool: test/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load later messages" }));
    await screen.findByText("Answer");
    expect(loadAgentTranscript).toHaveBeenLastCalledWith({ paneId: "%1", identity: "identity" }, source.key, "later", expect.any(AbortSignal));
    expect(screen.getAllByText(/First request/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Copy loaded transcript" }));
    await screen.findByText("Copied");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Assistant\nAnswer"));
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
    fireEvent.click(screen.getByRole("button", { name: "Refresh transcript" }));
    await screen.findByText("Refreshed conversation");
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await waitFor(() => expect(loadAgentTranscript).toHaveBeenLastCalledWith({ historyId: "record" }, null, null, expect.any(AbortSignal)));
  });
});
