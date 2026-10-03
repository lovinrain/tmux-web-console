import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import { THEME_TOGGLE_REQUEST_EVENT } from "../theme";
import { moveWorkspaceSession, moveWorkspaceSessions, reparentWorkspaceSession, type SessionWorkspaceState } from "../workspaceState";
import { WORKSPACE_SESSION_DRAG_TYPE } from "../workspaceSessionDrag";
import {
  PANE_NAVIGATION_ACTION,
  SHORTCUT_ACTION_EVENT,
  type ShortcutActionId,
} from "../shortcutSettings";
import type { Pane, Session } from "../types";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import {
  COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH,
  ActivePaneSessionContext,
  DEFAULT_DESKTOP_TAB_RAIL_WIDTH,
  MAX_DESKTOP_TAB_RAIL_WIDTH,
  MIN_DESKTOP_TAB_RAIL_WIDTH,
  MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID,
  SessionWorkspaceNavigation,
  WorkspaceTabSearchDialog,
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

function dragDataTransfer(): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    setData: vi.fn(),
  } as unknown as DataTransfer;
}

function mockElementBounds(
  element: HTMLElement,
  bounds: Partial<DOMRect>,
): void {
  const left = bounds.left ?? 0;
  const top = bounds.top ?? 0;
  const width = bounds.width ?? 100;
  const height = bounds.height ?? 40;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: bounds.right ?? left + width,
    bottom: bounds.bottom ?? top + height,
    toJSON: () => ({}),
  });
}

class TestDragEvent extends MouseEvent {
  readonly dataTransfer: DataTransfer | null;

  constructor(type: string, init: DragEventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("DragEvent", TestDragEvent);
  document.body.style.overflow = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("SessionWorkspaceNavigation", () => {
  it("marks the current session unread without visiting it, even when tab actions are hidden", () => {
    const props = navigationProps({
      onMarkSessionUnread: vi.fn(), tabActionsVisible: false,
      workspacePersistenceState: "saved", activeWorkspaceId: "workspace-one",
      workspaceName: "Review", onRenameWorkspace: vi.fn(),
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    const button = screen.getByRole("button", { name: "Mark as unread" });
    const actions = screen.getByRole("group", { name: "Rename and unread actions" });
    expect(within(actions).getByRole("button", { name: "Mark as unread" })).toBe(button);
    expect(within(actions).getByRole("button", { name: "Rename workspace Review" })).toBeVisible();
    expect(button).toHaveAccessibleDescription(/Alpha control/);
    fireEvent.click(button);
    expect(props.onMarkSessionUnread).toHaveBeenCalledWith("alpha");
    expect(props.onSelect).not.toHaveBeenCalled();
    view.rerender(<SessionWorkspaceNavigation {...props} uncheckedReadySessions={new Set(["alpha"])} />);
    expect(screen.getByRole("button", { name: "Already unread" })).toBeDisabled();
  });

  it("targets the focused pane session and disables manual unread when no live session is selected", () => {
    const props = navigationProps({ activeSession: null, onMarkSessionUnread: vi.fn() });
    const view = render(
      <ActivePaneSessionContext.Provider value="beta">
        <SessionWorkspaceNavigation {...props} />
      </ActivePaneSessionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark as unread" }));
    expect(props.onMarkSessionUnread).toHaveBeenCalledWith("beta");
    expect(props.onSelect).not.toHaveBeenCalled();
    view.rerender(<SessionWorkspaceNavigation {...props} />);
    expect(screen.getByRole("button", { name: "Mark as unread" })).toBeDisabled();
    view.rerender(<SessionWorkspaceNavigation {...props} activeSession="ended" openSessions={["ended"]} />);
    expect(screen.getByRole("button", { name: "Mark as unread" })).toBeDisabled();
  });

  it("exposes unchecked status on tabs and collapsed groups without acknowledging move selection or expansion", () => {
    const props = navigationProps({
      orientation: "vertical", uncheckedReadySessions: new Set(["alpha", "beta"]),
      groups: [{ id: "review", name: "Review", color: "blue", collapsed: true, tabs: ["alpha", "beta"] }],
      onToggleTabGroup: vi.fn(), onMoveTab: vi.fn(), onMoveTabs: vi.fn(),
    });
    const { rerender } = render(<SessionWorkspaceNavigation {...props} />);
    const group = screen.getByRole("button", { name: "Expand Review tab group" });
    expect(within(group).getByLabelText("2 unread sessions")).toBeVisible();
    fireEvent.click(group);
    expect(props.onToggleTabGroup).toHaveBeenCalledWith("review", false);
    expect(props.onSelect).not.toHaveBeenCalled();

    rerender(<SessionWorkspaceNavigation {...props} groups={[{ ...props.groups![0], collapsed: false }]} />);
    const tab = screen.getByRole("tab", { name: /Alpha control.*unread/ });
    expect(tab.closest(".workspace-tab")).toHaveAttribute("data-ready-unchecked", "true");
    expect(tab.querySelector(".workspace-tab-ready-mark")).not.toBeInTheDocument();
    fireEvent.click(tab, { ctrlKey: true });
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.click(tab);
    expect(props.onSelect).toHaveBeenCalledWith("alpha");
  });

  it("quickly finds and adds a running session without leaving the workspace", () => {
    const onAddSession = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({ onAddSession })}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Add running sessions to workspace, 2 available",
    });
    expect(trigger).toHaveTextContent("Add sessions");
    expect(trigger).toHaveTextContent("2");
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Add running sessions" });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "arch logs" },
    });
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Add archive to workspace",
    }));
    expect(onAddSession).toHaveBeenCalledWith("archive", false);
  });

  it("disables quick add while syncing or when every running session is open", () => {
    const { rerender } = render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          onAddSession: vi.fn(),
          workspacePersistenceState: "loading",
        })}
      />,
    );

    expect(screen.getByRole("button", {
      name: "Add running sessions to workspace, 2 available",
    })).toBeDisabled();

    rerender(
      <SessionWorkspaceNavigation
        {...navigationProps({
          onAddSession: vi.fn(),
          openSessions: sessions.map((item) => item.name),
        })}
      />,
    );
    expect(screen.getByRole("button", {
      name: "Add running sessions to workspace, 0 available",
    })).toBeDisabled();
  });

  it("shows saved pane views beside sessions and can create or open one", () => {
    const onCreatePaneLayout = vi.fn();
    const onSelectPaneLayout = vi.fn();
    const shortcutActions: ShortcutActionId[] = [];
    const captureShortcut = (event: Event) => {
      shortcutActions.push((event as CustomEvent<ShortcutActionId>).detail);
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          paneLayouts: [{
            id: "review-wall",
            name: "Review wall",
            root: {
              id: "split",
              kind: "split",
              direction: "horizontal",
              ratio: 0.5,
              first: { id: "left", kind: "pane", session: "alpha" },
              second: { id: "right", kind: "pane", session: "beta" },
            },
          }],
          activePaneLayoutId: "review-wall",
          onCreatePaneLayout,
          onSelectPaneLayout,
        })}
      />,
    );

    const paneTab = screen.getByRole("tab", { name: /Review wall/ });
    expect(paneTab).toHaveAttribute("aria-selected", "true");
    expect(paneTab).toHaveAttribute("aria-controls", "muxdeck-workspace-pane-board");
    fireEvent.click(paneTab);
    expect(onSelectPaneLayout).toHaveBeenCalledWith("review-wall");
    fireEvent.click(screen.getByRole("button", { name: "Create multi-pane view" }));
    expect(onCreatePaneLayout).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Open shortcut window" }));
    const shortcutDialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(shortcutDialog).getByRole("button", { name: /Navigate between panes/ }))
      .toHaveTextContent("G");
    fireEvent.keyDown(window, { code: "KeyG", key: "g" });
    expect(shortcutActions).toContain(PANE_NAVIGATION_ACTION);
    window.removeEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
  });

  it("offers Insert snippet only for a live active pane when no session tab is selected", () => {
    const props = navigationProps({ activeSession: null, activePaneLayoutId: "pair" });
    const view = render(
      <ActivePaneSessionContext.Provider value="alpha">
        <SessionWorkspaceNavigation {...props} />
      </ActivePaneSessionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open shortcut window" }));
    expect(screen.getByRole("button", { name: /Insert snippet/ })).toBeEnabled();

    for (const unavailableSession of [null, "missing-session"]) {
      view.rerender(
        <ActivePaneSessionContext.Provider value={unavailableSession}>
          <SessionWorkspaceNavigation {...props} />
        </ActivePaneSessionContext.Provider>,
      );
      expect(screen.getByRole("button", { name: /Insert snippet/ })).toBeDisabled();
    }
  });

  it("finds tabs by group name and exposes their group name and color", () => {
    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "beta", "zulu"]}
        groups={[{
          id: "release-lane",
          name: "Release lane",
          color: "orange",
          collapsed: false,
          tabs: ["beta", "zulu"],
        }]}
        sessions={sessions}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "release" },
    });

    const results = within(dialog).getAllByRole("option");
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveTextContent("beta");
    expect(results[1]).toHaveTextContent("Zulu shell");
    for (const result of results) {
      const metadata = within(result).getByLabelText(
        "Tab group Release lane, color orange",
      );
      expect(metadata).toHaveTextContent("Release lane");
      expect(metadata).toHaveAttribute("data-tab-group-color", "orange");
    }
  });

  it("shows nesting and parent context in tab search even when the parent is filtered out", () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "beta", "zulu"]}
        sessionParents={{ beta: "alpha", zulu: "beta" }}
        sessions={sessions}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    const [root, child, grandchild] = within(dialog).getAllByRole("option");
    expect(root).not.toHaveAttribute("data-session-parent");
    expect(child).toHaveAttribute("data-session-parent", "alpha");
    expect(child).toHaveAttribute("data-session-depth", "1");
    expect(child).toHaveTextContent("Child of Alpha control");
    expect(grandchild).toHaveAttribute("data-session-depth", "2");
    expect(grandchild).toHaveAccessibleDescription("Child of beta. Nesting level 2.");

    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "Zulu" },
    });
    const result = within(dialog).getByRole("option");
    expect(result).toHaveTextContent("Child of beta");
    expect(result.style.getPropertyValue("--workspace-session-depth")).toBe("2");
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith("zulu");
  });

  it.each(["horizontal", "vertical"] as const)(
    "marks nested %s tabs without changing their names, actions, or keyboard order",
    (orientation) => {
      const props = navigationProps({
        openSessions: ["alpha", "beta", "zulu", "archive"],
        sessionParents: { beta: "alpha", zulu: "beta" },
        orientation,
      });
      render(<SessionWorkspaceNavigation {...props} />);

      const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
      const beta = screen.getByRole("tab", { name: "beta, Working" });
      const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
      const archive = screen.getByRole("tab", { name: "Archived deploy, Background work" });
      expect(alpha.closest(".workspace-tab")).not.toHaveAttribute("data-session-parent");
      expect(archive.closest(".workspace-tab")).not.toHaveAttribute("data-session-depth");
      expect(alpha.querySelector(".workspace-tab-child-marker")).toBeNull();
      expect(beta.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "alpha");
      expect(beta.closest(".workspace-tab")).toHaveAttribute("data-session-depth", "1");
      expect(zulu.closest(".workspace-tab")).toHaveAttribute("data-session-depth", "2");
      expect(zulu.closest<HTMLElement>(".workspace-tab")?.style
        .getPropertyValue("--workspace-session-depth")).toBe("2");
      expect(beta).toHaveAccessibleDescription("Claude. Child of Alpha control (alpha). Nesting level 1.");
      expect(zulu.title).toContain("Child of beta. Nesting level 2.");
      expect(beta.querySelector(".workspace-tab-child-marker"))
        .toHaveAttribute("aria-hidden", "true");

      alpha.focus();
      fireEvent.keyDown(alpha, { key: orientation === "vertical" ? "ArrowDown" : "ArrowRight" });
      expect(beta).toHaveFocus();
      fireEvent.keyDown(beta, { key: orientation === "vertical" ? "ArrowDown" : "ArrowRight" });
      expect(zulu).toHaveFocus();
      fireEvent.click(zulu);
      expect(props.onSelect).toHaveBeenCalledWith("zulu");
      fireEvent.click(screen.getByRole("button", { name: "Close beta quick tab" }));
      expect(props.onCloseTab).toHaveBeenCalledWith("beta");
    },
  );

  it("retains nested parent context in the narrow rail and the Overview open list", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          sessionParents: { beta: "alpha", zulu: "beta" },
          orientation: "vertical",
          desktopTabRailWidth: MIN_DESKTOP_TAB_RAIL_WIDTH,
          recentsOpen: true,
        })}
      />,
    );

    const childTab = screen.getByRole("tab", { name: "beta, Working" });
    expect(childTab.querySelector(".workspace-tab-compact-index"))
      .toHaveAttribute("data-index", "2");
    expect(childTab.querySelector(".session-agent-icon")).toBeInTheDocument();
    expect(childTab.querySelector(".workspace-tab-child-marker")).toBeInTheDocument();

    const openList = screen.getByRole("region", { name: "Open tabs" });
    const childRow = openList.querySelector<HTMLElement>("[data-workspace-session-name='beta']")!;
    const grandchildRow = openList.querySelector<HTMLElement>("[data-workspace-session-name='zulu']")!;
    expect(childRow).toHaveTextContent("Child of Alpha control");
    expect(grandchildRow).toHaveAttribute("data-session-depth", "2");
    expect(within(grandchildRow).getByRole("button", { name: /^Zulu shell/ }))
      .toHaveAccessibleDescription("Child of beta. Nesting level 2.");
  });

  it("includes descendants when selecting a parent tab for moving", () => {
    const onTabSelectionChange = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu", "archive"],
          sessionParents: { beta: "alpha", zulu: "beta" },
          onMoveTab: vi.fn(),
          onMoveTabs: vi.fn(),
          onTabSelectionChange,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Alpha control, Needs input" }), {
      ctrlKey: true,
    });
    expect(onTabSelectionChange).toHaveBeenLastCalledWith(["alpha", "beta", "zulu"]);
    expect(screen.getAllByRole("tab", { name: /selected for moving/ })).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Archived deploy, Background work" }))
      .toHaveAttribute("aria-selected", "false");
  });

  it.each(["rail", "overview"] as const)(
    "moves a parent and its descendants between sibling boundaries from the %s",
    (surface) => {
      const onMoveTab = vi.fn();
      const parents = { beta: "alpha", archive: "beta", zulu: "alpha" };
      function NestedReorderHarness() {
        const [openSessions, setOpenSessions] = useState(["alpha", "beta", "archive", "zulu", "other"]);
        return (
          <SessionWorkspaceNavigation
            {...navigationProps({
              openSessions,
              sessionParents: parents,
              sessions: [...sessions, session({ name: "other" })],
              orientation: "vertical",
              recentsOpen: surface === "overview",
              onMoveTab: (name, index) => {
                onMoveTab(name, index);
                setOpenSessions((current) => moveWorkspaceSession({
                  openSessions: current,
                  recentSessions: [],
                  groups: [],
                  parents,
                }, name, index).openSessions);
              },
            })}
          />
        );
      }
      render(<NestedReorderHarness />);
      const surfaceElement = surface === "rail"
        ? screen.getByRole("navigation", { name: "Session workspace" })
        : screen.getByRole("region", { name: "Open tabs" });
      const controls = within(surfaceElement);

      expect(controls.getByRole("button", { name: "Move Alpha control tab up" })).toBeDisabled();
      fireEvent.click(controls.getByRole("button", { name: "Move Alpha control tab down" }));
      expect(onMoveTab).toHaveBeenLastCalledWith("alpha", 4);
      expect([...surfaceElement.querySelectorAll("[data-workspace-session-name]")]
        .map((element) => element.getAttribute("data-workspace-session-name")))
        .toEqual(["other", "alpha", "beta", "archive", "zulu"]);
      expect(controls.getByRole("button", { name: "Move Alpha control tab down" })).toBeDisabled();

      expect(controls.getByRole("button", { name: "Move beta tab up" })).toBeDisabled();
      fireEvent.click(controls.getByRole("button", { name: "Move beta tab down" }));
      expect(onMoveTab).toHaveBeenLastCalledWith("beta", 4);
      expect([...surfaceElement.querySelectorAll("[data-workspace-session-name]")]
        .map((element) => element.getAttribute("data-workspace-session-name")))
        .toEqual(["other", "alpha", "zulu", "beta", "archive"]);
      expect(controls.getByRole("button", { name: "Move beta tab down" })).toBeDisabled();
      expect(controls.getByRole("button", { name: "Move Archived deploy tab up" })).toBeDisabled();
      expect(controls.getByRole("button", { name: "Move Archived deploy tab down" })).toBeDisabled();
      expect(screen.getAllByText("beta moved to position 4 of 5.", { selector: "[role='status']" }))
        .toHaveLength(1);
    },
  );

  it("renders a colored group block with collapse, edit, and atomic move controls", () => {
    const onToggleTabGroup = vi.fn();
    const onMoveTabGroup = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "review",
            name: "Review lane",
            color: "cyan",
            collapsed: false,
            tabs: ["beta", "zulu"],
          }],
          onMoveTab: vi.fn(),
          onSaveTabGroup: vi.fn(),
          onDeleteTabGroup: vi.fn(),
          onToggleTabGroup,
          onMoveTabGroup,
        })}
      />,
    );

    const collapse = screen.getByRole("button", {
      name: "Collapse Review lane tab group",
    });
    const group = collapse.closest<HTMLElement>("[data-workspace-tab-group-id]");
    expect(group).toHaveAttribute("data-workspace-tab-group-id", "review");
    expect(group).toHaveAttribute("data-tab-group-color", "cyan");
    expect(within(group!).getAllByRole("tab")).toHaveLength(2);

    expect(within(group!).getByRole("button", { name: "Move beta tab left" }))
      .toBeDisabled();
    expect(within(group!).getByRole("button", { name: "Move Zulu shell tab right" }))
      .toBeDisabled();
    fireEvent.click(collapse);
    expect(onToggleTabGroup).toHaveBeenCalledWith("review", true);

    fireEvent.click(screen.getByRole("button", { name: "Move Review lane group left" }));
    expect(onMoveTabGroup).toHaveBeenCalledWith("review", -1);
    expect(screen.getByRole("button", { name: "Move Review lane group right" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Edit Review lane tab group" }));
    expect(screen.getByRole("dialog", { name: "Edit Review lane" })).toBeInTheDocument();
  });

  it.each(["alpha", "beta"])("folds every member including the active root or child %s", (activeSession) => {
    const props = navigationProps({ activeSession, openSessions: ["alpha", "beta", "zulu", "archive"],
      sessionParents: { beta: "alpha", zulu: "beta" }, onToggleTabGroup: vi.fn() });
    function GroupNavigation() {
      const [collapsed, setCollapsed] = useState(false);
      return <SessionWorkspaceNavigation {...props} groups={[{
        id: "family", name: "Family", color: "orange", collapsed, tabs: ["alpha", "beta", "zulu"],
      }]} onToggleTabGroup={(_, next) => setCollapsed(next)} />;
    }
    render(<GroupNavigation />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Family tab group" }));
    const header = screen.getByRole("button", { name: "Expand Family tab group" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveAccessibleDescription(/Active session:/);
    expect(header.closest("[data-workspace-tab-group-id]"))
      .toHaveAttribute("data-active-group", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Archived deploy, Background work" })).toBeVisible();
    fireEvent.click(header);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getAllByRole("tab").filter((tab) => tab.getAttribute("aria-selected") === "true"))
      .toHaveLength(1);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it("layers group management over Overview and returns without another history change", () => {
    const onOpenRecents = vi.fn();
    const onCloseRecents = vi.fn();
    const onMoveTabGroup = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "review",
            name: "Review lane",
            color: "pink",
            collapsed: false,
            tabs: ["alpha", "beta"],
          }],
          onSaveTabGroup: vi.fn(),
          onDeleteTabGroup: vi.fn(),
          onMoveTabGroup,
          onOpenRecents,
          onCloseRecents,
        })}
      />,
    );

    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(overview).getByRole("button", {
      name: "Move Review lane group down",
    }));
    expect(onMoveTabGroup).toHaveBeenCalledWith("review", 1);
    fireEvent.click(within(overview).getByRole("button", {
      name: "Edit Review lane tab group",
    }));
    expect(onCloseRecents).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Switch sessions" }))
      .not.toBeInTheDocument();

    const editor = screen.getByRole("dialog", { name: "Edit Review lane" });
    fireEvent.click(within(editor).getByRole("button", { name: "Close tab group editor" }));
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    expect(onOpenRecents).not.toHaveBeenCalled();
  });

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

  it("shows command-running status in tabs, Overview, and tab search", () => {
    const runningSession = session({ name: "command-task", agentState: "running_command" });
    const visibleSessions = [sessions[0], runningSession];
    const view = render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "command-task"],
          recentSessions: ["command-task"],
          sessions: visibleSessions,
          recentsOpen: true,
        })}
      />,
    );

    const tab = screen.getByRole("tab", { name: "command-task, Command running" });
    expect(tab.querySelector(".workspace-state-dot")).toHaveClass("running_command");
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    const status = within(openGroup).getByText("Command running");
    expect(status).toHaveClass("workspace-session-status", "running_command");
    view.unmount();

    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "command-task"]}
        sessions={visibleSessions}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "command-task" } });
    const result = within(dialog).getByRole("option");
    expect(result).toHaveTextContent("Command running");
    expect(result.querySelector(".workspace-state-dot")).toHaveClass("running_command");
    expect(result.querySelector(".workspace-tab-search-result-state")).toHaveClass("running_command");
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

  it("fuzzy-searches and runs desktop commands and open tabs", async () => {
    const props = navigationProps();
    const shortcutActions: ShortcutActionId[] = [];
    const captureShortcut = (event: Event) => {
      shortcutActions.push((event as CustomEvent<ShortcutActionId>).detail);
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
    render(<SessionWorkspaceNavigation {...props} />);

    const trigger = screen.getByRole("button", { name: "Open command palette" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+Shift+H");

    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    const palette = screen.getByRole("dialog", { name: "Run a command" });
    const search = within(palette).getByRole("combobox", { name: "Search commands" });
    await waitFor(() => expect(search).toHaveFocus());
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.change(search, { target: { value: "rnm ssn" } });
    expect(within(palette).getByRole("option", { name: /Rename tmux session/ }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.queryByRole("dialog", { name: "Run a command" })).not.toBeInTheDocument();
    expect(shortcutActions).toContain("session-rename");
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(trigger);
    const snippetPalette = screen.getByRole("dialog", { name: "Run a command" });
    const snippetSearch = within(snippetPalette).getByRole("combobox", { name: "Search commands" });
    fireEvent.change(snippetSearch, { target: { value: "insert snippet" } });
    expect(within(snippetPalette).getByRole("option", { name: /Insert snippet/ }))
      .toHaveTextContent("Ctrl+Shift+I");
    fireEvent.keyDown(snippetSearch, { key: "Enter" });
    expect(shortcutActions).toContain("input-insert-snippet");

    fireEvent.click(trigger);
    const reopened = screen.getByRole("dialog", { name: "Run a command" });
    const reopenedSearch = within(reopened).getByRole("combobox", { name: "Search commands" });
    fireEvent.change(reopenedSearch, { target: { value: "bta" } });
    expect(within(reopened).getByRole("option", { name: /Switch to beta/ }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(reopenedSearch, { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith("beta");

    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run a command" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    const blockingModal = document.createElement("div");
    blockingModal.setAttribute("aria-modal", "true");
    document.body.append(blockingModal);
    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByRole("dialog", { name: "Run a command" })).not.toBeInTheDocument();
    blockingModal.remove();
    window.removeEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
  });

  it("opens a shortcut layer and runs End, Rename, or fuzzy search by follow-up key", async () => {
    const shortcutActions: ShortcutActionId[] = [];
    const captureShortcut = (event: Event) => {
      shortcutActions.push((event as CustomEvent<ShortcutActionId>).detail);
    };
    window.addEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
    render(<SessionWorkspaceNavigation {...navigationProps()} />);

    const trigger = screen.getByRole("button", { name: "Open shortcut window" });
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Z");

    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    let shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(shortcuts).toHaveTextContent("Release the opening chord");
    expect(within(shortcuts).getByRole("button", {
      name: /Open End session confirmation/,
    })).toHaveTextContent("E");

    fireEvent.keyDown(window, { code: "KeyE", key: "e" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }))
      .not.toBeInTheDocument();
    expect(shortcutActions).toContain("session-end");

    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, { code: "KeyR", key: "r" });
    expect(shortcutActions).toContain("session-rename");

    fireEvent.click(trigger);
    shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(shortcuts).getByRole("button", { name: /Insert snippet/ }))
      .toHaveTextContent("I");
    fireEvent.keyDown(window, { code: "KeyI", key: "i" });
    expect(shortcutActions).toContain("input-insert-snippet");

    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(shortcuts).getByRole("button", {
      name: /Show or hide floating staged input/,
    })).toHaveTextContent("Y");
    fireEvent.keyDown(window, { code: "KeyY", key: "y" });
    expect(shortcutActions).toContain("view-floating-input");

    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(shortcuts).getByRole("button", { name: /Fuzzy command search/ }))
      .toHaveTextContent("H");
    fireEvent.keyDown(window, { code: "KeyH", key: "h" });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Run a command" })).toBeVisible();
    });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }))
      .not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    const themeRequest = vi.fn();
    window.addEventListener(THEME_TOGGLE_REQUEST_EVENT, themeRequest);
    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, { code: "KeyT", key: "t" });
    expect(themeRequest).toHaveBeenCalledOnce();

    window.removeEventListener(THEME_TOGGLE_REQUEST_EVENT, themeRequest);
    window.removeEventListener(SHORTCUT_ACTION_EVENT, captureShortcut);
  });

  it("exposes distinct Move and Copy window actions with exact accessible text", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("opened");
    const onCloseTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({ onOpenTabInNewWindow, onCloseTab })}
      />,
    );

    const actions = screen.getByRole("group", {
      name: "Alpha control tab window actions",
    });
    const move = within(actions).getByRole("button", {
      name: "Move Alpha control tab to new window",
    });
    const copy = within(actions).getByRole("button", {
      name: "Copy Alpha control tab to new window",
    });

    expect(move).toHaveClass("workspace-tab-window-move");
    expect(move).toHaveAttribute("title", "Move tab to new window");
    expect(move).toHaveAccessibleDescription(
      "Opens this session in a separate browser window and removes this quick tab here. The tmux session keeps running.",
    );
    expect(copy).toHaveClass("workspace-tab-window-copy");
    expect(copy).toHaveAttribute("title", "Copy tab to new window");
    expect(copy).toHaveAccessibleDescription(
      "Opens this session in a separate browser window and keeps this quick tab here.",
    );

    fireEvent.click(copy);
    expect(onOpenTabInNewWindow).toHaveBeenCalledOnce();
    expect(onOpenTabInNewWindow).toHaveBeenLastCalledWith("alpha", "copy");
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByText(
      "Alpha control copied to a new window and remains open here.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();

    fireEvent.click(move);
    expect(onOpenTabInNewWindow).toHaveBeenCalledTimes(2);
    expect(onOpenTabInNewWindow).toHaveBeenLastCalledWith("alpha", "move");
    expect(onCloseTab).toHaveBeenCalledOnce();
    expect(onCloseTab).toHaveBeenCalledWith("alpha");
    expect(screen.getByText(
      "Alpha control moved to a new window. The tmux session keeps running.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();
  });

  it("keeps the source tab when a new window is blocked and closes it only after success", () => {
    const onOpenTabInNewWindow = vi.fn()
      .mockReturnValueOnce("blocked")
      .mockReturnValueOnce("opened");
    const onCloseTab = vi.fn();
    const props = navigationProps({ onOpenTabInNewWindow });

    function WindowMoveHarness() {
      const [openSessions, setOpenSessions] = useState(["alpha", "beta"]);
      return (
        <SessionWorkspaceNavigation
          {...props}
          openSessions={openSessions}
          onCloseTab={(sessionName) => {
            onCloseTab(sessionName);
            setOpenSessions((current) => current.filter((name) => name !== sessionName));
          }}
        />
      );
    }

    render(<WindowMoveHarness />);
    const move = screen.getByRole("button", {
      name: "Move Alpha control tab to new window",
    });

    fireEvent.click(move);
    expect(onOpenTabInNewWindow).toHaveBeenNthCalledWith(1, "alpha", "move");
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser blocked a new window for Alpha control. Allow pop-ups and try again.",
    );
    expect(screen.getByRole("button", { name: "Dismiss new window error" }))
      .toBeVisible();

    fireEvent.click(move);
    expect(onOpenTabInNewWindow).toHaveBeenNthCalledWith(2, "alpha", "move");
    expect(onCloseTab).toHaveBeenCalledOnce();
    expect(onCloseTab).toHaveBeenCalledWith("alpha");
    expect(screen.queryByRole("tab", { name: "Alpha control, Needs input" }))
      .not.toBeInTheDocument();
  });

  it("keeps Move in place while an earlier saved-workspace update finishes", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("workspace-sync-pending");
    const onCloseTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({ onOpenTabInNewWindow, onCloseTab })}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Move Alpha control tab to new window",
    }));

    expect(onOpenTabInNewWindow).toHaveBeenCalledWith("alpha", "move");
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Muxdeck is finishing an earlier workspace save before moving Alpha control. The source tab is unchanged. Try Move again when the save finishes.",
    );
  });

  it("disables only Move while a saved workspace is loading in tabs and Overview", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("opened");
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          onOpenTabInNewWindow,
          workspacePersistenceState: "loading",
        })}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    const moveButtons = [
      within(navigation).getByRole("button", {
        name: "Move Alpha control tab to new window",
      }),
      within(openGroup).getByRole("button", {
        name: "Move Alpha control tab to new window",
      }),
    ];
    const copyButtons = [
      within(navigation).getByRole("button", {
        name: "Copy Alpha control tab to new window",
      }),
      within(openGroup).getByRole("button", {
        name: "Copy Alpha control tab to new window",
      }),
    ];

    for (const move of moveButtons) {
      expect(move).toBeDisabled();
      expect(move).toHaveAttribute(
        "title",
        "Move is unavailable until the saved workspace finishes opening.",
      );
      expect(move).toHaveAccessibleDescription(
        "Move is unavailable until the saved workspace finishes opening.",
      );
      fireEvent.click(move);
    }
    for (const copy of copyButtons) {
      expect(copy).toBeEnabled();
      expect(copy).toHaveAttribute("title", "Copy tab to new window");
      fireEvent.click(copy);
    }
    expect(onOpenTabInNewWindow).toHaveBeenCalledTimes(2);
    expect(onOpenTabInNewWindow).toHaveBeenNthCalledWith(1, "alpha", "copy");
    expect(onOpenTabInNewWindow).toHaveBeenNthCalledWith(2, "alpha", "copy");
  });

  it("keeps Copy available but disables Move while a workspace has a sync issue", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("opened");
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          onOpenTabInNewWindow,
          workspacePersistenceState: "error",
          workspaceName: "Release room",
        })}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    for (const surface of [navigation, openGroup]) {
      const move = within(surface).getByRole("button", {
        name: "Move Alpha control tab to new window",
      });
      const copy = within(surface).getByRole("button", {
        name: "Copy Alpha control tab to new window",
      });
      expect(move).toBeDisabled();
      expect(move).toHaveAccessibleDescription(
        "Move is unavailable until the workspace sync issue is resolved.",
      );
      expect(copy).toBeEnabled();
      fireEvent.click(copy);
    }
    expect(onOpenTabInNewWindow).toHaveBeenCalledTimes(2);
  });

  it("offers window actions only for open Overview rows and stacks them without End", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("opened");
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({ recentsOpen: true, onOpenTabInNewWindow })}
      />,
    );

    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    const recentGroup = screen.getByRole("region", { name: "Recently visited" });
    const availableGroup = screen.getByRole("region", { name: "Other live sessions" });
    expect(within(openGroup).getAllByRole("group", { name: /tab window actions$/ }))
      .toHaveLength(2);
    expect(within(recentGroup).queryByRole("button", { name: /tab to new window$/ }))
      .not.toBeInTheDocument();
    expect(within(availableGroup).queryByRole("button", { name: /tab to new window$/ }))
      .not.toBeInTheDocument();

    const move = within(openGroup).getByRole("button", {
      name: "Move Alpha control tab to new window",
    });
    const copy = within(openGroup).getByRole("button", {
      name: "Copy Alpha control tab to new window",
    });
    const row = move.closest<HTMLElement>(".workspace-session-row");
    expect(row).toHaveClass("stacked-actions");
    expect(move).toHaveClass("workspace-session-window-move");
    expect(copy).toHaveClass("workspace-session-window-copy");
    expect(within(row!).queryByRole("button", {
      name: "Terminate Alpha control tmux session",
    })).not.toBeInTheDocument();
  });

  it("keeps Move and Copy actions on tabs inside a named group", () => {
    const onOpenTabInNewWindow = vi.fn().mockReturnValue("opened");
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "review",
            name: "Review lane",
            color: "cyan",
            collapsed: false,
            tabs: ["beta", "zulu"],
          }],
          onOpenTabInNewWindow,
        })}
      />,
    );

    const group = screen.getByRole("tab", {
      name: "beta, Review lane group, Working",
    }).closest<HTMLElement>("[data-workspace-tab-group-id]");
    const actions = within(group!).getByRole("group", {
      name: "beta tab window actions",
    });
    const move = within(actions).getByRole("button", {
      name: "Move beta tab to new window",
    });
    const copy = within(actions).getByRole("button", {
      name: "Copy beta tab to new window",
    });
    expect(move).toHaveAttribute("title", "Move tab to new window");
    expect(copy).toHaveAttribute("title", "Copy tab to new window");

    fireEvent.click(copy);
    expect(onOpenTabInNewWindow).toHaveBeenCalledWith("beta", "copy");
  });

  it("does not offer window actions for the synthetic New session tab", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          newSessionActive: true,
          onCloseNewSession: vi.fn(),
          onOpenTabInNewWindow: vi.fn().mockReturnValue("opened"),
        })}
      />,
    );

    const syntheticTab = screen.getByRole("tab", {
      name: "New session, not created yet",
    });
    const syntheticContainer = syntheticTab.closest<HTMLElement>(
      ".workspace-new-session-tab",
    );
    expect(within(syntheticContainer!).queryByRole("button", { name: /new window/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "New session tab window actions" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Alpha control tab window actions" }))
      .toBeInTheDocument();
  });

  it("adds and removes independent separators inside groups without adding tabs", () => {
    function SeparatorWorkspace() {
      const [separators, setSeparators] = useState<string[]>([]);
      const [separatorsBefore, setSeparatorsBefore] = useState<string[]>([]);
      return <SessionWorkspaceNavigation {...navigationProps({
        orientation: "vertical",
        separators,
        separatorsBefore,
        groups: [{ id: "pair", name: "Pair", color: "blue", collapsed: false, tabs: ["alpha", "beta"] }],
        onChangeSeparator: (name, add, side) => side === "before"
          ? setSeparatorsBefore(add ? [...separatorsBefore, name] : [])
          : setSeparators(add ? [...separators, name] : []),
      })} />;
    }
    render(<SeparatorWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Insert separator before current session" }));
    const before = screen.getByRole("separator", { name: "Separator before Alpha control" });
    const tab = document.querySelector('[data-workspace-session-name="alpha"]')!;
    expect(before.parentElement?.nextElementSibling).toBe(tab);
    fireEvent.click(screen.getByRole("button", { name: "Append separator after current session" }));
    const separator = screen.getByRole("separator", { name: "Separator after Alpha control" });
    expect(separator.closest(".workspace-tab-group")).toHaveAttribute("data-workspace-tab-group-id", "pair");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(separator.parentElement?.previousElementSibling).toBe(tab);
    expect(screen.getByRole("button", { name: "Append separator after current session" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove separator after Alpha control" }));
    expect(screen.queryByRole("separator", { name: "Separator after Alpha control" })).toBeNull();
    expect(screen.getByRole("button", { name: "Append separator after current session" })).toBeEnabled();
    expect(before).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove separator before Alpha control" }));
    expect(screen.queryByRole("separator", { name: "Separator before Alpha control" })).toBeNull();
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

  it("offers a side-rail-only stable status sort and announces its ordering", () => {
    const onSortTabsByWorkingState = vi.fn();
    const props = navigationProps({
      openSessions: ["beta", "alpha", "zulu"],
      onSortTabsByWorkingState,
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    expect(screen.queryByRole("button", {
      name: "Stable sort tabs: non-working first, then working",
    })).not.toBeInTheDocument();

    view.rerender(<SessionWorkspaceNavigation {...props} orientation="vertical" />);
    const sortButton = screen.getByRole("button", {
      name: "Stable sort tabs: non-working first, then working",
    });
    expect(sortButton).toHaveTextContent("Non-working first");
    expect(sortButton).toHaveTextContent("Stable");

    fireEvent.click(sortButton);

    expect(onSortTabsByWorkingState).toHaveBeenCalledOnce();
    expect(screen.getByText(
      "Tabs sorted with non-working sessions first and working sessions second. Relative order within each status was preserved.",
    )).toBeInTheDocument();
  });

  it("centers the active vertical tab by scrolling only the tab viewport", () => {
    const props = navigationProps({
      activeSession: "alpha",
      openSessions: ["alpha", "beta", "zulu"],
    });
    const view = render(
      <SessionWorkspaceNavigation {...props} orientation="vertical" />,
    );
    const viewport = document.querySelector<HTMLElement>(".workspace-tab-viewport")!;
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const betaScrollIntoView = vi.fn();
    beta.scrollIntoView = betaScrollIntoView;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 300,
    });
    viewport.scrollTop = 100;
    mockElementBounds(viewport, { top: 100, height: 300 });
    mockElementBounds(beta, { top: 500, height: 42 });

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        activeSession="beta"
        orientation="vertical"
      />,
    );

    expect(viewport.scrollTop).toBe(371);
    expect(betaScrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a long sidebar steady while removing tabs and refreshing workspace data", () => {
    const tabs = ["alpha", "beta", ...Array.from({ length: 28 }, (_, index) => `ended-${index}`)];
    const props = navigationProps({ openSessions: tabs, orientation: "vertical" });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    const viewport = document.querySelector<HTMLElement>(".workspace-tab-viewport")!;
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    viewport.scrollTop = 850;
    mockElementBounds(viewport, { top: 100, height: 300 });
    mockElementBounds(alpha, { top: -700, height: 42 });

    fireEvent.click(screen.getByRole("button", { name: "Close ended-18 quick tab" }));
    const remaining = tabs.filter((name) => name !== "ended-18");
    view.rerender(<SessionWorkspaceNavigation {...props} openSessions={remaining} />);

    expect(viewport.scrollTop).toBe(850);
    expect(alpha).toHaveFocus();

    // Polling and cross-tab synchronization can supply fresh array instances.
    view.rerender(
      <SessionWorkspaceNavigation {...props} openSessions={[...remaining]} groups={[]} />,
    );
    expect(viewport.scrollTop).toBe(850);
  });

  it("preserves the sidebar after forgetting the active tab, then reveals explicit selections", () => {
    const props = navigationProps({
      activeSession: "ended",
      openSessions: ["alpha", "beta", "ended", "zulu"],
      orientation: "vertical",
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    const viewport = document.querySelector<HTMLElement>(".workspace-tab-viewport")!;
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    viewport.scrollTop = 850;
    mockElementBounds(viewport, { top: 100, height: 300 });
    mockElementBounds(beta, { top: -500, height: 42 });
    mockElementBounds(alpha, { top: -600, height: 42 });

    // Forgetting can update the list before the route chooses a surviving tab.
    const remaining = ["alpha", "beta", "zulu"];
    view.rerender(<SessionWorkspaceNavigation {...props} openSessions={remaining} />);
    view.rerender(
      <SessionWorkspaceNavigation {...props} openSessions={remaining} activeSession="beta" />,
    );
    expect(viewport.scrollTop).toBe(850);

    fireEvent.click(alpha);
    expect(props.onSelect).toHaveBeenCalledWith("alpha");
    view.rerender(
      <SessionWorkspaceNavigation {...props} openSessions={remaining} activeSession="alpha" />,
    );
    expect(viewport.scrollTop).toBe(21);
  });

  it("hides direct actions for every top or side tab while Overview keeps them", () => {
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
      recentsOpen: true,
      newSessionActive: true,
      tabActionsVisible: false,
      onMoveTab: vi.fn(),
      onOpenTabInNewWindow: vi.fn().mockReturnValue("opened"),
      onCloseNewSession: vi.fn(),
      onSessionTerminated: vi.fn(),
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    const directActionSelector = [
      ".workspace-tab-reorder",
      ".workspace-tab-window-actions",
      ".workspace-tab-terminate",
      ".workspace-tab-close",
    ].join(", ");

    expect(navigation).toHaveAttribute("data-tab-actions-visible", "false");
    expect(within(navigation).getAllByRole("tab")).toHaveLength(4);
    expect(navigation.querySelectorAll(directActionSelector)).toHaveLength(0);
    expect(within(navigation).queryByRole("button", {
      name: "Close New session tab",
    })).not.toBeInTheDocument();

    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    expect(within(overview).getByRole("button", {
      name: "Move beta tab up",
    })).toBeVisible();
    expect(within(overview).getByRole("button", {
      name: "Copy beta tab to new window",
    })).toBeVisible();
    expect(within(overview).getByRole("button", {
      name: "Terminate beta tmux session",
    })).toBeVisible();
    expect(within(overview).getByRole("button", {
      name: "Close beta quick tab",
    })).toBeVisible();

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        recentsOpen={false}
        newSessionActive={false}
        orientation="vertical"
      />,
    );
    expect(navigation).toHaveAttribute("data-orientation", "vertical");
    expect(navigation).toHaveAttribute("data-tab-actions-visible", "false");
    expect(navigation.querySelectorAll(directActionSelector)).toHaveLength(0);

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        recentsOpen={false}
        newSessionActive={false}
        orientation="vertical"
        tabActionsVisible
      />,
    );
    expect(navigation).toHaveAttribute("data-tab-actions-visible", "true");
    expect(within(navigation).getByRole("button", { name: "Move beta tab up" }))
      .toBeVisible();
    expect(within(navigation).getByRole("button", {
      name: "Copy beta tab to new window",
    })).toBeVisible();
    expect(within(navigation).getByRole("button", {
      name: "Terminate beta tmux session",
    })).toBeVisible();
    expect(within(navigation).getByRole("button", {
      name: "Close beta quick tab",
    })).toBeVisible();
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
        {...navigationProps({ onMoveTab: vi.fn() })}
        orientation="vertical"
      />,
    );

    expect(screen.getByRole("navigation", { name: "Session workspace" }))
      .toHaveAttribute("data-orientation", "horizontal");
    expect(screen.getByRole("tablist", { name: "Session workspace tabs" }))
      .toHaveAttribute("aria-orientation", "horizontal");
    expect(screen.queryByRole("separator", { name: "Resize vertical session tabs" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .not.toHaveAttribute("draggable");
  });

  it.each(["horizontal", "vertical"] as const)(
    "splits Sessions by window target beside New session in the %s tab layout",
    (orientation) => {
      const onOpenDashboard = vi.fn();
      const onQuickNewSession = vi.fn();
      render(
        <SessionWorkspaceNavigation
          {...navigationProps({ onNewSession: vi.fn(), onQuickNewSession, onOpenDashboard })}
          orientation={orientation}
          dashboardWindowHref="/mux/?workspace=release&tab=alpha&tab=beta"
        />,
      );

      const dashboardActions = screen.getByRole("group", { name: "Sessions page actions" });
      const sessionsButton = within(dashboardActions)
        .getByRole("button", { name: "All sessions" });
      const sessionsWindowLink = within(dashboardActions)
        .getByRole("link", { name: "Open all sessions in new window" });
      const newSessionActions = screen.getByRole("group", { name: "New session actions" });
      const newSessionButton = within(newSessionActions)
        .getByRole("button", { name: "New session" });
      const quickSessionButton = within(newSessionActions)
        .getByRole("button", { name: "Quick new temporary session" });
      expect(sessionsWindowLink).toHaveAttribute(
        "href",
        "/mux/?workspace=release&tab=alpha&tab=beta",
      );
      expect(sessionsWindowLink).toHaveAttribute("target", "_blank");
      expect(sessionsWindowLink).toHaveAttribute("rel", "noopener noreferrer");
      fireEvent.click(sessionsButton);
      expect(onOpenDashboard).toHaveBeenCalledOnce();
      expect(dashboardActions.nextElementSibling).toBe(newSessionActions);
      expect(newSessionButton.nextElementSibling).toBe(quickSessionButton);
      expect(newSessionActions.nextElementSibling).toHaveClass("workspace-tab-viewport");
      fireEvent.click(quickSessionButton);
      expect(onQuickNewSession).toHaveBeenCalledOnce();
    },
  );

  it("labels, disables, and reports errors for quick temporary session creation", () => {
    const onQuickNewSession = vi.fn();
    const onDismissQuickNewSessionError = vi.fn();
    const props = navigationProps({ onNewSession: vi.fn(), onQuickNewSession });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    const quick = screen.getByRole("button", { name: "Quick new temporary session" });
    expect(quick).not.toHaveAttribute("aria-keyshortcuts");
    expect(quick).toHaveAttribute(
      "title",
      "Quick temporary session from workspace memory (Ctrl+Shift+Z, then K)",
    );
    expect(quick).not.toBeDisabled();

    view.rerender(
      <SessionWorkspaceNavigation
        {...props}
        quickNewSessionBusy
        quickNewSessionError="The remembered directory is unavailable."
        onDismissQuickNewSessionError={onDismissQuickNewSessionError}
      />,
    );
    expect(quick).toBeDisabled();
    expect(quick).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The remembered directory is unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss quick session error" }));
    expect(onDismissQuickNewSessionError).toHaveBeenCalledOnce();
  });

  it("opens a synthetic New session tab from the fixed tab-bar action", () => {
    const onNewSession = vi.fn();
    const props = navigationProps({ onNewSession });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    const openNewSession = screen.getByRole("button", { name: "New session" });
    expect(openNewSession).toHaveAttribute("aria-keyshortcuts", "Control+Shift+B");
    expect(openNewSession).toHaveAttribute("title", "New session (Ctrl+Shift+B)");
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

  it.each(["horizontal", "vertical"] as const)("nests a branch by its %s tab center and promotes it at the root drop target", (orientation) => {
    const onReparentSession = vi.fn();
    const onMoveTab = vi.fn();
    const props = navigationProps({ orientation, openSessions: ["alpha", "beta", "zulu"],
      sessionParents: { beta: "alpha" }, onReparentSession, onMoveTab });
    render(<SessionWorkspaceNavigation {...props} />);
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const target = screen.getByRole("tab", { name: "Zulu shell, Other" }).closest<HTMLElement>(".workspace-tab")!;
    const dataTransfer = dragDataTransfer();
    mockElementBounds(target, { top: 200, left: 200, width: 100, height: 40 });
    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.dragOver(target, { clientX: 250, clientY: 220, dataTransfer });
    expect(target).toHaveAttribute("data-tab-drop-nest", "true");
    fireEvent.drop(target, { clientX: 250, clientY: 220, dataTransfer });
    expect(onReparentSession).toHaveBeenLastCalledWith("alpha", "zulu");
    expect(onMoveTab).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.dragStart(beta, { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "Top level drop target" }), { dataTransfer });
    expect(onReparentSession).toHaveBeenLastCalledWith("beta", null);
    expect(screen.queryByRole("group", { name: "Top level drop target" })).not.toBeInTheDocument();
  });

  it("rejects dropping on descendants and keeps edge drops as ordinary reorders", () => {
    const onReparentSession = vi.fn();
    const onMoveTab = vi.fn();
    render(<SessionWorkspaceNavigation {...navigationProps({
      openSessions: ["alpha", "beta", "zulu"], sessionParents: { beta: "alpha" }, onMoveTab, onReparentSession,
    })} />);
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" }).closest<HTMLElement>(".workspace-tab")!;
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" }).closest<HTMLElement>(".workspace-tab")!;
    mockElementBounds(beta, { left: 100, width: 100 });
    mockElementBounds(zulu, { left: 200, width: 100 });
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.dragOver(zulu, { clientX: 250, clientY: 20, dataTransfer });
    fireEvent.dragOver(beta, { clientX: 150, clientY: 20, dataTransfer });
    expect(zulu).not.toHaveAttribute("data-tab-drop-nest");
    fireEvent.drop(beta, { clientX: 150, clientY: 20, dataTransfer });
    expect(onReparentSession).not.toHaveBeenCalled();
    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.drop(zulu, { clientX: 295, clientY: 20, dataTransfer });
    expect(onMoveTab).toHaveBeenCalledWith("alpha", 2);
  });

  it("opens placement from a tab and exposes promotion and nesting through its keyboard", () => {
    const onReparentSession = vi.fn();
    const onTransferSelectedSessions = vi.fn();
    render(<SessionWorkspaceNavigation {...navigationProps({
      openSessions: ["alpha", "beta", "zulu"], sessionParents: { beta: "alpha", zulu: "alpha" },
      onReparentSession, onTransferSelectedSessions,
    })} />);
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    fireEvent.contextMenu(zulu);
    expect(onTransferSelectedSessions).toHaveBeenCalledWith(["zulu"]);
    fireEvent.keyDown(zulu, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(onReparentSession).toHaveBeenLastCalledWith("zulu", null);
    fireEvent.keyDown(zulu, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onReparentSession).toHaveBeenLastCalledWith("zulu", "beta");
  });

  it("moves the selected branch up and down one level without switching or closing sessions", async () => {
    const props = navigationProps({ activeSession: "zulu", tabActionsVisible: false });
    function NestedNavigation() {
      const [workspace, setWorkspace] = useState<SessionWorkspaceState>({
        openSessions: ["alpha", "beta", "zulu", "archive"], recentSessions: [], groups: [],
        parents: { beta: "alpha", zulu: "beta", archive: "zulu" },
      });
      return <SessionWorkspaceNavigation {...props} {...workspace} sessionParents={workspace.parents}
        onReparentSession={(name, parent) => setWorkspace((current) => reparentWorkspaceSession(current, name, parent))} />;
    }
    render(<NestedNavigation />);
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    const child = screen.getByRole("tab", { name: "Archived deploy, Background work" });
    const controls = screen.getByRole("group", { name: "Session nesting level" });
    const promote = within(controls).getByRole("button", { name: "Up one level" });
    const nest = within(controls).getByRole("button", { name: "Down one level" });
    expect(promote).toBeEnabled();
    expect(nest).toBeDisabled();
    fireEvent.click(promote);
    expect(zulu.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "alpha");
    expect(child.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "zulu");
    expect(zulu).toHaveAttribute("aria-selected", "true");
    expect(nest).toBeEnabled();
    fireEvent.click(promote);
    expect(zulu.closest(".workspace-tab")).not.toHaveAttribute("data-session-parent");
    expect(child.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "zulu");
    expect(promote).toBeVisible();
    expect(promote).toBeDisabled();
    expect(promote).toHaveAccessibleDescription("This session is already at the top level");
    expect(nest).toHaveAccessibleDescription("Nest Zulu shell under Alpha control; its nested sessions come with it");
    fireEvent.click(nest);
    expect(zulu.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "alpha");
    expect(child.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "zulu");
    expect(nest).toHaveAccessibleDescription("Nest Zulu shell under beta; its nested sessions come with it");
    fireEvent.click(nest);
    expect(zulu.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "beta");
    expect(child.closest(".workspace-tab")).toHaveAttribute("data-session-parent", "zulu");
    expect(zulu).toHaveAttribute("aria-selected", "true");
    expect(nest).toBeDisabled();
    expect(promote).toBeEnabled();
    expect(screen.getByText("Zulu shell moved down one level.")).toBeInTheDocument();
    await waitFor(() => expect(zulu).toHaveFocus());
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it.each<Partial<NavigationProps>>([
    { activeSession: "alpha" },
    { activeSession: "beta", groups: [
      { id: "review", name: "Review", color: "blue", collapsed: false, tabs: ["alpha"] },
    ] },
  ])("keeps root level controls visible without allowing a move across tab groups: %j", (overrides) => {
    const props = navigationProps({
      onReparentSession: vi.fn(), ...overrides,
    });
    render(<SessionWorkspaceNavigation {...props} />);
    const controls = screen.getByRole("group", { name: "Session nesting level" });
    const promote = within(controls).getByRole("button", { name: "Up one level" });
    const nest = within(controls).getByRole("button", { name: "Down one level" });
    expect(controls).toBeVisible();
    expect(promote).toBeDisabled();
    expect(nest).toBeDisabled();
    expect(nest).toHaveAccessibleDescription("There is no previous session at this level in the same tab group");
    fireEvent.click(promote);
    fireEvent.click(nest);
    expect(props.onReparentSession).not.toHaveBeenCalled();
  });

  it.each(["Up one level", "Down one level"])("announces a rejected %s and leaves the tab nested", (buttonName) => {
    render(<SessionWorkspaceNavigation {...navigationProps({
      activeSession: "zulu", openSessions: ["alpha", "beta", "zulu"],
      sessionParents: { beta: "alpha", zulu: "alpha" },
      onReparentSession: () => { throw new Error("Wait for the workspace to finish opening."); },
    })} />);
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(screen.getByText("Wait for the workspace to finish opening.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Zulu shell, Other" }).closest(".workspace-tab"))
      .toHaveAttribute("data-session-parent", "alpha");
  });

  it("opens placement for the current session even when tab actions are hidden", () => {
    const props = navigationProps({
      tabActionsVisible: false,
      sessionParents: { beta: "alpha" },
      onReparentSession: vi.fn(),
      onTransferSelectedSessions: vi.fn(),
    });
    const { rerender } = render(<SessionWorkspaceNavigation {...props} />);
    // The per-tab control targets an inactive nested tab without changing selection.
    const nestedPlacement = screen.getByRole("button", { name: "Move / Nest beta" });
    expect(nestedPlacement).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(nestedPlacement);
    expect(props.onTransferSelectedSessions).toHaveBeenLastCalledWith(["beta"]);
    expect(screen.queryByRole("button", { name: "Move / Nest Alpha control" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Move / Nest" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAccessibleDescription(/Organize Alpha control/);
    fireEvent.click(button);
    expect(props.onTransferSelectedSessions).toHaveBeenLastCalledWith(["alpha"]);

    // Placement changes workspace metadata, so unavailable sessions can still move.
    rerender(<SessionWorkspaceNavigation {...props} activeSession="beta" sessions={[]} />);
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(props.onTransferSelectedSessions).toHaveBeenLastCalledWith(["beta"]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onReparentSession).not.toHaveBeenCalled();
  });

  it.each<Partial<NavigationProps>>([
    { workspacePersistenceState: "loading" },
    { workspacePersistenceState: "error" },
    { separatorsBusy: true },
    { newSessionActive: true },
    { activeSession: null },
    { activeSession: "not-in-workspace" },
  ])("disables placement and level controls when the workspace or session is unavailable: %j", (overrides) => {
    const onTransferSelectedSessions = vi.fn();
    const onReparentSession = vi.fn();
    render(<SessionWorkspaceNavigation {...navigationProps({
      activeSession: "zulu", openSessions: ["alpha", "beta", "zulu"],
      sessionParents: { beta: "alpha", zulu: "alpha" },
      onReparentSession, onTransferSelectedSessions, ...overrides,
    })} />);
    const button = screen.getByRole("button", { name: "Move / Nest" });
    const promote = screen.getByRole("button", { name: "Up one level" });
    const nest = screen.getByRole("button", { name: "Down one level" });
    expect(button).toBeDisabled();
    expect(promote).toBeDisabled();
    expect(nest).toBeDisabled();
    fireEvent.click(button);
    fireEvent.click(promote);
    fireEvent.click(nest);
    if (overrides.workspacePersistenceState || overrides.separatorsBusy) {
      const tabPlacement = screen.getByRole("button", { name: "Move / Nest Zulu shell" });
      expect(tabPlacement).toBeDisabled();
      fireEvent.click(tabPlacement);
    }
    expect(onReparentSession).not.toHaveBeenCalled();
    expect(onTransferSelectedSessions).not.toHaveBeenCalled();
  });

  it("targets the focused session for placement and level changes in a multi-pane view", () => {
    const onTransferSelectedSessions = vi.fn();
    const onReparentSession = vi.fn();
    render(<ActivePaneSessionContext.Provider value="beta">
      <SessionWorkspaceNavigation {...navigationProps({
        activeSession: null, onReparentSession, onTransferSelectedSessions,
      })} />
    </ActivePaneSessionContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Move / Nest" }));
    expect(onTransferSelectedSessions).toHaveBeenCalledWith(["beta"]);
    expect(screen.getByRole("button", { name: "Up one level" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Down one level" }));
    expect(onReparentSession).toHaveBeenCalledWith("beta", "alpha");
  });

  it("drags horizontal desktop tabs to a new position without selecting or closing them", () => {
    const onMoveTab = vi.fn();
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
      onMoveTab,
    });
    render(<SessionWorkspaceNavigation {...props} />);

    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const alphaContainer = alpha.closest<HTMLElement>(".workspace-tab")!;
    const zuluContainer = screen.getByRole("tab", { name: "Zulu shell, Other" })
      .closest<HTMLElement>(".workspace-tab")!;
    const dataTransfer = dragDataTransfer();
    mockElementBounds(zuluContainer, { left: 200, width: 100 });

    expect(alpha).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(alpha, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "alpha");
    expect(dataTransfer.setData).toHaveBeenCalledWith(WORKSPACE_SESSION_DRAG_TYPE, "alpha");
    expect(alphaContainer).toHaveAttribute("data-tab-dragging", "true");

    fireEvent.dragOver(zuluContainer, {
      clientX: 290,
      clientY: 20,
      dataTransfer,
    });
    expect(zuluContainer).toHaveAttribute("data-tab-drop-edge", "after");

    fireEvent.drop(zuluContainer, {
      clientX: 290,
      clientY: 20,
      dataTransfer,
    });
    expect(onMoveTab).toHaveBeenCalledWith("alpha", 2);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onCloseTab).not.toHaveBeenCalled();
    expect(alphaContainer).not.toHaveAttribute("data-tab-dragging");
    expect(zuluContainer).not.toHaveAttribute("data-tab-drop-edge");
    expect(screen.getByText(
      "Alpha control moved to position 3 of 3.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();
  });

  it("allows a workspace's only tab to be dragged into a pane view", () => {
    render(<SessionWorkspaceNavigation {...navigationProps({
      openSessions: ["alpha"],
      activePaneLayoutId: "pair",
      onMoveTab: vi.fn(),
    })} />);
    const tab = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const dataTransfer = dragDataTransfer();
    expect(tab).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(tab, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(WORKSPACE_SESSION_DRAG_TYPE, "alpha");
  });

  it("selects desktop tab ranges and clears the move selection on a normal click or Escape", () => {
    const props = navigationProps({
      openSessions: ["alpha", "beta", "archive", "zulu"],
      onMoveTab: vi.fn(),
      onMoveTabs: vi.fn(),
      onTabSelectionChange: vi.fn(),
      onTransferSelectedSessions: vi.fn(),
    });
    render(<SessionWorkspaceNavigation {...props} />);

    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const archive = screen.getByRole("tab", { name: "Archived deploy, Background work" });
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });

    fireEvent.click(archive, { shiftKey: true });
    expect(props.onTabSelectionChange).toHaveBeenLastCalledWith(["alpha", "beta", "archive"]);
    expect(alpha.closest(".workspace-tab")).toHaveAttribute("data-tab-move-selected", "true");
    expect(beta.closest(".workspace-tab")).toHaveAttribute("data-tab-move-selected", "true");
    expect(archive.closest(".workspace-tab")).toHaveAttribute("data-tab-move-selected", "true");
    expect(zulu.closest(".workspace-tab")).not.toHaveAttribute("data-tab-move-selected");
    expect(screen.getByRole("group", { name: "3 tabs selected for moving" }))
      .toHaveTextContent("3selectedDrag together");
    fireEvent.click(screen.getByRole("button", {
      name: "Move or copy 3 selected sessions to a workspace",
    }));
    expect(props.onTransferSelectedSessions).toHaveBeenCalledWith([
      "alpha",
      "beta",
      "archive",
    ]);
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(archive, { key: "Escape" });
    expect(props.onTabSelectionChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("group", { name: /tabs selected for moving/ }))
      .not.toBeInTheDocument();
    expect(alpha.closest(".workspace-tab")).not.toHaveAttribute("data-tab-move-selected");

    fireEvent.click(beta, { ctrlKey: true });
    expect(beta.closest(".workspace-tab")).toHaveAttribute("data-tab-move-selected", "true");
    fireEvent.click(zulu);
    expect(props.onSelect).toHaveBeenCalledWith("zulu");
    expect(screen.queryByRole("group", { name: /tabs selected for moving/ }))
      .not.toBeInTheDocument();
  });

  it("drags a separator between groups without selecting or reordering tabs", () => {
    const props = navigationProps({
      orientation: "vertical", openSessions: ["alpha", "beta", "zulu"],
      separators: ["alpha"], onCrossSeparator: vi.fn(), onMoveTab: vi.fn(), onMoveTabs: vi.fn(),
      groups: [{ id: "pair", name: "Pair", color: "blue", collapsed: false, tabs: ["alpha", "beta"] }],
    });
    render(<SessionWorkspaceNavigation {...props} />);
    const line = screen.getByRole("separator", { name: "Separator after Alpha control" });
    const row = screen.getByRole("tab", { name: "Zulu shell, Other" }).closest<HTMLElement>(".workspace-tab")!;
    mockElementBounds(row, { top: 100, height: 40 });
    const dataTransfer = dragDataTransfer();
    expect(line).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(line, { dataTransfer });
    expect(line.parentElement).toHaveAttribute("data-separator-dragging", "true");
    expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith(
      "application/x-muxdeck-separator", JSON.stringify({ name: "alpha", side: "after" }),
    );
    fireEvent.dragOver(row, { dataTransfer, clientY: 102 });
    expect(row).toHaveAttribute("data-separator-drop-edge", "before");
    fireEvent.dragOver(row, { dataTransfer, clientY: 138 });
    expect(row).toHaveAttribute("data-separator-drop-edge", "after");
    fireEvent.drop(row, { dataTransfer, clientY: 138 });
    expect(props.onCrossSeparator).toHaveBeenCalledExactlyOnceWith({
      from: { name: "alpha", side: "after" }, to: { name: "zulu", side: "after" },
    });
    expect(row).not.toHaveAttribute("data-separator-drop-edge");
    expect(line.parentElement).not.toHaveAttribute("data-separator-dragging");
    expect(props.onMoveTab).not.toHaveBeenCalled();
    expect(props.onMoveTabs).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("cancels separator dragging on drag end or workspace changes and ignores external drops", () => {
    const props = navigationProps({ orientation: "vertical", separators: ["alpha"], onCrossSeparator: vi.fn(), activeWorkspaceId: "one" });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    const line = screen.getByRole("separator", { name: "Separator after Alpha control" });
    const row = screen.getByRole("tab", { name: "beta, Working" }).closest<HTMLElement>(".workspace-tab")!;
    mockElementBounds(row, { top: 100, height: 40 });
    const dataTransfer = dragDataTransfer();
    fireEvent.drop(row, { dataTransfer, clientY: 138 });
    expect(props.onCrossSeparator).not.toHaveBeenCalled();
    fireEvent.dragStart(line, { dataTransfer });
    fireEvent.dragOver(row, { dataTransfer, clientY: 138 });
    fireEvent.dragEnd(line);
    expect(row).not.toHaveAttribute("data-separator-drop-edge");
    fireEvent.dragStart(line, { dataTransfer });
    fireEvent.dragOver(row, { dataTransfer, clientY: 138 });
    view.rerender(<SessionWorkspaceNavigation {...props} activeWorkspaceId="two" />);
    expect(row).not.toHaveAttribute("data-separator-drop-edge");
    fireEvent.drop(row, { dataTransfer, clientY: 138 });
    expect(props.onCrossSeparator).not.toHaveBeenCalled();
    view.rerender(<SessionWorkspaceNavigation {...props} separatorsBusy />);
    expect(line).toHaveAttribute("draggable", "false");
    expect(fireEvent.dragStart(line, { dataTransfer })).toBe(false);
  });

  it("moves an adjacent tab across a separator with arrows or drag without changing tab order", () => {
    const onCrossSeparator = vi.fn();
    const props = navigationProps({ orientation: "vertical", separators: ["alpha"], onCrossSeparator, onMoveTab: vi.fn(), onMoveTabs: vi.fn() });
    render(<SessionWorkspaceNavigation {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Move beta tab up" }));
    expect(onCrossSeparator).toHaveBeenLastCalledWith({ from: { name: "alpha", side: "after" }, to: { name: "beta", side: "after" } });
    expect(props.onMoveTab).not.toHaveBeenCalled();
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(beta, { dataTransfer });
    const separator = screen.getByRole("separator", { name: "Separator after Alpha control" }).parentElement!;
    fireEvent.dragOver(separator, { dataTransfer });
    expect(separator).toHaveAttribute("data-crossing", "true");
    fireEvent.drop(separator, { dataTransfer });
    expect(onCrossSeparator).toHaveBeenCalledTimes(2);
    expect(props.onMoveTabs).not.toHaveBeenCalled();
  });

  it("crosses a leading separator with the complete selected block", () => {
    const props = navigationProps({ orientation: "vertical", separatorsBefore: ["alpha"], onCrossSeparator: vi.fn(), onMoveTab: vi.fn(), onMoveTabs: vi.fn() });
    render(<SessionWorkspaceNavigation {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "beta, Working" }), { shiftKey: true });
    const up = screen.getByRole("button", { name: "Move selected tabs up" });
    expect(up).toBeEnabled();
    fireEvent.click(up);
    expect(props.onCrossSeparator).toHaveBeenCalledWith({ from: { name: "alpha", side: "before" }, to: { name: "beta", side: "after" } });
    expect(props.onMoveTabs).not.toHaveBeenCalled();
  });

  it("clears the reported selection when switching workspaces or unmounting", () => {
    const onTabSelectionChange = vi.fn();
    const props = navigationProps({ onMoveTab: vi.fn(), onMoveTabs: vi.fn(), onTabSelectionChange, activeWorkspaceId: "one" });
    const view = render(<SessionWorkspaceNavigation {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "beta, Working" }), { shiftKey: true });
    expect(onTabSelectionChange).toHaveBeenLastCalledWith(["alpha", "beta"]);
    view.rerender(<SessionWorkspaceNavigation {...props} activeWorkspaceId="two" />);
    expect(onTabSelectionChange).toHaveBeenLastCalledWith([]);
    view.unmount();
    expect(onTabSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it.each(["horizontal", "vertical"] as const)("moves selections with arrows in %s tabs and keeps selection", (orientation) => {
    const onMoveTab = vi.fn();
    function Harness() {
      const [tabs, setTabs] = useState(["alpha", "beta", "archive", "zulu"]);
      return <SessionWorkspaceNavigation {...navigationProps({
        activeSession: "beta", openSessions: tabs, orientation, onMoveTab,
        onMoveTabs: (names, target) => setTabs(moveWorkspaceSessions({
          openSessions: tabs, recentSessions: [], groups: [],
        }, names, target).openSessions),
      })} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "Archived deploy, Background work" }), { shiftKey: true });
    const previous = orientation === "vertical" ? "up" : "left";
    const next = orientation === "vertical" ? "down" : "right";
    const order = () => Array.from(document.querySelectorAll(".workspace-tab[data-workspace-session-name]"))
      .map((item) => item.getAttribute("data-workspace-session-name"));
    fireEvent.click(screen.getByRole("button", { name: `Move beta tab ${previous}` }));
    expect(order()).toEqual(["beta", "archive", "alpha", "zulu"]);
    expect(onMoveTab).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Move selected tabs ${previous}` })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: `Move selected tabs ${next}` }));
    fireEvent.click(screen.getByRole("button", { name: `Move selected tabs ${next}` }));
    expect(order()).toEqual(["alpha", "zulu", "beta", "archive"]);
    expect(screen.getByRole("button", { name: `Move selected tabs ${next}` })).toBeDisabled();
    expect(screen.getByRole("group", { name: "2 tabs selected for moving" })).toBeVisible();
  });

  it("offers move controls with Actions hidden and preserves non-contiguous selection order", () => {
    const onMoveTabs = vi.fn();
    render(<SessionWorkspaceNavigation {...navigationProps({
      openSessions: ["alpha", "beta", "archive", "zulu"], tabActionsVisible: false,
      onMoveTab: vi.fn(), onMoveTabs, orientation: "vertical",
    })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Zulu shell, Other" }), { metaKey: true });
    fireEvent.click(screen.getByRole("tab", { name: "beta, Working" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Move selected tabs up" }));
    expect(onMoveTabs).toHaveBeenCalledWith(["beta", "zulu"], 0);
    expect(screen.getByRole("button", { name: "Move selected tabs down" })).toBeDisabled();
  });

  it("moves a Ctrl/Cmd-selected set together in stable tab order", () => {
    const onMoveTabs = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "archive", "zulu"],
          onMoveTab: vi.fn(),
          onMoveTabs,
        })}
      />,
    );

    const alphaContainer = screen.getByRole("tab", {
      name: "Alpha control, Needs input",
    }).closest<HTMLElement>(".workspace-tab")!;
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    const betaContainer = beta.closest<HTMLElement>(".workspace-tab")!;
    const zuluContainer = zulu.closest<HTMLElement>(".workspace-tab")!;

    fireEvent.click(zulu, { metaKey: true });
    fireEvent.click(beta, { ctrlKey: true });
    expect(betaContainer).toHaveAttribute("data-tab-move-selected", "true");
    expect(zuluContainer).toHaveAttribute("data-tab-move-selected", "true");

    const dataTransfer = dragDataTransfer();
    mockElementBounds(alphaContainer, { left: 100, width: 100 });
    fireEvent.dragStart(zulu, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-muxdeck-tabs",
      JSON.stringify(["beta", "zulu"]),
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith(WORKSPACE_SESSION_DRAG_TYPE, "zulu");
    expect(betaContainer).toHaveAttribute("data-tab-dragging", "true");
    expect(zuluContainer).toHaveAttribute("data-tab-dragging", "true");

    fireEvent.dragOver(alphaContainer, {
      clientX: 105,
      clientY: 20,
      dataTransfer,
    });
    expect(alphaContainer).toHaveAttribute("data-tab-drop-edge", "before");
    fireEvent.drop(alphaContainer, {
      clientX: 105,
      clientY: 20,
      dataTransfer,
    });

    expect(onMoveTabs).toHaveBeenCalledOnce();
    expect(onMoveTabs).toHaveBeenCalledWith(["beta", "zulu"], 0);
    expect(betaContainer).toHaveAttribute("data-tab-move-selected", "true");
    expect(zuluContainer).toHaveAttribute("data-tab-move-selected", "true");
    expect(screen.getByText(
      "2 selected tabs moved to positions 1 through 2 of 4. Their relative order was preserved.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();
  });

  it.each(["horizontal", "vertical"] as const)("drags a folded group header and its nested members in %s tabs", (orientation) => {
    const onMoveTabs = vi.fn();
    const props = navigationProps({
      activeSession: "beta", openSessions: ["alpha", "beta", "zulu", "archive"],
      sessionParents: { zulu: "beta" },
      groups: [{ id: "workers", name: "Workers", color: "green", collapsed: true, tabs: ["beta", "zulu"] }],
      onMoveTab: vi.fn(), onMoveTabs, onToggleTabGroup: vi.fn(), onReparentSession: vi.fn(), orientation,
    });
    render(<SessionWorkspaceNavigation {...props} />);
    const header = screen.getByRole("button", { name: "Expand Workers tab group" });
    const group = header.closest<HTMLElement>("[data-workspace-tab-group-id]")!;
    const archive = screen.getByRole("tab", { name: "Archived deploy, Background work" }).closest<HTMLElement>(".workspace-tab")!;
    expect(header).toHaveAttribute("draggable", "true");
    expect(within(group).queryByRole("tab")).not.toBeInTheDocument();
    mockElementBounds(archive, { left: 100, top: 100, width: 100, height: 40 });
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(header, { dataTransfer });
    expect(group).toHaveAttribute("data-tab-dragging", "true");
    expect(dataTransfer.setData).not.toHaveBeenCalledWith(WORKSPACE_SESSION_DRAG_TYPE, expect.any(String));
    fireEvent.dragOver(archive, { clientX: 190, clientY: 135, dataTransfer });
    expect(archive).toHaveAttribute("data-tab-drop-edge", "after");
    fireEvent.drop(archive, { clientX: 190, clientY: 135, dataTransfer });
    expect(onMoveTabs).toHaveBeenCalledWith(["beta", "zulu"], 2);
    expect(props.onReparentSession).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onToggleTabGroup).not.toHaveBeenCalled();
    expect(group).not.toHaveAttribute("data-tab-dragging");
  });

  it("moves a one-session group as a block without nesting or promoting it", () => {
    const props = navigationProps({ activeSession: "beta", openSessions: ["beta", "alpha"],
      groups: [{ id: "one", name: "One", color: "green", collapsed: true, tabs: ["beta"] }],
      onMoveTab: vi.fn(), onMoveTabs: vi.fn(), onToggleTabGroup: vi.fn(), onReparentSession: vi.fn() });
    render(<SessionWorkspaceNavigation {...props} />);
    const target = screen.getByRole("tab", { name: "Alpha control, Needs input" }).closest<HTMLElement>(".workspace-tab")!;
    mockElementBounds(target, { left: 100, width: 100 });
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Expand One tab group" }), { dataTransfer });
    expect(screen.queryByRole("group", { name: "Top level drop target" })).not.toBeInTheDocument();
    fireEvent.dragOver(target, { clientX: 160, clientY: 20, dataTransfer });
    expect(target).not.toHaveAttribute("data-tab-drop-nest");
    fireEvent.drop(target, { clientX: 160, clientY: 20, dataTransfer });
    expect(props.onMoveTabs).toHaveBeenCalledWith(["beta"], 1);
    expect(props.onReparentSession).not.toHaveBeenCalled();
    expect(props.onMoveTab).not.toHaveBeenCalled();
  });

  it.each<Partial<NavigationProps>>([
    { workspacePersistenceState: "loading" }, { workspacePersistenceState: "error" }, { separatorsBusy: true },
  ])("disables group dragging while synchronization is unavailable: %j", (overrides) => {
    render(<SessionWorkspaceNavigation {...navigationProps({
      groups: [{ id: "one", name: "One", color: "green", collapsed: true, tabs: ["beta"] }],
      onMoveTab: vi.fn(), onMoveTabs: vi.fn(), onToggleTabGroup: vi.fn(), ...overrides,
    })} />);
    expect(screen.getByRole("button", { name: "Expand One tab group" })).not.toHaveAttribute("draggable");
  });

  it("cancels a group drag when another workspace opens", () => {
    const props = navigationProps({ activeWorkspaceId: "first",
      groups: [{ id: "one", name: "One", color: "green", collapsed: true, tabs: ["beta"] }],
      onMoveTab: vi.fn(), onMoveTabs: vi.fn(), onToggleTabGroup: vi.fn() });
    const { rerender } = render(<SessionWorkspaceNavigation {...props} />);
    const header = screen.getByRole("button", { name: "Expand One tab group" });
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(header, { dataTransfer });
    expect(header.closest("[data-workspace-tab-group-id]")).toHaveAttribute("data-tab-dragging", "true");
    rerender(<SessionWorkspaceNavigation {...props} activeWorkspaceId="second" />);
    expect(header.closest("[data-workspace-tab-group-id]")).not.toHaveAttribute("data-tab-dragging");
    fireEvent.drop(screen.getByRole("tab", { name: "Alpha control, Needs input" }).closest(".workspace-tab")!, { dataTransfer });
    expect(props.onMoveTabs).not.toHaveBeenCalled();
  });

  it("uses the vertical midpoint when dragging tabs in the desktop side rail", () => {
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

    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
    const alphaContainer = screen.getByRole("tab", {
      name: "Alpha control, Needs input",
    }).closest<HTMLElement>(".workspace-tab")!;
    const dataTransfer = dragDataTransfer();
    mockElementBounds(alphaContainer, { top: 100, height: 40 });

    fireEvent.dragStart(zulu, { dataTransfer });
    fireEvent.dragOver(alphaContainer, {
      clientX: 999,
      clientY: 105,
      dataTransfer,
    });
    expect(alphaContainer).toHaveAttribute("data-tab-drop-edge", "before");
    fireEvent.drop(alphaContainer, {
      clientX: 999,
      clientY: 105,
      dataTransfer,
    });

    expect(onMoveTab).toHaveBeenCalledWith("zulu", 0);
  });

  it("keeps grouped tab drags inside their group", () => {
    const onMoveTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "workers",
            name: "Workers",
            color: "green",
            collapsed: false,
            tabs: ["beta", "zulu"],
          }],
          onMoveTab,
        })}
      />,
    );

    const beta = screen.getByRole("tab", { name: /beta, Workers group/i });
    const zuluContainer = screen.getByRole("tab", { name: /Zulu shell, Workers group/i })
      .closest<HTMLElement>(".workspace-tab")!;
    const alphaContainer = screen.getByRole("tab", {
      name: "Alpha control, Needs input",
    }).closest<HTMLElement>(".workspace-tab")!;
    const firstTransfer = dragDataTransfer();
    mockElementBounds(zuluContainer, { left: 200, width: 100 });

    fireEvent.dragStart(beta, { dataTransfer: firstTransfer });
    fireEvent.dragOver(zuluContainer, {
      clientX: 290,
      clientY: 20,
      dataTransfer: firstTransfer,
    });
    fireEvent.drop(zuluContainer, {
      clientX: 290,
      clientY: 20,
      dataTransfer: firstTransfer,
    });
    expect(onMoveTab).toHaveBeenCalledWith("beta", 2);

    const secondTransfer = dragDataTransfer();
    mockElementBounds(alphaContainer, { left: 0, width: 100 });
    fireEvent.dragStart(beta, { dataTransfer: secondTransfer });
    fireEvent.dragOver(alphaContainer, {
      clientX: 5,
      clientY: 20,
      dataTransfer: secondTransfer,
    });
    expect(alphaContainer).not.toHaveAttribute("data-tab-drop-edge");
    fireEvent.drop(alphaContainer, {
      clientX: 5,
      clientY: 20,
      dataTransfer: secondTransfer,
    });
    fireEvent.dragEnd(beta, { dataTransfer: secondTransfer });
    expect(onMoveTab).toHaveBeenCalledTimes(1);
  });

  it("drops ungrouped tabs around a group as one atomic block", () => {
    const onMoveTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "workers",
            name: "Workers",
            color: "green",
            collapsed: false,
            tabs: ["beta", "zulu"],
          }],
          onMoveTab,
        })}
      />,
    );

    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const group = document.querySelector<HTMLElement>(
      '[data-workspace-tab-group-id="workers"]',
    )!;
    const dataTransfer = dragDataTransfer();
    mockElementBounds(group, { left: 100, width: 240 });

    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.dragOver(group, {
      clientX: 330,
      clientY: 20,
      dataTransfer,
    });
    expect(group).toHaveAttribute("data-tab-drop-edge", "after");
    fireEvent.drop(group, {
      clientX: 330,
      clientY: 20,
      dataTransfer,
    });

    expect(onMoveTab).toHaveBeenCalledWith("alpha", 2);
    expect(screen.getByText(
      "Alpha control moved to position 3 of 3.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();
  });

  it("requires the atomic move handler before a collapsed group can be dragged", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          activeSession: "beta",
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "workers",
            name: "Workers",
            color: "green",
            collapsed: true,
            tabs: ["beta", "zulu"],
          }],
          onMoveTab: vi.fn(),
          onToggleTabGroup: vi.fn(),
        })}
      />,
    );

    expect(screen.queryByRole("tab", { name: /beta, Workers group/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Workers tab group" })).not.toHaveAttribute("draggable");
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .toHaveAttribute("draggable", "true");
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
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .not.toHaveAttribute("draggable");

    view.rerender(
      <SessionWorkspaceNavigation
        {...navigationProps({ openSessions: ["alpha"], onMoveTab: vi.fn() })}
      />,
    );
    expect(screen.queryByRole("group", { name: /Reorder .* tab/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Alpha control, Needs input" }))
      .not.toHaveAttribute("draggable");
  });

  it("announces the final position when an ungrouped tab crosses a group", () => {
    const onMoveTab = vi.fn();
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "beta", "zulu"],
          groups: [{
            id: "workers",
            name: "Workers",
            color: "green",
            collapsed: false,
            tabs: ["beta", "zulu"],
          }],
          onMoveTab,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Alpha control tab right" }));
    expect(onMoveTab).toHaveBeenCalledWith("alpha", 1);
    expect(screen.getByText(
      "Alpha control moved to position 3 of 3.",
      { selector: "[role='status']" },
    )).toBeInTheDocument();
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

  it("renames a saved workspace directly from the desktop tab bar", async () => {
    const onRenameWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error("workspace storage is temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          workspacePersistenceState: "saved",
          activeWorkspaceId: "workspace-one",
          workspaceName: "Release command center",
          onRenameWorkspace,
        })}
      />,
    );

    const openRename = screen.getByRole("button", {
      name: "Rename workspace Release command center",
    });
    expect(openRename).toHaveAttribute("aria-controls", "workspace-rename-dialog");
    expect(openRename).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openRename);

    const dialog = screen.getByRole("dialog", { name: "Rename workspace" });
    const name = within(dialog).getByRole("textbox", { name: "New workspace name" });
    const submit = within(dialog).getByRole("button", { name: "Rename workspace" });
    const attributes = within(dialog).getByRole("region", {
      name: "Workspace attributes",
    });
    expect(openRename).toHaveAttribute("aria-expanded", "true");
    expect(name).toHaveValue("Release command center");
    expect(name).toHaveFocus();
    expect(submit).toBeDisabled();
    expect(attributes).toHaveTextContent("Server saved");
    expect(attributes).toHaveTextContent("workspace-one");
    expect(attributes).toHaveTextContent("Session tabs2");
    expect(attributes).toHaveTextContent("Tab groups0");
    expect(attributes).toHaveTextContent("Pane views0");
    expect(dialog).toHaveTextContent(
      "Its tabs, groups, links, notes, and activity history stay attached.",
    );

    fireEvent.change(name, { target: { value: "  Release train  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "workspace storage is temporarily unavailable",
    );
    expect(onRenameWorkspace).toHaveBeenLastCalledWith("Release train");
    expect(name).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Rename workspace" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Rename workspace" }))
        .not.toBeInTheDocument();
    });
    expect(onRenameWorkspace).toHaveBeenCalledTimes(2);
    expect(openRename).toHaveFocus();
  });

  it("keeps workspace rename out of the compact mobile navigation", () => {
    vi.stubGlobal("innerWidth", 390);
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          workspacePersistenceState: "saved",
          activeWorkspaceId: "workspace-one",
          workspaceName: "Release command center",
          onRenameWorkspace: vi.fn(),
        })}
      />,
    );

    expect(screen.queryByRole("button", {
      name: "Rename workspace Release command center",
    })).not.toBeInTheDocument();
  });

  it("exposes workspace rename from Overview on compact mobile layouts", () => {
    vi.stubGlobal("innerWidth", 390);
    const onCloseRecents = vi.fn();
    const view = render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: true,
          workspacePersistenceState: "saved",
          activeWorkspaceId: "workspace-one",
          workspaceName: "Release command center",
          onRenameWorkspace: vi.fn().mockResolvedValue(undefined),
          onCloseRecents,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onCloseRecents).toHaveBeenCalledOnce();
    view.rerender(
      <SessionWorkspaceNavigation
        {...navigationProps({
          recentsOpen: false,
          workspacePersistenceState: "saved",
          activeWorkspaceId: "workspace-one",
          workspaceName: "Release command center",
          onRenameWorkspace: vi.fn().mockResolvedValue(undefined),
          onCloseRecents,
        })}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Rename workspace" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Workspace attributes" }))
      .toHaveTextContent("workspace-one");
  });

  it("finds workspace rename through the desktop command palette", () => {
    render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          workspacePersistenceState: "saved",
          activeWorkspaceId: "workspace-one",
          workspaceName: "Release command center",
          onRenameWorkspace: vi.fn().mockResolvedValue(undefined),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const palette = screen.getByRole("dialog", { name: "Run a command" });
    fireEvent.change(within(palette).getByRole("combobox"), {
      target: { value: "workspace attr" },
    });
    fireEvent.click(within(palette).getByRole("option", {
      name: /Rename this workspace/,
    }));
    expect(screen.getByRole("dialog", { name: "Rename workspace" })).toBeVisible();
  });

  it.each([
    ["saved", "Workspace saved automatically", "Saved"],
    ["loading", "Opening saved workspace", "Opening"],
    [
      "limited",
      "Workspace tabs saved; tab groups are not stored by this server",
      "Tabs saved",
    ],
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
    [
      "limited",
      "Workspace tabs saved; tab groups are not stored by this server",
      "Saved workspace",
      "Tabs saved",
    ],
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
