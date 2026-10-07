import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampSessionJumperGeometry,
  SESSION_JUMPER_GEOMETRY_PREFIX,
  useFloatingSessionJumper,
} from "./useFloatingSessionJumper";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("innerWidth", 760);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("visualViewport", undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("floating session jumper geometry", () => {
  it.each([
    [{ x: -100, y: -100, width: 440, height: 480 }, { x: 12, y: 12, width: 440, height: 480 }],
    [{ x: 9999, y: 9999, width: 9999, height: 9999 }, { x: 12, y: 12, width: 736, height: 876 }],
    [{ x: 9999, y: 9999, width: 440, height: 480 }, { x: 308, y: 408, width: 440, height: 480 }],
    [{ x: 20, y: 30, width: 10, height: 20 }, { x: 20, y: 30, width: 360, height: 300 }],
  ])("keeps window geometry inside the viewport: %j", (input, expected) => {
    expect(clampSessionJumperGeometry(input)).toEqual(expected);
  });

  it("clamps a stored window after the browser shrinks", () => {
    localStorage.setItem(SESSION_JUMPER_GEOMETRY_PREFIX + "workspace:one", JSON.stringify({ x: 1000, y: 800, width: 500, height: 700 }));
    const { result } = renderHook(() => useFloatingSessionJumper("workspace:one", true));
    expect(result.current.geometry).toEqual({ x: 248, y: 188, width: 500, height: 700 });
    vi.stubGlobal("innerWidth", 680);
    vi.stubGlobal("innerHeight", 600);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current.geometry).toEqual({ x: 168, y: 12, width: 500, height: 576 });
  });

  it.each(["broken JSON", JSON.stringify({ x: "bad", y: 20, width: 400, height: 500 })])("uses safe defaults for malformed stored geometry", (value) => {
    localStorage.setItem(SESSION_JUMPER_GEOMETRY_PREFIX + "workspace:two", value);
    const { result } = renderHook(() => useFloatingSessionJumper("workspace:two", true));
    expect(result.current.geometry).toEqual({ x: 292, y: 72, width: 440, height: 480 });
  });

  it("works in memory when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    const { result } = renderHook(() => useFloatingSessionJumper("workspace:private", true));
    expect(result.current.geometry).toEqual({ x: 292, y: 72, width: 440, height: 480 });
  });
});
