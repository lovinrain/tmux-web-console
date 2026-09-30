import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallbackMessage, GlobalCallbackSnapshot } from "../api";
import { DEFAULT_CALLBACK_LIST_VIEW } from "../callbackListView";
import { renderWithTheme } from "../test-utils";
import { ThemeProvider } from "../theme";
import type { Session } from "../types";
import { CALLBACK_VIEW_STORAGE_KEY, WorkspaceCallbackList } from "./WorkspaceCallbackList";

function session(name: string, state: Session["agentState"] = "waiting_human"): Session {
  return {
    name, id: `id-${name}`, windows: 1, attached: 0, created: 1, serverStarted: 1,
    serverPid: 1, activity: 1, activePaneId: "%1", agentState: state,
    agentStateReason: "test", agentStateChangedAt: 100, customTitle: null,
    tags: [], starred: false, ignored: false, queuedMessageCount: 0, panes: [],
  };
}

function message(id: string, sessionName: string, text = `${sessionName} report`): CallbackMessage {
  return {
    id, sequence: 1, sessionName, message: text, agentType: "codex", cwd: "/project",
    requestId: null, tmuxSessionId: null, tmuxPaneId: null, host: null,
    createdAt: 200, reviewedAt: null,
  };
}

function snapshot(overrides: Partial<GlobalCallbackSnapshot> = {}): GlobalCallbackSnapshot {
  return {
    callbackSessions: [], globalCallbackSessions: [], workspaceCallbacks: [],
    sessionRevision: 0, callbackMessageRevision: 0, callbackMessages: [], ...overrides,
  };
}

function baseProps(overrides: Partial<ComponentProps<typeof WorkspaceCallbackList>> = {}) {
  return {
    sessionName: "current", workspaceId: "one", workspaceName: "Workspace one",
    sessions: [session("current"), session("working", "working")],
    workspaceSessionNames: ["current", "working"], callbackSessions: ["current", "working"],
    onChange: vi.fn(async () => undefined), onSelectSession: vi.fn(), ...overrides,
  };
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: "Show callback list" }));
  return screen.getByRole("dialog", { name: "Callback list" });
}

function changeSelect(name: string, value: string) {
  fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
}

function search(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search callbacks" }), { target: { value } });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  window.localStorage.clear();
});

describe("WorkspaceCallbackList sorting and filtering", () => {
  it("edits custom groups using all scope callbacks even when search hides rows, without changing the queue", async () => {
    const onSaveGroup = vi.fn(async () => undefined);
    const props = baseProps({
      globalCallbackSnapshot: snapshot({
        callbackGroupRevision: 2,
        callbackGroups: [
          { id: "global", name: "Global group", workspaceId: null, sessions: ["current"] },
          { id: "workspace", name: "Workspace group", workspaceId: "one", sessions: ["working"] },
        ],
      }), onSaveGroup, onDeleteGroup: vi.fn(async () => undefined),
    });
    renderWithTheme(<WorkspaceCallbackList {...props} />);
    openList();
    changeSelect("Group callbacks by", "custom");
    expect(screen.getByRole("button", { name: "Global group callback group" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Workspace group callback group" })).not.toBeInTheDocument();
    search("current");
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    expect(screen.getByRole("checkbox", { name: "Include working in group" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom callback group name" }), { target: { value: "Picked" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include working in group" }));
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));
    await waitFor(() => expect(onSaveGroup).toHaveBeenCalledExactlyOnceWith({
      id: undefined, workspaceId: null, name: "Picked", sessions: ["working"], expectedRevision: 2,
    }));
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    expect(screen.getByRole("combobox", { name: "Group callbacks by" })).toHaveValue("custom");
    search("");
    expect(screen.getByRole("button", { name: "Workspace group callback group" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Global group callback group" })).not.toBeInTheDocument();
  });

  it("keeps shared group creation available globally while explaining unsaved workspace scope", () => {
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      workspaceId: null, globalCallbackSnapshot: snapshot({ callbackGroups: [], callbackGroupRevision: 0 }),
      onSaveGroup: vi.fn(async () => undefined), onDeleteGroup: vi.fn(async () => undefined),
    })} />);
    openList();
    changeSelect("Group callbacks by", "custom");
    expect(screen.getByRole("button", { name: "New group" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    changeSelect("Group callbacks by", "custom");
    expect(screen.getByText("Save this workspace to share custom groups, or create them in Global.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New group" })).not.toBeInTheDocument();
  });

  it("shares view preferences and open filters across scopes without storing search text", () => {
    const workspaceKey = "muxdeck.callback-list-view.v1:workspace:one";
    window.localStorage.setItem(workspaceKey, JSON.stringify({
      ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-asc", status: "ready",
    }));
    window.localStorage.setItem("muxdeck.callback-list-view.v1:global", JSON.stringify({
      ...DEFAULT_CALLBACK_LIST_VIEW, sort: "callback-newest", group: "status",
    }));
    const props = baseProps({ globalCallbackSnapshot: snapshot(), onGlobalChange: vi.fn(async () => undefined) });
    const view = renderWithTheme(<WorkspaceCallbackList {...props} />);
    openList();
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("callback-newest");
    expect(screen.getByRole("combobox", { name: "Group callbacks by" })).toHaveValue("status");
    changeSelect("Filter callbacks by status", "working");
    fireEvent.click(screen.getByRole("button", { name: "More callback filters" }));
    changeSelect("Filter callbacks by agent", "claude");
    search("temporary-private-search");
    expect(JSON.parse(window.localStorage.getItem(CALLBACK_VIEW_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_CALLBACK_LIST_VIEW, sort: "callback-newest", group: "status", status: "working", agent: "claude",
    });

    fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("callback-newest");
    expect(screen.getByRole("combobox", { name: "Group callbacks by" })).toHaveValue("status");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("working");
    expect(screen.getByRole("searchbox", { name: "Search callbacks" })).toHaveValue("temporary-private-search");
    expect(screen.getByRole("button", { name: "More callback filters" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by agent" })).toHaveValue("claude");
    changeSelect("Filter callbacks by status", "waiting");
    expect(JSON.parse(window.localStorage.getItem(CALLBACK_VIEW_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_CALLBACK_LIST_VIEW, sort: "callback-newest", group: "status", status: "waiting", agent: "claude",
    });

    fireEvent.click(screen.getByRole("button", { name: "Global callback scope" }));
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("callback-newest");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("waiting");
    expect(screen.getByRole("button", { name: "More callback filters" })).toHaveTextContent("(1)");
    fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    view.unmount();
    renderWithTheme(<WorkspaceCallbackList {...props} />);
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("callback-newest");
    expect(screen.getByRole("combobox", { name: "Group callbacks by" })).toHaveValue("status");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("waiting");
    expect(screen.getByRole("searchbox", { name: "Search callbacks" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "More callback filters" }));
    expect(screen.getByRole("combobox", { name: "Filter callbacks by agent" })).toHaveValue("claude");
  });

  it("keeps the same view when switching between saved and temporary workspaces", () => {
    const otherWorkspaceKey = "muxdeck.callback-list-view.v1:workspace:two";
    window.localStorage.setItem(otherWorkspaceKey, JSON.stringify({
      ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-desc", status: "working",
    }));
    const props = baseProps();
    const view = renderWithTheme(<WorkspaceCallbackList {...props} />);
    openList();
    changeSelect("Sort callbacks", "ready-longest");
    changeSelect("Filter callbacks by status", "ready");
    search("private search");
    view.rerender(<ThemeProvider><WorkspaceCallbackList {...props} workspaceId="two" /></ThemeProvider>);
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("ready-longest");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("ready");
    expect(screen.getByRole("searchbox", { name: "Search callbacks" })).toHaveValue("private search");
    view.rerender(<ThemeProvider><WorkspaceCallbackList {...props} workspaceId={null} temporaryKey="another" /></ThemeProvider>);
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("ready-longest");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("ready");
    expect(screen.getByRole("searchbox", { name: "Search callbacks" })).toHaveValue("private search");
    expect(JSON.parse(window.localStorage.getItem(CALLBACK_VIEW_STORAGE_KEY)!))
      .toEqual({ ...DEFAULT_CALLBACK_LIST_VIEW, sort: "ready-longest", status: "ready" });
    expect(JSON.parse(window.localStorage.getItem(otherWorkspaceKey)!))
      .toEqual({ ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-desc", status: "working" });
  });

  it.each(["global", "workspace"] as const)("clears only displayed %s callbacks and their messages", async (scope) => {
    const onChange = vi.fn(async () => undefined);
    const onGlobalChange = vi.fn(async () => undefined);
    const onReviewMessage = vi.fn(async (_id: string) => undefined);
    const onReviewSession = vi.fn(async () => undefined);
    const callbackMessages = [
      message("shown-1", "shown", "Selected report"),
      message("hidden-1", "hidden", "Protected report"),
      message("shown-2", "shown", "Another report in the same session"),
    ];
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      sessionName: "shown", sessions: [session("shown"), session("hidden")],
      workspaceSessionNames: ["shown", "hidden"], callbackSessions: ["shown", "hidden"],
      globalCallbackSnapshot: snapshot({ globalCallbackSessions: ["shown", "hidden"], callbackMessages }),
      onChange, onGlobalChange, onReviewMessage, onReviewSession,
    })} />);
    openList();
    if (scope === "workspace") fireEvent.click(screen.getByRole("button", { name: "Workspace callback scope" }));
    search("shown");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2 shown");
    expect(screen.getByRole("button", { name: "Hide callback list" })).toHaveTextContent("Global 2/2");
    expect(screen.getByRole("button", { name: "Hide callback list" })).toHaveTextContent("Local 2/2");
    expect(screen.queryByText("Protected report")).not.toBeInTheDocument();
    expect(screen.getByText("Another report in the same session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear shown" }));
    await waitFor(() => expect(onReviewMessage).toHaveBeenCalledTimes(2));
    expect(onReviewMessage.mock.calls.map(([id]) => id)).toEqual(["shown-1", "shown-2"]);
    expect(scope === "global" ? onGlobalChange : onChange).toHaveBeenCalledExactlyOnceWith(["hidden"]);
    expect(scope === "global" ? onChange : onGlobalChange).not.toHaveBeenCalled();
    expect(onReviewSession).not.toHaveBeenCalled();
  });

  it("clears only displayed ended callbacks while preserving hidden ended and displayed live sessions", async () => {
    const onChange = vi.fn(async () => undefined);
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      sessionName: "live-shown", sessions: [session("live-shown")],
      callbackSessions: ["ended-shown", "ended-hidden", "live-shown"], onChange,
    })} />);
    openList();
    search("shown");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3 shown");
    fireEvent.click(screen.getByRole("button", { name: "Clear ended shown" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(["ended-hidden", "live-shown"]));
  });

  it("keeps hidden callbacks out of Add options and preserves them when adding a new session", async () => {
    const onChange = vi.fn(async () => undefined);
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      sessionName: "hidden-working", sessions: [
        session("shown-ready"), session("hidden-working", "working"), session("new-session"),
      ], callbackSessions: ["shown-ready", "hidden-working"], onChange,
    })} />);
    openList();
    changeSelect("Filter callbacks by status", "ready");
    expect(screen.queryByRole("button", { name: "Open hidden-working" })).not.toBeInTheDocument();
    const choices = screen.getByRole("combobox", { name: "Choose a session to watch" });
    expect(within(choices).queryByRole("option", { name: "hidden-working" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current" })).toBeDisabled();
    fireEvent.change(choices, { target: { value: "new-session" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChange)
      .toHaveBeenCalledExactlyOnceWith(["shown-ready", "hidden-working", "new-session"]));
  });

  it("filters callbacks for replaced session IDs as ended before applying live status or agent filters", () => {
    const oldMessage = { ...message("old", "reused"), tmuxSessionId: "$old", agentType: "claude" };
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      sessionName: "reused", sessions: [{ ...session("reused"), id: "$new", agentType: "codex" }],
      workspaceSessionNames: ["reused"], callbackSessions: [],
      globalCallbackSnapshot: snapshot({ callbackMessages: [oldMessage] }),
    })} />);
    openList();
    changeSelect("Filter callbacks by status", "ready");
    expect(screen.getByText("No callbacks match these filters")).toBeInTheDocument();
    changeSelect("Filter callbacks by status", "ended");
    expect(screen.getByRole("button", { name: "Open reused" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More callback filters" }));
    changeSelect("Filter callbacks by agent", "claude");
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 shown");
    changeSelect("Filter callbacks by agent", "codex");
    expect(screen.getByRole("status")).toHaveTextContent("0 of 1 shown");
  });

  it("matches the Global only location label for message-only callbacks outside workspace tabs", () => {
    renderWithTheme(<WorkspaceCallbackList {...baseProps({
      sessionName: "current", callbackSessions: [], workspaceSessionNames: ["current"],
      sessions: [session("current"), session("message-only"), session("global-marker"), session("workspace-owned")],
      globalCallbackSnapshot: snapshot({
        globalCallbackSessions: ["current", "global-marker"],
        callbackMessages: [message("pending-only", "message-only", "Unassigned callback report")],
        workspaceCallbacks: [{ workspaceId: "another", workspaceName: "Other workspace", sessions: ["workspace-owned"] }],
      }),
    })} />);
    openList();
    expect(within(screen.getByRole("button", { name: "Open current" }).closest("li")!)
      .getByText("This workspace")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Open workspace-owned" }).closest("li")!)
      .getByText("Other · Other workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More callback filters" }));
    changeSelect("Filter callbacks by location", "global-only");

    expect(screen.getByRole("status")).toHaveTextContent("2 of 4 shown");
    expect(screen.getByText("Unassigned callback report")).toBeInTheDocument();
    for (const name of ["message-only", "global-marker"]) {
      expect(within(screen.getByRole("button", { name: `Open ${name}` }).closest("li")!)
        .getByText("Global only")).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Open current" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open workspace-owned" })).not.toBeInTheDocument();
  });

  it("resets a no-match view to the full queue while keeping the selected sort", () => {
    renderWithTheme(<WorkspaceCallbackList {...baseProps()} />);
    openList();
    changeSelect("Sort callbacks", "name-desc");
    changeSelect("Filter callbacks by status", "ready");
    fireEvent.click(screen.getByRole("button", { name: "More callback filters" }));
    changeSelect("Filter callbacks by messages", "with-messages");
    changeSelect("Filter callbacks by location", "other");
    search("does not exist");
    expect(screen.getByText("No callbacks match these filters")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear shown" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all callbacks" }));
    expect(screen.getByRole("searchbox", { name: "Search callbacks" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Sort callbacks" })).toHaveValue("name-desc");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by status" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by messages" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Filter callbacks by location" })).toHaveValue("all");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 shown");
    expect(within(screen.getByRole("list", { name: "Sessions to call back" })).getAllByRole("listitem")
      .map((item) => item.querySelector(".workspace-callback-session strong")?.textContent))
      .toEqual(["working", "current"]);
    expect(screen.queryByRole("button", { name: "Reset callback filters" })).not.toBeInTheDocument();
  });
});
