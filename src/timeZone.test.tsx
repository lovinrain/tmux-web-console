import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeZoneSelect } from "./components/TimeZoneSelect";
import {
  DEFAULT_TIME_ZONE, formatTimestamp, setDisplayTimeZone, SHORT_TIMESTAMP_FORMAT,
  TIME_ZONE_STORAGE_KEY, useDisplayTimeZone,
} from "./timeZone";

beforeEach(() => {
  setDisplayTimeZone(DEFAULT_TIME_ZONE);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setDisplayTimeZone(DEFAULT_TIME_ZONE);
  localStorage.clear();
});

describe("UTC timestamp display", () => {
  it.each([
    ["2026-01-15T20:34:56Z", "Jan 15, 12:34 PM PST"],
    ["2026-07-15T20:34:56Z", "Jul 15, 1:34 PM PDT"],
    ["2026-01-01T00:30:00Z", "Dec 31, 4:30 PM PST"],
    ["2026-03-08T09:59:00Z", "Mar 8, 1:59 AM PST"],
    ["2026-03-08T10:00:00Z", "Mar 8, 3:00 AM PDT"],
    ["2026-11-01T08:30:00Z", "Nov 1, 1:30 AM PDT"],
    ["2026-11-01T09:30:00Z", "Nov 1, 1:30 AM PST"],
  ])("displays %s in Pacific time, including daylight-saving boundaries", (utc, expected) => {
    const timestamp = new Date(utc);
    expect(formatTimestamp(timestamp, DEFAULT_TIME_ZONE, SHORT_TIMESTAMP_FORMAT, "en-US"))
      .toBe(expected);
    expect(timestamp.toISOString()).toBe(utc.replace("Z", ".000Z"));
  });

  it("shows the same instant in UTC, another region, or fixed PST without shifting the timestamp", () => {
    const timestamp = Date.parse("2026-07-15T03:04:05Z");
    expect(formatTimestamp(timestamp, "UTC", SHORT_TIMESTAMP_FORMAT, "en-US"))
      .toBe("Jul 15, 3:04 AM UTC");
    expect(formatTimestamp(timestamp, "Asia/Tokyo", SHORT_TIMESTAMP_FORMAT, "en-US"))
      .toBe("Jul 15, 12:04 PM GMT+9");
    expect(formatTimestamp(timestamp, "Etc/GMT+8", SHORT_TIMESTAMP_FORMAT, "en-US"))
      .toBe("Jul 14, 7:04 PM GMT-8");
    expect(formatTimestamp(timestamp, DEFAULT_TIME_ZONE, SHORT_TIMESTAMP_FORMAT, "en-US"))
      .toBe("Jul 14, 8:04 PM PDT");
  });
});

describe("display time zone preference", () => {
  it("defaults to Pacific and restores a saved region across remounts", () => {
    const first = renderHook(useDisplayTimeZone);
    expect(first.result.current.timeZone).toBe("America/Los_Angeles");
    act(() => first.result.current.setTimeZone("Asia/Tokyo"));
    expect(localStorage.getItem(TIME_ZONE_STORAGE_KEY)).toBe("Asia/Tokyo");
    first.unmount();
    const second = renderHook(useDisplayTimeZone);
    expect(second.result.current.timeZone).toBe("Asia/Tokyo");
  });

  it.each(["not/a-zone", "", '{"timeZone":"UTC"}'])("recovers from an invalid saved preference: %s", (stored) => {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, stored);
    const { result } = renderHook(useDisplayTimeZone);
    expect(result.current.timeZone).toBe("America/Los_Angeles");
  });

  it("updates every selector and consumer immediately without a provider", () => {
    const { result } = renderHook(useDisplayTimeZone);
    render(<><TimeZoneSelect /><TimeZoneSelect compact /></>);
    const selects = screen.getAllByRole("combobox", { name: "Display time zone" });
    fireEvent.change(selects[0], { target: { value: "UTC" } });
    expect(result.current.timeZone).toBe("UTC");
    expect(selects[1]).toHaveValue("UTC");
    fireEvent.change(selects[1], { target: { value: "Etc/GMT+8" } });
    expect(result.current.timeZone).toBe("Etc/GMT+8");
    expect(selects[0]).toHaveValue("Etc/GMT+8");
  });

  it("follows the browser only when explicitly selected", () => {
    const detected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { result } = renderHook(useDisplayTimeZone);
    act(() => result.current.setTimeZone("system"));
    expect(result.current.preference).toBe("system");
    expect(result.current.timeZone).toBe(detected);
    expect(localStorage.getItem(TIME_ZONE_STORAGE_KEY)).toBe("system");
  });

  it("responds to another tab changing or clearing the preference", () => {
    const { result } = renderHook(useDisplayTimeZone);
    act(() => {
      localStorage.setItem(TIME_ZONE_STORAGE_KEY, "UTC");
      window.dispatchEvent(new StorageEvent("storage", {
        key: TIME_ZONE_STORAGE_KEY, newValue: "UTC", storageArea: localStorage,
      }));
    });
    expect(result.current.timeZone).toBe("UTC");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    });
    expect(result.current.timeZone).toBe("America/Los_Angeles");
  });

  it("keeps a selection in memory when writes fail even if old storage is still readable", () => {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, "UTC");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    const { result } = renderHook(useDisplayTimeZone);
    expect(result.current.timeZone).toBe("UTC");
    act(() => result.current.setTimeZone("Asia/Tokyo"));
    expect(result.current.timeZone).toBe("Asia/Tokyo");
    expect(localStorage.getItem(TIME_ZONE_STORAGE_KEY)).toBe("UTC");
    expect(renderHook(useDisplayTimeZone).result.current.timeZone).toBe("Asia/Tokyo");
  });

  it("renders and allows changes when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    const { result } = renderHook(useDisplayTimeZone);
    expect(result.current.timeZone).toBe("America/Los_Angeles");
    act(() => result.current.setTimeZone("UTC"));
    expect(result.current.timeZone).toBe("UTC");
  });
});
