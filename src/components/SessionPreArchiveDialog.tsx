import type { Session } from "../types";
import { SessionTerminateDialog } from "./SessionTerminateDialog";

interface Props {
  session: Session;
  onClose: () => void;
  onPreArchive: (session: Session) => Promise<void>;
  onFallbackFocus?: () => void;
}

export function SessionPreArchiveDialog({ session, onClose, onPreArchive, onFallbackFocus }: Props) {
  return <SessionTerminateDialog
    sessionName={session.name}
    sessionTitle={session.customTitle}
    heading="Pre-archive session?"
    confirmLabel="Pre-archive session"
    pendingLabel="Pre-archiving..."
    description={<>
      <p>Pre-archive <strong>{session.customTitle || session.name}</strong>
        {session.customTitle && session.customTitle !== session.name && <> (<code>{session.name}</code>)</>}?</p>
      <p>This ends the entire tmux session and every program running in its panes. Unsaved terminal work can be lost.</p>
      <p>The tab stays in place with its saved directory, history and recorded agent references.
        You can recreate a fresh shell later or copy a command to resume a recorded conversation.
        Running programs and pane layouts are not restored.</p>
      <p>Other workspaces keep their tabs and show this session as pre-archived too.</p>
    </>}
    onClose={onClose}
    onTerminate={() => onPreArchive(session)}
    onFallbackFocus={onFallbackFocus}
  />;
}
