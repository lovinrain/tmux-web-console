import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { subscribeToSessionInventory } from "./sessionInventory";
import type { Session } from "./types";

/** Keep the view's inventory connection alive while its selected session changes. */
export function useConsoleSession(
  sessionName: string,
  snapshot: Session | null | undefined,
  onSessionsChange?: (sessions: Session[]) => void,
) {
  const [inventory, setInventory] = useState<Session[] | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState(sessionName);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [editedSnapshot, setEditedSnapshot] = useState<{
    source: Session | null;
    session: Session | null;
  } | null>(null);
  const onSessionsChangeRef = useRef(onSessionsChange);
  onSessionsChangeRef.current = onSessionsChange;
  const ownsInventory = snapshot === undefined;

  if (selectedName !== sessionName) {
    setSelectedName(sessionName);
    if (ownsInventory && inventory !== null
      && !inventory.some((item) => item.name === sessionName)) {
      // A copy or rename may navigate before its stream event arrives. Refresh
      // that unknown target without briefly treating an older cache as proof
      // that it is missing. Known-session navigation needs no network request.
      setInventory(null);
      setInventoryError(null);
      setRefreshVersion((current) => current + 1);
    }
  }

  useEffect(() => {
    if (!ownsInventory) return;
    return subscribeToSessionInventory({
      onSessions: (sessions) => {
        setInventory(sessions);
        setInventoryError(null);
        onSessionsChangeRef.current?.(sessions);
      },
      onError: (error) => setInventoryError(
        error instanceof Error ? error.message : "Unable to load session",
      ),
    });
  }, [ownsInventory, refreshVersion]);

  const source = ownsInventory
    ? inventory?.find((item) => item.name === sessionName) ?? null
    : snapshot?.name === sessionName ? snapshot : null;
  const session = !ownsInventory && editedSnapshot?.source === source
    ? editedSnapshot.session
    : source;

  const setSession = useCallback((update: SetStateAction<Session | null>) => {
    const apply = (current: Session | null) => (
      typeof update === "function" ? update(current) : update
    );
    if (ownsInventory) {
      setInventory((current) => current?.map((item) => (
        item.name === sessionName ? apply(item) : item
      )).filter((item): item is Session => item !== null) ?? null);
    } else {
      setEditedSnapshot((current) => ({
        source,
        session: apply(current?.source === source ? current.session : source),
      }));
    }
  }, [ownsInventory, sessionName, source]);

  const lookupError = session ? null
    : !ownsInventory || inventory !== null
      ? "This tmux session no longer exists."
      : inventoryError;

  return { session, setSession, lookupError };
}
