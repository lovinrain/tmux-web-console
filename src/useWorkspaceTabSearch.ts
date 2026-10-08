import { useCallback, useEffect, useState, type RefObject } from "react";
import { isCompactWorkspaceViewport } from "./components/workspaceNavigation/viewport";
import { isWorkspaceRoute } from "./workspaceRoutes";
import type { SessionWorkspaceState } from "./workspaceState";

interface WorkspaceTabSearchOptions {
  path: string;
  workspaceId: string | null;
  temporaryTerminalKey: string;
  openSessionCount: number;
  getLocation: () => { path: string };
  workspaceRef: RefObject<Pick<SessionWorkspaceState, "openSessions">>;
}

/** Owns picker presentation and its lifetime within the current workspace. */
export function useWorkspaceTabSearch({
  path,
  workspaceId,
  temporaryTerminalKey,
  openSessionCount,
  getLocation,
  workspaceRef,
}: WorkspaceTabSearchOptions) {
  const [presentation, setPresentation] = useState({
    open: false, floating: false, focusRequest: 0,
  });
  const setOpen = useCallback((open: boolean) => {
    setPresentation((current) => current.open === open ? current : { ...current, open });
  }, []);
  const setFloating = useCallback((floating: boolean) => {
    setPresentation((current) => ({ ...current, floating }));
  }, []);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const closeModal = useCallback(() => {
    setPresentation((current) => current.floating ? current : { ...current, open: false });
  }, []);
  const open = useCallback(() => {
    if (
      !isWorkspaceRoute(getLocation().path)
      || workspaceRef.current.openSessions.length === 0
      || isCompactWorkspaceViewport()
      || document.querySelector('[aria-modal="true"]')
    ) return;
    setPresentation((current) => ({
      ...current, open: true, focusRequest: current.focusRequest + 1,
    }));
  }, [getLocation, workspaceRef]);

  useEffect(() => {
    if (presentation.open && openSessionCount === 0) setOpen(false);
  }, [presentation.open, openSessionCount, setOpen]);

  useEffect(() => {
    setPresentation((current) => current.floating && isWorkspaceRoute(path)
      ? current : current.open ? { ...current, open: false } : current);
  }, [path]);

  useEffect(() => {
    setOpen(false);
  }, [workspaceId, temporaryTerminalKey, setOpen]);

  return { presentation, open, close, closeModal, setFloating };
}
