import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSessionHistory, restoreSessionHistory, type SessionHistoryEntry } from "../api";
import { SessionHistoryDialog } from "./SessionHistoryDialog";

vi.mock("../api", () => ({ listSessionHistory: vi.fn(), restoreSessionHistory: vi.fn() }));
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
  it("filters workspace history on demand and shows names, agent references and membership", async () => {
    render(<SessionHistoryDialog workspaceId="project" workspaceName="Project" onClose={vi.fn()} onOpenSession={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Recent Sessions" });
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
