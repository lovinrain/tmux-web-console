import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_FONT_SIZE_STORAGE_KEY, useCallbackFontSize } from "./callbackAppearance";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("callback text preferences", () => {
  it.each([null, "", "broken", "11", "21", "14.5", "Infinity"])("uses a readable default for %s", (stored) => {
    if (stored !== null) window.localStorage.setItem(CALLBACK_FONT_SIZE_STORAGE_KEY, stored);
    const { result } = renderHook(useCallbackFontSize);
    expect(result.current[0]).toBe(14);
  });

  it("loads saved text size and follows changes or resets from another browser tab", () => {
    window.localStorage.setItem(CALLBACK_FONT_SIZE_STORAGE_KEY, "18");
    const { result } = renderHook(useCallbackFontSize);
    expect(result.current[0]).toBe(18);
    act(() => {
      window.localStorage.setItem(CALLBACK_FONT_SIZE_STORAGE_KEY, "16");
      window.dispatchEvent(new StorageEvent("storage", { key: CALLBACK_FONT_SIZE_STORAGE_KEY }));
    });
    expect(result.current[0]).toBe(16);
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current[0]).toBe(14);
  });

  it("still adjusts text when local storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    const { result } = renderHook(useCallbackFontSize);
    act(() => result.current[1](20));
    expect(result.current[0]).toBe(20);
    act(() => result.current[1](NaN));
    expect(result.current[0]).toBe(20);
  });
});
