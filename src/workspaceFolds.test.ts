import { describe, expect, it } from "vitest";
import {
  foldWorkspaceTabs, normalizeWorkspaceTabFolds, unfoldWorkspaceTabs,
  workspaceFoldMembers, workspaceFoldSelectionError,
} from "./workspaceFolds";
import {
  closeWorkspaceSession, isolatedWorkspaceSearch, renameWorkspaceSession, reparentWorkspaceSession,
  restoreWorkspaceTabs, searchWithWorkspaceState, searchWithoutWorkspaceTabs,
  visitWorkspaceSession, workspaceFoldsFromSearch, type SessionWorkspaceState,
} from "./workspaceState";
import { rebaseWorkspaceEdits } from "./workspaceSync";

function tree(): SessionWorkspaceState {
  return {
    openSessions: ["root", "a", "a-child", "gap", "b", "other"],
    recentSessions: ["a-child", "root"], groups: [],
    parents: { a: "root", "a-child": "a", gap: "root", b: "root" },
  };
}

describe("workspace tab folds", () => {
  it("folds nonadjacent sibling branches without moving or reparenting sessions", () => {
    const original = tree();
    const folded = foldWorkspaceTabs(original, ["b", "a-child", "a"], "fold");
    expect(folded).toEqual({ ...original, folds: [{ id: "fold", tabs: ["a", "b"] }] });
    expect(workspaceFoldMembers(folded.folds![0], folded.openSessions, folded.parents))
      .toEqual(["a", "a-child", "b"]);
    expect(folded.openSessions).toBe(original.openSessions);
    expect(folded.parents).toBe(original.parents);
    expect(unfoldWorkspaceTabs(folded, "fold")).toEqual(original);
  });

  it("allows a selected branch with multiple sessions to become one placeholder", () => {
    expect(foldWorkspaceTabs(tree(), ["a", "a-child"], "branch").folds)
      .toEqual([{ id: "branch", tabs: ["a"] }]);
  });

  it.each([["a", "other"], ["a-child", "b"], ["root", "other", "a"]])(
    "requires sibling roots for %j", (...names) => {
      // Selecting a parent also selects its descendants; root + other is valid.
      const selected = names as string[];
      const valid = selected.includes("root");
      expect(workspaceFoldSelectionError(tree(), selected) === null).toBe(valid);
    },
  );

  it("preserves named group membership and rejects folds across group boundaries", () => {
    const state = tree();
    state.groups = [{ id: "family", name: "Family", color: "blue", collapsed: false, tabs: state.openSessions.slice(0, 5) }];
    expect(foldWorkspaceTabs(state, ["a", "b"], "fold").groups).toBe(state.groups);
    expect(workspaceFoldSelectionError(state, ["root", "other"])).toContain("same group");
  });

  it("canonicalizes malformed, overlapping, deleted and reordered fold metadata", () => {
    const state = tree();
    expect(normalizeWorkspaceTabFolds([
      null, { id: "bad id", tabs: ["a", "b"] },
      { id: "fold", tabs: ["missing", "b", "a", "a"] },
      { id: "overlap", tabs: ["a"] }, { id: "fold", tabs: ["root", "other"] },
      { id: "one", tabs: ["other"] },
    ], state.openSessions, state.parents)).toEqual([{ id: "fold", tabs: ["a", "b"] }]);
    expect(workspaceFoldSelectionError(state, ["missing"])).toContain("at least two");
  });

  it("persists URL folds, removes them from isolated routes and preserves collapsed active folds on restore", () => {
    const state = foldWorkspaceTabs(tree(), ["a", "b"], "fold");
    const search = searchWithWorkspaceState("?view=list", state.openSessions, state.groups, state.parents, state.folds);
    expect(workspaceFoldsFromSearch(search, state.openSessions)).toEqual(state.folds);
    expect(searchWithoutWorkspaceTabs(search)).toBe("?view=list");
    expect(workspaceFoldsFromSearch(isolatedWorkspaceSearch(search, state.openSessions), state.openSessions)).toEqual([]);
    expect(restoreWorkspaceTabs(tree(), "a-child", state.openSessions, state.groups, state.parents, state.folds).folds).toEqual(state.folds);
  });

  it("reveals an explicitly visited hidden session without changing its tree", () => {
    const state = foldWorkspaceTabs(tree(), ["a", "b"], "fold");
    const visited = visitWorkspaceSession(state, "a-child");
    expect(visited.folds).toBeUndefined();
    expect(visited.parents).toEqual(state.parents);
    expect(visited.recentSessions[0]).toBe("a-child");
  });

  it("reconciles close, rename and reparent operations without hiding an unrelated session", () => {
    const state = foldWorkspaceTabs(tree(), ["a", "b"], "fold");
    const renamed = renameWorkspaceSession(state, "a", "renamed");
    expect(renamed.folds).toEqual([{ id: "fold", tabs: ["renamed", "b"] }]);
    expect(renamed.parents?.["a-child"]).toBe("renamed");
    expect(closeWorkspaceSession(state, "a-child").folds).toEqual(state.folds);
    expect(closeWorkspaceSession(state, "a").folds).toBeUndefined();
    expect(reparentWorkspaceSession(state, "b", "other").folds).toBeUndefined();
    expect(workspaceFoldSelectionError(state, ["root", "other"])).toContain("Unfold");
  });

  it("merges independent fold creation and tab edits from another browser", () => {
    const base = { tabs: ["a", "gap", "b", "c", "d"], groups: [] };
    const local = { ...base, folds: [{ id: "local", tabs: ["a", "b"] }] };
    const remote = { ...base, tabs: [...base.tabs, "new"], folds: [{ id: "remote", tabs: ["c", "d"] }] };
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      ...remote, folds: [...local.folds, ...remote.folds],
    });
  });

  it("does not revive folds removed locally or remotely in a concurrent edit", () => {
    const base = { tabs: ["a", "b", "c"], groups: [], folds: [{ id: "fold", tabs: ["a", "b"] }] };
    const unfolded = { ...base, folds: [] };
    const stale = { ...base, tabs: [...base.tabs, "new"] };
    expect(rebaseWorkspaceEdits(base, unfolded, stale).folds).toBeUndefined();
    expect(rebaseWorkspaceEdits(base, stale, unfolded).folds).toBeUndefined();
  });

  it("keeps the deliberate local assignment when two browsers create overlapping folds", () => {
    const base = { tabs: ["a", "b", "c"], groups: [] };
    const local = { ...base, folds: [{ id: "local", tabs: ["a", "c"] }] };
    const remote = { ...base, folds: [{ id: "remote", tabs: ["a", "b"] }] };
    expect(rebaseWorkspaceEdits(base, local, remote).folds).toEqual(local.folds);
  });
});
