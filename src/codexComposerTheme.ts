import type { IBuffer, IBufferCell, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { TerminalThemeMode } from "./terminalTheme";

// Codex blends its startup terminal background with white (12%) or black (4%)
// and caches that color. Preserve the existing defaults for mode-only callers.
const COMPOSER_BACKGROUNDS: Record<TerminalThemeMode, string> = {
  dark: "#282a29",
  light: "#f0f0eb",
};

function composerBackground(theme: TerminalThemeMode, terminalBackground?: string): string {
  if (!terminalBackground || !/^#[0-9a-f]{6}$/i.test(terminalBackground)) {
    return COMPOSER_BACKGROUNDS[theme];
  }
  const color = Number.parseInt(terminalBackground.slice(1), 16);
  const channels = [color >>> 16, (color >>> 8) & 255, color & 255];
  const amount = theme === "dark" ? 0.12 : 0.04;
  const blend = theme === "dark" ? 255 : 0;
  return `#${channels.map((channel) => (
    Math.floor(channel * (1 - amount) + blend * amount).toString(16).padStart(2, "0")
  )).join("")}`;
}

interface Background {
  mode: number;
  color: number;
}

interface ComposerRow {
  y: number;
  spans: Array<{ x: number; width: number }>;
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

function composerRows(terminal: Terminal): ComposerRow[] {
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

  const rows = new Map<number, ComposerRow>();
  for (const { left, right, top, bottom } of bands) {
    for (let y = Math.max(top, buffer.viewportY); y <= Math.min(bottom, viewportEnd - 1); y += 1) {
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
      rows.set(y, { y, spans });
    }
  }
  return [...rows.values()].sort((a, b) => a.y - b.y);
}

/** Recolors the Codex composer and visible sent-message bands without changing terminal data. */
export function attachCodexComposerTheme(
  terminal: Terminal,
  initialTheme: TerminalThemeMode,
  terminalBackground?: string,
): {
  setTheme: (theme: TerminalThemeMode, terminalBackground?: string) => void;
  dispose: () => void;
} {
  let theme = initialTheme;
  let backgroundColor = composerBackground(theme, terminalBackground);
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
    const nextSignature = JSON.stringify([theme, backgroundColor, rows]);
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
          backgroundColor,
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
    setTheme(nextTheme, nextTerminalBackground) {
      theme = nextTheme;
      backgroundColor = composerBackground(theme, nextTerminalBackground);
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
