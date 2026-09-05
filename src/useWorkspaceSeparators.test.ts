import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getWorkspace, updateWorkspace, type SavedWorkspace } from "./api";
import { useWorkspaceSeparators } from "./useWorkspaceSeparators";

vi.mock("./api", () => ({ getWorkspace: vi.fn(), updateWorkspace: vi.fn() }));

const workspace: SavedWorkspace = {
  id: "one", name: "One", tabs: ["a", "b"], groups: [], separators: ["a"],
  activeSession: "a", sessionRevision: 1, createdAt: 1, updatedAt: 2, lastActiveAt: 1,
};

beforeEach(() => vi.resetAllMocks());

it("uses hydrated workspace data and merges changes with the latest saved separators", async () => {
  const { result, rerender } = renderHook(
    ({ snapshot }) => useWorkspaceSeparators("one", ["a", "b"], snapshot),
    { initialProps: { snapshot: workspace } },
  );
  expect(result.current.anchors).toEqual(["a"]);
  expect(getWorkspace).not.toHaveBeenCalled();
  vi.mocked(getWorkspace).mockResolvedValue({ ...workspace, separators: ["a", "b"] });
  vi.mocked(updateWorkspace).mockResolvedValue({ ...workspace, separators: ["b"], updatedAt: 3 });
  await act(() => result.current.change("a", false));
  expect(updateWorkspace).toHaveBeenCalledWith("one", { separators: ["b"], sessionRevision: 1 });
  expect(result.current.anchors).toEqual(["b"]);
  rerender({ snapshot: { ...workspace, updatedAt: 4, separators: [] } });
  expect(result.current.anchors).toEqual([]);
});

it("keeps temporary separators across session switches and resets them after saving", async () => {
  const { result, rerender } = renderHook(
    ({ id, snapshot }: { id: string | null; snapshot: SavedWorkspace | null }) => (
      useWorkspaceSeparators(id, ["a", "b"], snapshot)
    ),
    { initialProps: { id: null as string | null, snapshot: null as SavedWorkspace | null } },
  );
  await act(() => result.current.change("a", true));
  expect(result.current.anchors).toEqual(["a"]);
  expect(updateWorkspace).not.toHaveBeenCalled();
  rerender({ id: "one", snapshot: workspace });
  expect(result.current.anchors).toEqual(["a"]);
  rerender({ id: null, snapshot: null });
  expect(result.current.anchors).toEqual([]);
});

it("reports failed writes without removing the saved line", async () => {
  const { result } = renderHook(() => useWorkspaceSeparators("one", ["a", "b"], workspace));
  vi.mocked(getWorkspace).mockResolvedValue(workspace);
  vi.mocked(updateWorkspace).mockRejectedValue(new Error("Workspace changed; try again."));
  await act(() => result.current.change("a", false));
  expect(result.current.anchors).toEqual(["a"]);
  expect(result.current.error).toBe("Workspace changed; try again.");
  expect(result.current.busy).toBe(false);
});

it("persists before-session placement without rewriting after-session lines", async () => {
  const { result } = renderHook(() => useWorkspaceSeparators("one", ["a", "b"], workspace));
  vi.mocked(getWorkspace).mockResolvedValue(workspace);
  vi.mocked(updateWorkspace).mockResolvedValue({
    ...workspace, separatorsBefore: ["a"], updatedAt: 3,
  });
  await act(() => result.current.change("a", true, "before"));
  expect(updateWorkspace).toHaveBeenCalledWith("one", {
    separatorsBefore: ["a"], sessionRevision: 1,
  });
  expect(result.current.beforeAnchors).toEqual(["a"]);
  expect(result.current.anchors).toEqual(["a"]);
});
