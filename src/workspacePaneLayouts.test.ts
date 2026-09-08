import { describe, expect, it } from "vitest";
import type { WorkspacePaneLayout } from "./api";
import {
  adjacentWorkspacePaneId,
  assignWorkspacePaneSession,
  canSplitWorkspacePane,
  createWorkspacePaneLayout,
  reconcileWorkspacePaneLayouts,
  removeWorkspacePane,
  renameWorkspacePaneSession,
  resizeWorkspacePaneSplit,
  splitWorkspacePane,
  workspacePaneLeaves,
  workspacePaneSessions,
} from "./workspacePaneLayouts";

function idFactory() {
  let index = 0;
  return (prefix: "layout" | "pane" | "split") => `${prefix}-${++index}`;
}

function pair(): WorkspacePaneLayout {
  return {
    id: "pair",
    name: "Pair",
    root: {
      id: "root",
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { id: "left", kind: "pane", session: "alpha" },
      second: { id: "right", kind: "pane", session: "beta" },
    },
  };
}

describe("workspace pane layouts", () => {
  it("finds the nearest geometrically adjacent pane without wrapping", () => {
    const panes = [
      { id: "left", left: 0, right: 40, top: 0, bottom: 100 },
      { id: "top-right", left: 48, right: 100, top: 0, bottom: 46 },
      { id: "bottom-right", left: 48, right: 100, top: 54, bottom: 100 },
    ];

    expect(adjacentWorkspacePaneId(panes, "left", "right")).toBe("top-right");
    expect(adjacentWorkspacePaneId(panes, "top-right", "down")).toBe("bottom-right");
    expect(adjacentWorkspacePaneId(panes, "bottom-right", "left")).toBe("left");
    expect(adjacentWorkspacePaneId(panes, "left", "down")).toBeNull();
    expect(adjacentWorkspacePaneId(panes, "top-right", "right")).toBeNull();
  });

  it("creates uniquely named layouts and recursively splits panes", () => {
    const ids = idFactory();
    const first = createWorkspacePaneLayout([], "alpha", ids);
    const second = createWorkspacePaneLayout([first], "beta", ids);
    expect(first.name).toBe("Pane view 1");
    expect(second.name).toBe("Pane view 2");

    const two = splitWorkspacePane(first, first.root.id, "horizontal", ids);
    const empty = workspacePaneLeaves(two.root).find((pane) => !pane.session)!;
    const three = splitWorkspacePane(two, empty.id, "vertical", ids);
    expect(workspacePaneLeaves(three.root)).toHaveLength(3);
    expect(three.root).toMatchObject({ kind: "split", direction: "horizontal" });
  });

  it("moves a session assignment instead of duplicating it", () => {
    const layout = assignWorkspacePaneSession(pair(), "right", "alpha");
    expect(workspacePaneSessions(layout)).toEqual(["alpha"]);
    expect(workspacePaneLeaves(layout.root)).toEqual([
      { id: "left", kind: "pane", session: null },
      { id: "right", kind: "pane", session: "alpha" },
    ]);
  });

  it("stops splitting when a branch reaches the persisted depth limit", () => {
    const ids = idFactory();
    let layout = createWorkspacePaneLayout([], "alpha", ids);
    for (let depth = 1; depth < 6; depth += 1) {
      const target = workspacePaneLeaves(layout.root).at(-1)!;
      expect(canSplitWorkspacePane(layout, target.id)).toBe(true);
      layout = splitWorkspacePane(layout, target.id, "horizontal", ids);
    }
    const deepest = workspacePaneLeaves(layout.root).at(-1)!;
    expect(canSplitWorkspacePane(layout, deepest.id)).toBe(false);
    expect(splitWorkspacePane(layout, deepest.id, "vertical", ids)).toBe(layout);
  });

  it("collapses a removed pane into its sibling and keeps one empty root", () => {
    const collapsed = removeWorkspacePane(pair(), "left");
    expect(collapsed.root).toEqual({ id: "right", kind: "pane", session: "beta" });
    const emptied = removeWorkspacePane(collapsed, "right");
    expect(emptied.root).toEqual({ id: "right", kind: "pane", session: null });
  });

  it("bounds split ratios and reconciles removed or duplicate sessions", () => {
    const resized = resizeWorkspacePaneSplit(pair(), "root", 0.99);
    expect(resized.root).toMatchObject({ ratio: 0.85 });
    const source = pair();
    if (source.root.kind !== "split") throw new Error("expected split fixture");
    const duplicate: WorkspacePaneLayout = {
      ...source,
      root: {
        ...source.root,
        second: { id: "right", kind: "pane", session: "alpha" },
      },
    };
    expect(workspacePaneLeaves(
      reconcileWorkspacePaneLayouts([duplicate], ["alpha"])[0].root,
    ).map((pane) => pane.session)).toEqual(["alpha", null]);
  });

  it("follows session renames without introducing a duplicate", () => {
    const renamed = renameWorkspacePaneSession([pair()], "alpha", "beta")[0];
    expect(workspacePaneLeaves(renamed.root).map((pane) => pane.session)).toEqual([
      "beta",
      null,
    ]);
  });
});
