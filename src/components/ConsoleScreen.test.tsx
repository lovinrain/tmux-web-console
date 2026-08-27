import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copySession,
  createQueuedMessage,
  deleteQueuedMessage,
  getSnippetTree,
  listWorkspaces,
  listQueuedMessages,
  listSessions,
  renameSession,
  updateSessionDetails,
  updateSessionWorkspacePin,
  updateQueuedMessage,
  updateSessionTags,
  updateSessionTitle,
} from "../api";
import { renderWithTheme } from "../test-utils";
import type { TerminalSubmissionTerminator } from "../terminalInput";
import { ThemeProvider, type Theme } from "../theme";
import type { Pane, Session } from "../types";
import { ConsoleScreen } from "./ConsoleScreen";
import { MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID } from "./SessionWorkspaceNavigation";

const liveTerminalHandle = vi.hoisted(() => ({
  send: vi.fn((_data: string) => true),
  paste: vi.fn((_data: string) => true),
  submit: vi.fn(async (_data: string, _terminator: TerminalSubmissionTerminator) => true),
  focus: vi.fn(),
  redraw: vi.fn(() => true),
  navigateHistory: vi.fn((_action: "page-up" | "page-down" | "exit") => true),
  jumpToLive: vi.fn(),
}));
const liveTerminalState = vi.hoisted(() => ({
  onStateChange: null as null | ((state: "live") => void),
}));

vi.mock("../api", () => ({
  copySession: vi.fn(),
  listSessions: vi.fn(),
  listQueuedMessages: vi.fn(),
  createQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  getSnippetTree: vi.fn(),
  renameSession: vi.fn(),
  updateSessionDetails: vi.fn(),
  updateSessionWorkspacePin: vi.fn(),
  listWorkspaces: vi.fn(),
  updateSessionStar: vi.fn(),
  updateSessionTags: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("./LiveTerminal", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    LiveTerminal: forwardRef(function MockLiveTerminal(
      {
        browserCopyMode,
        layoutSuspended,
        layoutRefreshToken,
        theme,
        onStateChange,
      }: {
        browserCopyMode?: boolean;
        layoutSuspended?: boolean;
        layoutRefreshToken?: string;
        theme: Theme;
        onStateChange: (state: "live") => void;
      },
      ref,
    ) {
      liveTerminalState.onStateChange = onStateChange;
      useImperativeHandle(ref, () => liveTerminalHandle, []);
      return (
        <div
          data-testid="live-terminal"
          data-browser-copy-mode={browserCopyMode ? "true" : "false"}
          data-layout-suspended={layoutSuspended ? "true" : "false"}
          data-layout-refresh-token={layoutRefreshToken}
          data-terminal-theme={theme}
        />
      );
    }),
  };
});

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
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle,
    tags: [],
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
  liveTerminalState.onStateChange = null;
  window.localStorage.clear();
  vi.mocked(getSnippetTree).mockResolvedValue({ revision: 0, tree: [] });
  vi.mocked(listWorkspaces).mockResolvedValue([]);
  document.title = "Muxdeck";
});

describe("ConsoleScreen session identity", () => {
  it("places desktop notes immediately before the header action cluster", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        headerNotes={<aside data-testid="header-notes">Scoped notes</aside>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const notes = screen.getByTestId("header-notes");
    expect(notes.parentElement).toHaveClass("console-header");
    expect(notes.nextElementSibling).toBe(view.container.querySelector(".console-actions"));
  });

  it("stages the current browser theme for Grok without sending terminal input", async () => {
    const grokSession = {
      ...session(),
      agentState: "waiting_human" as const,
      agentStateReason: "Grok is waiting for input",
      panes: [{ ...pane(), command: "grok", title: "grok" }],
    };
    vi.mocked(listSessions).mockResolvedValue([grokSession]);
    renderWithTheme(
      <ConsoleScreen sessionName="test" onBack={vi.fn()} />,
    );

    await screen.findByRole("heading", { name: "test" });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    const grokThemeButton = screen.getByRole("button", {
      name: "Stage groknight theme command for Grok",
    });
    expect(grokThemeButton).toHaveAccessibleDescription(
      /Sending changes Grok's saved user theme globally/,
    );
    fireEvent.click(grokThemeButton);

    expect(stagedInput).toHaveValue("/theme groknight");
    expect(screen.getByRole("main")).toHaveAttribute("data-mobile-focus", "input");
    expect(liveTerminalHandle.send).not.toHaveBeenCalled();
    expect(liveTerminalHandle.submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(screen.getByTestId("live-terminal")).toHaveAttribute(
      "data-terminal-theme",
      "light",
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", {
      name: "Stage grokday theme command for Grok",
    }));

    expect(stagedInput).toHaveValue("/theme grokday");
    expect(liveTerminalHandle.send).not.toHaveBeenCalled();
    expect(liveTerminalHandle.submit).not.toHaveBeenCalled();
  });

  it("preserves an existing draft when Grok theme staging is declined", async () => {
    const grokSession = {
      ...session(),
      panes: [{ ...pane(), command: "grok", title: "grok" }],
    };
    vi.mocked(listSessions).mockResolvedValue([grokSession]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithTheme(
      <ConsoleScreen sessionName="test" onBack={vi.fn()} />,
    );

    await screen.findByRole("heading", { name: "test" });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.change(stagedInput, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", {
      name: "Stage groknight theme command for Grok",
    }));

    expect(window.confirm).toHaveBeenCalledWith(
      "Replace the staged input that is already here?",
    );
    expect(stagedInput).toHaveValue("keep this draft");
    expect(liveTerminalHandle.send).not.toHaveBeenCalled();
    expect(liveTerminalHandle.submit).not.toHaveBeenCalled();
  });

  it("does not offer Grok theme staging for another foreground process", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen sessionName="test" onBack={vi.fn()} />,
    );

    await screen.findByRole("heading", { name: "test" });
    expect(screen.queryByRole("button", {
      name: /theme command for Grok/i,
    })).not.toBeInTheDocument();
  });

  it("follows an in-terminal pane switch before offering Grok theme staging", async () => {
    vi.useFakeTimers();
    try {
      const shellPane = pane();
      const grokPane = {
        ...pane(),
        id: "%2",
        index: 1,
        command: "grok",
        title: "grok",
      };
      const shellSession = {
        ...session(),
        activePaneId: shellPane.id,
        panes: [shellPane, { ...grokPane, active: false }],
      };
      const grokSession = {
        ...shellSession,
        activePaneId: grokPane.id,
        panes: [{ ...shellPane, active: false }, grokPane],
      };
      vi.mocked(listSessions)
        .mockResolvedValueOnce([shellSession])
        .mockResolvedValue([grokSession]);
      renderWithTheme(
        <ConsoleScreen sessionName="test" onBack={vi.fn()} />,
      );

      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole("button", {
        name: /theme command for Grok/i,
      })).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByRole("button", {
        name: "Stage groknight theme command for Grok",
      })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the saved workspace and display names in the browser tab title", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Release review")]);
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        workspaceName="Incident room"
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Release review" });
    await waitFor(() => {
      expect(document.title).toBe("Incident room - Release review");
    });

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          workspaceName="Release train"
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(document.title).toBe("Release train - Release review");
    });

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen sessionName="test" onBack={vi.fn()} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(document.title).toBe("Release review - Muxdeck");
    });
  });

  it("offers exclusive mobile purposes without remounting the terminal or losing a draft", async () => {
    const needsInputSession = {
      ...session(),
      agentState: "waiting_human" as const,
      agentStateReason: "Agent is waiting for input",
      memorandumCount: 3,
      queuedMessageCount: 2,
    };
    const openOverview = vi.fn();
    const closeOverview = vi.fn();
    vi.mocked(listSessions).mockResolvedValue([needsInputSession]);
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
        onOpenWorkspaceOverview={openOverview}
        onCloseWorkspaceOverview={closeOverview}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const focus = screen.getByRole("navigation", { name: "Mobile console focus" });
    const overview = within(focus).getByRole("button", { name: "Overview" });
    const terminal = within(focus).getByRole("button", { name: "Terminal" });
    const input = within(focus).getByRole("button", {
      name: "Input, 2 queued memo items",
    });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    const liveTerminal = screen.getByTestId("live-terminal");

    expect(overview).toHaveAttribute("id", MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID);
    expect(shell).toHaveAttribute("data-mobile-focus", "terminal");
    expect([overview, terminal, input].filter((button) => (
      button.getAttribute("aria-pressed") === "true"
    ))).toEqual([terminal]);
    expect(input).toHaveClass("needs-input");
    expect(input).toHaveClass("has-queued-memos");
    expect(input).toHaveTextContent("Q 2");
    expect(input).toHaveAttribute("title", "This session needs input");

    fireEvent.click(input);
    expect(shell).toHaveAttribute("data-mobile-focus", "input");
    expect(input).toBePressed();
    await waitFor(() => expect(stagedInput).toHaveFocus());
    fireEvent.input(stagedInput, { target: { value: "keep this reply" } });

    fireEvent.click(terminal);
    expect(shell).toHaveAttribute("data-mobile-focus", "terminal");
    expect(stagedInput).not.toHaveFocus();
    expect(liveTerminal).toBe(screen.getByTestId("live-terminal"));

    fireEvent.click(overview);
    expect(openOverview).toHaveBeenCalledOnce();
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
          workspaceOverlayOpen
          onOpenWorkspaceOverview={openOverview}
          onCloseWorkspaceOverview={closeOverview}
        />
      </ThemeProvider>,
    );
    expect(shell).toHaveAttribute("data-mobile-focus", "overview");
    expect(overview).toBePressed();

    fireEvent.click(input);
    expect(closeOverview).toHaveBeenCalledOnce();
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
          onOpenWorkspaceOverview={openOverview}
          onCloseWorkspaceOverview={closeOverview}
        />
      </ThemeProvider>,
    );
    expect(shell).toHaveAttribute("data-mobile-focus", "input");
    expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("keep this reply");
    expect(screen.getByTestId("live-terminal")).toBe(liveTerminal);
  });

  it("returns desktop keyboard focus to the live terminal", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    const liveButton = screen.getByRole("button", {
      name: "Focus live terminal input",
    });
    expect(liveButton).toBeDisabled();

    act(() => liveTerminalState.onStateChange?.("live"));
    expect(liveButton).toBeEnabled();
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    expect(liveButton.dispatchEvent(mouseDown)).toBe(false);
    fireEvent.click(liveButton);

    expect(liveTerminalHandle.navigateHistory).toHaveBeenCalledWith("exit");
    expect(liveTerminalHandle.jumpToLive).toHaveBeenCalledOnce();
    expect(liveTerminalHandle.focus).toHaveBeenCalledOnce();
  });

  it("redraws the local terminal renderer from the desktop bottom controls", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    const redraw = screen.getByRole("button", { name: "Redraw terminal display" });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    expect(redraw).toBeEnabled();
    stagedInput.focus();

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    expect(redraw.dispatchEvent(mouseDown)).toBe(false);
    fireEvent.click(redraw);

    expect(liveTerminalHandle.redraw).toHaveBeenCalledOnce();
    expect(liveTerminalHandle.focus).not.toHaveBeenCalled();
    expect(liveTerminalHandle.send).not.toHaveBeenCalled();
    expect(stagedInput).toHaveFocus();
  });

  it("toggles browser-owned terminal selection without remounting or sending input", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session(),
      session(null, "next-session"),
    ]);
    const view = renderWithTheme(
      <ConsoleScreen sessionName="test" onBack={vi.fn()} />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const terminal = screen.getByTestId("live-terminal");
    const copyMode = screen.getByRole("button", {
      name: "Browser terminal copy mode",
    });
    expect(copyMode).not.toBePressed();
    expect(copyMode).toHaveTextContent("Copy");
    expect(copyMode).toHaveAttribute("aria-controls", "muxdeck-active-console");
    expect(copyMode).toHaveAttribute("aria-keyshortcuts", "Control+Shift+C");
    expect(shell).toHaveAttribute("data-desktop-copy-mode", "false");
    expect(terminal).toHaveAttribute("data-browser-copy-mode", "false");

    expect(fireEvent.mouseDown(copyMode)).toBe(false);
    fireEvent.click(copyMode);

    expect(copyMode).toBePressed();
    expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");
    expect(terminal).toHaveAttribute("data-browser-copy-mode", "true");
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    expect(liveTerminalHandle.send).not.toHaveBeenCalled();
    expect(liveTerminalHandle.submit).not.toHaveBeenCalled();

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen sessionName="next-session" onBack={vi.fn()} />
      </ThemeProvider>,
    );

    await screen.findByRole("heading", { name: "next-session" });
    expect(screen.getByRole("button", {
      name: "Browser terminal copy mode",
    })).not.toBePressed();
    expect(screen.getByTestId("live-terminal"))
      .toHaveAttribute("data-browser-copy-mode", "false");
  });

  it("learns agent paging controls and captures the exact desktop terminal shortcuts", async () => {
    const claudeSession = {
      ...session(),
      panes: [{ ...pane(), command: "claude", title: "Claude Code" }],
    };
    const onSessionTerminated = vi.fn(async () => {});
    vi.mocked(listSessions).mockResolvedValue([claudeSession]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
        onSessionTerminated={onSessionTerminated}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    act(() => liveTerminalState.onStateChange?.("live"));
    const shell = screen.getByRole("main");
    const bottomControls = screen.getByRole("group", { name: "Terminal input shortcuts" });
    const mobileControls = screen.getByRole("navigation", { name: "Terminal view controls" });
    const rawPageUp = within(bottomControls).getByRole("button", { name: "PgUp" });
    const rawPageDown = within(bottomControls).getByRole("button", { name: "PgDn" });
    const tmuxPageUp = within(bottomControls).getByRole("button", { name: "Tmux Page Up" });
    const mobileRawPageUp = within(mobileControls).getByRole("button", {
      name: "Raw terminal Page Up",
    });
    const mobileTmuxPageUp = within(mobileControls).getByRole("button", {
      name: "Tmux Page Up",
    });

    expect(shell).toHaveAttribute("data-scroll-agent", "claude");
    expect(shell).toHaveAttribute("data-scroll-mode", "application");
    expect(rawPageUp).toHaveClass("preferred-scroll-key");
    expect(rawPageUp).toHaveAttribute("aria-keyshortcuts", "Control+Shift+U");
    expect(rawPageDown).toHaveAttribute("aria-keyshortcuts", "Control+Shift+D");
    expect(mobileRawPageUp).toHaveClass("preferred-scroll-control");
    expect(mobileRawPageUp).toHaveAttribute("aria-keyshortcuts", "Control+Shift+U");
    expect(tmuxPageUp).not.toHaveClass("preferred-scroll-key");
    expect(mobileTmuxPageUp).not.toHaveClass("preferred-scroll-control");

    expect(fireEvent.keyDown(window, {
      code: "KeyU",
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(fireEvent.keyDown(window, {
      code: "KeyD",
      key: "D",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(liveTerminalHandle.send.mock.calls).toEqual([
      ["\x1b[5~"],
      ["\x1b[6~"],
    ]);

    fireEvent.click(tmuxPageUp);
    expect(shell).toHaveAttribute("data-scroll-mode", "tmux");
    expect(tmuxPageUp).toHaveClass("preferred-scroll-key");
    expect(tmuxPageUp).toHaveAttribute("aria-keyshortcuts", "Control+Shift+U");
    expect(mobileTmuxPageUp).toHaveClass("preferred-scroll-control");
    expect(rawPageUp).not.toHaveClass("preferred-scroll-key");
    expect(JSON.parse(
      window.localStorage.getItem("muxdeck-agent-scroll-preferences") || "{}",
    )).toEqual({ claude: "tmux" });

    fireEvent.keyDown(window, {
      code: "KeyU",
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, {
      code: "KeyD",
      key: "D",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(liveTerminalHandle.navigateHistory.mock.calls).toEqual([
      ["page-up"],
      ["page-down"],
    ]);

    expect(fireEvent.keyDown(window, {
      code: "KeyC",
      key: "C",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");
    expect(fireEvent.keyDown(window, {
      code: "KeyC",
      key: "C",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    })).toBe(true);
    expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");

    expect(fireEvent.keyDown(window, {
      code: "KeyL",
      key: "L",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(liveTerminalHandle.navigateHistory).toHaveBeenLastCalledWith("exit");
    expect(liveTerminalHandle.jumpToLive).toHaveBeenCalledOnce();
    expect(liveTerminalHandle.focus).toHaveBeenCalledOnce();

    expect(fireEvent.keyDown(window, {
      code: "KeyE",
      key: "E",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(screen.getByRole("alertdialog", { name: "Terminate tmux session?" }))
      .toBeVisible();
    expect(onSessionTerminated).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(window, {
      code: "KeyC",
      key: "C",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(true);
    expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");
  });

  it("fills the desktop viewport without remounting the terminal or losing its draft", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session(),
      session(null, "next-session"),
    ]);
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const terminal = screen.getByTestId("live-terminal");
    const draft = screen.getByRole("textbox", { name: "Staged input" });
    const consoleBars = screen.getByRole("group", { name: "Console bars" });
    const terminalShortcuts = screen.getByRole("group", {
      name: "Terminal input shortcuts",
    });
    const enterFocus = within(consoleBars).getByRole("button", {
      name: "Enter desktop terminal focus",
    });
    const copyMode = within(consoleBars).getByRole("button", {
      name: "Browser terminal copy mode",
    });
    expect(within(terminalShortcuts).queryByRole("button", {
      name: "Enter desktop terminal focus",
    })).not.toBeInTheDocument();
    expect(enterFocus).toHaveTextContent("Focus");
    expect(enterFocus).toHaveAttribute("aria-controls", "muxdeck-active-console");
    expect(enterFocus).toHaveAttribute("aria-keyshortcuts", "Control+Shift+F");
    expect(enterFocus).not.toBePressed();
    fireEvent.input(draft, { target: { value: "keep this desktop draft" } });

    expect(shell).toHaveAttribute("data-desktop-focus", "false");
    fireEvent.click(copyMode);
    expect(copyMode).toBePressed();
    expect(terminal).toHaveAttribute("data-browser-copy-mode", "true");
    expect(terminal).toHaveAttribute(
      "data-layout-refresh-token",
      "terminal:standard:desktop-standard:desktop-tabs-horizontal:desktop-tab-rail-288",
    );
    expect(fireEvent.mouseDown(enterFocus)).toBe(false);
    fireEvent.click(enterFocus);

    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    expect(copyMode).not.toBePressed();
    expect(terminal).toHaveAttribute("data-browser-copy-mode", "false");
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    expect(draft).toHaveValue("keep this desktop draft");
    expect(terminal).toHaveAttribute(
      "data-layout-refresh-token",
      "terminal:standard:desktop-focus:desktop-tabs-horizontal:desktop-tab-rail-288",
    );
    const exitFocus = screen.getByRole("button", {
      name: "Exit desktop terminal focus",
    });
    const focusControls = screen.getByRole("group", {
      name: "Desktop terminal focus controls",
    });
    const focusRedraw = within(focusControls).getByRole("button", {
      name: "Redraw terminal display",
    });
    const focusShortcuts = within(focusControls).getByRole("button", {
      name: "Show all buttons",
    });
    expect(within(focusControls).getAllByRole("button")).toHaveLength(3);
    expect(focusRedraw).toHaveTextContent("Redraw");
    expect(focusShortcuts).toHaveTextContent("Show all buttons");
    expect(focusShortcuts).toHaveAttribute(
      "aria-controls",
      "muxdeck-terminal-shortcuts",
    );
    expect(focusShortcuts).toHaveAttribute("aria-expanded", "false");
    expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "false");
    expect(fireEvent.mouseDown(focusRedraw)).toBe(false);
    fireEvent.click(focusRedraw);
    expect(liveTerminalHandle.redraw).toHaveBeenCalledOnce();
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    expect(fireEvent.mouseDown(focusShortcuts)).toBe(false);
    fireEvent.click(focusShortcuts);
    expect(focusShortcuts).toHaveAttribute("aria-expanded", "true");
    expect(focusShortcuts).toHaveTextContent("Hide all buttons");
    expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "true");
    expect(within(terminalShortcuts).getByRole("button", {
      name: "Raw terminal keyboard",
    })).toBeInTheDocument();
    expect(within(terminalShortcuts).getByRole("button", {
      name: "Edit title and tags",
    })).toBeInTheDocument();
    expect(within(terminalShortcuts).getByRole("button", {
      name: "Open snippets",
    })).toBeInTheDocument();
    expect(within(terminalShortcuts).getByRole("button", {
      name: "Paste to draft",
    })).toBeInTheDocument();
    fireEvent.click(focusShortcuts);
    expect(focusShortcuts).toHaveAttribute("aria-expanded", "false");
    expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "false");
    expect(exitFocus).toHaveTextContent("Exit");
    expect(exitFocus).toBePressed();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    fireEvent.click(exitFocus);

    expect(shell).toHaveAttribute("data-desktop-focus", "false");
    expect(screen.queryByRole("group", {
      name: "Desktop terminal focus controls",
    })).not.toBeInTheDocument();
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    expect(draft).toHaveValue("keep this desktop draft");
    expect(terminal).toHaveAttribute(
      "data-layout-refresh-token",
      "terminal:standard:desktop-standard:desktop-tabs-horizontal:desktop-tab-rail-288",
    );
    await waitFor(() => expect(liveTerminalHandle.focus).toHaveBeenCalledTimes(3));

    expect(fireEvent.keyDown(window, {
      code: "KeyF",
      key: "F",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    expect(screen.getByRole("button", {
      name: "Exit desktop terminal focus",
    })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+F");
    expect(fireEvent.keyDown(window, {
      code: "KeyF",
      key: "f",
      ctrlKey: true,
    })).toBe(true);
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    expect(fireEvent.keyDown(window, {
      altKey: true,
      code: "KeyF",
      key: "F",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(true);
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    expect(fireEvent.keyDown(window, {
      code: "KeyF",
      key: "F",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(shell).toHaveAttribute("data-desktop-focus", "false");
    await waitFor(() => expect(liveTerminalHandle.focus).toHaveBeenCalledTimes(5));

    fireEvent.click(enterFocus);
    expect(shell).toHaveAttribute("data-desktop-focus", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show all buttons" }));
    expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "true");
    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="next-session"
          onBack={vi.fn()}
          sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
        />
      </ThemeProvider>,
    );
    await waitFor(() => expect(shell).toHaveAttribute("data-desktop-focus", "false"));
    expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "false");
  });

  it("offers every shortcut in focus even when the normal bottom strip is hidden", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        barVisibility={{
          sessionTabs: false,
          stagedInput: true,
          shortcuts: false,
        }}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shortcutStrip = document.getElementById("muxdeck-terminal-shortcuts");
    expect(shortcutStrip).not.toBeNull();
    expect(shortcutStrip).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", {
      name: "Enter desktop terminal focus",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Show all buttons" }));

    expect(shortcutStrip).not.toHaveAttribute("hidden");
    expect(screen.getByRole("group", {
      name: "Terminal input shortcuts",
    })).toBe(shortcutStrip);

    fireEvent.click(screen.getByRole("button", { name: "Hide all buttons" }));
    expect(shortcutStrip).toHaveAttribute("hidden");
  });

  it("moves the floating shortcut panel by pointer and keyboard within the viewport", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", {
      name: "Enter desktop terminal focus",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Show all buttons" }));

    const shell = screen.getByRole("main");
    const panel = screen.getByRole("region", { name: "Terminal input" });
    const moveHandle = screen.getByRole("button", {
      name: "Move floating button panel",
    });
    const rect = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1_000, 700));
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(100, 400, 800, 200));
    Object.defineProperties(moveHandle, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: { value: vi.fn(() => true), configurable: true },
      releasePointerCapture: { value: vi.fn(), configurable: true },
    });
    const dispatchPointer = (
      target: Window | Element,
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
      pointerId: number,
      clientX: number,
      clientY: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "mouse" },
        isPrimary: { value: true },
      });
      fireEvent(target, event);
    };
    const position = () => [
      shell.style.getPropertyValue("--desktop-focus-shortcuts-x"),
      shell.style.getPropertyValue("--desktop-focus-shortcuts-y"),
    ];

    expect(moveHandle).toHaveTextContent("Move panel");
    expect(position()).toEqual(["0px", "0px"]);
    fireEvent.keyDown(moveHandle, { key: "ArrowRight" });
    fireEvent.keyDown(moveHandle, { key: "ArrowUp", shiftKey: true });
    expect(position()).toEqual(["16px", "-64px"]);
    fireEvent.keyDown(moveHandle, { key: "Enter" });
    expect(position()).toEqual(["0px", "0px"]);

    dispatchPointer(moveHandle, "pointerdown", 7, 200, 450);
    expect(document.documentElement).toHaveClass("desktop-focus-shortcuts-moving");
    dispatchPointer(window, "pointermove", 8, 500, 250);
    expect(position()).toEqual(["0px", "0px"]);
    dispatchPointer(window, "pointermove", 7, 500, 250);
    expect(position()).toEqual(["88px", "-200px"]);
    dispatchPointer(window, "pointerup", 7, 500, 250);
    expect(document.documentElement).not.toHaveClass("desktop-focus-shortcuts-moving");

    fireEvent.click(screen.getByRole("button", { name: "Hide all buttons" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all buttons" }));
    expect(position()).toEqual(["88px", "-200px"]);
    fireEvent.doubleClick(screen.getByRole("button", {
      name: "Move floating button panel",
    }));
    expect(position()).toEqual(["0px", "0px"]);

    fireEvent.click(screen.getByRole("button", {
      name: "Exit desktop terminal focus",
    }));
    expect(position()).toEqual(["0px", "0px"]);
  });

  it("switches the desktop tab rail without remounting the terminal", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    const onDesktopTabOrientationChange = vi.fn();
    const onTabActionsVisibilityChange = vi.fn();
    const view = renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
        desktopTabOrientation="horizontal"
        onDesktopTabOrientationChange={onDesktopTabOrientationChange}
        tabActionsVisible
        onTabActionsVisibilityChange={onTabActionsVisibilityChange}
        desktopTabRailWidth={344}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const terminal = screen.getByTestId("live-terminal");
    const orientationToggle = within(screen.getByRole("group", {
      name: "Console bars",
    })).getByRole("button", { name: "Vertical session tabs" });
    const tabActionsToggle = within(screen.getByRole("group", {
      name: "Console bars",
    })).getByRole("button", { name: "Tab action buttons" });

    expect(shell).toHaveAttribute("data-desktop-tabs", "horizontal");
    expect(shell).toHaveAttribute("data-desktop-tab-rail-width", "344");
    expect(shell.style.getPropertyValue("--desktop-tab-rail-width")).toBe("344px");
    expect(shell).toHaveAttribute("data-session-tabs-visible", "true");
    expect(orientationToggle).not.toBePressed();
    expect(orientationToggle).toHaveAttribute("aria-controls", "muxdeck-session-tabs");
    expect(tabActionsToggle).toBePressed();
    expect(tabActionsToggle).toHaveTextContent("Actions");
    expect(tabActionsToggle).toHaveAttribute("aria-controls", "muxdeck-session-tabs");
    expect(tabActionsToggle).toHaveAttribute(
      "title",
      "Hide action buttons on every session tab (Ctrl+Shift+A)",
    );
    fireEvent.click(tabActionsToggle);
    expect(onTabActionsVisibilityChange).toHaveBeenCalledWith(false);
    fireEvent.click(orientationToggle);
    expect(onDesktopTabOrientationChange).toHaveBeenCalledWith("vertical");

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
          desktopTabOrientation="vertical"
          onDesktopTabOrientationChange={onDesktopTabOrientationChange}
          tabActionsVisible={false}
          onTabActionsVisibilityChange={onTabActionsVisibilityChange}
          desktopTabRailWidth={999}
        />
      </ThemeProvider>,
    );

    expect(shell).toHaveAttribute("data-desktop-tabs", "vertical");
    expect(shell).toHaveAttribute("data-desktop-tab-rail-width", "480");
    expect(shell.style.getPropertyValue("--desktop-tab-rail-width")).toBe("480px");
    expect(orientationToggle).toBePressed();
    expect(tabActionsToggle).not.toBePressed();
    expect(tabActionsToggle).toHaveAttribute(
      "title",
      "Show action buttons on every session tab (Ctrl+Shift+A)",
    );
    fireEvent.click(tabActionsToggle);
    expect(onTabActionsVisibilityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    expect(terminal).toHaveAttribute(
      "data-layout-refresh-token",
      "terminal:standard:desktop-standard:desktop-tabs-vertical:desktop-tab-rail-480",
    );
  });

  it("uses raw and tmux history controls and exits distraction-free mode for input", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const mobileFocus = screen.getByRole("navigation", { name: "Mobile console focus" });
    const terminalControls = screen.getByRole("navigation", {
      name: "Terminal view controls",
    });
    const rawPageUp = within(terminalControls).getByRole("button", {
      name: "Raw terminal Page Up",
    });
    const rawPageDown = within(terminalControls).getByRole("button", {
      name: "Raw terminal Page Down",
    });
    const tmuxPageUp = within(terminalControls).getByRole("button", {
      name: "Tmux Page Up",
    });
    const tmuxPageDown = within(terminalControls).getByRole("button", {
      name: "Tmux Page Down",
    });
    const returnToLive = within(terminalControls).getByRole("button", {
      name: "Return to live terminal",
    });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    const liveTerminal = screen.getByTestId("live-terminal");

    expect(rawPageUp).toBeDisabled();
    expect(rawPageDown).toBeDisabled();
    expect(tmuxPageUp).toBeDisabled();
    expect(tmuxPageDown).toBeDisabled();
    expect(returnToLive).toBeDisabled();
    act(() => liveTerminalState.onStateChange?.("live"));
    expect(rawPageUp).toBeEnabled();
    expect(rawPageDown).toBeEnabled();
    expect(tmuxPageUp).toBeEnabled();
    expect(tmuxPageDown).toBeEnabled();
    expect(returnToLive).toBeEnabled();
    expect(shell).toHaveAttribute("data-mobile-distraction-free", "false");
    const enterDistractionFree = within(terminalControls).getByRole("button", {
      name: "Enter distraction-free terminal",
    });
    expect(enterDistractionFree).not.toBePressed();
    for (const control of [
      rawPageUp,
      rawPageDown,
      tmuxPageUp,
      tmuxPageDown,
      returnToLive,
      enterDistractionFree,
    ]) {
      const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      expect(control.dispatchEvent(mouseDown)).toBe(false);
      expect(mouseDown.defaultPrevented).toBe(true);
    }

    fireEvent.input(stagedInput, { target: { value: "keep this reply available" } });
    fireEvent.click(rawPageUp);
    fireEvent.click(rawPageDown);
    fireEvent.click(tmuxPageUp);
    fireEvent.click(tmuxPageDown);
    fireEvent.click(returnToLive);

    expect(liveTerminalHandle.send.mock.calls).toEqual([
      ["\x1b[5~"],
      ["\x1b[6~"],
    ]);
    expect(liveTerminalHandle.navigateHistory.mock.calls).toEqual([
      ["page-up"],
      ["page-down"],
      ["exit"],
    ]);
    expect(liveTerminalHandle.jumpToLive).toHaveBeenCalledOnce();
    expect(liveTerminalHandle.focus).toHaveBeenCalledOnce();

    fireEvent.click(enterDistractionFree);

    expect(shell).toHaveAttribute("data-mobile-distraction-free", "true");
    const exitDistractionFree = within(terminalControls).getByRole("button", {
      name: "Exit distraction-free terminal",
    });
    expect(exitDistractionFree).toBePressed();
    expect(screen.queryByRole("button", {
      name: "Enter distraction-free terminal",
    })).not.toBeInTheDocument();
    expect(screen.getByTestId("live-terminal")).toBe(liveTerminal);
    expect(stagedInput).toHaveValue("keep this reply available");

    fireEvent.click(exitDistractionFree);

    expect(shell).toHaveAttribute("data-mobile-distraction-free", "false");
    expect(within(terminalControls).getByRole("button", {
      name: "Enter distraction-free terminal",
    })).not.toBePressed();

    fireEvent.click(within(terminalControls).getByRole("button", {
      name: "Enter distraction-free terminal",
    }));
    fireEvent.click(within(mobileFocus).getByRole("button", { name: "Input" }));

    expect(shell).toHaveAttribute("data-mobile-focus", "input");
    expect(shell).toHaveAttribute("data-mobile-distraction-free", "false");
    expect(within(mobileFocus).getByRole("button", { name: "Input" })).toBePressed();
    await waitFor(() => expect(stagedInput).toHaveFocus());
    expect(screen.getByTestId("live-terminal")).toBe(liveTerminal);
    expect(stagedInput).toHaveValue("keep this reply available");
    expect(liveTerminalHandle.navigateHistory).toHaveBeenCalledTimes(3);
    expect(liveTerminalHandle.send).toHaveBeenCalledTimes(2);
  });

  it("focuses staged input without remounting or resizing the terminal", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        sessionNavigation={<nav aria-label="Quick sessions">Workspace tabs</nav>}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const shell = screen.getByRole("main");
    const mobileFocus = screen.getByRole("navigation", { name: "Mobile console focus" });
    const stagedInput = screen.getByRole("textbox", { name: "Staged input" });
    const liveTerminal = screen.getByTestId("live-terminal");

    fireEvent.click(within(mobileFocus).getByRole("button", { name: "Input" }));
    await waitFor(() => expect(stagedInput).toHaveFocus());
    fireEvent.input(stagedInput, { target: { value: "queue\tthis exact draft" } });
    expect(liveTerminal).toHaveAttribute("data-layout-suspended", "false");

    const enterInputFocus = screen.getByRole("button", {
      name: "Enter distraction-free input",
    });
    expect(enterInputFocus).not.toBePressed();
    fireEvent.click(enterInputFocus);

    expect(shell).toHaveAttribute("data-mobile-focus", "input");
    expect(shell).toHaveAttribute("data-mobile-distraction-free", "true");
    expect(screen.getByTestId("live-terminal")).toBe(liveTerminal);
    expect(liveTerminal).toHaveAttribute("data-layout-suspended", "true");
    expect(stagedInput).toHaveValue("queue\tthis exact draft");
    await waitFor(() => expect(stagedInput).toHaveFocus());
    const exitInputFocus = screen.getByRole("button", {
      name: "Exit distraction-free input",
    });
    expect(exitInputFocus).toBePressed();

    fireEvent.click(exitInputFocus);

    expect(shell).toHaveAttribute("data-mobile-distraction-free", "false");
    expect(liveTerminal).toHaveAttribute("data-layout-suspended", "false");
    expect(screen.getByTestId("live-terminal")).toBe(liveTerminal);
    expect(stagedInput).toHaveValue("queue\tthis exact draft");
  });

  it("toggles console regions independently and keeps their toolbar available", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        workspaceLinks={<section aria-label="Workspace links">Pinned links</section>}
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
    const workspaceLinks = within(toolbar).getByRole("region", {
      name: "Workspace links",
    });

    expect(workspaceLinks).toBeVisible();
    expect(tabs).toBePressed();
    expect(tabs).toHaveAttribute("aria-controls", "muxdeck-session-tabs");
    expect(tabs).toHaveAttribute("aria-keyshortcuts", "Control+Shift+S");
    expect(tabs).toHaveAttribute("title", "Hide session tabs (Ctrl+Shift+S)");
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

    expect(fireEvent.keyDown(window, {
      code: "KeyS",
      key: "S",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(tabs).not.toBePressed();
    expect(tabs).toHaveAttribute("title", "Show session tabs (Ctrl+Shift+S)");
    expect(workspaceLinks).toBeVisible();
    expect(within(screen.getByRole("group", { name: "Console bars" }))
      .getAllByRole("button")).toHaveLength(5);

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
    expect(within(toolbar).queryByRole("button", {
      name: "Enter desktop terminal focus",
    })).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: "Edit title and tags" }));
      expect(screen.getByRole("dialog", { name: "Edit title and tags" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByText("This tmux session no longer exists.")).toBeVisible();
      expect(screen.queryByTestId("live-terminal")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Quick sessions" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByTestId("live-terminal")).toBeVisible();
      expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
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

    const titleButton = screen.getByRole("button", { name: "Edit title and tags" });
    await waitFor(() => expect(titleButton).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Browser terminal copy mode" }));
    expect(screen.getByTestId("live-terminal"))
      .toHaveAttribute("data-browser-copy-mode", "true");
    fireEvent.click(titleButton);
    expect(screen.getByRole("dialog", { name: "Edit title and tags" })).toBeVisible();

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen sessionName="test" onBack={vi.fn()} workspaceOverlayOpen />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
      .not.toBeInTheDocument();
    expect(screen.getByTestId("live-terminal"))
      .toHaveAttribute("data-browser-copy-mode", "false");

    view.rerender(
      <ThemeProvider>
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          workspaceOverlayOpen={false}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
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

  it("pins and unpins the current session from the desktop header", async () => {
    const current = session();
    vi.mocked(listSessions).mockResolvedValue([current]);
    vi.mocked(updateSessionWorkspacePin).mockResolvedValue({
      session: "test",
      workspacePinned: true,
      sessionRevision: 7,
    });
    const onSessionUpdate = vi.fn();
    const onWorkspacePinChange = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
        onWorkspacePinChange={onWorkspacePinChange}
      />,
    );

    const pin = await screen.findByRole("button", {
      name: "Pin test to every workspace",
    });
    expect(pin).not.toBePressed();
    fireEvent.click(pin);

    await waitFor(() => expect(updateSessionWorkspacePin).toHaveBeenCalledWith(
      "test",
      true,
    ));
    expect(screen.getByRole("button", {
      name: "Unpin test from every workspace",
    })).toBePressed();
    expect(onSessionUpdate).toHaveBeenCalledWith({
      ...current,
      workspacePinned: true,
    });
    expect(onWorkspacePinChange).toHaveBeenCalledWith("test", true, 7);
  });

  it("restores the console pin control and reports a failed request", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionWorkspacePin).mockRejectedValue(
      new Error("workspace storage is unavailable"),
    );
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Pin test to every workspace",
    }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(
      "Workspace pin failed: workspace storage is unavailable",
    );
    expect(screen.getByRole("button", {
      name: "Pin test to every workspace",
    })).not.toBePressed();
    fireEvent.click(within(error).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the desktop workspace transfer picker beside the global pin", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(listWorkspaces).mockResolvedValue([{
      id: "destination",
      name: "Release room",
      tabs: ["review"],
      groups: [],
      quickLinks: [],
      activeSession: "review",
      sessionRevision: 4,
      createdAt: 1,
      updatedAt: 2,
      lastActiveAt: 1,
    }]);
    const onSessionWorkspaceTransfer = vi.fn().mockResolvedValue({
      session: "test",
      operation: "copy",
      destinationAlreadyContained: false,
      destinationAdded: true,
      sourceRemoved: false,
      sourceWorkspace: null,
      destinationWorkspace: {
        id: "destination",
        name: "Release room",
        tabs: ["review", "test"],
        groups: [],
        quickLinks: [],
        activeSession: "review",
        sessionRevision: 5,
        createdAt: 1,
        updatedAt: 3,
        lastActiveAt: 1,
      },
      sessionRevision: 5,
    });
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        workspaceName="Current room"
        onBack={vi.fn()}
        onSessionWorkspaceTransfer={onSessionWorkspaceTransfer}
      />,
    );

    const transferButton = await screen.findByRole("button", {
      name: "Move or copy test to a workspace",
    });
    const pinButton = screen.getByRole("button", {
      name: "Pin test to every workspace",
    });
    expect(pinButton.nextElementSibling).toBe(transferButton);
    fireEvent.click(transferButton);

    expect(await screen.findByRole("dialog", {
      name: "Move or copy to a workspace",
    })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy test to Release room" }));
    await waitFor(() => expect(onSessionWorkspaceTransfer).toHaveBeenCalledWith(
      "test",
      "destination",
      "copy",
      4,
    ));
  });

  it("creates a focused session copy from the desktop header and exact shortcut", async () => {
    const firstCreation = deferred<{ name: string; id: string }>();
    const onSessionCopied = vi.fn();
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(copySession)
      .mockReturnValueOnce(firstCreation.promise)
      .mockResolvedValueOnce({ name: "test_2", id: "$3" });
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionCopied={onSessionCopied}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const copyNew = screen.getByRole("button", { name: "Copy New" });
    expect(copyNew).toHaveAttribute("aria-keyshortcuts", "Control+Shift+M");
    expect(copyNew).toHaveAttribute(
      "title",
      "Create and open a fresh session in this pane's working directory (Ctrl+Shift+M)",
    );

    fireEvent.click(copyNew);
    expect(copySession).toHaveBeenCalledWith("test", "$1", "dark");
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(fireEvent.keyDown(window, {
      code: "KeyM",
      key: "N",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(copySession).toHaveBeenCalledTimes(1);

    await act(async () => firstCreation.resolve({ name: "test_1", id: "$2" }));
    expect(onSessionCopied).toHaveBeenCalledWith("test", "test_1", "$2");

    expect(fireEvent.keyDown(window, {
      code: "KeyM",
      key: "N",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    })).toBe(true);
    expect(copySession).toHaveBeenCalledTimes(1);

    expect(fireEvent.keyDown(window, {
      code: "KeyM",
      key: "N",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    await waitFor(() => expect(onSessionCopied).toHaveBeenLastCalledWith(
      "test",
      "test_2",
      "$3",
    ));
    expect(fireEvent.keyDown(window, {
      code: "KeyM",
      key: "N",
      ctrlKey: true,
      shiftKey: true,
      repeat: true,
    })).toBe(false);
    expect(copySession).toHaveBeenCalledTimes(2);
  });

  it("keeps Copy New failures on the source session for dismissal", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(copySession).mockRejectedValue(new Error("source directory is gone"));
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionCopied={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Copy New" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Copy New failed: source directory is gone");
    fireEvent.click(within(error).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("inserts snippets from the staged composer at the current selection without sending", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(getSnippetTree).mockResolvedValue({
      revision: 1,
      tree: [{ id: "continue", type: "snippet", name: "Continue", text: "continue from here" }],
    });
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    const textarea = screen.getByRole("textbox", { name: "Staged input" }) as HTMLTextAreaElement;
    const snippetButton = screen.getByRole("button", {
      name: "Insert snippet into staged input",
    });
    fireEvent.input(textarea, { target: { value: "alpha omega" } });
    textarea.focus();
    textarea.setSelectionRange(6, 11);
    fireEvent.mouseDown(snippetButton);
    fireEvent.click(snippetButton);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("alpha continue from here"));
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
    fireEvent.click(screen.getByRole("button", { name: "Edit title and tags" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Mobile work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", "Mobile work"));
    expect(onSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      name: "test",
      customTitle: "Mobile work",
    }));
    expect(await screen.findByRole("heading", { name: "Mobile work" })).toBeVisible();
    expect(screen.getByText("test / /work")).toBeVisible();
    expect(document.title).toBe("Mobile work - Muxdeck");
    expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
      .not.toBeInTheDocument();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("updates session tags from the bottom details control", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ ...session(), tags: ["review"] }]);
    vi.mocked(updateSessionTags).mockResolvedValue(["review", "urgent"]);
    const onSessionUpdate = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Edit title and tags" }));
    expect(screen.getByRole("checkbox", { name: "Review" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionTags).toHaveBeenCalledWith(
      "test",
      ["review", "urgent"],
    ));
    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(onSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      name: "test",
      tags: ["review", "urgent"],
    }));
  });

  it("atomically updates title and tags from the details control", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ ...session(), tags: ["review"] }]);
    vi.mocked(updateSessionDetails).mockResolvedValue({
      customTitle: "Release review",
      tags: ["review", "urgent"],
    });
    const onSessionUpdate = vi.fn();
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Edit title and tags" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Release review" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSessionDetails).toHaveBeenCalledWith(
      "test",
      "Release review",
      ["review", "urgent"],
    ));
    expect(updateSessionTitle).not.toHaveBeenCalled();
    expect(updateSessionTags).not.toHaveBeenCalled();
    expect(onSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      customTitle: "Release review",
      tags: ["review", "urgent"],
    }));
  });

  it("clears the human title without renaming the tmux session", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Old label")]);
    vi.mocked(updateSessionTitle).mockResolvedValue(null);
    renderWithTheme(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "Old label" });
    fireEvent.click(screen.getByRole("button", { name: "Edit title and tags" }));
    const titleDialog = screen.getByRole("dialog", { name: "Edit title and tags" });
    fireEvent.click(within(titleDialog).getByRole("button", { name: "Clear title" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

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
    const aliasButton = screen.getByRole("button", { name: "Edit title and tags" });
    const renameButton = screen.getByRole("button", { name: "Rename tmux session" });
    await waitFor(() => expect(renameButton).toBeEnabled());
    expect(aliasButton).toBeEnabled();
    expect(renameButton).toHaveAttribute("aria-keyshortcuts", "Control+Shift+R");
    expect(renameButton).toHaveAttribute("title", expect.stringContaining("Ctrl+Shift+R"));

    expect(fireEvent.keyDown(window, {
      code: "KeyR",
      key: "R",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "Rename tmux session" });
    expect(within(dialog).getByRole("textbox", { name: "Native tmux name" }))
      .toHaveValue("test");
    expect(dialog).toHaveTextContent("display title is preserved");
    expect(screen.queryByRole("dialog", { name: "Edit title and tags" }))
      .not.toBeInTheDocument();
    expect(fireEvent.keyDown(window, {
      code: "KeyR",
      key: "R",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(true);

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

  it("offers guarded termination from the bottom controls without requiring a live PTY", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Display alias")]);
    const onSessionTerminated = vi.fn(async () => {});
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionTerminated={onSessionTerminated}
      />,
    );

    await screen.findByRole("heading", { name: "Display alias" });
    const shortcuts = screen.getByRole("group", { name: "Terminal input shortcuts" });
    const endButton = within(shortcuts).getByRole("button", {
      name: "Terminate tmux session",
    });
    expect(endButton).toBeEnabled();
    expect(endButton).toHaveTextContent("End");
    expect(within(screen.getByRole("navigation", { name: "Terminal view controls" }))
      .getByRole("button", { name: "Terminate tmux session" })).toBeEnabled();

    fireEvent.click(endButton);
    const confirmation = screen.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    });
    expect(confirmation).toHaveTextContent("Display alias");
    expect(confirmation).toHaveTextContent("test");
    expect(onSessionTerminated).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", {
      name: "Terminate session",
    }));

    await waitFor(() => expect(onSessionTerminated)
      .toHaveBeenCalledWith("test", "$1", 1, 10, 100));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps an open termination confirmation bound to its original tmux ID", async () => {
    vi.useFakeTimers();
    try {
      const replacement = { ...session("Replacement alias"), serverStarted: 20 };
      vi.mocked(listSessions)
        .mockResolvedValueOnce([session("Original alias")])
        .mockResolvedValue([replacement]);
      const onSessionTerminated = vi.fn(async () => {});
      renderWithTheme(
        <ConsoleScreen
          sessionName="test"
          onBack={vi.fn()}
          onSessionTerminated={onSessionTerminated}
        />,
      );

      await act(async () => { await Promise.resolve(); });
      fireEvent.click(within(screen.getByRole("group", {
        name: "Terminal input shortcuts",
      })).getByRole("button", { name: "Terminate tmux session" }));
      const confirmation = screen.getByRole("alertdialog", {
        name: "Terminate tmux session?",
      });
      expect(confirmation).toHaveTextContent("Original alias");

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      expect(screen.getByRole("heading", { name: "Replacement alias" })).toBeVisible();
      expect(confirmation).toHaveTextContent("Original alias");
      expect(confirmation).not.toHaveTextContent("Replacement alias");
      await act(async () => {
        fireEvent.click(within(confirmation).getByRole("button", {
          name: "Terminate session",
        }));
        await Promise.resolve();
      });

      expect(onSessionTerminated).toHaveBeenCalledWith("test", "$1", 1, 10, 100);
      expect(onSessionTerminated)
        .not.toHaveBeenCalledWith("test", "$1", 1, 20, 100);
    } finally {
      vi.useRealTimers();
    }
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

  it("removes a queued memorandum after its unchanged staged input is acknowledged", async () => {
    const queuedMemo = {
      id: "memo-1",
      text: "Review the latest test failure",
      state: "queued" as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      position: 0,
    };
    const loadedSession = { ...session(), memorandumCount: 1, queuedMessageCount: 1 };
    const onSessionUpdate = vi.fn();
    vi.mocked(listSessions).mockResolvedValue([loadedSession]);
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "test",
      messages: [queuedMemo],
    });
    vi.mocked(updateQueuedMessage).mockResolvedValue({ ...queuedMemo, state: "note" });
    vi.mocked(deleteQueuedMessage).mockResolvedValue(undefined);
    liveTerminalHandle.submit.mockResolvedValue(true);
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    act(() => liveTerminalState.onStateChange?.("live"));
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda, 1 queued" }));
    expect(await screen.findByText("Review the latest test failure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Memo" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("Review the latest test failure");
    expect(updateQueuedMessage).toHaveBeenCalledWith("test", "memo-1", { state: "note" });

    fireEvent.click(screen.getByRole("button", { name: "Send + Enter" }));

    await waitFor(() => expect(liveTerminalHandle.submit).toHaveBeenCalledWith(
      queuedMemo.text,
      "enter",
    ));
    await waitFor(() => expect(deleteQueuedMessage).toHaveBeenCalledWith("test", "memo-1"));
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("");
    expect(onSessionUpdate).toHaveBeenLastCalledWith({
      ...loadedSession,
      memorandumCount: 0,
      queuedMessageCount: 0,
    });
  });

  it("queues staged input without a live PTY and updates the memo count immediately", async () => {
    const loadedSession = { ...session(), memorandumCount: 2, queuedMessageCount: 2 };
    const onSessionUpdate = vi.fn();
    vi.mocked(listSessions).mockResolvedValue([loadedSession]);
    vi.mocked(createQueuedMessage).mockResolvedValue({
      id: "memo-3",
      text: "  keep this for later\n",
      state: "queued",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      position: 2,
    });
    renderWithTheme(
      <ConsoleScreen
        sessionName="test"
        onBack={vi.fn()}
        onSessionUpdate={onSessionUpdate}
      />,
    );

    await screen.findByRole("heading", { name: "test" });
    const textarea = screen.getByRole("textbox", { name: "Staged input" });
    fireEvent.input(textarea, { target: { value: "  keep this for later\n" } });
    const addButton = screen.getByRole("button", { name: "Queue in memo" });
    expect(addButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send + Enter" })).toBeDisabled();

    fireEvent.click(addButton);

    await waitFor(() => expect(createQueuedMessage).toHaveBeenCalledWith(
      "test",
      "  keep this for later\n",
      "queued",
    ));
    await waitFor(() => expect(textarea).toHaveValue(""));
    const memoButton = screen.getByRole("button", { name: "Open memoranda, 3 queued" });
    expect(within(memoButton).getByText("Memo")).toBeVisible();
    expect(within(memoButton).getByText("Q 3")).toBeVisible();
    expect(onSessionUpdate).toHaveBeenCalledWith({
      ...loadedSession,
      memorandumCount: 3,
      queuedMessageCount: 3,
    });
  });
});
