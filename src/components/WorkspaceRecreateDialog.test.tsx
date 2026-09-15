import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecoverableSession } from "../api";
import { WorkspaceRecreateDialog } from "./WorkspaceRecreateDialog";

function recovery(name: string, overrides: Partial<RecoverableSession> = {}): RecoverableSession {
  return {
    id: `registry-${name}`,
    name,
    directory: `/srv/${name}`,
    agentType: null,
    agentSessionId: null,
    firstSeenAt: 10,
    lastSeenAt: 20,
    directoryAvailable: true,
    ...overrides,
  };
}

const targets = ["alpha", "beta"].map((name) => ({ name, recovery: recovery(name) }));

describe("WorkspaceRecreateDialog", () => {
  it("confirms the exact shells and does nothing on Cancel", () => {
    const onRecreate = vi.fn();
    const onClose = vi.fn();
    render(<WorkspaceRecreateDialog
      targets={targets}
      workspaceName="alchemist"
      onRecreate={onRecreate}
      onClose={onClose}
    />);

    const dialog = screen.getByRole("alertdialog", { name: "Recreate 2 missing shells?" });
    expect(dialog).toHaveTextContent("in alchemist");
    expect(dialog).toHaveTextContent("under its original name");
    expect(dialog).toHaveTextContent("never resumes a coding agent automatically");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(dialog).toHaveTextContent("/srv/alpha");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRecreate).not.toHaveBeenCalled();
  });

  it("recreates sequentially, reports partial failure, and retries only failures", async () => {
    const onRecreate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("tmux session already exists"))
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<WorkspaceRecreateDialog targets={targets} onRecreate={onRecreate} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate 2 shells" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 recreated; 1 failed");
    expect(screen.getByText("tmux session already exists")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry 1 shell" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    // alpha must not be recreated twice: its name is live again after the first pass.
    expect(onRecreate.mock.calls.map(([target]) => target.name)).toEqual(["alpha", "beta", "beta"]);
  });

  it("refuses a shell whose saved directory is gone, without calling the API", async () => {
    const onRecreate = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceRecreateDialog
      targets={[{ name: "gone", recovery: recovery("gone", { directoryAvailable: false }) }]}
      onRecreate={onRecreate}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate 1 shell" }));
    await screen.findByRole("alert");
    expect(onRecreate).not.toHaveBeenCalled();
    expect(screen.getAllByText("Saved directory is unavailable. Restore it before recreating.")
      .length).toBeGreaterThan(0);
  });

  it("refuses a tab with no recovery record at all", async () => {
    const onRecreate = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceRecreateDialog
      targets={[{ name: "forgotten" }]}
      onRecreate={onRecreate}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate 1 shell" }));
    await screen.findByRole("alert");
    expect(onRecreate).not.toHaveBeenCalled();
    expect(screen.getAllByText("No saved directory; this tab cannot be recreated.")
      .length).toBeGreaterThan(0);
  });
});
