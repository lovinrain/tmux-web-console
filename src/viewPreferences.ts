import { forkSyncGroupFromSearch } from "./forkSync";

const LOCAL_VIEW_KEY = "muxdeck-local-view-preferences";
export const LOCAL_VIEW_PREFERENCES_EVENT = "muxdeck:local-view-preferences";

export function localViewPreferencesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (forkSyncGroupFromSearch(window.location.search)) return true;
  try { return window.sessionStorage.getItem(LOCAL_VIEW_KEY) === "1"; }
  catch { return false; }
}

export function enableLocalViewPreferences(): void {
  try { window.sessionStorage.setItem(LOCAL_VIEW_KEY, "1"); } catch { /* Page-local choices still work. */ }
  window.dispatchEvent(new Event(LOCAL_VIEW_PREFERENCES_EVENT));
}

export function readViewPreference(key: string): string | null {
  try {
    if (localViewPreferencesEnabled()) {
      const local = window.sessionStorage.getItem(key);
      if (local !== null) return local;
    }
    return window.localStorage.getItem(key);
  } catch { return null; }
}

export function writeViewPreference(key: string, value: string): void {
  try {
    viewPreferenceStorage().setItem(key, value);
  } catch { /* Keep the current page's choice when persistence is unavailable. */ }
}

export function viewPreferenceStorage(): Storage {
  return localViewPreferencesEnabled() ? window.sessionStorage : window.localStorage;
}

export function writeLocalViewPreference(key: string, value: string): void {
  if (localViewPreferencesEnabled()) writeViewPreference(key, value);
}
