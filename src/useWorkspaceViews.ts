import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  evictWorkspaceView, getWorkspaceViews, resumeWorkspaceView,
  type WorkspaceViewIdentity, type WorkspaceViewSnapshot,
} from "./api";
import { forkSyncGroupFromSearch, newForkSyncId } from "./forkSync";

const PAUSED_KEY = "muxdeck-workspace-view-paused";

export function useWorkspaceViews(workspaceId: string | null, search: string, sessions: string[]) {
  // A fresh page gets its own ID, including browser duplicates that copy sessionStorage.
  const [id] = useState(newForkSyncId);
  const group = forkSyncGroupFromSearch(search);
  const scope = workspaceId ? `workspace:${workspaceId}` : group ? `fork:${group}` : null;
  const identity = useMemo<WorkspaceViewIdentity>(() => ({ id, scope, group }), [id, scope, group]);
  const [paused, setPaused] = useState(() => {
    try { return window.sessionStorage.getItem(PAUSED_KEY) === "1"; } catch { return false; }
  });
  const [snapshot, setSnapshot] = useState<WorkspaceViewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const revision = useRef(0);
  const rejoining = useRef(false);
  const sessionsKey = JSON.stringify(sessions);

  const pause = useCallback(() => {
    try { window.sessionStorage.setItem(PAUSED_KEY, "1"); } catch { /* Live eviction still pauses the page. */ }
    setPaused(true);
  }, []);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      const currentRevision = revision.current;
      try {
        const next = await getWorkspaceViews(scope, JSON.parse(sessionsKey) as string[], id, controller.signal);
        if (controller.signal.aborted || currentRevision !== revision.current) return;
        setSnapshot((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setError(null);
        if (next.evicted && !rejoining.current) pause();
      } catch (problem) {
        if (!controller.signal.aborted && currentRevision === revision.current) {
          setError(problem instanceof Error ? problem.message : "Unable to load workspace views.");
        }
      } finally { busy = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2000);
    const onFocus = () => { void poll(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, scope, sessionsKey, refreshToken, pause]);

  const evict = useCallback(async (target: string) => {
    if (!scope || target === id) return;
    await evictWorkspaceView(scope, JSON.parse(sessionsKey) as string[], id, target);
    refresh();
  }, [id, scope, sessionsKey, refresh]);

  const resume = useCallback(async () => {
    rejoining.current = true;
    revision.current += 1;
    try {
      await resumeWorkspaceView(id);
      try { window.sessionStorage.removeItem(PAUSED_KEY); } catch { /* This page can still rejoin. */ }
      setPaused(false);
      refresh();
    } finally { rejoining.current = false; }
  }, [id, refresh]);

  return {
    identity, available: Boolean(scope), views: snapshot?.views ?? [],
    loading: snapshot === null && error === null, error, paused, pause, resume, evict, refresh,
  };
}

export type WorkspaceViewsController = ReturnType<typeof useWorkspaceViews>;
