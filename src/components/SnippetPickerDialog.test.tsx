import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, getSnippetTree, saveSnippetTree } from "../api";
import type { SnippetFolder, SnippetLeaf, SnippetTree } from "../types";
import { SnippetPickerDialog } from "./SnippetPickerDialog";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  getSnippetTree: vi.fn(),
  saveSnippetTree: vi.fn(),
}));

const deploySnippet: SnippetLeaf = {
  id: "deploy-production",
  type: "snippet",
  name: "Deploy production",
  text: "kubectl rollout status deployment/api\n",
};

const reviewSnippet: SnippetLeaf = {
  id: "review-diff",
  type: "snippet",
  name: "Review diff",
  text: "Review the current changes and list any regressions.",
};

const library: SnippetTree = {
  revision: 4,
  tree: [
    {
      id: "operations",
      type: "folder",
      name: "Operations",
      children: [
        {
          id: "deploy",
          type: "folder",
          name: "Deploy",
          children: [deploySnippet],
        },
      ],
    },
    reviewSnippet,
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSnippetTree).mockResolvedValue(library);
  document.body.style.overflow = "";
});

describe("SnippetPickerDialog", () => {
  it("drills through folders and inserts only after explicit confirmation", async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading snippets");
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Operations" }));
    expect(screen.getByRole("navigation", { name: "Snippet folder" })).toHaveTextContent(
      "Library/Operations",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open folder Deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview snippet Deploy production" }));

    expect(onChoose).not.toHaveBeenCalled();
    const preview = screen.getByRole("complementary", { name: "Snippet preview" });
    expect(within(preview).getByRole("heading", { name: "Deploy production" })).toBeVisible();
    expect(preview.querySelector("pre")?.textContent).toBe(deploySnippet.text);
    expect(within(preview).getByText("Library / Operations / Deploy")).toBeVisible();

    fireEvent.click(within(preview).getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(deploySnippet));
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("searches globally across snippet names, text, and folder paths", async () => {
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    const search = await screen.findByRole("searchbox", { name: "Search all snippets" });

    fireEvent.change(search, { target: { value: "kubectl" } });
    expect(screen.getByRole("button", { name: "Preview snippet Deploy production" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview snippet Review diff" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "operations" } });
    expect(screen.getByRole("button", { name: "Preview snippet Deploy production" })).toBeVisible();

    fireEvent.change(search, { target: { value: "regressions" } });
    expect(screen.getByRole("button", { name: "Preview snippet Review diff" })).toBeVisible();

    fireEvent.change(search, { target: { value: "nothing matches this" } });
    expect(screen.getByText("No snippets match.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear snippet search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "Open folder Operations" })).toBeVisible();
  });

  it("shows load failure, retry, and an actionable empty state", async () => {
    const onManage = vi.fn();
    const onClose = vi.fn();
    vi.mocked(getSnippetTree)
      .mockRejectedValueOnce(new Error("Snippet storage is offline"))
      .mockResolvedValueOnce({ revision: 0, tree: [] });

    render(
      <SnippetPickerDialog
        onClose={onClose}
        onChoose={vi.fn()}
        onManage={onManage}
        title="Choose reusable text"
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose reusable text" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("Snippet storage is offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No snippets yet.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Shortcuts" })).toBeVisible();
    expect(onManage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retains the picker and reports a rejected insertion", async () => {
    const onChoose = vi.fn().mockRejectedValue(new Error("The draft is too long"));
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The draft is too long");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Insert" })).toBeEnabled();
  });

  it("saves edits inside the picker and inserts the saved text without navigating away", async () => {
    const updated = { ...reviewSnippet, name: "Review code", text: "Check only the changed code.\n", aliases: ["rv"] };
    vi.mocked(saveSnippetTree).mockResolvedValue({ revision: 5, tree: [library.tree[0], updated] });
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit snippet" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: updated.name } });
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: updated.text } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcuts" }), { target: { value: "rv, RV" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    await screen.findByText("Snippet saved to the shared library.");
    expect(saveSnippetTree).toHaveBeenCalledWith([library.tree[0], updated], 4);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(updated));
  });

  it("keeps edits after a conflict and reloads the latest library before a deliberate retry", async () => {
    const newerFolder = { ...library.tree[0], name: "Renamed elsewhere" };
    vi.mocked(getSnippetTree).mockResolvedValueOnce(library).mockResolvedValueOnce({
      revision: 8, tree: [newerFolder, reviewSnippet],
    });
    vi.mocked(saveSnippetTree)
      .mockRejectedValueOnce(new ApiRequestError("Conflict", 409))
      .mockImplementationOnce(async (tree, revision) => ({ tree, revision: revision + 1 }));
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit snippet" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: "My unsaved edits" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your edits will be kept");
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save snippet" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Snippet text" })).toHaveValue("My unsaved edits");
    expect(saveSnippetTree).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    await screen.findByText("Snippet saved to the shared library.");
    expect(saveSnippetTree).toHaveBeenLastCalledWith([
      newerFolder, { ...reviewSnippet, text: "My unsaved edits", aliases: [] },
    ], 8);
  });

  it("previews the best shortcut match and supports keyboard insertion from search", async () => {
    const aliased = { ...deploySnippet, aliases: ["rd"] };
    vi.mocked(getSnippetTree).mockResolvedValue({ revision: 1, tree: [
      { ...reviewSnippet, name: "rd" }, aliased,
    ] });
    const onChoose = vi.fn();
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={onChoose} />);
    const search = screen.getByRole("searchbox", { name: "Search all snippets" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "rd" } });
    const results = screen.getByLabelText("Matching snippets");
    expect(within(results).getAllByRole("button")[0]).toHaveAccessibleName("Preview snippet Deploy production");
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Preview snippet rd" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(aliased));
  });

  it("cancels edits with Escape without closing the picker or changing the snippet", async () => {
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit snippet" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: "Discard me" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Snippet preview" }).querySelector("pre"))
      .toHaveTextContent(reviewSnippet.text);
    expect(onClose).not.toHaveBeenCalled();
    expect(saveSnippetTree).not.toHaveBeenCalled();
  });

  it("creates a snippet and its shortcuts in an empty library, then inserts the saved content", async () => {
    vi.mocked(getSnippetTree).mockResolvedValue({ revision: 0, tree: [] });
    vi.mocked(saveSnippetTree).mockImplementation(async (tree, revision) => ({ tree, revision: revision + 1 }));
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const onManage = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} onManage={onManage} />);

    fireEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Check deployment" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcuts" }), { target: { value: "ship, SHIP go" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), {
      target: { value: "kubectl get pods\n" },
    });
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Library root");
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));

    await screen.findByRole("button", { name: "Preview snippet Check deployment" });
    expect(saveSnippetTree).toHaveBeenCalledOnce();
    expect(saveSnippetTree).toHaveBeenCalledWith([{
      id: expect.any(String),
      type: "snippet",
      name: "Check deployment",
      text: "kubectl get pods\n",
      aliases: ["ship", "go"],
    }], 0);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onManage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search all snippets" }), { target: { value: "ship" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(vi.mocked(saveSnippetTree).mock.calls[0][0][0]));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates a folder and a snippet within it from the picker", async () => {
    vi.mocked(saveSnippetTree).mockImplementation(async (tree, revision) => ({ tree, revision: revision + 1 }));
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Operations" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Operations");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Checks" } });
    expect(screen.queryByRole("textbox", { name: "Shortcuts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));

    await waitFor(() => expect(saveSnippetTree).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save folder" })).not.toBeInTheDocument());
    const savedFolder = (vi.mocked(saveSnippetTree).mock.calls[0][0][0] as SnippetFolder).children[1] as SnippetFolder;
    expect(savedFolder).toEqual({ id: expect.any(String), type: "folder", name: "Checks", children: [] });
    // Folder creation may leave the parent open or open the new folder; both allow immediate creation.
    const openFolder = screen.queryByRole("button", { name: "Open folder Checks" });
    if (openFolder) fireEvent.click(openFolder);
    fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Operations / Checks");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Status" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: "git status" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));

    await screen.findByRole("button", { name: "Preview snippet Status" });
    const savedTree = vi.mocked(saveSnippetTree).mock.calls[1][0];
    expect(savedTree[1]).toEqual(reviewSnippet);
    const operations = savedTree[0] as SnippetFolder;
    expect(operations.children[0]).toEqual((library.tree[0] as SnippetFolder).children[0]);
    expect(operations.children[1]).toEqual({
      ...savedFolder,
      children: [{ id: expect.any(String), type: "snippet", name: "Status", text: "git status", aliases: [] }],
    });
    expect(vi.mocked(saveSnippetTree).mock.calls[1][1]).toBe(5);
  });

  it("moves a nested snippet and clears its shortcuts while preserving the other entries", async () => {
    const aliased = { ...deploySnippet, aliases: ["ship"] };
    const operations = library.tree[0] as SnippetFolder;
    const deploy = operations.children[0] as SnippetFolder;
    vi.mocked(getSnippetTree).mockResolvedValue({ revision: 4, tree: [
      { ...operations, children: [{ ...deploy, children: [aliased] }] }, reviewSnippet,
    ] });
    vi.mocked(saveSnippetTree).mockImplementation(async (tree, revision) => ({ tree, revision: revision + 1 }));
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    const search = await screen.findByRole("searchbox", { name: "Search all snippets" });
    await waitFor(() => expect(search).toBeEnabled());
    fireEvent.change(search, { target: { value: "ship" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit snippet" }));
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Operations / Deploy");
    fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcuts" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));

    await screen.findByText("Snippet saved to the shared library.");
    expect(saveSnippetTree).toHaveBeenCalledWith([
      { ...operations, children: [{ ...deploy, children: [] }] },
      reviewSnippet,
      { ...deploySnippet, aliases: [] },
    ], 4);
  });

  it("edits folder names and locations without losing their snippets or allowing cyclic moves", async () => {
    vi.mocked(saveSnippetTree).mockImplementation(async (tree, revision) => ({ tree, revision: revision + 1 }));
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Operations" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit folder" }));
    const location = screen.getByRole("combobox", { name: "Location" });
    expect(within(location).queryByRole("option", { name: "Operations" })).not.toBeInTheDocument();
    expect(within(location).queryByRole("option", { name: "Operations / Deploy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open folder Deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Release" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save folder" })).not.toBeInTheDocument());
    const operations = library.tree[0] as SnippetFolder;
    const deploy = operations.children[0] as SnippetFolder;
    expect(saveSnippetTree).toHaveBeenCalledWith([
      { ...operations, children: [] }, reviewSnippet, { ...deploy, name: "Release" },
    ], 4);
  });

  it("cancels or confirms snippet deletion without inserting or closing the picker", async () => {
    vi.mocked(saveSnippetTree).mockImplementation(async (tree, revision) => ({ tree, revision: revision + 1 }));
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview snippet Review diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete snippet" }));
    let confirmation = screen.getByRole("alertdialog", { name: "Delete snippet" });
    expect(confirmation).toHaveTextContent(reviewSnippet.name);
    expect(saveSnippetTree).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview snippet Review diff" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete snippet" }));
    confirmation = screen.getByRole("alertdialog", { name: "Delete snippet" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete snippet" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Preview snippet Review diff" })).not.toBeInTheDocument());
    expect(saveSnippetTree).toHaveBeenCalledWith([library.tree[0]], 4);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("requires a fresh confirmation after a folder deletion conflict and preserves concurrent additions", async () => {
    const concurrentSnippet = { ...reviewSnippet, id: "concurrent", name: "Added elsewhere" };
    const operations = library.tree[0] as SnippetFolder;
    vi.mocked(getSnippetTree).mockResolvedValueOnce(library).mockResolvedValueOnce({
      revision: 9,
      tree: [{ ...operations, children: [...operations.children, { ...concurrentSnippet, id: "nested-concurrent" }] }, reviewSnippet, concurrentSnippet],
    });
    vi.mocked(saveSnippetTree)
      .mockRejectedValueOnce(new ApiRequestError("Conflict", 409))
      .mockImplementationOnce(async (tree, revision) => ({ tree, revision: revision + 1 }));
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Operations" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    let confirmation = screen.getByRole("alertdialog", { name: "Delete folder" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveSnippetTree).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    confirmation = screen.getByRole("alertdialog", { name: "Delete folder" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(within(screen.getByRole("alertdialog", { name: "Delete folder" }))
      .getByRole("button", { name: "Delete folder" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(within(screen.getByRole("alertdialog", { name: "Delete folder" }))
      .getByRole("button", { name: "Delete folder" })).toBeEnabled());
    expect(saveSnippetTree).toHaveBeenCalledOnce();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete folder" }))
      .getByRole("button", { name: "Delete folder" }));
    await screen.findByRole("button", { name: "Preview snippet Added elsewhere" });
    expect(saveSnippetTree).toHaveBeenLastCalledWith([reviewSnippet, concurrentSnippet], 9);
    expect(screen.queryByRole("button", { name: "Open folder Operations" })).not.toBeInTheDocument();
  });

  it("keeps all new-snippet fields through a conflict and saves against the reloaded revision", async () => {
    vi.mocked(getSnippetTree).mockResolvedValueOnce(library).mockResolvedValueOnce({
      revision: 7, tree: [...library.tree, { ...reviewSnippet, id: "extra", name: "From another tab" }],
    });
    vi.mocked(saveSnippetTree)
      .mockRejectedValueOnce(new ApiRequestError("Conflict", 409))
      .mockImplementationOnce(async (tree, revision) => ({ tree, revision: revision + 1 }));
    render(<SnippetPickerDialog onClose={vi.fn()} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New check" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcuts" }), { target: { value: "check ck" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: "run checks" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save snippet" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save snippet" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("New check");
    expect(screen.getByRole("textbox", { name: "Shortcuts" })).toHaveValue("check ck");
    expect(screen.getByRole("textbox", { name: "Snippet text" })).toHaveValue("run checks");
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Operations / Deploy");
    expect(saveSnippetTree).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    await screen.findByRole("button", { name: "Preview snippet New check" });
    const savedTree = vi.mocked(saveSnippetTree).mock.calls[1][0];
    expect(savedTree.slice(1)).toEqual([reviewSnippet, { ...reviewSnippet, id: "extra", name: "From another tab" }]);
    const folder = (savedTree[0] as SnippetFolder).children[0] as SnippetFolder;
    expect(folder.children[0]).toEqual(deploySnippet);
    expect(folder.children[1]).toMatchObject({ name: "New check", text: "run checks", aliases: ["check", "ck"] });
    expect(vi.mocked(saveSnippetTree).mock.calls[1][1]).toBe(7);
  });

  it("returns to the library root when a deletion reload removes the browsed folder", async () => {
    vi.mocked(getSnippetTree).mockResolvedValueOnce(library).mockResolvedValueOnce({
      revision: 8, tree: [deploySnippet, reviewSnippet],
    });
    vi.mocked(saveSnippetTree).mockRejectedValueOnce(new ApiRequestError("Conflict", 409));
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={onChoose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Operations" }));
    fireEvent.click(screen.getByRole("button", { name: "Open folder Deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview snippet Deploy production" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete snippet" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete snippet" }))
      .getByRole("button", { name: "Delete snippet" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(within(screen.getByRole("alertdialog", { name: "Delete snippet" }))
      .getByRole("button", { name: "Delete snippet" })).toBeEnabled());
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete snippet" }))
      .getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("navigation", { name: "Snippet folder" })).toHaveTextContent(/^Library$/);
    expect(screen.getByRole("button", { name: "Preview snippet Deploy production" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview snippet Review diff" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveDisplayValue("Library root");
    expect(screen.getByRole("combobox", { name: "Location" })).toHaveValue("");
    expect(saveSnippetTree).toHaveBeenCalledOnce();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels creation without saving or closing, and keeps invalid shortcuts editable", async () => {
    const onClose = vi.fn();
    render(<SnippetPickerDialog onClose={onClose} onChoose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Snippet text" }), { target: { value: "Draft text" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcuts" }), { target: { value: "x".repeat(33) } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Each shortcut can contain up to 32 characters.");
    expect(screen.getByRole("textbox", { name: "Snippet text" })).toHaveValue("Draft text");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview snippet Review diff" })).toBeVisible();
    expect(saveSnippetTree).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locks page scroll, contains focus, handles Escape, and isolates typed keys", async () => {
    const onClose = vi.fn();
    const outsideKeyDown = vi.fn();
    const previousOverflow = "clip";
    document.body.style.overflow = previousOverflow;
    const { unmount } = render(
      <div onKeyDown={outsideKeyDown}>
        <SnippetPickerDialog onClose={onClose} onChoose={vi.fn()} onManage={vi.fn()} />
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: "Insert a snippet" });
    expect(dialog).toHaveFocus();
    const search = await screen.findByRole("searchbox", { name: "Search all snippets" });
    expect(document.body.style.overflow).toBe("hidden");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: "a" });
    expect(outsideKeyDown).not.toHaveBeenCalled();

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ));
    focusable[0].focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(focusable.at(-1)).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(document.body.style.overflow).toBe(previousOverflow);
  });
});
