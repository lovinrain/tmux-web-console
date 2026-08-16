import { describe, expect, it } from "vitest";
import {
  clearClosedWorkspaceHistory,
  closeWorkspaceSession,
  createSessionWorkspace,
  renameWorkspaceSession,
  restoreWorkspaceTabs,
  searchWithoutWorkspaceTabs,
  searchWithWorkspaceTabs,
  sessionAfterClose,
  visitWorkspaceSession,
  workspaceTabsFromSearch,
  type SessionWorkspaceState,
} from "./workspaceState";

describe("workspace tab URL state", () => {
  it("round-trips ordered repeated tabs while preserving raw non-tab query pieces", () => {
    const original = "?kind=codex&raw=%2f%2F&flag&sort=state&tab=stale&sort=title";

    const serialized = searchWithWorkspaceTabs(original, ["zeta", "alpha", "third"]);

    expect(serialized).toBe(
      "?kind=codex&raw=%2f%2F&flag&sort=state&sort=title"
      + "&tab=zeta&tab=alpha&tab=third",
    );
    expect(workspaceTabsFromSearch(serialized)).toEqual(["zeta", "alpha", "third"]);
  });

  it("canonicalizes duplicate and empty tabs and appends a missing active session", () => {
    const nonCanonical = "?tab=alpha&tab=&tab=alpha&tab=beta";

    expect(workspaceTabsFromSearch(nonCanonical, "gamma")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(workspaceTabsFromSearch(nonCanonical, "beta")).toEqual(["alpha", "beta"]);
    expect(searchWithWorkspaceTabs(nonCanonical, ["alpha", "", "alpha", "beta"]))
      .toBe("?tab=alpha&tab=beta");

    expect(restoreWorkspaceTabs(
      { openSessions: ["stale"], recentSessions: [] },
      "gamma",
      ["alpha", "", "alpha", "beta"],
    )).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "beta", "alpha"],
    });
  });

  it("round-trips session names containing reserved and ambiguous ASCII characters", () => {
    const sessionNames = [
      "slash/name",
      "comma,name",
      "amp&name",
      "equals=name",
      "plus+name",
      "percent%name",
      "hash#name",
      "space name",
    ];

    const serialized = searchWithWorkspaceTabs("?keep=a+b", sessionNames);

    expect(serialized).toBe(
      "?keep=a+b&tab=slash%2Fname&tab=comma%2Cname&tab=amp%26name"
      + "&tab=equals%3Dname&tab=plus%2Bname&tab=percent%25name"
      + "&tab=hash%23name&tab=space%20name",
    );
    expect(workspaceTabsFromSearch(serialized)).toEqual(sessionNames);
  });

  it("removes every workspace tab without rewriting the remaining query", () => {
    const search = "?tab=alpha&kind=codex&%74ab=encoded&flag&tab=beta&empty=";

    expect(searchWithoutWorkspaceTabs(search)).toBe("?kind=codex&flag&empty=");
    expect(searchWithWorkspaceTabs(search, [])).toBe("?kind=codex&flag&empty=");
    expect(searchWithoutWorkspaceTabs("?tab=only")).toBe("");
  });

  it("restores dashboard tabs without requiring or inventing an active session", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["stale"],
      recentSessions: ["previous", "alpha"],
    };
    const orderedTabs = workspaceTabsFromSearch("?tab=alpha&tab=beta");

    const restored = restoreWorkspaceTabs(workspace, undefined, orderedTabs);

    expect(restored).toEqual({
      openSessions: ["alpha", "beta"],
      recentSessions: ["previous", "alpha", "beta"],
    });
    expect(restoreWorkspaceTabs(restored, undefined, [])).toEqual({
      openSessions: [],
      recentSessions: ["previous", "alpha", "beta"],
    });
  });

  it("preserves visit history, promotes the active session, and avoids duplicate recents", () => {
    const restored = restoreWorkspaceTabs(
      {
        openSessions: ["old"],
        recentSessions: ["old", "closed", "beta"],
      },
      "gamma",
      ["alpha", "beta", "gamma"],
    );

    expect(restored).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "old", "closed", "beta", "alpha"],
    });
    expect(new Set(restored.recentSessions).size).toBe(restored.recentSessions.length);
    expect(restoreWorkspaceTabs(restored, "gamma", restored.openSessions)).toBe(restored);
  });
});

describe("session workspace state", () => {
  it("starts empty or seeds the active session as both open and most recent", () => {
    expect(createSessionWorkspace()).toEqual({
      openSessions: [],
      recentSessions: [],
    });
    expect(createSessionWorkspace("alpha")).toEqual({
      openSessions: ["alpha"],
      recentSessions: ["alpha"],
    });
  });

  it("opens new visits, preserves tab order, and promotes revisits in MRU order", () => {
    const initial = createSessionWorkspace("alpha");
    const afterBeta = visitWorkspaceSession(initial, "beta");
    const afterGamma = visitWorkspaceSession(afterBeta, "gamma");

    expect(afterGamma).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "beta", "alpha"],
    });

    const revisited = visitWorkspaceSession(afterGamma, "alpha");
    expect(revisited).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["alpha", "gamma", "beta"],
    });
    expect(visitWorkspaceSession(revisited, "alpha")).toBe(revisited);
  });

  it("keeps only the 30 most recent visits while retaining every open tab", () => {
    let workspace: SessionWorkspaceState = {
      openSessions: [],
      recentSessions: [],
    };

    for (let index = 0; index < 32; index += 1) {
      workspace = visitWorkspaceSession(workspace, `session-${index}`);
    }

    expect(workspace.openSessions).toHaveLength(32);
    expect(workspace.recentSessions).toHaveLength(30);
    expect(workspace.recentSessions.slice(0, 2)).toEqual(["session-31", "session-30"]);
    expect(workspace.recentSessions).not.toContain("session-0");
    expect(workspace.recentSessions).not.toContain("session-1");
  });

  it("closes and reopens tabs without discarding their visit trail", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta"],
      recentSessions: ["beta", "alpha", "ended"],
    };

    const closed = closeWorkspaceSession(workspace, "alpha");
    expect(closed).toEqual({
      openSessions: ["beta"],
      recentSessions: ["beta", "alpha", "ended"],
    });
    expect(closeWorkspaceSession(closed, "missing")).toBe(closed);

    expect(visitWorkspaceSession(closed, "alpha")).toEqual({
      openSessions: ["beta", "alpha"],
      recentSessions: ["alpha", "beta", "ended"],
    });
  });

  it("renames a real session everywhere without changing tab or visit order", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "old/name", "omega"],
      recentSessions: ["omega", "old/name", "alpha"],
    };

    expect(renameWorkspaceSession(workspace, "old/name", "new name")).toEqual({
      openSessions: ["alpha", "new name", "omega"],
      recentSessions: ["omega", "new name", "alpha"],
    });
    expect(renameWorkspaceSession(workspace, "missing", "new name")).toBe(workspace);
    expect(renameWorkspaceSession(workspace, "old/name", "old/name")).toBe(workspace);
  });

  it("deduplicates a defensive rename collision while preserving first position", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "old", "new", "omega"],
      recentSessions: ["new", "old", "alpha"],
    };

    expect(renameWorkspaceSession(workspace, "old", "new")).toEqual({
      openSessions: ["alpha", "new", "omega"],
      recentSessions: ["new", "alpha"],
    });
  });

  it("clears only closed history and returns the same state when no cleanup is needed", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta"],
      recentSessions: ["ended", "beta", "alpha", "older"],
    };

    const cleared = clearClosedWorkspaceHistory(workspace);
    expect(cleared).toEqual({
      openSessions: ["alpha", "beta"],
      recentSessions: ["beta", "alpha"],
    });
    expect(clearClosedWorkspaceHistory(cleared)).toBe(cleared);
  });

  it("chooses the adjacent tab after a close and handles missing fallbacks", () => {
    const open = ["alpha", "beta", "gamma"];

    expect(sessionAfterClose(open, "alpha")).toBe("beta");
    expect(sessionAfterClose(open, "beta")).toBe("gamma");
    expect(sessionAfterClose(open, "gamma")).toBe("beta");
    expect(sessionAfterClose(["alpha"], "alpha")).toBeNull();
    expect(sessionAfterClose(open, "missing")).toBeNull();
  });
});
