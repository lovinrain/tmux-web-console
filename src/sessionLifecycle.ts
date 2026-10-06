import type { Session } from "./types";

/** A retained tmux session is dead only when every known pane has exited. */
export function sessionHasOnlyDeadPanes(session: Pick<Session, "panes"> | null | undefined): boolean {
  return Boolean(session?.panes?.length && session.panes.every((pane) => pane.dead));
}
