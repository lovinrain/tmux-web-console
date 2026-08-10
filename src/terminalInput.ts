export function prepareTerminalSubmission(
  data: string,
  withEnter: boolean,
  bracketedPasteMode: boolean,
): string {
  let prepared = data.replace(/\r?\n/g, "\r");
  if (bracketedPasteMode) prepared = `\x1b[200~${prepared}\x1b[201~`;
  return withEnter ? `${prepared}\r` : prepared;
}
