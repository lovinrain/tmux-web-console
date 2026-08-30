import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteWorkspace,
  getSnippetTree,
  listQueuedMessages,
  listSessions,
  listWorkspaces,
  subscribeToSessions,
  updateSessionDetails,
  updateSessionIgnored,
  updateSessionStar,
  updateSessionWorkspacePin,
  updateSessionTags,
  updateSessionTitle,
  type SavedWorkspace,
} from "../api";
import { renderWithTheme } from "../test-utils";
import type { Pane, QueuedMessage, Session } from "../types";
import { activePane, classifyPane, SessionDashboard } from "./SessionDashboard";

vi.mock("../api", () => ({
  BASE_PATH: "/mux",
  listSessions: vi.fn(),
  listQueuedMessages: vi.fn(),
  createQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getSnippetTree: vi.fn(),
  subscribeToSessions: vi.fn(),
  updateSessionDetails: vi.fn(),
  updateSessionIgnored: vi.fn(),
  updateSessionStar: vi.fn(),
  updateSessionWorkspacePin: vi.fn(),
  updateSessionTags: vi.fn(),
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
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    ignored: false,
    panes: [pane()],
    ...overrides,
    tags: overrides.tags ?? [],
    queuedMessageCount: overrides.queuedMessageCount ?? 0,
  };
}

function openOrder(): string[] {
  return screen.getAllByRole("button", { name: /^Open / })
    .map((button) => button.getAttribute("aria-label") || "");
}

function deferredAttentionUpdate() {
  let resolve!: (value: Pick<Session, "starred" | "ignored">) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Pick<Session, "starred" | "ignored">>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(subscribeToSessions).mockReturnValue(vi.fn());
  window.history.replaceState({}, "", "/mux/");
  window.localStorage.clear();
  vi.mocked(listQueuedMessages).mockResolvedValue({ session: "test", messages: [] });
  vi.mocked(getSnippetTree).mockResolvedValue({ revision: 1, tree: [] });
  vi.mocked(listWorkspaces).mockResolvedValue([]);
  vi.mocked(deleteWorkspace).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session classification", () => {
  it("recognizes Claude, Codex, Copilot, Cursor, and Grok panes", () => {
    expect(classifyPane(pane({ command: "claude" })).tone).toBe("claude");
    expect(classifyPane(pane({ command: "codex" })).tone).toBe("codex");
    expect(classifyPane(pane({ command: "copilot" }))).toEqual({
      label: "Copilot",
      tone: "copilot",
    });
    expect(classifyPane(pane({ command: "node", title: "GitHub Copilot" }))).toEqual({
      label: "Copilot",
      tone: "copilot",
    });
    expect(classifyPane(pane({ command: "NODE", title: "project - github copilot" })))
      .toEqual({ label: "Copilot", tone: "copilot" });
    expect(classifyPane(pane({ command: "copilot-agent" })).tone).toBe("process");
    expect(classifyPane(pane({ command: "node", title: "GitHub Copilot preview" })).tone)
      .toBe("process");
    expect(classifyPane(pane({ command: "bash", title: "GitHub Copilot" })).tone)
      .toBe("shell");
    expect(classifyPane(pane({ command: "agent" })).label).toBe("Cursor");
    expect(classifyPane(pane({ command: "cursor-agent" })).tone).toBe("cursor");
    expect(classifyPane(pane({ command: "grok" }))).toEqual({
      label: "Grok",
      tone: "grok",
    });
  });

  it("selects the server-declared active pane", () => {
    const item = session({
      activePaneId: "%2",
      panes: [pane(), pane({ id: "%2", command: "codex" })],
    });
    expect(activePane(item)?.id).toBe("%2");
  });

  it("offers same-page and new-window session creation actions", () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    const onNewSession = vi.fn();
    renderWithTheme(
      <SessionDashboard
        onOpen={vi.fn()}
        onNewSession={onNewSession}
        newSessionWindowHref="/mux/sessions/new?q=deploy&tab=leak&workspace=saved-id"
      />,
    );

    const primary = screen.getByRole("button", { name: "New session" });
    expect(primary.closest(".dashboard-intro")).not.toBeNull();
    fireEvent.click(primary);
    expect(onNewSession).toHaveBeenCalledOnce();

    const newWindow = screen.getByRole("link", {
      name: "Open new session in new window",
    });
    expect(newWindow).toHaveAttribute("href", "/mux/sessions/new?q=deploy");
    expect(newWindow).toHaveAttribute("target", "_blank");
    expect(newWindow).toHaveAttribute("rel", "noopener noreferrer");
    expect(newWindow).toHaveTextContent("New window");
    expect(screen.queryByRole("button", { name: /Resume workspace/ })).not.toBeInTheDocument();
  });

  it("offers a return to the preserved workspace with its tab count and target", () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    const onResumeWorkspace = vi.fn();
    renderWithTheme(
      <SessionDashboard
        onOpen={vi.fn()}
        onResumeWorkspace={onResumeWorkspace}
        workspaceReturnSession="work/name #1"
        workspaceTabCount={3}
      />,
    );

    const resume = screen.getByRole("button", {
      name: "Resume workspace at work/name #1, 3 open tabs",
    });
    expect(resume.closest(".dashboard-intro")).not.toBeNull();
    expect(resume).toHaveTextContent("Resume workspace");
    expect(resume).toHaveTextContent("Resume at · work/name #1");
    expect(resume).toHaveTextContent("3 tabs");

    fireEvent.click(resume);
    expect(onResumeWorkspace).toHaveBeenCalledOnce();
  });

  it("renders server workspaces between the intro and sessions and forwards actions", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?q=release&tab=stale-tab&workspace=stale-workspace",
    );
    const savedWorkspace: SavedWorkspace = {
      id: "saved-id",
      name: "Release room",
      tabs: ["api", "web"],
      groups: [{
        id: "release-group",
        name: "Release lane",
        color: "green",
        collapsed: false,
        tabs: ["api", "web"],
      }],
      activeSession: "web",
      sessionRevision: 0,
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 60_000,
      lastActiveAt: Date.now() - 60_000,
    };
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(listWorkspaces).mockResolvedValue([savedWorkspace]);
    const onOpenSavedWorkspace = vi.fn();
    const onSavedWorkspaceDeleted = vi.fn();
    renderWithTheme(
      <SessionDashboard
        onOpen={vi.fn()}
        currentWorkspaceTabs={["current-api", "current-web"]}
        currentWorkspaceGroups={[{
          id: "current-group",
          name: "Current lane",
          color: "cyan",
          collapsed: true,
          tabs: ["current-api", "current-web"],
        }]}
        activeSession="current-web"
        activeWorkspaceId="saved-id"
        onOpenSavedWorkspace={onOpenSavedWorkspace}
        onSavedWorkspaceDeleted={onSavedWorkspaceDeleted}
      />,
    );

    const workspaceHeading = await screen.findByRole("heading", { name: "Saved workspaces" });
    const workspaceSection = workspaceHeading.closest(".saved-workspaces");
    const intro = document.querySelector(".dashboard-intro");
    const controls = screen.getByRole("region", { name: "Session filters" });
    expect(intro?.compareDocumentPosition(workspaceSection as Node)
      ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(workspaceSection?.compareDocumentPosition(controls)
      ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(workspaceSection as HTMLElement).getByText("Current")).toBeVisible();
    expect(within(workspaceSection as HTMLElement).queryByLabelText("1 tab group"))
      .not.toBeInTheDocument();
    expect(screen.getByText("03 / SESSIONS")).toBeVisible();

    const workspaceWindowLink = screen.getByRole("link", {
      name: "Open workspace Release room in new window",
    });
    const workspaceWindowUrl = new URL(
      workspaceWindowLink.getAttribute("href") || "",
      "https://muxdeck.test",
    );
    expect(workspaceWindowUrl.pathname).toBe("/mux/session/web");
    expect(workspaceWindowUrl.searchParams.get("q")).toBe("release");
    expect(workspaceWindowUrl.searchParams.getAll("tab")).toEqual(["api", "web"]);
    expect(workspaceWindowUrl.searchParams.get("workspace")).toBe("saved-id");
    expect(workspaceWindowUrl.searchParams.getAll("tab-group").map((value) => (
      JSON.parse(value)
    ))).toEqual(savedWorkspace.groups);
    expect(workspaceWindowLink).toHaveAttribute("target", "_blank");
    expect(workspaceWindowLink).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("radio", { name: /Start fresh/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Copy current tabs/ })).not.toBeChecked();
    expect(screen.getByText("Copy 2 open tabs in the current order."))
      .toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Resume workspace Release room" }));
    expect(onOpenSavedWorkspace).toHaveBeenCalledWith(savedWorkspace);

    fireEvent.click(screen.getByRole("button", { name: "Delete workspace Release room" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workspace",
    }));
    await waitFor(() => expect(onSavedWorkspaceDeleted).toHaveBeenCalledWith("saved-id"));
  });

  it("uses the base-path new-session route for the default window link", () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    expect(screen.getByRole("link", {
      name: "Open new session in new window",
    })).toHaveAttribute("href", "/mux/sessions/new");
  });

  it("keeps current dashboard filters but isolates quick tabs in the default new-window link", () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?kind=shells&tab=alpha&workspace=saved-id&view=list&tab=beta",
    );
    vi.mocked(listSessions).mockResolvedValue([]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    expect(screen.getByRole("link", {
      name: "Open new session in new window",
    })).toHaveAttribute("href", "/mux/sessions/new?kind=shells&view=list");
  });

  it("manages memoranda from both card and list views without opening the session", async () => {
    const messages: QueuedMessage[] = [
      {
        id: "queued-1",
        text: "Run the focused tests",
        state: "queued",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        position: 0,
      },
      {
        id: "queued-2",
        text: "Check the deployment",
        state: "queued",
        createdAt: 1_700_000_001_000,
        updatedAt: 1_700_000_001_000,
        position: 1,
      },
      {
        id: "note-1",
        text: "Possible follow-up",
        state: "note",
        createdAt: 1_700_000_002_000,
        updatedAt: 1_700_000_002_000,
        position: 2,
      },
      {
        id: "note-2",
        text: "Scratch result",
        state: "note",
        createdAt: 1_700_000_003_000,
        updatedAt: 1_700_000_003_000,
        position: 3,
      },
    ];
    vi.mocked(listSessions).mockResolvedValue([session({
      memorandumCount: 4,
      queuedMessageCount: 2,
    })]);
    vi.mocked(listQueuedMessages).mockResolvedValue({ session: "test", messages });
    const onOpen = vi.fn();
    renderWithTheme(<SessionDashboard onOpen={onOpen} />);

    const cardAction = await screen.findByRole("button", {
      name: "Manage memoranda for test, 2 queued",
    });
    expect(screen.getByRole("button", { name: "Light theme" })).toBeVisible();
    expect(cardAction).toHaveTextContent("Q2");
    expect(cardAction).toHaveClass("has-queued");
    fireEvent.click(cardAction);

    expect(await screen.findByRole("dialog", { name: "Memo" })).toBeVisible();
    expect(screen.getByText(/4 SAVED · 2 QUEUED/)).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close memo" }));

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const rowAction = screen.getByRole("button", {
      name: "Manage memoranda for test, 2 queued",
    });
    expect(rowAction.closest(".session-row")).not.toBeNull();
    fireEvent.click(rowAction);
    expect(await screen.findByRole("dialog", { name: "Memo" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stages a chosen snippet from cards and lists without sending it", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 2,
      tree: [{ id: "review", type: "snippet", name: "Review diff", text: "review\nthe diff" }],
    });
    const onOpen = vi.fn();
    renderWithTheme(<SessionDashboard onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use snippet with test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("test"));
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test")).toBe("review\nthe diff");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const rowAction = screen.getByRole("button", { name: "Use snippet with test" });
    expect(rowAction.closest(".session-row")).not.toBeNull();
    fireEvent.click(rowAction);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  });

  it("confirms the exact session identity from card and List terminate controls", async () => {
    const target = session({
      id: "$19",
      created: 19,
      serverStarted: 20,
      serverPid: 21,
      customTitle: "Release worker",
    });
    const hiddenIgnored = session({ name: "ignored", id: "$ignored", ignored: true });
    vi.mocked(listSessions).mockResolvedValue([target, hiddenIgnored]);
    const onOpen = vi.fn();
    const onSessionTerminated = vi.fn(async () => {});
    renderWithTheme(
      <SessionDashboard
        onOpen={onOpen}
        onSessionTerminated={onSessionTerminated}
      />,
    );

    const cardTerminate = await screen.findByRole("button", {
      name: "Terminate Release worker tmux session",
    });
    expect(cardTerminate).toHaveAttribute("aria-haspopup", "dialog");
    cardTerminate.focus();
    fireEvent.click(cardTerminate);
    expect(screen.getByRole("alertdialog", { name: "Terminate tmux session?" }))
      .toHaveTextContent("Release worker");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cardTerminate).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const rowTerminate = screen.getByRole("button", {
      name: "Terminate Release worker tmux session",
    });
    expect(rowTerminate.closest(".session-row")).not.toBeNull();
    fireEvent.click(rowTerminate);
    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));

    await waitFor(() => expect(onSessionTerminated).toHaveBeenCalledWith(
      "test",
      "$19",
      19,
      20,
      21,
    ));
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Open Release worker",
    })).not.toBeInTheDocument());
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Find a session",
    })).toHaveFocus());
  });

  it("ignores stale updates for a terminated identity but accepts a same-name replacement", async () => {
    const target = session({ id: "$old", created: 19, customTitle: "Old worker" });
    const replacement = session({ id: "$new", created: 20, customTitle: "New worker" });
    let publishSessions = (_sessions: Session[]) => {};
    vi.mocked(listSessions).mockResolvedValue([target]);
    vi.mocked(subscribeToSessions).mockImplementation(({ onSessions }) => {
      publishSessions = onSessions;
      return vi.fn();
    });
    renderWithTheme(
      <SessionDashboard
        onOpen={vi.fn()}
        onSessionTerminated={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "Terminate Old worker tmux session",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Open Old worker",
    })).not.toBeInTheDocument());

    act(() => publishSessions([target]));
    expect(screen.queryByRole("button", { name: "Open Old worker" }))
      .not.toBeInTheDocument();

    act(() => publishSessions([replacement]));
    expect(screen.getByRole("button", { name: "Open New worker" })).toBeVisible();
  });

  it("keeps the snippet picker open when browser draft storage is unavailable", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "review", type: "snippet", name: "Review diff", text: "review the diff" }],
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });
    const onOpen = vi.fn();
    renderWithTheme(<SessionDashboard onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use snippet with test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved in this browser");
    expect(screen.getByRole("dialog", { name: "Stage a snippet for test" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("quietly retains the picker when replacing an existing draft is cancelled", async () => {
    window.localStorage.setItem("muxdeck-terminal-draft:test", "keep this draft");
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "review", type: "snippet", name: "Review diff", text: "replacement" }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onOpen = vi.fn();
    renderWithTheme(<SessionDashboard onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use snippet with test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Stage a snippet for test" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("muxdeck-terminal-draft:test")).toBe("keep this draft");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("isolates new-window quick tabs while preserving the dashboard query", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?q=work&tab=alpha&kind=shells&workspace=saved-id&tab=beta&sort=title,tmux-name",
    );
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "work/name #1", customTitle: "Deploy API" }),
    ]);
    const onOpen = vi.fn();
    renderWithTheme(<SessionDashboard onOpen={onOpen} />);

    const link = await screen.findByRole("link", {
      name: "Open Deploy API in new window",
    }) as HTMLAnchorElement;
    expect(link).toHaveAttribute(
      "href",
      "/mux/session/work%2Fname%20%231?q=work&kind=shells&sort=title,tmux-name",
    );
    expect(new URL(link.href).searchParams.getAll("tab")).toEqual([]);
    expect(new URL(link.href).searchParams.has("workspace")).toBe(false);
    expect(new URL(window.location.href).searchParams.getAll("tab")).toEqual([
      "alpha",
      "beta",
    ]);
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

  it("keeps ordered workspace tabs canonical when dashboard controls update the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?tab=space%20name&tab=plus%2Bname",
    );
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    fireEvent.click(screen.getByRole("button", { name: "List" }));

    expect(window.location.search).toBe(
      "?view=list&tab=space%20name&tab=plus%2Bname",
    );
    expect(new URLSearchParams(window.location.search).getAll("tab")).toEqual([
      "space name",
      "plus+name",
    ]);
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

    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open Deploy API" })).toBeVisible();
    expect(screen.getByText("tmux / test")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Needs input 1/ }));
    expect(screen.getByRole("button", { name: "Open Deploy API" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open worker" })).not.toBeInTheDocument();
  });

  it.each(["command-wait", "background-work"])(
    "filters and canonicalizes the %s state alias",
    async (stateAlias) => {
      window.history.replaceState({}, "", `/mux/?state=${stateAlias}`);
      vi.mocked(listSessions).mockResolvedValue([
        session({
          name: "background",
          agentState: "waiting_command",
          agentStateReason: "Agent is waiting for background work",
        }),
        session({ name: "foreground", id: "$2", agentState: "working" }),
      ]);

      renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

      const background = await screen.findByRole("button", { name: "Open background" });
      expect(background).toHaveAccessibleDescription("Background work");
      expect(screen.queryByRole("button", { name: "Open foreground" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Background work 1/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(window.location.search).toBe("?state=waiting_command");
    },
  );

  it("saves an optional human title from the card editor", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionTitle).mockResolvedValue("Muxdeck work");
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit title and tags for test" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Muxdeck work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", "Muxdeck work"));
    expect(await screen.findByRole("button", { name: "Open Muxdeck work" })).toBeVisible();
  });

  it("keeps keyboard focus inside the session details dialog", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ customTitle: "Existing" })]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit title and tags for test",
    }));
    const close = screen.getByRole("button", { name: "Close session details" });
    const save = screen.getByRole("button", { name: "Save details" });

    save.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
  });

  it("clears a human title and falls back to the tmux session name", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ customTitle: "Old title" })]);
    vi.mocked(updateSessionTitle).mockResolvedValue(null);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit title and tags for test" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear title" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", ""));
    expect(await screen.findByRole("button", { name: "Open test" })).toBeVisible();
  });

  it("edits predefined tags with the title and renders compact badges", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ tags: ["work"] })]);
    vi.mocked(updateSessionTags).mockResolvedValue(["work", "urgent"]);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    expect(screen.getByRole("button", { name: "Open test" }))
      .toHaveAccessibleDescription(/Tags: Work/);
    expect(container.querySelector(".session-tag.tag-work")).toHaveTextContent("Work");
    fireEvent.click(screen.getByRole("button", { name: "Edit title and tags for test" }));
    expect(screen.getByRole("checkbox", { name: "Work" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionTags).toHaveBeenCalledWith(
      "test",
      ["work", "urgent"],
    ));
    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tag.tag-urgent")).toHaveTextContent("Urgent");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(container.querySelector(".session-row .session-tag.tag-work")).toBeVisible();
    expect(container.querySelector(".session-row .session-tag.tag-urgent")).toBeVisible();
  });

  it("persists simultaneous title and tag edits atomically", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ tags: ["work"] })]);
    vi.mocked(updateSessionDetails).mockResolvedValue({
      customTitle: "Release review",
      tags: ["work", "urgent"],
    });
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit title and tags for test",
    }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Release review" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionDetails).toHaveBeenCalledWith(
      "test",
      "Release review",
      ["work", "urgent"],
    ));
    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(updateSessionTags).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open Release review" })).toBeVisible();
  });

  it("returns focus to search when a tag edit filters out its card", async () => {
    window.history.replaceState({}, "", "/mux/?tag=work");
    vi.mocked(listSessions).mockResolvedValue([session({ tags: ["work"] })]);
    vi.mocked(updateSessionTags).mockResolvedValue([]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit title and tags for test",
    }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open test" }))
      .not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Find a session" }))
      .toHaveFocus());
  });

  it("keeps the tag editor open and existing badges intact when persistence fails", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ tags: ["review"] })]);
    vi.mocked(updateSessionTags).mockRejectedValue(new Error("metadata disk is unavailable"));
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit title and tags for test",
    }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("metadata disk is unavailable");
    expect(screen.getByRole("dialog", { name: "Edit title and tags" })).toBeVisible();
    expect(container.querySelector(".session-tag.tag-review")).toBeVisible();
    expect(container.querySelector(".session-tag.tag-work")).not.toBeInTheDocument();
  });

  it("includes any selected tag and hard-excludes reverse matches from every section", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "work", id: "$work", tags: ["work"] }),
      session({ name: "review", id: "$review", tags: ["review"] }),
      session({ name: "pinned", id: "$pinned", starred: true, tags: ["work", "urgent"] }),
      session({ name: "ignored", id: "$ignored", ignored: true, tags: ["blocked"] }),
    ]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open work" });
    fireEvent.click(screen.getByRole("button", { name: /^Add Work include filter,/ }));
    expect(window.location.search).toBe("?tag=work");
    expect(screen.getByRole("button", { name: "Open work" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open pinned" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open ignored", hidden: true }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Add Review include filter,/ }));
    expect(window.location.search).toBe("?tag=work&tag=review");
    expect(screen.getByRole("button", { name: "Open review" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Exclude matches" }));
    expect(window.location.search).toBe("?not-tag=work&not-tag=review");
    expect(screen.queryByRole("button", { name: "Open work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open pinned" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open review" })).not.toBeInTheDocument();

    const includeMode = screen.getByRole("button", { name: "Include matches" });
    expect(includeMode).not.toHaveAttribute("aria-pressed");
    fireEvent.click(includeMode);
    expect(window.location.search).toBe("?tag=work&tag=review");
    expect(screen.getByRole("button", { name: "Open work" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open pinned" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open review" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Exclude matches" }));
    expect(window.location.search).toBe("?not-tag=work&not-tag=review");
    fireEvent.click(screen.getByRole("button", { name: /^Remove Review exclude filter,/ }));
    expect(window.location.search).toBe("?not-tag=work");
    expect(screen.getByRole("button", { name: "Open review" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear tag filters" }));
    fireEvent.click(screen.getByRole("button", { name: /^Add Blocked exclude filter,/ }));
    expect(window.location.search).toBe("?not-tag=blocked");
    expect(screen.queryByRole("button", { name: "Open ignored", hidden: true }))
      .not.toBeInTheDocument();
    expect(screen.getByText("1 starred / 2 filtered / 0 ignored")).toBeVisible();
  });

  it("groups by every assigned tag while keeping the result count unique", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "multi", tags: ["work", "urgent"] }),
      session({ name: "plain", id: "$plain" }),
    ]);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open multi" });
    fireEvent.click(screen.getByRole("button", { name: /Group Tags \/ labels/ }));

    expect(window.location.search).toBe("?group=tag");
    expect([...container.querySelectorAll(".tag-session-group .state-group-header h3")]
      .map((heading) => heading.textContent)).toEqual(["Work", "Urgent", "Untagged"]);
    expect(screen.getAllByRole("button", { name: "Open multi" })).toHaveLength(2);
    expect(screen.getByText("0 starred / 2 filtered / 0 ignored")).toBeVisible();
  });

  it("filters Claude and Codex independently and switches view modes", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "claude-one", id: "$1", panes: [pane({ command: "claude" })] }),
      session({ name: "codex-one", id: "$2", panes: [pane({ command: "codex" })] }),
      session({ name: "shell-one", id: "$3" }),
    ]);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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

  it("keeps Cursor, Copilot, and Grok sessions under their own and the Agents chips", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "cursor-one", id: "$1", panes: [pane({ command: "agent" })] }),
      session({
        name: "copilot-one",
        id: "$2",
        panes: [pane({ command: "node", title: "~/work - GitHub Copilot" })],
      }),
      session({ name: "grok-one", id: "$3", panes: [pane({ command: "grok" })] }),
      session({ name: "codex-one", id: "$4", panes: [pane({ command: "codex" })] }),
      session({
        name: "node-lookalike",
        id: "$5",
        panes: [pane({ command: "node", title: "GitHub Copilot dashboard" })],
      }),
    ]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open cursor-one" });
    fireEvent.click(screen.getByRole("button", { name: /^agents$/i }));
    expect(screen.getByRole("button", { name: "Open cursor-one" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open copilot-one" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open grok-one" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open codex-one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open node-lookalike" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cursor$/i }));
    expect(screen.getByRole("button", { name: "Open cursor-one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open copilot-one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open grok-one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open codex-one" })).not.toBeInTheDocument();

    const copilotFilter = screen.getByRole("button", { name: /^copilot$/i });
    fireEvent.click(copilotFilter);
    expect(copilotFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open copilot-one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open cursor-one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open node-lookalike" })).not.toBeInTheDocument();
    const copilotBadge = screen.getByText("Copilot", { selector: ".agent-badge" });
    expect(copilotBadge).toHaveClass("agent-badge", "copilot");

    fireEvent.click(screen.getByRole("button", { name: /^grok$/i }));
    expect(screen.getByRole("button", { name: "Open grok-one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open cursor-one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open copilot-one" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open codex-one" })).not.toBeInTheDocument();
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
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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

  it("restores included and excluded tags from browser history without refetching", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ name: "work", tags: ["work"] }),
      session({ name: "blocked", id: "$2", tags: ["blocked"] }),
    ]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open work" });
    act(() => {
      window.history.pushState({}, "", "/mux/?not-tag=work&tag=blocked");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("button", { name: "Open work" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open blocked" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Change Blocked to exclude filter,/ }))
      .not.toHaveAttribute("aria-pressed");
    expect(screen.getByRole("button", { name: /^Remove Work exclude filter,/ }))
      .not.toHaveAttribute("aria-pressed");
    expect(listSessions).toHaveBeenCalledOnce();
  });

  it("canonicalizes tag aliases and conflicts restored from browser history", async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ tags: ["work"] })]);
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    act(() => {
      window.history.pushState(
        {},
        "",
        "/mux/?tag=URGENT,work&tag=work&not-tag=urgent&not-tag=unknown&tab=test",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.search).toBe("?tag=work&not-tag=urgent&tab=test");
    expect(screen.getByRole("button", { name: "Open test" })).toBeVisible();
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
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open needs-old" });

    const groupLabels = [...container.querySelectorAll(".state-group-header h3")]
      .map((heading) => heading.textContent);
    expect(groupLabels).toEqual(["Needs input", "Working", "Background work", "Other"]);
    expect(screen.getByRole("button", { name: /Background work 1/ })).toBeVisible();
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
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

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
    const { unmount } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    expect(screen.getByText(/1 sessions \/ polling/i)).toBeVisible();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 4000);

    unmount();
  });

  it("keeps starred and ignored sessions outside filters while reporting active counts", async () => {
    window.history.replaceState(
      {},
      "",
      "/mux/?q=deploy&kind=codex&state=waiting_human",
    );
    vi.mocked(listSessions).mockResolvedValue([
      session({
        name: "deploy",
        id: "$deploy",
        customTitle: "Deploy target",
        agentState: "waiting_human",
        panes: [pane({ command: "codex" })],
      }),
      session({
        name: "worker",
        id: "$worker",
        agentState: "unknown",
        panes: [pane({ command: "claude" })],
      }),
      session({
        name: "pinned",
        id: "$pinned",
        customTitle: "Pinned control",
        starred: true,
      }),
      session({
        name: "ignored-session",
        id: "$observe",
        customTitle: "Observe demo",
        ignored: true,
        agentState: "working",
      }),
    ]);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open Deploy target" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Pinned control" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open worker" })).not.toBeInTheDocument();
    expect(screen.getByText(
      "1 starred / 1 filtered / 1 ignored",
      { selector: ".results-summary" },
    )).toBeVisible();
    expect(screen.getByRole("button", { name: /Needs input 1/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Working 0/ })).toBeVisible();

    const ignored = container.querySelector<HTMLDetailsElement>("details.ignored-section");
    expect(ignored).not.toBeNull();
    expect(ignored).not.toHaveAttribute("open");
    expect(within(ignored!).getByText("1", { selector: ".ignored-section-count" })).toBeVisible();
    const ignoredCard = within(ignored!).getByRole("button", {
      name: "Open Observe demo",
      hidden: true,
    });
    expect(ignoredCard).not.toBeVisible();

    fireEvent.click(ignored!.querySelector("summary")!);
    expect(ignored).toHaveAttribute("open");
    expect(ignoredCard).toBeVisible();
    expect(within(ignored!).getByRole("button", {
      name: "Remove Observe demo from ignored",
    })).toHaveAttribute("aria-pressed", "true");
  });

  it("always shows the collapsed ignored section when its count is zero", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByRole("button", { name: "Open test" });
    const ignored = container.querySelector<HTMLDetailsElement>("details.ignored-section");
    expect(ignored).not.toBeNull();
    expect(ignored).not.toHaveAttribute("open");
    expect(within(ignored!).getByText("Ignored", {
      selector: ".ignored-section-title",
    })).toBeVisible();
    expect(within(ignored!).getByText("0", {
      selector: ".ignored-section-count",
    })).toBeVisible();
    expect(within(ignored!).queryByRole("button", {
      name: /^Open /,
      hidden: true,
    })).not.toBeInTheDocument();
  });

  it("restores an ignored session to the filtered section", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ customTitle: "Observe demo", ignored: true }),
    ]);
    vi.mocked(updateSessionIgnored).mockResolvedValue({ starred: false, ignored: false });
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByText("Ignored", { selector: ".ignored-section-title" });
    const ignored = container.querySelector<HTMLDetailsElement>("details.ignored-section")!;
    fireEvent.click(ignored.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", {
      name: "Remove Observe demo from ignored",
    }));

    await waitFor(() => expect(updateSessionIgnored).toHaveBeenCalledWith("test", false));
    expect(await screen.findByRole("button", { name: "Open Observe demo" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ignore Observe demo" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const emptyIgnored = container.querySelector<HTMLDetailsElement>("details.ignored-section");
    expect(emptyIgnored).not.toBeNull();
    expect(within(emptyIgnored!).getByText("0", {
      selector: ".ignored-section-count",
    })).toBeVisible();
    expect(screen.getByText(
      "0 starred / 1 filtered / 0 ignored",
      { selector: ".results-summary" },
    )).toBeVisible();
  });

  it("makes star and ignored mutually exclusive under one per-session busy lock", async () => {
    const starRequest = deferredAttentionUpdate();
    const ignoreRequest = deferredAttentionUpdate();
    vi.mocked(listSessions).mockResolvedValue([
      session({ customTitle: "Background job", ignored: true }),
    ]);
    vi.mocked(updateSessionStar).mockReturnValue(starRequest.promise);
    vi.mocked(updateSessionIgnored).mockReturnValue(ignoreRequest.promise);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    await screen.findByText("Ignored", { selector: ".ignored-section-title" });
    fireEvent.click(container.querySelector(".ignored-section summary")!);
    fireEvent.click(screen.getByRole("button", { name: "Add Background job to starred" }));

    expect(updateSessionStar).toHaveBeenCalledWith("test", true);
    const starredToggle = screen.getByRole("button", {
      name: "Remove Background job from starred",
    });
    const ignoreToggle = screen.getByRole("button", { name: "Ignore Background job" });
    expect(starredToggle).toHaveAttribute("aria-pressed", "true");
    expect(ignoreToggle).toHaveAttribute("aria-pressed", "false");
    expect(starredToggle).toBeDisabled();
    expect(ignoreToggle).toBeDisabled();
    expect(within(container.querySelector("details.ignored-section")!).getByText("0", {
      selector: ".ignored-section-count",
    })).toBeVisible();

    await act(async () => {
      starRequest.resolve({ starred: true, ignored: false });
      await starRequest.promise;
    });
    await waitFor(() => expect(starredToggle).toBeEnabled());

    fireEvent.click(ignoreToggle);
    expect(updateSessionIgnored).toHaveBeenCalledWith("test", true);
    expect(screen.queryByRole("heading", { name: "Starred" })).not.toBeInTheDocument();
    const ignored = container.querySelector<HTMLDetailsElement>("details.ignored-section")!;
    const hiddenIgnoreToggle = ignored.querySelector<HTMLButtonElement>(".session-ignore-toggle")!;
    const hiddenStarToggle = ignored.querySelector<HTMLButtonElement>(".session-star-toggle")!;
    expect(hiddenIgnoreToggle).toHaveAttribute("aria-label", "Remove Background job from ignored");
    expect(hiddenIgnoreToggle).toHaveAttribute("aria-pressed", "true");
    expect(hiddenStarToggle).toHaveAttribute("aria-pressed", "false");
    expect(hiddenIgnoreToggle).toBeDisabled();
    expect(hiddenStarToggle).toBeDisabled();

    await act(async () => {
      ignoreRequest.resolve({ starred: false, ignored: true });
      await ignoreRequest.promise;
    });
    await waitFor(() => expect(hiddenIgnoreToggle).toBeEnabled());
    expect(hiddenStarToggle).toBeEnabled();
  });

  it("rolls both attention flags back when ignoring a starred session fails", async () => {
    const request = deferredAttentionUpdate();
    vi.mocked(listSessions).mockResolvedValue([
      session({ customTitle: "Important job", starred: true }),
    ]);
    vi.mocked(updateSessionIgnored).mockReturnValue(request.promise);
    const { container } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Ignore Important job" }));
    expect(updateSessionIgnored).toHaveBeenCalledWith("test", true);
    expect(screen.queryByRole("heading", { name: "Starred" })).not.toBeInTheDocument();
    expect(container.querySelector("details.ignored-section")).toBeInTheDocument();

    await act(async () => {
      request.reject(new Error("metadata disk is unavailable"));
      await request.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("metadata disk is unavailable");
    expect(screen.getByRole("heading", { name: "Starred" })).toBeVisible();
    const emptyIgnored = container.querySelector<HTMLDetailsElement>("details.ignored-section");
    expect(emptyIgnored).not.toBeNull();
    expect(within(emptyIgnored!).getByText("0", {
      selector: ".ignored-section-count",
    })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Remove Important job from starred",
    })).toHaveAttribute("aria-pressed", "true");
    const restoredIgnore = screen.getByRole("button", { name: "Ignore Important job" });
    expect(restoredIgnore).toHaveAttribute("aria-pressed", "false");
    expect(restoredIgnore).toBeEnabled();
  });

  it("adds and removes sessions from the pinned starred section", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionStar)
      .mockResolvedValueOnce({ starred: true, ignored: false })
      .mockResolvedValueOnce({ starred: false, ignored: false });
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add test to starred" }));
    await waitFor(() => expect(updateSessionStar).toHaveBeenCalledWith("test", true));
    expect(await screen.findByRole("heading", { name: "Starred" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove test from starred" }));
    await waitFor(() => expect(updateSessionStar).toHaveBeenCalledWith("test", false));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Starred" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add test to starred" })).toBeVisible();
  });

  it("pins and unpins a session across workspaces with an optimistic card control", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionWorkspacePin)
      .mockResolvedValueOnce({
        session: "test",
        workspacePinned: true,
        sessionRevision: 3,
      })
      .mockResolvedValueOnce({
        session: "test",
        workspacePinned: false,
        sessionRevision: 4,
      });
    const onWorkspacePinChange = vi.fn();
    renderWithTheme(
      <SessionDashboard
        onOpen={vi.fn()}
        onWorkspacePinChange={onWorkspacePinChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "Pin test to every workspace",
    }));
    await waitFor(() => expect(updateSessionWorkspacePin).toHaveBeenCalledWith(
      "test",
      true,
    ));
    expect(screen.getByRole("button", {
      name: "Unpin test from every workspace",
    })).toBePressed();
    expect(onWorkspacePinChange).toHaveBeenCalledWith("test", true, 3);

    fireEvent.click(screen.getByRole("button", {
      name: "Unpin test from every workspace",
    }));
    await waitFor(() => expect(updateSessionWorkspacePin).toHaveBeenLastCalledWith(
      "test",
      false,
    ));
    expect(screen.getByRole("button", {
      name: "Pin test to every workspace",
    })).not.toBePressed();
    expect(onWorkspacePinChange).toHaveBeenLastCalledWith("test", false, 4);
  });

  it("rolls back a failed global workspace pin", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionWorkspacePin).mockRejectedValue(
      new Error("A workspace already has 32 sessions"),
    );
    renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Pin test to every workspace",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A workspace already has 32 sessions",
    );
    expect(screen.getByRole("button", {
      name: "Pin test to every workspace",
    })).not.toBePressed();
  });

  it("does not schedule another refresh when a pending request resolves after unmount", async () => {
    let resolveRequest!: (sessions: Session[]) => void;
    const pendingRequest = new Promise<Session[]>((resolve) => {
      resolveRequest = resolve;
    });
    vi.mocked(listSessions).mockReturnValue(pendingRequest);
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    const { unmount } = renderWithTheme(<SessionDashboard onOpen={vi.fn()} />);
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
