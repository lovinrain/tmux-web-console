import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TerminalSubmissionTerminator } from "./terminalInput";
import type { LiveTerminalHandle } from "./components/LiveTerminal";

export interface HeldTerminalSnapshot {
  context: string;
  url: string;
  width: number;
  height: number;
  capturedAt: number;
}

/** One temporary, browser-local image. Never pauses or replaces the live PTY. */
export function useHeldTerminalView(
  terminal: RefObject<LiveTerminalHandle | null>,
  context: string,
  enabled: boolean,
) {
  const [snapshot, setSnapshot] = useState<HeldTerminalSnapshot | null>(null);
  const [error, setError] = useState<{ context: string; message: string } | null>(null);
  const sourceRef = useRef({ context, enabled, version: 0 });
  if (sourceRef.current.context !== context) sourceRef.current.version += 1;
  sourceRef.current.context = context;
  sourceRef.current.enabled = enabled;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const urlsRef = useRef(new Set<string>());

  const revoke = useCallback((url: string) => {
    if (urlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      for (const url of urlsRef.current) revoke(url);
    };
  }, [revoke]);
  useEffect(() => {
    setSnapshot((current) => current?.context === context ? current : null);
    setError(null);
  }, [context]);
  useEffect(() => () => {
    if (snapshot) revoke(snapshot.url);
  }, [snapshot, revoke]);

  const release = useCallback(() => {
    requestRef.current += 1;
    setSnapshot(null);
    setError(null);
  }, []);

  const submitKeepingView = useCallback(async (
    data: string,
    terminator: TerminalSubmissionTerminator,
  ): Promise<boolean> => {
    const target = terminal.current;
    const source = { ...sourceRef.current };
    if (!target || !source.enabled) return false;
    const request = ++requestRef.current;
    const stillCurrent = () => mountedRef.current
      && requestRef.current === request
      && sourceRef.current.version === source.version
      && sourceRef.current.context === source.context
      && sourceRef.current.enabled
      && terminal.current === target;
    setError(null);
    if (snapshotRef.current?.context !== source.context) {
      let url: string | null = null;
      try {
        const captured = await target.capture();
        if (!stillCurrent()) return false;
        const blob = await new Promise<Blob>((resolve, reject) => captured.canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error("Image capture failed")), "image/png",
        ));
        if (!stillCurrent()) return false;
        url = URL.createObjectURL(blob);
        urlsRef.current.add(url);
        setSnapshot({ context: source.context, url, width: captured.width,
          height: captured.height, capturedAt: Date.now() });
        // Commit the frozen view before the question can redraw the live screen.
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      } catch {
        if (url) revoke(url);
        if (stillCurrent()) setError({ context: source.context,
          message: "Could not keep this view. Nothing was sent; your draft is still available." });
        return false;
      }
    }
    if (!stillCurrent()) return false;
    // Both frames use this attachment's ordered WebSocket. The guarded history
    // exit is processed before input and never sends a key to the application.
    if (!target.navigateHistory("exit", false)) return false;
    // Transport failures retain both the image and draft. No automatic retry.
    try { return await target.submit(data, terminator); } catch { return false; }
  }, [terminal, revoke]);

  return {
    snapshot: snapshot?.context === context ? snapshot : null,
    error: error?.context === context ? error.message : null,
    submitKeepingView,
    release,
  };
}
