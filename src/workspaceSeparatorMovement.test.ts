import { describe, expect, it } from "vitest";
import { adjacentSeparatorCrossing, separatorMoveTo } from "./workspaceSeparatorMovement";

describe("separatorMoveTo", () => {
  const tabs = ["a", "b", "c", "d"];
  it.each(["before", "after"] as const)("moves a line to the %s edge of a distant tab", (side) => {
    const from = { name: "a", side: "after" as const };
    const to = { name: "d", side };
    expect(separatorMoveTo(tabs, [], ["a"], from, to)).toEqual({ from, to });
    expect(tabs).toEqual(["a", "b", "c", "d"]);
  });

  it("treats equivalent anchors as the same gap and never merges occupied gaps", () => {
    const from = { name: "a", side: "after" as const };
    expect(separatorMoveTo(tabs, [], ["a"], from, { name: "b", side: "before" })).toBeNull();
    expect(separatorMoveTo(tabs, ["d"], ["a"], from, { name: "c", side: "after" })).toBeNull();
    expect(separatorMoveTo(tabs, [], ["a", "c"], from, { name: "d", side: "before" })).toBeNull();
  });

  it("rejects removed sources and destinations", () => {
    const from = { name: "a", side: "after" as const };
    expect(separatorMoveTo(tabs, [], [], from, { name: "d", side: "after" })).toBeNull();
    expect(separatorMoveTo(tabs.slice(1), [], ["a"], from, { name: "d", side: "after" })).toBeNull();
    expect(separatorMoveTo(tabs, [], ["a"], from, { name: "gone", side: "after" })).toBeNull();
  });
});

describe("adjacentSeparatorCrossing", () => {
  it("crosses either representation of the preceding separator without moving tabs", () => {
    for (const [before, after, from] of [
      [["b"], [], { name: "b", side: "before" }],
      [[], ["a"], { name: "a", side: "after" }],
    ] as const) {
      expect(adjacentSeparatorCrossing(["a", "b", "c"], ["b"], [...before], [...after], "previous"))
        .toEqual({ from, to: { name: "b", side: "after" } });
    }
  });
  it("crosses in both directions at the ends and moves contiguous selections together", () => {
    expect(adjacentSeparatorCrossing(["a", "b"], ["a", "b"], ["a"], [], "previous"))
      .toEqual({ from: { name: "a", side: "before" }, to: { name: "b", side: "after" } });
    expect(adjacentSeparatorCrossing(["a", "b"], ["b", "a"], [], ["b"], "next"))
      .toEqual({ from: { name: "b", side: "after" }, to: { name: "a", side: "before" } });
  });
  it("does not merge noncontiguous selections or lose an existing separator", () => {
    expect(adjacentSeparatorCrossing(["a", "b", "c"], ["a", "c"], ["a"], [], "previous")).toBeNull();
    expect(adjacentSeparatorCrossing(["a", "b", "c"], ["b"], ["b"], ["b"], "previous"))
      .toEqual({ from: { name: "b", side: "before" }, to: { name: "c", side: "before" } });
  });
});
