import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY,
  MAX_PINNED_WORKSPACES,
  MAX_VISIBLE_WORKSPACES,
  NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY,
  emptyWorkspaceMemory,
  hideWorkspace,
  loadWorkspaceMemory,
  observeSessionWorkspaces,
  persistWorkspaceMemory,
  pinWorkspace,
  rankWorkspaceSuggestions,
  recordWorkspaceLaunch,
  restoreHiddenWorkspaces,
  workspacePathError,
} from "./newSessionWorkspaceMemory";

function sessionWorkspace(
  name: string,
  id: string,
  path: string,
  activity: number,
): Session {
  const paneId = `%${id.replace("$", "")}`;
  return {
    name,
    id,
    windows: 1,
    attached: 0,
    created: activity - 100,
    serverStarted: 1,
    serverPid: 100,
    activity,
    activePaneId: paneId,
    agentState: "other",
    agentStateReason: "Test session",
    agentStateChangedAt: activity,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [{
      id: paneId,
      index: 0,
      window_index: 0,
      window_name: "shell",
      window_active: true,
      active: true,
      command: "bash",
      path,
      title: name,
      width: 120,
      height: 40,
      history_size: 0,
      history_limit: 2000,
      alternate_on: false,
      dead: false,
      activity,
    }],
  };
}

beforeEach(() => window.localStorage.clear());

describe("new-session workspace memory", () => {
  it("migrates the legacy pinned-path list and ignores malformed entries", () => {
    window.localStorage.setItem(
      LEGACY_NEW_SESSION_DIRECTORIES_STORAGE_KEY,
      JSON.stringify(["/work/alpha", "relative", "/work/alpha", 7, "/work/beta"]),
    );

    const memory = loadWorkspaceMemory(window.localStorage);

    expect(memory.entries).toEqual([
      expect.objectContaining({ path: "/work/alpha", pinned: true }),
      expect.objectContaining({ path: "/work/beta", pinned: true }),
    ]);
    persistWorkspaceMemory(window.localStorage, memory);
    expect(loadWorkspaceMemory(window.localStorage)).toEqual(memory);
    expect(window.localStorage.getItem(NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY))
      .not.toBeNull();
  });

  it("bounds malformed stored pins while retaining the remaining history", () => {
    window.localStorage.setItem(
      NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: 10 }, (_, index) => ({
          path: `/work/${index}`,
          pinned: true,
          pinnedAt: index + 1,
          launches: 0,
          lastUsedAt: 0,
          lastSeenAt: 0,
          observedSessions: 0,
          sessionKeys: [],
        })),
        hiddenPaths: [],
      }),
    );

    const memory = loadWorkspaceMemory(window.localStorage);

    expect(memory.entries).toHaveLength(10);
    expect(memory.entries.filter((entry) => entry.pinned).map((entry) => entry.path))
      .toEqual(Array.from(
        { length: MAX_PINNED_WORKSPACES },
        (_, index) => `/work/${index + 2}`,
      ));
  });

  it("counts unique sessions once and blends current activity with frequency", () => {
    const now = 2_000_000_000_000;
    const nowSeconds = now / 1000;
    const sessions = [
      sessionWorkspace("alpha", "$1", "/work/shared", nowSeconds - 120),
      sessionWorkspace("beta", "$2", "/work/recent", nowSeconds),
      sessionWorkspace("gamma", "$3", "/work/shared", nowSeconds - 60),
    ];

    const observed = observeSessionWorkspaces(emptyWorkspaceMemory(), sessions);
    const observedAgain = observeSessionWorkspaces(observed, sessions);
    const ranked = rankWorkspaceSuggestions(observedAgain, sessions, now);

    expect(observedAgain).toBe(observed);
    const shared = observed.entries.find((entry) => entry.path === "/work/shared");
    expect(shared).toMatchObject({ observedSessions: 2 });
    expect(shared?.sessionKeys).toHaveLength(2);
    expect(ranked.map((entry) => entry.path)).toEqual(["/work/shared", "/work/recent"]);
    expect(ranked[0]).toMatchObject({ activeSessions: 2, reason: "active" });
  });

  it("prioritizes pins, remembers launches, and honors hide and restore", () => {
    const sessions = [sessionWorkspace("alpha", "$1", "/work/alpha", 100)];
    let memory = observeSessionWorkspaces(emptyWorkspaceMemory(), sessions);
    memory = recordWorkspaceLaunch(memory, "/work/manual", 1_000);
    memory = recordWorkspaceLaunch(memory, "/work/manual", 2_000);
    memory = pinWorkspace(memory, "/work/alpha", 3_000);

    expect(rankWorkspaceSuggestions(memory, sessions, 4_000).map((entry) => entry.path))
      .toEqual(["/work/alpha", "/work/manual"]);
    expect(memory.entries.find((entry) => entry.path === "/work/manual"))
      .toMatchObject({ launches: 2, lastUsedAt: 2_000 });

    memory = hideWorkspace(memory, "/work/alpha");
    memory = observeSessionWorkspaces(memory, sessions);
    expect(rankWorkspaceSuggestions(memory, sessions, 4_000).map((entry) => entry.path))
      .toEqual(["/work/manual"]);
    memory = restoreHiddenWorkspaces(memory);
    expect(rankWorkspaceSuggestions(memory, sessions, 4_000).map((entry) => entry.path))
      .toEqual(["/work/alpha", "/work/manual"]);
  });

  it("keeps the ranked list bounded and validates server-style absolute paths", () => {
    const sessions = Array.from({ length: MAX_VISIBLE_WORKSPACES + 4 }, (_, index) => (
      sessionWorkspace(`session-${index}`, `$${index + 1}`, `/work/${index}`, 1_000 + index)
    ));
    const memory = observeSessionWorkspaces(emptyWorkspaceMemory(), sessions);

    expect(rankWorkspaceSuggestions(memory, sessions, 2_000_000)).toHaveLength(
      MAX_VISIBLE_WORKSPACES,
    );
    expect(workspacePathError("/work/valid path")).toBeNull();
    expect(workspacePathError("relative/path")).toMatch(/absolute server path/);
    expect(workspacePathError("/work/line\nbreak")).toMatch(/control/);
  });
});
