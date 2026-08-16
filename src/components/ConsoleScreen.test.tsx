import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSnippetTree,
  listQueuedMessages,
  listSessions,
  renameSession,
  updateSessionTitle,
} from "../api";
import { renderWithTheme } from "../test-utils";
import { ThemeProvider, type Theme } from "../theme";
import type { Pane, Session } from "../types";
import { ConsoleScreen } from "./ConsoleScreen";

vi.mock("../api", () => ({
  listSessions: vi.fn(),
  listQueuedMessages: vi.fn(),
  createQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  getSnippetTree: vi.fn(),
  renameSession: vi.fn(),
  updateSessionStar: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("./LiveTerminal", () => ({
  LiveTerminal: ({ theme }: { theme: Theme }) => (
    <div data-testid="live-terminal" data-terminal-theme={theme} />
  ),
}));

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
    history_limit: 2000,
    alternate_on: false,
    dead: false,
    activity: 1,
  };
}

function session(customTitle: string | null = null, name = "test"): Session {
  return {
    name,
    id: "$1",
    windows: 1,
    attached: 0,
    created: 1,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [pane()],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(getSnippetTree).mockResolvedValue({ revision: 0, tree: [] });
  document.title = "Muxdeck";
});

describe("ConsoleScreen session identity", () => {
  it("toggles console regions independently and keeps their toolbar available", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const toolbar = screen.getByRole("group", { name: "Console bars" });
    const tabs = within(toolbar).getByRole("button", { name: "Session tabs" });
    const input = within(toolbar).getByRole("button", { name: "Staged input" });
    const keys = within(toolbar).getByRole("button", {
      name: "Terminal shortcut buttons",
    });

    expect(tabs).toBePressed();
    expect(tabs).toHaveAttribute("aria-controls", "muxdeck-session-tabs");
    expect(input).toBePressed();
    expect(input).toHaveAttribute("aria-controls", "muxdeck-staged-input");
    expect(keys).toBePressed();
    expect(keys).toHaveAttribute("aria-controls", "muxdeck-terminal-shortcuts");

    fireEvent.click(input);
    expect(input).not.toBePressed();
    expect(screen.queryByRole("textbox", { name: "Staged input" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Terminal input shortcuts" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Quick sessions" })).toBeVisible();

    fireEvent.click(keys);
    expect(keys).not.toBePressed();
    expect(screen.queryByRole("group", { name: "Terminal input shortcuts" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Console bars" })).toBeVisible();

    fireEvent.click(tabs);
    expect(tabs).not.toBePressed();
    expect(tabs).toHaveAttribute("title", "Show session tabs");
    expect(within(screen.getByRole("group", { name: "Console bars" }))
      .getAllByRole("button")).toHaveLength(3);

    fireEvent.click(input);
    expect(screen.getByRole("textbox", { name: "Staged input" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Terminal input shortcuts" }))
      .not.toBeInTheDocument();
    expect(tabs).not.toBePressed();
    expect(keys).not.toBePressed();
  });

  it("reports live session metadata and places workspace navigation above the console", async () => {
    const currentSession = session();
    const onSessionsChange = vi.fn();
    vi.mocked(listSessions).mockResolvedValue([currentSession]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionsChange={onSessionsChange}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    expect(screen.getByRole("navigation", { name: "Quick sessions" })).toBeVisible();
    expect(onSessionsChange).toHaveBeenCalledWith([currentSession]);
  });

  it("keeps workspace navigation available when a visited session has ended", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="ended"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    expect(await screen.findByText("This tmux session no longer exists.")).toBeVisible();
    const toolbar = screen.getByRole("group", { name: "Console bars" });
    expect(within(toolbar).getByRole("button", { name: "Session tabs" })).toBePressed();
    const inputToggle = within(toolbar).getByRole("button", { name: "Staged input" });
    const shortcutsToggle = within(toolbar).getByRole("button", {
      name: "Terminal shortcut buttons",
    });
    expect(inputToggle).toBeDisabled();
    expect(inputToggle).not.toBePressed();
    expect(inputToggle).not.toHaveAttribute("aria-controls");
    expect(shortcutsToggle).toBeDisabled();
    expect(shortcutsToggle).not.toBePressed();
    expect(shortcutsToggle).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("navigation", { name: "Quick sessions" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "ended" })).toBeVisible();
  });

  it("replaces a loaded console with the unavailable view when its session ends", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listSessions)
        .mockResolvedValueOnce([session()])
        .mockResolvedValueOnce([])
        .mockResolvedValue([session()]);
      renderWithTheme(
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
        />,
      );

      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("live-terminal")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Edit display title" }));
      expect(screen.getByRole("dialog", { name: "Edit display title" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByText("This tmux session no longer exists.")).toBeVisible();
      expect(screen.queryByTestId("live-terminal")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Edit display title" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Quick sessions" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByTestId("live-terminal")).toBeVisible();
      expect(screen.queryByRole("dialog", { name: "Edit display title" }))
        .not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes console-local dialogs before a routed workspace overlay opens", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        workspaceOverlayOpen={false}
      />,
    );

    const titleButton = screen.getByRole("button", { name: "Edit display title" });
    await waitFor(() => expect(titleButton).toBeEnabled());
    fireEvent.click(titleButton);
    expect(screen.getByRole("dialog", { name: "Edit display title" })).toBeVisible();

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen sessionName="test" onBack={vi.fn()} workspaceOverlayOpen />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Edit display title" }))
      .not.toBeInTheDocument();

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          workspaceOverlayOpen={false}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Edit display title" }))
      .not.toBeInTheDocument();
  });

  it("exposes the theme control and passes changes to the live terminal", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    expect(screen.getByTestId("live-terminal")).toHaveAttribute("data-terminal-theme", "dark");

    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));

    expect(screen.getByRole("button", { name: "Light theme" })).toBePressed();
    expect(screen.getByTestId("live-terminal")).toHaveAttribute("data-terminal-theme", "light");
  });

  it("inserts snippets into the staged draft without sending", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "continue", type: "snippet", name: "Continue", text: "continue from here" }],
    });
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("continue from here"));
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveFocus();
  });

  it("reveals and focuses a hidden staged input after inserting a snippet", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "continue", type: "snippet", name: "Continue", text: "continue from here" }],
    });
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    const inputToggle = screen.getByRole("button", { name: "Staged input" });
    fireEvent.click(inputToggle);
    expect(inputToggle).not.toBePressed();
    expect(screen.queryByRole("textbox", { name: "Staged input" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(inputToggle).toBePressed());
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    expect(textarea).toHaveValue("continue from here");
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it("updates the human title from the bottom shortcut bar", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionTitle).mockResolvedValue("Mobile work");
    const onSessionUpdate = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Edit display title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Mobile work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", "Mobile work"));
    expect(onSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      name: "test",
      customTitle: "Mobile work",
    }));
    expect(await screen.findByRole("heading", { name: "Mobile work" })).toBeVisible();
    expect(screen.getByText("test / /work")).toBeVisible();
    expect(document.title).toBe("Mobile work - Muxdeck");
    expect(screen.queryByRole("dialog", { name: "Edit display title" }))
      .not.toBeInTheDocument();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("clears the human title without renaming the tmux session", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Old label")]);
    vi.mocked(updateSessionTitle).mockResolvedValue(null);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "Old label" });
    fireEvent.click(screen.getByRole("button", { name: "Edit display title" }));
    const titleDialog = screen.getByRole("dialog", { name: "Edit display title" });
    fireEvent.click(within(titleDialog).getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", ""));
    expect(await screen.findByRole("heading", { name: "test" })).toBeVisible();
    expect(document.title).toBe("test - Muxdeck");
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("renames the native tmux session without changing its display title", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Display alias")]);
    vi.mocked(renameSession).mockResolvedValue({
      previousSession: "test",
      session: "  renamed/session  ",
      warnings: [],
    });
    const onSessionRenamed = vi.fn();
    const onSessionUpdate = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionRenamed={onSessionRenamed}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "Display alias" });
    const aliasButton = screen.getByRole("button", { name: "Edit display title" });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    await waitFor(() => expect(renameButton).toBeEnabled());
    expect(aliasButton).toBeEnabled();

    fireEvent.click(renameButton);
    const dialog = screen.getByRole("dialog", { name: "Rename tmux session" });
    expect(within(dialog).getByRole("textbox", { name: "Native tmux name" }))
      .toHaveValue("test");
    expect(dialog).toHaveTextContent("display title is preserved");
    expect(screen.queryByRole("dialog", { name: "Edit display title" }))
      .not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Native tmux name" }), {
      target: { value: "  renamed/session  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename session" }));

    await waitFor(() => expect(renameSession)
      .toHaveBeenCalledWith("test", "  renamed/session  "));
    expect(onSessionRenamed)
      .toHaveBeenCalledWith("test", "  renamed/session  ", "$1", []);
    expect(onSessionUpdate).not.toHaveBeenCalled();
    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Rename tmux session" }))
      .not.toBeInTheDocument();
  });

  it("captures the staged draft before a slow rename can switch to another session", async () => {
    const pendingRename = deferred<Awaited<ReturnType<typeof renameSession>>>();
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(renameSession).mockReturnValue(pendingRename.promise);
    const onSessionRenamed = vi.fn();
    const storageSet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionRenamed={onSessionRenamed}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    fireEvent.input(screen.getByRole("textbox", { name: "Staged input" }), {
      target: { value: "draft belonging to the renamed session" },
    });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    await waitFor(() => expect(renameButton).toBeEnabled());
    fireEvent.click(renameButton);
    fireEvent.change(screen.getByRole("textbox", { name: "Native tmux name" }), {
      target: { value: "renamed-session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    await waitFor(() => expect(renameSession)
      .toHaveBeenCalledWith("test", "renamed-session"));

    vi.mocked(listSessions).mockResolvedValue([session(null, "other-session")]);
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="other-session"
          onBack={vi.fn()}
          onSessionRenamed={onSessionRenamed}
        />
      </ThemeProvider>,
    );
    const otherDraft = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.input(otherDraft, {
      target: { value: "draft belonging to the newly active session" },
    });

    await act(async () => {
      pendingRename.resolve({
        previousSession: "test",
        session: "renamed-session",
        warnings: [],
      });
      await pendingRename.promise;
    });
    await waitFor(() => expect(onSessionRenamed)
      .toHaveBeenCalledWith("test", "renamed-session", "$1", []));

    vi.mocked(listSessions).mockResolvedValue([session(null, "renamed-session")]);
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="renamed-session"
          onBack={vi.fn()}
          onSessionRenamed={onSessionRenamed}
        />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("draft belonging to the renamed session"));
    expect(screen.getByText(/could not be saved on this device/i)).toBeVisible();
    storageSet.mockRestore();
  });

  it("forwards rename warnings and renders the App-owned notice after routing", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Display alias")]);
    vi.mocked(renameSession).mockResolvedValue({
      previousSession: "test",
      session: "renamed-session",
      warnings: ["Queued memoranda could not be migrated."],
    });
    const onSessionRenamed = vi.fn();
    const onDismissRenameWarning = vi.fn();
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionRenamed={onSessionRenamed}
      />,
    );

    await screen.findByRole("heading", { name: "Display alias" });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    await waitFor(() => expect(renameButton).toBeEnabled());
    fireEvent.click(renameButton);
    fireEvent.change(screen.getByRole("textbox", { name: "Native tmux name" }), {
      target: { value: "renamed-session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    await waitFor(() => expect(onSessionRenamed)
      .toHaveBeenCalledWith(
        "test",
        "renamed-session",
        "$1",
        ["Queued memoranda could not be migrated."],
      ));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    vi.mocked(listSessions).mockResolvedValue([
      session("Display alias", "renamed-session"),
    ]);
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="renamed-session"
          onBack={vi.fn()}
          onSessionRenamed={onSessionRenamed}
          renameWarning={{
            sessionId: "$1",
            sessionName: "renamed-session",
            messages: ["Queued memoranda could not be migrated."],
          }}
          onDismissRenameWarning={onDismissRenameWarning}
        />
      </ThemeProvider>,
    );

    const warning = await screen.findByRole("status");
    expect(warning).toHaveTextContent("Tmux session renamed with warnings");
    expect(warning).toHaveTextContent("Queued memoranda could not be migrated.");
    fireEvent.click(within(warning).getByRole("button", {
      name: "Dismiss rename warning",
    }));
    expect(onDismissRenameWarning).toHaveBeenCalledWith("$1");

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="renamed-session"
          onBack={vi.fn()}
          onSessionRenamed={onSessionRenamed}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the native rename dialog open when the API rejects the name", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Display alias")]);
    vi.mocked(renameSession).mockRejectedValue(new Error("session name already exists"));
    const onSessionRenamed = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionRenamed={onSessionRenamed}
      />,
    );

    await screen.findByRole("heading", { name: "Display alias" });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    await waitFor(() => expect(renameButton).toBeEnabled());
    fireEvent.click(renameButton);
    fireEvent.change(screen.getByRole("textbox", { name: "Native tmux name" }), {
      target: { value: "occupied" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("session name already exists");
    expect(screen.getByRole("dialog", { name: "Rename tmux session" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Native tmux name" })).toHaveValue("occupied");
    expect(screen.getByRole("button", { name: "Rename session" })).toBeEnabled();
    expect(onSessionRenamed).not.toHaveBeenCalled();
    expect(updateSessionTitle).not.toHaveBeenCalled();
  });

  it("loads a queued memorandum into the permanent staged input", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "test",
      messages: [{
        id: "memo-1",
        text: "Review the latest test failure",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        position: 0,
      }],
    });
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda" }));
    expect(await screen.findByText("Review the latest test failure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Queued messages" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("Review the latest test failure");
  });
});
