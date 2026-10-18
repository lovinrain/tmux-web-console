import type { Terminal } from "@xterm/xterm";

export interface CaptureRectangle { x: number; y: number; width: number; height: number }
export interface TerminalCaptureSnapshot {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  cols: number;
  rows: number;
  lines: string[];
  textForArea: (rectangle: CaptureRectangle) => string;
}

export async function captureTerminal(terminal: Terminal | null): Promise<TerminalCaptureSnapshot> {
  const screen = terminal?.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!terminal || !screen) throw new Error("Terminal is not ready to capture");
  const box = screen.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) throw new Error("Terminal is not visible");
  const cols = terminal.cols;
  const rows = terminal.rows;
  const buffer = terminal.buffer.active;
  const bufferLines = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row));
  const lines = bufferLines.map((line) => line?.translateToString(true) ?? "");
  const cells = bufferLines.map((line) => Array.from({ length: cols }, (_, col) => {
    const cell = line?.getCell(col);
    return cell?.getWidth() === 0 ? "" : cell?.getChars() || " ";
  }));
  // Copy synchronously before async image/font work; live output keeps running behind this snapshot.
  const clone = screen.cloneNode(true) as HTMLElement;
  const owner = terminal.element!.cloneNode(false) as HTMLElement;
  owner.style.cssText = `position:fixed;left:-100000px;top:0;width:${box.width}px;height:${box.height}px;pointer-events:none`;
  clone.style.width = `${box.width}px`;
  clone.style.height = `${box.height}px`;
  owner.append(clone);
  document.body.append(owner);
  let canvas: HTMLCanvasElement;
  try {
    const { toCanvas } = await import("html-to-image");
    canvas = await toCanvas(clone, { width: box.width, height: box.height,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      backgroundColor: terminal.options.theme?.background ?? "#101510",
      preferredFontFormat: "woff2" });
  } finally { owner.remove(); }
  return { canvas, width: box.width, height: box.height, cols, rows, lines,
    textForArea: (rectangle) => {
      const firstRow = Math.max(0, Math.floor(rectangle.y / box.height * rows));
      const lastRow = Math.min(rows, Math.ceil((rectangle.y + rectangle.height) / box.height * rows));
      const firstCol = Math.max(0, Math.floor(rectangle.x / box.width * cols));
      const lastCol = Math.min(cols, Math.ceil((rectangle.x + rectangle.width) / box.width * cols));
      return cells.slice(firstRow, lastRow).map((line) => line.slice(firstCol, lastCol).join("").trimEnd()).join("\n");
    } };
}

export function cropCapture(snapshot: TerminalCaptureSnapshot, rectangle: CaptureRectangle): Promise<Blob> {
  const ratio = snapshot.canvas.width / snapshot.width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rectangle.width * ratio));
  canvas.height = Math.max(1, Math.round(rectangle.height * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image capture is unavailable in this browser");
  context.drawImage(snapshot.canvas, rectangle.x * ratio, rectangle.y * ratio,
    rectangle.width * ratio, rectangle.height * ratio, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Unable to create capture image")), "image/png"));
}
