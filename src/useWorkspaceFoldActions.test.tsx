import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeWorkspaceFold, deleteWorkspaceFold, recoverWorkspaceFoldSession, type SavedWorkspace } from "./api";
import { pane, session } from "./components/workspaceNavigation/testFixtures";
import type { Session } from "./types";
import { useWorkspaceFoldActions } from "./useWorkspaceFoldActions";
import type { SessionWorkspaceState } from "./workspaceState";

vi.mock("./api", () => ({ closeWorkspaceFold: vi.fn(), deleteWorkspaceFold: vi.fn(), recoverWorkspaceFoldSession: vi.fn() }));

function setup(live: Session[] = [], disabledReason: string | null = null) {
  const state: SessionWorkspaceState = { openSessions: ["alpha", "child", "beta", "other"], recentSessions: [],
    groups: [], parents: { child: "alpha" }, folds: [{ id: "fold", tabs: ["alpha", "beta"] }] };
  let saved: SavedWorkspace = { id: "workspace", name: "Workspace", tabs: state.openSessions,
    folds: state.folds, parents: state.parents, activeSession: "other", sessionRevision: 3,
    createdAt: 1, updatedAt: 10, lastActiveAt: 10 };
  const result = { workspace: { ...saved, tabs: ["other"], folds: [], parents: {}, updatedAt: 12 },
    deleted: true, closed: ["alpha", "child", "beta"], failures: {} };
  vi.mocked(deleteWorkspaceFold).mockResolvedValue(result);
  vi.mocked(closeWorkspaceFold).mockResolvedValue({ ...result, workspace: saved });
  const captureSavedWorkspace = vi.fn(async () => saved);
  const onWorkspaceUpdated = vi.fn((workspace: SavedWorkspace) => { saved = workspace; });
  const refreshInventory = vi.fn(async () => undefined);
  function Harness() {
    const actions = useWorkspaceFoldActions({ workspaceId: saved.id, disabledReason,
      getWorkspace: () => state, getSessions: () => live, captureSavedWorkspace, onWorkspaceUpdated, refreshInventory });
    return <><button onClick={() => actions.deleteFold("fold")}>Request deletion</button>
      <button onClick={() => actions.foldAndClose([], "fold")}>Request close</button>{actions.confirmation}</>;
  }
  render(<Harness />);
  return { state, saved, result, captureSavedWorkspace, onWorkspaceUpdated, refreshInventory };
}

beforeEach(() => vi.clearAllMocks());

describe("fold actions", () => {
  it("removes a closed fold without recovering anything and allows cancellation", async () => {
    const env = setup();
    fireEvent.click(screen.getByText("Request deletion"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("All sessions are already closed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteWorkspaceFold).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Request deletion"));
    fireEvent.click(screen.getByRole("button", { name: "Delete fold" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deleteWorkspaceFold).toHaveBeenCalledWith(env.saved, "fold", ["alpha", "beta"],
      ["alpha", "child", "beta"].map((name) => ({ name, sessionId: null })));
    expect(env.onWorkspaceUpdated).toHaveBeenCalledWith(env.result.workspace);
    expect(env.refreshInventory).toHaveBeenCalledTimes(1);
    expect(recoverWorkspaceFoldSession).not.toHaveBeenCalled();
    expect(closeWorkspaceFold).not.toHaveBeenCalled();
  });

  it("confirms running, dead and closed members separately with exact native identities", async () => {
    const alpha = session({ name: "alpha", id: "$1" });
    const beta = session({ name: "beta", id: "$2", panes: [pane({ dead: true })] });
    const env = setup([alpha, beta]);
    fireEvent.click(screen.getByText("Request deletion"));
    const dialog = screen.getByRole("alertdialog", { name: "Delete fold and 3 tabs?" });
    expect(dialog).toHaveTextContent("1 running session will be archived");
    expect(dialog).toHaveTextContent("1 dead tmux session will also be removed");
    expect(dialog).toHaveTextContent("recorded coding conversations remain available in History");
    fireEvent.click(screen.getByRole("button", { name: "Archive and delete" }));
    await waitFor(() => expect(deleteWorkspaceFold).toHaveBeenCalledTimes(1));
    expect(deleteWorkspaceFold).toHaveBeenCalledWith(env.saved, "fold", ["alpha", "beta"], [
      { name: "alpha", sessionId: "$1", sessionCreated: alpha.created, serverStarted: alpha.serverStarted, serverPid: alpha.serverPid },
      { name: "child", sessionId: null },
      { name: "beta", sessionId: "$2", sessionCreated: beta.created, serverStarted: beta.serverStarted, serverPid: beta.serverPid, onlyDeadPanes: true },
    ]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("requires a saved, synced workspace", () => {
    setup([], "Save this workspace first");
    fireEvent.click(screen.getByText("Request deletion"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteWorkspaceFold).not.toHaveBeenCalled();
  });

  it("rejects a workspace switch while preparing the confirmed deletion", async () => {
    const env = setup();
    env.captureSavedWorkspace.mockResolvedValue({ ...env.saved, id: "other-workspace" });
    fireEvent.click(screen.getByText("Request deletion"));
    fireEvent.click(screen.getByRole("button", { name: "Delete fold" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace changed");
    expect(deleteWorkspaceFold).not.toHaveBeenCalled();
  });

  it("keeps a failed deletion visible and retries against the saved archive", async () => {
    const env = setup([session({ name: "alpha", id: "$1" })]);
    const partial = { ...env.result, deleted: false, workspace: { ...env.saved, updatedAt: 11 }, failures: { alpha: "Close failed" } };
    vi.mocked(deleteWorkspaceFold).mockResolvedValueOnce(partial);
    fireEvent.click(screen.getByText("Request deletion"));
    fireEvent.click(screen.getByRole("button", { name: "Archive and delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The fold was kept; retry");
    expect(env.onWorkspaceUpdated).toHaveBeenCalledWith(partial.workspace);
    fireEvent.click(screen.getByRole("button", { name: "Archive and delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(vi.mocked(deleteWorkspaceFold).mock.calls[1][0]).toEqual(partial.workspace);
    expect(env.refreshInventory).toHaveBeenCalledTimes(2);
  });

  it("preserves the existing fold-and-close workflow", async () => {
    setup(["alpha", "child", "beta"].map((name, index) => session({ name, id: `$${index + 1}` })));
    fireEvent.click(screen.getByText("Request close"));
    fireEvent.click(screen.getByRole("button", { name: "Fold and close" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(closeWorkspaceFold).toHaveBeenCalledTimes(1);
    expect(deleteWorkspaceFold).not.toHaveBeenCalled();
  });
});
