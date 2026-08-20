import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Session } from "../types";
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
        initialSession="alpha"
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
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /beta/i }));
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
