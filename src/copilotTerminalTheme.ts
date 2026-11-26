import type { IBuffer, IBufferLine, Terminal } from "@xterm/xterm";
import {
  attachTerminalRowTheme,
  highlightSpans,
  shadeTerminalBackground,
  type TerminalThemeRow,
} from "./terminalRowTheme";
import { TERMINAL_THEMES, type TerminalThemeMode } from "./terminalTheme";

const SENT_TIMESTAMP = / \d{1,2}:\d{2}(?: [AP]M)? +┃$/i;
const IDLE_FOOTER = /\/\s+commands\s+·\s+\?\s+help\b/i;

interface Reply {
  first: number;
  last: number;
  right: number;
}

function frameRight(line: IBufferLine, cols: number): number | undefined {
  let right = Math.min(line.length, cols) - 1;
  while (right > 3 && !line.getCell(right)?.getChars().trim()) right -= 1;
  return line.getCell(right)?.getChars() === "┃" ? right : undefined;
}

function sentPromptRight(line: IBufferLine, cols: number): number | undefined {
  if (line.translateToString(false, 0, 3) !== " ❯ ") return;
  const end = Math.min(line.length, cols);
  const text = line.translateToString(true, 3, end).trimEnd();
  // Copilot also uses this marker for notices, which lack the timestamp.
  if (!SENT_TIMESTAMP.test(text)) return;
  return frameRight(line, cols);
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

function copilotRows(
  terminal: Terminal,
  theme: TerminalThemeMode,
  terminalBackground?: string,
): TerminalThemeRow[] {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  const composer = findComposer(terminal);
  const rows: TerminalThemeRow[] = [];
  const replies: Reply[] = [];
  let sentRight: number | undefined;
  let reply: Reply | undefined;

  for (let y = buffer.viewportY; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      sentRight = undefined;
      reply = undefined;
      continue;
    }
    const prefix = line.translateToString(false, 0, 3);
    const sentStart = sentPromptRight(line, terminal.cols);
    // Rendered continuations share the message's frame and its text indent.
    const continuation = sentRight !== undefined && line.getCell(sentRight)?.getChars() === "┃"
      && prefix === "   "
      && Boolean(line.translateToString(true, 3, sentRight).trim());
    sentRight = sentStart ?? (continuation ? sentRight : undefined);

    const inComposer = composer && y >= composer.top && y < composer.bottom;
    const promptRight = inComposer ? composer.right : sentRight;
    if (promptRight !== undefined) rows.push({ y, spans: highlightSpans(line, 0, promptRight, true) });

    // Both progress and answers use a blue bullet. A later tool row or
    // interruption rules out that block. A new prompt closes the prior turn.
    if (sentStart !== undefined) {
      if (reply) replies.push(reply);
      reply = undefined;
    } else if (prefix === " ● ") {
      const marker = line.getCell(1);
      const right = frameRight(line, terminal.cols);
      reply = right !== undefined && marker?.isFgPalette() && [4, 12].includes(marker.getFgColor())
        ? { first: y, last: y, right } : undefined;
    } else if (reply && line.getCell(reply.right)?.getChars() === "┃") {
      if (prefix !== "   ") {
        reply = undefined;
      } else if (line.translateToString(true, 3, reply.right).trim()) {
        reply.last = y;
      }
    }
  }

  const liveEnd = Math.min(buffer.length, buffer.baseY + terminal.rows);
  if (reply && composer && end === liveEnd) {
    const footer = Array.from({ length: liveEnd - composer.bottom - 1 }, (_, index) =>
      buffer.getLine(composer.bottom + 1 + index)?.translateToString(true) ?? "",
    ).join(" ");
    if (IDLE_FOOTER.test(footer)) replies.push(reply);
  }

  if (replies.length > 0) {
    const accent = terminal.options.theme?.blue ?? TERMINAL_THEMES[theme].blue!;
    const fill = shadeTerminalBackground(theme, terminalBackground, theme === "dark" ? 0.15 : 0.12, accent);
    for (const { first, last, right } of replies) {
      for (let y = first; y <= last; y += 1) {
        const line = buffer.getLine(y);
        if (line?.getCell(right)?.getChars() !== "┃") continue;
        rows.push({ y, spans: [
          ...highlightSpans(line, 0, 1, true).map((span) => ({ ...span, backgroundColor: accent })),
          ...highlightSpans(line, 1, right, true).map((span) => ({ ...span, backgroundColor: fill })),
        ] });
      }
    }
  }
  return rows.sort((a, b) => a.y - b.y);
}

export function attachCopilotTerminalTheme(
  terminal: Terminal,
  theme: TerminalThemeMode,
  terminalBackground?: string,
) {
  return attachTerminalRowTheme(terminal, {
    rows: copilotRows,
    background: (mode, background) => shadeTerminalBackground(mode, background, mode === "dark" ? 0.14 : 0.07),
  }, theme, terminalBackground);
}
