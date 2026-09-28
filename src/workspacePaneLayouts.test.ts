import { describe, expect, it } from "vitest";
import type { WorkspacePaneLayout } from "./api";
import {
  adjacentWorkspacePaneId,
  assignWorkspacePaneSession,
  canSplitWorkspacePane,
  createWorkspacePaneLayout,
  dropWorkspacePaneSession,
  reconcileWorkspacePaneLayouts,
  removeWorkspacePane,
  renameWorkspacePaneSession,
  resizeWorkspacePaneSplit,
  splitWorkspacePane,
  workspacePaneLeaves,
  workspacePaneDropRegion,
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
  it.each([
    [0.1, 0.5, "left"], [0.9, 0.5, "right"],
    [0.5, 0.1, "top"], [0.5, 0.9, "bottom"],
    [0.5, 0.5, "center"], [0.3, 0.7, "center"],
    [0.1, 0.2, "left"], [0.2, 0.1, "top"],
    [0.8, 0.9, "bottom"], [0.9, 0.8, "right"],
  ] as const)("maps normalized drop point %s,%s to %s", (x, y, region) => {
    // A non-square pane at a page offset uses the same visible regions.
    expect(workspacePaneDropRegion(100 + x * 800, 50 + y * 300, {
      left: 100, top: 50, width: 800, height: 300,
    })).toBe(region);
  });

  it.each([
    ["left", "horizontal", true], ["right", "horizontal", false],
    ["top", "vertical", true], ["bottom", "vertical", false],
  ] as const)("splits on the %s and moves the grabbed session exactly once", (region, direction, before) => {
    const source = pair();
    const next = dropWorkspacePaneSession(source, "right", "alpha", region, idFactory());
    expect(workspacePaneLeaves(source.root).map((pane) => pane.session)).toEqual(["alpha", "beta"]);
    expect(next.root).toMatchObject({
      first: { id: "left", session: null },
      second: {
        kind: "split", direction, ratio: 0.5,
        first: before ? { session: "alpha" } : { id: "right", session: "beta" },
        second: before ? { id: "right", session: "beta" } : { session: "alpha" },
      },
    });
    expect(workspacePaneLeaves(next.root)).toHaveLength(3);
    expect(workspacePaneSessions(next).filter((session) => session === "alpha")).toHaveLength(1);
  });

  it("replaces in the center, ignores self-splits and missing targets, and respects pane limits", () => {
    const source = pair();
    expect(dropWorkspacePaneSession(source, "right", "alpha", "center"))
      .toEqual(assignWorkspacePaneSession(source, "right", "alpha"));
    expect(dropWorkspacePaneSession(source, "right", "beta", "top")).toBe(source);
    expect(dropWorkspacePaneSession(source, "missing", "alpha", "left")).toBe(source);
    const ids = idFactory();
    let capped = source;
    // Split the shallowest branch first so the pane-count limit is reached first.
    const queue = ["left", "right"];
    while (workspacePaneLeaves(capped.root).length < 12) {
      const paneId = queue.shift()!;
      const previous = new Set(workspacePaneLeaves(capped.root).map((pane) => pane.id));
      capped = splitWorkspacePane(capped, paneId, "horizontal", ids);
      queue.push(paneId, workspacePaneLeaves(capped.root).find((pane) => !previous.has(pane.id))!.id);
    }
    expect(dropWorkspacePaneSession(capped, "right", "gamma", "bottom")).toBe(capped);
    expect(dropWorkspacePaneSession(capped, "right", "gamma", "center")).not.toBe(capped);
  });

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
    expect(dropWorkspacePaneSession(layout, deepest.id, "beta", "right", ids)).toBe(layout);
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
