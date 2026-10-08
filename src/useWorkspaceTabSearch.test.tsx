import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceTabSearch } from "./useWorkspaceTabSearch";

function options() {
  return {
    path: "/session/alpha",
    workspaceId: null as string | null,
    temporaryTerminalKey: "temporary-one",
    openSessionCount: 1,
    getLocation: vi.fn(() => ({ path: "/session/alpha" })),
    workspaceRef: { current: { openSessions: ["alpha"] } },
  };
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
});
afterEach(() => vi.unstubAllGlobals());

describe("workspace tab search lifetime", () => {
  it("refocuses an already-open floating picker and remembers its presentation after closing", () => {
    const { result } = renderHook(() => useWorkspaceTabSearch(options()));
    act(() => result.current.open());
    expect(result.current.presentation).toEqual({ open: true, floating: false, focusRequest: 1 });
    act(() => result.current.setFloating(true));
    act(() => result.current.open());
    expect(result.current.presentation).toEqual({ open: true, floating: true, focusRequest: 2 });
    act(() => result.current.close());
    expect(result.current.presentation.open).toBe(false);
    act(() => result.current.open());
    expect(result.current.presentation).toEqual({ open: true, floating: true, focusRequest: 3 });
  });

  it.each([false, true])("closes only the modal on session-history navigation, floating=%s", (floating) => {
    const props = options();
    const { result } = renderHook(() => useWorkspaceTabSearch(props));
    act(() => { result.current.open(); result.current.setFloating(floating); });
    act(() => result.current.closeModal());
    expect(result.current.presentation.open).toBe(floating);
  });

  it.each([false, true])("keeps only the floating picker open while moving between workspace routes, floating=%s", (floating) => {
    const { result, rerender } = renderHook(useWorkspaceTabSearch, { initialProps: options() });
    act(() => { result.current.open(); result.current.setFloating(floating); });
    rerender({ ...options(), path: "/panes/layout" });
    expect(result.current.presentation.open).toBe(floating);
    rerender({ ...options(), path: "/" });
    expect(result.current.presentation.open).toBe(false);
  });

  it.each(["saved-workspace", "temporary-workspace", "last-tab"] as const)(
    "closes on %s replacement/removal", (change) => {
      const props = options();
      const { result, rerender } = renderHook(useWorkspaceTabSearch, { initialProps: props });
      act(() => { result.current.open(); result.current.setFloating(true); });
      if (change === "saved-workspace") rerender({ ...props, workspaceId: "saved-two" });
      else if (change === "temporary-workspace") rerender({ ...props, temporaryTerminalKey: "temporary-two" });
      else {
        props.workspaceRef.current.openSessions = [];
        rerender({ ...props, openSessionCount: 0 });
      }
      expect(result.current.presentation.open).toBe(false);
      expect(result.current.presentation.floating).toBe(true);
    },
  );

  it.each(["dashboard", "no-tabs", "compact", "other-modal"] as const)(
    "does not open or consume a focus request when blocked by %s", (reason) => {
      const props = options();
      const modal = document.createElement("div");
      if (reason === "dashboard") props.getLocation.mockReturnValue({ path: "/" });
      else if (reason === "no-tabs") props.workspaceRef.current.openSessions = [];
      else if (reason === "compact") vi.stubGlobal("innerWidth", 640);
      else { modal.setAttribute("aria-modal", "true"); document.body.append(modal); }
      try {
        const { result } = renderHook(() => useWorkspaceTabSearch(props));
        act(() => result.current.open());
        expect(result.current.presentation).toEqual({ open: false, floating: false, focusRequest: 0 });
      } finally {
        modal.remove();
      }
    },
  );
});
