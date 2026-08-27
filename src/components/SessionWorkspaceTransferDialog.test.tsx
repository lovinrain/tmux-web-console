import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWorkspaces,
  type SavedWorkspace,
  type WorkspaceSessionTransferResult,
} from "../api";
import { SessionWorkspaceTransferDialog } from "./SessionWorkspaceTransferDialog";

vi.mock("../api", () => ({
  listWorkspaces: vi.fn(),
}));

function workspace(
  id: string,
  name: string,
  tabs: string[],
  sessionRevision = 4,
): SavedWorkspace {
  return {
    id,
    name,
    tabs,
    groups: [],
    quickLinks: [],
    activeSession: tabs[0] ?? null,
    sessionRevision,
    createdAt: 1,
    updatedAt: 2,
    lastActiveAt: 1,
  };
}

describe("SessionWorkspaceTransferDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([
      workspace("source", "Current project", ["agent", "shell"]),
      workspace("destination", "Release room", ["review"]),
      workspace("existing", "Agent archive", ["agent"]),
    ]);
  });

  it("filters out the source, copies once, and marks the destination as added", async () => {
    const destination = workspace("destination", "Release room", ["review", "agent"], 5);
    const result: WorkspaceSessionTransferResult = {
      session: "agent",
      operation: "copy",
      destinationAlreadyContained: false,
      destinationAdded: true,
      sourceRemoved: false,
      sourceWorkspace: workspace("source", "Current project", ["agent", "shell"], 5),
      destinationWorkspace: destination,
      sessionRevision: 5,
    };
    const onTransfer = vi.fn().mockResolvedValue(result);
    render(
      <SessionWorkspaceTransferDialog
        sessionName="agent"
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinned={false}
        onClose={vi.fn()}
        onTransfer={onTransfer}
      />,
    );

    expect(await screen.findByText("Release room")).toBeVisible();
    expect(screen.queryByText("Current project", { selector: ".workspace-transfer-row strong" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "agent is already in Agent archive" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Copy agent to Release room" }));
    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(
      "destination",
      "copy",
      4,
    ));
    expect(await screen.findByText("Copied agent to Release room.")).toBeVisible();
    expect(screen.getByRole("button", { name: "agent is already in Release room" }))
      .toBeDisabled();
  });

  it("searches by workspace tabs and closes after a move", async () => {
    const onClose = vi.fn();
    const onTransfer = vi.fn().mockResolvedValue({
      session: "agent",
      operation: "move",
      destinationAlreadyContained: true,
      destinationAdded: false,
      sourceRemoved: true,
      sourceWorkspace: workspace("source", "Current project", ["shell"], 5),
      destinationWorkspace: workspace("existing", "Agent archive", ["agent"], 5),
      sessionRevision: 5,
    } satisfies WorkspaceSessionTransferResult);
    render(
      <SessionWorkspaceTransferDialog
        sessionName="agent"
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinned={false}
        onClose={onClose}
        onTransfer={onTransfer}
      />,
    );

    const search = await screen.findByRole("searchbox", { name: "Search saved workspaces" });
    fireEvent.change(search, { target: { value: "agent" } });
    expect(screen.queryByText("Release room")).not.toBeInTheDocument();
    const archive = screen.getByText("Agent archive").closest("article");
    expect(archive).not.toBeNull();
    fireEvent.click(within(archive!).getByRole("button", {
      name: "Move agent to Agent archive",
    }));

    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith("existing", "move", 4));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("explains why a globally pinned session cannot be moved", async () => {
    render(
      <SessionWorkspaceTransferDialog
        sessionName="agent"
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinned
        onClose={vi.fn()}
        onTransfer={vi.fn()}
      />,
    );

    expect(await screen.findByText(/already copied everywhere/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Move agent to Release room" }))
      .toBeDisabled();
  });
});
