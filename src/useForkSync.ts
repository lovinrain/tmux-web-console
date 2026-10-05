import { useCallback, useEffect, useRef, useState } from "react";
import {
  ForkSyncPeer,
  forkSyncGroupFromSearch,
  forkSyncSelectionKey,
  newForkSyncId,
  searchWithForkSyncGroup,
  storeForkSyncSnapshot,
  readForkSyncSnapshot,
  type ForkSyncSelection,
} from "./forkSync";
import { enableLocalViewPreferences } from "./viewPreferences";

const UNLINKED_PREFIX = "muxdeck-fork-sync-unlinked:";

function unlinked(group: string): boolean {
  try { return window.sessionStorage.getItem(`${UNLINKED_PREFIX}${group}`) === "1"; }
  catch { return false; }
}

function sharedStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function useForkSync(
  search: string,
  selection: ForkSyncSelection | null,
  onSelection: (selection: ForkSyncSelection) => void,
  onSearchChange: (search: string) => void,
  paused = false,
) {
  const requestedGroup = forkSyncGroupFromSearch(search);
  const group = requestedGroup && !unlinked(requestedGroup) ? requestedGroup : null;
  const [sender] = useState(newForkSyncId);
  const [newGroup, setNewGroup] = useState(newForkSyncId);
  const [problem, setProblem] = useState<string | null>(null);
  const peer = useRef<ForkSyncPeer | null>(null);
  const skipInitialPublish = useRef(false);
  const selectionRef = useRef(selection);
  const onSelectionRef = useRef(onSelection);
  selectionRef.current = selection;
  onSelectionRef.current = onSelection;
  const selectionKey = selection ? forkSyncSelectionKey(selection) : null;
  const supported = typeof window.BroadcastChannel === "function";

  useEffect(() => {
    if (requestedGroup && !group) onSearchChange(searchWithForkSyncGroup(search, null));
  }, [requestedGroup, group, search, onSearchChange]);

  useEffect(() => {
    if (!group || !supported || paused) return;
    let connection: ForkSyncPeer;
    try {
      connection = new ForkSyncPeer(
        group, sender, new BroadcastChannel(`muxdeck-fork-sync:${group}`), sharedStorage(),
        (next) => onSelectionRef.current(next),
      );
      peer.current = connection;
      // connect() may restore a newer cached view. The first effect still has
      // the old URL's selection until that navigation has rendered.
      skipInitialPublish.current = true;
      connection.connect();
      if (!connection.snapshot && selectionRef.current) connection.select(selectionRef.current);
      setProblem(null);
    } catch {
      peer.current?.close();
      peer.current = null;
      setProblem("This browser could not connect linked tabs.");
      return;
    }
    const refresh = () => connection.requestSelection();
    const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
      connection.close();
      if (peer.current === connection) peer.current = null;
    };
  }, [group, sender, supported, paused]);

  useEffect(() => {
    if (skipInitialPublish.current) {
      skipInitialPublish.current = false;
      return;
    }
    if (selectionRef.current && peer.current?.group === group) {
      peer.current.select(selectionRef.current);
    }
  }, [group, selectionKey]);

  const prepareFork = useCallback(() => {
    const current = selectionRef.current;
    if (!current || !supported || paused) return window.location.href;
    const nextGroup = group ?? newGroup;
    const storage = sharedStorage();
    if (peer.current?.group === nextGroup) peer.current.select(current, true);
    else {
      const previous = readForkSyncSnapshot(nextGroup, storage);
      storeForkSyncSnapshot(nextGroup, {
        version: 1, sequence: (previous?.sequence ?? 0) + 1, sender, updatedAt: Date.now(), selection: current,
      }, storage);
    }
    const nextSearch = searchWithForkSyncGroup(window.location.search, nextGroup);
    onSearchChange(nextSearch);
    enableLocalViewPreferences();
    const destination = new URL(window.location.href);
    destination.search = nextSearch;
    return destination.href;
  }, [group, newGroup, onSearchChange, sender, supported, paused]);

  const unlink = useCallback(() => {
    if (group) {
      try { window.sessionStorage.setItem(`${UNLINKED_PREFIX}${group}`, "1"); } catch { /* URL removal also detaches. */ }
    }
    peer.current?.close();
    peer.current = null;
    enableLocalViewPreferences();
    onSearchChange(searchWithForkSyncGroup(window.location.search, null));
    setNewGroup(newForkSyncId());
  }, [group, onSearchChange]);

  const destination = new URL(window.location.href);
  destination.search = searchWithForkSyncGroup(search, group ?? newGroup);
  return {
    linked: Boolean(group),
    active: Boolean(group) && supported && problem === null && !paused,
    available: supported && selection !== null && problem === null && !paused,
    href: destination.href,
    prepareFork,
    unlink,
    problem: paused ? "This view is disconnected." : problem ?? (!supported ? "This browser does not support linked tabs." : null),
  };
}
