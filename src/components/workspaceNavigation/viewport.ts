import { useEffect, useState } from "react";
import type { WorkspaceTabOrientation } from "./types";

export const MIN_DESKTOP_TAB_RAIL_WIDTH = 72;
export const MAX_DESKTOP_TAB_RAIL_WIDTH = 480;
export const DEFAULT_DESKTOP_TAB_RAIL_WIDTH = 288;
export const COMPACT_DESKTOP_TAB_RAIL_MAX_WIDTH = 176;

const DESKTOP_TAB_RAIL_MAIN_CONTENT_MIN_WIDTH = 360;
export const DESKTOP_TAB_RAIL_KEYBOARD_STEP = 8;
export const DESKTOP_TAB_RAIL_KEYBOARD_LARGE_STEP = 32;

export function clampDesktopTabRailWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DESKTOP_TAB_RAIL_WIDTH;
  return Math.min(
    MAX_DESKTOP_TAB_RAIL_WIDTH,
    Math.max(MIN_DESKTOP_TAB_RAIL_WIDTH, Math.round(width)),
  );
}

export function isCompactWorkspaceViewport(): boolean {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return viewportWidth <= 640
    || (viewportWidth <= 1024 && (coarsePointer || viewportHeight <= 500));
}

export function useWorkspaceTabOrientation(
  preferredOrientation: WorkspaceTabOrientation,
): {
  orientation: WorkspaceTabOrientation;
  compactViewport: boolean;
} {
  const [compactViewport, setCompactViewport] = useState(isCompactWorkspaceViewport);

  useEffect(() => {
    const syncViewport = () => setCompactViewport(isCompactWorkspaceViewport());
    const viewport = window.visualViewport;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)");
    syncViewport();
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener?.("resize", syncViewport);
    coarsePointer?.addEventListener?.("change", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener?.("resize", syncViewport);
      coarsePointer?.removeEventListener?.("change", syncViewport);
    };
  }, []);

  return {
    orientation: compactViewport ? "horizontal" : preferredOrientation,
    compactViewport,
  };
}

function desktopTabRailMaxWidth(): number {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  return Math.max(
    MIN_DESKTOP_TAB_RAIL_WIDTH,
    Math.min(
      MAX_DESKTOP_TAB_RAIL_WIDTH,
      Math.floor(viewportWidth - DESKTOP_TAB_RAIL_MAIN_CONTENT_MIN_WIDTH),
    ),
  );
}

export function useDesktopTabRailMaxWidth(): number {
  const [maxWidth, setMaxWidth] = useState(desktopTabRailMaxWidth);

  useEffect(() => {
    const syncViewport = () => setMaxWidth(desktopTabRailMaxWidth());
    const viewport = window.visualViewport;
    syncViewport();
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener?.("resize", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener?.("resize", syncViewport);
    };
  }, []);

  return maxWidth;
}

export function clampDesktopTabRailWidthForViewport(width: number, maxWidth: number): number {
  return Math.min(maxWidth, clampDesktopTabRailWidth(width));
}
