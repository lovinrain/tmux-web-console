import { describe, expect, it } from "vitest";
import { adjacentSeparatorCrossing } from "./workspaceSeparatorMovement";

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
