import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listQueuedMessages, listSessions, subscribeToSessions, updateSessionStar, updateSessionTitle } from "../api";
import type { Pane, Session } from "../types";
import { activePane, classifyPane, SessionDashboard } from "./SessionDashboard";

vi.mock("../api", () => ({
  BASE_PATH: "/mux",
  listSessions: vi.fn(),
  listQueuedMessages: vi.fn(),
  createQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  subscribeToSessions: vi.fn(),
  updateSessionStar: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

function pane(overrides: Partial<Pane> = {}): Pane {
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
    history_limit: 2000,
    alternate_on: false,
    dead: false,
    activity: 1,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    name: "test",
    id: "$1",
    windows: 1,
    attached: 0,
    created: 1,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    panes: [pane()],
    ...overrides,
    queuedMessageCount: overrides.queuedMessageCount ?? 0,
  };
}

function openOrder(): string[] {
  return screen.getAllByRole("button", { name: /^Open / })
    .map((button) => button.getAttribute("aria-label") || "");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(subscribeToSessions).mockReturnValue(vi.fn());
  window.history.replaceState({}, "", "/mux/");
  window.localStorage.clear();
  vi.mocked(listQueuedMessages).mockResolvedValue({ session: "test", messages: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session classification", () => {
  it("recognizes Claude and Codex panes", () => {
    expect(classifyPane(pane({ command: "claude" })).tone).toBe("claude");
    expect(classifyPane(pane({ command: "codex" })).tone).toBe("codex");
  });

  it("selects the server-declared active pane", () => {
    const item = session({
      activePaneId: "%2",
      panes: [pane(), pane({ id: "%2", command: "codex" })],
    });
    expect(activePane(item)?.id).toBe("%2");
  });

  it("manages memoranda from both card and list views without opening the session", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ queuedMessageCount: 2 })]);
    const onOpen = vi.fn();
    render(<SessionDashboard onOpen={onOpen} />);

    const cardAction = await screen.findByRole("button", { name: "Manage memoranda for test" });
    expect(cardAction).toHaveTextContent("2");
    fireEvent.click(cardAction);

    expect(await screen.findByRole("dialog", { name: "Queued messages" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close queued messages" }));

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const rowAction = screen.getByRole("button", { name: "Manage memoranda for test" });
    expect(rowAction.closest(".session-row")).not.toBeNull();
    fireEvent.click(rowAction);
    expect(await screen.findByRole("dialog", { name: "Queued messages" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("offers a query-preserving new-window link without changing default navigation", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?q=work&kind=shells&sort=title,tmux-name",
    );
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "work/name #1", customTitle: "Deploy API" }),
    ]);
    const onOpen = vi.fn();
    render(<SessionDashboard onOpen={onOpen} />);

    const link = await screen.findByRole("link", {
      name: "Open Deploy API in new window",
    });
    expect(link).toHaveAttribute(
      "href",
      "/mux/session/work%2Fname%20%231?q=work&kind=shells&sort=title,tmux-name",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("New window");

    fireEvent.click(screen.getByRole("button", { name: "Open Deploy API" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("work/name #1");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const rowLink = screen.getByRole("link", { name: "Open Deploy API in new window" });
    expect(rowLink.closest(".session-row")).not.toBeNull();
    expect(rowLink).toHaveAttribute(
      "href",
      "/mux/session/work%2Fname%20%231?q=work&kind=shells&view=list&sort=title,tmux-name",
    );
  });

  it("shows human titles and filters agent attention states", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({
        customTitle: "Deploy API",
        agentState: "waiting_human",
        agentStateReason: "Codex is paused",
        panes: [pane({ command: "codex" })],
      }),
      session({
        name: "worker",
        id: "$2",
        agentState: "working",
        agentStateReason: "Live spinner",
        panes: [pane({ command: "claude" })],
      }),
    ]);

    render(<SessionDashboard onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open Deploy API" })).toBeVisible();
    expect(screen.getByText("tmux / test")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Needs input 1/ }));
    expect(screen.getByRole("button", { name: "Open Deploy API" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open worker" })).not.toBeInTheDocument();
  });

  it("saves an optional human title from the card editor", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionTitle).mockResolvedValue("Muxdeck work");
    render(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit title for test" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Muxdeck work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", "Muxdeck work"));
    expect(await screen.findByRole("button", { name: "Open Muxdeck work" })).toBeVisible();
  });

  it("clears a human title and falls back to the tmux session name", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ customTitle: "Old title" })]);
    vi.mocked(updateSessionTitle).mockResolvedValue(null);
    render(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit title for test" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", ""));
    expect(await screen.findByRole("button", { name: "Open test" })).toBeVisible();
  });

  it("filters Claude and Codex independently and switches view modes", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "claude-one", id: "$1", panes: [pane({ command: "claude" })] }),
      session({ name: "codex-one", id: "$2", panes: [pane({ command: "codex" })] }),
      session({ name: "shell-one", id: "$3" }),
    ]);
    const { container } = render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open claude-one" });
    fireEvent.click(screen.getByRole("button", { name: /^claude$/i }));
    expect(screen.getByRole("button", { name: "Open claude-one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open codex-one" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(container.querySelector(".session-list")).toBeInTheDocument();
    expect(window.localStorage.getItem("muxdeck-session-view")).toBe("list");
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(container.querySelector(".session-list")).not.toBeInTheDocument();
  });

  it("hydrates filters, grouping, view, and ordered sorting from the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?q=api&kind=codex&state=waiting_human&view=list&group=state&sort=state,title",
    );
    vi.mocked(listSessions).mockResolvedValue([
      session({
        name: "deploy-api",
        customTitle: "Deploy API",
        agentState: "waiting_human",
        panes: [pane({ command: "codex" })],
      }),
      session({
        name: "deploy-web",
        id: "$2",
        customTitle: "Deploy Web",
        agentState: "working",
        panes: [pane({ command: "codex" })],
      }),
      session({
        name: "claude-api",
        id: "$3",
        customTitle: "Claude API",
        agentState: "waiting_human",
        panes: [pane({ command: "claude" })],
      }),
    ]);
    const { container } = render(<SessionDashboard onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open Deploy API" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Deploy Web" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Claude API" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Find a session" })).toHaveValue("api");
    expect(screen.getByRole("button", { name: /^codex$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Needs input 2/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Group State \/ attention/ })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".session-row")).toBeInTheDocument();
    expect(screen.getByText(/^Order:/)).toHaveTextContent(
      "Order: 1 State (attention first), then 2 Title (A-Z)",
    );
  });

  it("adds, removes, and reorders the visible sort-priority badges", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    const { container } = render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    const badgeLabels = () => [...container.querySelectorAll(".sort-priority-copy strong")]
      .map((element) => element.textContent);
    expect(badgeLabels()).toEqual(["Activity", "Tmux name"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Add sort criterion" }), {
      target: { value: "title" },
    });
    expect(badgeLabels()).toEqual(["Activity", "Tmux name", "Title"]);
    expect(window.location.search).toBe("?sort=activity,tmux-name,title");

    fireEvent.click(screen.getByRole("button", { name: "Remove Activity sort" }));
    expect(badgeLabels()).toEqual(["Tmux name", "Title"]);

    fireEvent.click(screen.getByRole("button", { name: "Move Title earlier" }));
    expect(badgeLabels()).toEqual(["Title", "Tmux name"]);
    expect(screen.getByText(/^Order:/)).toHaveTextContent(
      "Order: 1 Title (A-Z), then 2 Tmux name (A-Z)",
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Tmux name sort" }));
    expect(badgeLabels()).toEqual(["Title"]);
    expect(screen.getByRole("button", { name: "Remove Title sort" })).toBeDisabled();
    expect(window.location.search).toBe("?sort=title");
  });

  it("distinguishes state/title priority and applies the same comparator in cards and lists", async () => {
    window.history.replaceState({}, "", "/mux/?sort=state,title");
    vi.mocked(listSessions).mockResolvedValue([
      session({
        name: "needs-zulu",
        id: "$1",
        customTitle: "Zulu",
        agentState: "waiting_human",
      }),
      session({
        name: "working-alpha",
        id: "$2",
        customTitle: "Alpha",
        agentState: "working",
      }),
      session({
        name: "needs-beta",
        id: "$3",
        customTitle: "Beta",
        agentState: "waiting_human",
      }),
    ]);
    const { container } = render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open Zulu" });
    expect(openOrder()).toEqual(["Open Beta", "Open Zulu", "Open Alpha"]);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(container.querySelector(".session-list")).toBeInTheDocument();
    expect(openOrder()).toEqual(["Open Beta", "Open Zulu", "Open Alpha"]);

    act(() => {
      window.history.pushState({}, "", "/mux/?view=list&sort=title,state");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText(/^Order:/)).toHaveTextContent(
      "Order: 1 Title (A-Z), then 2 State (attention first)",
    );
    expect(openOrder()).toEqual(["Open Alpha", "Open Beta", "Open Zulu"]);

    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(container.querySelector(".session-list")).not.toBeInTheDocument();
    expect(openOrder()).toEqual(["Open Alpha", "Open Beta", "Open Zulu"]);
  });

  it("restores a query-only URL change on popstate without refetching sessions", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "alpha", customTitle: "Alpha task" }),
      session({ name: "beta", id: "$2", customTitle: "Beta task" }),
    ]);
    render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open Alpha task" });
    act(() => {
      window.history.pushState({}, "", "/mux/?q=beta");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("textbox", { name: "Find a session" })).toHaveValue("beta");
    expect(screen.getByRole("button", { name: "Open Beta task" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Alpha task" })).not.toBeInTheDocument();
    expect(listSessions).toHaveBeenCalledOnce();
  });

  it("groups by state separately from globally sorting by newest state change", async () => {
    const now = Math.floor(Date.now() / 1000);
    window.history.replaceState(
      {},
      "",
      "/mux/?view=list&group=state&sort=state-change,tmux-name",
    );
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "needs-old", id: "$1", agentState: "waiting_human", agentStateChangedAt: now - 100 }),
      session({ name: "command", id: "$2", agentState: "waiting_command", agentStateChangedAt: now - 20 }),
      session({ name: "working", id: "$3", agentState: "working", agentStateChangedAt: now - 5 }),
      session({ name: "needs-new", id: "$4", agentState: "waiting_human", agentStateChangedAt: now - 10 }),
      session({ name: "shell", id: "$5", agentState: "other", agentStateChangedAt: now - 1 }),
    ]);
    const { container } = render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open needs-old" });

    const groupLabels = [...container.querySelectorAll(".state-group-header h3")]
      .map((heading) => heading.textContent);
    expect(groupLabels).toEqual(["Needs input", "Working", "Command wait", "Other"]);
    const needsInputOrder = [...container.querySelectorAll(".state-session-group.waiting_human .session-card-main")]
      .map((button) => button.getAttribute("aria-label"));
    expect(needsInputOrder).toEqual(["Open needs-new", "Open needs-old"]);

    fireEvent.click(screen.getByRole("button", { name: /Group State \/ attention/ }));
    expect(container.querySelectorAll(".state-session-group")).toHaveLength(0);
    expect(openOrder()).toEqual([
      "Open shell",
      "Open working",
      "Open needs-new",
      "Open command",
      "Open needs-old",
    ]);
    expect(screen.getAllByText(/^state /)).toHaveLength(5);
  });

  it("keeps visible state-change ages current without a new server event", async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000;
    vi.setSystemTime(now * 1000);
    window.history.replaceState({}, "", "/mux/?view=list&sort=state-change");
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "aging", agentStateChangedAt: now - 59 }),
    ]);
    render(<SessionDashboard onOpen={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("state now")).toBeVisible();

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("state 1m ago")).toBeVisible();
  });

  it("applies pushed session snapshots from the live stream", async () => {
    let streamOptions: Parameters<typeof subscribeToSessions>[0] | undefined;
    vi.mocked(listSessions).mockResolvedValue([session({ name: "initial" })]);
    vi.mocked(subscribeToSessions).mockImplementation((options) => {
      streamOptions = options;
      return vi.fn();
    });
    render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open initial" });
    act(() => {
      streamOptions?.onSessions([session({
        name: "pushed",
        agentState: "waiting_human",
        agentStateChangedAt: 42,
      })]);
    });

    expect(screen.getByRole("button", { name: "Open pushed" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open initial" })).not.toBeInTheDocument();
    expect(screen.getByText(/1 sessions \/ live/i)).toBeVisible();
  });

  it("does not let an older poll overwrite a newer streamed snapshot", async () => {
    let resolvePoll!: (sessions: Session[]) => void;
    let streamOptions: Parameters<typeof subscribeToSessions>[0] | undefined;
    const pendingPoll = new Promise<Session[]>((resolve) => {
      resolvePoll = resolve;
    });
    vi.mocked(listSessions).mockReturnValue(pendingPoll);
    vi.mocked(subscribeToSessions).mockImplementation((options) => {
      streamOptions = options;
      return vi.fn();
    });
    render(<SessionDashboard onOpen={vi.fn()} />);

    act(() => {
      streamOptions?.onSessions([session({ name: "stream-new" })]);
    });
    expect(screen.getByRole("button", { name: "Open stream-new" })).toBeVisible();

    await act(async () => {
      resolvePoll([session({ name: "poll-old" })]);
      await pendingPoll;
    });
    expect(screen.getByRole("button", { name: "Open stream-new" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open poll-old" })).not.toBeInTheDocument();
  });

  it("falls back to polling when the live stream is unavailable", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(subscribeToSessions).mockImplementation(() => {
      throw new Error("SSE unavailable");
    });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const { unmount } = render(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    expect(screen.getByText(/1 sessions \/ polling/i)).toBeVisible();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 4000);

    unmount();
  });

  it("adds and removes sessions from the pinned starred section", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionStar)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    render(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add test to starred" }));
    await waitFor(() => expect(updateSessionStar).toHaveBeenCalledWith("test", true));
    expect(await screen.findByRole("heading", { name: "Starred" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove test from starred" }));
    await waitFor(() => expect(updateSessionStar).toHaveBeenCalledWith("test", false));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Starred" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add test to starred" })).toBeVisible();
  });

  it("does not schedule another refresh when a pending request resolves after unmount", async () => {
    let resolveRequest!: (sessions: Session[]) => void;
    const pendingRequest = new Promise<Session[]>((resolve) => {
      resolveRequest = resolve;
    });
    vi.mocked(listSessions).mockReturnValue(pendingRequest);
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    const { unmount } = render(<SessionDashboard onOpen={vi.fn()} />);
    expect(listSessions).toHaveBeenCalledOnce();

    const signal = vi.mocked(listSessions).mock.calls[0][0];
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolveRequest([session()]);
      await pendingRequest;
    });

    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 4000);
  });
});
