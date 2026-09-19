import { describe, expect, it } from "vitest";
import type { WorkspacePaneLayout } from "./api";
import {
  restoreForgottenPaneLayouts,
  restoreForgottenWorkspaceSession,
} from "./forgottenWorkspace";
import {
  assignWorkspacePaneSession,
  reconcileWorkspacePaneLayouts,
  removeWorkspacePane,
  resizeWorkspacePaneSplit,
} from "./workspacePaneLayouts";
import { removeWorkspaceSession, type SessionWorkspaceState } from "./workspaceState";

function workspace(): SessionWorkspaceState {
  return {
    openSessions: ["alpha", "beta", "gamma", "delta"],
    recentSessions: ["delta", "gamma", "beta", "alpha", "closed"],
    groups: [{
      id: "group", name: "Work", color: "blue", collapsed: true,
      tabs: ["beta", "gamma"],
    }],
  };
}

function layout(): WorkspacePaneLayout {
  return {
    id: "layout", name: "Original",
    root: {
      id: "split", kind: "split", direction: "horizontal", ratio: 0.4,
      first: { id: "left", kind: "pane", session: "beta" },
      second: { id: "right", kind: "pane", session: "gamma" },
    },
  };
}

describe("restoreForgottenWorkspaceSession", () => {
  it("restores the original tab, recent order and collapsed group membership", () => {
    const before = workspace();
    const current = removeWorkspaceSession(before, "beta");
    expect(restoreForgottenWorkspaceSession("beta", before, current)).toEqual(before);
    expect(current.openSessions).toEqual(["alpha", "gamma", "delta"]);
  });

  it("restores recent-only entries without opening a tab", () => {
    const before = workspace();
    const current = removeWorkspaceSession(before, "closed");
    expect(restoreForgottenWorkspaceSession("closed", before, current)).toEqual(before);
  });

  it("keeps later additions, deletions, ordering and group metadata edits", () => {
    const before = workspace();
    const current: SessionWorkspaceState = {
      openSessions: ["delta", "gamma", "new"],
      recentSessions: ["new", "gamma", "delta"],
      groups: [{ ...before.groups[0], name: "Renamed", color: "red", collapsed: false, tabs: ["gamma"] }],
    };
    expect(restoreForgottenWorkspaceSession("beta", before, current)).toEqual({
      openSessions: ["delta", "beta", "gamma", "new"],
      recentSessions: ["new", "gamma", "beta", "delta"],
      groups: [{ ...current.groups[0], tabs: ["beta", "gamma"] }],
    });
  });

  it.each([
    ["beta", "gamma"],
    ["gamma", "beta"],
  ])("restores multiple forgotten sessions in %s, %s order from a shared baseline", (first, second) => {
    const before = workspace();
    const current = removeWorkspaceSession(removeWorkspaceSession(before, "beta"), "gamma");
    const partial = restoreForgottenWorkspaceSession(first, before, current);
    expect(partial.openSessions).not.toContain(second);
    expect(partial.recentSessions).not.toContain(second);
    expect(partial.groups[0].tabs).toEqual([first]);
    expect(restoreForgottenWorkspaceSession(second, before, partial)).toEqual(before);
  });

  it("retains a session's new position and membership if manually reopened", () => {
    const before = workspace();
    const current: SessionWorkspaceState = {
      openSessions: ["beta", "alpha", "gamma", "delta"],
      recentSessions: [...before.recentSessions],
      groups: [{ ...before.groups[0], id: "another", tabs: ["beta", "alpha"] }],
    };
    expect(restoreForgottenWorkspaceSession("beta", before, current)).toBe(current);
  });

  it("does not split a newly created unrelated group at the old insertion position", () => {
    const before = workspace();
    before.groups = [];
    const current = removeWorkspaceSession(before, "beta");
    current.groups = [{ id: "new", name: "New", color: "red", collapsed: false, tabs: ["alpha", "gamma"] }];
    const restored = restoreForgottenWorkspaceSession("beta", before, current);
    expect(restored.openSessions).toEqual(["alpha", "gamma", "beta", "delta"]);
    expect(restored.groups).toEqual(current.groups);
  });

  it("does not resurrect removed members when recreating an emptied group", () => {
    const before = workspace();
    const current = removeWorkspaceSession(removeWorkspaceSession(before, "beta"), "gamma");
    const restored = restoreForgottenWorkspaceSession("beta", before, current);
    expect(restored.groups).toEqual([{ ...before.groups[0], tabs: ["beta"] }]);
    expect(restored.openSessions).toEqual(["alpha", "beta", "delta"]);
  });

  it("does nothing when the session was never in this workspace", () => {
    const current = workspace();
    expect(restoreForgottenWorkspaceSession("unknown", workspace(), current)).toBe(current);
  });
});

describe("restoreForgottenPaneLayouts", () => {
  it("restores cleared assignments while preserving later names and split ratios", () => {
    const before = [layout()];
    const current = reconcileWorkspacePaneLayouts(before, ["gamma"]);
    current[0] = { ...resizeWorkspacePaneSplit(current[0], "split", 0.7), name: "Renamed" };
    const restored = restoreForgottenPaneLayouts("beta", before, current, ["beta", "gamma"]);
    expect(restored).toEqual([{ ...resizeWorkspacePaneSplit(before[0], "split", 0.7), name: "Renamed" }]);
    expect(current[0].root).toMatchObject({ first: { session: null } });
  });

  it("restores each of several forgotten sessions independently", () => {
    const before = [layout()];
    const current = reconcileWorkspacePaneLayouts(before, []);
    const partial = restoreForgottenPaneLayouts("gamma", before, current, ["gamma"]);
    expect(partial[0].root).toMatchObject({ first: { session: null }, second: { session: "gamma" } });
    expect(restoreForgottenPaneLayouts("beta", before, partial, ["beta", "gamma"])).toEqual(before);
  });

  it("keeps newer pane assignments", () => {
    const before = [layout()];
    const current = [assignWorkspacePaneSession(before[0], "left", "new")];
    expect(restoreForgottenPaneLayouts("beta", before, current, ["beta", "gamma", "new"])).toEqual(current);
  });

  it("keeps a forgotten session if the user already placed it in a different pane", () => {
    const before = [layout()];
    const current = [assignWorkspacePaneSession(before[0], "right", "beta")];
    expect(restoreForgottenPaneLayouts("beta", before, current, ["beta", "gamma"])).toEqual(current);
  });

  it("does not recreate layouts or panes removed after Forget", () => {
    const before = [layout()];
    expect(restoreForgottenPaneLayouts("beta", before, [], ["beta"])).toEqual([]);
    const current = [removeWorkspacePane(before[0], "left")];
    expect(restoreForgottenPaneLayouts("beta", before, current, ["beta", "gamma"])).toEqual(current);
  });

  it("does not assign panes when the session's tab has not been restored", () => {
    const before = [layout()];
    const current = reconcileWorkspacePaneLayouts(before, ["gamma"]);
    expect(restoreForgottenPaneLayouts("beta", before, current, ["gamma"])).toEqual(current);
  });
});
