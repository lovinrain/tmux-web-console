import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSnippetTree } from "../api";
import type { SnippetLeaf, SnippetTree } from "../types";
import { SnippetPickerDialog } from "./SnippetPickerDialog";

vi.mock("../api", () => ({
  getSnippetTree: vi.fn(),
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
