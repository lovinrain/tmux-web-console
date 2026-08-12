import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../test-utils";
import type { SnippetNode } from "../types";
import { SnippetLibrary } from "./SnippetLibrary";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

describe("SnippetLibrary", () => {
  it("creates a snippet in the current nested folder and preserves exact text", async () => {
    const initialTree = [{
      id: "work",
      type: "folder" as const,
      name: "Work",
      children: [],
    }];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return jsonResponse({ revision: 2, tree: initialTree });
      const body = JSON.parse(String(init.body)) as { revision: number; tree: unknown[] };
      return jsonResponse({ revision: body.revision + 1, tree: body.tree });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Light theme" })).toBeVisible();

    fireEvent.click(await screen.findByRole("button", { name: "Open folder Work" }));
    const controls = screen.getByLabelText("Snippet library controls");
    fireEvent.click(within(controls).getByRole("button", { name: "New snippet" }));
    expect(screen.getByRole("dialog", { name: "New snippet" })).toBeVisible();
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Review diff" } });
    fireEvent.input(screen.getByLabelText("Snippet text"), {
      target: { value: "  review the diff\ncarefully  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      revision: number;
      tree: Array<{ children: Array<{ name: string; text: string }> }>;
    };
    expect(request.revision).toBe(2);
    expect(request.tree[0].children[0]).toMatchObject({
      name: "Review diff",
      text: "  review the diff\ncarefully  ",
    });
    expect(await screen.findByRole("button", { name: "Edit snippet Review diff" })).toBeVisible();
  });

  it("reorders and recursively deletes nodes through explicit controls", async () => {
    let snapshot = {
      revision: 1,
      tree: [
        { id: "a", type: "snippet" as const, name: "Alpha", text: "a" },
        {
          id: "folder",
          type: "folder" as const,
          name: "Nested",
          children: [{ id: "b", type: "snippet" as const, name: "Beta", text: "b" }],
        },
      ],
    };
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return jsonResponse(snapshot);
      const body = JSON.parse(String(init.body)) as typeof snapshot;
      snapshot = { revision: body.revision + 1, tree: body.tree };
      return jsonResponse(snapshot);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);

    await screen.findByRole("button", { name: "Open folder Nested" });
    fireEvent.click(screen.getByRole("button", { name: "Move Nested up" }));
    await waitFor(() => expect(snapshot.tree[0].id).toBe("folder"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Nested" }));
    expect(screen.getByRole("alertdialog", { name: "Delete Nested?" }))
      .toHaveTextContent("all 1 descendant nodes");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(snapshot.tree.map((node) => node.id)).toEqual(["a"]));
  });

  it("blocks a stale revision overwrite and offers an explicit reload", async () => {
    const tree = [{ id: "one", type: "snippet" as const, name: "One", text: "one" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 4, tree }))
      .mockResolvedValueOnce(jsonResponse({
        error: "snippet tree changed; current revision is 5",
        revision: 5,
      }, 409))
      .mockResolvedValueOnce(jsonResponse({ revision: 5, tree }));
    vi.stubGlobal("fetch", fetchMock);
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit snippet One" }));
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const editor = screen.getByRole("dialog", { name: "Edit snippet" });
    expect(await within(editor).findByRole("alert")).toHaveTextContent("changed in another browser");
    fireEvent.click(within(editor).getByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("dialog", { name: "Edit snippet" })).not.toBeInTheDocument();
  });

  it("keeps editor input available and supports retry after a transient save failure", async () => {
    const tree = [{ id: "one", type: "snippet" as const, name: "One", text: "one" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 4, tree }))
      .mockResolvedValueOnce(jsonResponse({ error: "unable to save snippets" }, 500))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { revision: number; tree: unknown[] };
        return jsonResponse({ revision: body.revision + 1, tree: body.tree });
      });
    vi.stubGlobal("fetch", fetchMock);
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit snippet One" }));
    const name = screen.getByLabelText("Name");
    fireEvent.input(name, { target: { value: "Retained edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const editor = screen.getByRole("dialog", { name: "Edit snippet" });
    expect(await within(editor).findByRole("alert")).toHaveTextContent("unable to save snippets");
    expect(name).toHaveValue("Retained edit");
    expect(within(editor).queryByRole("button", { name: "Reload library" })).not.toBeInTheDocument();

    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("button", { name: "Edit snippet Retained edit" })).toBeVisible();
  });

  it("contains delete confirmation focus, handles Escape, and restores page state", async () => {
    const tree = [{
      id: "folder",
      type: "folder" as const,
      name: "Nested",
      children: [{ id: "child", type: "snippet" as const, name: "Child", text: "child" }],
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ revision: 1, tree })));
    document.body.style.overflow = "clip";
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);

    const trigger = await screen.findByRole("button", { name: "Delete Nested" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Delete Nested?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });

    await waitFor(() => expect(cancel).toHaveFocus());
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog", { name: "Delete Nested?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("clip");
  });

  it("prevents creation and invalid moves beyond the server tree-depth limit", async () => {
    let nested: SnippetNode = {
      id: "level-12",
      type: "folder",
      name: "Level 12",
      children: [],
    };
    for (let level = 11; level >= 1; level -= 1) {
      nested = {
        id: `level-${level}`,
        type: "folder",
        name: `Level ${level}`,
        children: [nested],
      };
    }
    const tree: SnippetNode[] = [
      { id: "root-snippet", type: "snippet", name: "Root snippet", text: "root" },
      nested,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ revision: 1, tree })));
    renderWithTheme(<SnippetLibrary onOpenSessions={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit snippet Root snippet" }));
    const location = screen.getByRole("combobox", { name: "Location" });
    expect(within(location).getByRole("option", { name: /Level 11$/ })).toBeVisible();
    expect(within(location).queryByRole("option", { name: /Level 12$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close snippet editor" }));

    fireEvent.click(screen.getByRole("button", { name: /Level 12/ }));
    const controls = screen.getByLabelText("Snippet library controls");
    expect(within(controls).getByRole("button", { name: "New folder" })).toBeDisabled();
    expect(within(controls).getByRole("button", { name: "New snippet" })).toBeDisabled();
    expect(screen.getByText(/maximum nesting depth/i)).toBeVisible();
  });
});
