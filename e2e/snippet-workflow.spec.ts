import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

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
