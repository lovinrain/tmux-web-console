import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, getSnippetTree, saveSnippetTree } from "../api";
import type { SnippetLeaf, SnippetTree } from "../types";
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
    fireEvent.click(screen.getByRole("button", { name: "Manage snippets" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
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
