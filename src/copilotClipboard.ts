import type { Terminal } from "@xterm/xterm";

const COPILOT_BORDER = "┃";
const PADDED_BORDER = / {2,}┃$/;

export function stripCopilotCopyBorder(
  terminal: Pick<Terminal, "buffer" | "cols" | "getSelectionPosition">,
  selection: string,
): string {
  const range = terminal.getSelectionPosition();
  if (!range) return selection;

  const { start, end } = range;
  const buffer = terminal.buffer.active;
  const borderColumn = terminal.cols - 1;
  const hasBorder = (row: number) => row >= 0 && row < buffer.length
    && buffer.getLine(row)?.getCell(borderColumn)?.getChars() === COPILOT_BORDER;
  const newline = selection.includes("\r\n") ? "\r\n" : "\n";
  const original: string[] = [];
  const cleaned: string[] = [];

  for (let row = start.y; row <= end.y; row += 1) {
    const line = buffer.getLine(row);
    if (!line) return selection;

    const from = row === start.y ? start.x : 0;
    const to = row === end.y ? end.x : line.length;
    const text = line.translateToString(true, from, to);
    const separator = row > start.y && !line.isWrapped ? newline : "";
    original.push(separator, text);

    // The Copilot frame is a run of right-edge cells. The padding can also
    // be selected without the border cell, especially on the last row.
    const paddedBorder = line.length === terminal.cols
      && line.getCell(borderColumn)?.getChars() === COPILOT_BORDER
      && (hasBorder(row - 1) || hasBorder(row + 1))
      ? PADDED_BORDER.exec(line.translateToString(true))?.[0]
      : undefined;
    const contentEnd = paddedBorder ? terminal.cols - paddedBorder.length : to;
    cleaned.push(separator, to > contentEnd ? line.translateToString(true, from, contentEnd) : text);
  }

  // Keep xterm's result for selections whose layout differs, such as a
  // rectangle across part of the terminal.
  if (original.join("").replaceAll("\u00a0", " ") !== selection) return selection;
  const text = cleaned.join("").replaceAll("\u00a0", " ");
  return text.trim() ? text : selection;
}
