import { describe, expect, it } from "vitest";
import { independentForkHref } from "./forkSync";
import {
  searchWithSavedWorkspaceId,
  searchWithWorkspaceState,
  workspaceFoldsFromSearch,
  workspaceGroupsFromSearch,
  workspaceParentsFromSearch,
  workspaceTabsFromSearch,
} from "./workspaceState";
import { MAX_WORKSPACE_REQUEST_TARGET_BYTES, workspaceHref, workspaceSearchFromLocation } from "./workspaceUrl";

const tabs = Array.from({ length: 96 }, (_, index) => (
  `worker-${index}-${"long-session-name-".repeat(3)}`
));
tabs[5] = "worker-5-报告 & review+#";
const groups = [{ id: "workers", name: "Workers", color: "blue" as const, collapsed: false, tabs }];
const parents = Object.fromEntries(tabs.slice(1).map((name) => [name, tabs[0]]));
const folds = [{ id: "fold", tabs: tabs.slice(2, 4) }];

function largeSearch(saved: boolean): string {
  const search = searchWithWorkspaceState("?view=list&tag=a&tag=b", tabs, groups, parents, folds);
  return searchWithSavedWorkspaceId(search, saved ? "saved-id" : null);
}

describe("workspace URL transport", () => {
  it("keeps short legacy queries and ordinary anchors unchanged", () => {
    const search = "?q=a%20b&tab=api&tab=web&workspace=saved";
    const href = workspaceHref("/mux/session/api", search, "#details");
    expect(href).toBe(`/mux/session/api${search}#details`);
    expect(workspaceSearchFromLocation(new URL(href, "https://muxdeck.test"))).toBe(search);
  });

  it.each([true, false])("round-trips an oversized workspace (saved=%s) without HTTP layout parameters", (saved) => {
    const search = largeSearch(saved);
    expect(search.length).toBeGreaterThan(8190);
    const url = new URL(workspaceHref("/mux/session/worker-0", search), "https://muxdeck.test");
    expect(url.pathname.length + url.search.length).toBeLessThan(MAX_WORKSPACE_REQUEST_TARGET_BYTES);
    expect(url.searchParams.get("view")).toBe("list");
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(url.searchParams.get("workspace")).toBe(saved ? "saved-id" : null);
    for (const name of ["tab", "tab-group", "tab-parent", "tab-fold"]) {
      expect(url.searchParams.has(name)).toBe(false);
    }
    const restored = workspaceSearchFromLocation(url);
    expect(restored).toBe(search);
    expect(workspaceTabsFromSearch(restored)).toEqual(tabs);
    expect(workspaceGroupsFromSearch(restored, tabs)).toEqual(groups);
    expect(workspaceParentsFromSearch(restored, tabs)).toEqual(parents);
    expect(workspaceFoldsFromSearch(restored, tabs)).toEqual(folds);
  });

  it("takes changed and removed controls only from the actual query", () => {
    const url = new URL(workspaceHref("/mux/session/worker-0", largeSearch(true)), "https://muxdeck.test");
    url.search = "?view=cards&workspace=other&new=1";
    const restored = workspaceSearchFromLocation(url);
    const params = new URLSearchParams(restored);
    expect(params.get("view")).toBe("cards");
    expect(params.get("workspace")).toBe("other");
    expect(params.getAll("tag")).toEqual([]);
    expect(params.get("new")).toBe("1");
    expect(workspaceTabsFromSearch(restored)).toEqual(tabs);
  });

  it("does not restore a removed linked-tab group from the fragment", () => {
    const search = largeSearch(true) + "&fork-sync=pair";
    const linked = new URL(workspaceHref("/mux/session/worker-0", search), "https://muxdeck.test");
    const independent = new URL(independentForkHref(linked.href));
    expect(new URLSearchParams(workspaceSearchFromLocation(independent)).has("fork-sync")).toBe(false);
    expect(workspaceTabsFromSearch(workspaceSearchFromLocation(independent))).toEqual(tabs);
  });

  it("prefers explicit query metadata to a stale fragment", () => {
    const url = new URL(workspaceHref("/mux/session/worker-0", largeSearch(true)), "https://muxdeck.test");
    url.search = "?workspace=saved-id&tab=replacement";
    expect(workspaceSearchFromLocation(url)).toBe(url.search);
  });

  it("clears obsolete workspace fragments when the workspace becomes small", () => {
    const url = new URL(workspaceHref("/mux/session/worker-0", largeSearch(false), "#details"), "https://muxdeck.test");
    expect(workspaceSearchFromLocation(url)).toBe(largeSearch(false));
    expect(workspaceHref("/mux/session/api", "?tab=api", url.hash)).toBe("/mux/session/api?tab=api#details");
  });

  it("ignores unrelated fragments and fragments without workspace fields", () => {
    expect(workspaceSearchFromLocation({ search: "?view=list", hash: "#other?tab=bad" })).toBe("?view=list");
    expect(workspaceSearchFromLocation({ search: "?view=list", hash: "#muxdeck-workspace?workspace=bad&view=cards" }))
      .toBe("?view=list");
  });
});
