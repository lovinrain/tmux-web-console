import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../test-utils";
import type { Session } from "../types";
import { WorkspaceCallbackList } from "./WorkspaceCallbackList";

function desktopMediaQuery(matches = true) {
  return vi.fn(() => ({
    matches,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function session(name: string, state: Session["agentState"] = "waiting_human"): Session {
  return {
    name,
    id: `id-${name}`,
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 1,
    serverPid: 1,
    activity: 1,
    activePaneId: "%1",
    agentState: state,
    agentStateReason: "test",
    agentStateChangedAt: 1,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [],
  };
}

function renderList(
  callbackSessions: string[] = [],
  onChange = vi.fn(async () => undefined),
) {
  return renderWithTheme(
    <WorkspaceCallbackList
      sessionName="agent-one"
      workspaceId="workspace-one"
      workspaceName="Launch room"
      sessions={[
        session("agent-one", "working"),
        session("agent-two"),
        session("agent-three", "waiting_command"),
      ]}
      callbackSessions={callbackSessions}
      onChange={onChange}
      onSelectSession={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", desktopMediaQuery());
  window.localStorage.clear();
  document.documentElement.classList.remove("workspace-callback-moving");
});

describe("WorkspaceCallbackList", () => {
  it("opens a focused floating list and adds the current or selected session", async () => {
    const onChange = vi.fn(async () => undefined);
    const view = renderList([], onChange);

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(within(panel).getByText("Nothing queued for a callback")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Current" }));
    expect(onChange).toHaveBeenLastCalledWith(["agent-one"]);

    view.rerender(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        sessions={[session("agent-one", "working"), session("agent-two")]}
        callbackSessions={["agent-one"]}
        onChange={onChange}
        onSelectSession={vi.fn()}
      />,
    );
    expect(within(screen.getByRole("dialog", { name: "Callback list" })).getByText("1 watching"))
      .toBeInTheDocument();
  });

  it("shows live status, opens a session, and marks an item reviewed", async () => {
    const onChange = vi.fn(async () => undefined);
    const onSelectSession = vi.fn();
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        sessions={[session("agent-one", "working"), session("agent-two")]}
        callbackSessions={["agent-one", "agent-two", "old-session"]}
        onChange={onChange}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(within(panel).getAllByText("Working").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("Ended / unavailable").length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Open agent-one" }));
    expect(onSelectSession).toHaveBeenCalledWith("agent-one");
    fireEvent.click(within(panel).getByRole("button", {
      name: "Mark agent-two reviewed and remove from callback list",
    }));
    expect(onChange).toHaveBeenLastCalledWith(["agent-one", "old-session"]);
    const clearEnded = within(panel).getByRole("button", { name: "Clear ended" });
    await waitFor(() => expect(clearEnded).toBeEnabled());
    fireEvent.click(clearEnded);
    expect(onChange).toHaveBeenLastCalledWith(["agent-one", "agent-two"]);
  });

  it("persists pin state and keeps the panel open across session changes", () => {
    const view = renderList(["agent-one"]);
    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    let panel = screen.getByRole("dialog", { name: "Callback list" });
    fireEvent.click(within(panel).getByRole("button", { name: "Pin callback list" }));

    view.rerender(
      <WorkspaceCallbackList
        sessionName="agent-two"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        sessions={[session("agent-one"), session("agent-two")]}
        callbackSessions={["agent-one"]}
        onChange={vi.fn(async () => undefined)}
        onSelectSession={vi.fn()}
      />,
    );
    panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(panel).toHaveAttribute("data-pinned", "true");
    expect(screen.getByRole("button", { name: "Hide callback list" })).toHaveTextContent("PIN");
  });

  it("restores panel state by workspace without writing the previous workspace state", async () => {
    window.localStorage.setItem(
      "muxdeck.workspace-callback-panel.v1:workspace:workspace-one",
      JSON.stringify({
        open: true,
        pinned: true,
        position: { x: 100, y: 110 },
        size: { width: 350, height: 360 },
      }),
    );
    const workspaceTwoPreference = {
      open: true,
      pinned: false,
      position: { x: 40, y: 50 },
      size: { width: 330, height: 340 },
    };
    window.localStorage.setItem(
      "muxdeck.workspace-callback-panel.v1:workspace:workspace-two",
      JSON.stringify(workspaceTwoPreference),
    );
    const view = renderList(["agent-one"]);
    expect(screen.getByRole("dialog", { name: "Callback list" })).toHaveStyle({
      left: "100px",
      top: "110px",
    });

    view.rerender(
      <WorkspaceCallbackList
        sessionName="agent-two"
        workspaceId="workspace-two"
        workspaceName="Second room"
        sessions={[session("agent-one"), session("agent-two")]}
        callbackSessions={["agent-two"]}
        onChange={vi.fn(async () => undefined)}
        onSelectSession={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Callback list" }))
      .toHaveStyle({ left: "40px", top: "50px" }));
    expect(JSON.parse(window.localStorage.getItem(
      "muxdeck.workspace-callback-panel.v1:workspace:workspace-two",
    ) || "null")).toEqual(workspaceTwoPreference);
  });

  it("persists the border-box size after native panel resizing", async () => {
    let resize: ResizeObserverCallback | null = null;
    const disconnect = vi.fn();
    class CallbackResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }

      observe() {}
      unobserve() {}
      disconnect() { disconnect(); }
    }
    vi.stubGlobal("ResizeObserver", CallbackResizeObserver);
    renderList(["agent-one"]);
    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 342 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 378 });

    act(() => {
      resize?.([], {} as ResizeObserver);
    });

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(
        "muxdeck.workspace-callback-panel.v1:workspace:workspace-one",
      ) || "null");
      expect(stored?.size).toEqual({ width: 342, height: 378 });
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("defaults to the global queue and includes workspace-owned entries once", () => {
    const onGlobalChange = vi.fn(async () => undefined);
    const onChange = vi.fn(async () => undefined);
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        workspaceSessionNames={["agent-one"]}
        sessions={[
          session("agent-one", "working"),
          session("agent-two"),
          session("agent-three", "waiting_command"),
        ]}
        callbackSessions={["agent-one"]}
        onChange={onChange}
        globalCallbackSnapshot={{
          callbackSessions: ["agent-global", "agent-one", "agent-two"],
          globalCallbackSessions: ["agent-global"],
          workspaceCallbacks: [
            { workspaceId: "workspace-one", workspaceName: "Launch room", sessions: ["agent-one"] },
            { workspaceId: "workspace-two", workspaceName: "Review room", sessions: ["agent-one", "agent-two"] },
          ],
          sessionRevision: 0,
        }}
        onGlobalChange={onGlobalChange}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(panel).toHaveAttribute("data-scope", "global");
    expect(within(panel).getByText("agent-global")).toBeInTheDocument();
    expect(within(panel).getByText("agent-one")).toBeInTheDocument();
    expect(within(panel).getByText("agent-two")).toBeInTheDocument();
    expect(within(panel).getByText("This workspace")).toBeInTheDocument();
    expect(within(panel).getByText("Other · Review room")).toBeInTheDocument();
    expect(within(panel).getByText("Global only")).toBeInTheDocument();

    fireEvent.change(within(panel).getByRole("combobox", { name: "Choose a session to watch" }), {
      target: { value: "agent-three" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
    expect(onGlobalChange).toHaveBeenLastCalledWith(["agent-global", "agent-three"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes a current workspace-owned entry from the global view without removing another workspace's entry", () => {
    const onGlobalChange = vi.fn(async () => undefined);
    const onChange = vi.fn(async () => undefined);
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        sessions={[session("agent-one"), session("agent-two")]}
        callbackSessions={["agent-one"]}
        onChange={onChange}
        globalCallbackSnapshot={{
          callbackSessions: ["agent-one", "agent-two"],
          globalCallbackSessions: [],
          workspaceCallbacks: [
            { workspaceId: "workspace-one", workspaceName: "Launch room", sessions: ["agent-one"] },
            { workspaceId: "workspace-two", workspaceName: "Review room", sessions: ["agent-two"] },
          ],
          sessionRevision: 0,
        }}
        onGlobalChange={onGlobalChange}
        onSelectSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    fireEvent.click(within(panel).getByRole("button", {
      name: "Remove agent-one from this workspace callback list",
    }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(onGlobalChange).not.toHaveBeenCalled();
    expect(within(panel).getByRole("button", {
      name: "Remove agent-two from this workspace callback list",
    })).toBeDisabled();
  });

  it("labels workspace presence and keeps sessions outside the workspace display-only", () => {
    const onSelectSession = vi.fn();
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one"), session("agent-two"), session("agent-three")]}
        callbackSessions={[]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: ["agent-one", "agent-two", "agent-three"],
          globalCallbackSessions: ["agent-three"],
          workspaceCallbacks: [
            { workspaceId: "workspace-one", workspaceName: "Launch room", sessions: ["agent-one"] },
            { workspaceId: "workspace-two", workspaceName: "Review room", sessions: ["agent-two"] },
          ],
          sessionRevision: 0,
        }}
        onGlobalChange={vi.fn(async () => undefined)}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(within(panel).getByText("This workspace")).toBeInTheDocument();
    expect(within(panel).getByText("Other · Review room")).toBeInTheDocument();
    expect(within(panel).getByText("Global only")).toBeInTheDocument();

    const outsideOpen = within(panel).getByRole("button", { name: "Open agent-two" });
    expect(outsideOpen).toBeDisabled();
    fireEvent.click(outsideOpen);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(within(panel).getByRole("button", { name: "Open agent-one" })).toBeEnabled();
  });

  it("allows reviewing inherited global entries from any workspace", async () => {
    const onReviewSession = vi.fn(async () => undefined);
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceName="Launch room"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one"), session("agent-two")]}
        callbackSessions={[]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: ["agent-two"],
          globalCallbackSessions: [],
          workspaceCallbacks: [{
            workspaceId: "workspace-two",
            workspaceName: "Review room",
            sessions: ["agent-two"],
          }],
          sessionRevision: 0,
        }}
        onGlobalChange={vi.fn(async () => undefined)}
        onReviewSession={onReviewSession}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    const review = within(panel).getByRole("button", {
      name: "Mark agent-two reviewed and remove from all callback lists",
    });
    expect(review).toBeEnabled();
    fireEvent.click(review);
    await waitFor(() => expect(onReviewSession).toHaveBeenCalledWith("agent-two"));
  });
});
