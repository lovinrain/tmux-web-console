import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessionFiles,
  previewSessionFile,
  sessionFileDownloadUrl,
  sessionFileImageUrl,
  uploadSessionFile,
  type SessionDirectoryListing,
  type SessionFileEntry,
} from "../api";
import { SessionFilesPanel } from "./SessionFilesPanel";

vi.mock("../api", () => ({
  listSessionFiles: vi.fn(),
  previewSessionFile: vi.fn(),
  sessionFileDownloadUrl: vi.fn(),
  sessionFileImageUrl: vi.fn(),
  uploadSessionFile: vi.fn(),
}));

function entry(
  name: string,
  path: string,
  kind: SessionFileEntry["kind"],
  overrides: Partial<SessionFileEntry> = {},
): SessionFileEntry {
  const absolutePath = `/work/project/${path}`;
  return {
    name,
    path,
    absolutePath,
    terminalText: absolutePath.includes(" ") ? `'${absolutePath}'` : absolutePath,
    kind,
    size: kind === "file" ? 14 : null,
    modified: 1_700_000_000,
    hidden: name.startsWith("."),
    symlink: false,
    accessible: true,
    ...overrides,
  };
}

function listing(path: string, entries: SessionFileEntry[]): SessionDirectoryListing {
  const absolutePath = path ? `/work/project/${path}` : "/work/project";
  return {
    root: "/work/project",
    path,
    absolutePath,
    terminalText: absolutePath,
    entries,
    truncated: false,
    limit: 1_000,
  };
}

function renderPanel(overrides: {
  onClose?: () => void;
  onInsertPath?: (terminalText: string) => boolean;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onInsertPath = overrides.onInsertPath ?? vi.fn(() => true);
  render(
    <SessionFilesPanel
      sessionName="agent"
      sessionId="$7"
      paneId="%3"
      panePath="/work/project"
      onClose={onClose}
      onInsertPath={onInsertPath}
    />,
  );
  return { onClose, onInsertPath };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sessionFileDownloadUrl).mockReturnValue("/files/download");
  vi.mocked(sessionFileImageUrl).mockReturnValue("/files/image");
  document.documentElement.classList.remove("session-files-panel-moving");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

describe("SessionFilesPanel", () => {
  it("browses folders, previews text, and stages a shell-safe path", async () => {
    const root = listing("", [
      entry("src", "src", "directory"),
      entry(".env", ".env", "file"),
    ]);
    const source = listing("src", [
      entry("main file.ts", "src/main file.ts", "file"),
    ]);
    vi.mocked(listSessionFiles).mockImplementation(async (
      _session,
      _sessionId,
      _paneId,
      path,
    ) => path === "src" ? source : root);
    vi.mocked(previewSessionFile).mockResolvedValue({
      root: "/work/project",
      name: "main file.ts",
      path: "src/main file.ts",
      absolutePath: "/work/project/src/main file.ts",
      terminalText: "'/work/project/src/main file.ts'",
      kind: "text",
      mediaType: "text/typescript",
      size: 14,
      modified: 1_700_000_000,
      truncated: false,
      previewBytes: 14,
      content: "export const x = 1;",
    });
    const { onInsertPath } = renderPanel();

    const panel = await screen.findByRole("dialog", { name: "Files" });
    expect(listSessionFiles).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "",
      expect.any(AbortSignal),
    );
    expect(within(panel).queryByRole("button", { name: "File .env" })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Folder src" }));
    await waitFor(() => expect(listSessionFiles).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "src",
      expect.any(AbortSignal),
    ));
    const file = await within(panel).findByRole("button", { name: "File main file.ts" });
    fireEvent.click(file);

    expect(await within(panel).findByText("export const x = 1;")).toBeInTheDocument();
    expect(previewSessionFile).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "src/main file.ts",
      expect.any(AbortSignal),
    );
    const download = within(panel).getByRole("link", { name: "Download selected file" });
    expect(download).toHaveAttribute("href", "/files/download");
    expect(download).toHaveAttribute("download", "main file.ts");
    expect(sessionFileDownloadUrl).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "src/main file.ts",
    );

    fireEvent.click(within(panel).getByRole("button", {
      name: "Insert server path into staged input",
    }));
    expect(onInsertPath).toHaveBeenCalledWith("'/work/project/src/main file.ts'");
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Path added to staged input",
    );

    fireEvent.click(within(panel).getByRole("button", { name: "Copy server path" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "/work/project/src/main file.ts",
    ));
  });

  it("reveals dotfiles on demand and reports binary files without rendering content", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry(".token", ".token", "file"),
      entry("archive.bin", "archive.bin", "file", { size: 2_048 }),
    ]));
    vi.mocked(previewSessionFile).mockResolvedValue({
      root: "/work/project",
      name: "archive.bin",
      path: "archive.bin",
      absolutePath: "/work/project/archive.bin",
      terminalText: "/work/project/archive.bin",
      kind: "binary",
      mediaType: "application/octet-stream",
      size: 2_048,
      modified: 1_700_000_000,
      truncated: false,
      previewBytes: 2_048,
      content: null,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    expect(within(panel).queryByRole("button", { name: "File .token" })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Show dotfiles" }));
    expect(within(panel).getByRole("button", { name: "File .token" })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "File archive.bin" }));
    expect(await within(panel).findByText("Binary file")).toBeInTheDocument();
    expect(within(panel).getByText(/Preview is disabled/)).toBeInTheDocument();
  });

  it("renders raster images with a full-size link and a decode failure state", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("diagram.png", "diagram.png", "file", { size: 4_096 }),
    ]));
    vi.mocked(previewSessionFile).mockResolvedValue({
      root: "/work/project",
      name: "diagram.png",
      path: "diagram.png",
      absolutePath: "/work/project/diagram.png",
      terminalText: "/work/project/diagram.png",
      kind: "image",
      mediaType: "image/png",
      size: 4_096,
      modified: 1_700_000_000,
      truncated: false,
      previewBytes: 4_096,
      content: null,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File diagram.png" }));
    const image = await within(panel).findByRole("img", {
      name: "Preview of diagram.png",
    });
    expect(image).toHaveAttribute("src", "/files/image");
    expect(sessionFileImageUrl).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "diagram.png",
    );
    expect(within(panel).getByText("Decoding image")).toBeInTheDocument();

    fireEvent.load(image);
    expect(within(panel).getByRole("link", { name: "Open diagram.png full size" }))
      .toHaveAttribute("href", "/files/image");
    expect(within(panel).getByText("Open full size")).toBeInTheDocument();
    expect(within(panel).queryByText("Decoding image")).not.toBeInTheDocument();

    fireEvent.error(image);
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "Image preview unavailable",
    );
  });

  it("keeps oversized raster images downloadable without requesting inline content", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("huge.webp", "huge.webp", "file", { size: 40 * 1_024 * 1_024 }),
    ]));
    vi.mocked(previewSessionFile).mockResolvedValue({
      root: "/work/project",
      name: "huge.webp",
      path: "huge.webp",
      absolutePath: "/work/project/huge.webp",
      terminalText: "/work/project/huge.webp",
      kind: "image",
      mediaType: "image/webp",
      size: 40 * 1_024 * 1_024,
      modified: 1_700_000_000,
      truncated: true,
      previewBytes: 25 * 1_024 * 1_024,
      content: null,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File huge.webp" }));
    expect(await within(panel).findByText("Image is too large to preview"))
      .toBeInTheDocument();
    expect(within(panel).getByText(/Inline viewing is limited to 25 MiB/))
      .toBeInTheDocument();
    expect(within(panel).queryByRole("img")).not.toBeInTheDocument();
    expect(sessionFileImageUrl).not.toHaveBeenCalled();
    expect(within(panel).getByRole("link", { name: "Download selected file" }))
      .toHaveAttribute("href", "/files/download");
  });

  it("is movable from its title strip and closes with Escape", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", []));
    const { onClose } = renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const header = within(panel).getByRole("heading", { name: "Files" }).closest("header");
    expect(header).not.toBeNull();

    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: 11 },
        pointerType: { value: "mouse" },
        isPrimary: { value: true },
      });
      fireEvent(header!, event);
    };
    dispatchPointer("pointerdown", 500, 100);
    dispatchPointer("pointermove", 420, 150);
    expect(document.documentElement).toHaveClass("session-files-panel-moving");
    expect(panel.getAttribute("style")).toContain("--session-files-y:");
    dispatchPointer("pointerup", 420, 150);
    expect(document.documentElement).not.toHaveClass("session-files-panel-moving");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uploads picked files into the shown folder and selects the new entry", async () => {
    const uploaded = entry("notes.txt", "notes.txt", "file", { size: 8 });
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", []))
      .mockResolvedValue(listing("", [uploaded]));
    vi.mocked(uploadSessionFile).mockResolvedValue(uploaded);
    vi.mocked(previewSessionFile).mockResolvedValue({
      root: "/work/project",
      name: "notes.txt",
      path: "notes.txt",
      absolutePath: "/work/project/notes.txt",
      terminalText: "/work/project/notes.txt",
      kind: "text",
      mediaType: "text/plain",
      size: 8,
      modified: 1_700_000_000,
      truncated: false,
      previewBytes: 8,
      content: "new note",
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const picker = panel.querySelector<HTMLInputElement>("input[type='file']");
    expect(picker).not.toBeNull();
    const file = new File(["new note"], "notes.txt", { type: "text/plain" });

    fireEvent.change(picker!, { target: { files: [file] } });

    await waitFor(() => expect(uploadSessionFile).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "",
      file,
      expect.any(AbortSignal),
    ));
    expect(await within(panel).findByText("8 B uploaded")).toBeInTheDocument();
    const uploadedRow = await within(panel).findByRole("button", { name: "File notes.txt" });
    expect(uploadedRow).toHaveAttribute("aria-pressed", "true");
    expect(await within(panel).findByText("new note")).toBeInTheDocument();
  });

  it("accepts file drops and keeps a per-file conflict visible", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", []));
    vi.mocked(uploadSessionFile).mockRejectedValue(
      new Error("a file or directory with this name already exists"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const file = new File(["duplicate"], "existing.txt", { type: "text/plain" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      dropEffect: "none",
    } as unknown as DataTransfer;

    fireEvent.dragEnter(panel, { dataTransfer });
    expect(within(panel).getByText("Drop to upload")).toBeInTheDocument();
    fireEvent.drop(panel, { dataTransfer });

    await waitFor(() => expect(uploadSessionFile).toHaveBeenCalledWith(
      "agent",
      "$7",
      "%3",
      "",
      file,
      expect.any(AbortSignal),
    ));
    expect(await within(panel).findByText(
      "a file or directory with this name already exists",
    )).toBeInTheDocument();
    expect(within(panel).getByText("0 uploaded, 1 failed.")).toBeInTheDocument();
  });
});
