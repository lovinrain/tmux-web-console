export type TerminalSubmissionTerminator = "none" | "enter" | "tab";

// Standard xterm Ctrl+End (kEND5), re-encoded by tmux for the foreground application.
export const CTRL_END_SEQUENCE = "\x1b[1;5F";

export function prepareTerminalSubmission(
  data: string,
  terminator: TerminalSubmissionTerminator,
  bracketedPasteMode: boolean,
): string {
  let prepared = data.replace(/\r?\n/g, "\r");
  if (bracketedPasteMode) prepared = `\x1b[200~${prepared}\x1b[201~`;
  if (terminator === "enter") return `${prepared}\r`;
  if (terminator === "tab") return `${prepared}\t`;
  return prepared;
}
