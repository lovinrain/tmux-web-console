import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePaneLayout } from "../api";
import type { Session } from "../types";
import { WorkspacePaneBoard } from "./WorkspacePaneBoard";

const layout: WorkspacePaneLayout = {
  id: "pair",
  name: "Pair view",
  root: {
    id: "left",
    kind: "pane",
    session: "alpha",
  },
};

function session(name: string): Session {
  return {
    id: `$${name}`,
    name,
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 2,
    serverPid: 3,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "Shell",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    tags: [],
    panes: [],
  };
}

describe("WorkspacePaneBoard", () => {
  it("renders sessions as full pane content and can extend the split tree", async () => {
    const onChange = vi.fn(async (_layout: WorkspacePaneLayout) => undefined);
    render(
      <WorkspacePaneBoard
        layout={layout}
        openSessions={["alpha", "beta"]}
        sessions={[session("alpha"), session("beta")]}
        sessionNavigation={<nav>Workspace tabs</nav>}
        desktopTabOrientation="horizontal"
        desktopTabRailWidth={288}
        workspacePersistenceState="saved"
        onChange={onChange}
        onDelete={vi.fn(async () => undefined)}
        onExit={vi.fn()}
        renderSession={(name, paneId, active) => (
          <div data-testid={`session-${paneId}`} data-active={active}>{name} controls</div>
        )}
      />,
    );

    expect(screen.getByText("alpha controls")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split this pane left and right" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Empty pane")).toBeInTheDocument();

    const selectors = screen.getAllByRole("combobox");
    fireEvent.change(selectors[1], { target: { value: "beta" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(screen.getByText("beta controls")).toBeInTheDocument();
    const saved = onChange.mock.calls.at(-1)?.[0];
    expect(saved && JSON.stringify(saved)).toContain('"session":"beta"');

    expect(screen.getByRole("option", { name: "alpha (move here)" })).toBeEnabled();
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "alpha" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
    expect(screen.getAllByText("alpha controls")).toHaveLength(1);
  });

  it("renames and explicitly confirms deletion", async () => {
    const onChange = vi.fn(async (_layout: WorkspacePaneLayout) => undefined);
    const onDelete = vi.fn(async () => undefined);
    render(
      <WorkspacePaneBoard
        layout={layout}
        openSessions={["alpha"]}
        sessions={[session("alpha")]}
        sessionNavigation={<nav />}
        desktopTabOrientation="vertical"
        desktopTabRailWidth={300}
        workspacePersistenceState="saved"
        onChange={onChange}
        onDelete={onDelete}
        onExit={vi.fn()}
        renderSession={(name) => <div>{name}</div>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename pane view Pair view" }));
    const input = screen.getByRole("textbox", { name: "Pane view name" });
    fireEvent.change(input, { target: { value: "Review wall" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Review wall" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("pair"));
  });
});
