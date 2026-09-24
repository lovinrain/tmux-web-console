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

  it("preserves the remote hierarchy when the local workspace has no edits", () => {
    const base = {
      tabs: ["parent", "child", "other"],
      parents: { child: "parent" },
    };
    const remote = {
      tabs: ["other", "child", "grandchild", "parent"],
      groups: [],
      parents: { child: "other", grandchild: "child" },
    };
    expect(rebaseWorkspaceEdits(base, structuredClone(base), remote)).toEqual(remote);
  });

  it("merges concurrent child additions into the parent tree and group", () => {
    const base = {
      tabs: ["parent", "other"],
      groups: [group("work", ["parent"])],
    };
    const local = {
      tabs: ["parent", "local-child", "other"],
      parents: { "local-child": "parent" },
      groups: [group("work", ["parent", "local-child"])],
    };
    const remote = {
      tabs: ["parent", "remote-child", "other"],
      parents: { "remote-child": "parent" },
      groups: [group("work", ["parent", "remote-child"], { color: "orange" })],
    };
    const result = rebaseWorkspaceEdits(base, local, remote);
    expect(result).toEqual({
      tabs: ["parent", "local-child", "remote-child", "other"],
      parents: { "local-child": "parent", "remote-child": "parent" },
      groups: [group("work", ["parent", "local-child", "remote-child"], { color: "orange" })],
    });
    expect(rebaseWorkspaceEdits(base, local, result)).toEqual(result);
  });

  it("promotes a new child when another browser closes its parent", () => {
    const base = {
      tabs: ["root", "parent", "child", "other"],
      parents: { parent: "root", child: "parent" },
    };
    const local = {
      tabs: ["root", "parent", "child", "new-child", "other"],
      parents: { ...base.parents, "new-child": "parent" },
    };
    const remote = {
      tabs: ["root", "child", "other"],
      parents: { child: "root" },
    };
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      tabs: ["root", "child", "new-child", "other"],
      parents: { child: "root", "new-child": "root" },
      groups: [],
    });
  });

  it("promotes remote child additions when their parent is closed locally", () => {
    const base = {
      tabs: ["root", "parent", "child", "other"],
      parents: { parent: "root", child: "parent" },
    };
    const local = {
      tabs: ["root", "child", "other"],
      parents: { child: "root" },
    };
    const remote = {
      tabs: ["root", "parent", "child", "new-child", "other"],
      parents: { ...base.parents, "new-child": "parent" },
    };
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      tabs: ["root", "child", "new-child", "other"],
      parents: { child: "root", "new-child": "root" },
      groups: [],
    });
  });

  it("preserves a remote reparent when a local close only implicitly promotes the child", () => {
    const base = {
      tabs: ["root", "parent", "child", "other"],
      parents: { parent: "root", child: "parent" },
    };
    const local = {
      tabs: ["root", "child", "other"],
      parents: { child: "root" },
    };
    const remote = {
      tabs: ["root", "parent", "other", "child"],
      parents: { parent: "root", child: "other" },
    };
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      tabs: ["root", "other", "child"],
      parents: { child: "other" },
      groups: [],
    });
  });

  it("combines independent reparenting while an intentional local parent edit wins conflicts", () => {
    const base = {
      tabs: ["a", "child", "second-child", "b", "c"],
      parents: { child: "a", "second-child": "a" },
    };
    const local = {
      tabs: ["a", "second-child", "b", "child", "c"],
      parents: { child: "b", "second-child": "a" },
    };
    const remote = {
      tabs: ["a", "b", "c", "child", "second-child"],
      parents: { child: "c", "second-child": "c" },
    };
    expect(rebaseWorkspaceEdits(base, local, remote)).toEqual({
      tabs: ["a", "b", "child", "c", "second-child"],
      parents: { child: "b", "second-child": "c" },
      groups: [],
    });
  });

  it("does not resurrect a remotely closed child through stale local hierarchy edits", () => {
    const base = {
      tabs: ["a", "child", "b"],
      parents: { child: "a" },
    };
    expect(rebaseWorkspaceEdits(
      base,
      { tabs: ["a", "b", "child"], parents: { child: "b" } },
      { tabs: ["a", "b"] },
    )).toEqual({ tabs: ["a", "b"], groups: [] });
  });

  it("makes new children roots when no ancestor survives concurrent closes", () => {
    const base = {
      tabs: ["root", "parent"],
      parents: { parent: "root" },
    };
    expect(rebaseWorkspaceEdits(
      base,
      { tabs: ["root", "parent", "new-child"], parents: { ...base.parents, "new-child": "parent" } },
      { tabs: [] },
    )).toEqual({ tabs: ["new-child"], groups: [] });
  });

  it("keeps a newly added child with its tree after the parent changes groups remotely", () => {
    const base = {
      tabs: ["parent", "first", "second"],
      groups: [group("one", ["parent", "first"]), group("two", ["second"])],
    };
    const local = {
      tabs: ["parent", "child", "first", "second"],
      parents: { child: "parent" },
      groups: [group("one", ["parent", "child", "first"]), group("two", ["second"])],
    };
    const remote = {
      tabs: ["first", "second", "parent"],
      groups: [group("one", ["first"]), group("two", ["second", "parent"])],
    };
    const result = rebaseWorkspaceEdits(base, local, remote);
    expect(result).toEqual({
      tabs: ["first", "second", "parent", "child"],
      parents: { child: "parent" },
      groups: [group("one", ["first"]), group("two", ["second", "parent", "child"])],
    });
  });

  it("merges hierarchy for session names that match JavaScript object properties", () => {
    const parents = Object.fromEntries([["__proto__", "parent"], ["constructor", "parent"]]);
    expect(rebaseWorkspaceEdits(
      { tabs: ["parent"] },
      { tabs: ["parent", "__proto__", "constructor"], parents },
      { tabs: ["parent"] },
    )).toEqual({
      tabs: ["parent", "__proto__", "constructor"],
      parents,
      groups: [],
    });
  });

  it("does not regroup a remotely ungrouped tree through a stale child's inherited group", () => {
    const base = {
      tabs: ["parent", "other"],
      groups: [group("one", ["parent", "other"])],
    };
    expect(rebaseWorkspaceEdits(
      base,
      {
        tabs: ["parent", "child", "other"],
        parents: { child: "parent" },
        groups: [group("one", ["parent", "child", "other"])],
      },
      { tabs: ["parent", "other"], groups: [group("one", ["other"])] },
    )).toEqual({
      tabs: ["parent", "child", "other"],
      parents: { child: "parent" },
      groups: [group("one", ["other"])],
    });
  });
});
