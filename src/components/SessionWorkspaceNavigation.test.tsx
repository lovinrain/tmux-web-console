import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { Pane, Session } from "../types";
import { NEW_SESSION_PANEL_ID } from "./NewSessionScreen";
import {
  MOBILE_WORKSPACE_OVERVIEW_CONTROL_ID,
  SessionWorkspaceNavigation,
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

  it("provides roving keyboard focus, tab activation, closing, and a recent count", () => {
    const props = navigationProps({
      openSessions: ["alpha", "beta", "zulu"],
    });
    const view = render(<SessionWorkspaceNavigation {...props} />);

    expect(screen.getByRole("navigation", { name: "Session workspace" })).toHaveAttribute(
      "id",
      "muxdeck-session-tabs",
    );
    const alpha = screen.getByRole("tab", { name: "Alpha control, Needs input" });
    const beta = screen.getByRole("tab", { name: "beta, Working" });
    const zulu = screen.getByRole("tab", { name: "Zulu shell, Other" });
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
      expect(screen.queryByRole("button", { name: "Save workspace" }))
        .not.toBeInTheDocument();
      expect(within(screen.getByRole("dialog", { name: "Switch sessions" }))
        .queryByRole("button", { name: "Save" }))
        .not.toBeInTheDocument();
      expect(onSaveWorkspace).not.toHaveBeenCalled();
    },
  );

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
