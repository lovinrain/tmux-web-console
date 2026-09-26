import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWorkspaces,
  type SavedWorkspace,
  type WorkspaceSessionsTransferResult,
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

  const sourceTree = {
    openSessions: ["root", "agent", "child", "shell"], recentSessions: ["agent"], groups: [],
    parents: { agent: "root", child: "agent" },
  };

  it("finds a parent locally, excludes its own branch, and keeps failed changes reviewable", async () => {
    const onReparentSession = vi.fn().mockRejectedValueOnce(new Error("Workspace changed; try again.")).mockResolvedValue(undefined);
    const onTransfer = vi.fn();
    const onClose = vi.fn();
    render(<SessionWorkspaceTransferDialog sessionNames={["agent"]} sourceWorkspaceId="source" sourceWorkspaceName="Current project"
      sourceWorkspace={sourceTree} onReparentSession={onReparentSession} onTransfer={onTransfer} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Move / Nest" });
    expect(within(dialog).queryByRole("radio", { name: "Nest under child" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: "Nest under agent" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("1 nested session comes with it.")).toBeVisible();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "shell" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Nest under shell" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Nest session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace changed; try again.");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Nest session" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onReparentSession).toHaveBeenLastCalledWith("agent", "shell");
    expect(onTransfer).not.toHaveBeenCalled();
  });

  it("promotes one level without waiting for other workspaces to load", async () => {
    vi.mocked(listWorkspaces).mockReturnValue(new Promise(() => {}));
    const onReparentSession = vi.fn();
    render(<SessionWorkspaceTransferDialog sessionNames={["child"]} sourceWorkspaceId="source" sourceWorkspaceName="Current project"
      sourceWorkspace={sourceTree} onReparentSession={onReparentSession} onTransfer={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(onReparentSession).toHaveBeenCalledWith("child", "root");
  });

  it("transfers a complete branch under a chosen parent with one save", async () => {
    const onTransfer = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    render(<SessionWorkspaceTransferDialog sessionNames={["agent"]} sourceWorkspaceId="source" sourceWorkspaceName="Current project"
      sourceWorkspace={sourceTree} onReparentSession={vi.fn()} onTransfer={onTransfer} onClose={onClose} />);
    await screen.findByRole("option", { name: "Release room" });
    fireEvent.change(screen.getByRole("combobox", { name: "Destination workspace" }), { target: { value: "destination" } });
    expect(screen.queryByRole("group", { name: "Quick placement" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Nest under review" }));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(["agent", "child"], "destination", "move", 4, "review"));
    expect(onClose).toHaveBeenCalled();
  });

  it("allows copying a pinned descendant and prevents moving it out of the source", async () => {
    const onTransfer = vi.fn().mockResolvedValue({});
    render(<SessionWorkspaceTransferDialog sessionNames={["agent"]} sourceWorkspaceId="source" sourceWorkspaceName="Current project"
      sourceWorkspace={sourceTree} workspacePinnedSessions={["child"]} onReparentSession={vi.fn()} onTransfer={onTransfer} onClose={vi.fn()} />);
    await screen.findByRole("option", { name: "Release room" });
    fireEvent.change(screen.getByRole("combobox", { name: "Destination workspace" }), { target: { value: "destination" } });
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy here" }));
    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(["agent", "child"], "destination", "copy", 4, null));
  });

  it("filters out the source, copies once, and marks the destination as added", async () => {
    const destination = workspace("destination", "Release room", ["review", "agent"], 5);
    const result: WorkspaceSessionsTransferResult = {
      sessions: ["agent"],
      operation: "copy",
      destinationAlreadyContained: [],
      destinationAdded: ["agent"],
      sourceRemoved: [],
      sourceWorkspace: workspace("source", "Current project", ["agent", "shell"], 5),
      destinationWorkspace: destination,
      sessionRevision: 5,
    };
    const onTransfer = vi.fn().mockResolvedValue(result);
    render(
      <SessionWorkspaceTransferDialog
        sessionNames={["agent"]}
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinnedSessions={[]}
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
      ["agent"],
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
      sessions: ["agent"],
      operation: "move",
      destinationAlreadyContained: ["agent"],
      destinationAdded: [],
      sourceRemoved: ["agent"],
      sourceWorkspace: workspace("source", "Current project", ["shell"], 5),
      destinationWorkspace: workspace("existing", "Agent archive", ["agent"], 5),
      sessionRevision: 5,
    } satisfies WorkspaceSessionsTransferResult);
    render(
      <SessionWorkspaceTransferDialog
        sessionNames={["agent"]}
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinnedSessions={[]}
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

    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(
      ["agent"],
      "existing",
      "move",
      4,
    ));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("explains why a globally pinned session cannot be moved", async () => {
    render(
      <SessionWorkspaceTransferDialog
        sessionNames={["agent"]}
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinnedSessions={["agent"]}
        onClose={vi.fn()}
        onTransfer={vi.fn()}
      />,
    );

    expect(await screen.findByText(/already copied everywhere/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Move agent to Release room" }))
      .toBeDisabled();
  });

  it("copies only missing sessions from an ordered multi-selection", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      workspace("source", "Current project", ["alpha", "beta", "gamma"]),
      workspace("destination", "Release room", ["review", "beta"]),
      workspace("existing", "Complete archive", ["alpha", "beta", "gamma"]),
    ]);
    const result: WorkspaceSessionsTransferResult = {
      sessions: ["alpha", "beta", "gamma"],
      operation: "copy",
      destinationAlreadyContained: ["beta"],
      destinationAdded: ["alpha", "gamma"],
      sourceRemoved: [],
      sourceWorkspace: workspace(
        "source",
        "Current project",
        ["alpha", "beta", "gamma"],
        5,
      ),
      destinationWorkspace: workspace(
        "destination",
        "Release room",
        ["review", "beta", "alpha", "gamma"],
        5,
      ),
      sessionRevision: 5,
    };
    const onTransfer = vi.fn().mockResolvedValue(result);

    render(
      <SessionWorkspaceTransferDialog
        sessionNames={["alpha", "beta", "gamma"]}
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinnedSessions={[]}
        onClose={vi.fn()}
        onTransfer={onTransfer}
      />,
    );

    expect(await screen.findByText("3 selected sessions")).toBeVisible();
    expect(screen.getByText("alpha, beta, gamma")).toBeVisible();
    expect(screen.getByText("1 of 3 already here")).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Complete archive already contains all 3 selected sessions",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Move 3 selected sessions to Complete archive",
    })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", {
      name: "Copy 2 missing selected sessions to Release room",
    }));
    await waitFor(() => expect(onTransfer).toHaveBeenCalledWith(
      ["alpha", "beta", "gamma"],
      "destination",
      "copy",
      4,
    ));
    expect(await screen.findByText(
      "Copied 2 sessions to Release room; 1 was already there.",
    )).toBeVisible();
  });

  it("blocks the complete multi-session move when any selection is globally pinned", async () => {
    render(
      <SessionWorkspaceTransferDialog
        sessionNames={["agent", "shell"]}
        sourceWorkspaceId="source"
        sourceWorkspaceName="Current project"
        workspacePinnedSessions={["shell"]}
        onClose={vi.fn()}
        onTransfer={vi.fn()}
      />,
    );

    expect(await screen.findByText(/shell.*unpin it first/i)).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Move 2 selected sessions to Release room",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Copy 2 missing selected sessions to Release room",
    })).toBeEnabled();
  });
});
