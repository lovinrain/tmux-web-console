import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Session } from "../types";
import { setWorkspaceTabGroup, type SessionWorkspaceState } from "../workspaceState";
import { WorkspaceGroupDialog } from "./WorkspaceGroupDialog";

function pane(): Pane {
  return {
    id: "%1",
    index: 0,
    window_index: 0,
    window_name: "main",
    window_active: true,
    active: true,
    command: "bash",
    path: "/work",
    title: "shell",
    width: 100,
    height: 30,
    history_size: 0,
    history_limit: 2_000,
    alternate_on: false,
    dead: false,
    activity: 1,
  };
}

function session(name: string, customTitle: string | null = null): Session {
  return {
    id: `$${name}`,
    name,
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent detected",
    agentStateChangedAt: 1,
    customTitle,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [pane()],
    tags: [],
  };
}

const sessions = [session("alpha", "Alpha control"), session("beta")];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("WorkspaceGroupDialog", () => {
  it("creates a named group with a chosen color and ordered members", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceGroupDialog
        groups={[]}
        openSessions={["alpha", "beta"]}
        sessions={sessions}
        initialSession="beta"
        onSave={onSave}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Create a group" });
    const create = within(dialog).getByRole("button", { name: "Create group" });
    expect(create).toBeDisabled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Group name" }), {
      target: { value: "Release lane" },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /alpha/i }));
    fireEvent.click(create);

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      name: "Release lane",
      color: "orange",
      collapsed: false,
      tabs: ["alpha", "beta"],
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("edits membership while preserving collapse state and explains cross-group moves", () => {
    const onSave = vi.fn();
    render(
      <WorkspaceGroupDialog
        groups={[
          {
            id: "review",
            name: "Review",
            color: "cyan",
            collapsed: true,
            tabs: ["alpha"],
          },
          {
            id: "build",
            name: "Build",
            color: "green",
            collapsed: false,
            tabs: ["beta"],
          },
        ]}
        openSessions={["alpha", "beta"]}
        sessions={sessions}
        groupId="review"
        onSave={onSave}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit Review" });
    const beta = within(dialog).getByRole("checkbox", { name: /beta.*move from Build/i });
    fireEvent.click(beta);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save group" }));

    expect(onSave).toHaveBeenCalledWith({
      id: "review",
      name: "Review",
      color: "cyan",
      collapsed: true,
      tabs: ["alpha", "beta"],
    });
  });

  it.each(["alpha", null])("creates a second group without moving an existing group's tab (initial: %s)", (initialSession) => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta"],
      recentSessions: [],
      groups: [{
        id: "review",
        name: "Review",
        color: "cyan",
        collapsed: true,
        tabs: ["alpha"],
      }],
    };
    const onSave = vi.fn();
    render(
      <WorkspaceGroupDialog
        groups={workspace.groups}
        openSessions={workspace.openSessions}
        sessions={sessions}
        initialSession={initialSession}
        onSave={onSave}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Create a group" });
    expect(within(dialog).getByRole("textbox", { name: "Group name" })).toHaveValue("");
    expect(within(dialog).getByRole("checkbox", { name: /alpha/i })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /beta/i })).toBeChecked();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Group name" }), {
      target: { value: "Build" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create group" }));

    expect(onSave).toHaveBeenCalledOnce();
    const next = setWorkspaceTabGroup(workspace, onSave.mock.calls[0][0]);
    expect(next.groups).toEqual([
      workspace.groups[0],
      {
        id: expect.any(String),
        name: "Build",
        color: "blue",
        collapsed: false,
        tabs: ["beta"],
      },
    ]);
    expect(next.groups[1].id).not.toBe(workspace.groups[0].id);
  });

  it("requires an explicit tab move when every open tab is already grouped", () => {
    const onSave = vi.fn();
    render(
      <WorkspaceGroupDialog
        groups={[{
          id: "review",
          name: "Review",
          color: "cyan",
          collapsed: false,
          tabs: ["alpha", "beta"],
        }]}
        openSessions={["alpha", "beta"]}
        sessions={sessions}
        initialSession="alpha"
        onSave={onSave}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Create a group" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Group name" }), {
      target: { value: "Build" },
    });
    const create = within(dialog).getByRole("button", { name: "Create group" });
    expect(create).toBeDisabled();
    for (const checkbox of within(dialog).getAllByRole("checkbox")) {
      expect(checkbox).not.toBeChecked();
    }
    fireEvent.submit(create.closest("form")!);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /beta.*move from Review/i }));
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: "Build",
      tabs: ["beta"],
    }));
  });

  it("ungroups an existing group without touching its tmux sessions", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceGroupDialog
        groups={[{
          id: "review",
          name: "Review",
          color: "purple",
          collapsed: false,
          tabs: ["alpha"],
        }]}
        openSessions={["alpha"]}
        sessions={sessions}
        groupId="review"
        onSave={vi.fn()}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ungroup tabs" }));
    expect(onDelete).toHaveBeenCalledWith("review");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
