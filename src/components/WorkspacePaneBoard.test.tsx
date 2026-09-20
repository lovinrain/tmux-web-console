import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContext } from "react";
import type { WorkspacePaneLayout } from "../api";
import type { Session } from "../types";
import { WorkspacePaneBoard } from "./WorkspacePaneBoard";
import { ActivePaneSessionContext } from "./SessionWorkspaceNavigation";

const layout: WorkspacePaneLayout = {
  id: "pair",
  name: "Pair view",
  root: {
    id: "left",
    kind: "pane",
    session: "alpha",
  },
};

const pairLayout: WorkspacePaneLayout = {
  id: "pair",
  name: "Pair view",
  root: {
    id: "split",
    kind: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { id: "left", kind: "pane", session: "alpha" },
    second: { id: "right", kind: "pane", session: "beta" },
  },
};

function paneRect(left: number, right: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 500,
    width: right - left,
    height: 500,
    toJSON: () => ({}),
  };
}

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

afterEach(() => vi.restoreAllMocks());

describe("WorkspacePaneBoard", () => {
  it("arms pane navigation and moves active terminal focus geometrically", () => {
    function ActiveSessionProbe() {
      return <span data-testid="active-command-session">{useContext(ActivePaneSessionContext)}</span>;
    }
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function mockPaneBounds(this: HTMLElement) {
        if (this.dataset.paneId === "left") return paneRect(0, 400);
        if (this.dataset.paneId === "right") return paneRect(408, 800);
        return paneRect(0, 0);
      });
    render(
      <WorkspacePaneBoard
        layout={pairLayout}
        openSessions={["alpha", "beta"]}
        sessions={[session("alpha"), session("beta")]}
        sessionNavigation={<ActiveSessionProbe />}
        desktopTabOrientation="horizontal"
        desktopTabRailWidth={288}
        workspacePersistenceState="saved"
        onChange={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => undefined)}
        onExit={vi.fn()}
        renderSession={(name, paneId, active, _onActivate, focusRequestToken) => (
          <div
            data-testid={`terminal-${paneId}`}
            data-active={active}
            data-focus-request={focusRequestToken}
          >
            {name}
          </div>
        )}
      />,
    );

    fireEvent.keyDown(window, {
      code: "KeyG",
      key: "G",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Pane navigation");
    expect(screen.getByRole("button", { name: /Navigating/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("terminal-right")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("active-command-session")).toHaveTextContent("beta");
    expect(screen.getByTestId("terminal-right")).toHaveAttribute(
      "data-focus-request",
      expect.stringMatching(/^\d+$/),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Focused beta");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("terminal-left")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("active-command-session")).toHaveTextContent("alpha");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    bounds.mockRestore();
  });

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
