import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessionFiles,
  previewSessionFile,
  type SessionDirectoryListing,
  type SessionFileEntry,
} from "../api";
import { SessionFilesPanel } from "./SessionFilesPanel";

vi.mock("../api", () => ({
  listSessionFiles: vi.fn(),
  previewSessionFile: vi.fn(),
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
});
