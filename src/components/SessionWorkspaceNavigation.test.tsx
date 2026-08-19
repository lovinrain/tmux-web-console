import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { Pane, Session } from "../types";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import {
  COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH,
  DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
  MAX_DESKTOP_TAB_RAIL_WIDTH,
  MIN_DESKTOP_TAB_RAIL_WIDTH,
  MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID,
  SessionWorkspaceNavigation,
  clampDesktopTabRailWidth,
} from "./SessionWorkspaceNavigation";

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
    history_limit: 2_000,
    alternate_on: false,
    dead: false,
    activity: 1,
    ...overrides,
  };
}

function session(overrides: Partial<Session> & Pick<Session, "name">): Session {
  return {
    id: `$${overrides.name}`,
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent detected",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [pane()],
    ...overrides,
    tags: overrides.tags ?? [],
  };
}

const sessions: Session[] = [
  session({
    name: "alpha",
    customTitle: "Alpha control",
    activity: 40,
    agentState: "waiting_human",
    panes: [pane({ command: "codex", path: "/srv/alpha", title: "review" })],
  }),
  session({
    name: "beta",
    activity: 30,
    agentState: "working",
    panes: [pane({ command: "claude", path: "/srv/beta", title: "worker" })],
  }),
  session({
    name: "archive",
    customTitle: "Archived deploy",
    activity: 20,
    agentState: "waiting_command",
    panes: [pane({ command: "bash", path: "/srv/archive", title: "kubectl logs" })],
  }),
  session({
    name: "zulu",
    customTitle: "Zulu shell",
    activity: 10,
    panes: [pane({ command: "zsh", path: "/srv/zulu" })],
  }),
];

type NavigationProps = ComponentProps<typeof SessionWorkspaceNavigation>;

function navigationProps(overrides: Partial<NavigationProps> = {}): NavigationProps {
  return {
    activeSession: "alpha",
    openSessions: ["alpha", "beta"],
    recentSessions: ["alpha", "archive", "ended", "beta"],
    sessions,
    recentsOpen: false,
    onSelect: vi.fn(),
    onCloseTab: vi.fn(),
    onOpenRecents: vi.fn(),
    onCloseRecents: vi.fn(),
    onClearRecents: vi.fn(),
    onOpenDashboard: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  document.body.style.overflow = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("SessionWorkspaceNavigation", () => {
  it("clamps desktop tab rail widths to finite hard limits", () => {
    expect(MIN_DESKTOP_TAB_RAIL_WIDTH).toBe(72);
    expect(COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH).toBe(176);
    expect(clampDesktopTabRailWidth(MIN_DESKTOP_TAB_RAIL_WIDTH - 80))
      .toBe(MIN_DESKTOP_TAB_RAIL_WIDTH);
    expect(clampDesktopTabRailWidth(MAX_DESKTOP_TAB_RAIL_WIDTH + 80))
      .toBe(MAX_DESKTOP_TAB_RAIL_WIDTH);
    expect(clampDesktopTabRailWidth(302.6)).toBe(303);
    expect(clampDesktopTabRailWidth(Number.NaN)).toBe(DEFAULT_DESKTOP_TAB_RAIL_WIDTH);
    expect(clampDesktopTabRailWidth(Number.POSITIVE_INFINITY))
      .toBe(DEFAULT_DESKTOP_TAB_RAIL_WIDTH);
  });

  it("labels Grok panes in the session switcher", () => {
    const grokSession = session({
      name: "grok-work",
      agentState: "waiting_human",
      panes: [pane({ command: "grok" })],
    });
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          activeSession: "grok-work",
          openSessions: ["grok-work"],
          recentSessions: ["grok-work"],
          sessions: [grokSession],
          recentsOpen: true,
        })}
      />,
    );

    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    expect(within(openGroup).getByText("Grok")).toBeVisible();
  });

  it("labels the Copilot npm wrapper without accepting deceptive Node titles", () => {
    const copilotSession = session({
      name: "copilot-work",
      agentState: "unknown",
      panes: [pane({ command: "node", title: "~/repo - GitHub Copilot" })],
    });
    const deceptiveNodeSession = session({
      name: "node-work",
      panes: [pane({ command: "node", title: "GitHub Copilot dashboard" })],
    });
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          activeSession: "copilot-work",
          openSessions: ["copilot-work", "node-work"],
          recentSessions: ["copilot-work", "node-work"],
          sessions: [copilotSession, deceptiveNodeSession],
          recentsOpen: true,
        })}
      />,
    );

    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    expect(within(openGroup).getByText("Copilot")).toBeVisible();
    expect(within(openGroup).getByText("node")).toBeVisible();
  });

  it("provides roving keyboard focus, tab activation, closing, and a recent count", () => {
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    expect(navigation).toHaveAttribute("id", "muxdeck-session-tabs");
    expect(navigation).toHaveAttribute("data-orientation", "horizontal");
    expect(navigation).toHaveClass("workspace-navigation-horizontal");
    expect(screen.getByRole("tablist", { name: "Session workspace tabs" }))
      .toHaveAttribute("aria-orientation", "horizontal");
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    expect(alpha.querySelector(".workspace-tab-compact-index"))
      .toHaveAttribute("data-index", "1");
    expect(beta.querySelector(".workspace-tab-compact-index"))
      .toHaveAttribute("data-index", "2");
    expect(alpha.querySelector(".workspace-tab-compact-index"))
      .toHaveAttribute("aria-hidden", "true");
    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(alpha).toHaveAttribute("aria-controls", "muxdeck-active-console");
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(beta).not.toHaveAttribute("aria-controls");
    expect(beta).toHaveAttribute("tabindex", "-1");

    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(beta).toHaveFocus();
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.click(beta);
    expect(props.onSelect).toHaveBeenCalledWith("beta");

    fireEvent.keyDown(beta, { key: "End" });
    expect(zulu).toHaveFocus();
    fireEvent.keyDown(zulu, { key: "ArrowRight" });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: "ArrowLeft" });
    expect(zulu).toHaveFocus();
    fireEvent.keyDown(zulu, { key: "Home" });
    expect(alpha).toHaveFocus();

    const closeBeta = screen.getByRole("button", { name: "Close beta quick tab" });
    closeBeta.focus();
    fireEvent.click(closeBeta);
    expect(props.onCloseTab).toHaveBeenCalledWith("beta");
    view.rerender(
      <SessionWorkspaceNavigation {...props} openSessions={["alpha", "zulu"]} />,
    );
    expect(alpha).toHaveFocus();

    const recents = screen.getByRole("button", {
      name: "Open session switcher, 3 recently visited",
    });
    expect(recents).toHaveTextContent("3");
    fireEvent.click(recents);
    expect(props.onOpenRecents).toHaveBeenCalledOnce();
  });

  it("uses vertical tab semantics, arrow traversal, and reorder controls", () => {
    const onMoveTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          onMoveTab,
        })}
        orientation="vertical"
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    expect(navigation).toHaveAttribute("data-orientation", "vertical");
    expect(navigation).toHaveClass("workspace-navigation-vertical");
    expect(screen.getByRole("tablist", { name: "Session workspace tabs" }))
      .toHaveAttribute("aria-orientation", "vertical");

    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: "ArrowUp" });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: "ArrowUp" });
    expect(zulu).toHaveFocus();
    fireEvent.keyDown(zulu, { key: "Home" });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: "End" });
    expect(zulu).toHaveFocus();

    const moveBetaUp = screen.getByRole("button", { name: "Move beta tab up" });
    const moveBetaDown = screen.getByRole("button", { name: "Move beta tab down" });
    expect(moveBetaUp).toHaveClass("workspace-tab-move-up");
    expect(moveBetaDown).toHaveClass("workspace-tab-move-down");
    expect(moveBetaUp).toHaveAttribute("title", "Move tab up");
    expect(moveBetaDown).toHaveAttribute("title", "Move tab down");
    expect(moveBetaUp.querySelector("path"))
      .toHaveAttribute("d", "m6 14 6-6 6 6");
    expect(moveBetaDown.querySelector("path"))
      .toHaveAttribute("d", "m6 10 6 6 6-6");
    expect(screen.queryByRole("button", { name: "Move beta tab left" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move beta tab right" }))
      .not.toBeInTheDocument();

    fireEvent.click(moveBetaUp);
    expect(onMoveTab).toHaveBeenCalledWith("beta", 0);
  });

  it("resizes vertical tabs by pointer and keyboard, committing only completed changes", () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly isPrimary: boolean;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const onDesktopTabRailWidthChange = vi.fn();

    function ResizableNavigation() {
      const [width, setWidth] = useState(DEFAULT_DESKTOP_TAB_RAIL_WIDTH);
      return (
        <SessionWorkspaceNavigation
          {...navigationProps()}
          orientation="vertical"
          desktopTabRailWidth={width}
          onDesktopTabRailWidthChange={(nextWidth) => {
            onDesktopTabRailWidthChange(nextWidth);
            setWidth(nextWidth);
          }}
        />
      );
    }

    render(<ResizableNavigation />);
    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    const handle = screen.getByRole("separator", { name: "Resize vertical session tabs" });
    expect(navigation).toHaveStyle({
      position: "relative",
      width: `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH}px`,
      "--desktop-tab-rail-width": `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH}px`,
    });
    expect(navigation).not.toHaveAttribute("data-compact");
    expect(handle).toHaveClass("workspace-tab-rail-resize-handle");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", `${MIN_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(handle).toHaveAttribute("aria-valuemax", `${MAX_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(handle).toHaveAttribute("aria-valuenow", `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(handle).toHaveAttribute("aria-valuetext", `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH} pixels`);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "312");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", `${MIN_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(navigation).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("button", { name: "All sessions" }))
      .toHaveAttribute("aria-label", "All sessions");
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("aria-label", "Alpha control, Needs input");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", `${MAX_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(navigation).not.toHaveAttribute("data-compact");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(handle).toHaveAttribute("aria-valuenow", `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH}`);
    expect(onDesktopTabRailWidthChange.mock.calls.map(([width]) => width)).toEqual([
      280,
      312,
      MIN_DESKTOP_TAB_RAIL_WIDTH,
      MAX_DESKTOP_TAB_RAIL_WIDTH,
      DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
    ]);

    onDesktopTabRailWidthChange.mockClear();
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 300,
      isPrimary: false,
      pointerId: 9,
    });
    fireEvent.pointerDown(handle, { button: 2, clientX: 300, pointerId: 9 });
    expect(document.documentElement).not.toHaveClass("workspace-tab-rail-resizing");

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    expect(document.documentElement).toHaveClass("workspace-tab-rail-resizing");
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 7 });
    fireEvent.pointerUp(window, { clientX: 420, pointerId: 7 });
    expect(navigation).toHaveStyle({ width: "288px" });
    expect(document.documentElement).toHaveClass("workspace-tab-rail-resizing");
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 1 });
    expect(navigation).toHaveStyle({ width: "348px" });
    expect(handle).toHaveAttribute("aria-valuenow", "348");
    expect(onDesktopTabRailWidthChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: 360, pointerId: 1 });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledOnce();
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledWith(348);
    expect(document.documentElement).not.toHaveClass("workspace-tab-rail-resizing");

    onDesktopTabRailWidthChange.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 250, pointerId: 2 });
    expect(navigation).toHaveStyle({ width: "298px" });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(navigation).toHaveStyle({ width: "348px" });
    expect(onDesktopTabRailWidthChange).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("workspace-tab-rail-resizing");

    fireEvent.doubleClick(handle);
    expect(navigation).toHaveStyle({ width: `${DEFAULT_DESKTOP_TAB_RAIL_WIDTH}px` });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledOnce();
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledWith(
      DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
    );

    onDesktopTabRailWidthChange.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 330, pointerId: 3 });
    expect(navigation).toHaveStyle({ width: "318px" });
    fireEvent.lostPointerCapture(handle, { pointerId: 3 });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledWith(318);
    expect(document.documentElement).not.toHaveClass("workspace-tab-rail-resizing");

    onDesktopTabRailWidthChange.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 4 });
    fireEvent.pointerMove(window, { clientX: -1_000, pointerId: 4 });
    expect(navigation).toHaveStyle({ width: `${MIN_DESKTOP_TAB_RAIL_WIDTH}px` });
    expect(navigation).toHaveAttribute("data-compact", "true");
    expect(handle).toHaveAttribute("aria-valuenow", `${MIN_DESKTOP_TAB_RAIL_WIDTH}`);
    fireEvent.pointerUp(window, { clientX: -1_000, pointerId: 4 });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledWith(
      MIN_DESKTOP_TAB_RAIL_WIDTH,
    );

    onDesktopTabRailWidthChange.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 5 });
    fireEvent.pointerMove(window, { clientX: 2_000, pointerId: 5 });
    expect(navigation).toHaveStyle({ width: `${MAX_DESKTOP_TAB_RAIL_WIDTH}px` });
    expect(navigation).not.toHaveAttribute("data-compact");
    expect(handle).toHaveAttribute("aria-valuenow", `${MAX_DESKTOP_TAB_RAIL_WIDTH}`);
    fireEvent.pointerUp(window, { clientX: 2_000, pointerId: 5 });
    expect(onDesktopTabRailWidthChange).toHaveBeenCalledWith(
      MAX_DESKTOP_TAB_RAIL_WIDTH,
    );
  });

  it("caps the vertical tab rail to preserve main content width", () => {
    vi.stubGlobal("visualViewport", { width: 700, height: 800 });
    render(
      <SessionWorkspaceNavigation
        {...navigationProps()}
        orientation="vertical"
        desktopTabRailWidth={MAX_DESKTOP_TAB_RAIL_WIDTH}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    const handle = screen.getByRole("separator", { name: "Resize vertical session tabs" });
    expect(navigation).toHaveStyle({ width: "340px" });
    expect(handle).toHaveAttribute("aria-valuemax", "340");
    expect(handle).toHaveAttribute("aria-valuenow", "340");
  });

  it("exposes compact rail state at the narrow-width boundary only", () => {
    const props = navigationProps();
    const view = render(
      <SessionWorkspaceNavigation
        {...props}
        orientation="vertical"
        desktopTabRailWidth={COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    expect(navigation).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("aria-label", "Alpha control, Needs input");

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        orientation="vertical"
        desktopTabRailWidth={COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH + 1}
      />,
    );
    expect(navigation).not.toHaveAttribute("data-compact");

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        orientation="horizontal"
        desktopTabRailWidth={MIN_DESKTOP_TAB_RAIL_WIDTH}
      />,
    );
    expect(navigation).not.toHaveAttribute("data-compact");
  });

  it("keeps the compact mobile tab surface horizontal", () => {
    vi.stubGlobal("visualViewport", { width: 390, height: 664 });
    render(
      <SessionWorkspaceNavigation
        {...navigationProps()}
        orientation="vertical"
      />,
    );

    expect(screen.getByRole("navigation", { name: "Session workspace" }))
      .toHaveAttribute("data-orientation", "horizontal");
    expect(screen.getByRole("tablist", { name: "Session workspace tabs" }))
      .toHaveAttribute("aria-orientation", "horizontal");
    expect(screen.queryByRole("separator", { name: "Resize vertical session tabs" }))
      .not.toBeInTheDocument();
  });

  it.each(["horizontal", "vertical"] as const)(
    "keeps the New session action beside Sessions in the %s tab layout",
    (orientation) => {
      render(
        <SessionWorkspaceNavigation
          {...navigationProps({ onNewSession: vi.fn() })}
          orientation={orientation}
        />,
      );

      const sessionsButton = screen.getByRole("button", { name: "All sessions" });
      const newSessionButton = screen.getByRole("button", { name: "New session" });
      expect(sessionsButton.nextElementSibling).toBe(newSessionButton);
      expect(newSessionButton.nextElementSibling).toHaveClass("workspace-tab-viewport");
    },
  );

  it("opens a synthetic New session tab from the fixed tab-bar action", () => {
    const onNewSession = vi.fn();
    const props = navigationProps({ onNewSession });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    const openNewSession = screen.getByRole("button", { name: "New session" });
    expect(openNewSession).toHaveAttribute("title", "New session");
    expect(within(openNewSession).getByText("New session")).toBeInTheDocument();
    expect(openNewSession).not.toHaveAttribute("aria-current");
    fireEvent.click(openNewSession);
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();

    view.rerender(
      <SessionWorkspaceNavigation {...props} newSessionActive />,
    );
    expect(openNewSession).toBeDisabled();
    expect(openNewSession).toHaveAttribute("aria-current", "page");
    expect(openNewSession).toHaveAttribute("title", "New session is already open");
    fireEvent.click(openNewSession);
    expect(onNewSession).toHaveBeenCalledOnce();

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        workspacePersistenceState="loading"
      />,
    );
    expect(openNewSession).toBeDisabled();
    expect(openNewSession).not.toHaveAttribute("aria-current");
    expect(openNewSession).toHaveAttribute(
      "title",
      "Wait for workspace to finish opening",
    );
    fireEvent.click(openNewSession);
    expect(onNewSession).toHaveBeenCalledOnce();

    view.rerender(<SessionWorkspaceNavigation {...navigationProps()} />);
    expect(screen.queryByRole("button", { name: "New session" })).not.toBeInTheDocument();
  });

  it("confirms termination from a live quick tab without confusing it with closing", async () => {
    const onSessionTerminated = vi.fn(async () => {});
    const props = navigationProps({
      openSessions: ["alpha", "ended"],
      onSessionTerminated,
    });
    render(<SessionWorkspaceNavigation {...props} />);

    expect(screen.queryByRole("button", { name: "Terminate ended tmux session" }))
      .not.toBeInTheDocument();
    const terminateAlpha = screen.getByRole("button", {
      name: "Terminate Alpha control tmux session",
    });
    expect(terminateAlpha).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getByRole("button", { name: "Close Alpha control quick tab" }))
      .toBeVisible();

    terminateAlpha.focus();
    fireEvent.click(terminateAlpha);

    const confirmation = screen.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    });
    expect(confirmation).toHaveTextContent("Alpha control");
    expect(onSessionTerminated).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole("button", { name: "Terminate session" }));
    await waitFor(() => expect(onSessionTerminated).toHaveBeenCalledWith(
      "alpha",
      "$alpha",
      1,
      10,
      100,
    ));
    expect(screen.queryByRole("alertdialog", { name: "Terminate tmux session?" }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(terminateAlpha).toHaveFocus());
  });

  it("focuses a visible console control after active Overview termination hides the tabs", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    const onSessionTerminated = vi.fn();

    function TerminationRouteHarness() {
      const [route, setRoute] = useState({
        activeSession: "alpha",
        openSessions: ["alpha", "beta"],
        recentsOpen: true,
        liveSessions: sessions,
      });

      return (
        <>
          <header className="console-header">
            <button type="button" className="back-button">Back to sessions</button>
          </header>
          <SessionWorkspaceNavigation
            {...navigationProps()}
            activeSession={route.activeSession}
            openSessions={route.openSessions}
            recentsOpen={route.recentsOpen}
            sessions={route.liveSessions}
            tabsVisible={false}
            onSessionTerminated={async (...identity) => {
              onSessionTerminated(...identity);
              // Match the routed console: the old Overview can survive the first focus frame.
              window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                setRoute({
                  activeSession: "beta",
                  openSessions: ["beta"],
                  recentsOpen: false,
                  liveSessions: sessions.filter((item) => item.name !== "alpha"),
                });
              }));
            }}
          />
        </>
      );
    }

    render(<TerminationRouteHarness />);
    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(overview).getByRole("button", {
      name: "Terminate Alpha control tmux session",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));

    await waitFor(() => expect(onSessionTerminated).toHaveBeenCalledWith(
      "alpha",
      "$alpha",
      1,
      10,
      100,
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch sessions" }))
      .not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to sessions" }))
      .toHaveFocus());
  });

  it("reorders tabs with explicit controls without selecting or closing them", () => {
    const onMoveTab = vi.fn();
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
    });

    function ReorderHarness() {
      const [openSessions, setOpenSessions] = useState(props.openSessions);
      return (
        <SessionWorkspaceNavigation
          {...props}
          openSessions={openSessions}
          onMoveTab={(sessionName, targetIndex) => {
            onMoveTab(sessionName, targetIndex);
            setOpenSessions((current) => {
              const sourceIndex = current.indexOf(sessionName);
              const next = [...current];
              next.splice(sourceIndex, 1);
              next.splice(targetIndex, 0, sessionName);
              return next;
            });
          }}
        />
      );
    }

    render(<ReorderHarness />);

    expect(screen.getByRole("button", { name: "Move Alpha control tab left" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Zulu shell tab right" }))
      .toBeDisabled();
    const moveBetaLeft = screen.getByRole("button", { name: "Move beta tab left" });
    moveBetaLeft.focus();
    fireEvent.click(moveBetaLeft);

    expect(onMoveTab).toHaveBeenCalledWith("beta", 0);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Move beta tab right" })).toHaveFocus();
    expect(screen.getAllByRole("tab").map((tab) => (
      tab.querySelector(".workspace-tab-title")?.textContent
    ))).toEqual([
      "beta",
      "Alpha control",
      "Zulu shell",
    ]);
    expect(screen.getByRole("tab", { name: "beta, Working" }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+1");
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+2");
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("beta moved to position 1 of 3.", { selector: "[role='status']" }))
      .toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Move beta tab left" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move beta tab left" }));
    expect(onMoveTab).toHaveBeenCalledTimes(1);
  });

  it("omits reorder controls when reordering is unavailable or only one tab is open", () => {
    const view = render(<SessionWorkspaceNavigation {...navigationProps()} />);
    expect(screen.queryByRole("group", { name: /Reorder .* tab/ })).not.toBeInTheDocument();

    view.rerender(
      <SessionWorkspaceNavigation
        {...navigationProps({ openSessions: ["alpha"], onMoveTab: vi.fn() })}
      />,
    );
    expect(screen.queryByRole("group", { name: /Reorder .* tab/ })).not.toBeInTheDocument();
  });

  it("reorders the full tab order from Overview even when its list is filtered", () => {
    const onMoveTab = vi.fn();
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
      recentSessions: ["alpha", "beta", "zulu"],
      recentsOpen: true,
    });

    function OverviewReorderHarness() {
      const [openSessions, setOpenSessions] = useState(props.openSessions);
      return (
        <SessionWorkspaceNavigation
          {...props}
          openSessions={openSessions}
          onMoveTab={(sessionName, targetIndex) => {
            onMoveTab(sessionName, targetIndex);
            setOpenSessions((current) => {
              const next = [...current];
              next.splice(current.indexOf(sessionName), 1);
              next.splice(targetIndex, 0, sessionName);
              return next;
            });
          }}
        />
      );
    }

    render(<OverviewReorderHarness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a workspace session" }), {
      target: { value: "beta" },
    });

    const moveBetaUp = screen.getByRole("button", { name: "Move beta tab up" });
    moveBetaUp.focus();
    fireEvent.click(moveBetaUp);

    expect(onMoveTab).toHaveBeenCalledWith("beta", 0);
    expect(moveBetaUp).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move beta tab down" })).toHaveFocus();
    expect(screen.getByText("beta moved to position 1 of 3.", { selector: "[role='status']" }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear workspace search" }));
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    expect([...openGroup.querySelectorAll(".workspace-session-copy strong")]
      .map((title) => title.textContent)).toEqual(["beta", "Alpha control", "Zulu shell"]);
    expect(within(openGroup).getByRole("button", { name: "Move Zulu shell tab down" }))
      .toBeDisabled();
  });

  it("hides only the tab navigation while keeping status and Recents mounted", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps()}
        tabsVisible={false}
        recentsOpen
      />,
    );

    expect(screen.queryByRole("navigation", { name: "Session workspace" })).not.toBeInTheDocument();
    expect(document.getElementById("muxdeck-session-tabs")).not.toBeVisible();
    expect(screen.getAllByRole("tab", { hidden: true })).toHaveLength(2);
    expect(screen.getByText("Active session: Alpha control", { selector: "[role='status']" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Open tabs" })).toBeVisible();
  });

  it("renders an active synthetic New session tab outside real tmux session lists", () => {
    const props = navigationProps({
      activeSession: null,
      newSessionActive: true,
      onCloseNewSession: vi.fn(),
      recentsOpen: true,
    });
    render(<SessionWorkspaceNavigation {...props} />);

    const newSessionTab = screen.getByRole("tab", {
      name: "New session, not created yet",
    });
    expect(newSessionTab).toHaveAttribute("aria-selected", "true");
    expect(newSessionTab).toHaveAttribute("aria-controls", NEW_SESSION_PANEL_ID);
    expect(newSessionTab).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Active view: New session", { selector: "[role='status']" }))
      .toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("aria-selected", "false");
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    expect(within(openGroup).getByText("Alpha control")).toBeVisible();
    expect(within(openGroup).queryByText("New session")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close New session tab" }));
    expect(props.onCloseNewSession).toHaveBeenCalledOnce();
  });

  it("groups open, recent, unavailable, and other live sessions with their actions", () => {
    const props = navigationProps({ recentsOpen: true });
    render(<SessionWorkspaceNavigation {...props} />);

    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    const recentGroup = screen.getByRole("region", { name: "Recently visited" });
    const availableGroup = screen.getByRole("region", { name: "Other live sessions" });

    expect(within(openGroup).getByText("Alpha control")).toBeVisible();
    expect(within(openGroup).getByText("Active \u00b7 Needs input")).toBeVisible();
    expect(within(openGroup).getByText("beta")).toBeVisible();
    fireEvent.click(within(openGroup).getByRole("button", { name: "Close beta quick tab" }));
    expect(props.onCloseTab).toHaveBeenCalledWith("beta");

    expect(within(recentGroup).getByText("Archived deploy")).toBeVisible();
    expect(within(recentGroup).getByText("Background work")).toBeVisible();
    const unavailable = within(recentGroup).getByRole("button", {
      name: /ended tmux session ended Unavailable/i,
    });
    expect(unavailable).toBeEnabled();
    fireEvent.click(unavailable);
    expect(props.onSelect).toHaveBeenCalledWith("ended");
    fireEvent.click(within(recentGroup).getByRole("button", { name: /Archived deploy/ }));
    expect(props.onSelect).toHaveBeenCalledWith("archive");

    fireEvent.click(within(recentGroup).getByRole("button", { name: "Clear closed" }));
    expect(props.onClearRecents).toHaveBeenCalledOnce();

    expect(within(availableGroup).getByText("Zulu shell")).toBeVisible();
    fireEvent.click(within(availableGroup).getByRole("button", { name: /Zulu shell/ }));
    expect(props.onSelect).toHaveBeenCalledWith("zulu");

    fireEvent.click(screen.getByRole("button", { name: "Browse all" }));
    expect(props.onOpenDashboard).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close session switcher" }));
    expect(props.onCloseRecents).toHaveBeenCalledOnce();
  });

  it("offers termination for every live Overview row without stacking dialogs", async () => {
    const onSessionTerminated = vi.fn(async () => {});
    const props = navigationProps({ recentsOpen: true, onSessionTerminated });
    render(<SessionWorkspaceNavigation {...props} />);

    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    const openGroup = within(overview).getByRole("region", { name: "Open tabs" });
    const recentGroup = within(overview).getByRole("region", { name: "Recently visited" });
    const availableGroup = within(overview).getByRole("region", { name: "Other live sessions" });
    expect(within(openGroup).getByRole("button", {
      name: "Terminate Alpha control tmux session",
    })).toBeVisible();
    expect(within(openGroup).getByRole("button", {
      name: "Terminate beta tmux session",
    })).toBeVisible();
    expect(within(recentGroup).getByRole("button", {
      name: "Terminate Archived deploy tmux session",
    })).toBeVisible();
    expect(within(recentGroup).queryByRole("button", {
      name: "Terminate ended tmux session",
    })).not.toBeInTheDocument();
    expect(within(availableGroup).getByRole("button", {
      name: "Terminate Zulu shell tmux session",
    })).toBeVisible();

    const overviewSearch = within(overview).getByRole("searchbox", {
      name: "Find a workspace session",
    });
    fireEvent.change(overviewSearch, { target: { value: "Archived deploy" } });
    const overviewScroll = overview.querySelector<HTMLElement>(".workspace-recents-scroll");
    expect(overviewScroll).not.toBeNull();
    overviewScroll!.scrollTop = 87;
    fireEvent.scroll(overviewScroll!);

    fireEvent.click(within(recentGroup).getByRole("button", {
      name: "Terminate Archived deploy tmux session",
    }));

    expect(screen.queryByRole("dialog", { name: "Switch sessions" }))
      .not.toBeInTheDocument();
    const confirmation = screen.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    });
    expect(confirmation).toHaveTextContent("Archived deploy");
    expect(props.onCloseRecents).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("alertdialog", { name: "Terminate tmux session?" }))
      .not.toBeInTheDocument();
    const overviewAfterEscape = screen.getByRole("dialog", { name: "Switch sessions" });
    expect(overviewAfterEscape).toBeVisible();
    expect(within(overviewAfterEscape).getByRole("searchbox", {
      name: "Find a workspace session",
    })).toHaveValue("Archived deploy");
    expect(overviewAfterEscape.querySelector<HTMLElement>(".workspace-recents-scroll")?.scrollTop)
      .toBe(87);
    expect(props.onCloseRecents).not.toHaveBeenCalled();

    fireEvent.click(within(overviewAfterEscape).getByRole("button", {
      name: "Terminate Archived deploy tmux session",
    }));
    fireEvent.click(within(screen.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    })).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog", { name: "Terminate tmux session?" }))
      .not.toBeInTheDocument();
    const restoredOverview = screen.getByRole("dialog", { name: "Switch sessions" });
    expect(restoredOverview).toBeVisible();
    expect(within(restoredOverview).getByRole("searchbox", {
      name: "Find a workspace session",
    })).toHaveValue("Archived deploy");
    expect(restoredOverview.querySelector<HTMLElement>(".workspace-recents-scroll")?.scrollTop)
      .toBe(87);
    expect(within(restoredOverview).getByRole("searchbox", {
      name: "Find a workspace session",
    })).toHaveFocus();
    expect(onSessionTerminated).not.toHaveBeenCalled();
    expect(props.onCloseRecents).not.toHaveBeenCalled();

    fireEvent.click(within(restoredOverview).getByRole("button", {
      name: "Clear workspace search",
    }));

    fireEvent.click(within(restoredOverview).getByRole("button", {
      name: "Terminate Zulu shell tmux session",
    }));
    fireEvent.click(within(screen.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    })).getByRole("button", { name: "Terminate session" }));

    await waitFor(() => expect(onSessionTerminated).toHaveBeenCalledWith(
      "zulu",
      "$zulu",
      1,
      10,
      100,
    ));
  });

  it("shows queued memo attention on the mobile Overview session row", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          sessions: sessions.map((item) => item.name === "alpha"
            ? { ...item, memorandumCount: 4, queuedMessageCount: 2 }
            : item),
        })}
      />,
    );

    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    expect(within(openGroup).getByLabelText("2 queued memo items")).toHaveTextContent("Q 2");
  });

  it("keeps ignored live sessions discoverable but sorts them after active work", () => {
    const availableSessions = [
      session({
        name: "alpha",
        customTitle: "Alpha control",
        agentState: "waiting_human",
      }),
      session({
        name: "active-worker",
        customTitle: "Active worker",
        activity: 5,
        agentState: "working",
      }),
      session({
        name: "active-shell",
        customTitle: "Active shell",
        activity: 50,
        agentState: "other",
      }),
      session({
        name: "ignored-urgent",
        customTitle: "Ignored urgent",
        activity: 100,
        agentState: "waiting_human",
        ignored: true,
      }),
      session({
        name: "ignored-command",
        customTitle: "Ignored command",
        activity: 10,
        agentState: "waiting_command",
        ignored: true,
      }),
    ];
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha"],
          recentSessions: ["alpha"],
          sessions: availableSessions,
          recentsOpen: true,
        })}
      />,
    );

    const availableGroup = screen.getByRole("region", { name: "Other live sessions" });
    const titles = [...availableGroup.querySelectorAll(".workspace-session-copy strong")]
      .map((title) => title.textContent);
    expect(titles).toEqual([
      "Active worker",
      "Active shell",
      "Ignored urgent",
      "Ignored command",
    ]);
    expect(within(availableGroup).getByText("Ignored urgent")).toBeVisible();
    expect(within(availableGroup).getByText("Ignored command")).toBeVisible();
  });

  it("keeps focus inside Recents when an inactive tab row is removed", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const props = navigationProps({ recentsOpen: true });

    function ClosableNavigation() {
      const [openSessions, setOpenSessions] = useState(props.openSessions);
      return (
        <SessionWorkspaceNavigation
          {...props}
          openSessions={openSessions}
          onCloseTab={(sessionName) => {
            setOpenSessions((current) => current.filter((name) => name !== sessionName));
          }}
        />
      );
    }

    render(<ClosableNavigation />);
    while (frames.length > 0) frames.shift()?.(0);
    const search = screen.getByRole("searchbox", { name: "Find a workspace session" });
    expect(search).toHaveFocus();

    const dialog = screen.getByRole("dialog", { name: "Switch sessions" });
    const closeBeta = within(dialog).getByRole("button", { name: "Close beta quick tab" });
    closeBeta.focus();
    fireEvent.click(closeBeta);
    expect(document.body).toHaveFocus();
    while (frames.length > 0) frames.shift()?.(0);

    expect(search).toHaveFocus();
    expect(dialog).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("searches session metadata, clears the query, and closes with Escape", () => {
    const props = navigationProps({ recentsOpen: true });
    render(<SessionWorkspaceNavigation {...props} />);

    const search = screen.getByRole("searchbox", { name: "Find a workspace session" });
    expect(search).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.change(search, { target: { value: "kubectl" } });
    expect(screen.getByRole("region", { name: "Recently visited" })).toHaveTextContent(
      "Archived deploy",
    );
    expect(screen.queryByRole("region", { name: "Open tabs" })).not.toBeInTheDocument();
    expect(screen.queryByText("ended")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nothing matches" } });
    expect(screen.getByRole("heading", { name: "No matching sessions" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear workspace search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("region", { name: "Open tabs" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Recently visited" })).toBeVisible();

    fireEvent.change(search, { target: { value: "archive" } });
    const clearSearch = screen.getByRole("button", { name: "Clear workspace search" });
    clearSearch.focus();
    fireEvent.click(clearSearch);
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close session switcher" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCloseRecents).toHaveBeenCalledOnce();
  });

  it("labels an unsaved browser workspace as temporary in the tab bar and Overview", () => {
    const onSaveWorkspace = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          workspaceName: "Stale saved name",
          onSaveWorkspace,
        })}
      />,
    );

    const save = screen.getByRole("button", { name: "Save workspace" });
    expect(within(save).getByText("Temporary workspace")).toBeVisible();
    expect(save).toHaveAttribute("title", "Temporary workspace - Save workspace");
    expect(save).toHaveAttribute("aria-description", "Workspace: Temporary workspace");
    expect(screen.getByRole("group", {
      name: "Workspace: Temporary workspace. Not saved",
    })).toHaveAttribute("title", "Temporary workspace");
    expect(screen.queryByText("Stale saved name")).not.toBeInTheDocument();
  });

  it("names, validates, and retries saving an unsaved workspace", async () => {
    const onSaveWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error("workspace storage is temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const view = render(
      <SessionWorkspaceNavigation
        {...navigationProps({ onSaveWorkspace })}
      />,
    );

    const openSave = screen.getByRole("button", { name: "Save workspace" });
    expect(openSave).toHaveAttribute("aria-haspopup", "dialog");
    expect(openSave).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openSave);

    const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
    expect(view.container).not.toContainElement(dialog);
    expect(dialog.closest(".workspace-save-backdrop")?.parentElement).toBe(document.body);
    const name = within(dialog).getByRole("textbox", { name: "Workspace name" });
    const submit = within(dialog).getByRole("button", { name: "Save workspace" });
    expect(openSave).toHaveAttribute("aria-expanded", "true");
    expect(name).toHaveFocus();
    expect(dialog).toHaveTextContent(
      "Save 2 open tabs in their current order. Future tab and active-session changes will sync automatically.",
    );
    expect(dialog).toHaveTextContent("Resume tab: alpha");
    expect(submit).toBeDisabled();

    fireEvent.change(name, { target: { value: "   " } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(dialog).toHaveTextContent("Enter a workspace name.");
    expect(submit).toBeDisabled();

    fireEvent.change(name, { target: { value: "  Release room  " } });
    expect(name).not.toHaveAttribute("aria-invalid");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "workspace storage is temporarily unavailable",
    );
    expect(onSaveWorkspace).toHaveBeenLastCalledWith("Release room");
    expect(name).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Save this workspace" }))
        .not.toBeInTheDocument();
    });
    expect(onSaveWorkspace).toHaveBeenCalledTimes(2);
    expect(onSaveWorkspace).toHaveBeenLastCalledWith("Release room");
  });

  it.each([
    ["saved", "Workspace saved automatically", "Saved"],
    ["loading", "Opening saved workspace", "Opening"],
    ["error", "Workspace sync issue", "Sync issue"],
  ] as const)(
    "shows the %s persistence status without another save action",
    (workspacePersistenceState, accessibleLabel, visibleLabel) => {
      const onSaveWorkspace = vi.fn().mockResolvedValue(undefined);
      render(
        <SessionWorkspaceNavigation
          {...navigationProps({
            recentsOpen: true,
            workspacePersistenceState,
            workspaceName: "Release command center",
            onSaveWorkspace,
          })}
        />,
      );

      const statuses = screen.getAllByRole("status", { name: accessibleLabel });
      expect(statuses).toHaveLength(2);
      for (const status of statuses) {
        expect(status).toHaveTextContent(visibleLabel);
        expect(status).toHaveAttribute("tabindex", "-1");
      }
      const tabBarStatus = statuses.find((status) => (
        status.classList.contains("workspace-saved-indicator")
      ));
      expect(tabBarStatus).toBeDefined();
      expect(tabBarStatus).toHaveTextContent("Release command center");
      expect(tabBarStatus).toHaveAttribute(
        "aria-description",
        "Workspace: Release command center",
      );
      expect(tabBarStatus).toHaveAttribute(
        "title",
        `Release command center - ${visibleLabel}`,
      );
      expect(screen.getByRole("group", {
        name: `Workspace: Release command center. ${visibleLabel}`,
      })).toHaveAttribute("title", "Release command center");
      expect(screen.queryByRole("button", { name: "Save workspace" }))
        .not.toBeInTheDocument();
      expect(within(screen.getByRole("dialog", { name: "Switch sessions" }))
        .queryByRole("button", { name: "Save" }))
        .not.toBeInTheDocument();
      expect(onSaveWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["saved", "Workspace saved automatically", "Saved workspace", "Saved"],
    ["loading", "Opening saved workspace", "Opening workspace", "Opening"],
    ["error", "Workspace sync issue", "Saved workspace", "Sync issue"],
  ] as const)(
    "uses a saved-workspace fallback for %s state instead of calling it temporary",
    (workspacePersistenceState, accessibleLabel, identityName, stateLabel) => {
      render(
        <SessionWorkspaceNavigation
          {...navigationProps({
            recentsOpen: true,
            workspacePersistenceState,
          })}
        />,
      );

      const tabBarStatus = screen.getAllByRole("status", { name: accessibleLabel })
        .find((status) => status.classList.contains("workspace-saved-indicator"));
      expect(tabBarStatus).toBeDefined();
      expect(within(tabBarStatus!).getByText(identityName)).toBeVisible();
      expect(screen.getByRole("group", {
        name: `Workspace: ${identityName}. ${stateLabel}`,
      })).toBeVisible();
      expect(screen.queryByText("Temporary workspace")).not.toBeInTheDocument();
    },
  );

  it("keeps a long saved workspace name available while styling it for ellipsis", () => {
    const workspaceName = "Release coordination room with a deliberately very long name";
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          workspacePersistenceState: "saved",
          workspaceName,
        })}
      />,
    );

    const status = screen.getByRole("status", { name: "Workspace saved automatically" });
    const name = within(status).getByText(workspaceName);
    expect(name).toHaveClass("workspace-identity-name");
    expect(name).toHaveAttribute("title", workspaceName);
    expect(status).toHaveAttribute("aria-description", `Workspace: ${workspaceName}`);
    expect(status).toHaveAttribute("title", `${workspaceName} - Saved`);
  });

  it("focuses the replacement status after a successful save", async () => {
    function SaveHarness() {
      const [workspacePersistenceState, setWorkspacePersistenceState] = useState<
        "unsaved" | "saved"
      >("unsaved");
      return (
        <SessionWorkspaceNavigation
          {...navigationProps({
            workspacePersistenceState,
            onSaveWorkspace: async () => {
              setWorkspacePersistenceState("saved");
            },
          })}
        />
      );
    }

    render(<SaveHarness />);
    const openSave = screen.getByRole("button", { name: "Save workspace" });
    openSave.focus();
    fireEvent.click(openSave);
    const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Release room" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));

    const savedStatus = await screen.findByRole("status", {
      name: "Workspace saved automatically",
    });
    await waitFor(() => expect(savedStatus).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Save this workspace" }))
      .not.toBeInTheDocument();
  });

  it("focuses the visible Overview control after a successful compact save", async () => {
    vi.stubGlobal("visualViewport", { width: 390, height: 664 });

    function CompactSaveHarness() {
      const [workspacePersistenceState, setWorkspacePersistenceState] = useState<
        "unsaved" | "saved"
      >("unsaved");
      return (
        <>
          <button id={MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID} type="button">
            Mobile Overview
          </button>
          <SessionWorkspaceNavigation
            {...navigationProps({
              workspacePersistenceState,
              onSaveWorkspace: async () => {
                setWorkspacePersistenceState("saved");
              },
            })}
          />
        </>
      );
    }

    render(<CompactSaveHarness />);
    const openSave = screen.getByRole("button", { name: "Save workspace" });
    openSave.focus();
    fireEvent.click(openSave);
    const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Mobile release room" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));

    const overview = screen.getByRole("button", { name: "Mobile Overview" });
    await waitFor(() => expect(overview).toHaveFocus());
    expect(screen.getByRole("status", {
      name: "Workspace saved automatically",
    })).not.toHaveFocus();
  });

  it("closes the Overview Recents sheet before opening its save dialog", () => {
    const onCloseRecents = vi.fn();
    const onSaveWorkspace = vi.fn().mockResolvedValue(undefined);

    function OverviewHarness() {
      const [recentsOpen, setRecentsOpen] = useState(true);
      return (
        <SessionWorkspaceNavigation
          {...navigationProps({
            recentsOpen,
            onCloseRecents: () => {
              onCloseRecents();
              setRecentsOpen(false);
            },
            onSaveWorkspace,
          })}
        />
      );
    }

    render(<OverviewHarness />);
    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(overview).getByRole("button", { name: "Save" }));

    expect(onCloseRecents).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Switch sessions" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Save this workspace" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
    expect(onSaveWorkspace).not.toHaveBeenCalled();
  });
});
