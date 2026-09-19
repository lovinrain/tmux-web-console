import { BASE_PATH } from "./api";
import type { OpenTabInNewWindowResult } from "./components/SessionWorkspaceNavigation";

/** A session-only page carries no saved or temporary workspace state. */
export function ephemeralSessionHref(sessionName: string): string {
  return `${BASE_PATH}/session/${encodeURIComponent(sessionName)}?ephemeral=1`;
}

export function openEphemeralSessionTab(sessionName: string): OpenTabInNewWindowResult {
  let child: Window | null = null;
  try {
    child = window.open("about:blank", "_blank");
    if (!child) return "blocked";
    child.opener = null;
    child.location.replace(new URL(ephemeralSessionHref(sessionName), window.location.href).href);
    return "opened";
  } catch {
    try { child?.close(); } catch { /* A partially opened tab may already be closed. */ }
    return "failed";
  }
}
