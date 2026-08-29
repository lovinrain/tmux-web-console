import { describe, expect, it } from "vitest";
import {
  clearClosedWorkspaceHistory,
  closeWorkspaceSession,
  createSessionWorkspace,
  isolatedWorkspaceSearch,
  moveWorkspaceTabGroup,
  moveWorkspaceSession,
  removeWorkspaceTabGroup,
  renameWorkspaceSession,
  restoreWorkspaceTabs,
  savedWorkspaceIdFromSearch,
  searchWithSavedWorkspaceId,
  searchWithoutWorkspaceTabs,
  searchWithWorkspaceState,
  searchWithWorkspaceTabs,
  setWorkspaceTabGroup,
  setWorkspaceTabGroupCollapsed,
  sessionAfterClose,
  stableSortWorkspaceSessionsByWorkingState,
  visitWorkspaceSession,
  workspaceGroupsFromSearch,
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
      { openSessions: ["stale"], recentSessions: [], groups: [] },
      "gamma",
      ["alpha", "", "alpha", "beta"],
    )).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "beta", "alpha"],
      groups: [],
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

  it("round-trips one saved workspace binding without disturbing tabs or filters", () => {
    const original = "?kind=codex&workspace=old&tab=alpha&%77orkspace=duplicate";

    const bound = searchWithSavedWorkspaceId(original, "work/id #1");

    expect(bound).toBe("?kind=codex&tab=alpha&workspace=work%2Fid%20%231");
    expect(savedWorkspaceIdFromSearch(bound)).toBe("work/id #1");
    expect(searchWithSavedWorkspaceId(bound, null)).toBe("?kind=codex&tab=alpha");
    expect(savedWorkspaceIdFromSearch("?workspace=&workspace=ignored")).toBeNull();
  });

  it("isolates one requested tab from every saved workspace tab and group parameter", () => {
    const group = encodeURIComponent(JSON.stringify({
      id: "old_group",
      name: "Old group",
      color: "blue",
      collapsed: false,
      tabs: ["alpha", "beta"],
    }));
    const original = (
      "?kind=codex&raw=%2f%2F&flag&workspace=saved%2Fone"
      + `&tab=alpha&%74ab=beta&tab-group=${group}&%74ab-group=${group}`
      + "&empty=&%77orkspace=duplicate"
    );

    const isolated = isolatedWorkspaceSearch(original, ["requested"]);

    expect(isolated).toBe("?kind=codex&raw=%2f%2F&flag&empty=&tab=requested");
    expect(savedWorkspaceIdFromSearch(isolated)).toBeNull();
    expect(workspaceTabsFromSearch(isolated)).toEqual(["requested"]);
    expect(new URLSearchParams(isolated).getAll("tab-group")).toEqual([]);
  });

  it("encodes a special-character session name in an otherwise raw isolated query", () => {
    const sessionName = "work/name #1+%&=,";

    const isolated = isolatedWorkspaceSearch(
      "?keep=a+b&raw=%2f%2F&tab=stale&workspace=old",
      [sessionName],
    );

    expect(isolated).toBe(
      "?keep=a+b&raw=%2f%2F&tab=work%2Fname%20%231%2B%25%26%3D%2C",
    );
    expect(workspaceTabsFromSearch(isolated)).toEqual([sessionName]);
  });

  it("round-trips ordered tab groups without colliding with dashboard grouping", () => {
    const tabs = ["alpha", "beta", "gamma", "delta"];
    const groups = [
      {
        id: "build_group",
        name: "Build lane",
        color: "cyan" as const,
        collapsed: true,
        tabs: ["beta", "gamma"],
      },
    ];

    const serialized = searchWithWorkspaceState(
      "?group=agent&kind=claude&tab=old&tab-group=broken",
      tabs,
      groups,
    );

    expect(new URLSearchParams(serialized).get("group")).toBe("agent");
    expect(workspaceTabsFromSearch(serialized)).toEqual(tabs);
    expect(workspaceGroupsFromSearch(serialized, tabs)).toEqual(groups);
    expect(new URLSearchParams(serialized).getAll("tab-group")).toHaveLength(1);
    expect(searchWithoutWorkspaceTabs(serialized)).toBe("?group=agent&kind=claude");
  });

  it("drops malformed, overlapping, and non-contiguous URL groups", () => {
    const tabs = ["alpha", "beta", "gamma", "delta"];
    const invalid = encodeURIComponent(JSON.stringify({
      id: "first",
      name: "First",
      color: "blue",
      collapsed: false,
      tabs: ["alpha", "gamma"],
    }));
    const valid = encodeURIComponent(JSON.stringify({
      id: "second",
      name: "Second",
      color: "green",
      collapsed: false,
      tabs: ["beta", "gamma"],
    }));
    const serialized = `?tab-group=${invalid}&tab-group=${valid}`;

    expect(workspaceGroupsFromSearch(serialized, tabs)).toEqual([
      {
        id: "second",
        name: "Second",
        color: "green",
        collapsed: false,
        tabs: ["beta", "gamma"],
      },
    ]);
    expect(workspaceGroupsFromSearch("?tab-group=%7Bbad", tabs)).toEqual([]);
  });

  it("restores dashboard tabs without requiring or inventing an active session", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["stale"],
      recentSessions: ["previous", "alpha"],
      groups: [],
    };
    const orderedTabs = workspaceTabsFromSearch("?tab=alpha&tab=beta");

    const restored = restoreWorkspaceTabs(workspace, undefined, orderedTabs);

    expect(restored).toEqual({
      openSessions: ["alpha", "beta"],
      recentSessions: ["previous", "alpha", "beta"],
      groups: [],
    });
    expect(restoreWorkspaceTabs(restored, undefined, [])).toEqual({
      openSessions: [],
      recentSessions: ["previous", "alpha", "beta"],
      groups: [],
    });
  });

  it("preserves visit history, promotes the active session, and avoids duplicate recents", () => {
    const restored = restoreWorkspaceTabs(
      {
        openSessions: ["old"],
        recentSessions: ["old", "closed", "beta"],
        groups: [],
      },
      "gamma",
      ["alpha", "beta", "gamma"],
    );

    expect(restored).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "old", "closed", "beta", "alpha"],
      groups: [],
    });
    expect(new Set(restored.recentSessions).size).toBe(restored.recentSessions.length);
    expect(restoreWorkspaceTabs(restored, "gamma", restored.openSessions)).toBe(restored);
  });

  it("preserves a collapsed active group while restoring URL or saved state", () => {
    const groups = [{
      id: "review",
      name: "Review",
      color: "orange" as const,
      collapsed: true,
      tabs: ["alpha", "beta"],
    }];
    const restored = restoreWorkspaceTabs(
      { openSessions: [], recentSessions: [], groups: [] },
      "alpha",
      ["alpha", "beta"],
      groups,
    );

    expect(restored.groups).toEqual(groups);
  });
});

describe("session workspace state", () => {
  it("starts empty or seeds the active session as both open and most recent", () => {
    expect(createSessionWorkspace()).toEqual({
      openSessions: [],
      recentSessions: [],
      groups: [],
    });
    expect(createSessionWorkspace("alpha")).toEqual({
      openSessions: ["alpha"],
      recentSessions: ["alpha"],
      groups: [],
    });
  });

  it("opens new visits, preserves tab order, and promotes revisits in MRU order", () => {
    const initial = createSessionWorkspace("alpha");
    const afterBeta = visitWorkspaceSession(initial, "beta");
    const afterGamma = visitWorkspaceSession(afterBeta, "gamma");

    expect(afterGamma).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "beta", "alpha"],
      groups: [],
    });

    const revisited = visitWorkspaceSession(afterGamma, "alpha");
    expect(revisited).toEqual({
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["alpha", "gamma", "beta"],
      groups: [],
    });
    expect(visitWorkspaceSession(revisited, "alpha")).toBe(revisited);
  });

  it("keeps only the 30 most recent visits while retaining every open tab", () => {
    let workspace: SessionWorkspaceState = {
      openSessions: [],
      recentSessions: [],
      groups: [],
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
      groups: [],
    };

    const closed = closeWorkspaceSession(workspace, "alpha");
    expect(closed).toEqual({
      openSessions: ["beta"],
      recentSessions: ["beta", "alpha", "ended"],
      groups: [],
    });
    expect(closeWorkspaceSession(closed, "missing")).toBe(closed);

    expect(visitWorkspaceSession(closed, "alpha")).toEqual({
      openSessions: ["beta", "alpha"],
      recentSessions: ["alpha", "beta", "ended"],
      groups: [],
    });
  });

  it("moves an open tab to an exact target index without changing visit history", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma", "delta"],
      recentSessions: ["gamma", "closed", "beta", "alpha"],
      groups: [],
    };

    const movedLeft = moveWorkspaceSession(workspace, "gamma", 0);
    expect(movedLeft).toEqual({
      openSessions: ["gamma", "alpha", "beta", "delta"],
      recentSessions: ["gamma", "closed", "beta", "alpha"],
      groups: [],
    });
    expect(movedLeft).not.toBe(workspace);
    expect(movedLeft.openSessions).not.toBe(workspace.openSessions);
    expect(movedLeft.recentSessions).toBe(workspace.recentSessions);
    expect(workspace.openSessions).toEqual(["alpha", "beta", "gamma", "delta"]);

    expect(moveWorkspaceSession(workspace, "beta", 3)).toEqual({
      openSessions: ["alpha", "gamma", "delta", "beta"],
      recentSessions: workspace.recentSessions,
      groups: [],
    });
  });

  it("clamps out-of-range target indices to the first and last tab", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["beta", "ended", "alpha"],
      groups: [],
    };

    expect(moveWorkspaceSession(workspace, "gamma", -100).openSessions).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(moveWorkspaceSession(workspace, "alpha", 100).openSessions).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
  });

  it("returns the original workspace for missing tabs, no-ops, and invalid indices", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["gamma", "beta", "alpha", "closed"],
      groups: [],
    };

    expect(moveWorkspaceSession(workspace, "missing", 0)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "beta", 1)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "alpha", -1)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "gamma", 99)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "beta", 1.5)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "beta", Number.NaN)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "beta", Number.POSITIVE_INFINITY)).toBe(workspace);
  });

  it("stable-sorts non-working tabs before working tabs without changing visit history", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["working-a", "idle-a", "working-b", "idle-b"],
      recentSessions: ["working-b", "idle-a", "closed"],
      groups: [],
    };

    const sorted = stableSortWorkspaceSessionsByWorkingState(
      workspace,
      new Set(["working-a", "working-b"]),
    );

    expect(sorted.openSessions).toEqual([
      "idle-a",
      "idle-b",
      "working-a",
      "working-b",
    ]);
    expect(sorted.recentSessions).toBe(workspace.recentSessions);
    expect(stableSortWorkspaceSessionsByWorkingState(
      sorted,
      new Set(["working-a", "working-b"]),
    )).toBe(sorted);
  });

  it("keeps tab groups atomic while stable-sorting their blocks and members", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: [
        "working-a",
        "group-working",
        "group-idle",
        "idle-a",
        "idle-group",
        "working-b",
      ],
      recentSessions: ["group-working"],
      groups: [
        {
          id: "mixed",
          name: "Mixed",
          color: "cyan",
          collapsed: false,
          tabs: ["group-working", "group-idle"],
        },
        {
          id: "idle",
          name: "Idle",
          color: "gray",
          collapsed: true,
          tabs: ["idle-group"],
        },
      ],
    };

    const sorted = stableSortWorkspaceSessionsByWorkingState(
      workspace,
      new Set(["working-a", "group-working", "working-b"]),
    );

    expect(sorted.openSessions).toEqual([
      "idle-a",
      "idle-group",
      "working-a",
      "group-idle",
      "group-working",
      "working-b",
    ]);
    expect(sorted.groups.map((group) => group.id)).toEqual(["idle", "mixed"]);
    expect(sorted.groups[1].tabs).toEqual(["group-idle", "group-working"]);
    expect(sorted.groups[0].collapsed).toBe(true);
  });

  it("renames a real session everywhere without changing tab or visit order", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "old/name", "omega"],
      recentSessions: ["omega", "old/name", "alpha"],
      groups: [],
    };

    expect(renameWorkspaceSession(workspace, "old/name", "new name")).toEqual({
      openSessions: ["alpha", "new name", "omega"],
      recentSessions: ["omega", "new name", "alpha"],
      groups: [],
    });
    expect(renameWorkspaceSession(workspace, "missing", "new name")).toBe(workspace);
    expect(renameWorkspaceSession(workspace, "old/name", "old/name")).toBe(workspace);
  });

  it("deduplicates a defensive rename collision while preserving first position", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "old", "new", "omega"],
      recentSessions: ["new", "old", "alpha"],
      groups: [],
    };

    expect(renameWorkspaceSession(workspace, "old", "new")).toEqual({
      openSessions: ["alpha", "new", "omega"],
      recentSessions: ["new", "alpha"],
      groups: [],
    });
  });

  it("clears only closed history and returns the same state when no cleanup is needed", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta"],
      recentSessions: ["ended", "beta", "alpha", "older"],
      groups: [],
    };

    const cleared = clearClosedWorkspaceHistory(workspace);
    expect(cleared).toEqual({
      openSessions: ["alpha", "beta"],
      recentSessions: ["beta", "alpha"],
      groups: [],
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

  it("creates a contiguous group and moves selected tabs out of earlier groups", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma", "delta", "epsilon"],
      recentSessions: ["epsilon", "alpha"],
      groups: [{
        id: "old",
        name: "Old",
        color: "gray",
        collapsed: false,
        tabs: ["gamma", "delta"],
      }],
    };

    const grouped = setWorkspaceTabGroup(workspace, {
      id: "build",
      name: "  Build  ",
      color: "cyan",
      collapsed: false,
      tabs: ["delta", "beta"],
    });

    expect(grouped.openSessions).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
      "epsilon",
    ]);
    expect(grouped.groups).toEqual([
      {
        id: "build",
        name: "Build",
        color: "cyan",
        collapsed: false,
        tabs: ["beta", "delta"],
      },
      {
        id: "old",
        name: "Old",
        color: "gray",
        collapsed: false,
        tabs: ["gamma"],
      },
    ]);
    expect(grouped.recentSessions).toBe(workspace.recentSessions);
  });

  it("does not split the remaining members when regrouping a middle tab", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma", "delta"],
      recentSessions: ["beta"],
      groups: [{
        id: "old",
        name: "Old",
        color: "gray",
        collapsed: false,
        tabs: ["alpha", "beta", "gamma"],
      }],
    };

    expect(setWorkspaceTabGroup(workspace, {
      id: "new",
      name: "New",
      color: "blue",
      collapsed: false,
      tabs: ["beta", "delta"],
    })).toEqual({
      openSessions: ["alpha", "gamma", "beta", "delta"],
      recentSessions: ["beta"],
      groups: [
        {
          id: "old",
          name: "Old",
          color: "gray",
          collapsed: false,
          tabs: ["alpha", "gamma"],
        },
        {
          id: "new",
          name: "New",
          color: "blue",
          collapsed: false,
          tabs: ["beta", "delta"],
        },
      ],
    });
  });

  it("treats groups as atomic blocks during individual tab moves", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma", "delta"],
      recentSessions: ["alpha"],
      groups: [{
        id: "pair",
        name: "Pair",
        color: "blue",
        collapsed: false,
        tabs: ["beta", "gamma"],
      }],
    };

    const movedAcross = moveWorkspaceSession(workspace, "alpha", 1);
    expect(movedAcross.openSessions).toEqual(["beta", "gamma", "alpha", "delta"]);
    expect(movedAcross.groups[0].tabs).toEqual(["beta", "gamma"]);
    expect(moveWorkspaceSession(workspace, "beta", 0)).toBe(workspace);
    expect(moveWorkspaceSession(workspace, "beta", 2).openSessions).toEqual([
      "alpha",
      "gamma",
      "beta",
      "delta",
    ]);
  });

  it("moves a whole group across adjacent tabs and groups", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma", "delta", "epsilon"],
      recentSessions: [],
      groups: [
        {
          id: "first",
          name: "First",
          color: "green",
          collapsed: false,
          tabs: ["beta", "gamma"],
        },
        {
          id: "second",
          name: "Second",
          color: "orange",
          collapsed: false,
          tabs: ["delta", "epsilon"],
        },
      ],
    };

    const moved = moveWorkspaceTabGroup(workspace, "second", -1);
    expect(moved.openSessions).toEqual(["alpha", "delta", "epsilon", "beta", "gamma"]);
    expect(moved.groups.map((group) => group.id)).toEqual(["second", "first"]);
    expect(moveWorkspaceTabGroup(moved, "second", -1).openSessions).toEqual([
      "delta",
      "epsilon",
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("persists collapse state, expands on visit, and removes group metadata only", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "beta", "gamma"],
      recentSessions: ["alpha"],
      groups: [{
        id: "work",
        name: "Work",
        color: "purple",
        collapsed: false,
        tabs: ["beta", "gamma"],
      }],
    };

    const collapsed = setWorkspaceTabGroupCollapsed(workspace, "work", true);
    expect(collapsed.groups[0].collapsed).toBe(true);
    expect(visitWorkspaceSession(collapsed, "beta").groups[0].collapsed).toBe(false);
    expect(removeWorkspaceTabGroup(collapsed, "work")).toEqual({
      ...workspace,
      groups: [],
    });
  });

  it("keeps group membership valid when tabs close or native sessions rename", () => {
    const workspace: SessionWorkspaceState = {
      openSessions: ["alpha", "old", "gamma"],
      recentSessions: ["old", "alpha"],
      groups: [{
        id: "work",
        name: "Work",
        color: "red",
        collapsed: false,
        tabs: ["old", "gamma"],
      }],
    };

    const renamed = renameWorkspaceSession(workspace, "old", "new");
    expect(renamed.groups[0].tabs).toEqual(["new", "gamma"]);
    const oneLeft = closeWorkspaceSession(renamed, "new");
    expect(oneLeft.groups[0].tabs).toEqual(["gamma"]);
    expect(closeWorkspaceSession(oneLeft, "gamma").groups).toEqual([]);
  });

  it("lets a renamed source win group membership in inverse-order collisions", () => {
    const renamed = renameWorkspaceSession({
      openSessions: ["new", "middle", "old", "friend"],
      recentSessions: ["old", "new"],
      groups: [
        {
          id: "stale",
          name: "Stale target",
          color: "gray",
          collapsed: false,
          tabs: ["new"],
        },
        {
          id: "source",
          name: "Live source",
          color: "green",
          collapsed: true,
          tabs: ["old", "friend"],
        },
      ],
    }, "old", "new");

    expect(renamed.openSessions).toEqual(["middle", "new", "friend"]);
    expect(renamed.groups).toEqual([{
      id: "source",
      name: "Live source",
      color: "green",
      collapsed: true,
      tabs: ["new", "friend"],
    }]);
  });
});
