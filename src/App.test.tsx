import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_PATH } from "./api";
import { App } from "./App";
import type { Session } from "./types";
import { searchWithoutWorkspaceTabs } from "./workspaceState";

let pendingNewSessionCompletion: ((session: string) => void) | null = null;
let reportSessionRename: (
  (
    previousName: string,
    nextName: string,
    sessionId: string,
    warnings?: readonly string[],
  ) => void
) | null = null;
let reportKnownSessions: ((sessions: Session[]) => void) | null = null;

vi.mock("./components/SessionDashboard", () => ({
  SessionDashboard: ({
    onOpen,
    onOpenSnippets,
    onNewSession,
    onSessionsChange,
  }: {
    onOpen: (session: string) => void;
    onOpenSnippets: () => void;
    onNewSession: () => void;
    onSessionsChange?: (sessions: Session[]) => void;
  }) => {
    reportKnownSessions = onSessionsChange ?? null;
    return (
      <main aria-label="Dashboard" data-search={window.location.search}>
        <button type="button" onClick={() => onOpen("work/name #1")}>Open test session</button>
        <button type="button" onClick={() => onOpen("second work")}>Open second session</button>
        <button type="button" onClick={() => onOpen("alpha")}>Open alpha session</button>
        <button type="button" onClick={onOpenSnippets}>Open snippets</button>
        <button type="button" onClick={onNewSession}>New session</button>
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
  }: {
    onCreated: (session: string) => void;
    onCancel: () => void;
    sessionNavigation?: ReactNode;
  }) => {
    pendingNewSessionCompletion = onCreated;
    return (
      <main aria-label="New session view">
        {sessionNavigation}
        <button type="button" onClick={() => onCreated("fresh/session")}>Create test session</button>
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
    onBack,
    sessionNavigation,
    barVisibility,
    onBarVisibilityChange,
    onSessionsChange,
    onSessionRenamed,
    renameWarning,
    onDismissRenameWarning,
  }: {
    sessionName: string;
    onBack: () => void;
    sessionNavigation?: ReactNode;
    barVisibility: {
      sessionTabs: boolean;
      stagedInput: boolean;
      shortcuts: boolean;
    };
    onBarVisibilityChange: (
      bar: "sessionTabs" | "stagedInput" | "shortcuts",
      visible: boolean,
    ) => void;
    onSessionsChange?: (sessions: Session[]) => void;
    onSessionRenamed?: (
      previousName: string,
      nextName: string,
      sessionId: string,
      warnings?: readonly string[],
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
    const bars = [
      ["sessionTabs", "Session tabs", "muxdeck-session-tabs"],
      ["stagedInput", "Staged input", "muxdeck-staged-input"],
      ["shortcuts", "Terminal shortcut buttons", "muxdeck-terminal-shortcuts"],
    ] as const;
    return (
      <main aria-label="Console" data-session={sessionName}>
        <div role="group" aria-label="Console bars">
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

function session(name: string, id: string): Session {
  return {
    name,
    id,
    windows: 1,
    attached: 0,
    created: 1,
    activity: 1,
    activePaneId: null,
    agentState: "other",
    agentStateReason: "Test session",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [],
  };
}

describe("App routing", () => {
  beforeEach(() => {
    pendingNewSessionCompletion = null;
    reportSessionRename = null;
    reportKnownSessions = null;
    replaceUrl(dashboardUrl());
  });

  it("preserves dashboard query state when opening a session and using application Back", async () => {
    const search = "?kind=claude&state=working&sort=state&sort=title";
    replaceUrl(dashboardUrl(search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Dashboard" })).toHaveAttribute("data-search", search);

    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByText("work/name #1")).toBeVisible();
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

  it("appends a late creation result without pulling the user away from another session", () => {
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

  it("replaces a directly opened session deep link with the dashboard fallback", () => {
    const search = "?kind=codex&sort=title";
    replaceUrl(sessionUrl("direct%20work", search));
    render(<App />);

    expect(screen.getByRole("main", { name: "Console" })).toBeVisible();
    expect(screen.getByText("direct work")).toBeVisible();

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

  it("keeps console bar choices across SPA navigation and resets them on remount", async () => {
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open test session" }));

    const tabsToggle = screen.getByRole("button", { name: "Session tabs" });
    const inputToggle = screen.getByRole("button", { name: "Staged input" });
    const shortcutsToggle = screen.getByRole("button", {
      name: "Terminal shortcut buttons",
    });
    const routeBeforeToggles = window.location.href;

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

    expect(screen.getByRole("button", { name: "Session tabs" })).toBePressed();
    expect(screen.getByRole("button", { name: "Staged input" })).toBePressed();
    expect(screen.getByRole("button", {
      name: "Terminal shortcut buttons",
    })).toBePressed();
    expect(screen.getByRole("navigation", { name: "Session workspace" })).toBeVisible();
    expect(document.getElementById("muxdeck-staged-input")).toBeVisible();
    expect(document.getElementById("muxdeck-terminal-shortcuts")).toBeVisible();
  });
});
