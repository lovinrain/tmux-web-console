import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../types";
import { BulkSessionActionsDialog } from "./BulkSessionActionsDialog";

const targets = ["alpha", "beta"].map((name) => ({ name, session: {
  name, id: `$${name}`, created: 10, serverStarted: 5, serverPid: 1,
  customTitle: `${name} title`, agentState: "working",
} as Session }));

describe("BulkSessionActionsDialog", () => {
  it("confirms the exact targets and does nothing on Cancel", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<BulkSessionActionsDialog action="end" targets={targets} onApply={onApply} onClose={onClose} />);
    const dialog = screen.getByRole("alertdialog", { name: "End 2 selected sessions?" });
    expect(dialog).toHaveTextContent("across all workspaces");
    expect(dialog).toHaveTextContent("Unsaved terminal work can be lost");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(dialog).toHaveTextContent("alpha title");
    expect(dialog).toHaveTextContent("beta title");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each(["close", "end"] as const)("labels running commands explicitly before a bulk %s", (action) => {
    render(
      <BulkSessionActionsDialog
        action={action}
        targets={[
          { ...targets[0], session: { ...targets[0].session, agentState: "running_command" } },
          { ...targets[1], session: { ...targets[1].session, agentState: "waiting_command" } },
        ]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const rows = within(screen.getByRole("list", { name: "Selected sessions" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Command running");
    expect(rows[0]).not.toHaveTextContent("Ready");
    expect(rows[1]).toHaveTextContent("Ready");
  });

  it("reports partial failure and retries only failed identities", async () => {
    const onApply = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Identity changed")).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BulkSessionActionsDialog action="end" targets={targets} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 succeeded; 1 failed");
    expect(screen.getByText("Identity changed")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry 1 session" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onApply.mock.calls.map(([target]) => target.name)).toEqual(["alpha", "beta", "beta"]);
    expect(onApply).toHaveBeenLastCalledWith(targets[1]);
  });

  it("does not end unavailable sessions, but allows their tabs to be closed", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const props = { targets: [{ name: "missing" }], onApply, onClose: vi.fn() };
    const view = render(<BulkSessionActionsDialog {...props} action="end" />);
    fireEvent.click(screen.getByRole("button", { name: "End 1 session" }));
    await screen.findByRole("alert");
    expect(onApply).not.toHaveBeenCalled();
    view.unmount();
    render(<BulkSessionActionsDialog {...props} action="close" />);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("keep running");
    fireEvent.click(screen.getByRole("button", { name: "Close 1 tab" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(onApply).toHaveBeenCalledWith({ name: "missing" });
  });
});
