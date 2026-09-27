import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSubmittedMessages, type SubmittedMessagePage } from "../api";
import { SubmittedMessages } from "./SubmittedMessages";

vi.mock("../api", () => ({ listSubmittedMessages: vi.fn() }));

const initial: SubmittedMessagePage = {
  messages: [{ id: "2", agentType: "claude", agentSessionId: "conversation", submittedAt: 1000000, text: "Final <edited> message\n  with formatting", complete: true }],
  nextCursor: "1000000:2",
  sources: [{ agentType: "claude", status: "available" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSubmittedMessages).mockResolvedValue(initial);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("SubmittedMessages", () => {
  it("loads older messages, searches the archive, and copies exact text", async () => {
    const target = { sessionName: "agent", identity: "$1:1:1:1" };
    render(<SubmittedMessages target={target} />);
    expect(await screen.findByText("Final <edited> message with formatting")).toBeInTheDocument();
    expect(listSubmittedMessages).toHaveBeenCalledWith(target, "", null, expect.any(AbortSignal));
    expect(screen.getByText("Claude Code")).toHaveAttribute("title", "Conversation conversation");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(initial.messages[0].text));
    vi.mocked(listSubmittedMessages).mockResolvedValue({ ...initial, nextCursor: null, messages: [{ ...initial.messages[0], id: "1", text: "Earlier input" }] });
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Earlier input");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(listSubmittedMessages).toHaveBeenLastCalledWith(target, "", initial.nextCursor, expect.any(AbortSignal));
    vi.mocked(listSubmittedMessages).mockResolvedValue({ ...initial, messages: [], nextCursor: null });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a different prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("No submitted messages match your search.");
    expect(listSubmittedMessages).toHaveBeenLastCalledWith(target, "a different prompt", null, expect.any(AbortSignal));
    expect(screen.queryByText("Earlier input")).not.toBeInTheDocument();
  });

  it("shows saved input with incomplete-paste and unavailable-source notices", async () => {
    vi.mocked(listSubmittedMessages).mockResolvedValue({
      ...initial, nextCursor: null,
      messages: [{ ...initial.messages[0], complete: false, text: "Fix [Pasted text #1]" }],
      sources: [{ agentType: "claude", status: "missing" }],
    });
    render(<SubmittedMessages target={{ historyId: "ended-session" }} />);
    await screen.findByText("Fix [Pasted text #1]");
    expect(listSubmittedMessages).toHaveBeenCalledWith({ historyId: "ended-session" }, "", null, expect.any(AbortSignal));
    expect(screen.getByText(/Some pasted content/)).toBeInTheDocument();
    expect(screen.getByText(/Previously saved messages are retained/)).toBeInTheDocument();
  });

  it("recovers from a failed load and reports clipboard failure without losing input", async () => {
    vi.mocked(listSubmittedMessages).mockRejectedValueOnce(new Error("Archive unavailable"));
    render(<SubmittedMessages target={{ sessionName: "agent" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("article");
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select the message text");
    expect(within(screen.getByRole("article")).getByText(/Final <edited>/)).toBeInTheDocument();
  });
});
