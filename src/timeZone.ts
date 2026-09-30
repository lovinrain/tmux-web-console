import { useSyncExternalStore } from "react";

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const TIME_ZONE_STORAGE_KEY = "muxdeck.display-time-zone.v1";
const TIME_ZONE_CHANGE_EVENT = "muxdeck:display-time-zone-change";

export const SHORT_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
};
export const FULL_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
};
const DEFAULT_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  ...SHORT_TIMESTAMP_FORMAT, year: "numeric",
};

export function normalizeTimeZone(value: unknown): string {
  if (value === "system") return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone;
    } catch {
      // A corrupt or unsupported saved zone must not prevent the app from loading.
    }
  }
  return DEFAULT_TIME_ZONE;
}

export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

let transientPreference: string | null = null;
let cachedStoredValue: string | null | undefined;
let cachedPreference = DEFAULT_TIME_ZONE;

function readTimeZone(): string {
  if (transientPreference !== null) return transientPreference;
  if (typeof window === "undefined") return DEFAULT_TIME_ZONE;
  try {
    const stored = window.localStorage.getItem(TIME_ZONE_STORAGE_KEY);
    if (stored !== cachedStoredValue) {
      cachedStoredValue = stored;
      cachedPreference = normalizeTimeZone(stored);
    }
    return cachedPreference;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function setDisplayTimeZone(value: string): void {
  const preference = normalizeTimeZone(value);
  transientPreference = preference;
  try {
    window.localStorage.setItem(TIME_ZONE_STORAGE_KEY, preference);
    transientPreference = null;
  } catch {
    // Keep the selection for this page when browser storage is unavailable or full.
  }
  window.dispatchEvent(new Event(TIME_ZONE_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== TIME_ZONE_STORAGE_KEY) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    transientPreference = null;
    onChange();
  };
  window.addEventListener(TIME_ZONE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TIME_ZONE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** One browser-wide display preference; persisted timestamps remain UTC epoch values. */
export function useDisplayTimeZone() {
  const preference = useSyncExternalStore(subscribe, readTimeZone, () => DEFAULT_TIME_ZONE);
  return {
    preference,
    timeZone: preference === "system" ? browserTimeZone() : preference,
    setTimeZone: setDisplayTimeZone,
  };
}

/** Accept UTC epoch milliseconds (or a Date); conversion happens only when formatting. */
export function formatTimestamp(
  timestamp: number | Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = DEFAULT_TIMESTAMP_FORMAT,
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(timestamp);
}
