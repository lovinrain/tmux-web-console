import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";
import type { SnippetNode } from "../src/types";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) {
  throw new Error("Snippet browser validation requires the disposable Playwright socket");
}
const tmux = ["-L", socketName];
const sessionName = `muxdeck-snippet-workflow-${process.pid}`;
const screenshotDirectory = "/tmp/muxdeck-snippet-workflow-review";

test.beforeAll(() => {
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", sessionName,
    "bash", "--noprofile", "--norc",
  ]);
  mkdirSync(screenshotDirectory, { recursive: true });
});

test("staged-input snippet picker manages folders, text, shortcuts, and deletion in place", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const loginResponse = await request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(loginResponse.ok()).toBe(true);
  const readLibrary = async (): Promise<{ tree: SnippetNode[]; revision: number }> => {
    const response = await request.get("/mux/api/snippets");
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const original = await readLibrary();
  const sourceName = `Working snippets ${process.pid}`;
  const renamedSourceName = `Review snippets ${process.pid}`;
  const destinationName = `Saved snippets ${process.pid}`;
  const initialName = `Release checklist ${process.pid}`;
  const editedName = `Release final ${process.pid}`;
  const initialText = "Review the release before shipping.\n";
  const editedText = "  Review the exact staged changes.\nKeep whitespace intact.\n";
  const finalText = "  Insert after managing the library.\n";
  const draft = "prefix replace suffix";
  const reviewViewports = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 390, height: 600 },
    { width: 640, height: 480 },
  ];
  const sessionUrl = `/mux/session/${sessionName}?tab=${sessionName}`;
  const findNamed = (tree: SnippetNode[], name: string): SnippetNode | undefined => {
    for (const node of tree) {
      if (node.name === name) return node;
      if (node.type === "folder") {
        const child = findNamed(node.children, name);
        if (child) return child;
      }
    }
    return undefined;
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/mux/login");
    await page.getByLabel("Username").fill(E2E_AUTH_USERNAME);
    await page.getByLabel("Password").fill(E2E_AUTH_PASSWORD);
    await page.getByRole("button", { name: "Unlock Muxdeck" }).click();
    await expect(page).toHaveURL(/\/mux\/$/);

    const terminalInputFrames: (string | Buffer)[] = [];
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/ws/terminal")) return;
      socket.on("framesent", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString();
        // Ignore terminal attach protocol replies and sizing control messages.
        if (/^(?:\x1b\[(?:\?|>)[\d;]+c|\x1b\]1[01];rgb:[\da-f/]+\x1b\\)$/i.test(text)) return;
        if (typeof payload === "string") {
          try {
            if (JSON.parse(payload).type === "resize") return;
          } catch {
            // Anything else is terminal input and must fail the assertion below.
          }
        }
        terminalInputFrames.push(payload);
      });
    });

    await page.goto(sessionUrl);
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    const stagedInput = page.getByRole("textbox", { name: "Staged input", exact: true });
    await stagedInput.fill(draft);
    await stagedInput.evaluate((element) => {
      (element as HTMLTextAreaElement).setSelectionRange(7, 14);
    });
    await page.getByRole("button", { name: "Insert snippet into staged input", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Insert into staged input" });
    const search = picker.getByRole("searchbox", { name: "Search all snippets" });
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    const expectStillManaging = async () => {
      await expect(picker).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${sessionName}\\?tab=${sessionName}$`));
      await expect(stagedInput).toHaveValue(draft);
    };

    await picker.getByRole("button", { name: "New folder", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill(sourceName);
    await picker.getByRole("button", { name: "Save folder", exact: true }).click();
    await expect(picker.getByRole("button", { name: "Edit folder", exact: true })).toBeVisible();
    expect(findNamed((await readLibrary()).tree, sourceName)).toMatchObject({ type: "folder" });
    await expectStillManaging();

    await picker.getByRole("button", { name: "Edit folder", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill(renamedSourceName);
    await picker.getByRole("button", { name: "Save folder", exact: true }).click();
    const source = findNamed((await readLibrary()).tree, renamedSourceName);
    expect(source?.type).toBe("folder");
    expect(findNamed((await readLibrary()).tree, sourceName)).toBeUndefined();

    await picker.getByRole("button", { name: "New snippet", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill(initialName);
    await picker.getByRole("textbox", { name: "Shortcuts", exact: true }).fill("shipit, release");
    await picker.getByRole("textbox", { name: "Snippet text", exact: true }).fill(initialText);
    await expect(picker.getByRole("combobox", { name: "Location", exact: true })).toHaveValue(source!.id);
    await picker.getByRole("button", { name: "Save snippet", exact: true }).click();
    await expect(picker.getByRole("heading", { name: initialName, exact: true })).toBeVisible();
    const created = findNamed((await readLibrary()).tree, initialName);
    expect(created).toMatchObject({ type: "snippet", text: initialText, aliases: ["shipit", "release"] });
    await expectStillManaging();

    await picker.getByRole("button", { name: "New folder", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill(destinationName);
    await picker.getByRole("combobox", { name: "Location", exact: true }).selectOption({ label: "Library root" });
    await picker.getByRole("button", { name: "Save folder", exact: true }).click();
    const destination = findNamed((await readLibrary()).tree, destinationName);
    expect(destination?.type).toBe("folder");

    await search.fill("shipit");
    await expect(picker.getByRole("heading", { name: initialName, exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Edit snippet", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill(editedName);
    await picker.getByRole("textbox", { name: "Shortcuts", exact: true }).fill("");
    await picker.getByRole("textbox", { name: "Snippet text", exact: true }).fill(editedText);
    await picker.getByRole("combobox", { name: "Location", exact: true }).selectOption(destination!.id);

    for (const theme of ["dark", "light"] as const) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const viewport of reviewViewports) {
        await page.setViewportSize(viewport);
        await expect(picker.getByRole("textbox", { name: "Shortcuts", exact: true })).toBeVisible();
        await expect(picker.getByRole("combobox", { name: "Location", exact: true })).toBeVisible();
        await picker.getByRole("button", { name: "Save snippet", exact: true }).scrollIntoViewIfNeeded();
        await expect(picker.getByRole("button", { name: "Save snippet", exact: true })).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({
          path: `${screenshotDirectory}/crud-${theme}-${viewport.width}x${viewport.height}.png`,
          animations: "disabled",
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await picker.getByRole("button", { name: "Save snippet", exact: true }).click();
    await expect(picker.getByRole("heading", { name: editedName, exact: true })).toBeVisible();
    const movedLibrary = (await readLibrary()).tree;
    const moved = findNamed(movedLibrary, destinationName);
    expect(moved?.type === "folder" ? moved.children : []).toContainEqual(expect.objectContaining({
      id: created!.id, name: editedName, text: editedText,
    }));
    const edited = findNamed(movedLibrary, editedName);
    expect(edited?.type === "snippet" ? edited.aliases ?? [] : null).toEqual([]);
    const emptiedSource = findNamed(movedLibrary, renamedSourceName);
    expect(emptiedSource?.type === "folder" ? emptiedSource.children : null).toEqual([]);
    await expectStillManaging();

    for (const viewport of reviewViewports.slice(2)) {
      await page.setViewportSize(viewport);
      for (const name of ["Edit snippet", "Delete snippet", "Insert"]) {
        const action = picker.getByRole("button", { name, exact: true });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 1 });
      }
      await page.screenshot({
        path: `${screenshotDirectory}/crud-preview-light-${viewport.width}x${viewport.height}.png`,
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    await picker.getByRole("button", { name: "Delete snippet", exact: true }).click();
    const deletion = picker.getByRole("alertdialog", { name: "Delete snippet", exact: true });
    await expect(deletion).toBeVisible();
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deletion).toBeHidden();
    expect(findNamed((await readLibrary()).tree, editedName)?.id).toBe(created!.id);
    await picker.getByRole("button", { name: "Delete snippet", exact: true }).click();
    await deletion.getByRole("button", { name: "Delete snippet", exact: true }).click();
    await expect(deletion).toBeHidden();
    expect(findNamed((await readLibrary()).tree, editedName)).toBeUndefined();
    await expectStillManaging();

    await picker.getByRole("button", { name: "New snippet", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill("Retained insertion snippet");
    await picker.getByRole("textbox", { name: "Shortcuts", exact: true }).fill("keepme");
    await picker.getByRole("textbox", { name: "Snippet text", exact: true }).fill(finalText);
    await picker.getByRole("button", { name: "Save snippet", exact: true }).click();
    await picker.getByRole("navigation", { name: "Snippet folder" }).getByRole("button", { name: "Library", exact: true }).click();
    await picker.getByRole("button", { name: `Open folder ${renamedSourceName}`, exact: true }).click();
    await picker.getByRole("button", { name: "Delete folder", exact: true }).click();
    const folderDeletion = picker.getByRole("alertdialog", { name: "Delete folder", exact: true });
    await folderDeletion.getByRole("button", { name: "Delete folder", exact: true }).click();
    await expect(folderDeletion).toBeHidden();
    expect(findNamed((await readLibrary()).tree, renamedSourceName)).toBeUndefined();
    await expectStillManaging();

    await picker.getByRole("button", { name: "Close snippets", exact: true }).click();
    await page.getByRole("button", { name: "Insert snippet into staged input", exact: true }).click();
    await expect(search).toBeFocused();
    await search.fill(editedName);
    await expect(picker.getByText("No snippets match.", { exact: true })).toBeVisible();
    await search.fill("keepme");
    await expect(picker.getByRole("heading", { name: "Retained insertion snippet", exact: true })).toBeVisible();
    await expectStillManaging();
    await picker.getByRole("button", { name: "Insert", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(stagedInput).toHaveValue(`prefix ${finalText} suffix`);
    await expect(stagedInput).toBeFocused();
    expect(terminalInputFrames).toEqual([]);
  } finally {
    const latest = await readLibrary();
    const restored = await request.put("/mux/api/snippets", {
      data: { revision: latest.revision, tree: original.tree },
    });
    expect(restored.ok()).toBe(true);
  }
});

test.afterAll(() => {
  try {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${sessionName}`], {
      stdio: "ignore",
    });
  } catch {
    // Cleanup only this test's session on the configured disposable socket.
  }
});

test("session snippet search, editing, and every shortcut entry point preserve the draft", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const loginResponse = await request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(loginResponse.ok()).toBe(true);
  const snippetResponse = await request.get("/mux/api/snippets");
  expect(snippetResponse.ok()).toBe(true);
  const originalSnippets = await snippetResponse.json();
  const shortcutResponse = await request.get("/mux/api/shortcuts");
  expect(shortcutResponse.ok()).toBe(true);
  const originalShortcuts = await shortcutResponse.json();
  const aliasId = `snippet-alias-${process.pid}`;
  const editedText = "  Review the staged changes.\nKeep exact whitespace.\n";

  try {
    const savedSnippets = await request.put("/mux/api/snippets", {
      data: {
        revision: originalSnippets.revision,
        tree: [...originalSnippets.tree, {
          id: `snippet-title-${process.pid}`,
          type: "snippet",
          name: "ship",
          text: "This title matches exactly but should rank below a shortcut.",
        }, {
          id: aliasId,
          type: "snippet",
          name: "Release checklist",
          text: "Review the release.",
          aliases: ["ship"],
        }],
      },
    });
    expect(savedSnippets.ok()).toBe(true);
    const savedShortcuts = await request.put("/mux/api/shortcuts", {
      data: {
        revision: originalShortcuts.revision,
        bindings: {
          ...originalShortcuts.bindings,
          "shortcut-launcher": {
            ...originalShortcuts.bindings["shortcut-launcher"],
            direct: "KeyX",
          },
        },
      },
    });
    expect(savedShortcuts.ok()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/mux/login");
    await page.getByLabel("Username").fill(E2E_AUTH_USERNAME);
    await page.getByLabel("Password").fill(E2E_AUTH_PASSWORD);
    await page.getByRole("button", { name: "Unlock Muxdeck" }).click();
    await expect(page).toHaveURL(/\/mux\/$/);

    const terminalInputFrames: (string | Buffer)[] = [];
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/ws/terminal")) return;
      socket.on("framesent", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString();
        // xterm answers tmux's device/color queries automatically during attach.
        // These specific protocol responses are unrelated to keyboard or draft input.
        if (/^(?:\x1b\[(?:\?|>)[\d;]+c|\x1b\]1[01];rgb:[\da-f/]+\x1b\\)$/i.test(text)) return;
        if (typeof payload === "string") {
          try {
            if (JSON.parse(payload).type === "resize") return;
          } catch {
            // Any non-control payload would reach the disposable terminal.
          }
        }
        terminalInputFrames.push(payload);
      });
    });
    await page.goto(`/mux/session/${sessionName}?tab=${sessionName}`);
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    const stagedInput = page.getByRole("textbox", { name: "Staged input", exact: true });
    await stagedInput.fill("prefix replace suffix");
    await stagedInput.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(7, 14);
    });
    await page.keyboard.press("Control+Shift+I");
    const picker = page.getByRole("dialog", { name: "Insert into staged input" });
    const search = picker.getByRole("searchbox", { name: "Search all snippets" });
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await search.fill("ship");
    const matches = picker.getByRole("button", { name: /^Preview snippet / });
    await expect(matches).toHaveCount(2);
    await expect(matches.first()).toHaveAccessibleName("Preview snippet Release checklist");
    await expect(matches.first()).toHaveAttribute("aria-pressed", "true");
    await search.fill("rls chk");
    await expect(matches.first()).toHaveAccessibleName("Preview snippet Release checklist");
    await picker.getByRole("button", { name: "Edit snippet", exact: true }).click();
    await picker.getByRole("textbox", { name: "Name", exact: true }).fill("Release review");
    await picker.getByRole("textbox", { name: "Shortcuts", exact: true }).fill("ship, release");
    await picker.getByRole("textbox", { name: "Snippet text", exact: true }).fill(editedText);

    for (const theme of ["dark", "light"] as const) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(picker.getByRole("textbox", { name: "Snippet text", exact: true })).toBeVisible();
        await expect(picker.getByRole("button", { name: "Save snippet", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({
          path: `${screenshotDirectory}/${theme}-${viewport.width}x${viewport.height}.png`,
          animations: "disabled",
        });
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await picker.getByRole("button", { name: "Save snippet", exact: true }).click();
    await expect(picker.getByText("Snippet saved to the shared library.")).toBeVisible();
    const persistedResponse = await request.get("/mux/api/snippets");
    expect(persistedResponse.ok()).toBe(true);
    const persisted = await persistedResponse.json();
    expect(persisted.tree.find((node: { id: string }) => node.id === aliasId)).toMatchObject({
      name: "Release review", text: editedText, aliases: ["ship", "release"],
    });
    await picker.getByRole("button", { name: "Insert", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(stagedInput).toHaveValue(`prefix ${editedText} suffix`);
    await expect(stagedInput).toBeFocused();

    await expect(page.getByRole("button", { name: "Open shortcut window" }))
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+X");
    await page.keyboard.press("Control+Shift+X");
    const launcher = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(launcher).toBeVisible();
    await expect(launcher.getByRole("button", { name: /Insert snippet/ })).toBeVisible();
    await page.keyboard.press("i");
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await search.fill("release");
    await expect(picker.getByRole("heading", { name: "Release review", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();

    await page.keyboard.press("Control+Shift+H");
    const palette = page.getByRole("dialog", { name: "Run a command" });
    await expect(palette).toBeVisible();
    const commandSearch = palette.getByRole("combobox", { name: "Search commands" });
    await commandSearch.fill("insert snippet");
    await expect(palette.locator('[role="option"][aria-selected="true"] strong'))
      .toHaveText("Insert snippet");
    await commandSearch.press("Enter");
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(stagedInput).toHaveValue(`prefix ${editedText} suffix`);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+Shift+I");
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    expect(terminalInputFrames).toEqual([]);
  } finally {
    for (const [endpoint, original, field] of [
      ["snippets", originalSnippets, "tree"],
      ["shortcuts", originalShortcuts, "bindings"],
    ] as const) {
      const current = await request.get(`/mux/api/${endpoint}`);
      if (current.ok()) {
        const snapshot = await current.json();
        await request.put(`/mux/api/${endpoint}`, {
          data: { revision: snapshot.revision, [field]: original[field] },
        });
      }
    }
  }
});
