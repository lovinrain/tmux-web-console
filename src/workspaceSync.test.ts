import { describe, expect, it } from "vitest";
import { rebaseWorkspaceEdits } from "./workspaceSync";
import type { WorkspaceTabGroup } from "./workspaceState";

function group(id: string, tabs: string[], changes: Partial<WorkspaceTabGroup> = {}): WorkspaceTabGroup {
  return { id, name: id, color: "blue", collapsed: false, tabs, ...changes };
}

describe("rebaseWorkspaceEdits", () => {
  it("keeps the canonical remote snapshot when the local workspace has no edits", () => {
    const base = { tabs: ["a", "b", "c"], groups: [group("work", ["a", "b"])] };
    const remote = {
      tabs: ["d", "c", "b"],
      groups: [group("work", ["b"], { name: "Renamed", collapsed: true })],
    };
    expect(rebaseWorkspaceEdits(base, structuredClone(base), remote)).toEqual(remote);
    expect(rebaseWorkspaceEdits({ tabs: [] }, { tabs: [] }, remote)).toEqual(remote);
  });

  it("preserves simultaneous closes from two browsers", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a", "b", "c"] },
      { tabs: ["a", "c"] },
      { tabs: ["a", "b"] },
    )).toEqual({ tabs: ["a"], groups: [] });
  });

  it("keeps a remote addition while applying a local close-all", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a", "b"] },
      { tabs: [] },
      { tabs: ["a", "b", "new"] },
    ).tabs).toEqual(["new"]);
  });

  it("applies a local close without undoing a remote reorder or addition", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a", "b", "c"] },
      { tabs: ["a", "c"] },
      { tabs: ["c", "new", "b", "a"] },
    ).tabs).toEqual(["c", "new", "a"]);
  });

  it("rebases local reorder deterministically while retaining remote removals and additions", () => {
    const base = { tabs: ["a", "b", "c", "d"] };
    const local = { tabs: ["d", "c", "b", "a"] };
    const remote = { tabs: ["b", "remote", "d", "a"] };
    const result = rebaseWorkspaceEdits(base, local, remote);
    expect(result.tabs).toEqual(["d", "remote", "b", "a"]);
    expect(rebaseWorkspaceEdits(base, local, result)).toEqual(result);
  });

  it("anchors local additions beside surviving neighbors and retains remote additions", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a", "b", "c"] },
      { tabs: ["first", "a", "b", "x", "y", "c", "last"] },
      { tabs: ["remote", "a", "c"] },
    ).tabs).toEqual(["remote", "first", "a", "x", "y", "c", "last"]);
  });

  it("does not duplicate a tab added concurrently in both browsers", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a"] },
      { tabs: ["a", "new"] },
      { tabs: ["new", "a"] },
    ).tabs).toEqual(["new", "a"]);
  });

  it("preserves independent group edits and merges different fields on the same group", () => {
    const tabs = ["a", "b", "c", "d"];
    const base = { tabs, groups: [group("one", ["a", "b"]), group("two", ["c", "d"])] };
    const local = {
      tabs,
      groups: [group("one", ["a", "b"], { name: "Local name" }), group("two", ["c", "d"])],
    };
    const remote = {
      tabs,
      groups: [
        group("one", ["a", "b"], { collapsed: true }),
        group("two", ["c", "d"], { color: "green" }),
      ],
    };
    expect(rebaseWorkspaceEdits(base, local, remote).groups).toEqual([
      group("one", ["a", "b"], { name: "Local name", collapsed: true }),
      group("two", ["c", "d"], { color: "green" }),
    ]);
  });

  it("merges concurrent group member closes without reviving either session", () => {
    expect(rebaseWorkspaceEdits(
      { tabs: ["a", "b", "c"], groups: [group("one", ["a", "b", "c"])] },
      { tabs: ["a", "c"], groups: [group("one", ["a", "c"], { color: "red" })] },
      { tabs: ["a", "b", "new"], groups: [group("one", ["a", "b", "new"])] },
    )).toEqual({ tabs: ["a", "new"], groups: [group("one", ["a", "new"], { color: "red" })] });
  });

  it("preserves group deletions in either browser and independently created groups", () => {
    const tabs = ["a", "b", "c", "d"];
    expect(rebaseWorkspaceEdits(
      { tabs, groups: [group("one", ["a"]), group("two", ["b"])] },
      { tabs, groups: [group("two", ["b"], { name: "Stale edit" }), group("local", ["c"])] },
      { tabs, groups: [group("one", ["a"]), group("remote", ["d"])] },
    ).groups).toEqual([group("local", ["c"]), group("remote", ["d"])]);
  });

  it("gives an intentional local group assignment precedence over a concurrent remote assignment", () => {
    const tabs = ["a", "b", "c"];
    expect(rebaseWorkspaceEdits(
      { tabs, groups: [group("one", ["a"]), group("two", ["c"])] },
      { tabs, groups: [group("one", ["a"]), group("two", ["b", "c"])] },
      { tabs, groups: [group("one", ["a", "b"]), group("two", ["c"])] },
    ).groups).toEqual([group("one", ["a"]), group("two", ["b", "c"])]);
  });

  it("normalizes groups against the final tab order without mutating any input", () => {
    const base = { tabs: ["a", "b", "c"], groups: [group("one", ["a", "b"])] };
    const local = { tabs: ["b", "a", "c"], groups: [group("one", ["b", "a"])] };
    const remote = { tabs: ["a", "b", "c"], groups: [group("one", ["a", "b"], { color: "pink" })] };
    const originals = structuredClone([base, local, remote]);
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      tabs: ["b", "a", "c"],
      groups: [group("one", ["b", "a"], { color: "pink" })],
    });
    expect([base, local, remote]).toEqual(originals);
  });
});
