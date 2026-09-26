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

describe("Codex composer theme adapter", () => {
  it.each([
    [235, "palette"],
    [255, "palette"],
    [0x282a29, "rgb"],
    [0xf0f0eb, "rgb"],
  ] as const)("recolors multiline composer background %s/%s without changing its cells", (color, mode) => {
    const view = fixture(color, mode);
    const original = JSON.stringify(view.cells);
    const adapter = attachCodexComposerTheme(view.terminal, "dark");
    expect(view.active().map(({ options }) => options.marker.line)).toEqual([4, 5, 6, 7]);
    expect(view.active().every(({ options }) => options.backgroundColor === "#282a29")).toBe(true);
    adapter.setTheme("light");
    expect(view.active()).toHaveLength(4);
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

  it("preserves reverse-video selections and leaves foreground/accent styling alone", () => {
    const view = fixture();
    view.cells[5][5].inverse = true;
    view.cells[5][6].inverse = true;
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    const selectedRow = view.active().filter(({ options }) => options.marker.line === 5);
    expect(selectedRow.map(({ options }) => [options.x, options.width])).toEqual([[0, 5], [7, 23]]);
    expect(view.active().every(({ options }) => !Object.hasOwn(options, "foregroundColor"))).toBe(true);
    adapter.dispose();
  });

  it("keeps adjacent panes and historical prompt bands outside the active composer unchanged", () => {
    const view = fixture();
    for (let y = 4; y <= 7; y += 1) {
      for (let x = 20; x < 30; x += 1) view.cells[y][x] = { char: "x", color: -1, mode: "default" };
    }
    view.cells[1] = view.cells[5].map((cell) => ({ ...cell }));
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active().map(({ options }) => [options.marker.line, options.width])).toEqual([
      [4, 20], [5, 20], [6, 20], [7, 20],
    ]);
    adapter.dispose();
  });

  it.each(["no prompt", "colored background", "cursor outside"])("ignores %s", (scenario) => {
    const view = fixture(scenario === "colored background" ? 0xff0000 : 235,
      scenario === "colored background" ? "rgb" : "palette");
    if (scenario === "no prompt") view.cells[5][0].char = "x";
    if (scenario === "cursor outside") Object.assign(view.buffer, { cursorY: 9 });
    const adapter = attachCodexComposerTheme(view.terminal, "light");
    expect(view.active()).toEqual([]);
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
