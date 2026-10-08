import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContext, type ComponentProps } from "react";
import type { WorkspacePaneLayout } from "../api";
import type { Session } from "../types";
import { WorkspacePaneBoard } from "./WorkspacePaneBoard";
import {
  ActivePaneSessionContext,
} from "./workspaceNavigation/context";
import { WORKSPACE_SESSION_DRAG_TYPE } from "../workspaceSessionDrag";

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

function sessionTransfer(data: Record<string, string>): DataTransfer {
  const transfer = {
    types: Object.keys(data),
    dropEffect: "none",
    effectAllowed: "uninitialized",
    getData: vi.fn((type: string) => data[type] ?? ""),
    setData: vi.fn((type: string, value: string) => {
      data[type] = value;
      transfer.types = Object.keys(data);
    }),
  };
  return transfer as unknown as DataTransfer;
}

function renderDropBoard(overrides: Partial<ComponentProps<typeof WorkspacePaneBoard>> = {}) {
  const onChange = vi.fn(async (_layout: WorkspacePaneLayout) => undefined);
  const terminalDrop = vi.fn();
  const view = render(<WorkspacePaneBoard
    layout={pairLayout}
    openSessions={["alpha", "beta", "gamma"]}
    sessions={[session("alpha"), session("beta"), session("gamma")]}
    sessionNavigation={<nav />}
    desktopTabOrientation="horizontal"
    desktopTabRailWidth={288}
    workspacePersistenceState="saved"
    onChange={onChange}
    onDelete={vi.fn()}
    onExit={vi.fn()}
    renderSession={(name, paneId) => (
      <div data-testid={`terminal-${paneId}`} onDrop={terminalDrop}>{name}</div>
    )}
    {...overrides}
  />);
  return { ...view, onChange, terminalDrop };
}

describe("WorkspacePaneBoard", () => {
  it("follows a shared pane selection while preserving focus in the receiving view", () => {
    const changed = vi.fn();
    const props: ComponentProps<typeof WorkspacePaneBoard> = {
      layout: pairLayout, openSessions: ["alpha", "beta"], sessions: [session("alpha"), session("beta")],
      sessionNavigation: <nav />, desktopTabOrientation: "horizontal", desktopTabRailWidth: 288,
      workspacePersistenceState: "saved", onChange: vi.fn(), onDelete: vi.fn(), onExit: vi.fn(),
      renderSession: (name, id) => <button type="button" data-testid={`terminal-${id}`}>{name}</button>,
      selectedPaneId: "left", onActivePaneChange: changed,
    };
    const view = render(<WorkspacePaneBoard {...props} />);
    const left = screen.getByTestId("terminal-left");
    left.focus();
    view.rerender(<WorkspacePaneBoard {...props} selectedPaneId="right" />);
    expect(screen.getByTestId("terminal-right").closest(".workspace-pane-leaf")).toHaveClass("active");
    expect(left).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerDown(left);
    expect(changed).toHaveBeenLastCalledWith("left");
  });

  it("moves a dropped workspace session and intercepts the terminal drop", async () => {
    const { onChange, terminalDrop } = renderDropBoard();
    const target = screen.getByTestId("terminal-right");
    const pane = target.closest(".workspace-pane-leaf")!;
    const dataTransfer = sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "alpha", "text/plain": "alpha" });
    expect(fireEvent.dragEnter(target, { dataTransfer })).toBe(false);
    expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false);
    expect(dataTransfer.getData).not.toHaveBeenCalled(); // Browser data is protected until drop.
    expect(pane).toHaveAttribute("data-session-drop-active", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Drop session into this pane");
    expect(fireEvent.drop(target, { dataTransfer })).toBe(false);
    expect(terminalDrop).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Session shown in pane left" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Session shown in pane right" })).toHaveValue("alpha");
    expect(pane).toHaveClass("active");
    expect(pane).not.toHaveAttribute("data-session-drop-active");
    expect(screen.queryByText("Drop session into this pane")).not.toBeInTheDocument();
  });

  it("uses a pane session handle as a drag source and clears a canceled preview", () => {
    const { onChange } = renderDropBoard();
    const handle = screen.getByRole("img", { name: "Drag alpha to another pane" });
    const dataTransfer = sessionTransfer({});
    expect(handle).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(handle, { dataTransfer });
    expect(dataTransfer.getData(WORKSPACE_SESSION_DRAG_TYPE)).toBe("alpha");
    const target = screen.getByTestId("terminal-right");
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragLeave(target, { relatedTarget: document.body });
    expect(screen.queryByText("Drop session into this pane")).not.toBeInTheDocument();
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.dragEnd(handle, { dataTransfer });
    expect(screen.queryByText("Drop session into this pane")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("previews a top split, preserves the target session and activates the dropped session", async () => {
    const { onChange, terminalDrop } = renderDropBoard();
    const target = screen.getByTestId("terminal-right");
    const pane = target.closest(".workspace-pane-leaf")!;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(paneRect(400, 800));
    const dataTransfer = sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "gamma" });
    const dragEvent = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 600, clientY: 20 });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      return event;
    };
    fireEvent(target, dragEvent("dragover"));
    expect(pane).toHaveAttribute("data-session-drop-region", "top");
    expect(screen.getByRole("status")).toHaveTextContent("Split above");
    expect(dataTransfer.getData).not.toHaveBeenCalled();
    fireEvent(target, dragEvent("drop"));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange.mock.calls[0][0].root).toMatchObject({
      second: { direction: "vertical", first: { session: "gamma" }, second: { id: "right", session: "beta" } },
    });
    expect(screen.getByText("gamma", { selector: "[data-testid]" }).closest(".workspace-pane-leaf")).toHaveClass("active");
    expect(terminalDrop).not.toHaveBeenCalled();
  });

  it.each([
    ["plain text", { "text/plain": "alpha" }, false],
    ["files", { Files: "", [WORKSPACE_SESSION_DRAG_TYPE]: "alpha" }, false],
    ["another workspace", { [WORKSPACE_SESSION_DRAG_TYPE]: "outside" }, true],
    ["empty session", { [WORKSPACE_SESSION_DRAG_TYPE]: "" }, true],
  ] as const)("does not assign a pane from %s", (_label, data, captured) => {
    const { onChange, terminalDrop } = renderDropBoard();
    const target = screen.getByTestId("terminal-right");
    expect(fireEvent.drop(target, { dataTransfer: sessionTransfer({ ...data }) })).toBe(!captured);
    expect(onChange).not.toHaveBeenCalled();
    expect(terminalDrop).toHaveBeenCalledTimes(captured ? 0 : 1);
  });

  it.each(["loading", "error"] as const)("rejects drops while the workspace is %s", (workspacePersistenceState) => {
    const { onChange, terminalDrop } = renderDropBoard({ workspacePersistenceState });
    const target = screen.getByTestId("terminal-right");
    const dataTransfer = sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "alpha" });
    fireEvent.dragOver(target, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(target, { dataTransfer });
    expect(onChange).not.toHaveBeenCalled();
    expect(terminalDrop).not.toHaveBeenCalled();
  });

  it("does not save an unchanged assignment or start overlapping saves and reports a failed drop", async () => {
    let rejectSave!: (reason: Error) => void;
    const onChange = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    renderDropBoard({ onChange });
    const target = screen.getByTestId("terminal-right");
    fireEvent.drop(target, { dataTransfer: sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "beta" }) });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.drop(target, { dataTransfer: sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "alpha" }) });
    fireEvent.drop(target, { dataTransfer: sessionTransfer({ [WORKSPACE_SESSION_DRAG_TYPE]: "gamma" }) });
    expect(onChange).toHaveBeenCalledOnce();
    await act(async () => rejectSave(new Error("Unable to save this layout")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to save this layout");
  });

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
