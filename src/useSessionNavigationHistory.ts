import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SESSION_VISITS = 100;

interface SessionNavigationHistory {
  workspaceKey: string;
  visits: string[];
  index: number;
}

function reconcileHistory(
  history: SessionNavigationHistory,
  workspaceKey: string,
  activeSession: string | null,
  openSessions: readonly string[],
): SessionNavigationHistory {
  const source = history.workspaceKey === workspaceKey
    ? history
    : { workspaceKey, visits: [], index: -1 };
  const available = new Set(openSessions);
  const visits: string[] = [];
  let index = -1;
  source.visits.forEach((name, sourceIndex) => {
    if (!available.has(name)) return;
    // Closing a tab can make two visits to the same session adjacent.
    if (visits.at(-1) !== name) visits.push(name);
    if (sourceIndex <= source.index) index = visits.length - 1;
  });
  if (activeSession && visits[index] !== activeSession) {
    visits.splice(index + 1);
    visits.push(activeSession);
    if (visits.length > MAX_SESSION_VISITS) visits.shift();
    index = visits.length - 1;
  }
  return history.workspaceKey === workspaceKey
    && history.index === index
    && history.visits.length === visits.length
    && history.visits.every((name, position) => name === visits[position])
    ? history
    : { workspaceKey, visits, index };
}

/** Page-local session visits, independent of tab order and browser route entries. */
export function useSessionNavigationHistory(
  workspaceKey: string,
  activeSession: string | null,
  openSessions: readonly string[],
) {
  const [history, setHistory] = useState<SessionNavigationHistory>(() => (
    reconcileHistory({ workspaceKey, visits: [], index: -1 }, workspaceKey, activeSession, openSessions)
  ));
  const historyRef = useRef(history);
  const updateHistory = useCallback((next: SessionNavigationHistory) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  useEffect(() => {
    updateHistory(reconcileHistory(historyRef.current, workspaceKey, activeSession, openSessions));
  }, [workspaceKey, activeSession, openSessions, updateHistory]);

  const navigate = useCallback((direction: "back" | "forward") => {
    const current = historyRef.current;
    if (current.workspaceKey !== workspaceKey) return null;
    const index = current.index + (direction === "back" ? -1 : 1);
    const name = current.visits[index];
    if (!name || !openSessions.includes(name)) return null;
    updateHistory({ ...current, index });
    return name;
  }, [workspaceKey, openSessions, updateHistory]);

  const rename = useCallback((previousName: string, nextName: string) => {
    const current = historyRef.current;
    if (!current.visits.includes(previousName)) return;
    updateHistory({
      ...current,
      visits: current.visits.map((name) => name === previousName ? nextName : name),
    });
  }, [updateHistory]);

  const inWorkspace = history.workspaceKey === workspaceKey;
  return {
    previousSession: inWorkspace ? history.visits[history.index - 1] ?? null : null,
    nextSession: inWorkspace ? history.visits[history.index + 1] ?? null : null,
    navigate,
    rename,
  };
}
