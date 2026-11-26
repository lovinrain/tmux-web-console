import type { IBuffer, IBufferLine, Terminal } from "@xterm/xterm";
import {
  attachTerminalRowTheme,
  highlightSpans,
  shadeTerminalBackground,
  type TerminalThemeRow,
} from "./terminalRowTheme";
import type { TerminalThemeMode } from "./terminalTheme";

const SENT_TIMESTAMP = / \d{1,2}:\d{2}(?: [AP]M)? +┃$/i;

function sentPromptRight(line: IBufferLine, cols: number): number | undefined {
  if (line.translateToString(false, 0, 3) !== " ❯ ") return;
  const end = Math.min(line.length, cols);
  const text = line.translateToString(true, 3, end).trimEnd();
  // Copilot also uses this marker for notices, which lack the timestamp.
  if (!SENT_TIMESTAMP.test(text)) return;
  let right = end - 1;
  while (right > 3 && !line.getCell(right)?.getChars().trim()) right -= 1;
  return right;
}

function ruleWidth(buffer: IBuffer, row: number, cols: number): number {
  if (row < buffer.baseY || buffer.getLine(row)?.getCell(0)?.getChars() !== "─") return 0;
  const text = buffer.getLine(row)?.translateToString(true, 0, cols).trimEnd();
  return text && /^─{8,}$/.test(text) ? text.length : 0;
}

function findComposer(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  // The lower rule sits immediately above Copilot's status and shortcut rows.
  for (let bottom = end - 2; bottom >= Math.max(end - 6, buffer.baseY + 2); bottom -= 1) {
    const right = ruleWidth(buffer, bottom, terminal.cols);
    if (!right) continue;
    for (let top = bottom - 2; top >= buffer.baseY; top -= 1) {
      const upperWidth = ruleWidth(buffer, top, terminal.cols);
      if (!upperWidth) continue;
      const prefix = buffer.getLine(top + 1)?.translateToString(false, 0, 2);
      if (upperWidth === right && prefix === "❯ ") return { top: top + 1, bottom, right };
      break;
    }
  }
}

function promptRows(terminal: Terminal): TerminalThemeRow[] {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  const composer = findComposer(terminal);
  const rows: TerminalThemeRow[] = [];
  let sentRight: number | undefined;

  for (let y = buffer.viewportY; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      sentRight = undefined;
      continue;
    }
    const sentStart = sentPromptRight(line, terminal.cols);
    // Rendered continuations share the message's frame and its text indent.
    const continuation = sentRight !== undefined && line.getCell(sentRight)?.getChars() === "┃"
      && line.translateToString(false, 0, 3) === "   "
      && Boolean(line.translateToString(true, 3, sentRight).trim());
    sentRight = sentStart ?? (continuation ? sentRight : undefined);

    const right = composer && y >= composer.top && y < composer.bottom ? composer.right : sentRight;
    if (right !== undefined) rows.push({ y, spans: highlightSpans(line, 0, right, true) });
  }
  return rows;
}

export function attachCopilotPromptTheme(
  terminal: Terminal,
  theme: TerminalThemeMode,
  terminalBackground?: string,
) {
  return attachTerminalRowTheme(terminal, {
    rows: promptRows,
    background: (mode, background) => shadeTerminalBackground(mode, background, mode === "dark" ? 0.14 : 0.07),
  }, theme, terminalBackground);
}
