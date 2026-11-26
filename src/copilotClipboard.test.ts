import type { IBufferRange, Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { stripCopilotCopyBorder } from "./copilotClipboard";

const cols = 32;
const framed = (text: string) => text.padEnd(cols - 1) + "┃";

function strip(
  selection: string,
  rows: string[],
  range: IBufferRange = { start: { x: 0, y: 0 }, end: { x: cols, y: rows.length - 1 } },
  wrappedRows: number[] = [],
): string {
  const lines = rows.map((row, index) => ({
    length: cols,
    isWrapped: wrappedRows.includes(index),
    getCell: (column: number) => ({ getChars: () => row[column] ?? "" }),
    translateToString: (_trim: boolean, start = 0, end = cols) => row.slice(start, end),
  }));
  const terminal = {
    cols,
    buffer: { active: { getLine: (row: number) => lines[row], length: lines.length } },
    getSelectionPosition: () => range,
  } as unknown as Pick<Terminal, "buffer" | "cols" | "getSelectionPosition">;
  return stripCopilotCopyBorder(terminal, selection);
}

describe("Copilot clipboard selections", () => {
  it("removes a right-edge frame and padding, including padding on a partial last row", () => {
    const rows = [framed("● • fusion"), framed(""), framed("   echo a | b ┃")];
    const range = { start: { x: 2, y: 0 }, end: { x: 20, y: 2 } };
    const selection = [rows[0].slice(2), rows[1], rows[2].slice(0, 20)].join("\r\n");
    expect(strip(selection, rows, range)).toBe("• fusion\r\n\r\n   echo a | b ┃");
  });

  it("finds the frame next to a single selected row", () => {
    const rows = [framed("● • fusion"), framed("   • gemini")];
    const range = { start: { x: 0, y: 1 }, end: { x: cols, y: 1 } };
    expect(strip(rows[1], rows, range)).toBe("   • gemini");
  });

  it("leaves interior or isolated box drawing and ordinary pipes in the selection", () => {
    const rows = ["  some output    ┃", "   text  |", framed("  standalone edge")];
    const selection = rows.join("\n");
    expect(strip(selection, rows)).toBe(selection);
  });

  it("keeps xterm's line joins when a selection includes wrapped output", () => {
    const fullRow = "Shell output".padEnd(cols, ".");
    const rows = [fullRow, "continued", framed("answer"), framed("  second line")];
    const selection = [fullRow + rows[1], rows[2], rows[3]].join("\n");
    expect(strip(selection, rows, undefined, [1]))
      .toBe(fullRow + "continued\nanswer\n  second line");
  });

  it("keeps xterm's text for a column selection that differs from a linear selection", () => {
    const rows = [framed("  first"), framed("  second")];
    const range = { start: { x: 2, y: 0 }, end: { x: cols, y: 1 } };
    const selection = rows.map((row) => row.slice(2)).join("\n");
    expect(strip(selection, rows, range)).toBe(selection);
  });
});
