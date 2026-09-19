import { useCallback, useEffect, useRef, useState } from "react";
import {
  recoverableSessionsFromList,
  recreateSession,
  terminateSession,
  type RecoverableSession,
} from "../api";
import { useTheme } from "../theme";
import type { Session } from "../types";
import { ConsoleScreen, type SessionRenameWarning } from "./ConsoleScreen";

interface EphemeralSessionScreenProps {
  sessionName: string;
  onSessionRenamed: (nextName: string) => void;
}

type SessionIdentity = Pick<Session, "id" | "created" | "serverStarted" | "serverPid">;

function hasIdentity(session: Session, identity: SessionIdentity): boolean {
  return session.id === identity.id
    && session.created === identity.created
    && session.serverStarted === identity.serverStarted
    && session.serverPid === identity.serverPid;
}

/** A terminal attachment with no workspace state or workspace persistence. */
export function EphemeralSessionScreen({
  sessionName,
  onSessionRenamed,
}: EphemeralSessionScreenProps) {
  const { theme } = useTheme();
  const mounted = useRef(false);
  const target = useRef<{
    name: string;
    identity: SessionIdentity | null;
    pendingName: string | null;
    previousName: string | null;
  }>({ name: sessionName, identity: null, pendingName: null, previousName: null });
  if (target.current.name !== sessionName) {
    if (target.current.pendingName !== sessionName) {
      target.current.identity = null;
      target.current.pendingName = null;
      target.current.previousName = null;
    }
    target.current.name = sessionName;
  }
  const [recovery, setRecovery] = useState<RecoverableSession | null>(null);
  const [renameWarning, setRenameWarning] = useState<SessionRenameWarning | null>(null);
  const [endedSession, setEndedSession] = useState<string | null>(null);
  const [recreating, setRecreating] = useState(false);
  const recreatingRef = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const followSession = useCallback((previousName: string, nextName: string) => {
    target.current.previousName = previousName;
    target.current.pendingName = nextName;
    onSessionRenamed(nextName);
  }, [onSessionRenamed]);

  const receiveSessions = useCallback((sessions: Session[]) => {
    const current = target.current;
    setRecovery(recoverableSessionsFromList(sessions).find(
      (item) => item.name === current.name,
    ) ?? null);
    const identity = current.identity;
    const sameSession = identity
      ? sessions.find((item) => hasIdentity(item, identity))
      : undefined;
    if (sameSession) {
      // A request started before this page renamed the session can finish later.
      // Wait for the new name before following further inventory renames.
      if (current.pendingName && sameSession.name === current.previousName) return;
      if (sameSession.name === current.pendingName) {
        current.pendingName = null;
        current.previousName = null;
      }
      if (sameSession.name !== current.name) followSession(current.name, sameSession.name);
      return;
    }
    const namedSession = sessions.find((item) => item.name === current.name);
    if (namedSession) current.identity = namedSession;
  }, [followSession]);

  const sessionRenamed = useCallback((
    previousName: string,
    nextName: string,
    sessionId: string,
    warnings: readonly string[] = [],
  ) => {
    setRenameWarning(warnings.length
      ? { sessionId, sessionName: nextName, messages: [...warnings] }
      : null);
    followSession(previousName, nextName);
  }, [followSession]);

  const terminate = useCallback(async (
    name: string,
    sessionId: string,
    created: number,
    serverStarted: number,
    serverPid: number,
  ) => {
    await terminateSession(name, sessionId, created, serverStarted, serverPid);
    if (!mounted.current || target.current.name !== name) return;
    setEndedSession(name);
    setRecovery(null);
    setRenameWarning(null);
    // End immediately without navigating out of this session-only page.
    setRefresh((value) => value + 1);
  }, []);

  const recreate = useCallback(async () => {
    if (!recovery || recovery.name !== sessionName || recreatingRef.current) return;
    recreatingRef.current = true;
    setRecreating(true);
    setNotice(null);
    try {
      const result = await recreateSession(recovery.id, theme);
      if (!mounted.current || target.current.name !== sessionName) return;
      target.current.identity = null;
      setRecovery(null);
      setEndedSession(null);
      if (result.name !== sessionName) followSession(sessionName, result.name);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (mounted.current && target.current.name === sessionName) {
        setNotice({
          message: error instanceof Error ? error.message : "Unable to recreate this shell.",
          error: true,
        });
      }
    } finally {
      recreatingRef.current = false;
      if (mounted.current) setRecreating(false);
    }
  }, [followSession, recovery, sessionName, theme]);

  const closeTab = useCallback(() => {
    window.close();
    if (!window.closed) {
      setNotice({
        message: "Close this browser tab to detach. The tmux session will keep running.",
        error: false,
      });
    }
  }, []);

  const currentRecovery = recovery?.name === sessionName ? recovery : null;
  return <>
    <ConsoleScreen
      key={refresh}
      ephemeral
      sessionName={sessionName}
      sessionSnapshot={endedSession === sessionName ? null : undefined}
      onBack={closeTab}
      onSessionsChange={receiveSessions}
      onSessionRenamed={sessionRenamed}
      onSessionTerminated={terminate}
      renameWarning={renameWarning}
      onDismissRenameWarning={() => setRenameWarning(null)}
      sessionRecovery={currentRecovery}
      onRecreateSession={currentRecovery ? recreate : undefined}
      recreateSessionBusy={recreating}
    />
    {notice && <div
      className="workspace-sync-notice workspace-sync-notice--compact"
      role={notice.error ? "alert" : "status"}
    >
      <p>{notice.message}</p>
      <div className="workspace-sync-notice-actions">
        <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
      </div>
    </div>}
  </>;
}
