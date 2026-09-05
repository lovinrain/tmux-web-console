import { useEffect, useRef, useState } from "react";
import { getWorkspace, updateWorkspace } from "./api";

interface SeparatorSnapshot {
  id: string;
  separators?: string[];
  separatorsBefore?: string[];
  updatedAt?: number;
}

// Separators are edited separately so an older tab-order snapshot cannot erase them.
export function useWorkspaceSeparators(
  workspaceId: string | null, tabs: string[], snapshot: SeparatorSnapshot | null,
) {
  const [temporary, setTemporary] = useState<string[]>([]);
  const [temporaryBefore, setTemporaryBefore] = useState<string[]>([]);
  const [saved, setSaved] = useState<SeparatorSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const currentId = useRef(workspaceId);
  currentId.current = workspaceId;
  const tabsKey = JSON.stringify(tabs);
  useEffect(() => {
    const open = new Set<string>(JSON.parse(tabsKey));
    setTemporary((current) => {
      const retained = current.filter((name) => open.has(name));
      return retained.length === current.length ? current : retained;
    });
    setTemporaryBefore((current) => {
      const retained = current.filter((name) => open.has(name));
      return retained.length === current.length ? current : retained;
    });
  }, [tabsKey]);
  useEffect(() => {
    ++generation.current;
    setError("");
    setBusy(false);
    setSaved(null);
    if (workspaceId) {
      setTemporary([]);
      setTemporaryBefore([]);
    }
    return () => { ++generation.current; };
  }, [workspaceId]);

  const latestSnapshot = saved?.id === workspaceId
    && (snapshot?.id !== workspaceId || (saved.updatedAt ?? 0) > (snapshot.updatedAt ?? 0))
    ? saved : snapshot;
  const anchors = (workspaceId
    ? latestSnapshot?.id === workspaceId ? latestSnapshot.separators ?? [] : []
    : temporary).filter((name) => tabs.includes(name));
  const beforeAnchors = (workspaceId
    ? latestSnapshot?.id === workspaceId ? latestSnapshot.separatorsBefore ?? [] : []
    : temporaryBefore).filter((name) => tabs.includes(name));

  const change = async (anchor: string, add: boolean, side: "before" | "after" = "after") => {
    if (busy || !tabs.includes(anchor)) return;
    const transform = (values: string[]) => add
      ? [...new Set([...values, anchor])]
      : values.filter((value) => value !== anchor);
    if (!workspaceId) {
      if (side === "before") setTemporaryBefore(transform(beforeAnchors));
      else setTemporary(transform(anchors));
      return;
    }
    const id = workspaceId;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const latest = await getWorkspace(id);
      if (generation.current !== request || currentId.current !== id) return;
      const updated = await updateWorkspace(id, {
        ...(side === "before"
          ? { separatorsBefore: transform(latest.separatorsBefore ?? []) }
          : { separators: transform(latest.separators ?? []) }),
        sessionRevision: latest.sessionRevision,
      });
      if (generation.current !== request || currentId.current !== id) return;
      setSaved(updated);
    } catch (reason) {
      if (generation.current !== request || currentId.current !== id) return;
      setError(reason instanceof Error ? reason.message : "Unable to save separator.");
    } finally {
      if (generation.current === request && currentId.current === id) setBusy(false);
    }
  };

  return { anchors, beforeAnchors, busy, error, change };
}
