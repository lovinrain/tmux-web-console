import type { IBufferLine, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { TERMINAL_THEMES, type TerminalThemeMode } from "./terminalTheme";

export interface TerminalThemeRow {
  y: number;
  spans: Array<{ x: number; width: number }>;
}

export interface TerminalRowTheme {
  setTheme: (theme: TerminalThemeMode, terminalBackground?: string) => void;
  dispose: () => void;
}

export function shadeTerminalBackground(
  theme: TerminalThemeMode,
  terminalBackground: string | undefined,
  amount: number,
): string {
  const background = terminalBackground && /^#[0-9a-f]{6}$/i.test(terminalBackground)
    ? terminalBackground
    : TERMINAL_THEMES[theme].background!;
  const color = Number.parseInt(background.slice(1), 16);
  const channels = [color >>> 16, (color >>> 8) & 255, color & 255];
  const blend = theme === "dark" ? 255 : 0;
  return "#" + channels.map((channel) => (
    Math.floor(channel * (1 - amount) + blend * amount).toString(16).padStart(2, "0")
  )).join("");
}

export function highlightSpans(
  line: IBufferLine, left: number, right: number, defaultBackgroundOnly = false,
): TerminalThemeRow["spans"] {
  const spans: TerminalThemeRow["spans"] = [];
  let start: number | null = null;
  for (let x = left; x <= right; x += 1) {
    const cell = x < right ? line.getCell(x) : undefined;
    // Keep application selection and reverse video above the row highlight.
    const highlight = x < right && !cell?.isInverse()
      && (!defaultBackgroundOnly || cell?.isBgDefault());
    if (highlight && start === null) start = x;
    if (!highlight && start !== null) {
      spans.push({ x: start, width: x - start });
      start = null;
    }
  }
  return spans;
}

export function attachTerminalRowTheme(
  terminal: Terminal,
  profile: {
    rows: (terminal: Terminal) => TerminalThemeRow[];
    background: (theme: TerminalThemeMode, terminalBackground?: string) => string;
  },
  initialTheme: TerminalThemeMode,
  terminalBackground?: string,
): TerminalRowTheme {
  let backgroundColor = profile.background(initialTheme, terminalBackground);
  let disposed = false;
  let frame: number | undefined;
  let signature = "";
  let activeBuffer = terminal.buffer.active;
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
    const rows = profile.rows(terminal).filter((row) => row.spans.length > 0);
    const nextSignature = JSON.stringify([backgroundColor, rows]);
    if (
      signature === nextSignature
      && markers.every((marker, index) => !marker.isDisposed && marker.line === rows[index]?.y)
    ) return;
    clear();
    signature = nextSignature;
    for (const row of rows) {
      const marker = terminal.registerMarker(row.y - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
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
    setTheme(theme, nextTerminalBackground) {
      backgroundColor = profile.background(theme, nextTerminalBackground);
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const listener of listeners) listener.dispose();
      clear();
    },
  };
}
