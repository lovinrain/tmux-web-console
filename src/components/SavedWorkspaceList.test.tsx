import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
  type SavedWorkspace,
} from "../api";
import { renderWithTheme } from "../test-utils";
import type { WorkspaceTabGroup } from "../workspaceState";
import { MAX_WORKSPACE_TABS } from "../workspaceValidation";
import { approximateWorkspaceActivity, SavedWorkspaceList } from "./SavedWorkspaceList";

vi.mock("../api", () => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
}));

function workspace(overrides: Partial<SavedWorkspace> = {}): SavedWorkspace {
  return {
    id: "workspace-1",
    name: "Release room",
    tabs: ["api", "web client"],
    groups: [],
    activeSession: "web client",
    sessionRevision: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    lastActiveAt: Date.now() - 5 * 60_000,
    ...overrides,
  };
}

function group(overrides: Partial<WorkspaceTabGroup> = {}): WorkspaceTabGroup {
  return {
    id: "delivery-group",
    name: "Delivery",
    color: "cyan",
    collapsed: false,
    tabs: ["web", "api"],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("saved workspace activity labels", () => {
  it("uses rough relative time before falling back to a date", () => {
    const now = new Date("2026-08-16T12:00:00Z").getTime();
    expect(approximateWorkspaceActivity(now - 25_000, now)).toBe("Active just now");
    expect(approximateWorkspaceActivity(now - 7 * 60_000, now)).toBe("Active 7m ago");
    expect(approximateWorkspaceActivity(now - 3 * 3_600_000, now)).toBe("Active 3h ago");
    expect(approximateWorkspaceActivity(now - 2 * 86_400_000, now)).toBe("Active 2d ago");
    expect(approximateWorkspaceActivity(0, now)).toBe("Activity time unavailable");
  });
});

describe("SavedWorkspaceList", () => {
  it("lists most-recent workspaces with ordered session names and opens one", async () => {
    const older = workspace({
      id: "older",
      name: "Earlier investigation",
      tabs: ["missing-session", "logs"],
      activeSession: "missing-session",
      lastActiveAt: Date.now() - 3_600_000,
    });
    const newer = workspace({
      id: "newer",
      groups: [group({ name: "Release lane", tabs: ["api", "web client"] })],
      lastActiveAt: Date.now() - 60_000,
    });
    vi.mocked(listWorkspaces).mockResolvedValue([older, newer]);
    const onOpen = vi.fn();

    renderWithTheme(
      <SavedWorkspaceList
        activeWorkspaceId="newer"
        onOpen={onOpen}
        getOpenInNewWindowHref={(item) => `/mux/?workspace=${item.id}`}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading saved workspaces");
    const cards = await screen.findAllByRole("listitem");
    const workspaceCards = cards.filter((item) => item.classList.contains("saved-workspace-card"));
    expect(workspaceCards).toHaveLength(2);
    expect(within(workspaceCards[0]).getByRole("heading", { level: 3 }))
      .toHaveTextContent("Release room");
    expect(within(workspaceCards[0]).getByText("Current")).toBeVisible();
    expect(within(workspaceCards[0]).getByText(/^Active /)).toHaveAttribute("title");
    expect(within(workspaceCards[0]).queryByLabelText("1 tab group"))
      .not.toBeInTheDocument();
    expect(within(workspaceCards[0]).queryByText("1 group")).not.toBeInTheDocument();

    const olderCard = workspaceCards[1];
    const orderedSessions = within(olderCard).getByRole("list", {
      name: "Ordered sessions in Earlier investigation",
    });
    expect(within(orderedSessions).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["01missing-session", "02logs"]);
    expect(within(olderCard).getByText("Resume / missing-session")).toBeVisible();

    const newWindow = within(olderCard).getByRole("link", {
      name: "Open workspace Earlier investigation in new window",
    });
    expect(newWindow).toHaveAttribute("href", "/mux/?workspace=older");
    expect(newWindow).toHaveAttribute("target", "_blank");
    expect(newWindow).toHaveAttribute("rel", "noopener noreferrer");
    expect(newWindow).toHaveTextContent("New window");

    fireEvent.click(screen.getByRole("button", { name: "Resume workspace Release room" }));
    expect(onOpen).toHaveBeenCalledWith(newer);
  });

  it("starts fresh by default even when the browser workspace has open tabs", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    const created = workspace({
      id: "fresh",
      name: "Blank slate",
      tabs: [],
      activeSession: null,
    });
    vi.mocked(createWorkspace).mockResolvedValue(created);

    renderWithTheme(
      <SavedWorkspaceList
        currentTabs={["web", "api"]}
        currentWorkspaceGroups={[group()]}
        activeSession="api"
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText("No saved workspaces yet.");

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("radio", { name: /Start fresh/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Copy current tabs/ })).not.toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Blank slate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith({
      name: "Blank slate",
      tabs: [],
      groups: [],
      activeSession: null,
    }));
  });

  it("can copy and immediately open a workspace with current tabs in order", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    const created = workspace({
      id: "created",
      name: "Cross device",
      tabs: ["web", "api"],
      groups: [group()],
      activeSession: "api",
    });
    vi.mocked(createWorkspace).mockResolvedValue(created);
    const onOpen = vi.fn();

    renderWithTheme(
      <SavedWorkspaceList
        currentTabs={["web", "api", "web"]}
        currentWorkspaceGroups={[group()]}
        activeSession="api"
        onOpen={onOpen}
      />,
    );
    await screen.findByText("No saved workspaces yet.");

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input).toHaveFocus();
    expect(screen.getByText("Copy 2 open tabs in the current order."))
      .toBeVisible();
    fireEvent.change(input, { target: { value: "  Cross device  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Copy current tabs/ }));
    expect(input).toHaveValue("  Cross device  ");
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith({
      name: "Cross device",
      tabs: ["web", "api"],
      groups: [group()],
      activeSession: "api",
    }));
    expect(onOpen).toHaveBeenCalledWith(created);
  });

  it("allows an empty workspace and ignores a list response older than its creation", async () => {
    const pendingList = deferred<SavedWorkspace[]>();
    vi.mocked(listWorkspaces).mockReturnValue(pendingList.promise);
    const created = workspace({
      id: "empty",
      name: "Fresh room",
      tabs: [],
      groups: [],
      activeSession: null,
    });
    vi.mocked(createWorkspace).mockResolvedValue(created);

    renderWithTheme(<SavedWorkspaceList onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("radio", { name: /Start fresh/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Copy current tabs/ })).toBeDisabled();
    expect(screen.getByText("No tabs are open to copy.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Fresh room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));
    expect(await screen.findByRole("heading", { name: "Fresh room" })).toBeVisible();
    expect(createWorkspace).toHaveBeenCalledWith({
      name: "Fresh room",
      tabs: [],
      groups: [],
      activeSession: null,
    });

    await act(async () => pendingList.resolve([]));
    expect(screen.getByRole("heading", { name: "Fresh room" })).toBeVisible();
    expect(screen.getByText("No sessions yet")).toBeVisible();
  });

  it("keeps fresh creation available when there are too many tabs to copy", async () => {
    const currentTabs = Array.from(
      { length: MAX_WORKSPACE_TABS + 1 },
      (_, index) => `session-${String(index + 1).padStart(2, "0")}`,
    );
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(createWorkspace).mockResolvedValue(workspace({
      id: "over-limit-fresh",
      name: "Fresh despite tabs",
      tabs: [],
      groups: [],
      activeSession: null,
    }));

    renderWithTheme(
      <SavedWorkspaceList
        currentTabs={currentTabs}
        activeSession={`session-${MAX_WORKSPACE_TABS + 1}`}
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText("No saved workspaces yet.");
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));

    expect(screen.getByRole("radio", { name: /Copy current tabs/ })).toBeDisabled();
    expect(screen.getByText(
      `${MAX_WORKSPACE_TABS + 1} tabs are open; saved workspaces support up to ${MAX_WORKSPACE_TABS}.`,
    )).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Fresh despite tabs" },
    });
    expect(screen.getByRole("button", { name: "Create & open" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith({
      name: "Fresh despite tabs",
      tabs: [],
      groups: [],
      activeSession: null,
    }));
  });

  it("keeps the entered name and copy choice after a creation failure", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(createWorkspace).mockRejectedValue(new Error("server unavailable"));

    renderWithTheme(
      <SavedWorkspaceList
        currentTabs={["web"]}
        activeSession="web"
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText("No saved workspaces yet.");
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Retry room" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Copy current tabs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create & open" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("server unavailable");
    expect(screen.getByRole("textbox", { name: "Workspace name" }))
      .toHaveValue("Retry room");
    expect(screen.getByRole("radio", { name: /Copy current tabs/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Create & open" })).toBeEnabled();
  });

  it("renames and confirmation-deletes without touching tmux sessions", async () => {
    const original = workspace();
    const renamed = { ...original, name: "Launch room" };
    vi.mocked(listWorkspaces).mockResolvedValue([original]);
    vi.mocked(updateWorkspace).mockResolvedValue(renamed);
    vi.mocked(deleteWorkspace).mockResolvedValue();
    const onDeleted = vi.fn();

    renderWithTheme(
      <SavedWorkspaceList onOpen={vi.fn()} onDeleted={onDeleted} />,
    );
    await screen.findByRole("heading", { name: "Release room" });

    fireEvent.click(screen.getByRole("button", { name: "Rename workspace Release room" }));
    const renameInput = screen.getByRole("textbox", { name: "New workspace name" });
    fireEvent.change(renameInput, { target: { value: " Launch room " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "Launch room" })).toBeVisible();
    expect(updateWorkspace).toHaveBeenCalledWith("workspace-1", { name: "Launch room" });

    fireEvent.click(screen.getByRole("button", { name: "Delete workspace Launch room" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Tmux sessions keep running");
    await waitFor(() => expect(confirmation).toHaveFocus());
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Delete workspace Launch room",
    })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Delete workspace Launch room" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workspace",
    }));
    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith("workspace-1"));
    expect(onDeleted).toHaveBeenCalledWith("workspace-1");
    expect(screen.queryByRole("heading", { name: "Launch room" })).not.toBeInTheDocument();
  });

  it("keeps a failed rename editable and reports the server error", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([workspace()]);
    vi.mocked(updateWorkspace).mockRejectedValue(new Error("name already exists"));

    renderWithTheme(<SavedWorkspaceList onOpen={vi.fn()} />);
    await screen.findByRole("heading", { name: "Release room" });
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace Release room" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New workspace name" }), {
      target: { value: "Existing room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("name already exists");
    expect(screen.getByRole("textbox", { name: "New workspace name" }))
      .toHaveValue("Existing room");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows a recoverable load error and a clear empty state", async () => {
    vi.mocked(listWorkspaces)
      .mockRejectedValueOnce(new Error("server offline"))
      .mockResolvedValueOnce([]);

    renderWithTheme(<SavedWorkspaceList onOpen={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Workspaces are unavailable");
    expect(alert).toHaveTextContent("server offline");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No saved workspaces yet.")).toBeVisible();
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });
});
