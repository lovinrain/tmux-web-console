import type { IBuffer, IBufferCell, Terminal } from "@xterm/xterm";
import {
  attachTerminalRowTheme,
  highlightSpans,
  shadeTerminalBackground,
  type TerminalThemeRow,
} from "./terminalRowTheme";
import type { TerminalThemeMode } from "./terminalTheme";

// Codex caches its startup fill. Recompute the same blend on a browser theme change.
function composerBackground(theme: TerminalThemeMode, terminalBackground?: string): string {
  return shadeTerminalBackground(theme, terminalBackground, theme === "dark" ? 0.12 : 0.04);
}

interface Background {
  mode: number;
  color: number;
}

interface BackgroundBand {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function neutralBackground(cell: IBufferCell | undefined): Background | null {
  if (!cell || cell.isBgDefault()) return null;
  const color = cell.getBgColor();
  if (cell.isBgRGB()) {
    const channels = [color >>> 16, (color >>> 8) & 255, color & 255];
    if (Math.max(...channels) - Math.min(...channels) > 32) return null;
  } else if (cell.isBgPalette()) {
    // xterm's grayscale ramp and the neutral entries in its six-level cube.
    if (color < 232 && ![16, 59, 102, 145, 188, 231].includes(color)) return null;
  } else {
    return null;
  }
  return { mode: cell.getBgColorMode(), color };
}

function hasBackground(cell: IBufferCell | undefined, background: Background): boolean {
  return cell?.getBgColorMode() === background.mode && cell.getBgColor() === background.color;
}

function backgroundBand(
  terminal: Terminal, x: number, y: number, minY: number, maxY: number,
): BackgroundBand | null {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(y);
  const background = neutralBackground(line?.getCell(x));
  if (!background || !line) return null;

  let left = x;
  let right = x + 1;
  while (left > 0 && hasBackground(line.getCell(left - 1), background)) left -= 1;
  while (right < terminal.cols && hasBackground(line.getCell(right), background)) right += 1;
  if (right - left < 8) return null;

  const rowMatches = (y: number): boolean => {
    const row = buffer.getLine(y);
    if (!row) return false;
    if (left > 0 && hasBackground(row.getCell(left - 1), background)) return false;
    if (right < terminal.cols && hasBackground(row.getCell(right), background)) return false;
    for (let x = left; x < right; x += 1) {
      if (!hasBackground(row.getCell(x), background)) return false;
    }
    return true;
  };
  let top = y;
  let bottom = y;
  while (top > minY && rowMatches(top - 1)) top -= 1;
  while (bottom + 1 < maxY && rowMatches(bottom + 1)) bottom += 1;
  return { left, right, top, bottom };
}

function hasPrompt(buffer: IBuffer, band: BackgroundBand, pattern: RegExp, endY = band.bottom): boolean {
  for (let y = band.top; y <= endY; y += 1) {
    const prefix = buffer.getLine(y)?.translateToString(false, band.left, Math.min(band.left + 5, band.right));
    if (prefix && pattern.test(prefix)) return true;
  }
  return false;
}

function composerRows(terminal: Terminal): TerminalThemeRow[] {
  const buffer = terminal.buffer.active;
  const cursorY = buffer.baseY + buffer.cursorY;
  const cursorX = Math.min(buffer.cursorX, terminal.cols - 1);
  const cursorBand = backgroundBand(terminal, cursorX, cursorY, buffer.baseY, buffer.baseY + terminal.rows);
  // The editable composer also supports queued and shell prompts. Only the
  // submitted-message marker (›) is recognized away from the input cursor.
  const composer = cursorBand && hasPrompt(buffer, cursorBand, /^\s{0,3}[›»!](?:\s|$)/u, cursorY)
    ? cursorBand : null;
  const bands: BackgroundBand[] = composer ? [composer] : [];
  const viewportEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  // Sent messages can be narrower than the composer. Its left edge anchors
  // those messages even when the input cursor is beyond their right edge.
  // Without a visible composer, stay in the cursor's pane column.
  const anchorX = composer?.left ?? cursorX;
  for (let y = buffer.viewportY; y < viewportEnd; y += 1) {
    const band = backgroundBand(terminal, anchorX, y, 0, buffer.length);
    if (!band) continue;
    y = band.bottom;
    if (composer && (band.left !== composer.left || band.right > composer.right)) continue;
    // A neutral rectangle alone could be a diff or a dialog. The prompt must
    // belong to this same uniform band; allow it above a scrolled viewport.
    if (hasPrompt(buffer, band, /^\s{0,3}›(?:\s|$)/u)) bands.push(band);
  }

  const rows = new Map<number, TerminalThemeRow>();
  for (const { left, right, top, bottom } of bands) {
    for (let y = Math.max(top, buffer.viewportY); y <= Math.min(bottom, viewportEnd - 1); y += 1) {
      const line = buffer.getLine(y)!;
      rows.set(y, { y, spans: highlightSpans(line, left, right) });
    }
  }
  return [...rows.values()].sort((a, b) => a.y - b.y);
}

/** Recolors the Codex composer and visible sent-message bands without changing terminal data. */
export function attachCodexComposerTheme(
  terminal: Terminal,
  initialTheme: TerminalThemeMode,
  terminalBackground?: string,
) {
  return attachTerminalRowTheme(
    terminal, { rows: composerRows, background: composerBackground }, initialTheme, terminalBackground,
  );
}
