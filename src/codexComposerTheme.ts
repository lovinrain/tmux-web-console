import type { IBuffer, IBufferCell, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { TerminalThemeMode } from "./terminalTheme";

// Codex blends its startup terminal background with white (12%) or black (4%)
// and caches that color. These are the same blends for Muxdeck's two palettes.
const COMPOSER_BACKGROUNDS: Record<TerminalThemeMode, string> = {
  dark: "#282a29",
  light: "#f0f0eb",
};

interface Background {
  mode: number;
  color: number;
}

interface ComposerRow {
  y: number;
  spans: Array<{ x: number; width: number }>;
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

function composerRows(terminal: Terminal): ComposerRow[] {
  const buffer = terminal.buffer.active;
  const cursorY = buffer.baseY + buffer.cursorY;
  const cursorX = Math.min(buffer.cursorX, terminal.cols - 1);
  const cursorLine = buffer.getLine(cursorY);
  const background = neutralBackground(cursorLine?.getCell(cursorX));
  if (!background || !cursorLine) return [];

  let left = cursorX;
  let right = cursorX + 1;
  while (left > 0 && hasBackground(cursorLine.getCell(left - 1), background)) left -= 1;
  while (right < terminal.cols && hasBackground(cursorLine.getCell(right), background)) right += 1;
  if (right - left < 8) return [];

  const rowMatches = (y: number): boolean => {
    const row = buffer.getLine(y);
    if (!row) return false;
    for (let x = left; x < right; x += 1) {
      if (!hasBackground(row.getCell(x), background)) return false;
    }
    return true;
  };
  let top = cursorY;
  let bottom = cursorY;
  while (top > buffer.baseY && rowMatches(top - 1)) top -= 1;
  while (bottom + 1 < buffer.baseY + terminal.rows && rowMatches(bottom + 1)) bottom += 1;

  // A neutral rectangle by itself could be a diff or a dialog. Require Codex's
  // composer prompt above (or on) the actual input cursor in that same band.
  let promptFound = false;
  for (let y = top; y <= cursorY; y += 1) {
    const prefix = buffer.getLine(y)?.translateToString(false, left, Math.min(left + 5, right));
    if (prefix && /^\s{0,3}[›»!](?:\s|$)/u.test(prefix)) {
      promptFound = true;
      break;
    }
  }
  if (!promptFound) return [];

  const rows: ComposerRow[] = [];
  for (let y = top; y <= bottom; y += 1) {
    const line = buffer.getLine(y)!;
    const spans: ComposerRow["spans"] = [];
    let start: number | null = null;
    for (let x = left; x <= right; x += 1) {
      // Preserve application selection/reverse-video highlights as well as all
      // foreground attributes. Browser selection also stays above this layer.
      const decorate = x < right && !line.getCell(x)?.isInverse();
      if (decorate && start === null) start = x;
      if (!decorate && start !== null) {
        spans.push({ x: start, width: x - start });
        start = null;
      }
    }
    rows.push({ y, spans });
  }
  return rows;
}

/** Recolors only the active Codex composer, without changing terminal data. */
export function attachCodexComposerTheme(terminal: Terminal, initialTheme: TerminalThemeMode): {
  setTheme: (theme: TerminalThemeMode) => void;
  dispose: () => void;
} {
  let theme = initialTheme;
  let disposed = false;
  let frame: number | undefined;
  let signature = "";
  let activeBuffer: IBuffer = terminal.buffer.active;
  const decorations: IDisposable[] = [];
  const markers: IMarker[] = [];

  const clear = () => {
    for (const decoration of decorations.splice(0)) decoration.dispose();
    for (const marker of markers.splice(0)) marker.dispose();
    signature = "";
  };

  const update = () => {
    if (disposed) return;
    const buffer = terminal.buffer.active;
    if (activeBuffer !== buffer) {
      clear();
      activeBuffer = buffer;
    }
    const rows = composerRows(terminal);
    const decoratedRows = rows.filter((row) => row.spans.length > 0);
    const nextSignature = JSON.stringify([theme, rows]);
    if (
      signature === nextSignature
      && markers.every((marker, index) => !marker.isDisposed && marker.line === decoratedRows[index]?.y)
    ) return;
    clear();
    signature = nextSignature;
    for (const row of decoratedRows) {
      const marker = terminal.registerMarker(row.y - buffer.baseY - buffer.cursorY);
      markers.push(marker);
      for (const span of row.spans) {
        const decoration = terminal.registerDecoration({
          marker,
          ...span,
          backgroundColor: COMPOSER_BACKGROUNDS[theme],
          layer: "bottom",
        });
        if (decoration) decorations.push(decoration);
      }
    }
  };

  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      update();
    });
  };

  const listeners = [
    terminal.onWriteParsed(schedule),
    terminal.onResize(schedule),
    terminal.onScroll(schedule),
    terminal.buffer.onBufferChange(() => {
      clear();
      schedule();
    }),
  ];
  update();

  return {
    setTheme(nextTheme) {
      theme = nextTheme;
      update();
    },
    dispose() {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const listener of listeners) listener.dispose();
      clear();
    },
  };
}
