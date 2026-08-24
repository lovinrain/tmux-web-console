import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  BASE_PATH,
  createWorkspace,
  getCommonWorkspaceQuickLinks,
  getSessionQuickLinks,
  getWorkspace,
  getWorkspaceQuickLinks,
  listSessions,
  terminateSession,
  updateWorkspaceActivity,
  type SavedWorkspace,
} from "./api";
import { App } from "./App";
import type { Session } from "./types";
import { searchWithoutWorkspaceTabs } from "./workspaceState";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    createWorkspace: vi.fn(),
    getCommonWorkspaceQuickLinks: vi.fn(),
    getSessionQuickLinks: vi.fn(),
    getWorkspace: vi.fn(),
    getWorkspaceQuickLinks: vi.fn(),
    listSessions: vi.fn(),
    terminateSession: vi.fn(),
    updateWorkspaceActivity: vi.fn(),
  };
});

const createWorkspaceMock = vi.mocked(createWorkspace);
const getCommonWorkspaceQuickLinksMock = vi.mocked(getCommonWorkspaceQuickLinks);
const getSessionQuickLinksMock = vi.mocked(getSessionQuickLinks);
const getWorkspaceMock = vi.mocked(getWorkspace);
const getWorkspaceQuickLinksMock = vi.mocked(getWorkspaceQuickLinks);
const listSessionsMock = vi.mocked(listSessions);
const terminateSessionMock = vi.mocked(terminateSession);
const updateWorkspaceActivityMock = vi.mocked(updateWorkspaceActivity);

let pendingNewSessionCompletion: ((session: string, sessionId?: string) => void) | null = null;
let reportSessionRename: (
  (
    previousName: string,
    nextName: string,
    sessionId: string,
    warnings?: readonly string[],
  ) => void
) | null = null;
let reportSessionTerminate: (
  ((
    sessionName: string,
    sessionId: string,
    sessionCreated: number,
    serverStarted: number,
    serverPid: number,
  ) => Promise<void>)
) | null = null;
let reportSessionCopy: (
  (sourceName: string, sessionName: string, sessionId: string) => void
) | null = null;
let reportKnownSessions: ((sessions: Session[]) => void) | null = null;
let openSessionFromDashboard: ((sessionName: string) => void) | null = null;
let openSavedWorkspaceFromDashboard: ((workspace: SavedWorkspace) => void) | null = null;
let reportSavedWorkspaceDeleted: ((workspaceId: string) => void) | null = null;
let reportSavedWorkspaceUpdated: ((workspace: SavedWorkspace) => void) | null = null;
let dashboardActiveWorkspaceId: string | null = null;
let dashboardMountCount = 0;
const originalSendBeaconDescriptor = Object.getOwnPropertyDescriptor(
  window.navigator,
  "sendBeacon",
);
const sendBeaconMock = vi.fn<Navigator["sendBeacon"]>();

vi.mock("./components/SessionDashboard", () => ({
  SessionDashboard: ({
    onOpen,
    onResumeWorkspace,
    workspaceReturnSession,
    workspaceTabCount,
    onOpenSnippets,
    onNewSession,
    onSessionsChange,
    onOpenSavedWorkspace,
    onSavedWorkspaceDeleted,
    onSavedWorkspaceUpdated,
    onSessionTerminated,
    activeWorkspaceId,
  }: {
    onOpen: (session: string) => void;
    onResumeWorkspace?: () => void;
    workspaceReturnSession?: string;
    workspaceTabCount?: number;
    onOpenSnippets: () => void;
    onNewSession: () => void;
    onSessionsChange?: (sessions: Session[]) => void;
    onOpenSavedWorkspace?: (workspace: SavedWorkspace) => void;
    onSavedWorkspaceDeleted?: (workspaceId: string) => void;
    onSavedWorkspaceUpdated?: (workspace: SavedWorkspace) => void;
    onSessionTerminated?: (
      sessionName: string,
      sessionId: string,
      sessionCreated: number,
      serverStarted: number,
      serverPid: number,
    ) => Promise<void>;
    activeWorkspaceId?: string | null;
  }) => {
    useEffect(() => {
      dashboardMountCount += 1;
    }, []);
    reportKnownSessions = onSessionsChange ?? null;
    openSessionFromDashboard = onOpen;
    openSavedWorkspaceFromDashboard = onOpenSavedWorkspace ?? null;
    reportSavedWorkspaceDeleted = onSavedWorkspaceDeleted ?? null;
    reportSavedWorkspaceUpdated = onSavedWorkspaceUpdated ?? null;
    reportSessionTerminate = onSessionTerminated ?? null;
    dashboardActiveWorkspaceId = activeWorkspaceId ?? null;
    return (
      <main aria-label="Dashboard" data-search={window.location.search}>
        <label className="search-field">
          Find a session
          <input aria-label="Find a session" />
        </label>
        <button type="button" onClick={() => onOpen("work/name #1")}>Open test session</button>
        <button type="button" onClick={() => onOpen("second work")}>Open second session</button>
        <button type="button" onClick={() => onOpen("alpha")}>Open alpha session</button>
        {onResumeWorkspace && workspaceReturnSession && (
          <button
            type="button"
            onClick={onResumeWorkspace}
            aria-label={`Resume workspace at ${workspaceReturnSession}, ${workspaceTabCount} open tabs`}
          >
            Resume workspace
          </button>
        )}
        <button type="button" onClick={onOpenSnippets}>Open snippets</button>
        <button type="button" onClick={onNewSession}>New session</button>
        {onSessionTerminated && (
          <button
            type="button"
            onClick={() => void onSessionTerminated("dashboard", "$dashboard", 4, 10, 100)}
          >
            Terminate dashboard session
          </button>
        )}
        <a href={`${BASE_PATH}/sessions/new${searchWithoutWorkspaceTabs(window.location.search)}`} target="_blank" rel="noopener noreferrer">
          New session in new window
        </a>
      </main>
    );
  },
}));

vi.mock("./components/NewSessionScreen", () => ({
  NEW_SESSION_PANEL_ID: "muxdeck-new-session",
  NewSessionScreen: ({
    onCreated,
    onCancel,
    sessionNavigation,
    workspaceLoading,
  }: {
    onCreated: (session: string, sessionId: string) => void;
    onCancel: () => void;
    sessionNavigation?: ReactNode;
    workspaceLoading?: boolean;
  }) => {
    pendingNewSessionCompletion = (session, sessionId = "$created") => {
      onCreated(session, sessionId);
    };
    return (
      <main aria-label="New session view">
        {sessionNavigation}
        <button
          type="button"
          disabled={workspaceLoading}
          onClick={() => onCreated("fresh/session", "$fresh")}
        >
          Create test session
        </button>
        <button type="button" onClick={onCancel}>Cancel new session</button>
      </main>
    );
  },
}));

vi.mock("./components/ConsoleScreen", () => ({
  DEFAULT_CONSOLE_BAR_VISIBILITY: {
    sessionTabs: true,
    stagedInput: true,
    shortcuts: true,
  },
  ConsoleScreen: ({
    sessionName,
    workspaceName,
    workspaceLinks,
    onBack,
    sessionNavigation,
    workspaceOverlayOpen,
    mobileMode,
    onMobileModeChange,
    onOpenWorkspaceOverview,
    onCloseWorkspaceOverview,
    barVisibility,
    onBarVisibilityChange,
    desktopTabOrientation,
    onDesktopTabOrientationChange,
    tabActionsVisible,
    onTabActionsVisibilityChange,
    desktopTabRailWidth,
    onDesktopTabRailWidthChange,
    onSessionsChange,
    onSessionRenamed,
    onSessionTerminated,
    onSessionCopied,
    renameWarning,
    onDismissRenameWarning,
  }: {
    sessionName: string;
    workspaceName?: string | null;
    workspaceLinks?: ReactNode;
    onBack: () => void;
    sessionNavigation?: ReactNode;
    workspaceOverlayOpen?: boolean;
    mobileMode: "terminal" | "input";
    onMobileModeChange: (mode: "terminal" | "input") => void;
    onOpenWorkspaceOverview?: () => void;
    onCloseWorkspaceOverview?: () => void;
    barVisibility: {
      sessionTabs: boolean;
      stagedInput: boolean;
      shortcuts: boolean;
    };
    onBarVisibilityChange: (
      bar: "sessionTabs" | "stagedInput" | "shortcuts",
      visible: boolean,
    ) => void;
    desktopTabOrientation: "horizontal" | "vertical";
    onDesktopTabOrientationChange: (orientation: "horizontal" | "vertical") => void;
    tabActionsVisible: boolean;
    onTabActionsVisibilityChange: (visible: boolean) => void;
    desktopTabRailWidth: number;
    onDesktopTabRailWidthChange: (width: number) => void;
    onSessionsChange?: (sessions: Session[]) => void;
    onSessionRenamed?: (
      previousName: string,
      nextName: string,
      sessionId: string,
      warnings?: readonly string[],
    ) => void;
    onSessionTerminated?: (
      sessionName: string,
      sessionId: string,
      sessionCreated: number,
      serverStarted: number,
      serverPid: number,
    ) => Promise<void>;
    onSessionCopied?: (
      sourceName: string,
      sessionName: string,
      sessionId: string,
    ) => void;
    renameWarning?: {
      sessionId: string;
      sessionName: string;
      messages: string[];
    } | null;
    onDismissRenameWarning?: (sessionId: string) => void;
  }) => {
    reportKnownSessions = onSessionsChange ?? null;
    reportSessionRename = onSessionRenamed ?? null;
    reportSessionTerminate = onSessionTerminated ?? null;
    reportSessionCopy = onSessionCopied ?? null;
    const bars = [
      ["sessionTabs", "Session tabs", "muxdeck-session-tabs"],
      ["stagedInput", "Staged input", "muxdeck-staged-input"],
      ["shortcuts", "Terminal shortcut buttons", "muxdeck-terminal-shortcuts"],
    ] as const;
    return (
      <main
        aria-label="Console"
        data-session={sessionName}
        data-workspace-name={workspaceName ?? ""}
        data-tab-orientation={desktopTabOrientation}
        data-tab-actions-visible={tabActionsVisible}
        data-tab-rail-width={desktopTabRailWidth}
      >
        <nav aria-label="Mobile console focus">
          <button
            type="button"
            aria-pressed={Boolean(workspaceOverlayOpen)}
            onClick={onOpenWorkspaceOverview}
          >
            Overview
          </button>
          <button
            type="button"
            aria-pressed={!workspaceOverlayOpen && mobileMode === "terminal"}
            onClick={() => {
              onCloseWorkspaceOverview?.();
              onMobileModeChange("terminal");
            }}
          >
            Terminal
          </button>
          <button
            type="button"
            aria-pressed={!workspaceOverlayOpen && mobileMode === "input"}
            onClick={() => {
              onCloseWorkspaceOverview?.();
              onMobileModeChange("input");
            }}
          >
            Input
          </button>
        </nav>
        <div className="console-bar-toolbar" role="group" aria-label="Console bars">
          {workspaceLinks}
          {bars.map(([bar, label, controls]) => (
            <button
              key={bar}
              type="button"
              aria-label={label}
              aria-pressed={barVisibility[bar]}
              aria-controls={controls}
              onClick={() => onBarVisibilityChange(bar, !barVisibility[bar])}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Desktop tab orientation">
          <button
            type="button"
            aria-pressed={desktopTabOrientation === "horizontal"}
            onClick={() => onDesktopTabOrientationChange("horizontal")}
          >
            Horizontal tabs
          </button>
          <button
            type="button"
            aria-pressed={desktopTabOrientation === "vertical"}
            onClick={() => onDesktopTabOrientationChange("vertical")}
          >
            Vertical tabs
          </button>
        </div>
        <button
          type="button"
          aria-label="Tab action buttons"
          aria-pressed={tabActionsVisible}
          onClick={() => onTabActionsVisibilityChange(!tabActionsVisible)}
        >
          Actions
        </button>
        <label>
          Desktop tab rail width
          <input
            type="range"
            min="0"
            max="1000"
            value={desktopTabRailWidth}
            onChange={(event) => onDesktopTabRailWidthChange(Number(event.target.value))}
          />
        </label>
        {sessionNavigation}
        <section id="muxdeck-staged-input" hidden={!barVisibility.stagedInput}>
          Staged input surface
        </section>
        <div id="muxdeck-terminal-shortcuts" hidden={!barVisibility.shortcuts}>
          Terminal shortcut surface
        </div>
        {renameWarning && (
          <aside role="status">
            <strong>Tmux session renamed with warnings</strong>
            {renameWarning.messages.map((warning) => <p key={warning}>{warning}</p>)}
            <button
              type="button"
              onClick={() => onDismissRenameWarning?.(renameWarning.sessionId)}
            >
              Dismiss rename warning
            </button>
          </aside>
        )}
        <button type="button" onClick={onBack}>Back to sessions</button>
        {onSessionCopied && (
          <button
            type="button"
            onClick={() => onSessionCopied(sessionName, `${sessionName}_1`, "$copy")}
          >
            Copy New
          </button>
        )}
      </main>
    );
  },
}));

vi.mock("./components/SnippetLibrary", () => ({
  SnippetLibrary: ({ onOpenSessions }: { onOpenSessions: () => void }) => (
    <main aria-label="Snippets">
      <button type="button" onClick={onOpenSessions}>Open sessions</button>
    </main>
  ),
}));

function dashboardUrl(search = ""): string {
  return `${BASE_PATH}/${search}`;
}

function sessionUrl(encodedName: string, search = ""): string {
  return `${BASE_PATH}/session/${encodedName}${search}`;
}

function replaceUrl(url: string): void {
  window.history.replaceState({}, "", url);
}

function openTabs(): string[] {
  return new URLSearchParams(window.location.search).getAll("tab");
}

function urlGroups(): unknown[] {
  return new URLSearchParams(window.location.search)
    .getAll("tab-group")
    .map((value) => JSON.parse(value));
}

function expectWorkspaceSearch(baseSearch: string, tabs: string[]): void {
  expect(searchWithoutWorkspaceTabs(window.location.search)).toBe(baseSearch);
  expect(openTabs()).toEqual(tabs);
}

function renderedTabs(): string[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent || "");
}

function historySessionBindings(): {
  route?: { name: string; sessionId?: string };
  tabs: Array<{ name: string; sessionId?: string }>;
} | undefined {
  return (window.history.state as {
    muxdeckSessionBindings?: {
      route?: { name: string; sessionId?: string };
      tabs: Array<{ name: string; sessionId?: string }>;
    };
  } | null)?.muxdeckSessionBindings;
}

function session(
  name: string,
  id: string,
  created = 1,
  serverStarted = 10,
  serverPid = 100,
): Session {
  return {
    name,
    id,
    windows: 1,
    attached: 0,
    created,
    serverStarted,
    serverPid,
    activity: 1,
    activePaneId: null,
    agentState: "other",
    agentStateReason: "Test session",
    agentStateChangedAt: 1,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [],
  };
}

function savedWorkspace(
  overrides: Partial<SavedWorkspace> = {},
): SavedWorkspace {
  return {
    id: "workspace-one",
    name: "Workspace one",
    tabs: ["alpha", "beta"],
    groups: [],
    activeSession: "alpha",
    sessionRevision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastActiveAt: 1_000,
    ...overrides,
  };
}

const coreGroup = {
  id: "core",
  name: "Core work",
  color: "cyan" as const,
  collapsed: false,
  tabs: ["alpha", "beta"],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
}

describe("App routing", () => {
  beforeEach(() => {
    createWorkspaceMock.mockReset();
    getCommonWorkspaceQuickLinksMock.mockReset();
    getSessionQuickLinksMock.mockReset();
    getWorkspaceMock.mockReset();
    getWorkspaceQuickLinksMock.mockReset();
    listSessionsMock.mockReset();
    terminateSessionMock.mockReset();
    updateWorkspaceActivityMock.mockReset();
    createWorkspaceMock.mockResolvedValue(savedWorkspace());
    getCommonWorkspaceQuickLinksMock.mockResolvedValue([]);
    getSessionQuickLinksMock.mockResolvedValue([]);
    getWorkspaceMock.mockResolvedValue(savedWorkspace());
    getWorkspaceQuickLinksMock.mockResolvedValue([]);
    listSessionsMock.mockResolvedValue([]);
    terminateSessionMock.mockResolvedValue(undefined);
    updateWorkspaceActivityMock.mockResolvedValue(savedWorkspace());
    pendingNewSessionCompletion = null;
    reportSessionRename = null;
    reportSessionTerminate = null;
    reportSessionCopy = null;
    reportKnownSessions = null;
    openSessionFromDashboard = null;
    openSavedWorkspaceFromDashboard = null;
    reportSavedWorkspaceDeleted = null;
    reportSavedWorkspaceUpdated = null;
    dashboardActiveWorkspaceId = null;
    dashboardMountCount = 0;
    sendBeaconMock.mockReset();
    sendBeaconMock.mockReturnValue(true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeaconMock,
    });
    window.localStorage.clear();
    replaceUrl(dashboardUrl());
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSendBeaconDescriptor) {
      Object.defineProperty(
        window.navigator,
        "sendBeacon",
        originalSendBeaconDescriptor,
      );
    } else {
      Reflect.deleteProperty(window.navigator, "sendBeacon");
    }
  });

  it("preserves dashboard query state when opening a session and using application Back", async () => {
    const search = "?kind=claude&state=working&sort=state&sort=title";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute("data-search", search);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /work\/name #1/ })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expectWorkspaceSearch(search, ["work/name #1"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/`);
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        `${search}&tab=work%2Fname%20%231`,
      );
    });
    expectWorkspaceSearch(search, ["work/name #1"]);
  });

  it("opens a routed creation tab, preserves ordered tabs, and replaces it with the created session", async () => {
    const search = "?kind=codex&tab=alpha&tab=beta";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    const newWindow = screen.getByRole("link", { name: "New session in new window" });
    expect(newWindow).toHaveAttribute(
      "href",
      `${BASE_PATH}/sessions/new?kind=codex`,
    );
    expect(newWindow).toHaveAttribute("target", "_blank");
    expect(newWindow).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(screen.getByRole("main", { name: "New session view" })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
    expectWorkspaceSearch("?kind=codex", ["alpha", "beta"]);
    expect(renderedTabs()).toEqual(["alpha", "beta", "New session"]);
    expect(screen.getByRole("tab", { name: /New session/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Create test session" }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "fresh/session",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/fresh%2Fsession`);
    expectWorkspaceSearch("?kind=codex", ["alpha", "beta", "fresh/session"]);
    expect(renderedTabs()).toEqual(["alpha", "beta", "fresh/session"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });
    expectWorkspaceSearch("?kind=codex", ["alpha", "beta", "fresh/session"]);
  });

  it("appends a copied session and focuses it when the source console is active", () => {
    replaceUrl(sessionUrl("alpha", "?kind=codex&tab=alpha&tab=beta"));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Copy New" }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha_1",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha_1`);
    expectWorkspaceSearch("?kind=codex", ["alpha", "beta", "alpha_1"]);
    expect(renderedTabs()).toEqual(["alpha", "beta", "alpha_1"]);
    expect(screen.getByRole("tab", { name: /alpha_1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(historySessionBindings()?.route).toEqual({
      name: "alpha_1",
      sessionId: "$copy",
    });
  });

  it("keeps a late copied session without stealing focus from another tab", () => {
    replaceUrl(sessionUrl("alpha", "?tab=alpha&tab=beta"));
    render(<App />);
    const completeCopy = reportSessionCopy;
    expect(completeCopy).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    act(() => completeCopy?.("alpha", "alpha_1", "$copy"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
    expectWorkspaceSearch("", ["alpha", "beta", "alpha_1"]);
  });

  it("opens New session as a tab switch and returns to its saved-workspace source", async () => {
    getWorkspaceMock.mockResolvedValue(savedWorkspace({
      tabs: ["alpha", "beta"],
      activeSession: "alpha",
    }));
    listSessionsMock.mockResolvedValue([
      session("alpha", "$alpha"),
      session("beta", "$beta"),
    ]);
    replaceUrl(sessionUrl(
      "alpha",
      "?kind=codex&workspace=workspace-one&tab=stale-url-tab",
    ));

    render(<App />);
    await screen.findByRole("status", { name: "Workspace saved automatically" });
    const historyLength = window.history.length;

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
    expectWorkspaceSearch("?kind=codex&workspace=workspace-one", ["alpha", "beta"]);
    expect(window.history.length).toBe(historyLength);
    expect(screen.getByRole("tab", { name: /New session/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "New session" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel new session" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("?kind=codex&workspace=workspace-one", ["alpha", "beta"]);
    expect(window.history.length).toBe(historyLength);
    await waitFor(() => expect(screen.getByRole("tab", { name: /alpha/ })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Close New session tab" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("?kind=codex&workspace=workspace-one", ["alpha", "beta"]);
    expect(window.history.length).toBe(historyLength);
    await waitFor(() => expect(screen.getByRole("tab", { name: /alpha/ })).toHaveFocus());
  });

  it("keeps the landing-page Back target after creating from the tab bar", async () => {
    replaceUrl(dashboardUrl("?kind=shells&tab=alpha"));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const historyLength = window.history.length;

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
    expect(window.history.length).toBe(historyLength);
    fireEvent.click(screen.getByRole("button", { name: "Create test session" }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "fresh/session",
    );
    expectWorkspaceSearch("?kind=shells", ["alpha", "fresh/session"]);
    expect(window.history.length).toBe(historyLength);

    fireEvent.click(screen.getByRole("button", { name: "All sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("?kind=shells", ["alpha", "fresh/session"]);
  });

  it("collapses tab-bar New session and Recents before returning to the landing page", async () => {
    replaceUrl(dashboardUrl("?state=working&tab=alpha"));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new/recents`);

    fireEvent.click(screen.getByRole("button", { name: "Create test session" }));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "fresh/session",
      );
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/fresh%2Fsession`);
    expectWorkspaceSearch("?state=working", ["alpha", "fresh/session"]);
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All sessions" }));
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("?state=working", ["alpha", "fresh/session"]);
  });

  it("syncs a saved workspace only after tab-bar creation succeeds", async () => {
    vi.useFakeTimers();
    const loaded = savedWorkspace({
      tabs: ["alpha", "beta"],
      activeSession: "alpha",
      sessionRevision: 5,
    });
    getWorkspaceMock.mockResolvedValue(loaded);
    listSessionsMock.mockResolvedValue([
      session("alpha", "$alpha"),
      session("beta", "$beta"),
    ]);
    updateWorkspaceActivityMock.mockResolvedValue({
      ...loaded,
      tabs: ["alpha", "beta", "fresh/session"],
      activeSession: "fresh/session",
    });
    replaceUrl(sessionUrl("alpha", "?workspace=workspace-one&tab=stale"));

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
      "workspace-one",
      ["alpha", "beta"],
      [],
      "alpha",
      5,
    );
    updateWorkspaceActivityMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel new session" }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Create test session" }));
    await act(async () => vi.advanceTimersByTimeAsync(400));

    expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
    expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
      "workspace-one",
      ["alpha", "beta", "fresh/session"],
      [],
      "fresh/session",
      5,
    );
  });

  it("restores a direct creation route and can switch to an existing real tab", () => {
    replaceUrl(`${BASE_PATH}/sessions/new?state=working&tab=alpha&tab=beta`);
    render(<App />);

    expect(screen.getByRole("main", { name: "New session view" })).toBeVisible();
    expect(renderedTabs()).toEqual(["alpha", "beta", "New session"]);
    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("?state=working", ["alpha", "beta"]);
    expect(renderedTabs()).toEqual(["alpha", "beta"]);
  });

  it("keeps the creation view addressable while its Recents sheet opens and closes", () => {
    replaceUrl(`${BASE_PATH}/sessions/new/recents?tab=alpha`);
    render(<App />);

    expect(screen.getByRole("main", { name: "New session view" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new/recents`);
    expectWorkspaceSearch("", ["alpha"]);

    fireEvent.click(screen.getByRole("button", { name: "Close session switcher" }));

    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
    expectWorkspaceSearch("", ["alpha"]);
    expect(screen.getByRole("tab", { name: /New session/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("appends a late creation result without pulling the user away from another session", async () => {
    replaceUrl(`${BASE_PATH}/?tab=alpha`);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeCreation = pendingNewSessionCompletion;
    expect(completeCreation).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    act(() => completeCreation?.("muxdeck-late"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["alpha", "muxdeck-late"]);
    expect(renderedTabs()).toEqual(["alpha", "muxdeck-late"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", {
      name: "Resume workspace at alpha, 2 open tabs",
    }));
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
  });

  it("keeps a late creation result while Back to sessions is pending", async () => {
    replaceUrl(`${BASE_PATH}/?tab=alpha`);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeCreation = pendingNewSessionCompletion;
    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    act(() => completeCreation?.("muxdeck-during-back"));

    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("", ["alpha", "muxdeck-during-back"]);
  });

  it("keeps an older creation result from replacing a newer creation view", async () => {
    replaceUrl(`${BASE_PATH}/?tab=alpha`);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeOlderCreation = pendingNewSessionCompletion;
    expect(completeOlderCreation).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeNewerCreation = pendingNewSessionCompletion;
    expect(completeNewerCreation).not.toBe(completeOlderCreation);

    act(() => {
      completeOlderCreation?.("muxdeck-older");
      completeNewerCreation?.("muxdeck-newer");
    });

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "muxdeck-newer",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/muxdeck-newer`);
    expectWorkspaceSearch("", ["alpha", "muxdeck-older", "muxdeck-newer"]);
    expect(renderedTabs()).toEqual(["alpha", "muxdeck-older", "muxdeck-newer"]);
  });

  it("keeps a late older result when the newer creation finishes from Recents", async () => {
    replaceUrl(`${BASE_PATH}/?tab=alpha`);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeOlderCreation = pendingNewSessionCompletion;

    fireEvent.click(screen.getByRole("tab", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeNewerCreation = pendingNewSessionCompletion;
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));

    act(() => {
      completeNewerCreation?.("muxdeck-newer");
      completeOlderCreation?.("muxdeck-older");
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/muxdeck-newer`);
    });
    expectWorkspaceSearch("", ["alpha", "muxdeck-newer", "muxdeck-older"]);
    expect(renderedTabs()).toEqual(["alpha", "muxdeck-newer", "muxdeck-older"]);
  });

  it("collapses the creation and Recents entries when creation finishes in the sheet", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeCreation = pendingNewSessionCompletion;
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new/recents`);

    act(() => completeCreation?.("muxdeck-from-recents"));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "muxdeck-from-recents",
      );
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/muxdeck-from-recents`);
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("", ["muxdeck-from-recents"]);
  });

  it("replaces a direct creation entry after its pushed Recents sheet completes", async () => {
    replaceUrl(`${BASE_PATH}/sessions/new?tab=alpha`);
    render(<App />);
    const completeCreation = pendingNewSessionCompletion;
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));

    act(() => completeCreation?.("muxdeck-direct"));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/muxdeck-direct`);
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "muxdeck-direct",
    );
    expectWorkspaceSearch("", ["alpha", "muxdeck-direct"]);
  });

  it("removes tab-bar New session from Back history after selecting from Recents", async () => {
    replaceUrl(dashboardUrl("?origin=before-direct"));
    window.history.pushState(
      {},
      "",
      sessionUrl("alpha", "?kind=shells&tab=alpha&tab=beta"),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    const recents = screen.getByRole("dialog", { name: "Switch sessions" });
    const betaRow = recents.querySelector<HTMLElement>(
      '[data-workspace-session-name="beta"]',
    );
    const selectBeta = betaRow?.querySelector<HTMLButtonElement>(
      ".workspace-session-select",
    );
    if (!selectBeta) throw new Error("Expected beta in the session switcher");
    fireEvent.click(selectBeta);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "beta",
      );
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
    expectWorkspaceSearch("?kind=shells", ["alpha", "beta"]);

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
  });

  it("replaces a directly opened session deep link with the dashboard fallback", () => {
    const search = "?kind=codex&sort=title";
    replaceUrl(sessionUrl("direct%20work", search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /direct work/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch(search, ["direct work"]);
    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
      "data-search",
      `${search}&tab=direct%20work`,
    );
  });

  it("rewrites an active renamed session and its exact ordered URL tabs", () => {
    const renamed = "renamed/name #1";
    replaceUrl(sessionUrl(
      "alpha",
      "?kind=codex&raw=%2f%2F&flag&tab=zeta&tab=alpha&tab=omega&sort=title",
    ));
    render(<App />);
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", renamed, "$alpha"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      renamed,
    );
    expect(window.location.pathname).toBe(
      `${BASE_PATH}/session/renamed%2Fname%20%231`,
    );
    expect(window.location.search).toBe(
      "?kind=codex&raw=%2f%2F&flag&sort=title"
      + "&tab=zeta&tab=renamed%2Fname%20%231&tab=omega",
    );
    expectWorkspaceSearch(
      "?kind=codex&raw=%2f%2F&flag&sort=title",
      ["zeta", renamed, "omega"],
    );
    expect(renderedTabs()).toEqual(["zeta", renamed, "omega"]);
  });

  it("opens a newly created session that reuses a name renamed earlier in the page", async () => {
    replaceUrl(sessionUrl("alpha"));
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", "bravo", "$id1"));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const completeCreation = pendingNewSessionCompletion;
    expect(completeCreation).not.toBeNull();

    act(() => completeCreation?.("alpha", "$id2"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    expect(historySessionBindings()).toEqual({
      route: { name: "alpha", sessionId: "$id2" },
      tabs: [
        { name: "bravo", sessionId: "$id1" },
        { name: "alpha", sessionId: "$id2" },
      ],
    });
  });

  it("canonicalizes renamed tabs in old browser-history entries on Back and Forward", async () => {
    const renamed = "renamed work";
    const dashboardSearch = "?kind=shells&flag&tab=stale";
    replaceUrl(dashboardUrl(dashboardSearch));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();
    act(() => completeRename?.("work/name #1", renamed, "$work"));

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/renamed%20work`);
    expectWorkspaceSearch("?kind=shells&flag", ["stale", renamed]);

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expect(window.location.search).toBe(
      "?kind=shells&flag&tab=stale&tab=renamed%20work",
    );
    expectWorkspaceSearch("?kind=shells&flag", ["stale", renamed]);

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        renamed,
      );
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/renamed%20work`);
    expectWorkspaceSearch("?kind=shells&flag", ["stale", renamed]);
  });

  it("reconciles a stale old-name snapshot by stable id and keeps the fresh snapshot canonical", () => {
    replaceUrl(sessionUrl("alpha", "?view=list&tab=alpha&tab=omega"));
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", "bravo", "$id1"));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expectWorkspaceSearch("?view=list", ["bravo", "omega"]);

    // Emulate an old history entry becoming current without a popstate. The stale
    // snapshot itself must trigger canonicalization using its stable session id.
    act(() => {
      window.history.replaceState(
        {},
        "",
        sessionUrl("alpha", "?view=list&tab=alpha&tab=omega"),
      );
      reportKnownSessions?.([session("alpha", "$id1")]);
    });

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expectWorkspaceSearch("?view=list", ["bravo", "omega"]);
    expect(renderedTabs()).toEqual(["bravo", "omega"]);

    act(() => reportKnownSessions?.([session("bravo", "$id1")]));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expectWorkspaceSearch("?view=list", ["bravo", "omega"]);
  });

  it("retains a late rename warning after the console unmounts and dismisses it on return", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    act(() => completeRename?.(
      "alpha",
      "bravo",
      "$id1",
      ["Queued memoranda could not be migrated."],
    ));

    act(() => window.history.forward());
    const warningHeading = await screen.findByText("Tmux session renamed with warnings");
    const warning = warningHeading.closest("aside");
    expect(warning).not.toBeNull();
    if (!warning) throw new Error("Rename warning container was not rendered");
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expect(warning).toHaveTextContent("Tmux session renamed with warnings");
    expect(warning).toHaveTextContent("Queued memoranda could not be migrated.");

    fireEvent.click(within(warning).getByRole("button", {
      name: "Dismiss rename warning",
    }));
    expect(screen.queryByText("Tmux session renamed with warnings")).not.toBeInTheDocument();
  });

  it("handles chained renames that return from A to B to A without an alias cycle", async () => {
    replaceUrl(sessionUrl("alpha", "?keep=1&tab=alpha&tab=omega"));
    render(<App />);
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", "bravo", "$alpha"));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expectWorkspaceSearch("?keep=1", ["bravo", "omega"]);

    act(() => completeRename?.("bravo", "alpha", "$alpha"));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("?keep=1", ["alpha", "omega"]);
    expect(renderedTabs()).toEqual(["alpha", "omega"]);

    act(() => {
      window.history.pushState(
        {},
        "",
        sessionUrl("bravo", "?keep=1&tab=bravo&tab=omega"),
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    });
    expectWorkspaceSearch("?keep=1", ["alpha", "omega"]);
  });

  it("applies a late rename without pulling focus from the newly active session", () => {
    replaceUrl(sessionUrl("alpha", "?kind=agents&tab=alpha&tab=beta"));
    render(<App />);
    const completeAlphaRename = reportSessionRename;
    expect(completeAlphaRename).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    act(() => completeAlphaRename?.("alpha", "alpha renamed", "$alpha"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
    expectWorkspaceSearch("?kind=agents", ["alpha renamed", "beta"]);
    expect(renderedTabs()).toEqual(["alpha renamed", "beta"]);
    expect(screen.getByRole("tab", { name: /beta/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("preserves the Recents suffix when the active session is renamed", () => {
    replaceUrl(
      `${BASE_PATH}/session/alpha/recents`
      + "?state=working&tab=alpha&tab=beta",
    );
    render(<App />);
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();

    act(() => completeRename?.("alpha", "renamed/alpha", "$alpha"));

    expect(window.location.pathname).toBe(
      `${BASE_PATH}/session/renamed%2Falpha/recents`,
    );
    expect(window.location.search).toBe(
      "?state=working&tab=renamed%2Falpha&tab=beta",
    );
    expectWorkspaceSearch("?state=working", ["renamed/alpha", "beta"]);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "renamed/alpha",
    );
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
  });

  it("opens a newly reused native name instead of following another session's alias", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", "bravo", "$id1"));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/bravo`);
    expectWorkspaceSearch("", ["bravo"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    expect(renderedTabs()).toEqual(["bravo", "alpha"]);
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
  });

  it("uses history-bound ids when a native name is reused before the first Back", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();

    act(() => completeRename?.("alpha", "bravo", "$id1"));
    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("", ["bravo"]);
    expect(historySessionBindings()).toEqual({
      tabs: [{ name: "bravo", sessionId: "$id1" }],
    });

    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "bravo",
    ));
    expectWorkspaceSearch("", ["bravo"]);
    expect(historySessionBindings()).toEqual({
      route: { name: "bravo", sessionId: "$id1" },
      tabs: [{ name: "bravo", sessionId: "$id1" }],
    });

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    expect(historySessionBindings()).toEqual({
      route: { name: "alpha", sessionId: "$id2" },
      tabs: [
        { name: "bravo", sessionId: "$id1" },
        { name: "alpha", sessionId: "$id2" },
      ],
    });

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    ));
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    expect(historySessionBindings()?.route).toEqual({ name: "alpha", sessionId: "$id2" });
  });

  it("rejects a late pre-rename snapshot without erasing a reused-name route", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();
    act(() => completeRename?.("alpha", "bravo", "$id1"));

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    expectWorkspaceSearch("", ["bravo", "alpha"]);

    act(() => reportKnownSessions?.([session("alpha", "$id1")]));

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
    expect(renderedTabs()).toEqual(["bravo", "alpha"]);
    expect(historySessionBindings()).toEqual({
      route: { name: "alpha", sessionId: "$id2" },
      tabs: [
        { name: "bravo", sessionId: "$id1" },
        { name: "alpha", sessionId: "$id2" },
      ],
    });

    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["bravo", "alpha"]);
  });

  it("routes a reused name's own rename by stable id when old aliases are ambiguous", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    let completeRename = reportSessionRename;
    expect(completeRename).not.toBeNull();
    act(() => completeRename?.("alpha", "bravo", "$id1"));

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    completeRename = reportSessionRename;

    act(() => completeRename?.("alpha", "charlie", "$id2"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "charlie",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/charlie`);
    expectWorkspaceSearch("", ["bravo", "charlie"]);
    expect(renderedTabs()).toEqual(["bravo", "charlie"]);
    expect(screen.queryByRole("tab", { name: /^alpha/ })).not.toBeInTheDocument();
  });

  it("does not let a late id1 rename completion rewrite a reused id2 view", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$id1")]));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    const completeId1Rename = reportSessionRename;
    expect(completeId1Rename).not.toBeNull();

    act(() => reportKnownSessions?.([
      session("bravo", "$id1"),
      session("alpha", "$id2"),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);

    act(() => completeId1Rename?.("alpha", "bravo", "$id1"));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["alpha"]);
    expect(renderedTabs()).toEqual(["alpha"]);
    expect(screen.queryByRole("tab", { name: /bravo/ })).not.toBeInTheDocument();
  });

  it("responds to query-only navigation and browser Back and Forward", async () => {
    const claudeSearch = "?kind=claude&sort=state&sort=title";
    const codexSearch = "?kind=codex&sort=title&sort=state";
    replaceUrl(dashboardUrl(claudeSearch));
    render(<App />);

    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
      "data-search",
      claudeSearch,
    );

    act(() => {
      window.history.pushState({}, "", dashboardUrl(codexSearch));
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
      "data-search",
      codexSearch,
    );

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        claudeSearch,
      );
    });

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        codexSearch,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute(
        "data-search",
        `${codexSearch}&tab=work%2Fname%20%231`,
      );
    });

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    });
    expectWorkspaceSearch(codexSearch, ["work/name #1"]);
  });

  it("does not remount the dashboard when its local filters update the URL", () => {
    render(<App />);
    expect(dashboardMountCount).toBe(1);

    act(() => {
      window.history.replaceState({}, "", dashboardUrl("?view=list"));
      reportKnownSessions?.([session("alpha", "$alpha")]);
    });

    expect(window.location.search).toBe("?view=list");
    expect(dashboardMountCount).toBe(1);
  });

  it("routes to snippets without leaking dashboard query keys and restores them on return", async () => {
    const search = "?kind=codex&view=list&sort=state,title";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));
    expect(screen.getByRole("main", { name: "Snippets" })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/snippets`);
    expectWorkspaceSearch("", ["work/name #1"]);

    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch(search, ["work/name #1"]);
  });

  it("opens a direct snippets deep link and returns to a clean dashboard", () => {
    replaceUrl(`${BASE_PATH}/snippets?ignored=1`);
    render(<App />);

    expect(screen.getByRole("main", { name: "Snippets" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    expect(window.location.href.endsWith(`${BASE_PATH}/`)).toBe(true);
  });

  it("keeps quick tabs, records closed visits, and switches without losing dashboard state", async () => {
    const search = "?kind=codex&view=list&sort=title,tmux-name";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "work/name #1",
    );
    expectWorkspaceSearch(search, ["work/name #1"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    expectWorkspaceSearch(search, ["work/name #1"]);

    fireEvent.click(screen.getByRole("button", { name: "Open second session" }));
    const firstTab = screen.getByRole("tab", { name: /work\/name #1/ });
    const secondTab = screen.getByRole("tab", { name: /second work/ });
    expect(firstTab).toHaveAttribute("aria-selected", "false");
    expect(secondTab).toHaveAttribute("aria-selected", "true");

    firstTab.focus();
    fireEvent.click(firstTab);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "work/name #1",
    );
    expect(firstTab).toHaveFocus();
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expectWorkspaceSearch(search, ["work/name #1", "second work"]);

    const recentsButton = screen.getByRole("button", { name: /Open session switcher/ });
    recentsButton.focus();
    const canonicalHistoryLength = window.history.length;
    fireEvent.click(recentsButton);
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231/recents`);
    expectWorkspaceSearch(search, ["work/name #1", "second work"]);
    expect(window.history.length).toBe(canonicalHistoryLength + 1);
    const switcher = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(switcher).getByRole("button", { name: "Close second work quick tab" }));

    expectWorkspaceSearch(search, ["work/name #1"]);
    expect(within(switcher).getByRole("heading", { name: "Recently visited" })).toBeVisible();
    fireEvent.click(within(switcher).getByRole("button", { name: /second work/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/second%20work`);
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "second work",
      );
    });
    expect(window.history.length).toBe(canonicalHistoryLength);
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open session switcher/ })).toHaveFocus();
    expectWorkspaceSearch(search, ["work/name #1", "second work"]);

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expectWorkspaceSearch(search, ["work/name #1", "second work"]);

    act(() => window.history.forward());
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "second work",
      );
    });
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();
    expectWorkspaceSearch(search, ["work/name #1", "second work"]);
  });

  it("switches desktop tabs with exact global shortcuts, including direct numbers from a composer", () => {
    const search = "?kind=agents";
    replaceUrl(sessionUrl(
      "beta",
      `${search}&tab=alpha&tab=beta&tab=gamma`,
    ));
    render(<App />);
    act(() => reportKnownSessions?.([
      session("alpha", "$alpha"),
      session("beta", "$beta"),
      session("gamma", "$gamma"),
    ]));

    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Test terminal composer");
    document.body.append(composer);
    composer.focus();

    for (const shiftKey of [false, true]) {
      const commentShortcut = new KeyboardEvent("keydown", {
        key: shiftKey ? "?" : "/",
        code: "Slash",
        ctrlKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      composer.dispatchEvent(commentShortcut);
      expect(commentShortcut.defaultPrevented).toBe(false);
    }
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );
    expect(screen.getByRole("tab", { name: /alpha/ }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+1");
    expect(screen.getByRole("tab", { name: /beta/ }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+2");
    expect(screen.getByRole("tab", { name: /gamma/ }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+3");

    // Keep the browser's ordinary Ctrl+number shortcut untouched.
    const browserNumberShortcut = new KeyboardEvent("keydown", {
      key: "3",
      code: "Digit3",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(browserNumberShortcut);
    expect(browserNumberShortcut.defaultPrevented).toBe(false);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    const directThirdTab = new KeyboardEvent("keydown", {
      key: "#",
      code: "Digit3",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => { composer.dispatchEvent(directThirdTab); });
    expect(directThirdTab.defaultPrevented).toBe(true);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "gamma",
    );
    expect(composer).toHaveFocus();

    // Number-pad digits follow the same positional mapping.
    fireEvent.keyDown(composer, {
      key: "2",
      code: "Numpad2",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    // A missing position is consumed so its shifted symbol never leaks into xterm.
    const missingNinthTab = new KeyboardEvent("keydown", {
      key: "(",
      code: "Digit9",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(missingNinthTab);
    expect(missingNinthTab.defaultPrevented).toBe(true);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    // Extra modifiers must not turn a nearby browser/editor chord into a tab switch.
    fireEvent.keyDown(composer, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    fireEvent.keyDown(composer, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(composer, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      keyCode: 229,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );

    fireEvent.keyDown(composer, {
      key: "<",
      code: "Comma",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(composer).toHaveFocus();

    // Previous and next wrap in URL order without changing the open-tab list.
    fireEvent.keyDown(window, {
      key: "<",
      code: "Comma",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "gamma",
    );
    fireEvent.keyDown(window, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expectWorkspaceSearch(search, ["alpha", "beta", "gamma"]);

    fireEvent.click(screen.getByRole("button", { name: "Session tabs" }));
    expect(document.getElementById("muxdeck-session-tabs")).not.toBeVisible();
    fireEvent.keyDown(window, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );
    expectWorkspaceSearch(search, ["alpha", "beta", "gamma"]);

    composer.remove();
  });

  it("keeps workspace tab shortcuts and group details out of the landing page", () => {
    const landingGroup = {
      ...coreGroup,
      name: "Hidden landing group",
    };
    replaceUrl(dashboardUrl(
      `?tab=alpha&tab=beta&tab-group=${encodeURIComponent(JSON.stringify(landingGroup))}`,
    ));
    render(<App />);
    act(() => reportKnownSessions?.([
      session("alpha", "$alpha"),
      session("beta", "$beta"),
    ]));

    const searchShortcut = new KeyboardEvent("keydown", {
      key: ":",
      code: "Semicolon",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(searchShortcut);
    expect(searchShortcut.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Jump to tab" }))
      .not.toBeInTheDocument();

    const directShortcut = new KeyboardEvent("keydown", {
      key: "@",
      code: "Digit2",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(directShortcut);
    expect(directShortcut.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expect(screen.queryByText("Hidden landing group")).not.toBeInTheDocument();

    const newSessionShortcut = new KeyboardEvent("keydown", {
      key: "B",
      code: "KeyB",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(newSessionShortcut);
    expect(newSessionShortcut.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
  });

  it("opens New session with the exact desktop workspace shortcut", () => {
    replaceUrl(sessionUrl("alpha", "?tab=alpha&tab=beta"));
    render(<App />);

    const newSessionButton = screen.getByRole("button", { name: "New session" });
    expect(newSessionButton).toHaveAttribute("aria-keyshortcuts", "Control+Shift+B");

    const extraModifier = new KeyboardEvent("keydown", {
      key: "B",
      code: "KeyB",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(extraModifier);
    expect(extraModifier.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);

    const shortcut = new KeyboardEvent("keydown", {
      key: "B",
      code: "KeyB",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(shortcut));

    expect(shortcut.defaultPrevented).toBe(true);
    expect(screen.getByRole("main", { name: "New session view" })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
    expectWorkspaceSearch("", ["alpha", "beta"]);

    const repeatedShortcut = new KeyboardEvent("keydown", {
      key: "B",
      code: "KeyB",
      ctrlKey: true,
      shiftKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(repeatedShortcut);
    expect(repeatedShortcut.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);
  });

  it("reorders tabs in the URL without changing the active route and remaps direct shortcuts", () => {
    const search = "?kind=agents&flag";
    replaceUrl(sessionUrl(
      "beta",
      `${search}&tab=alpha&tab=beta&tab=gamma`,
    ));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Move beta tab left" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "beta",
    );
    expectWorkspaceSearch(search, ["beta", "alpha", "gamma"]);
    expect(renderedTabs()).toEqual(["beta", "alpha", "gamma"]);
    expect(historySessionBindings()?.tabs.map((binding) => binding.name)).toEqual([
      "beta",
      "alpha",
      "gamma",
    ]);
    expect(screen.getByRole("tab", { name: /beta/ }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+1");
    expect(screen.getByRole("tab", { name: /alpha/ }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+2");

    fireEvent.keyDown(window, {
      key: "@",
      code: "Digit2",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch(search, ["beta", "alpha", "gamma"]);
  });

  it("copies a tab into an isolated browser workspace without changing the source", () => {
    const sessionName = "work/name #1";
    const sourceGroup = encodeURIComponent(JSON.stringify({
      id: "source-group",
      name: "Source group",
      color: "cyan",
      collapsed: false,
      tabs: [sessionName, "second work"],
    }));
    replaceUrl(sessionUrl(
      "work%2Fname%20%231",
      `?kind=agents&flag&tab=work%2Fname%20%231&tab=second%20work&tab-group=${sourceGroup}`,
    ));
    const sourceUrl = window.location.href;
    const replace = vi.fn();
    const close = vi.fn();
    const child = {
      opener: window,
      location: { replace },
      close,
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(child);

    render(<App />);
    fireEvent.click(screen.getByRole("button", {
      name: `Copy ${sessionName} tab to new window`,
    }));

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(child.opener).toBeNull();
    expect(replace).toHaveBeenCalledOnce();
    const destination = new URL(String(replace.mock.calls[0]?.[0]));
    expect(destination.origin).toBe(window.location.origin);
    expect(destination.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expect(destination.searchParams.get("kind")).toBe("agents");
    expect(destination.searchParams.has("flag")).toBe(true);
    expect(destination.searchParams.getAll("tab")).toEqual([sessionName]);
    expect(destination.searchParams.has("tab-group")).toBe(false);
    expect(destination.searchParams.has("workspace")).toBe(false);
    expect(window.location.href).toBe(sourceUrl);
    expect(renderedTabs()).toEqual([sessionName, "second work"]);
    expect(close).not.toHaveBeenCalled();
    expect(terminateSessionMock).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("moves a tab only after its isolated browser workspace opens", () => {
    replaceUrl(sessionUrl(
      "alpha",
      "?kind=agents&flag&tab=alpha&tab=beta",
    ));
    const replace = vi.fn();
    const child = {
      opener: window,
      location: { replace },
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(child);

    render(<App />);
    fireEvent.click(screen.getByRole("button", {
      name: "Move alpha tab to new window",
    }));

    expect(replace).toHaveBeenCalledOnce();
    const destination = new URL(String(replace.mock.calls[0]?.[0]));
    expect(destination.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expect(destination.searchParams.getAll("tab")).toEqual(["alpha"]);
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
    expectWorkspaceSearch("?kind=agents&flag", ["beta"]);
    expect(renderedTabs()).toEqual(["beta"]);
    expect(terminateSessionMock).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("focuses the dashboard search after moving the final source tab", async () => {
    replaceUrl(sessionUrl("alpha", "?kind=agents&tab=alpha"));
    const open = vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace: vi.fn() },
      close: vi.fn(),
    } as unknown as Window);

    render(<App />);
    fireEvent.click(screen.getByRole("button", {
      name: "Move alpha tab to new window",
    }));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("?kind=agents", []);
    expect(screen.getByRole("textbox", { name: "Find a session" })).toHaveFocus();
    expect(terminateSessionMock).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("keeps a moved tab in place when the browser blocks the new window", () => {
    replaceUrl(sessionUrl(
      "alpha",
      "?kind=agents&tab=alpha&tab=beta",
    ));
    const sourceUrl = window.location.href;
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(<App />);
    fireEvent.click(screen.getByRole("button", {
      name: "Move alpha tab to new window",
    }));

    expect(window.location.href).toBe(sourceUrl);
    expect(renderedTabs()).toEqual(["alpha", "beta"]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser blocked a new window for alpha. Allow pop-ups and try again.",
    );
    expect(terminateSessionMock).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("closes a partial child and keeps the source when child navigation fails", () => {
    replaceUrl(sessionUrl(
      "alpha",
      "?kind=agents&tab=alpha&tab=beta",
    ));
    const sourceUrl = window.location.href;
    const close = vi.fn();
    const child = {
      opener: window,
      location: {
        replace: vi.fn(() => {
          throw new DOMException("Navigation denied", "SecurityError");
        }),
      },
      close,
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(child);

    render(<App />);
    fireEvent.click(screen.getByRole("button", {
      name: "Move alpha tab to new window",
    }));

    expect(close).toHaveBeenCalledOnce();
    expect(window.location.href).toBe(sourceUrl);
    expect(renderedTabs()).toEqual(["alpha", "beta"]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Muxdeck could not open alpha in a new window. The source tab is unchanged. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss new window error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(terminateSessionMock).not.toHaveBeenCalled();

    open.mockRestore();
  });

  it("keeps a reordered workspace through native Back from Overview and the console", async () => {
    replaceUrl(dashboardUrl("?kind=agents&tab=alpha&tab=beta&tab=gamma"));
    render(<App />);

    fireEvent.click(screen.getByRole("button", {
      name: "Resume workspace at gamma, 3 open tabs",
    }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/gamma`);

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/gamma/recents`);
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Move beta tab up" }));
    expectWorkspaceSearch("?kind=agents", ["beta", "alpha", "gamma"]);

    act(() => window.history.back());
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/gamma`);
      expect(screen.queryByRole("dialog", { name: "Switch sessions" }))
        .not.toBeInTheDocument();
    });
    expectWorkspaceSearch("?kind=agents", ["beta", "alpha", "gamma"]);
    expect(renderedTabs()).toEqual(["beta", "alpha", "gamma"]);

    act(() => window.history.back());
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/`);
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });
    expectWorkspaceSearch("?kind=agents", ["beta", "alpha", "gamma"]);
  });

  it("searches only open tabs by display title or tmux name and jumps directly", () => {
    replaceUrl(sessionUrl(
      "alpha-native",
      "?tab=alpha-native&tab=alpha-native-helper",
    ));
    render(<App />);
    act(() => reportKnownSessions?.([
      { ...session("alpha-native", "$alpha"), customTitle: "Command deck" },
      {
        ...session("alpha-native-helper", "$beta"),
        customTitle: "Emerald release",
      },
      { ...session("outside-native", "$outside"), customTitle: "Outside only" },
    ]));

    const openSearch = screen.getByRole("button", { name: /Search open tabs/ });
    expect(openSearch).toHaveAttribute("aria-keyshortcuts", "Control+Shift+;");
    fireEvent.click(openSearch);

    let dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    let search = within(dialog).getByRole("combobox", {
      name: "Search open tabs by title or tmux name",
    });
    expect(within(dialog).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(search, { target: { value: "emerald" } });
    expect(within(dialog).getByRole("option")).toHaveTextContent("Emerald release");
    expect(within(dialog).queryByText("Outside only")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha-native-helper",
    );
    expect(screen.queryByRole("dialog", { name: "Jump to tab" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: ":",
      code: "Semicolon",
      ctrlKey: true,
      shiftKey: true,
    });
    dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    search = within(dialog).getByRole("combobox", {
      name: "Search open tabs by title or tmux name",
    });
    fireEvent.change(search, { target: { value: "alpha-native" } });
    expect(within(dialog).getByRole("option", {
      name: /Command deck/,
      selected: true,
    })).toHaveTextContent("alpha-native");
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha-native",
    );
    expectWorkspaceSearch("", ["alpha-native", "alpha-native-helper"]);

    fireEvent.click(screen.getByRole("button", { name: /Search open tabs/ }));
    dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    search = within(dialog).getByRole("combobox", {
      name: "Search open tabs by title or tmux name",
    });
    fireEvent.change(search, { target: { value: "outside only" } });
    expect(within(dialog).getByText("No matching open tabs")).toBeVisible();
    expect(within(dialog).queryByRole("option")).not.toBeInTheDocument();
  });

  it("suppresses global workspace shortcuts while an aria-modal dialog is open", () => {
    replaceUrl(sessionUrl(
      "alpha",
      "?tab=alpha&tab=beta",
    ));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toHaveAttribute(
      "aria-modal",
      "true",
    );

    fireEvent.keyDown(window, {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, {
      key: ":",
      code: "Semicolon",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Jump to tab" })).not.toBeInTheDocument();
    expectWorkspaceSearch("", ["alpha", "beta"]);
  });

  it("resumes the most-recent open tab from the dashboard without losing tab order", async () => {
    const search = "?kind=codex&view=list&sort=title,tmux-name";
    replaceUrl(
      dashboardUrl(
        `${search}&tab=work%2Fname%20%231&tab=second%20work&tab=alpha`,
      ),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open second session" }));
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "second work",
    );
    expectWorkspaceSearch(search, ["work/name #1", "second work", "alpha"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    const updatedSearch = "?kind=shells&view=cards&sort=activity,tmux-name";
    act(() => {
      window.history.replaceState(
        window.history.state,
        "",
        dashboardUrl(
          `${updatedSearch}&tab=work%2Fname%20%231&tab=second%20work&tab=alpha`,
        ),
      );
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: window.history.state,
      }));
    });
    const resume = screen.getByRole("button", {
      name: "Resume workspace at second work, 3 open tabs",
    });
    fireEvent.click(resume);

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "second work",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/second%20work`);
    expectWorkspaceSearch(updatedSearch, ["work/name #1", "second work", "alpha"]);
    expect(screen.getByRole("tab", { name: /second work/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    expectWorkspaceSearch(updatedSearch, ["work/name #1", "second work", "alpha"]);
  });

  it("resumes the final ordered tab from a directly loaded dashboard URL", () => {
    replaceUrl(`${BASE_PATH}/?kind=shells&tab=alpha&tab=second%20work`);
    render(<App />);

    fireEvent.click(screen.getByRole("button", {
      name: "Resume workspace at second work, 2 open tabs",
    }));

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "second work",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/second%20work`);
    expectWorkspaceSearch("?kind=shells", ["alpha", "second work"]);
  });

  it("returns from pushed Recents without creating a duplicate dashboard entry", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));

    fireEvent.click(screen.getByRole("button", { name: "Browse all" }));

    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expectWorkspaceSearch("", ["work/name #1"]);
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("main", { name: "Console" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expectWorkspaceSearch("", ["work/name #1"]);
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();
  });

  it("uses browser Back to close Recents and canonicalizes a direct Recents deep link", async () => {
    replaceUrl(sessionUrl("direct%20work", "?kind=shells"));
    const { unmount } = render(<App />);

    expectWorkspaceSearch("?kind=shells", ["direct work"]);
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/direct%20work/recents`);
    expectWorkspaceSearch("?kind=shells", ["direct work"]);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/direct%20work`);
    });
    expectWorkspaceSearch("?kind=shells", ["direct work"]);
    expect(screen.queryByRole("dialog", { name: "Switch sessions" })).not.toBeInTheDocument();

    unmount();
    replaceUrl(
      `${BASE_PATH}/session/direct%20work/recents`
      + "?kind=shells&tab=first%20work&tab=direct%20work",
    );
    render(<App />);
    expect(renderedTabs()).toEqual(["first work", "direct work"]);
    fireEvent.click(screen.getByRole("button", { name: "Close session switcher" }));

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/direct%20work`);
    expectWorkspaceSearch("?kind=shells", ["first work", "direct work"]);
  });

  it("uses browser Back when Recents reselects the already-active session", () => {
    replaceUrl(sessionUrl("direct%20work"));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const switcher = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(switcher).getByRole("button", {
      name: /direct work tmux session ended Active/i,
    }));

    expect(historyBack).toHaveBeenCalledOnce();
    historyBack.mockRestore();
  });

  it("chooses the neighboring tab when the active tab closes and returns to the dashboard after the last tab", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Open second session" }));

    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    let switcher = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(switcher).getByRole("button", { name: "Close second work quick tab" }));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "work/name #1",
      );
    });
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expectWorkspaceSearch("", ["work/name #1"]);

    fireEvent.click(screen.getByRole("button", { name: /Open session switcher/ }));
    switcher = screen.getByRole("dialog", { name: "Switch sessions" });
    fireEvent.click(within(switcher).getByRole("button", { name: "Close work/name #1 quick tab" }));

    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("", []);
  });

  it("terminates the exact active session and routes to the neighboring quick tab", async () => {
    replaceUrl(sessionUrl(
      "second%20work",
      "?kind=agents&tab=work%2Fname%20%231&tab=second%20work",
    ));
    render(<App />);
    act(() => reportKnownSessions?.([
      session("work/name #1", "$1"),
      session("second work", "$2"),
    ]));
    const terminate = reportSessionTerminate;
    expect(terminate).not.toBeNull();

    await act(async () => {
      await terminate?.("second work", "$2", 1, 10, 100);
    });

    expect(terminateSessionMock)
      .toHaveBeenCalledWith("second work", "$2", 1, 10, 100);
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "work/name #1",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);
    expectWorkspaceSearch("?kind=agents", ["work/name #1"]);
  });

  it("returns to the dashboard after terminating the last open quick tab", async () => {
    replaceUrl(sessionUrl("work%2Fname%20%231", "?q=review&tab=work%2Fname%20%231"));
    render(<App />);
    act(() => reportKnownSessions?.([session("work/name #1", "$1")]));
    const terminate = reportSessionTerminate;

    await act(async () => {
      await terminate?.("work/name #1", "$1", 1, 10, 100);
    });

    expect(terminateSessionMock)
      .toHaveBeenCalledWith("work/name #1", "$1", 1, 10, 100);
    expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    expectWorkspaceSearch("?q=review", []);
  });

  it("terminates an inactive session from its quick-tab icon without leaving the active tab", async () => {
    replaceUrl(sessionUrl("alpha", "?kind=agents&tab=alpha&tab=beta"));
    render(<App />);
    act(() => reportKnownSessions?.([
      session("alpha", "$alpha"),
      session("beta", "$beta", 2, 10, 100),
    ]));

    const terminateBeta = screen.getByRole("button", {
      name: "Terminate beta tmux session",
    });
    fireEvent.click(terminateBeta);
    expect(screen.getByRole("alertdialog", { name: "Terminate tmux session?" }))
      .toHaveTextContent("beta");
    expect(terminateSessionMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));

    await waitFor(() => {
      expect(terminateSessionMock).toHaveBeenCalledWith("beta", "$beta", 2, 10, 100);
      expect(screen.queryByRole("tab", { name: /beta/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      "alpha",
    );
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("?kind=agents", ["alpha"]);
    act(() => reportKnownSessions?.([
      session("alpha", "$alpha"),
      session("beta", "$beta", 2, 10, 100),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const overview = screen.getByRole("dialog", { name: "Switch sessions" });
    expect(within(overview).queryByRole("button", { name: "Terminate beta tmux session" }))
      .not.toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "Terminate alpha tmux session" }))
      .toBeVisible();
  });

  it("moves focus to Dashboard search after terminating the final quick tab", async () => {
    replaceUrl(sessionUrl("alpha", "?tab=alpha"));
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$alpha")]));

    fireEvent.click(screen.getByRole("button", {
      name: "Terminate alpha tmux session",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Terminate session" }));

    await waitFor(() => expect(screen.getByRole("main", { name: "Dashboard" }))
      .toBeVisible());
    expect(window.location.pathname).toBe(`${BASE_PATH}/`);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Find a session" }))
      .toHaveFocus());
  });

  it("wires landing-page termination through the identity-safe App callback", async () => {
    render(<App />);
    act(() => reportKnownSessions?.([session("dashboard", "$dashboard", 4)]));

    fireEvent.click(screen.getByRole("button", { name: "Terminate dashboard session" }));

    await waitFor(() => expect(terminateSessionMock).toHaveBeenCalledWith(
      "dashboard",
      "$dashboard",
      4,
      10,
      100,
    ));
  });

  it("keeps the route when a same-name replacement appears during termination", async () => {
    const request = deferred<void>();
    terminateSessionMock.mockReturnValue(request.promise);
    replaceUrl(sessionUrl("alpha", "?tab=alpha"));
    render(<App />);
    act(() => reportKnownSessions?.([session("alpha", "$old")]));
    const terminate = reportSessionTerminate;
    const completion = terminate?.("alpha", "$old", 1, 10, 100);

    act(() => reportKnownSessions?.([session("alpha", "$old", 1, 20)]));
    await act(async () => {
      request.resolve();
      await completion;
    });

    expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
    expectWorkspaceSearch("", ["alpha"]);
    expect(historySessionBindings()?.route?.name).toBe("alpha");
  });

  it("restores every ordered open tab from the URL after remount", async () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Open second session" }));
    expect(renderedTabs()).toEqual(["work/name #1", "second work"]);
    expectWorkspaceSearch("", ["work/name #1", "second work"]);

    first.unmount();
    render(<App />);

    expect(renderedTabs()).toEqual(["work/name #1", "second work"]);
    expect(screen.getByRole("tab", { name: /second work/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /work\/name #1/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expectWorkspaceSearch("", ["work/name #1", "second work"]);
  });

  it("canonicalizes malformed ordered tab parameters and appends a missing active session", () => {
    const firstSession = "comma,&=+/# name";
    const activeSession = "active +/#? name";
    replaceUrl(
      sessionUrl(
        encodeURIComponent(activeSession),
        `?kind=codex&flag&tab=${encodeURIComponent(firstSession)}`
        + `&tab=&tab=${encodeURIComponent(firstSession)}&tab`,
      ),
    );

    render(<App />);

    expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
      "data-session",
      activeSession,
    );
    expect(renderedTabs()).toEqual([firstSession, activeSession]);
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).toBe(
      `?kind=codex&flag&tab=${encodeURIComponent(firstSession)}`
      + `&tab=${encodeURIComponent(activeSession)}`,
    );
    expectWorkspaceSearch("?kind=codex&flag", [firstSession, activeSession]);
  });

  it("keeps console display choices across SPA navigation and resets them on remount", async () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    const terminalMode = screen.getByRole("button", { name: "Terminal" });
    const inputMode = screen.getByRole("button", { name: /^Input$/ });
    const tabsToggle = screen.getByRole("button", { name: "Session tabs" });
    const inputToggle = screen.getByRole("button", { name: "Staged input" });
    const shortcutsToggle = screen.getByRole("button", {
      name: "Terminal shortcut buttons",
    });
    const routeBeforeToggles = window.location.href;

    expect(terminalMode).toBePressed();
    expect(inputMode).not.toBePressed();
    fireEvent.click(inputMode);
    expect(inputMode).toBePressed();
    expect(window.location.href).toBe(routeBeforeToggles);
    expect(tabsToggle).toBePressed();
    expect(inputToggle).toBePressed();
    expect(shortcutsToggle).toBePressed();
    fireEvent.click(tabsToggle);
    fireEvent.click(inputToggle);
    fireEvent.click(shortcutsToggle);

    expect(window.location.href).toBe(routeBeforeToggles);
    expect(tabsToggle).not.toBePressed();
    expect(inputToggle).not.toBePressed();
    expect(shortcutsToggle).not.toBePressed();
    expect(document.getElementById("muxdeck-session-tabs")).not.toBeVisible();
    expect(document.getElementById("muxdeck-staged-input")).not.toBeVisible();
    expect(document.getElementById("muxdeck-terminal-shortcuts")).not.toBeVisible();
    expect(screen.getByRole("group", { name: "Console bars" })).toBeVisible();

    act(() => {
      window.history.pushState(
        {},
        "",
        `${BASE_PATH}/session/work%2Fname%20%231/recents`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    expect(document.getElementById("muxdeck-session-tabs")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close session switcher" }));
    expect(window.location.pathname).toBe(`${BASE_PATH}/session/work%2Fname%20%231`);

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    await screen.findByRole("main", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Open second session" }));

    expect(screen.getByRole("button", { name: /^Input$/ })).toBePressed();
    expect(screen.getByRole("button", { name: "Session tabs" })).not.toBePressed();
    expect(screen.getByRole("button", { name: "Staged input" })).not.toBePressed();
    expect(screen.getByRole("button", {
      name: "Terminal shortcut buttons",
    })).not.toBePressed();

    fireEvent.click(screen.getByRole("button", { name: "Session tabs" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Staged input" })).not.toBePressed();

    first.unmount();
    render(<App />);

    expect(screen.getByRole("button", { name: "Terminal" })).toBePressed();
    expect(screen.getByRole("button", { name: /^Input$/ })).not.toBePressed();
    expect(screen.getByRole("button", { name: "Session tabs" })).toBePressed();
    expect(screen.getByRole("button", { name: "Staged input" })).toBePressed();
    expect(screen.getByRole("button", {
      name: "Terminal shortcut buttons",
    })).toBePressed();
    expect(screen.getByRole("navigation", { name: "Session workspace" })).toBeVisible();
    expect(document.getElementById("muxdeck-staged-input")).toBeVisible();
    expect(document.getElementById("muxdeck-terminal-shortcuts")).toBeVisible();
  });

  it("defaults malformed desktop tab orientation to horizontal", () => {
    window.localStorage.setItem("muxdeck-desktop-tab-orientation", "diagonal");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-orientation", "horizontal");
    expect(screen.getByRole("button", { name: "Horizontal tabs" })).toBePressed();
  });

  it("persists desktop tab orientation across App remounts", () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    expect(screen.getByRole("button", { name: "Horizontal tabs" })).toBePressed();

    fireEvent.click(screen.getByRole("button", { name: "Vertical tabs" }));
    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-orientation", "vertical");
    expect(window.localStorage.getItem("muxdeck-desktop-tab-orientation"))
      .toBe("vertical");

    first.unmount();
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-orientation", "vertical");
    expect(screen.getByRole("button", { name: "Vertical tabs" })).toBePressed();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(screen.getByRole("main", { name: "New session view" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Session workspace" }))
      .toHaveAttribute("data-orientation", "vertical");
  });

  it("persists one tab-action toggle across top tabs, side tabs, and remounts", () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    const actionsToggle = screen.getByRole("button", { name: "Tab action buttons" });
    const navigation = screen.getByRole("navigation", { name: "Session workspace" });
    expect(actionsToggle).toBePressed();
    expect(navigation).toHaveAttribute("data-tab-actions-visible", "true");
    expect(screen.getByRole("button", { name: "Close work/name #1 quick tab" }))
      .toBeVisible();

    expect(fireEvent.keyDown(window, {
      code: "KeyA",
      key: "A",
      ctrlKey: true,
      shiftKey: true,
    })).toBe(false);
    expect(actionsToggle).not.toBePressed();
    expect(navigation).toHaveAttribute("data-tab-actions-visible", "false");
    expect(screen.queryByRole("button", { name: "Close work/name #1 quick tab" }))
      .not.toBeInTheDocument();
    expect(window.localStorage.getItem("muxdeck-desktop-tab-actions-visible"))
      .toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Vertical tabs" }));
    expect(navigation).toHaveAttribute("data-orientation", "vertical");
    expect(navigation).toHaveAttribute("data-tab-actions-visible", "false");
    expect(screen.queryByRole("button", { name: "Close work/name #1 quick tab" }))
      .not.toBeInTheDocument();

    first.unmount();
    render(<App />);

    expect(screen.getByRole("button", { name: "Tab action buttons" })).not.toBePressed();
    expect(screen.getByRole("navigation", { name: "Session workspace" }))
      .toHaveAttribute("data-tab-actions-visible", "false");
    fireEvent.click(screen.getByRole("button", { name: "Tab action buttons" }));
    expect(screen.getByRole("button", { name: "Close work/name #1 quick tab" }))
      .toBeVisible();
    expect(window.localStorage.getItem("muxdeck-desktop-tab-actions-visible"))
      .toBe("true");
  });

  it("defaults malformed desktop tab rail width and clamps stored numeric values", () => {
    window.localStorage.setItem("muxdeck-desktop-tab-rail-width", "wide");
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "288");

    first.unmount();
    window.localStorage.setItem("muxdeck-desktop-tab-rail-width", "20");
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "72");
  });

  it("clamps and persists desktop tab rail width across App remounts", () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));
    const widthControl = screen.getByRole("slider", { name: "Desktop tab rail width" });

    fireEvent.change(widthControl, { target: { value: "96" } });
    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "96");
    expect(window.localStorage.getItem("muxdeck-desktop-tab-rail-width")).toBe("96");

    fireEvent.change(widthControl, { target: { value: "360" } });
    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "360");
    expect(window.localStorage.getItem("muxdeck-desktop-tab-rail-width")).toBe("360");

    fireEvent.change(widthControl, { target: { value: "900" } });
    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "480");
    expect(window.localStorage.getItem("muxdeck-desktop-tab-rail-width")).toBe("480");

    first.unmount();
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" }))
      .toHaveAttribute("data-tab-rail-width", "480");
  });

  describe("saved workspace lifecycle", () => {
    it("creates the exact open workspace and binds it in place without a redundant activity save", async () => {
      vi.useFakeTimers();
      const created = savedWorkspace({
        id: "release-room",
        name: "Release room",
        tabs: ["alpha", "beta"],
        activeSession: "beta",
        sessionRevision: 7,
        createdAt: 2_000,
        updatedAt: 2_000,
        lastActiveAt: 2_000,
      });
      createWorkspaceMock.mockResolvedValue(created);
      replaceUrl(
        sessionUrl("beta", "?kind=codex&flag&tab=alpha&tab=beta"),
      );
      const historyLength = window.history.length;

      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
      const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
      fireEvent.change(within(dialog).getByRole("textbox", {
        name: "Workspace name",
      }), { target: { value: "  Release room  " } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(createWorkspaceMock).toHaveBeenCalledOnce();
      expect(createWorkspaceMock).toHaveBeenCalledWith({
        name: "Release room",
        tabs: ["alpha", "beta"],
        groups: [],
        activeSession: "beta",
      });
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
      expect(window.location.search).toBe(
        "?kind=codex&flag&workspace=release-room&tab=alpha&tab=beta",
      );
      expect(window.history.length).toBe(historyLength);
      expect(screen.queryByRole("dialog", { name: "Save this workspace" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("status", {
        name: "Workspace saved automatically",
      })).toBeVisible();
      expect(screen.getByTitle("Release room - Saved")).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
    });

    it("keeps groups local without a save loop when workspace creation uses a legacy backend", async () => {
      vi.useFakeTimers();
      const legacyCreated = savedWorkspace({
        id: "legacy-room",
        name: "Legacy room",
        tabs: ["alpha", "beta"],
        activeSession: "alpha",
      });
      Reflect.deleteProperty(legacyCreated, "groups");
      createWorkspaceMock.mockResolvedValue(legacyCreated);
      const encodedGroup = encodeURIComponent(JSON.stringify(coreGroup));
      replaceUrl(sessionUrl(
        "alpha",
        `?tab=alpha&tab=beta&tab-group=${encodedGroup}`,
      ));

      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
      const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
      fireEvent.change(within(dialog).getByRole("textbox", {
        name: "Workspace name",
      }), { target: { value: "Legacy room" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(createWorkspaceMock).toHaveBeenCalledWith({
        name: "Legacy room",
        tabs: ["alpha", "beta"],
        groups: [coreGroup],
        activeSession: "alpha",
      });
      expect(urlGroups()).toEqual([coreGroup]);
      expect(screen.getByRole("status", {
        name: "Workspace tabs saved; tab groups are not stored by this server",
      })).toHaveTextContent("Tabs saved");

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
    });

    it("does not bind a late create after browser Back and Forward navigation", async () => {
      const pendingCreate = deferred<SavedWorkspace>();
      const created = savedWorkspace({
        id: "saved-during-navigation",
        name: "Saved during navigation",
        tabs: ["alpha"],
        activeSession: "alpha",
      });
      createWorkspaceMock.mockImplementationOnce(() => pendingCreate.promise);
      replaceUrl(dashboardUrl("?kind=shells"));

      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
      const dialog = screen.getByRole("dialog", { name: "Save this workspace" });
      fireEvent.change(within(dialog).getByRole("textbox", {
        name: "Workspace name",
      }), { target: { value: "Saved during navigation" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save workspace" }));
      expect(createWorkspaceMock).toHaveBeenCalledOnce();

      act(() => window.history.back());
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
      });
      act(() => window.history.forward());
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          "alpha",
        );
      });
      const locationAfterNavigation = window.location.href;
      const tabsAfterNavigation = openTabs();

      await act(async () => {
        pendingCreate.resolve(created);
        await pendingCreate.promise;
        await Promise.resolve();
      });

      expect(window.location.href).toBe(locationAfterNavigation);
      expect(openTabs()).toEqual(tabsAfterNavigation);
      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();
      expect(screen.getByRole("button", { name: "Save workspace" })).toBeVisible();
      expect(screen.queryByRole("status", {
        name: "Workspace saved automatically",
      })).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Workspace saved separately",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The workspace was saved on the server, but this page changed before it could be opened.",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Find it in Sessions; this page was not changed.",
      );
    });

    it("reports a saved workspace as loading until hydration succeeds", async () => {
      const pendingWorkspace = deferred<SavedWorkspace>();
      getWorkspaceMock.mockImplementationOnce(() => pendingWorkspace.promise);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=stale-url-tab",
      ));

      render(<App />);

      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledWith("workspace-one"));
      expect(getWorkspaceQuickLinksMock).not.toHaveBeenCalled();
      expect(screen.getByRole("status", { name: "Opening saved workspace" })).toBeVisible();
      expect(screen.getByTitle("Opening workspace - Opening")).toBeVisible();
      expect(screen.queryByRole("status", {
        name: "Workspace saved automatically",
      })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save workspace" }))
        .not.toBeInTheDocument();
      const newSessionButton = screen.getByRole("button", { name: "New session" });
      expect(newSessionButton).toBeDisabled();
      expect(newSessionButton).toHaveAttribute(
        "title",
        "Wait for workspace to finish opening",
      );
      const moveTabToWindow = screen.getByRole("button", {
        name: "Move alpha tab to new window",
      });
      const copyTabToWindow = screen.getByRole("button", {
        name: "Copy alpha tab to new window",
      });
      expect(moveTabToWindow).toBeDisabled();
      expect(copyTabToWindow).toBeEnabled();

      await act(async () => {
        pendingWorkspace.resolve(savedWorkspace());
        await pendingWorkspace.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByRole("status", {
          name: "Workspace saved automatically",
        })).toBeVisible();
      });
      await waitFor(() => expect(getWorkspaceQuickLinksMock).toHaveBeenCalledWith(
        "workspace-one",
        expect.any(AbortSignal),
      ));
      await waitFor(() => expect(getSessionQuickLinksMock).toHaveBeenCalledWith(
        "alpha",
        expect.any(AbortSignal),
      ));
      expect(screen.getByRole("region", { name: "Common quick links" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Workspace quick links" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Session quick links" })).toBeVisible();
      const consoleToolbar = screen.getByRole("group", { name: "Console bars" });
      expect(within(consoleToolbar).getByRole("region", {
        name: "Common quick links",
      })).toBeVisible();
      expect(within(consoleToolbar).getByRole("region", {
        name: "Workspace quick links",
      })).toBeVisible();
      expect(within(consoleToolbar).getByRole("region", {
        name: "Session quick links",
      })).toBeVisible();
      expect(screen.getByTitle("Workspace one - Saved")).toBeVisible();
      expect(newSessionButton).toBeEnabled();
      expect(newSessionButton).toHaveAttribute("title", "New session (Ctrl+Shift+B)");
      expect(moveTabToWindow).toBeEnabled();
      expect(copyTabToWindow).toBeEnabled();
      expect(screen.queryByRole("status", { name: "Opening saved workspace" }))
        .not.toBeInTheDocument();
    });

    it("hydrates saved tab groups into the canonical workspace URL", async () => {
      const collapsedCoreGroup = { ...coreGroup, collapsed: true };
      getWorkspaceMock.mockResolvedValue(savedWorkspace({
        groups: [collapsedCoreGroup],
      }));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(sessionUrl(
        "alpha",
        "?kind=codex&workspace=workspace-one&tab=stale-url-tab",
      ));

      render(<App />);

      await waitFor(() => {
        expect(openTabs()).toEqual(["alpha", "beta"]);
        expect(urlGroups()).toEqual([collapsedCoreGroup]);
      });
      expect(new URLSearchParams(window.location.search).getAll("tab-group"))
        .toHaveLength(1);
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
      expect(screen.getByRole("status", {
        name: "Workspace saved automatically",
      })).toBeVisible();
      expect(screen.getByRole("button", {
        name: "Expand Core work tab group",
      })).toBeVisible();
    });

    it("waits for saved-workspace hydration before direct creation can submit", async () => {
      const pendingWorkspace = deferred<SavedWorkspace>();
      getWorkspaceMock.mockImplementationOnce(() => pendingWorkspace.promise);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(
        `${BASE_PATH}/sessions/new?workspace=workspace-one&tab=stale-url-tab`,
      );

      render(<App />);

      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledWith("workspace-one"));
      const createSessionButton = screen.getByRole("button", {
        name: "Create test session",
      });
      expect(createSessionButton).toBeDisabled();
      fireEvent.click(createSessionButton);
      expect(window.location.pathname).toBe(`${BASE_PATH}/sessions/new`);

      await act(async () => {
        pendingWorkspace.resolve(savedWorkspace());
        await pendingWorkspace.promise;
        await Promise.resolve();
      });

      await waitFor(() => expect(createSessionButton).toBeEnabled());
      expect(renderedTabs()).toEqual(["alpha", "beta", "New session"]);
      fireEvent.click(createSessionButton);

      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "fresh/session",
      );
      expectWorkspaceSearch("?workspace=workspace-one", [
        "alpha",
        "beta",
        "fresh/session",
      ]);
    });

    it("keeps the selected workspace name visible while opening it", async () => {
      const pendingWorkspace = deferred<SavedWorkspace>();
      const selectedWorkspace = savedWorkspace({
        id: "workspace-two",
        name: "Incident room",
        tabs: ["alpha"],
        activeSession: "alpha",
      });
      getWorkspaceMock.mockImplementationOnce(() => pendingWorkspace.promise);
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);

      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Open alpha session" }));
      expect(openSavedWorkspaceFromDashboard).not.toBeNull();

      act(() => openSavedWorkspaceFromDashboard?.(selectedWorkspace));
      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledWith("workspace-two"));
      expect(screen.getByTitle("Incident room - Opening")).toBeVisible();

      await act(async () => {
        pendingWorkspace.resolve({ ...selectedWorkspace, name: "Incident response" });
        await pendingWorkspace.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getByTitle("Incident response - Saved")).toBeVisible();
      });
      expect(screen.getByRole("main", { name: "Console" }))
        .toHaveAttribute("data-workspace-name", "Incident response");
    });

    it("updates the active workspace identity after a landing-page rename", async () => {
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await waitFor(() => {
        expect(window.location.search).toBe(
          "?workspace=workspace-one&tab=alpha&tab=beta",
        );
      });
      fireEvent.click(screen.getByRole("button", {
        name: "Resume workspace at alpha, 2 open tabs",
      }));
      const console = await screen.findByRole("main", { name: "Console" });
      expect(console).toHaveAttribute("data-workspace-name", "Workspace one");
      expect(screen.getByTitle("Workspace one - Saved")).toBeVisible();
      expect(reportSavedWorkspaceUpdated).not.toBeNull();

      act(() => reportSavedWorkspaceUpdated?.(savedWorkspace({ name: "Release train" })));
      expect(console).toHaveAttribute("data-workspace-name", "Release train");
      expect(screen.getByTitle("Release train - Saved")).toBeVisible();

      act(() => reportSavedWorkspaceUpdated?.(savedWorkspace({
        id: "workspace-two",
        name: "Other workspace",
      })));
      expect(console).toHaveAttribute("data-workspace-name", "Release train");
      expect(screen.getByTitle("Release train - Saved")).toBeVisible();
    });

    it("persists the remaining ordered tabs after terminating the active saved-workspace session", async () => {
      vi.useFakeTimers();
      const loaded = savedWorkspace({
        tabs: ["alpha", "beta"],
        activeSession: "beta",
        sessionRevision: 4,
      });
      getWorkspaceMock.mockResolvedValue(loaded);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock.mockResolvedValue(savedWorkspace({
        tabs: ["alpha"],
        activeSession: "alpha",
        sessionRevision: 4,
      }));
      replaceUrl(sessionUrl(
        "beta",
        "?workspace=workspace-one&tab=alpha&tab=beta",
      ));

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);
      });
      updateWorkspaceActivityMock.mockClear();
      const terminate = reportSessionTerminate;
      expect(terminate).not.toBeNull();

      await act(async () => {
        await terminate?.("beta", "$beta", 1, 10, 100);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
      expectWorkspaceSearch("?workspace=workspace-one", ["alpha"]);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha"],
        [],
        "alpha",
        4,
      );
    });

    it("autosaves a moved tab but not a copied tab in a saved workspace", async () => {
      vi.useFakeTimers();
      const loaded = savedWorkspace({
        tabs: ["alpha", "beta"],
        activeSession: "alpha",
        sessionRevision: 4,
      });
      getWorkspaceMock.mockResolvedValue(loaded);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock.mockResolvedValue(loaded);
      replaceUrl(sessionUrl(
        "alpha",
        "?kind=agents&workspace=workspace-one&tab=stale",
      ));
      const replace = vi.fn();
      const open = vi.spyOn(window, "open").mockReturnValue({
        opener: window,
        location: { replace },
        close: vi.fn(),
      } as unknown as Window);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(500));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalled();
      updateWorkspaceActivityMock.mockClear();
      updateWorkspaceActivityMock.mockResolvedValue(savedWorkspace({
        tabs: ["alpha"],
        activeSession: "alpha",
        sessionRevision: 5,
      }));

      fireEvent.click(screen.getByRole("button", {
        name: "Copy beta tab to new window",
      }));
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
      expectWorkspaceSearch("?kind=agents&workspace=workspace-one", ["alpha", "beta"]);

      fireEvent.click(screen.getByRole("button", {
        name: "Move beta tab to new window",
      }));
      await act(async () => vi.advanceTimersByTimeAsync(500));

      expect(window.location.pathname).toBe(`${BASE_PATH}/session/alpha`);
      expectWorkspaceSearch("?kind=agents&workspace=workspace-one", ["alpha"]);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha"],
        [],
        "alpha",
        4,
      );
      expect(replace).toHaveBeenCalledTimes(2);
      for (const [destination] of replace.mock.calls) {
        expect(new URL(String(destination)).searchParams.has("workspace")).toBe(false);
      }
      expect(terminateSessionMock).not.toHaveBeenCalled();

      open.mockRestore();
    });

    it("waits for an older saved-workspace save before moving a tab", async () => {
      vi.useFakeTimers();
      const firstSave = deferred<SavedWorkspace>();
      const secondSave = deferred<SavedWorkspace>();
      const loaded = savedWorkspace({
        tabs: ["alpha", "beta"],
        activeSession: "alpha",
        sessionRevision: 4,
      });
      getWorkspaceMock.mockResolvedValue(loaded);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=stale",
      ));
      const replace = vi.fn();
      const open = vi.spyOn(window, "open").mockReturnValue({
        opener: window,
        location: { replace },
        close: vi.fn(),
      } as unknown as Window);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByRole("button", {
        name: "Copy beta tab to new window",
      }));
      expect(open).toHaveBeenCalledOnce();
      expectWorkspaceSearch("?workspace=workspace-one", ["alpha", "beta"]);

      fireEvent.click(screen.getByRole("button", {
        name: "Move beta tab to new window",
      }));
      expect(open).toHaveBeenCalledOnce();
      expectWorkspaceSearch("?workspace=workspace-one", ["alpha", "beta"]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Muxdeck is finishing an earlier workspace save before moving beta.",
      );

      await act(async () => {
        firstSave.resolve(loaded);
        await firstSave.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(0));

      fireEvent.click(screen.getByRole("button", { name: "Move beta tab left" }));
      expectWorkspaceSearch("?workspace=workspace-one", ["beta", "alpha"]);
      fireEvent.click(screen.getByRole("button", {
        name: "Move beta tab to new window",
      }));
      expect(open).toHaveBeenCalledOnce();
      expectWorkspaceSearch("?workspace=workspace-one", ["beta", "alpha"]);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondSave.resolve(savedWorkspace({
          tabs: ["beta", "alpha"],
          activeSession: "alpha",
          sessionRevision: 4,
        }));
        await secondSave.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(0));

      fireEvent.click(screen.getByRole("button", {
        name: "Move beta tab to new window",
      }));
      expect(open).toHaveBeenCalledTimes(2);
      expectWorkspaceSearch("?workspace=workspace-one", ["alpha"]);

      act(() => window.dispatchEvent(new Event("pagehide")));
      expect(sendBeaconMock).toHaveBeenCalledOnce();
      const body = sendBeaconMock.mock.calls[0]?.[1];
      expect(body).toBeInstanceOf(Blob);
      vi.useRealTimers();
      expect(JSON.parse(await readBlobText(body as Blob))).toEqual({
        tabs: ["alpha"],
        groups: [],
        activeSession: "alpha",
        sessionRevision: 4,
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(terminateSessionMock).not.toHaveBeenCalled();

      open.mockRestore();
    });

    it("reports a hydration failure as a workspace persistence error", async () => {
      getWorkspaceMock.mockRejectedValueOnce(new Error("workspace disk is unavailable"));
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=stale-url-tab",
      ));

      render(<App />);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Saved workspace unavailable");
      });
      expect(screen.getByRole("alert")).toHaveTextContent("workspace disk is unavailable");
      expect(screen.getByRole("status", { name: "Workspace sync issue" })).toBeVisible();
      expect(screen.getByTitle("Saved workspace - Sync issue")).toBeVisible();
      expect(screen.queryByRole("status", {
        name: "Workspace saved automatically",
      })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save workspace" }))
        .not.toBeInTheDocument();
      const moveTabToWindow = screen.getByRole("button", {
        name: "Move alpha tab to new window",
      });
      const copyTabToWindow = screen.getByRole("button", {
        name: "Copy alpha tab to new window",
      });
      expect(moveTabToWindow).toBeDisabled();
      expect(moveTabToWindow).toHaveAccessibleDescription(
        "Move is unavailable until the workspace sync issue is resolved.",
      );
      expect(copyTabToWindow).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Workspace sync issue" })).toBeVisible();
      expect(screen.queryByRole("status", { name: "Opening saved workspace" }))
        .not.toBeInTheDocument();
      expect(screen.queryByRole("status", {
        name: "Workspace saved automatically",
      })).not.toBeInTheDocument();
      const recovery = screen.getByRole("complementary", {
        name: "Workspace sync recovery",
      });
      expect(within(recovery).getByRole("button", { name: "Retry" })).toBeVisible();

      fireEvent.click(within(recovery).getByRole("button", {
        name: "Show workspace sync details",
      }));
      expect(screen.getByRole("alert")).toHaveTextContent("workspace disk is unavailable");

      getWorkspaceMock.mockResolvedValueOnce(savedWorkspace());
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(screen.getByRole("status", {
          name: "Workspace saved automatically",
        })).toBeVisible();
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", {
        name: "Workspace sync recovery",
      })).not.toBeInTheDocument();
      expect(moveTabToWindow).toBeEnabled();
      expect(copyTabToWindow).toBeEnabled();
    });

    it("clears a load sync problem after navigating to an unsaved URL", async () => {
      getWorkspaceMock.mockRejectedValueOnce(new Error("workspace disk is unavailable"));
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=alpha",
      ));

      render(<App />);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Saved workspace unavailable");
      });
      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
      expect(screen.getByRole("complementary", {
        name: "Workspace sync recovery",
      })).toBeVisible();

      act(() => {
        window.history.pushState({}, "", sessionUrl("alpha", "?tab=alpha"));
        window.dispatchEvent(new PopStateEvent("popstate", {
          state: window.history.state,
        }));
      });

      await waitFor(() => {
        expect(screen.queryByRole("complementary", {
          name: "Workspace sync recovery",
        })).not.toBeInTheDocument();
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save workspace" })).toBeVisible();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();
    });

    it("invalidates an in-flight workspace load when navigation leaves its URL", async () => {
      const staleLoad = deferred<SavedWorkspace>();
      getWorkspaceMock
        .mockImplementationOnce(() => staleLoad.promise)
        .mockResolvedValueOnce(savedWorkspace());
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=alpha",
      ));

      render(<App />);
      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledOnce());

      act(() => {
        window.history.pushState({}, "", sessionUrl("alpha", "?tab=alpha"));
        window.dispatchEvent(new PopStateEvent("popstate", {
          state: window.history.state,
        }));
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Save workspace" })).toBeVisible();
      });

      await act(async () => {
        staleLoad.resolve(savedWorkspace({
          tabs: ["stale"],
          activeSession: "stale",
        }));
        await staleLoad.promise;
        await Promise.resolve();
      });
      expect(openTabs()).toEqual(["alpha"]);
      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();

      act(() => {
        window.history.pushState(
          {},
          "",
          sessionUrl("alpha", "?workspace=workspace-one&tab=alpha"),
        );
        window.dispatchEvent(new PopStateEvent("popstate", {
          state: window.history.state,
        }));
      });

      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        expect(screen.getByRole("status", {
          name: "Workspace saved automatically",
        })).toBeVisible();
      });
      expect(openTabs()).toEqual(["alpha", "beta"]);
    });

    it("hydrates server tabs over stale URL tabs and resumes the saved active session", async () => {
      const serverWorkspace = savedWorkspace({
        tabs: ["server-alpha", "server-beta"],
        activeSession: "server-beta",
      });
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue([
        session("server-alpha", "$server-alpha"),
        session("server-beta", "$server-beta"),
      ]);
      replaceUrl(
        `${BASE_PATH}/?kind=codex&tab=stale-one&tab=stale-two`
        + "&workspace=workspace-one",
      );

      render(<App />);

      await screen.findByRole("button", {
        name: "Resume workspace at server-beta, 2 open tabs",
      });
      await waitFor(() => {
        expect(window.location.search).toBe(
          "?kind=codex&workspace=workspace-one&tab=server-alpha&tab=server-beta",
        );
        expect(dashboardActiveWorkspaceId).toBe("workspace-one");
      });
      expect(getWorkspaceMock).toHaveBeenCalledWith("workspace-one");
      expect(window.location.pathname).toBe(`${BASE_PATH}/`);
      expect(openTabs()).toEqual(["server-alpha", "server-beta"]);
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-one",
      );
      expect(window.location.search).not.toContain("stale-one");
      expect(window.location.search).not.toContain("stale-two");

      fireEvent.click(screen.getByRole("button", {
        name: "Resume workspace at server-beta, 2 open tabs",
      }));
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          "server-beta",
        );
      });
      expect(screen.getByTitle("Workspace one - Saved")).toBeVisible();
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/server-beta`);
    });

    it("preserves saved tab groups through dashboard history and workspace resume", async () => {
      getWorkspaceMock.mockResolvedValue(savedWorkspace({
        groups: [coreGroup],
      }));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one&tab=stale`);

      render(<App />);

      const resume = await screen.findByRole("button", {
        name: "Resume workspace at alpha, 2 open tabs",
      });
      await waitFor(() => expect(urlGroups()).toEqual([coreGroup]));
      fireEvent.click(resume);
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          "alpha",
        );
      });
      expect(openTabs()).toEqual(["alpha", "beta"]);
      expect(urlGroups()).toEqual([coreGroup]);

      act(() => window.history.back());
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
      });
      expect(openTabs()).toEqual(["alpha", "beta"]);
      expect(urlGroups()).toEqual([coreGroup]);

      act(() => window.history.forward());
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          "alpha",
        );
      });
      expect(openTabs()).toEqual(["alpha", "beta"]);
      expect(urlGroups()).toEqual([coreGroup]);
    });

    it.each([
      {
        label: "the saved active tab",
        workspace: savedWorkspace({
          tabs: ["alpha", "beta"],
          activeSession: "beta",
        }),
        liveSessions: [session("alpha", "$alpha"), session("beta", "$beta")],
        expected: "beta",
      },
      {
        label: "the first live saved tab when the active tab ended",
        workspace: savedWorkspace({
          tabs: ["ended", "beta", "alpha"],
          activeSession: "ended",
        }),
        liveSessions: [session("beta", "$beta")],
        expected: "beta",
      },
    ])("routes to $label", async ({ workspace: serverWorkspace, liveSessions, expected }) => {
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue(liveSessions);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one&tab=stale`);

      render(<App />);

      await screen.findByRole("button", {
        name: `Resume workspace at ${expected}, ${serverWorkspace.tabs.length} open tabs`,
      });
      await waitFor(() => {
        expect(window.location.search).toBe(
          `?workspace=workspace-one${serverWorkspace.tabs.map((tab) => (
            `&tab=${encodeURIComponent(tab)}`
          )).join("")}`,
        );
        expect(dashboardActiveWorkspaceId).toBe("workspace-one");
      });
      fireEvent.click(screen.getByRole("button", {
        name: `Resume workspace at ${expected}, ${serverWorkspace.tabs.length} open tabs`,
      }));
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          expected,
        );
      });
      expect(window.location.pathname).toBe(`${BASE_PATH}/session/${expected}`);
      expect(openTabs()).toEqual(serverWorkspace.tabs);
    });

    it("keeps saved tabs but routes to the dashboard when none are live", async () => {
      const serverWorkspace = savedWorkspace({
        tabs: ["ended-one", "ended-two"],
        activeSession: "ended-two",
      });
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue([]);
      replaceUrl(
        `${BASE_PATH}/session/stale?tab=stale&workspace=workspace-one`,
      );

      render(<App />);

      await waitFor(() => {
        expect(window.location.pathname).toBe(`${BASE_PATH}/`);
        expect(openTabs()).toEqual(["ended-one", "ended-two"]);
      });
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
      expect(screen.queryByRole("button", { name: /Resume workspace/ })).not.toBeInTheDocument();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-one",
      );
    });

    it("autosyncs reordered saved tabs with the current workspace revision", async () => {
      vi.useFakeTimers();
      const serverWorkspace = savedWorkspace({
        tabs: ["alpha", "beta", "gamma"],
        activeSession: "beta",
        sessionRevision: 7,
      });
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
        session("gamma", "$gamma"),
      ]);
      updateWorkspaceActivityMock.mockResolvedValue({
        ...serverWorkspace,
        name: "Renamed remotely",
        sessionRevision: 8,
      });
      replaceUrl(sessionUrl(
        "beta",
        "?kind=codex&flag&workspace=workspace-one&tab=stale",
      ));

      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("status", {
        name: "Workspace saved automatically",
      })).toBeVisible();
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Move beta tab left" }));

      expect(window.location.pathname).toBe(`${BASE_PATH}/session/beta`);
      expect(window.location.search).toBe(
        "?kind=codex&flag&workspace=workspace-one&tab=beta&tab=alpha&tab=gamma",
      );
      await act(async () => {
        vi.advanceTimersByTime(399);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["beta", "alpha", "gamma"],
        [],
        "beta",
        7,
      );
      expect(screen.getByTitle("Renamed remotely - Saved")).toBeVisible();
    });

    it("autosyncs a saved workspace without dropping its tab groups", async () => {
      vi.useFakeTimers();
      const serverWorkspace = savedWorkspace({
        groups: [coreGroup],
        sessionRevision: 9,
      });
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock.mockResolvedValue({
        ...serverWorkspace,
        activeSession: "beta",
      });
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=stale",
      ));

      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
      expect(urlGroups()).toEqual([coreGroup]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [coreGroup],
        "beta",
        9,
      );
    });

    it("keeps an active group collapsed in the URL and saved activity", async () => {
      vi.useFakeTimers();
      const collapsedCoreGroup = { ...coreGroup, collapsed: true };
      const serverWorkspace = savedWorkspace({
        groups: [coreGroup],
        sessionRevision: 9,
      });
      getWorkspaceMock.mockResolvedValue(serverWorkspace);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock.mockResolvedValue({
        ...serverWorkspace,
        groups: [collapsedCoreGroup],
      });
      replaceUrl(sessionUrl("alpha", "?workspace=workspace-one&tab=stale"));

      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", {
        name: "Collapse Core work tab group",
      }));
      expect(urlGroups()).toEqual([collapsedCoreGroup]);
      expect(screen.getByRole("button", {
        name: "Expand Core work tab group",
      })).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [collapsedCoreGroup],
        "alpha",
        9,
      );
    });

    it("debounces changes and serializes the latest activity behind an in-flight save", async () => {
      vi.useFakeTimers();
      const firstSave = deferred<SavedWorkspace>();
      const secondSave = deferred<SavedWorkspace>();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", {
        name: "Resume workspace at alpha, 2 open tabs",
      }));
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "alpha",
      );

      await act(async () => {
        vi.advanceTimersByTime(399);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(1);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [],
        "alpha",
        0,
      );

      fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
      fireEvent.click(screen.getByRole("button", { name: "Close alpha quick tab" }));
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        firstSave.resolve(savedWorkspace());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["beta"],
        [],
        "beta",
        0,
      );

      await act(async () => {
        secondSave.resolve(savedWorkspace({
          tabs: ["beta"],
          activeSession: "beta",
        }));
        await Promise.resolve();
      });
    });

    it("sends the latest workspace activity when the page hides before the debounce", async () => {
      vi.useFakeTimers();
      const pageHideGroup = {
        ...coreGroup,
        tabs: ["alpha", "second work"],
      };
      getWorkspaceMock.mockResolvedValue(savedWorkspace({
        tabs: ["alpha", "second work"],
        groups: [pageHideGroup],
        activeSession: "alpha",
      }));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("second work", "$second"),
      ]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      const view = render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openSessionFromDashboard).not.toBeNull();

      act(() => {
        openSessionFromDashboard?.("second work");
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(updateWorkspaceActivityMock).not.toHaveBeenCalled();
      expect(sendBeaconMock).toHaveBeenCalledOnce();
      expect(sendBeaconMock.mock.calls[0]?.[0]).toBe(
        `${BASE_PATH}/api/workspaces/workspace-one/activity`,
      );
      const body = sendBeaconMock.mock.calls[0]?.[1];
      expect(body).toBeInstanceOf(Blob);
      expect((body as Blob).type).toBe("application/json");

      view.unmount();
      vi.useRealTimers();
      expect(JSON.parse(await readBlobText(body as Blob))).toEqual({
        tabs: ["alpha", "second work"],
        groups: [pageHideGroup],
        activeSession: "second work",
        sessionRevision: 0,
      });
    });

    it("keeps legacy workspace tabs saving without claiming groups are durable", async () => {
      vi.useFakeTimers();
      const legacyWorkspace = savedWorkspace({
        tabs: ["alpha"],
        activeSession: "alpha",
      });
      Reflect.deleteProperty(legacyWorkspace, "groups");
      getWorkspaceMock.mockResolvedValue(legacyWorkspace);
      updateWorkspaceActivityMock.mockResolvedValue(legacyWorkspace);
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("second work", "$second"),
      ]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      const view = render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(openSessionFromDashboard).not.toBeNull();

      act(() => openSessionFromDashboard?.("second work"));
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha", "second work"],
        [],
        "second work",
        0,
      );
      expect(screen.getByRole("status", {
        name: "Workspace saved automatically",
      })).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Create tab group" }));
      const groupDialog = screen.getByRole("dialog", { name: "Create a group" });
      fireEvent.change(within(groupDialog).getByRole("textbox", { name: "Group name" }), {
        target: { value: "Local release lane" },
      });
      fireEvent.click(within(groupDialog).getByRole("checkbox", { name: /alpha/i }));
      fireEvent.click(within(groupDialog).getByRole("button", { name: "Create group" }));

      expect(screen.getByRole("status", {
        name: "Workspace tabs saved; tab groups are not stored by this server",
      })).toHaveTextContent("Tabs saved");
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock.mock.calls[1]?.[2]).toEqual([
        expect.objectContaining({
          name: "Local release lane",
          tabs: ["alpha", "second work"],
        }),
      ]);
      expect(screen.queryByText(/Workspace changes are not saved/i))
        .not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Close alpha quick tab" }));
      act(() => window.dispatchEvent(new Event("pagehide")));
      expect(sendBeaconMock).toHaveBeenCalledOnce();
      const body = sendBeaconMock.mock.calls[0]?.[1];
      expect(body).toBeInstanceOf(Blob);

      view.unmount();
      vi.useRealTimers();
      const payload = JSON.parse(await readBlobText(body as Blob));
      expect(payload).toEqual({
        tabs: ["second work"],
        activeSession: "second work",
        sessionRevision: 0,
      });
      expect(payload).not.toHaveProperty("groups");
    });

    it("resyncs local groups after a focused page detects an upgraded backend", async () => {
      vi.useFakeTimers();
      const legacyWorkspace = savedWorkspace();
      Reflect.deleteProperty(legacyWorkspace, "groups");
      getWorkspaceMock.mockResolvedValue(legacyWorkspace);
      updateWorkspaceActivityMock
        .mockResolvedValueOnce(legacyWorkspace)
        .mockImplementation(async (
          _workspaceId,
          tabs,
          groups,
          activeSession,
          sessionRevision,
        ) => ({
          ...legacyWorkspace,
          tabs,
          groups,
          activeSession,
          sessionRevision,
        }));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      replaceUrl(sessionUrl(
        "alpha",
        "?workspace=workspace-one&tab=stale",
      ));

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.click(screen.getByRole("button", { name: "Create tab group" }));
      const groupDialog = screen.getByRole("dialog", { name: "Create a group" });
      fireEvent.change(within(groupDialog).getByRole("textbox", { name: "Group name" }), {
        target: { value: "Recovered group" },
      });
      fireEvent.click(within(groupDialog).getByRole("checkbox", { name: /beta/i }));
      fireEvent.click(within(groupDialog).getByRole("button", { name: "Create group" }));
      expect(screen.getByRole("status", {
        name: "Workspace tabs saved; tab groups are not stored by this server",
      })).toBeVisible();

      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
      expect(updateWorkspaceActivityMock.mock.calls[0]?.[2]).toEqual([
        expect.objectContaining({
          name: "Recovered group",
          tabs: ["alpha", "beta"],
        }),
      ]);
      expect(screen.getByRole("status", {
        name: "Workspace tabs saved; tab groups are not stored by this server",
      })).toBeVisible();

      getWorkspaceMock.mockResolvedValueOnce({
        ...legacyWorkspace,
        groups: [],
      });
      act(() => window.dispatchEvent(new Event("focus")));
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getWorkspaceMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock.mock.calls[1]?.[2]).toEqual([
        expect.objectContaining({
          name: "Recovered group",
          tabs: ["alpha", "beta"],
        }),
      ]);
      expect(screen.getByRole("status", {
        name: "Workspace saved automatically",
      })).toHaveTextContent("Saved");
    });

    it("clears a failed older activity after the newer queued activity succeeds", async () => {
      vi.useFakeTimers();
      const firstSave = deferred<SavedWorkspace>();
      const newerSave = deferred<SavedWorkspace>();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => newerSave.promise);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", {
        name: "Resume workspace at alpha, 2 open tabs",
      }));
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(1);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [],
        "alpha",
        0,
      );

      fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
      fireEvent.click(screen.getByRole("button", { name: "Close alpha quick tab" }));
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        firstSave.reject(new Error("older activity failed"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("older activity failed");
      expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["beta"],
        [],
        "beta",
        0,
      );

      await act(async () => {
        newerSave.resolve(savedWorkspace({
          tabs: ["beta"],
          activeSession: "beta",
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry an old snapshot behind newer in-flight and queued activity", async () => {
      vi.useFakeTimers();
      const newerSave = deferred<SavedWorkspace>();
      const latestSave = deferred<SavedWorkspace>();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
      ]);
      updateWorkspaceActivityMock
        .mockRejectedValueOnce(new Error("older activity failed"))
        .mockImplementationOnce(() => newerSave.promise)
        .mockImplementationOnce(() => latestSave.promise)
        .mockResolvedValue(savedWorkspace());
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("older activity failed");

      act(() => openSessionFromDashboard?.("beta"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [],
        "beta",
        0,
      );

      fireEvent.click(screen.getByRole("button", { name: "Close alpha quick tab" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);

      const retry = screen.getByRole("button", { name: "Retry" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        newerSave.resolve(savedWorkspace({
          activeSession: "beta",
        }));
        await newerSave.promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(3);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["beta"],
        [],
        "beta",
        0,
      );

      await act(async () => {
        latestSave.resolve(savedWorkspace({
          tabs: ["beta"],
          activeSession: "beta",
        }));
        await latestSave.promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(updateWorkspaceActivityMock.mock.calls).toEqual([
        ["workspace-one", ["alpha", "beta"], [], "alpha", 0],
        ["workspace-one", ["alpha", "beta"], [], "beta", 0],
        ["workspace-one", ["beta"], [], "beta", 0],
      ]);
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("ignores an activity failure after switching to another saved workspace", async () => {
      vi.useFakeTimers();
      const staleSave = deferred<SavedWorkspace>();
      const newerWorkspace = savedWorkspace({
        id: "workspace-two",
        name: "Workspace two",
        tabs: ["gamma"],
        activeSession: "gamma",
      });
      getWorkspaceMock.mockImplementation((workspaceId) => Promise.resolve(
        workspaceId === "workspace-one" ? savedWorkspace() : newerWorkspace,
      ));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("beta", "$beta"),
        session("gamma", "$gamma"),
      ]);
      updateWorkspaceActivityMock.mockImplementationOnce(() => staleSave.promise);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["alpha", "beta"],
        [],
        "alpha",
        0,
      );
      expect(openSavedWorkspaceFromDashboard).not.toBeNull();

      act(() => openSavedWorkspaceFromDashboard?.(newerWorkspace));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-two",
      );
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "gamma",
      );
      expect(screen.getByTitle("Workspace two - Saved")).toBeVisible();

      await act(async () => {
        staleSave.reject(new Error("workspace one save failed"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-two",
        ["gamma"],
        [],
        "gamma",
        0,
      );
    });

    it("ignores a stale workspace GET after switching to a different saved workspace", async () => {
      const staleLoad = deferred<SavedWorkspace>();
      const newerWorkspace = savedWorkspace({
        id: "workspace-two",
        name: "Workspace two",
        tabs: ["gamma"],
        activeSession: "gamma",
      });
      getWorkspaceMock.mockImplementation((workspaceId) => (
        workspaceId === "workspace-one"
          ? staleLoad.promise
          : Promise.resolve(newerWorkspace)
      ));
      listSessionsMock.mockResolvedValue([
        session("alpha", "$alpha"),
        session("gamma", "$gamma"),
      ]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one&tab=stale`);

      render(<App />);
      await waitFor(() => expect(getWorkspaceMock).toHaveBeenCalledOnce());
      expect(openSavedWorkspaceFromDashboard).not.toBeNull();

      act(() => openSavedWorkspaceFromDashboard?.(newerWorkspace));
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
          "data-session",
          "gamma",
        );
      });
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-two",
      );
      expect(openTabs()).toEqual(["gamma"]);

      await act(async () => {
        staleLoad.resolve(savedWorkspace({
          tabs: ["alpha"],
          activeSession: "alpha",
        }));
        await Promise.resolve();
      });
      expect(screen.getByRole("main", { name: "Console" })).toHaveAttribute(
        "data-session",
        "gamma",
      );
      expect(screen.getByTitle("Workspace two - Saved")).toBeVisible();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-two",
      );
      expect(openTabs()).toEqual(["gamma"]);
    });

    it("detaches a deleted active workspace without closing its tabs", async () => {
      getWorkspaceMock.mockResolvedValue(savedWorkspace({
        tabs: ["ended-one", "ended-two"],
        activeSession: "ended-two",
      }));
      listSessionsMock.mockResolvedValue([]);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);
      render(<App />);
      await waitFor(() => {
        expect(openTabs()).toEqual(["ended-one", "ended-two"]);
        expect(dashboardActiveWorkspaceId).toBe("workspace-one");
        expect(window.location.search).toBe(
          "?workspace=workspace-one&tab=ended-one&tab=ended-two",
        );
      });
      expect(reportSavedWorkspaceDeleted).not.toBeNull();

      act(() => reportSavedWorkspaceDeleted?.("workspace-one"));

      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();
      expect(openTabs()).toEqual(["ended-one", "ended-two"]);
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Workspace is now unsaved");
      });
      expect(screen.getByRole("button", {
        name: "Resume workspace at ended-two, 2 open tabs",
      })).toBeVisible();
      fireEvent.click(screen.getByRole("button", {
        name: "Resume workspace at ended-two, 2 open tabs",
      }));
      const console = await screen.findByRole("main", { name: "Console" });
      expect(console).toHaveAttribute("data-workspace-name", "");
      expect(screen.getByTitle("Temporary workspace - Save workspace")).toBeVisible();
    });

    it("detaches with tabs intact when an activity save reports a remote 404", async () => {
      vi.useFakeTimers();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);
      updateWorkspaceActivityMock.mockRejectedValue(
        new ApiRequestError("workspace not found", 404),
      );
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();
      expect(openTabs()).toEqual(["alpha", "beta"]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "deleted on another device",
      );
      expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
    });

    it("drops stale activity and reloads after a session revision conflict", async () => {
      vi.useFakeTimers();
      const staleSave = deferred<SavedWorkspace>();
      const renamedWorkspace = savedWorkspace({
        tabs: ["new-name"],
        activeSession: "new-name",
        sessionRevision: 1,
      });
      getWorkspaceMock
        .mockResolvedValueOnce(savedWorkspace({
          tabs: ["old-name"],
          activeSession: "old-name",
        }))
        .mockResolvedValue(renamedWorkspace);
      listSessionsMock
        .mockResolvedValueOnce([
          session("old-name", "$renamed"),
        ])
        .mockResolvedValue([
          session("new-name", "$renamed"),
        ]);
      updateWorkspaceActivityMock
        .mockImplementationOnce(() => staleSave.promise)
        .mockResolvedValue(renamedWorkspace);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledWith(
        "workspace-one",
        ["old-name"],
        [],
        "old-name",
        0,
      );

      act(() => openSessionFromDashboard?.("second work"));
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        staleSave.reject(new ApiRequestError("reload the workspace", 409));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getWorkspaceMock).toHaveBeenCalledTimes(2);
      expect(openTabs()).toEqual(["new-name"]);
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["new-name"],
        [],
        "new-name",
        1,
      );
    });

    it("does not let an older success lower a rehydrated session revision", async () => {
      vi.useFakeTimers();
      const staleSave = deferred<SavedWorkspace>();
      const renamedWorkspace = savedWorkspace({
        tabs: ["new-name"],
        activeSession: "new-name",
        sessionRevision: 1,
      });
      getWorkspaceMock
        .mockResolvedValueOnce(savedWorkspace({
          tabs: ["old-name"],
          activeSession: "old-name",
        }))
        .mockResolvedValue(renamedWorkspace);
      listSessionsMock
        .mockResolvedValueOnce([
          session("old-name", "$renamed"),
          session("second work", "$second"),
        ])
        .mockResolvedValue([
          session("new-name", "$renamed"),
          session("second work", "$second"),
        ]);
      updateWorkspaceActivityMock.mockImplementationOnce(() => staleSave.promise);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      const view = render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();

      act(() => openSavedWorkspaceFromDashboard?.(renamedWorkspace));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(openTabs()).toEqual(["new-name"]);
      await act(async () => {
        staleSave.resolve(savedWorkspace({
          tabs: ["old-name"],
          activeSession: "old-name",
        }));
        await Promise.resolve();
        window.dispatchEvent(new Event("pagehide"));
      });

      const body = sendBeaconMock.mock.calls.at(-1)?.[1];
      expect(body).toBeInstanceOf(Blob);
      vi.useRealTimers();
      expect(JSON.parse(await readBlobText(body as Blob))).toEqual({
        tabs: ["new-name"],
        groups: [],
        activeSession: "new-name",
        sessionRevision: 1,
      });
      view.unmount();
    });

    it("keeps newer staged activity when an older revision conflict arrives", async () => {
      vi.useFakeTimers();
      const staleSave = deferred<SavedWorkspace>();
      const renamedWorkspace = savedWorkspace({
        tabs: ["new-name"],
        activeSession: "new-name",
        sessionRevision: 1,
      });
      getWorkspaceMock
        .mockResolvedValueOnce(savedWorkspace({
          tabs: ["old-name"],
          activeSession: "old-name",
        }))
        .mockResolvedValue(renamedWorkspace);
      listSessionsMock
        .mockResolvedValueOnce([
          session("old-name", "$renamed"),
        ])
        .mockResolvedValue([
          session("new-name", "$renamed"),
        ]);
      updateWorkspaceActivityMock
        .mockImplementationOnce(() => staleSave.promise)
        .mockResolvedValue(renamedWorkspace);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();

      act(() => openSavedWorkspaceFromDashboard?.(renamedWorkspace));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(openTabs()).toEqual(["new-name"]);
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });
      expect(updateWorkspaceActivityMock).toHaveBeenCalledOnce();

      await act(async () => {
        staleSave.reject(new ApiRequestError("reload the workspace", 409));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getWorkspaceMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock).toHaveBeenLastCalledWith(
        "workspace-one",
        ["new-name"],
        [],
        "new-name",
        1,
      );
    });

    it("offers a retry after a save failure and retries the same activity", async () => {
      vi.useFakeTimers();
      const retrySave = deferred<SavedWorkspace>();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);
      updateWorkspaceActivityMock
        .mockRejectedValueOnce(new Error("disk is temporarily unavailable"))
        .mockImplementationOnce(() => retrySave.promise);
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("button", {
        name: "Resume workspace at alpha, 2 open tabs",
      })).toBeVisible();
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      const failedCall = updateWorkspaceActivityMock.mock.calls[0];
      expect(screen.getByRole("alert")).toHaveTextContent(
        "disk is temporarily unavailable",
      );

      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status", {
        name: "Workspace saved automatically",
      })).not.toBeInTheDocument();
      const recovery = screen.getByRole("complementary", {
        name: "Workspace sync recovery",
      });
      expect(recovery).toHaveTextContent("Workspace sync issue");

      const retry = within(recovery).getByRole("button", { name: "Retry" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await act(async () => {
        await Promise.resolve();
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });

      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(updateWorkspaceActivityMock.mock.calls[1]).toEqual(failedCall);
      expect(screen.getByRole("complementary", {
        name: "Workspace sync recovery",
      })).toBeVisible();

      await act(async () => {
        retrySave.resolve(savedWorkspace());
        await retrySave.promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(updateWorkspaceActivityMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Workspace sync issue" }))
        .not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", {
        name: "Workspace sync recovery",
      })).not.toBeInTheDocument();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-one",
      );
    });

    it("clears a save sync problem after navigating to an unsaved URL", async () => {
      vi.useFakeTimers();
      getWorkspaceMock.mockResolvedValue(savedWorkspace());
      listSessionsMock.mockResolvedValue([session("alpha", "$alpha")]);
      updateWorkspaceActivityMock.mockRejectedValueOnce(
        new Error("disk is temporarily unavailable"),
      );
      replaceUrl(`${BASE_PATH}/?workspace=workspace-one`);

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "disk is temporarily unavailable",
      );
      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
      expect(screen.getByRole("complementary", {
        name: "Workspace sync recovery",
      })).toBeVisible();

      act(() => {
        window.history.pushState({}, "", `${BASE_PATH}/?tab=alpha&tab=beta`);
        window.dispatchEvent(new PopStateEvent("popstate", {
          state: window.history.state,
        }));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByRole("complementary", {
        name: "Workspace sync recovery",
      })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(dashboardActiveWorkspaceId).toBeNull();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBeNull();
    });

    it("preserves the saved workspace binding while visiting snippets and returning", async () => {
      getWorkspaceMock.mockResolvedValue(savedWorkspace({
        tabs: ["ended-one", "ended-two"],
        activeSession: "ended-one",
      }));
      listSessionsMock.mockResolvedValue([]);
      replaceUrl(`${BASE_PATH}/?kind=codex&workspace=workspace-one`);
      render(<App />);
      await waitFor(() => expect(openTabs()).toEqual(["ended-one", "ended-two"]));

      fireEvent.click(screen.getByRole("button", { name: "Open snippets" }));
      expect(screen.getByRole("main", { name: "Snippets" })).toBeVisible();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-one",
      );
      expect(openTabs()).toEqual(["ended-one", "ended-two"]);

      fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
      await waitFor(() => {
        expect(screen.getByRole("main", { name: "Dashboard" })).toBeVisible();
      });
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        "workspace-one",
      );
      expect(openTabs()).toEqual(["ended-one", "ended-two"]);
    });
  });
});
