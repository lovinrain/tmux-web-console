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

function nestedWorkspace(): SessionWorkspaceState {
  return {
    openSessions: ["parent", "child", "grandchild", "sibling", "other"],
    recentSessions: ["other", "sibling", "grandchild", "child", "parent"],
    groups: [],
    parents: { child: "parent", grandchild: "child", sibling: "parent" },
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

  it.each(["parent", "child", "grandchild"])("restores %s and its original hierarchy after forgetting", (name) => {
    const before = nestedWorkspace();
    const current = removeWorkspaceSession(before, name);
    expect(restoreForgottenWorkspaceSession(name, before, current)).toEqual(before);
  });

  it.each([
    ["parent", "child"],
    ["child", "parent"],
  ])("restores forgotten ancestors in %s, %s order", (first, second) => {
    const before = nestedWorkspace();
    const current = removeWorkspaceSession(removeWorkspaceSession(before, "parent"), "child");
    const partial = restoreForgottenWorkspaceSession(first, before, current);
    expect(partial.openSessions).not.toContain(second);
    expect(partial.parents?.grandchild).toBe(first);
    expect(restoreForgottenWorkspaceSession(second, before, partial)).toEqual(before);
  });

  it("preserves a surviving child's later parent and its descendants", () => {
    const before = nestedWorkspace();
    const current: SessionWorkspaceState = {
      ...removeWorkspaceSession(before, "parent"),
      openSessions: ["sibling", "other", "child", "grandchild"],
      parents: { child: "other", grandchild: "child" },
    };
    const restored = restoreForgottenWorkspaceSession("parent", before, current);
    expect(restored.parents).toEqual({ child: "other", grandchild: "child", sibling: "parent" });
    expect(restored.openSessions.slice(
      restored.openSessions.indexOf("other"), restored.openSessions.indexOf("other") + 3,
    )).toEqual(["other", "child", "grandchild"]);
  });

  it("keeps a child promoted out of a still-surviving grandparent", () => {
    const before = nestedWorkspace();
    const current = removeWorkspaceSession(before, "child");
    delete current.parents?.grandchild;
    const restored = restoreForgottenWorkspaceSession("child", before, current);
    expect(restored.parents).toEqual({ child: "parent", sibling: "parent" });
  });

  it("does not recreate a descendant forgotten after its parent", () => {
    const before = nestedWorkspace();
    const current = removeWorkspaceSession(removeWorkspaceSession(before, "parent"), "grandchild");
    const restored = restoreForgottenWorkspaceSession("parent", before, current);
    expect(restored.openSessions).toEqual(["parent", "child", "sibling", "other"]);
    expect(restored.parents).toEqual({ child: "parent", sibling: "parent" });
  });

  it("preserves manually reopened hierarchy", () => {
    const before = nestedWorkspace();
    const current: SessionWorkspaceState = {
      ...before,
      openSessions: ["child", "grandchild", "sibling", "other", "parent"],
      parents: { grandchild: "child", parent: "other" },
    };
    expect(restoreForgottenWorkspaceSession("parent", before, current)).toBe(current);
  });

  it("preserves later group moves instead of moving the child back with its parent", () => {
    const before = nestedWorkspace();
    before.groups = [{ id: "original", name: "Original", color: "blue", collapsed: false,
      tabs: ["parent", "child", "grandchild", "sibling"] }];
    const current: SessionWorkspaceState = {
      ...removeWorkspaceSession(before, "parent"),
      openSessions: ["sibling", "other", "child", "grandchild"],
      groups: [
        { ...before.groups[0], tabs: ["sibling"] },
        { id: "new", name: "New", color: "red", collapsed: false, tabs: ["child", "grandchild"] },
      ],
    };
    const restored = restoreForgottenWorkspaceSession("parent", before, current);
    expect(restored.openSessions).toEqual(["parent", "sibling", "other", "child", "grandchild"]);
    expect(restored.parents).toEqual({ grandchild: "child", sibling: "parent" });
    expect(restored.groups).toEqual([
      { ...current.groups[0], tabs: ["parent", "sibling"] },
      current.groups[1],
    ]);
  });

  it("does not attach a restored child across its original parent's later group move", () => {
    const before = nestedWorkspace();
    const current: SessionWorkspaceState = {
      ...removeWorkspaceSession(before, "child"),
      groups: [{ id: "new", name: "New", color: "blue", collapsed: false,
        tabs: ["parent", "grandchild", "sibling"] }],
    };
    const restored = restoreForgottenWorkspaceSession("child", before, current);
    expect(restored.openSessions).toEqual(["parent", "grandchild", "sibling", "child", "other"]);
    expect(restored.parents).toEqual(current.parents);
    expect(restored.groups).toEqual(current.groups);
  });

  it("preserves a later ancestor move that would make restored child links cyclic", () => {
    const before = nestedWorkspace();
    const current: SessionWorkspaceState = {
      ...removeWorkspaceSession(before, "child"),
      openSessions: ["grandchild", "parent", "sibling", "other"],
      parents: { parent: "grandchild", sibling: "parent" },
    };
    const restored = restoreForgottenWorkspaceSession("child", before, current);
    expect(restored.parents).toEqual({ parent: "grandchild", sibling: "parent", child: "parent" });
    expect(restored.openSessions).toEqual(["grandchild", "parent", "child", "sibling", "other"]);
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
