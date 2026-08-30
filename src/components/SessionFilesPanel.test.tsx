import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  copySessionFileEntry,
  createSessionFileEntry,
  deleteSessionFileEntry,
  listSessionFiles,
  moveSessionFileEntry,
  previewSessionFile,
  saveSessionFileContent,
  sessionFileDownloadUrl,
  sessionFileImageUrl,
  uploadSessionFile,
  type SessionDirectoryListing,
  type SessionFileEntry,
  type SessionFilePreview,
} from "../api";
import { SessionFilesPanel } from "./SessionFilesPanel";

vi.mock("../api", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiRequestError";
      this.status = status;
    }
  },
  copySessionFileEntry: vi.fn(),
  createSessionFileEntry: vi.fn(),
  deleteSessionFileEntry: vi.fn(),
  listSessionFiles: vi.fn(),
  moveSessionFileEntry: vi.fn(),
  previewSessionFile: vi.fn(),
  saveSessionFileContent: vi.fn(),
  sessionFileDownloadUrl: vi.fn(),
  sessionFileImageUrl: vi.fn(),
  uploadSessionFile: vi.fn(),
}));

function apiError(message: string, status: number): Error {
  return new ApiRequestError(message, status);
}

function textPreview(
  name: string,
  path: string,
  content: string,
  overrides: Partial<SessionFilePreview> = {},
): SessionFilePreview {
  return {
    root: "/work/project",
    name,
    path,
    absolutePath: `/work/project/${path}`,
    terminalText: `/work/project/${path}`,
    kind: "text",
    mediaType: "text/plain",
    size: content.length,
    modified: 1_700_000_000,
    truncated: false,
    previewBytes: content.length,
    content,
    editable: true,
    ...overrides,
  };
}

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
    rootParent: "/work",
  };
}

function listingAt(
  root: string,
  entries: SessionFileEntry[],
  rootParent: string | null,
): SessionDirectoryListing {
  return {
    root,
    path: "",
    absolutePath: root,
    terminalText: root,
    entries,
    truncated: false,
    limit: 1_000,
    rootParent,
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
    vi.mocked(listSessionFiles).mockImplementation(
      async (_target, path) => (path === "src" ? source : root),
    );
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
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "",
      expect.any(AbortSignal),
    );
    expect(within(panel).queryByRole("button", { name: "File .env" })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Folder src" }));
    await waitFor(() => expect(listSessionFiles).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "src",
      expect.any(AbortSignal),
    ));
    const file = await within(panel).findByRole("button", { name: "File main file.ts" });
    fireEvent.click(file);

    expect(await within(panel).findByText("export const x = 1;")).toBeInTheDocument();
    expect(previewSessionFile).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "src/main file.ts",
      expect.any(AbortSignal),
    );
    const download = within(panel).getByRole("link", { name: "Download selected file" });
    expect(download).toHaveAttribute("href", "/files/download");
    expect(download).toHaveAttribute("download", "main file.ts");
    expect(sessionFileDownloadUrl).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
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
      { session: "agent", sessionId: "$7", paneId: "%3" },
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
      { session: "agent", sessionId: "$7", paneId: "%3" },
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
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "",
      file,
      expect.any(AbortSignal),
    ));
    expect(await within(panel).findByText(
      "a file or directory with this name already exists",
    )).toBeInTheDocument();
    expect(within(panel).getByText("0 uploaded, 1 failed.")).toBeInTheDocument();
  });

  it("creates a folder and an empty file in the shown directory", async () => {
    const created = entry("build", "build", "directory");
    const touched = entry("log.txt", "log.txt", "file", { size: 0 });
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", []))
      .mockResolvedValueOnce(listing("", [created]))
      .mockResolvedValue(listing("", [created, touched]));
    vi.mocked(createSessionFileEntry)
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(touched);
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("log.txt", "log.txt", ""),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Create a folder here" }));
    fireEvent.change(within(panel).getByLabelText("New folder name"), {
      target: { value: "build" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createSessionFileEntry).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "",
      "build",
      "directory",
    ));
    expect(await within(panel).findByRole("button", { name: "Folder build" }))
      .toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Create an empty file here" }));
    fireEvent.change(within(panel).getByLabelText("New file name"), {
      target: { value: "log.txt" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createSessionFileEntry).toHaveBeenLastCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "",
      "log.txt",
      "file",
    ));
    const newFile = await within(panel).findByRole("button", { name: "File log.txt" });
    expect(newFile).toHaveAttribute("aria-pressed", "true");
  });

  it("rejects names with separators before calling the API", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", []));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Create a folder here" }));
    fireEvent.change(within(panel).getByLabelText("New folder name"), {
      target: { value: "../escape" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create" }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "A name cannot contain / or navigate folders",
    );
    expect(createSessionFileEntry).not.toHaveBeenCalled();
  });

  it("renames an entry through the row action", async () => {
    const before = entry("draft.md", "draft.md", "file");
    const after = entry("final.md", "final.md", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [before]))
      .mockResolvedValue(listing("", [after]));
    vi.mocked(moveSessionFileEntry).mockResolvedValue(after);
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("final.md", "final.md", "done"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Rename draft.md" }));
    const input = within(panel).getByLabelText("New name for draft.md");
    expect(input).toHaveValue("draft.md");
    fireEvent.change(input, { target: { value: "final.md" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(moveSessionFileEntry).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "draft.md",
      "final.md",
    ));
    expect(await within(panel).findByRole("button", { name: "File final.md" }))
      .toBeInTheDocument();
  });

  it("duplicates a file with a suggested copy name", async () => {
    const source = entry("report.txt", "report.txt", "file");
    const copy = entry("report copy.txt", "report copy.txt", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [source]))
      .mockResolvedValue(listing("", [source, copy]));
    vi.mocked(copySessionFileEntry).mockResolvedValue(copy);
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("report copy.txt", "report copy.txt", "body"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Duplicate report.txt" }));
    expect(within(panel).getByLabelText("Name for the copy of report.txt"))
      .toHaveValue("report copy.txt");
    fireEvent.click(within(panel).getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(copySessionFileEntry).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "report.txt",
      "report copy.txt",
    ));
    expect(await within(panel).findByRole("button", { name: "File report copy.txt" }))
      .toBeInTheDocument();
  });

  it("confirms before deleting and escalates a non-empty folder to a recursive delete", async () => {
    const folder = entry("logs", "logs", "directory");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [folder]))
      .mockResolvedValue(listing("", []));
    vi.mocked(deleteSessionFileEntry)
      .mockRejectedValueOnce(apiError("folder is not empty and holds 3 entries", 409))
      .mockResolvedValueOnce({
        name: "logs",
        path: "logs",
        absolutePath: "/work/project/logs",
        terminalText: "/work/project/logs",
        kind: "directory",
        symlink: false,
        removedEntries: 3,
      });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Delete logs" }));
    expect(await within(panel).findByText(/Permanently delete logs/)).toBeInTheDocument();
    expect(deleteSessionFileEntry).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(deleteSessionFileEntry).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "logs",
      false,
    ));
    expect(await within(panel).findByText(/Delete it and everything inside/))
      .toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(deleteSessionFileEntry).toHaveBeenLastCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "logs",
      true,
    ));
    await waitFor(() => expect(
      within(panel).queryByRole("button", { name: "Folder logs" }),
    ).not.toBeInTheDocument());
  });

  it("cancels a delete without calling the API", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("keep.txt", "keep.txt", "file"),
    ]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Delete keep.txt" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));

    expect(within(panel).queryByText(/Permanently delete/)).not.toBeInTheDocument();
    expect(deleteSessionFileEntry).not.toHaveBeenCalled();
  });

  it("bulk deletes checked entries and reports partial failures", async () => {
    const first = entry("a.txt", "a.txt", "file");
    const second = entry("b.txt", "b.txt", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [first, second]))
      .mockResolvedValue(listing("", [second]));
    vi.mocked(deleteSessionFileEntry)
      .mockResolvedValueOnce({
        name: "a.txt",
        path: "a.txt",
        absolutePath: "/work/project/a.txt",
        terminalText: "/work/project/a.txt",
        kind: "file",
        symlink: false,
        removedEntries: 0,
      })
      .mockRejectedValueOnce(apiError("file or directory is not accessible", 403));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select a.txt" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select b.txt" }));
    expect(within(panel).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Delete selected" }));
    expect(await within(panel).findByText(/Permanently delete 2 items/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSessionFileEntry).toHaveBeenCalledTimes(2));
    expect(await within(panel).findByText("1 deleted, 1 failed.")).toBeInTheDocument();
    expect(within(panel).getByText("file or directory is not accessible"))
      .toBeInTheDocument();
  });

  it("selects every listed entry and bulk moves them into another folder", async () => {
    const first = entry("one.txt", "one.txt", "file");
    const second = entry("two.txt", "two.txt", "file");
    const target = entry("archive", "archive", "directory");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [target, first, second]))
      .mockResolvedValue(listing("", [target]));
    vi.mocked(moveSessionFileEntry)
      .mockResolvedValueOnce(entry("one.txt", "archive/one.txt", "file"))
      .mockResolvedValueOnce(entry("two.txt", "archive/two.txt", "file"));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select every listed entry" }));
    expect(within(panel).getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select archive" }));
    expect(within(panel).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Move selected" }));
    fireEvent.change(within(panel).getByLabelText("Destination folder for 2 items"), {
      target: { value: "archive" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(moveSessionFileEntry).toHaveBeenCalledTimes(2));
    expect(moveSessionFileEntry).toHaveBeenNthCalledWith(
      1,
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "one.txt",
      "archive/one.txt",
    );
    expect(moveSessionFileEntry).toHaveBeenNthCalledWith(
      2,
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "two.txt",
      "archive/two.txt",
    );
    expect(await within(panel).findByText("Moved 2 items.")).toBeInTheDocument();
  });

  it("refuses to move a folder into itself", async () => {
    const folder = entry("outer", "outer", "directory");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [folder]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Move outer" }));
    fireEvent.change(within(panel).getByLabelText("Destination folder for outer"), {
      target: { value: "outer/inner" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Move" }));

    expect(await within(panel).findByText("outer cannot be moved inside itself"))
      .toBeInTheDocument();
    expect(moveSessionFileEntry).not.toHaveBeenCalled();
  });

  it("edits a text file in place and saves it with the previewed timestamp", async () => {
    const target = entry("notes.md", "notes.md", "file", { size: 5 });
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("notes.md", "notes.md", "first"),
    );
    vi.mocked(saveSessionFileContent).mockResolvedValue({
      ...target,
      size: 6,
      modified: 1_700_000_500,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    const editor = within(panel).getByLabelText("Contents of notes.md");
    expect(editor).toHaveValue("first");
    fireEvent.change(editor, { target: { value: "second" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveSessionFileContent).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "notes.md",
      "second",
      1_700_000_000,
    ));
    expect(await within(panel).findByText(/Saved notes.md/)).toBeInTheDocument();
  });

  it("keeps the editor open and reports a save conflict", async () => {
    const target = entry("config.toml", "config.toml", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("config.toml", "config.toml", "old = true"),
    );
    vi.mocked(saveSessionFileContent).mockRejectedValue(
      apiError("the file changed on disk since it was opened; reload before saving", 409),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File config.toml" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit config.toml" }));
    fireEvent.change(within(panel).getByLabelText("Contents of config.toml"), {
      target: { value: "new = true" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));

    expect(await within(panel).findByText(/the file changed on disk/)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Contents of config.toml"))
      .toHaveValue("new = true");
  });

  it("does not offer editing for truncated previews", async () => {
    const target = entry("huge.log", "huge.log", "file", { size: 4_000_000 });
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("huge.log", "huge.log", "head", {
        truncated: true,
        editable: false,
        size: 4_000_000,
      }),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File huge.log" }));

    expect(await within(panel).findByText("head")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Edit huge.log" }))
      .not.toBeInTheDocument();
  });

  it("sorts entries by size and flips the direction while keeping folders first", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("assets", "assets", "directory"),
      entry("small.txt", "small.txt", "file", { size: 10 }),
      entry("large.txt", "large.txt", "file", { size: 900 }),
      entry("medium.txt", "medium.txt", "file", { size: 200 }),
    ]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    const names = () => within(panel)
      .getAllByRole("button", { name: /^(Folder|File) / })
      .map((button) => button.getAttribute("aria-label"));

    expect(names()).toEqual([
      "Folder assets",
      "File large.txt",
      "File medium.txt",
      "File small.txt",
    ]);

    fireEvent.change(within(panel).getByLabelText("Sort entries by"), {
      target: { value: "size" },
    });
    expect(names()).toEqual([
      "Folder assets",
      "File small.txt",
      "File medium.txt",
      "File large.txt",
    ]);

    fireEvent.click(within(panel).getByRole("button", { name: "Sort descending" }));
    expect(names()).toEqual([
      "Folder assets",
      "File large.txt",
      "File medium.txt",
      "File small.txt",
    ]);
  });

  it("keeps an unrelated open preview after a bulk delete", async () => {
    const open = entry("open.txt", "open.txt", "file");
    const doomed = entry("doomed.txt", "doomed.txt", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [doomed, open]))
      .mockResolvedValue(listing("", [open]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("open.txt", "open.txt", "still reading"),
    );
    vi.mocked(deleteSessionFileEntry).mockResolvedValue({
      name: "doomed.txt",
      path: "doomed.txt",
      absolutePath: "/work/project/doomed.txt",
      terminalText: "/work/project/doomed.txt",
      kind: "file",
      symlink: false,
      removedEntries: 0,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File open.txt" }));
    expect(await within(panel).findByText("still reading")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select doomed.txt" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Delete selected" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSessionFileEntry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      within(panel).getByRole("button", { name: "File open.txt" }),
    ).toHaveAttribute("aria-pressed", "true"));
    expect(await within(panel).findByText("still reading")).toBeInTheDocument();
  });

  it("renames from F2 and asks to delete from the Delete key", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("script.sh", "script.sh", "file"),
    ]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const row = within(panel).getByRole("button", { name: "File script.sh" });

    fireEvent.keyDown(row, { key: "F2" });
    expect(within(panel).getByLabelText("New name for script.sh")).toHaveValue("script.sh");

    fireEvent.keyDown(row, { key: "Delete" });
    expect(await within(panel).findByText(/Permanently delete script.sh/))
      .toBeInTheDocument();
  });

  it("refuses to upload over an unsaved edit instead of discarding it", async () => {
    const target = entry("notes.md", "notes.md", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("notes.md", "notes.md", "first"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    fireEvent.change(within(panel).getByLabelText("Contents of notes.md"), {
      target: { value: "unsaved work" },
    });

    const picker = panel.querySelector<HTMLInputElement>("input[type='file']");
    fireEvent.change(picker!, {
      target: { files: [new File(["x"], "dropped.txt", { type: "text/plain" })] },
    });

    await waitFor(() => expect(
      within(panel).getByText("Save or cancel the open edit first"),
    ).toBeInTheDocument());
    expect(uploadSessionFile).not.toHaveBeenCalled();
    expect(within(panel).getByLabelText("Contents of notes.md"))
      .toHaveValue("unsaved work");
  });

  it("unwinds one layer at a time on Escape before closing the panel", async () => {
    const target = entry("keep.txt", "keep.txt", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    const { onClose } = renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Create a folder here" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(panel).queryByLabelText("New folder name")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Delete keep.txt" }));
    expect(await within(panel).findByText(/Permanently delete keep.txt/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(panel).queryByText(/Permanently delete keep.txt/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps an unsaved edit when Escape is pressed in the editor", async () => {
    const target = entry("notes.md", "notes.md", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("notes.md", "notes.md", "first"),
    );
    const { onClose } = renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    fireEvent.change(within(panel).getByLabelText("Contents of notes.md"), {
      target: { value: "unsaved work" },
    });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(within(panel).getByLabelText("Contents of notes.md"))
      .toHaveValue("unsaved work");
    expect(within(panel).getByText("Choose Discard to throw these edits away"))
      .toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Discard" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves the rest of a selection when the destination folder is also checked", async () => {
    const target = entry("archive", "archive", "directory");
    const first = entry("one.txt", "one.txt", "file");
    const second = entry("two.txt", "two.txt", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [target, first, second]))
      .mockResolvedValue(listing("", [target]));
    vi.mocked(moveSessionFileEntry)
      .mockResolvedValueOnce(entry("one.txt", "archive/one.txt", "file"))
      .mockResolvedValueOnce(entry("two.txt", "archive/two.txt", "file"));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select every listed entry" }));
    expect(within(panel).getByText("3 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Move selected" }));
    fireEvent.change(within(panel).getByLabelText("Destination folder for 3 items"), {
      target: { value: "archive" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(moveSessionFileEntry).toHaveBeenCalledTimes(2));
    expect(await within(panel).findByText(/Moved 2 items\./)).toBeInTheDocument();
    expect(within(panel).getByText(/1 already there or not movable here/))
      .toBeInTheDocument();
  });

  it("opens the move prompt empty and reports its refusal inline", async () => {
    const folder = entry("outer", "outer", "directory");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [folder]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "Move outer" }));
    const destination = within(panel).getByLabelText("Destination folder for outer");
    expect(destination).toHaveValue("");

    fireEvent.change(destination, { target: { value: "outer/inner" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Move" }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "outer cannot be moved inside itself",
    );
    expect(within(panel).getByLabelText("Destination folder for outer"))
      .toBeInTheDocument();
    expect(moveSessionFileEntry).not.toHaveBeenCalled();
  });

  it("carries a checked entry through a rename", async () => {
    const before = entry("draft.md", "draft.md", "file");
    const other = entry("other.md", "other.md", "file");
    const after = entry("final.md", "final.md", "file");
    vi.mocked(listSessionFiles)
      .mockResolvedValueOnce(listing("", [before, other]))
      .mockResolvedValue(listing("", [after, other]));
    vi.mocked(moveSessionFileEntry).mockResolvedValue(after);
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("final.md", "final.md", "done"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select draft.md" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select other.md" }));
    expect(within(panel).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Rename draft.md" }));
    fireEvent.change(within(panel).getByLabelText("New name for draft.md"), {
      target: { value: "final.md" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(moveSessionFileEntry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      within(panel).getByRole("checkbox", { name: "Select final.md" }),
    ).toBeChecked());
    expect(within(panel).getByText("2 selected")).toBeInTheDocument();
  });

  it("keeps checked entries that the filter hides out of the select-all toggle", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("apple.txt", "apple.txt", "file"),
      entry("zebra.txt", "zebra.txt", "file"),
    ]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select zebra.txt" }));
    fireEvent.change(within(panel).getByLabelText("Filter files"), {
      target: { value: "apple" },
    });
    expect(within(panel).getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select every listed entry" }));
    expect(within(panel).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Select every listed entry" }));
    expect(within(panel).getByText("1 selected")).toBeInTheDocument();
  });

  it("lets Escape reach the terminal when there is no panel layer to unwind", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("keep.txt", "keep.txt", "file"),
    ]));
    const { onClose } = renderPanel();
    await screen.findByRole("dialog", { name: "Files" });

    // The panel floats over a live terminal, so swallowing Escape here would
    // stop the pane ever receiving it.
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    const reachedTerminal = vi.fn();
    outside.addEventListener("keydown", reachedTerminal);
    try {
      fireEvent.keyDown(outside, { key: "Escape" });
      expect(reachedTerminal).toHaveBeenCalledOnce();
      expect(reachedTerminal.mock.calls[0][0].defaultPrevented).toBe(false);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      outside.remove();
    }
  });

  it("swallows Escape only while a panel layer is open", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", []));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    const reachedTerminal = vi.fn();
    outside.addEventListener("keydown", reachedTerminal);

    try {
      fireEvent.click(within(panel).getByRole("button", { name: "Create a folder here" }));
      fireEvent.keyDown(outside, { key: "Escape" });

      expect(reachedTerminal).not.toHaveBeenCalled();
      expect(within(panel).queryByLabelText("New folder name")).not.toBeInTheDocument();
    } finally {
      outside.remove();
    }
  });

  it("will not reload a file underneath an unsaved edit, and saves against the timestamp the edit started from", async () => {
    const target = entry("notes.md", "notes.md", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile)
      .mockResolvedValueOnce(textPreview("notes.md", "notes.md", "MINE BASE"))
      .mockResolvedValue(textPreview("notes.md", "notes.md", "THEIRS", {
        modified: 1_700_009_999,
      }));
    vi.mocked(saveSessionFileContent).mockRejectedValue(
      apiError("the file changed on disk since it was opened", 409),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    fireEvent.change(within(panel).getByLabelText("Contents of notes.md"), {
      target: { value: "MINE EDITED" },
    });

    // Refresh is one of the paths that checks the editor first; a batch that is
    // already running is not, which is why the baseline below is pinned.
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh directory" }));
    expect(within(panel).getByText("Save or cancel the open edit first"))
      .toBeInTheDocument();
    expect(previewSessionFile).toHaveBeenCalledTimes(1);

    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveSessionFileContent).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "notes.md",
      "MINE EDITED",
      1_700_000_000,
    ));
    expect(await within(panel).findByText(/changed on disk/)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Contents of notes.md"))
      .toHaveValue("MINE EDITED");
  });

  it("adopts a reloaded file when the editor has no unsaved text", async () => {
    const target = entry("notes.md", "notes.md", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile)
      .mockResolvedValueOnce(textPreview("notes.md", "notes.md", "first"))
      .mockResolvedValue(textPreview("notes.md", "notes.md", "second", {
        modified: 1_700_009_999,
      }));
    vi.mocked(saveSessionFileContent).mockResolvedValue({ ...target, size: 6 });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh directory" }));

    await waitFor(() => expect(
      within(panel).getByLabelText("Contents of notes.md"),
    ).toHaveValue("second"));

    fireEvent.change(within(panel).getByLabelText("Contents of notes.md"), {
      target: { value: "second edited" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveSessionFileContent).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "notes.md",
      "second edited",
      1_700_009_999,
    ));
  });

  it("blocks a prompt submitted after the editor was dirtied", async () => {
    const target = entry("notes.md", "notes.md", "file");
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [target]));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("notes.md", "notes.md", "first"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(within(panel).getByRole("button", { name: "File notes.md" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit notes.md" }));
    // The prompt opens while the editor is still clean.
    fireEvent.click(within(panel).getByRole("button", { name: "Create a folder here" }));
    fireEvent.change(within(panel).getByLabelText("Contents of notes.md"), {
      target: { value: "typed after opening the prompt" },
    });
    fireEvent.change(within(panel).getByLabelText("New folder name"), {
      target: { value: "build" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(
      within(panel).getByText("Save or cancel the open edit first"),
    ).toBeInTheDocument());
    expect(createSessionFileEntry).not.toHaveBeenCalled();
    expect(within(panel).getByLabelText("Contents of notes.md"))
      .toHaveValue("typed after opening the prompt");
  });

  it("returns focus to the control that opened a prompt or confirmation", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("keep.txt", "keep.txt", "file"),
    ]));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const frames: FrameRequestCallback[] = [];
    const scheduler = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });

    try {
      const rename = within(panel).getByRole("button", { name: "Rename keep.txt" });
      rename.focus();
      fireEvent.click(rename);
      expect(within(panel).getByLabelText("New name for keep.txt")).toHaveFocus();

      fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
      frames.splice(0).forEach((frame) => frame(0));
      // The panel is a portal at the end of <body>, so dropping focus there
      // would restart tabbing at the top of the document.
      expect(rename).toHaveFocus();

      const remove = within(panel).getByRole("button", { name: "Delete keep.txt" });
      remove.focus();
      fireEvent.click(remove);
      expect(within(panel).getByRole("button", { name: "Cancel" })).toHaveFocus();

      fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
      frames.splice(0).forEach((frame) => frame(0));
      expect(remove).toHaveFocus();
    } finally {
      scheduler.mockRestore();
    }
  });


  it("steps above the pane working directory and back again", async () => {
    const paneListing = listing("", [entry("main.py", "main.py", "file")]);
    const parentListing = listingAt(
      "/work",
      [entry("project", "project", "directory")],
      "/",
    );
    vi.mocked(listSessionFiles).mockImplementation(async (target) => (
      target.root === "/work" ? parentListing : paneListing
    ));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    // At the pane directory the request carries no root at all.
    expect(listSessionFiles).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3" },
      "",
      expect.any(AbortSignal),
    );

    fireEvent.click(within(panel).getByRole("button", { name: "Go to parent directory" }));

    await waitFor(() => expect(listSessionFiles).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3", root: "/work" },
      "",
      expect.any(AbortSignal),
    ));
    expect(await within(panel).findByRole("button", { name: "Folder project" }))
      .toBeInTheDocument();
    await waitFor(() => expect(
      within(panel).getByLabelText("Directory path"),
    ).toHaveValue("/work"));

    fireEvent.click(within(panel).getByRole("button", { name: "Pane cwd" }));
    await waitFor(() => expect(
      within(panel).getByLabelText("Directory path"),
    ).toHaveValue("/work/project"));
  });

  it("jumps to an absolute path typed into the address bar", async () => {
    const paneListing = listing("", [entry("main.py", "main.py", "file")]);
    const elsewhere = listingAt(
      "/etc/nginx",
      [entry("nginx.conf", "nginx.conf", "file")],
      "/etc",
    );
    vi.mocked(listSessionFiles).mockImplementation(async (target) => (
      target.root === "/etc/nginx" ? elsewhere : paneListing
    ));
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.change(within(panel).getByLabelText("Directory path"), {
      target: { value: "/etc/nginx" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Go" }));

    await waitFor(() => expect(listSessionFiles).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3", root: "/etc/nginx" },
      "",
      expect.any(AbortSignal),
    ));
    expect(await within(panel).findByRole("button", { name: "File nginx.conf" }))
      .toBeInTheDocument();
    // The breadcrumb stops claiming the pane's own directory.
    await waitFor(() => expect(
      within(panel).getByRole("button", { name: "nginx" }),
    ).toBeInTheDocument());
  });

  it("refuses a relative path in the address bar without calling the API", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });
    const calls = vi.mocked(listSessionFiles).mock.calls.length;

    fireEvent.change(within(panel).getByLabelText("Directory path"), {
      target: { value: "relative/path" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Go" }));

    expect(await within(panel).findByText(
      "Enter an absolute path, starting with / or ~",
    )).toBeInTheDocument();
    // The rejected draft stays put instead of snapping back.
    expect(within(panel).getByLabelText("Directory path"))
      .toHaveValue("relative/path");
    expect(vi.mocked(listSessionFiles).mock.calls).toHaveLength(calls);
  });

  it("stops offering to go up once the server reports no reachable parent", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listingAt("/", [entry("etc", "etc", "directory")], null),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "Folder etc" });

    await waitFor(() => expect(
      within(panel).getByRole("button", { name: "Go to parent directory" }),
    ).toBeDisabled());
  });

  it("carries the browsed root into file operations outside the pane directory", async () => {
    const paneListing = listing("", [entry("main.py", "main.py", "file")]);
    const elsewhere = listingAt(
      "/srv/data",
      [entry("stale.log", "stale.log", "file")],
      "/srv",
    );
    vi.mocked(listSessionFiles).mockImplementation(async (target) => (
      target.root === "/srv/data" ? elsewhere : paneListing
    ));
    vi.mocked(deleteSessionFileEntry).mockResolvedValue({
      name: "stale.log",
      path: "stale.log",
      absolutePath: "/srv/data/stale.log",
      terminalText: "/srv/data/stale.log",
      kind: "file",
      symlink: false,
      removedEntries: 0,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.change(within(panel).getByLabelText("Directory path"), {
      target: { value: "/srv/data" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Go" }));
    await within(panel).findByRole("button", { name: "File stale.log" });

    fireEvent.click(within(panel).getByRole("button", { name: "Delete stale.log" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSessionFileEntry).toHaveBeenCalledWith(
      { session: "agent", sessionId: "$7", paneId: "%3", root: "/srv/data" },
      "stale.log",
      false,
    ));
  });

  it("reverts an address draft on Escape without closing the panel", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    const { onClose } = renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    const address = within(panel).getByLabelText("Directory path");
    address.focus();
    fireEvent.change(address, { target: { value: "/half-typed" } });
    fireEvent.keyDown(address, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(address).toHaveValue("/work/project"));
  });

  it("keeps every keystroke typed into the address bar before the first listing settles", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    const address = within(panel).getByLabelText("Directory path") as HTMLInputElement;

    // Deliberately no settle: this is the window where a synced field let a
    // pending flush land after the keystroke and revert it.
    const seen: string[] = [];
    for (const character of "/etc") {
      fireEvent.change(address, { target: { value: address.value + character } });
      seen.push(
        (within(panel).getByLabelText("Directory path") as HTMLInputElement).value,
      );
    }

    // Every character survives; nothing snaps back to the starting path.
    expect(seen).toEqual([
      "/work/project/",
      "/work/project/e",
      "/work/project/et",
      "/work/project/etc",
    ]);

    // The other common gesture is replacing the whole value at once.
    fireEvent.change(address, { target: { value: "/srv" } });
    await waitFor(() => expect(
      within(panel).getByLabelText("Directory path"),
    ).toHaveValue("/srv"));
  });

  it("shows the directory it failed to open rather than the one it left", async () => {
    vi.mocked(listSessionFiles).mockImplementation(async (target) => {
      if (target.root === "/work") throw new Error("file or directory is not accessible");
      return listing("", [entry("main.py", "main.py", "file")]);
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.click(within(panel).getByRole("button", { name: "Go to parent directory" }));

    expect(await within(panel).findByText("Could not open this directory"))
      .toBeInTheDocument();
    // The address bar must not keep claiming the folder we navigated away from.
    await waitFor(() => expect(
      within(panel).getByLabelText("Directory path"),
    ).toHaveValue("/work"));
    expect(within(panel).getByRole("button", { name: "Pane cwd" })).toBeInTheDocument();
  });

  it("drops the previous selection when the browsed root changes", async () => {
    const paneListing = listing("", [entry("README.md", "README.md", "file")]);
    const elsewhere = listingAt("/etc", [entry("hosts", "hosts", "file")], "/");
    vi.mocked(listSessionFiles).mockImplementation(async (target) => (
      target.root === "/etc" ? elsewhere : paneListing
    ));
    vi.mocked(previewSessionFile).mockResolvedValue(
      textPreview("README.md", "README.md", "pane readme"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    fireEvent.click(await within(panel).findByRole("button", { name: "File README.md" }));
    expect(await within(panel).findByText("pane readme")).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText("Directory path"), {
      target: { value: "/etc" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Go" }));
    await within(panel).findByRole("button", { name: "File hosts" });

    // A root-relative path means nothing under a different root, so it must not
    // be re-requested there.
    expect(vi.mocked(previewSessionFile).mock.calls.every(
      (call) => call[0].root === undefined,
    )).toBe(true);
  });

  it("names the folder that failed, not just the root it was under", async () => {
    const rooted = listingAt("/etc", [entry("nginx", "nginx", "directory")], "/");
    vi.mocked(listSessionFiles).mockImplementation(async (target, path) => {
      if (target.root === "/etc" && path === "nginx") {
        throw new Error("file or directory is not accessible");
      }
      if (target.root === "/etc") return rooted;
      return listing("", [entry("main.py", "main.py", "file")]);
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.change(within(panel).getByLabelText("Directory path"), {
      target: { value: "/etc" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Go" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Folder nginx" }));

    expect(await within(panel).findByText("Could not open this directory"))
      .toBeInTheDocument();
    // The breadcrumbs say etc > nginx, so the address bar must agree.
    await waitFor(() => expect(
      within(panel).getByLabelText("Directory path"),
    ).toHaveValue("/etc/nginx"));
  });

  it("offers a way out when the directory it opened at is refused", async () => {
    vi.mocked(listSessionFiles).mockRejectedValue(
      new Error("that directory is outside the browsable area"),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });

    expect(await within(panel).findByText("Could not open this directory"))
      .toBeInTheDocument();
    // Retrying a refused folder can never succeed, so it cannot be the only
    // control left; Pane cwd is absent here because this IS the pane directory.
    expect(within(panel).queryByRole("button", { name: "Pane cwd" }))
      .not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Go to parent directory" }))
      .toBeDisabled();

    fireEvent.click(within(panel).getByRole("button", { name: "Choose another folder" }));
    expect(within(panel).getByLabelText("Directory path")).toHaveFocus();
  });

  it("offers the path as selectable text when the browser has no clipboard", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    // A console served over plain HTTP is not a secure context, so the async
    // clipboard is simply absent.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.click(within(panel).getByRole("button", { name: "Copy server path" }));

    const field = await within(panel).findByLabelText(
      "Full path, selected for copying",
    );
    expect(field).toHaveValue("/work/project");
    expect(field).toHaveFocus();
    // The old behaviour was an error the user could do nothing about.
    expect(within(panel).queryByText(/Clipboard access is unavailable/))
      .not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss the path to copy" }));
    expect(within(panel).queryByLabelText("Full path, selected for copying"))
      .not.toBeInTheDocument();
  });

  it("offers the path when a present clipboard refuses the write", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    const writeText = vi.fn(async () => {
      throw new Error("Write permission denied.");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.click(within(panel).getByRole("button", { name: "Copy server path" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/work/project"));
    expect(await within(panel).findByLabelText("Full path, selected for copying"))
      .toHaveValue("/work/project");
  });

  it("keeps the plain copy path when the clipboard works", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(
      listing("", [entry("main.py", "main.py", "file")]),
    );
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.click(within(panel).getByRole("button", { name: "Copy server path" }));

    expect(await within(panel).findByText("Path copied")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("Full path, selected for copying"))
      .not.toBeInTheDocument();
  });

  it("stops offering a path that no longer matches the selection", async () => {
    vi.mocked(listSessionFiles).mockResolvedValue(listing("", [
      entry("src", "src", "directory"),
      entry("main.py", "main.py", "file"),
    ]));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    renderPanel();
    const panel = await screen.findByRole("dialog", { name: "Files" });
    await within(panel).findByRole("button", { name: "File main.py" });

    fireEvent.click(within(panel).getByRole("button", { name: "Copy server path" }));
    expect(await within(panel).findByLabelText("Full path, selected for copying"))
      .toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Folder src" }));

    await waitFor(() => expect(
      within(panel).queryByLabelText("Full path, selected for copying"),
    ).not.toBeInTheDocument());
  });
});
