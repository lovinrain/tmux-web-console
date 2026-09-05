import type {
  IBufferLine,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";

const FILE_EXTENSION = /\.(?:md|pdf|png|txt)/gi;
const MAX_LINK_TEXT_LENGTH = 4_096;
const MAX_WRAPPED_TEXT_LENGTH = 2_048;
const UNQUOTED_BOUNDARIES = new Set([
  '"',
  "'",
  "`",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "|",
  ",",
  ";",
  "=",
  "!",
]);

export interface TerminalFilePathMatch {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface TerminalFileLinkCallbacks {
  activate: (event: MouseEvent, path: string) => void;
  hover?: (event: MouseEvent, path: string) => void;
  leave?: (event: MouseEvent, path: string) => void;
  enabled?: () => boolean;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function openingQuote(text: string, closingIndex: number, quote: string): number {
  for (let cursor = closingIndex - 1; cursor >= 0; cursor -= 1) {
    if (text[cursor] === quote && !isEscaped(text, cursor)) return cursor;
  }
  return -1;
}

function unquotedStart(text: string, extensionStart: number): number {
  let cursor = extensionStart - 1;
  while (cursor >= 0) {
    const character = text[cursor];
    if (/\s/.test(character)) {
      if (isEscaped(text, cursor)) {
        cursor -= 2;
        continue;
      }
      break;
    }
    if (UNQUOTED_BOUNDARIES.has(character)) break;
    cursor -= 1;
  }
  return cursor + 1;
}

function canEndPath(text: string, endIndex: number): boolean {
  const next = text[endIndex];
  if (next === undefined || /\s/.test(next)) return true;
  if ('"\'`)]}>,:;!?'.includes(next)) return true;
  if (next !== ".") return false;
  const afterPeriod = text[endIndex + 1];
  return afterPeriod === undefined || /\s/.test(afterPeriod) || '")]}>'.includes(afterPeriod);
}

function decodedPath(rawPath: string): string {
  return rawPath.replace(/\\([^\n])/g, "$1");
}

function validPathCandidate(path: string): boolean {
  if (
    path.length === 0
    || path.length > MAX_LINK_TEXT_LENGTH
    || /[\u0000-\u001f\u007f]/.test(path)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    || !/\.(?:md|pdf|png|txt)$/i.test(path)
  ) return false;
  const name = path.split("/").pop() || "";
  return name.length > 4;
}

export function findTerminalFilePaths(text: string): TerminalFilePathMatch[] {
  const matches: TerminalFilePathMatch[] = [];
  FILE_EXTENSION.lastIndex = 0;
  let extension: RegExpExecArray | null;
  while ((extension = FILE_EXTENSION.exec(text)) !== null) {
    const endIndex = extension.index + extension[0].length;
    if (!canEndPath(text, endIndex)) continue;

    const closingQuote = text[endIndex];
    const quoteStart = closingQuote === '"' || closingQuote === "'"
      ? openingQuote(text, endIndex, closingQuote)
      : -1;
    const startIndex = quoteStart >= 0
      ? quoteStart + 1
      : unquotedStart(text, extension.index);
    const rawPath = text.slice(startIndex, endIndex);
    const path = decodedPath(rawPath);
    if (!validPathCandidate(path)) continue;
    if (matches.some((match) => (
      startIndex < match.endIndex && endIndex > match.startIndex
    ))) continue;
    matches.push({ text: path, startIndex, endIndex });
  }
  return matches;
}

export function resolveTerminalFileLinkPath(
  candidate: string,
  panePath: string,
): string | null {
  if (
    !validPathCandidate(candidate)
    || !panePath.startsWith("/")
    || /[\u0000-\u001f\u007f]/.test(panePath)
  ) return null;
  if (candidate.startsWith("/")) return candidate;
  if (candidate.startsWith("~/")) return candidate;
  if (candidate.startsWith("~")) return null;
  const cwd = panePath.replace(/\/+$/, "") || "/";
  return cwd === "/" ? `/${candidate}` : `${cwd}/${candidate}`;
}

function windowedLineStrings(
  lineIndex: number,
  terminal: Terminal,
): [string[], number] {
  let line: IBufferLine | undefined;
  let topIndex = lineIndex;
  let bottomIndex = lineIndex;
  let length = 0;
  let content = "";
  const lines: string[] = [];

  if ((line = terminal.buffer.active.getLine(lineIndex))) {
    const currentContent = line.translateToString(true);
    if (line.isWrapped && currentContent[0] !== " ") {
      while (
        (line = terminal.buffer.active.getLine(--topIndex))
        && length < MAX_WRAPPED_TEXT_LENGTH
      ) {
        content = line.translateToString(true);
        length += content.length;
        lines.push(content);
        if (!line.isWrapped || content.includes(" ")) break;
      }
      lines.reverse();
    }

    lines.push(currentContent);
    length = 0;
    while (
      (line = terminal.buffer.active.getLine(++bottomIndex))
      && line.isWrapped
      && length < MAX_WRAPPED_TEXT_LENGTH
    ) {
      content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (content.includes(" ")) break;
    }
  }
  return [lines, topIndex];
}

// Map a JavaScript string offset back to xterm's cell coordinates. Wide and
// combined characters can occupy a different number of cells than code units.
function mapStringIndex(
  terminal: Terminal,
  lineIndex: number,
  columnIndex: number,
  stringIndex: number,
): [number, number] {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let start = columnIndex;
  while (stringIndex > 0) {
    const line = buffer.getLine(lineIndex);
    if (!line) return [-1, -1];
    for (let cursor = start; cursor < line.length; cursor += 1) {
      line.getCell(cursor, cell);
      const characters = cell.getChars();
      if (cell.getWidth()) {
        stringIndex -= characters.length || 1;
        if (cursor === line.length - 1 && characters === "") {
          const nextLine = buffer.getLine(lineIndex + 1);
          if (nextLine?.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) stringIndex += 1;
          }
        }
      }
      if (stringIndex < 0) return [lineIndex, cursor];
    }
    lineIndex += 1;
    start = 0;
  }
  return [lineIndex, start];
}

export class TerminalFileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly callbacks: TerminalFileLinkCallbacks,
  ) {}

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    if (this.callbacks.enabled && !this.callbacks.enabled()) {
      callback(undefined);
      return;
    }
    const [lines, startLineIndex] = windowedLineStrings(
      bufferLineNumber - 1,
      this.terminal,
    );
    const matches = findTerminalFilePaths(lines.join(""));
    const links: ILink[] = [];
    for (const match of matches) {
      const [startY, startX] = mapStringIndex(
        this.terminal,
        startLineIndex,
        0,
        match.startIndex,
      );
      const [endY, endX] = mapStringIndex(
        this.terminal,
        startY,
        startX,
        match.endIndex - match.startIndex,
      );
      if (startY < 0 || startX < 0 || endY < 0 || endX < 0) continue;
      links.push({
        range: {
          start: { x: startX + 1, y: startY + 1 },
          end: { x: endX, y: endY + 1 },
        },
        text: match.text,
        activate: this.callbacks.activate,
        hover: this.callbacks.hover,
        leave: this.callbacks.leave,
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}
