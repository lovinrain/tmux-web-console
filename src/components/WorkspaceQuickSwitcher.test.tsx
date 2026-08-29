import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listWorkspaces, type SavedWorkspace } from "../api";
import { WorkspaceQuickSwitcher } from "./WorkspaceQuickSwitcher";

vi.mock("../api", () => ({
  listWorkspaces: vi.fn(),
}));

function workspace(id: string, name: string, tabs: string[] = []): SavedWorkspace {
  return {
    id,
    name,
    tabs,
    groups: [],
    quickLinks: [],
    activeSession: tabs[0] ?? null,
    sessionRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
  };
}

const alpha = workspace("alpha", "Alpha room", ["agent-alpha"]);
const middle = workspace("middle", "Middle room", ["agent-middle", "shell"]);
const zulu = workspace("zulu", "Zulu room", ["agent-zulu"]);

describe("WorkspaceQuickSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkspaces).mockResolvedValue([zulu, alpha, middle]);
  });

  it("uses stable alphabetical neighbors and wraps at either end", async () => {
    const onSwitch = vi.fn();
    const view = render(
      <WorkspaceQuickSwitcher
        activeWorkspaceId="middle"
        activeWorkspaceName="Middle room"
        onSwitch={onSwitch}
      />,
    );

    const previous = await screen.findByRole("button", {
      name: "Switch to previous workspace: Alpha room",
    });
    expect(screen.getByRole("button", {
      name: "Switch to next workspace: Zulu room",
    })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose workspace" })).toHaveTextContent("2/3");

    fireEvent.click(previous);
    expect(onSwitch).toHaveBeenLastCalledWith(alpha);
    view.rerender(
      <WorkspaceQuickSwitcher
        activeWorkspaceId="alpha"
        activeWorkspaceName="Alpha room"
        onSwitch={onSwitch}
      />,
    );
    expect(screen.getByRole("button", {
      name: "Switch to previous workspace: Zulu room",
    })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", {
      name: "Switch to next workspace: Middle room",
    }));
    expect(onSwitch).toHaveBeenLastCalledWith(middle);
  });

  it("searches names and sessions, then switches with the keyboard", async () => {
    const onSwitch = vi.fn();
    render(
      <WorkspaceQuickSwitcher
        activeWorkspaceId="middle"
        activeWorkspaceName="Middle room"
        onSwitch={onSwitch}
      />,
    );

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    const trigger = screen.getByRole("button", { name: "Choose workspace" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Switch workspace" });
    const search = within(dialog).getByRole("combobox", {
      name: "Search saved workspaces",
    });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "agent-zulu" } });
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    expect(within(dialog).getByRole("option")).toHaveTextContent("Zulu room");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSwitch).toHaveBeenCalledWith(zulu);
    expect(screen.queryByRole("dialog", { name: "Switch workspace" }))
      .not.toBeInTheDocument();
  });

  it("marks the current workspace and restores trigger focus after Escape", async () => {
    render(
      <WorkspaceQuickSwitcher
        activeWorkspaceId="middle"
        activeWorkspaceName="Middle room"
        onSwitch={vi.fn()}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Choose workspace" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Switch workspace" });
    const current = within(dialog).getByRole("option", { name: /Middle room/i });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("Current");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch workspace" }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the chooser usable after a failed load and retry", async () => {
    vi.mocked(listWorkspaces)
      .mockRejectedValueOnce(new Error("Workspace shelf unavailable"))
      .mockResolvedValueOnce([alpha]);
    render(
      <WorkspaceQuickSwitcher
        activeWorkspaceId={null}
        activeWorkspaceName="Temporary workspace"
        onSwitch={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Choose workspace" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace shelf unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: /Alpha room/i })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Switch to next workspace: Alpha room",
    })).toBeEnabled();
  });

  it("starts a temporary workspace at the two ends of the saved list", async () => {
    const onSwitch = vi.fn();
    render(
      <WorkspaceQuickSwitcher
        activeWorkspaceId={null}
        activeWorkspaceName="Temporary workspace"
        onSwitch={onSwitch}
      />,
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "Switch to previous workspace: Zulu room",
    }));
    expect(onSwitch).toHaveBeenLastCalledWith(zulu);
    fireEvent.click(screen.getByRole("button", {
      name: "Switch to next workspace: Alpha room",
    }));
    expect(onSwitch).toHaveBeenLastCalledWith(alpha);
  });
});
