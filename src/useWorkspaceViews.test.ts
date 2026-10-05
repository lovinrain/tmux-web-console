import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceViewSnapshot } from "./api";
import { useWorkspaceViews } from "./useWorkspaceViews";

const api = vi.hoisted(() => ({
  getWorkspaceViews: vi.fn(), evictWorkspaceView: vi.fn(), resumeWorkspaceView: vi.fn(),
}));
vi.mock("./api", () => api);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  window.sessionStorage.clear();
  api.getWorkspaceViews.mockResolvedValue({ views: [], evicted: false });
  api.resumeWorkspaceView.mockResolvedValue(undefined);
  api.evictWorkspaceView.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps identity stable across polling and counts the saved workspace independently of its sync group", async () => {
  const hook = renderHook(({ search }) => useWorkspaceViews("one", search, ["alpha"]), {
    initialProps: { search: "?fork-sync=linked" },
  });
  await act(async () => {});
  const identity = hook.result.current.identity;
  expect(identity).toMatchObject({ scope: "workspace:one", group: "linked" });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api.getWorkspaceViews).toHaveBeenCalledTimes(2);
  expect(hook.result.current.identity).toBe(identity);
  hook.rerender({ search: "" });
  await act(async () => {});
  expect(hook.result.current.identity).toMatchObject({ id: identity.id, scope: "workspace:one", group: null });
  await act(async () => { await hook.result.current.evict("another-view"); });
  expect(api.evictWorkspaceView).toHaveBeenCalledWith("workspace:one", ["alpha"], identity.id, "another-view");
});

it("persists a missed eviction across reload and preserves paused state when Rejoin fails", async () => {
  api.getWorkspaceViews.mockResolvedValue({ views: [], evicted: true });
  const original = renderHook(() => useWorkspaceViews(null, "?fork-sync=linked", ["alpha"]));
  await act(async () => {});
  expect(original.result.current.paused).toBe(true);
  const oldId = original.result.current.identity.id;
  original.unmount();
  api.getWorkspaceViews.mockResolvedValue({ views: [], evicted: false });
  const reloaded = renderHook(() => useWorkspaceViews(null, "?fork-sync=linked", ["alpha"]));
  await act(async () => {});
  expect(reloaded.result.current.identity.id).not.toBe(oldId);
  expect(reloaded.result.current.paused).toBe(true);
  api.resumeWorkspaceView.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await expect(reloaded.result.current.resume()).rejects.toThrow("offline"); });
  expect(reloaded.result.current.paused).toBe(true);
  await act(async () => { await reloaded.result.current.resume(); });
  expect(reloaded.result.current.paused).toBe(false);
});

it("ignores a stale eviction snapshot after explicit Rejoin or workspace navigation", async () => {
  let resolveOld: (snapshot: WorkspaceViewSnapshot) => void = () => {};
  api.getWorkspaceViews.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const hook = renderHook(({ workspace }) => useWorkspaceViews(workspace, "", ["alpha"]), {
    initialProps: { workspace: "one" },
  });
  act(() => hook.result.current.pause());
  await act(async () => { await hook.result.current.resume(); });
  await act(async () => { resolveOld({ views: [], evicted: true }); });
  expect(hook.result.current.paused).toBe(false);
  api.getWorkspaceViews.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  act(() => hook.result.current.refresh());
  hook.rerender({ workspace: "two" });
  await act(async () => { resolveOld({ views: [], evicted: true }); });
  expect(hook.result.current.paused).toBe(false);
  expect(hook.result.current.identity.scope).toBe("workspace:two");
});
