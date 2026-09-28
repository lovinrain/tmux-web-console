import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getWorkspace, updateWorkspace, type SavedWorkspace } from "./api";
import { useWorkspaceSeparators } from "./useWorkspaceSeparators";

vi.mock("./api", () => ({ getWorkspace: vi.fn(), updateWorkspace: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const crossing = { from: { name: "a", side: "after" as const }, to: { name: "b", side: "after" as const } };
it("moves a temporary separator without changing tab order", async () => {
  const { result } = renderHook(() => useWorkspaceSeparators(null, ["a", "b"], null));
  await act(() => result.current.change("a", true));
  await act(() => result.current.cross(crossing));
  expect(result.current.anchors).toEqual(["b"]);
  expect(updateWorkspace).not.toHaveBeenCalled();
});
it("saves both anchor arrays atomically with a rename revision fence", async () => {
  const snapshot = { id: "w", tabs: ["a", "b", "c"], separators: ["a", "c"], separatorsBefore: ["b"], updatedAt: 1, sessionRevision: 7 } as unknown as SavedWorkspace;
  vi.mocked(getWorkspace).mockResolvedValue(snapshot);
  vi.mocked(updateWorkspace).mockResolvedValue({ ...snapshot, separators: ["c"], separatorsBefore: ["b", "c"], updatedAt: 2 });
  const { result } = renderHook(() => useWorkspaceSeparators("w", ["a", "b", "c"], snapshot));
  await act(() => result.current.cross({ from: crossing.from, to: { name: "c", side: "before" } }));
  expect(updateWorkspace).toHaveBeenCalledWith("w", { separators: ["c"], separatorsBefore: ["b", "c"], sessionRevision: 7, expectedUpdatedAt: 1 });
  await waitFor(() => expect(result.current.anchors).toEqual(["c"]));
  expect(result.current.beforeAnchors).toEqual(["b", "c"]);
});
it("preserves separators and shows an error when tab order is not synced", async () => {
  const snapshot = { id: "w", tabs: ["b", "a"], separators: ["a"], updatedAt: 1 } as unknown as SavedWorkspace;
  vi.mocked(getWorkspace).mockResolvedValue(snapshot);
  const { result } = renderHook(() => useWorkspaceSeparators("w", ["a", "b"], snapshot));
  await act(() => result.current.cross(crossing));
  expect(updateWorkspace).not.toHaveBeenCalled();
  expect(result.current.error).toContain("finish syncing");
  expect(result.current.anchors).toEqual(["a"]);
});
