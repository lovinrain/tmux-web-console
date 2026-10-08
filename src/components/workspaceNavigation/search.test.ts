import { describe, expect, it } from "vitest";
import type { WorkspaceTabGroup } from "../../workspaceState";
import { searchWorkspaceTabs } from "./search";
import { session } from "./testFixtures";

describe("workspace tab search order", () => {
  it("ranks title and tmux-name matches ahead of group-only matches", () => {
    const entries = [
      session({ name: "title-exact", customTitle: "needle" }),
      session({ name: "needle", customTitle: "Different title" }),
      session({ name: "title-prefix", customTitle: "Needle project" }),
      session({ name: "needle-name", customTitle: "Different title" }),
      session({ name: "title-contains", customTitle: "Project needle" }),
      session({ name: "contains-needle", customTitle: "Different title" }),
      session({ name: "group-exact", customTitle: "Different title" }),
      session({ name: "group-prefix", customTitle: "Different title" }),
      session({ name: "group-contains", customTitle: "Different title" }),
      session({ name: "unmatched", customTitle: "Different title" }),
    ];
    const groups = new Map<string, WorkspaceTabGroup>([
      ["group-exact", { id: "exact", name: "Needle", color: "blue", tabs: ["group-exact"], collapsed: false }],
      ["group-prefix", { id: "prefix", name: "Needle group", color: "blue", tabs: ["group-prefix"], collapsed: false }],
      ["group-contains", { id: "contains", name: "Group needle", color: "blue", tabs: ["group-contains"], collapsed: false }],
    ]);
    const order = entries.map((item) => item.name).reverse();
    const results = searchWorkspaceTabs(order, new Map(entries.map((item) => [item.name, item])), groups, "needle");
    expect(results.map((item) => item.sessionName)).toEqual(entries.slice(0, -1).map((item) => item.name));
  });

  it("keeps workspace order when matches have the same relevance", () => {
    const entries = [
      session({ name: "first", customTitle: "Needle project", activity: 1 }),
      session({ name: "second", customTitle: "Needle project", activity: 100 }),
    ];
    const results = searchWorkspaceTabs(["second", "first"], new Map(entries.map((item) => [item.name, item])), new Map(), "needle");
    expect(results.map((item) => item.sessionName)).toEqual(["second", "first"]);
  });

  it("keeps ended tabs searchable by their tmux name", () => {
    const results = searchWorkspaceTabs(["ended-session"], new Map(), new Map(), "ended");
    expect(results).toEqual([expect.objectContaining({
      sessionName: "ended-session", title: "ended-session", session: undefined,
    })]);
  });

  it("preserves the open-tab order for an empty search", () => {
    const entries = [session({ name: "alpha", activity: 100 }), session({ name: "beta", activity: 1 })];
    const results = searchWorkspaceTabs(["beta", "ended", "alpha"], new Map(entries.map((item) => [item.name, item])), new Map(), "");
    expect(results.map((item) => item.sessionName)).toEqual(["beta", "ended", "alpha"]);
  });
});
