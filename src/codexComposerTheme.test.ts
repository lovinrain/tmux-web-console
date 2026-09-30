import type { IBuffer, IBufferCell, IBufferLine, IDecorationOptions, IMarker, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCodexComposerTheme } from "./codexComposerTheme";

interface CellSpec {
  char: string;
  color: number;
  mode: "palette" | "rgb" | "default";
  inverse?: boolean;
}

function fixture(color = 235, mode: CellSpec["mode"] = "palette", prompt = "›") {
  const cols = 30;
  const cells: CellSpec[][] = Array.from({ length: 12 }, () => (
    Array.from({ length: cols }, () => ({ char: " ", color: -1, mode: "default" as const }))
  ));
  for (let y = 4; y <= 7; y += 1) {
    cells[y] = Array.from({ length: cols }, () => ({ char: " ", color, mode }));
  }
  for (const [x, char] of [...`${prompt} keep this draft`].entries()) cells[5][x].char = char;
  for (const [x, char] of [..."  second line"].entries()) cells[6][x].char = char;
  const cellView = (spec: CellSpec): IBufferCell => ({
    getChars: () => spec.char,
    getBgColor: () => spec.color,
    getBgColorMode: () => ({ default: 0, palette: 1, rgb: 2 })[spec.mode],
    isBgDefault: () => spec.mode === "default",
    isBgPalette: () => spec.mode === "palette",
    isBgRGB: () => spec.mode === "rgb",
    isInverse: () => spec.inverse ? 1 : 0,
  } as IBufferCell);
  const buffer = {
    type: "alternate",
    get length() { return cells.length; },
    baseY: 0,
    viewportY: 0,
    cursorX: 13,
    cursorY: 6,
    getLine: (y: number) => cells[y] ? {
      getCell: (x: number) => cells[y][x] ? cellView(cells[y][x]) : undefined,
      translateToString: (_trim: boolean, start = 0, end = cols) => (
        cells[y].slice(start, end).map((cell) => cell.char).join("")
      ),
    } as IBufferLine : undefined,
  } as IBuffer;
  const events = new Map<string, Set<() => void>>();
  const listen = (name: string) => (callback: () => void) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)!.add(callback);
    return { dispose: vi.fn(() => { events.get(name)!.delete(callback); }) };
  };
  const registrations: Array<{ options: IDecorationOptions; dispose: ReturnType<typeof vi.fn> }> = [];
  const markers: IMarker[] = [];
  const terminal = {
    cols,
    rows: cells.length,
    buffer: { active: buffer, onBufferChange: listen("buffer") },
    onWriteParsed: listen("write"),
    onResize: listen("resize"),
    onScroll: listen("scroll"),
    registerMarker: vi.fn((offset: number) => {
      const marker = { line: buffer.baseY + buffer.cursorY + offset, isDisposed: false } as IMarker;
      marker.dispose = vi.fn(() => { Object.assign(marker, { isDisposed: true }); });
      markers.push(marker);
      return marker;
    }),
    registerDecoration: vi.fn((options: IDecorationOptions) => {
      const registration = { options, dispose: vi.fn() };
      registrations.push(registration);
      return registration;
    }),
  } as unknown as Terminal;
  const emit = (name: string) => { for (const callback of events.get(name) || []) callback(); };
  const active = () => registrations.filter((registration) => !registration.dispose.mock.calls.length);
  return { terminal, buffer, cells, registrations, markers, events, emit, active };
}

function sentMessage(view: ReturnType<typeof fixture>, color = 236, mode: CellSpec["mode"] = "palette", width = 30) {
  for (let y = 0; y <= 2; y += 1) {
    for (let x = 0; x < width; x += 1) view.cells[y][x] = { char: " ", color, mode };
  }
  for (const [x, char] of [..."› sent message"].entries()) view.cells[1][x].char = char;
  for (const [x, char] of [..."  continued"].entries()) view.cells[2][x].char = char;
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const flushFrame = () => {
  const queued = [...frames.values()];
  frames.clear();
  for (const callback of queued) callback(0);
};

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Codex input and sent-message theme adapter", () => {
  it.each([
    [235, 236, "palette"],
    [255, 255, "palette"],
    [0x282a29, 0x323431, "rgb"],
    [0xf0f0eb, 0xf5f5f0, "rgb"],
  ] as const)("recolors composer %s and multiline sent background %s/%s without changing cells", (color, sentColor, mode) => {
    const view = fixture(color, mode);
    sentMessage(view, sentColor, mode);
    const original = JSON.stringify(view.cells);
    const adapter = attachCodexComposerTheme(view.terminal, "dark");
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(view.active().every(({ options }) => options.backgroundColor === "#282a29")).toBe(true);
    adapter.setTheme("light");
    expect(view.active()).toHaveLength(7);
    expect(view.active().every(({ options }) => (
      options.backgroundColor === "#f0f0eb" && options.foregroundColor === undefined
      && options.layer === "bottom" && options.x === 0 && options.width === 30
    ))).toBe(true);
    expect(JSON.stringify(view.cells)).toBe(original);
    adapter.dispose();
    expect(view.active()).toEqual([]);
    expect(view.markers.every((marker) => marker.isDisposed)).toBe(true);
  });

  it.each(["›", "»", "!"])("recognizes the %s Codex prompt", (prompt) => {
    const view = fixture(235, "palette", prompt);
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active()).toHaveLength(4);
    adapter.dispose();
  });

  it.each([
    ["dark", "#2e3440", "#474c56"],
    ["dark", "#282a36", "#41434e"],
    ["dark", "#1a1b26", "#353640"],
    ["light", "#fdf6e3", "#f2ecd9"],
    ["light", "#ffffff", "#f4f4f4"],
    ["light", "#faf4ed", "#f0eae3"],
  ] as const)("blends the %s composer with palette background %s", (mode, background, expected) => {
    const view = fixture();
    sentMessage(view);
    const original = JSON.stringify(view.cells);
    const adapter = attachCodexComposerTheme(view.terminal, mode);
    adapter.setTheme(mode, background);
    expect(view.active()).toHaveLength(7);
    expect(view.active().every(({ options }) => options.backgroundColor === expected)).toBe(true);
    expect(JSON.stringify(view.cells)).toBe(original);
    const count = view.registrations.length;
    adapter.setTheme(mode, background);
    expect(view.registrations).toHaveLength(count);
    adapter.dispose();
  });

  it("preserves reverse-video selections and leaves foreground/accent styling alone", () => {
    const view = fixture();
    sentMessage(view);
    view.cells[1][3].inverse = true;
    view.cells[5][5].inverse = true;
    view.cells[5][6].inverse = true;
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    const selectedRow = view.active().filter(({ options }) => options.marker.line === 5);
    expect(selectedRow.map(({ options }) => [options.x, options.width])).toEqual([[0, 5], [7, 23]]);
    expect(view.active().filter(({ options }) => options.marker.line === 1)
      .map(({ options }) => [options.x, options.width])).toEqual([[0, 3], [4, 26]]);
    expect(view.active().every(({ options }) => !Object.hasOwn(options, "foregroundColor"))).toBe(true);
    adapter.dispose();
  });

  it("recolors historical prompts within the composer columns and preserves adjacent panes", () => {
    const view = fixture();
    for (let y = 4; y <= 7; y += 1) {
      for (let x = 20; x < 30; x += 1) view.cells[y][x] = { char: "x", color: -1, mode: "default" };
    }
    view.cells[1] = view.cells[5].map((cell) => ({ ...cell }));
    for (let x = 21; x < 30; x += 1) view.cells[1][x] = { char: " ", color: 235, mode: "palette" };
    view.cells[1][21].char = "›";
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active().map(({ options }) => [options.marker.line, options.width])).toEqual([
      [1, 20], [4, 20], [5, 20], [6, 20], [7, 20],
    ]);
    adapter.dispose();
  });

  it.each(["no prompt", "colored background"])("ignores %s", (scenario) => {
    const view = fixture(scenario === "colored background" ? 0xff0000 : 235,
      scenario === "colored background" ? "rgb" : "palette");
    if (scenario === "no prompt") view.cells[5][0].char = "x";
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active()).toEqual([]);
    adapter.dispose();
  });

  it("recognizes sent messages with the cursor outside any shaded input, including on initial attach", () => {
    const view = fixture();
    sentMessage(view);
    Object.assign(view.buffer, { cursorY: 9 });
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    adapter.dispose();
  });

  it("recognizes narrower sent messages when the input cursor is past their right edge", () => {
    const view = fixture();
    sentMessage(view, 236, "palette", 20);
    Object.assign(view.buffer, { cursorX: 28 });
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active().map(({ options }) => [options.marker.line, options.width])).toEqual([
      [0, 20], [1, 20], [2, 20], [4, 30], [5, 30], [6, 30], [7, 30],
    ]);
    adapter.dispose();
  });

  it.each(["»", "!"])("does not mistake an inactive %s band for a sent-message prompt", (prompt) => {
    const view = fixture(235, "palette", prompt);
    Object.assign(view.buffer, { cursorY: 9 });
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active()).toEqual([]);
    adapter.dispose();
  });

  it("themes visible message continuations when their prompt is above the scrollback viewport", () => {
    const view = fixture();
    sentMessage(view, 235);
    view.cells[3] = view.cells[0].map((cell) => ({ ...cell }));
    Object.assign(view.terminal, { rows: 4 });
    Object.assign(view.buffer, { type: "normal", baseY: 8, cursorY: 0, viewportY: 3 });
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([3, 4, 5, 6]);
    Object.assign(view.buffer, { viewportY: 4 });
    view.emit("scroll");
    flushFrame();
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([4, 5, 6, 7]);
    adapter.dispose();
  });

  it("coalesces redraws, removes obsolete rows, and cancels queued work on disposal", () => {
    const view = fixture();
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    view.emit("write");
    view.emit("resize");
    view.emit("scroll");
    expect(frames.size).toBe(1);
    flushFrame();
    expect(view.registrations).toHaveLength(4);
    Object.assign(view.buffer, { cursorY: 9 });
    view.emit("write");
    flushFrame();
    expect(view.active()).toHaveLength(4);
    for (const row of view.cells) {
      for (const cell of row) cell.mode = "default";
    }
    view.emit("write");
    flushFrame();
    expect(view.active()).toEqual([]);
    view.emit("write");
    adapter.dispose();
    expect(frames.size).toBe(0);
    expect([...view.events.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("clears decorations immediately when the terminal switches buffers", () => {
    const view = fixture();
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    view.emit("buffer");
    expect(view.active()).toEqual([]);
    expect(frames.size).toBe(1);
    adapter.dispose();
  });

  it("repairs markers moved by terminal insert/delete operations even when the composer stays put", () => {
    const view = fixture();
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    Object.assign(view.markers[0], { line: 3 });
    view.emit("write");
    flushFrame();
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([4, 5, 6, 7]);
    expect(view.markers[0].isDisposed).toBe(true);
    adapter.dispose();
  });
});
