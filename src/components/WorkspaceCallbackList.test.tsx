import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../test-utils";
import type { CallbackMessage } from "../api";
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

function callbackMessage(id: string, sessionName: string, message: string): CallbackMessage {
  return {
    id,
    sequence: 1,
    sessionName,
    message,
    agentType: "codex",
    cwd: "/root/tmux-web-console",
    requestId: null,
    tmuxSessionId: null,
    tmuxPaneId: null,
    host: null,
    createdAt: 1_789_776_000,
    reviewedAt: null,
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

  it("counts a running terminal command as working and gives it a distinct status", () => {
    const props = {
      sessionName: "terminal-task",
      workspaceId: "workspace-one",
      callbackSessions: ["terminal-task", "agent-one", "agent-two", "agent-three"],
      onChange: vi.fn(async () => undefined),
      onSelectSession: vi.fn(),
    };
    const otherSessions = [
      session("agent-one", "working"),
      session("agent-two", "waiting_human"),
      session("agent-three", "waiting_command"),
    ];
    const view = renderWithTheme(
      <WorkspaceCallbackList
        {...props}
        sessions={[session("terminal-task", "running_command"), ...otherSessions]}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show callback list" });
    expect(toggle).toHaveAccessibleDescription("1 ready out of 4 sessions; 2 working");
    expect(toggle).toHaveTextContent("1/4 ready");
    fireEvent.click(toggle);
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(within(panel).getByText("2 working")).toBeVisible();
    const commandRow = within(panel).getByRole("button", { name: "Open terminal-task" })
      .closest("li")!;
    expect(commandRow).toHaveClass("running_command");
    expect(commandRow).not.toHaveClass("ready");
    expect(within(commandRow).getByText("Command running", { selector: ".workspace-callback-status" }))
      .toHaveClass("running_command");
    expect(commandRow.querySelector(".workspace-callback-status-dot"))
      .toHaveClass("running_command");
    const waitingRow = within(panel).getByRole("button", { name: "Open agent-three" })
      .closest("li")!;
    expect(waitingRow).toHaveClass("waiting");
    expect(within(waitingRow).getByText("Waiting", { selector: ".workspace-callback-status" }))
      .toBeVisible();

    view.rerender(
      <WorkspaceCallbackList
        {...props}
        sessions={[session("terminal-task", "other"), ...otherSessions]}
      />,
    );
    expect(screen.getByRole("button", { name: "Hide callback list" }))
      .toHaveAccessibleDescription("2 ready out of 4 sessions; 1 working");
    expect(within(screen.getByRole("dialog", { name: "Callback list" }))
      .getByRole("button", { name: "Open terminal-task" }).closest("li"))
      .toHaveClass("ready");
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

  it("includes pending messages from ended, unwatched sessions and displays their content as text", () => {
    const message = callbackMessage("message-one", "ended-agent", "Completed <img src=x onerror=alert(1)> safely.");
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one")]}
        callbackSessions={[]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 2,
          callbackMessages: [message, {
            ...callbackMessage("message-reviewed", "reviewed-agent", "Previously reviewed report"),
            reviewedAt: message.createdAt + 1,
          }],
        }}
        onReviewMessage={vi.fn(async () => undefined)}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(within(panel).getByText("ended-agent")).toBeInTheDocument();
    expect(within(panel).getByText(message.message)).toBeInTheDocument();
    expect(within(panel).getByText(message.agentType)).toBeInTheDocument();
    expect(within(panel).getByText(message.cwd)).toBeInTheDocument();
    expect(panel.querySelector("time")).toHaveAttribute(
      "datetime", new Date(message.createdAt * 1000).toISOString(),
    );
    expect(within(panel).getByRole("button", { name: "Open ended-agent" })).toBeDisabled();
    expect(within(panel).queryByText("reviewed-agent")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Previously reviewed report")).not.toBeInTheDocument();
    expect(panel.querySelector("img")).toBeNull();
  });

  it.each(["global", "workspace"] as const)("shows the latest callback in %s scope after its message is reviewed", (scope) => {
    const older = callbackMessage("older", "agent-one", "Older callback");
    const latest = { ...callbackMessage("latest", "agent-one", "Latest callback message"), createdAt: older.createdAt + 90 };
    const props = {
      sessionName: "agent-one",
      workspaceId: "workspace-one",
      workspaceSessionNames: ["agent-one"],
      sessions: [session("agent-one")],
      callbackSessions: ["agent-one"],
      onChange: vi.fn(async () => undefined),
      onSelectSession: vi.fn(),
    };
    const snapshot = {
      callbackSessions: ["agent-one"], globalCallbackSessions: ["agent-one"],
      workspaceCallbacks: [], sessionRevision: 0, callbackMessageRevision: 2,
      callbackMessages: [older, latest, { ...older, id: "middle", createdAt: older.createdAt + 30 }],
    };
    const view = renderWithTheme(<WorkspaceCallbackList {...props} globalCallbackSnapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    if (scope === "workspace") fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    const timing = () => screen.getByText("Latest callback").parentElement!.querySelector("time")!;
    const date = new Date(latest.createdAt * 1000);
    expect(timing()).toHaveAttribute("datetime", date.toISOString());
    expect(timing()).toHaveTextContent(date.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }));
    expect(timing().title).toContain(date.toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    }));
    for (const remainingMessages of [[older], []]) {
      view.rerender(<WorkspaceCallbackList {...props} globalCallbackSnapshot={{
        ...snapshot, callbackMessages: remainingMessages, callbackMessageRevision: 3,
        latestCallbackAtBySession: { "agent-one": latest.createdAt },
      }} />);
      expect(timing()).toHaveAttribute("datetime", date.toISOString());
      expect(screen.queryByText("Ready since")).not.toBeInTheDocument();
    }
  });

  it("shows Ready since only when a watched agent without messages has a known ready transition", () => {
    const readyAt = 1_800_000_000;
    const props = {
      sessionName: "agent-one", callbackSessions: ["agent-one", "shell", "unknown-time"],
      onChange: vi.fn(async () => undefined), onSelectSession: vi.fn(),
    };
    const otherSessions = [session("shell", "other"), { ...session("unknown-time"), agentStateChangedAt: 0 }];
    const view = renderWithTheme(<WorkspaceCallbackList {...props} sessions={[
      { ...session("agent-one", "working"), agentStateChangedAt: readyAt }, ...otherSessions,
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    expect(screen.queryByText("Ready since")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest callback")).not.toBeInTheDocument();
    view.rerender(<WorkspaceCallbackList {...props} sessions={[
      { ...session("agent-one"), agentStateChangedAt: readyAt }, ...otherSessions,
    ]} />);
    const readyTime = screen.getByText("Ready since").parentElement!.querySelector("time")!;
    expect(readyTime).toHaveAttribute("datetime", new Date(readyAt * 1000).toISOString());
    expect(readyTime.title).toMatch(/^Ready observed:/);
    view.rerender(<WorkspaceCallbackList {...props} sessions={[
      session("agent-one", "working"), ...otherSessions,
    ]} />);
    expect(screen.queryByText("Ready since")).not.toBeInTheDocument();
  });

  it("lets the reader expand a long message without losing the full text or line breaks", () => {
    const message = callbackMessage("message-long", "agent-one", `${"Detailed outcome. ".repeat(50)}\nFinal result: all checks passed.`);
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        sessions={[session("agent-one")]}
        callbackSessions={[]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 1,
          callbackMessages: [message],
        }}
        onReviewMessage={vi.fn(async () => undefined)}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    const expand = within(panel).getByText("Show full message");
    const disclosure = expand.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(expand);
    expect(disclosure).toHaveAttribute("open");
    expect(within(panel).getByText(message.message, { normalizer: (text) => text }))
      .toBeVisible();
  });

  it("filters workspace messages to open or explicitly watched sessions, including ended sessions", () => {
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one")]}
        callbackSessions={["ended-agent"]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 3,
          callbackMessages: [
            callbackMessage("message-open", "agent-one", "Current workspace report"),
            callbackMessage("message-ended", "ended-agent", "Watched ended session report"),
            callbackMessage("message-outside", "outside-agent", "Other workspace report"),
          ],
        }}
        onReviewMessage={vi.fn(async () => undefined)}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    expect(panel).toHaveAttribute("data-scope", "workspace");
    expect(within(panel).getByText("Current workspace report")).toBeInTheDocument();
    expect(within(panel).getByText("Watched ended session report")).toBeInTheDocument();
    expect(within(panel).queryByText("Other workspace report")).not.toBeInTheDocument();
    expect(within(panel).queryByText("outside-agent")).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Global callback scope" }));
    expect(within(screen.getByRole("dialog", { name: "Callback list" }))
      .getByText("Other workspace report")).toBeInTheDocument();
  });

  it("reviews an individual message without reviewing the session or its other messages", async () => {
    const onReviewMessage = vi.fn(async () => undefined);
    const onReviewSession = vi.fn(async () => undefined);
    const onChange = vi.fn(async () => undefined);
    const first = callbackMessage("message-one", "agent-one", "First completed task");
    const second = {
      ...callbackMessage("message-two", "agent-one", "Second completed task"),
      agentType: "claude",
    };
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one")]}
        callbackSessions={[]}
        onChange={onChange}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 2,
          callbackMessages: [first, second],
        }}
        onReviewMessage={onReviewMessage}
        onReviewSession={onReviewSession}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    fireEvent.click(within(panel).getByRole("button", {
      name: "Mark message from codex in agent-one reviewed",
    }));
    await waitFor(() => expect(onReviewMessage).toHaveBeenCalledWith(first.id));
    expect(onReviewMessage).toHaveBeenCalledTimes(1);
    expect(onReviewSession).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(within(panel).getByText(second.message)).toBeInTheDocument();
  });

  it.each([
    { description: "a message for a previous session with the same name", ids: ["$7"], watched: "none", canOpen: false },
    { description: "old and unreported session IDs", ids: ["$7", null], watched: "none", canOpen: false },
    { description: "a matching session ID", ids: ["$8"], watched: "none", canOpen: true },
    { description: "both old and matching session IDs", ids: ["$7", "$8"], watched: "none", canOpen: true },
    { description: "a message without a session ID", ids: [null], watched: "none", canOpen: true },
    { description: "a manually watched global entry", ids: ["$7"], watched: "global", canOpen: true },
    { description: "a manually watched workspace entry", ids: ["$7"], watched: "workspace", canOpen: true },
  ])("guards opening the live session for $description", ({ ids, watched, canOpen }) => {
    const onSelectSession = vi.fn();
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="build"
        workspaceId="workspace-one"
        workspaceSessionNames={["build"]}
        sessions={[{ ...session("build"), id: "$8" }]}
        callbackSessions={watched === "workspace" ? ["build"] : []}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: watched === "global" ? ["build"] : [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: ids.length,
          callbackMessages: ids.map((tmuxSessionId, index) => ({
            ...callbackMessage(`message-${index}`, "build", `Completed task ${index}`),
            tmuxSessionId,
          })),
        }}
        onReviewMessage={vi.fn(async () => undefined)}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    const open = within(panel).getByRole("button", { name: "Open build" });
    if (canOpen) {
      expect(open).toBeEnabled();
      fireEvent.click(open);
      expect(onSelectSession).toHaveBeenCalledWith("build");
    } else {
      expect(open).toBeDisabled();
      fireEvent.click(open);
      fireEvent.click(within(panel).getByText("build"));
      expect(onSelectSession).not.toHaveBeenCalled();
    }
  });

  it("keeps a manual callback added by another tab while clearing messages is still pending", async () => {
    let finishReview!: () => void;
    const reviewPending = new Promise<void>((resolve) => { finishReview = resolve; });
    const onReviewMessage = vi.fn(() => reviewPending);
    let manualSessions = ["build"];
    let view: ReturnType<typeof renderWithTheme>;
    const onGlobalChange = vi.fn(async (next: string[]) => {
      manualSessions = next;
      view.rerender(renderSnapshot());
    });
    const renderSnapshot = () => (
      <WorkspaceCallbackList
        sessionName="build"
        workspaceId="workspace-one"
        workspaceSessionNames={["build", "new-agent"]}
        sessions={[session("build"), session("new-agent")]}
        callbackSessions={[]}
        onChange={vi.fn(async () => undefined)}
        globalCallbackSnapshot={{
          callbackSessions: manualSessions,
          globalCallbackSessions: manualSessions,
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 1,
          callbackMessages: [callbackMessage("message-build", "build", "Build complete")],
        }}
        onGlobalChange={onGlobalChange}
        onReviewMessage={onReviewMessage}
        onSelectSession={vi.fn()}
      />
    );
    view = renderWithTheme(renderSnapshot());

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear global" }));
    await waitFor(() => expect(onReviewMessage).toHaveBeenCalledWith("message-build"));

    // A refreshed server snapshot arrives while the message review request is pending.
    manualSessions = [...manualSessions, "new-agent"];
    view.rerender(renderSnapshot());
    expect(within(screen.getByRole("dialog", { name: "Callback list" }))
      .getByText("new-agent")).toBeInTheDocument();
    await act(async () => {
      finishReview();
      await reviewPending;
    });

    expect(onGlobalChange).toHaveBeenCalledTimes(1);
    expect(onGlobalChange).toHaveBeenCalledWith([]);
    expect(manualSessions).toContain("new-agent");
    expect(within(screen.getByRole("dialog", { name: "Callback list" }))
      .getByText("new-agent")).toBeInTheDocument();
  });

  it.each(["global", "workspace"] as const)("reviews all messages for a session from the %s scope", async (scope) => {
    const onReviewSession = vi.fn(async () => undefined);
    const onReviewMessage = vi.fn(async () => undefined);
    const onChange = vi.fn(async () => undefined);
    renderWithTheme(
      <WorkspaceCallbackList
        sessionName="agent-one"
        workspaceId="workspace-one"
        workspaceSessionNames={["agent-one"]}
        sessions={[session("agent-one")]}
        callbackSessions={[]}
        onChange={onChange}
        globalCallbackSnapshot={{
          callbackSessions: [],
          globalCallbackSessions: [],
          workspaceCallbacks: [],
          sessionRevision: 0,
          callbackMessageRevision: 1,
          callbackMessages: [callbackMessage("message-one", "agent-one", "Ready for review")],
        }}
        onReviewMessage={onReviewMessage}
        onReviewSession={onReviewSession}
        onSelectSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
    if (scope === "workspace") {
      fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    }
    const panel = screen.getByRole("dialog", { name: "Callback list" });
    fireEvent.click(within(panel).getByRole("button", { name: /^Mark agent-one reviewed/ }));
    await waitFor(() => expect(onReviewSession).toHaveBeenCalledWith("agent-one"));
    expect(onChange).not.toHaveBeenCalled();
    expect(onReviewMessage).not.toHaveBeenCalled();
  });
});
