import type { IBufferCell, IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  findTerminalFilePaths,
  resolveTerminalFileLinkPath,
  TerminalFileLinkProvider,
} from "./terminalFileLinks";

describe("terminal file path detection", () => {
  it("finds absolute, relative, home, and bare previewable file paths", () => {
    const text = "open /tmp/chart.PNG, ./notes.txt:12 ~/shots/final.png report.TXT README.md design.PDF";
    expect(findTerminalFilePaths(text).map((match) => match.text)).toEqual([
      "/tmp/chart.PNG",
      "./notes.txt",
      "~/shots/final.png",
      "report.TXT",
      "README.md",
      "design.PDF",
    ]);
  });

  it("keeps spaces inside quoted or shell-escaped paths", () => {
    const text = "'results/final chart.png' results/review\\ notes.txt";
    expect(findTerminalFilePaths(text).map((match) => match.text)).toEqual([
      "results/final chart.png",
      "results/review notes.txt",
    ]);
    const [quoted] = findTerminalFilePaths(text);
    expect(text.slice(quoted.startIndex, quoted.endIndex)).toBe("results/final chart.png");
  });

  it("leaves URLs, unsupported extensions, and suffix lookalikes alone", () => {
    const text = [
      "https://example.test/image.png",
      "file:///tmp/document.txt",
      "photo.jpg",
      "notes.json",
      "archive.txt.bak",
      ".png",
    ].join(" ");
    expect(findTerminalFilePaths(text)).toEqual([]);
  });

  it("does not include sentence punctuation or text line coordinates", () => {
    const text = "See (output/result.txt:42), then [images/map.png].";
    expect(findTerminalFilePaths(text).map((match) => match.text)).toEqual([
      "output/result.txt",
      "images/map.png",
    ]);
  });
});

describe("terminal file path resolution", () => {
  it("resolves relative paths from the live pane directory", () => {
    expect(resolveTerminalFileLinkPath("report.txt", "/work/project"))
      .toBe("/work/project/report.txt");
    expect(resolveTerminalFileLinkPath("../shots/result.png", "/work/project/"))
      .toBe("/work/project/../shots/result.png");
    expect(resolveTerminalFileLinkPath("image.png", "/"))
      .toBe("/image.png");
    expect(resolveTerminalFileLinkPath("docs/guide.md", "/work/project"))
      .toBe("/work/project/docs/guide.md");
    expect(resolveTerminalFileLinkPath("artifacts/report.pdf", "/work/project"))
      .toBe("/work/project/artifacts/report.pdf");
  });

  it("preserves absolute and current-user home paths", () => {
    expect(resolveTerminalFileLinkPath("/tmp/result.png", "/work"))
      .toBe("/tmp/result.png");
    expect(resolveTerminalFileLinkPath("~/notes.txt", "/work"))
      .toBe("~/notes.txt");
  });

  it("rejects invalid candidates and unsupported home-user expansion", () => {
    expect(resolveTerminalFileLinkPath("https://example.test/a.png", "/work")).toBeNull();
    expect(resolveTerminalFileLinkPath("notes.json", "/work")).toBeNull();
    expect(resolveTerminalFileLinkPath("~other/notes.txt", "/work")).toBeNull();
    expect(resolveTerminalFileLinkPath("notes.txt", "relative/work")).toBeNull();
  });
});

class FakeCell {
  chars = "";
  width = 1;

  getChars() { return this.chars; }
  getWidth() { return this.width; }
}

class FakeLine {
  readonly length: number;

  constructor(
    private readonly content: string,
    readonly isWrapped: boolean,
    columns: number,
  ) {
    this.length = columns;
  }

  translateToString(trimRight = false): string {
    return trimRight ? this.content.trimEnd() : this.content.padEnd(this.length);
  }

  getCell(index: number, target?: IBufferCell): IBufferCell | undefined {
    const cell = target as unknown as FakeCell | undefined;
    if (!cell || index < 0 || index >= this.length) return undefined;
    cell.chars = this.content[index] || "";
    cell.width = 1;
    return target;
  }
}

function fakeTerminal(lines: FakeLine[]): Terminal {
  return {
    buffer: {
      active: {
        getLine: (index: number) => lines[index] as unknown as IBufferLine | undefined,
        getNullCell: () => new FakeCell() as unknown as IBufferCell,
      },
    },
  } as unknown as Terminal;
}

describe("TerminalFileLinkProvider", () => {
  it("maps detected path text to one-based xterm cell ranges", () => {
    const terminal = fakeTerminal([new FakeLine("open /tmp/chart.png now", false, 40)]);
    const activate = vi.fn();
    const provider = new TerminalFileLinkProvider(terminal, { activate });
    let links: ILink[] | undefined;
    provider.provideLinks(1, (provided) => { links = provided; });

    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe("/tmp/chart.png");
    expect(links?.[0].range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 19, y: 1 },
    });
    links?.[0].activate(new MouseEvent("mouseup"), links[0].text);
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), "/tmp/chart.png");
  });

  it("maps a path that wraps onto the requested terminal row", () => {
    const terminal = fakeTerminal([
      new FakeLine("prefix /long/", false, 13),
      new FakeLine("result.txt", true, 13),
    ]);
    const provider = new TerminalFileLinkProvider(terminal, { activate: vi.fn() });
    let links: ILink[] | undefined;
    provider.provideLinks(2, (provided) => { links = provided; });

    expect(links?.[0]).toMatchObject({
      text: "/long/result.txt",
      range: {
        start: { x: 8, y: 1 },
        end: { x: 10, y: 2 },
      },
    });
  });
});
