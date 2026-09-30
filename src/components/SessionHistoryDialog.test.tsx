import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSessionHistory, listSubmittedMessages, loadSavedScrollback, loadAgentTranscript, restoreSessionHistory, type SessionHistoryEntry } from "../api";
import { SessionHistoryDialog } from "./SessionHistoryDialog";

vi.mock("../api", () => ({ listSessionHistory: vi.fn(), listSubmittedMessages: vi.fn(), loadSavedScrollback: vi.fn(), loadAgentTranscript: vi.fn(), restoreSessionHistory: vi.fn() }));
const entry: SessionHistoryEntry = {
  id: "history-1", name: "named-agent", title: "Project notes", names: ["old-agent", "named-agent"],
  directory: "/work/project", directoryAvailable: true, agentType: "codex", agentSessionId: "reference-id",
  firstSeenAt: 100, lastSeenAt: 200, state: "ended", endedAt: 220, tabClosedAt: null,
  workspaces: [{ id: "project", name: "Project", present: false, lastSeenAt: 200, closedAt: 210 }],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSessionHistory).mockResolvedValue({ entries: [entry], nextOffset: null });
  vi.mocked(restoreSessionHistory).mockResolvedValue({ session: entry.name, sessionId: "$2", created: true });
});

describe("SessionHistoryDialog", () => {
  it("shows native start, copy lineage and browser activity alongside agent history", async () => {
    vi.mocked(listSessionHistory).mockResolvedValue({ entries: [{ ...entry, createdAt: 90,
      origin: { kind: "copy", recordedAt: 95, sourceHistoryId: "parent", sourceName: "source-session", placement: "child" },
      viewEvents: [{ id: 1, kind: "split-workspace", recordedAt: 200 }, { id: 2, kind: "fork", recordedAt: 210 }],
    }], nextOffset: null });
    render(<SessionHistoryDialog sessionName={entry.name} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Metadata for named-agent" });
    await within(dialog).findByText("source-session");
    expect(dialog).toHaveTextContent("Started");
    expect(dialog).toHaveTextContent("Copied session");
    expect(dialog).toHaveTextContent("Child session");
    expect(dialog).toHaveTextContent("Agent history");
    expect(dialog).toHaveTextContent("reference-id");
    fireEvent.click(screen.getByText("Browser view activity (2)"));
    expect(screen.getByText("Split workspace opened")).toBeVisible();
    expect(screen.getByText("Fork requested")).toBeVisible();
    expect(restoreSessionHistory).not.toHaveBeenCalled();
  });

  it("leaves unknown start dates and origins explicit for older records", async () => {
    render(<SessionHistoryDialog sessionName={entry.name} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText("Not recorded for this session");
    expect(screen.getByText("Started").nextElementSibling).toHaveTextContent("Not recorded");
    expect(screen.queryByText(/Browser view activity/)).not.toBeInTheDocument();
  });

  it("opens saved output for an ended session without recreating its shell", async () => {
    vi.mocked(loadAgentTranscript).mockResolvedValue({ sources: [], selectedSource: null, status: "available", messages: [{ id: "first", role: "user", text: "Original request", timestamp: null, truncated: false }], nextCursor: null, partial: false, notice: null });
    vi.mocked(loadSavedScrollback).mockResolvedValue({
      part: "beginning", lines: ["Earlier output"], panes: [], selectedPane: null,
      capturedAt: 100, firstCapturedAt: 100, sessionCreatedAt: 90, limited: false,
      lineLimit: 2000, byteLimit: 1048576,
    });
    render(<SessionHistoryDialog onClose={vi.fn()} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Transcript for named-agent" }));
    await screen.findByText("Original request");
    expect(loadAgentTranscript).toHaveBeenCalledWith({ historyId: entry.id }, null, null, expect.any(AbortSignal), "conversation");
    fireEvent.click(screen.getByRole("button", { name: "Recorded terminal output" }));
    await screen.findByText("Earlier output");
    expect(screen.queryByText("Original request")).not.toBeInTheDocument();
    expect(loadSavedScrollback).toHaveBeenCalledWith({ historyId: entry.id }, "beginning", null, expect.any(AbortSignal));
    expect(restoreSessionHistory).not.toHaveBeenCalled();
  });

  it("opens saved messages for an ended session without recreating its shell", async () => {
    vi.mocked(listSubmittedMessages).mockResolvedValue({ messages: [], nextCursor: null, sources: [] });
    render(<SessionHistoryDialog onClose={vi.fn()} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Submitted messages for named-agent" }));
    await screen.findByText(/No Claude Code or Codex conversation ID/);
    expect(listSubmittedMessages).toHaveBeenCalledWith({ historyId: entry.id }, "", null, expect.any(AbortSignal));
    expect(restoreSessionHistory).not.toHaveBeenCalled();
  });

  it("filters workspace history on demand and shows names, agent references and membership", async () => {
    render(<SessionHistoryDialog workspaceId="project" workspaceName="Project" onClose={vi.fn()} onOpenSession={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Session history" });
    await within(dialog).findByText("named-agent");
    expect(listSessionHistory).toHaveBeenCalledWith("project", "", true, 0, expect.any(AbortSignal), null);
    expect(dialog).toHaveTextContent("old-agent");
    expect(dialog).toHaveTextContent("Project notes");
    expect(dialog).toHaveTextContent("reference-id");
    expect(dialog).toHaveTextContent("Project (previous)");
    fireEvent.change(screen.getByLabelText("Search session history"), { target: { value: "reference" } });
    expect(listSessionHistory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listSessionHistory).toHaveBeenLastCalledWith("project", "reference", true, 0, expect.any(AbortSignal), null));
  });

  it("requires confirmation to recreate and never creates while viewing", async () => {
    const onOpenSession = vi.fn();
    render(<SessionHistoryDialog onClose={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Recreate shell" }));
    expect(restoreSessionHistory).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Recreate shell confirmation" });
    expect(confirm).toHaveTextContent("No coding agent will be resumed");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Create fresh shell" }));
    await waitFor(() => expect(restoreSessionHistory).toHaveBeenCalledWith(entry.id, true));
    expect(onOpenSession).toHaveBeenCalledWith(entry.name);
  });

  it("keeps session history usable without showing workspace membership on ephemeral pages", async () => {
    vi.mocked(listSessionHistory).mockResolvedValue({ entries: [entry, {
      ...entry, id: "history-2", name: "another-name", workspaces: [],
    }], nextOffset: null });
    render(<SessionHistoryDialog sessionName="named-agent" showWorkspaceMembership={false}
      onClose={vi.fn()} onOpenSession={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Metadata for named-agent" });
    await within(dialog).findByText("named-agent");
    expect(listSessionHistory).toHaveBeenCalledWith(null, "", false, 0, expect.any(AbortSignal), "named-agent");
    expect(dialog).toHaveTextContent("reference-id");
    expect(dialog).not.toHaveTextContent("Project (previous)");
    expect(dialog).not.toHaveTextContent(/workspace/i);

    vi.mocked(listSessionHistory).mockResolvedValue({ entries: [], nextOffset: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh session history" }));
    expect(await screen.findByText(/No matching history yet/)).not.toHaveTextContent(/workspace/i);
  });

  it("reopens a running session without requesting creation", async () => {
    vi.mocked(listSessionHistory).mockResolvedValue({ entries: [{ ...entry, state: "live" }], nextOffset: null });
    const onOpenSession = vi.fn();
    render(<SessionHistoryDialog onClose={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reopen session" }));
    await waitFor(() => expect(restoreSessionHistory).toHaveBeenCalledWith(entry.id, false));
    expect(onOpenSession).toHaveBeenCalledWith(entry.name);
  });

  it("shows a restore conflict without navigating or closing", async () => {
    vi.mocked(restoreSessionHistory).mockRejectedValue(new Error("A different live session already uses this name"));
    const onOpenSession = vi.fn();
    const onClose = vi.fn();
    render(<SessionHistoryDialog onClose={onClose} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Recreate shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Create fresh shell" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different live session");
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("disables recreation for a missing directory and exposes load errors", async () => {
    vi.mocked(listSessionHistory).mockResolvedValueOnce({ entries: [{ ...entry, directoryAvailable: false }], nextOffset: null });
    render(<SessionHistoryDialog onClose={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Recreate shell" })).toBeDisabled();
    vi.mocked(listSessionHistory).mockRejectedValue(new Error("History unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
  });
});
