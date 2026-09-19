import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspace, updateWorkspace } from "./api";
import type { SeparatorCrossing } from "./workspaceSeparatorMovement";

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
  const movementInFlight = useRef(false);
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
        expectedUpdatedAt: latest.updatedAt,
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

  const cross = async ({ from, to }: SeparatorCrossing) => {
    if (busy || movementInFlight.current) return;
    const transform = (before: string[], after: string[]) => {
      const values = { before: [...before], after: [...after] };
      if (!values[from.side].includes(from.name) || values[to.side].includes(to.name)) {
        throw new Error("Separators changed; refresh and try again.");
      }
      values[from.side] = values[from.side].filter((name) => name !== from.name);
      values[to.side].push(to.name);
      return values;
    };
    const id = workspaceId;
    const request = ++generation.current;
    movementInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!id) {
        const values = transform(beforeAnchors, anchors);
        setTemporaryBefore(values.before);
        setTemporary(values.after);
      } else {
        const latest = await getWorkspace(id);
        if (generation.current !== request || currentId.current !== id) return;
        if (JSON.stringify(latest.tabs) !== tabsKey) throw new Error("Wait for workspace tab order to finish syncing, then try again.");
        const values = transform(latest.separatorsBefore ?? [], latest.separators ?? []);
        const updated = await updateWorkspace(id, {
          separatorsBefore: values.before, separators: values.after,
          sessionRevision: latest.sessionRevision,
          expectedUpdatedAt: latest.updatedAt,
        });
        if (generation.current === request && currentId.current === id) setSaved(updated);
      }
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : "Unable to move across separator.");
    } finally {
      movementInFlight.current = false;
      if (generation.current === request) setBusy(false);
    }
  };

  const restoreTemporary = useCallback((name: string, before: boolean, after: boolean) => {
    if (currentId.current) return;
    if (before) setTemporaryBefore((values) => [...new Set([...values, name])]);
    if (after) setTemporary((values) => [...new Set([...values, name])]);
  }, []);

  return { anchors, beforeAnchors, busy, error, change, cross, restoreTemporary };
}
