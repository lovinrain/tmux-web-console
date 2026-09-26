import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) {
  throw new Error("Note and scroll validation requires a disposable Playwright socket");
}
const tmux = ["-L", socketName];
const sessionName = `muxdeck-notes-scroll-${process.pid}`;
const sessionUrl = `/mux/session/${sessionName}?tab=${sessionName}`;
let paneId = "";

function paneFormat(format: string): string {
  return execFileSync("tmux", [
    ...tmux, "display-message", "-p", "-t", paneId, format,
  ], { encoding: "utf8" }).trim();
}

test.beforeAll(() => {
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", sessionName,
    "bash", "--noprofile", "--norc",
  ]);
  paneId = execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${sessionName}`, "-F", "#{pane_id}",
  ], { encoding: "utf8" }).trim();
  execFileSync("tmux", [
    ...tmux, "send-keys", "-t", paneId,
    "for i in {1..150}; do printf 'SCROLL_ROW_%03d\\n' \"$i\"; done", "Enter",
  ]);
});

test.afterAll(() => {
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${sessionName}`]);
});

test.beforeEach(async ({ page, request }) => {
  expect((await request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
  await page.goto("/mux/login");
  await page.getByLabel("Username").fill(E2E_AUTH_USERNAME);
  await page.getByLabel("Password").fill(E2E_AUTH_PASSWORD);
  await page.getByRole("button", { name: "Unlock Muxdeck" }).click();
  await expect(page).toHaveURL(/\/mux\/$/);
});

test("page sidebar keeps named pages easy to find and opens the main page by default", async ({
  page, request,
}) => {
  test.setTimeout(60_000);
  const existingPages = [
    { id: "main", name: "Page 1", content: "Original main page" },
    { id: "handoff", name: "Handoff", content: "Existing second page" },
  ];
  expect((await request.put("/mux/api/common-note", {
    data: { notebook: { pages: existingPages } },
  })).ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(sessionUrl);
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await page.getByRole("button", { name: "Edit common note" }).click();
  let editor = page.getByRole("dialog", { name: "Common", exact: true });
  let sidebar = editor.getByRole("complementary", { name: "Notebook pages" });
  await expect(sidebar).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Original main page");
  await expect(sidebar.getByRole("button", { name: /Page 1/ })).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("button", { name: /Handoff/ }).click();
  await expect(editor.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Existing second page");
  await expect(sidebar.getByRole("button", { name: /Handoff/ })).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("button", { name: "Add note page from sidebar" }).click();
  await editor.getByRole("textbox", { name: "Page name", exact: true }).fill("Release checklist");
  await editor.getByRole("textbox", { name: "Note", exact: true }).fill("Validate release notes");
  await expect(editor.getByRole("status")).toHaveText("Saved");
  const stored = await (await request.get("/mux/api/common-note")).json();
  expect(stored.notebook.pages.slice(0, 2)).toEqual(existingPages);
  expect(stored.notebook.pages[2]).toMatchObject({ name: "Release checklist", content: "Validate release notes" });

  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
    }
    await editor.getByRole("button", { name: "Resize note to Small" }).click();
    await expect(sidebar).toBeInViewport();
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/note-pages-${theme}.png`, animations: "disabled" });
  }

  await editor.getByRole("button", { name: "Hide page sidebar" }).click();
  await editor.getByRole("button", { name: "Save and close note" }).click();
  await page.getByRole("button", { name: "Edit common note" }).click();
  editor = page.getByRole("dialog", { name: "Common", exact: true });
  await expect(editor.getByRole("complementary", { name: "Notebook pages" })).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Original main page");
  await page.reload();
  editor = page.getByRole("dialog", { name: "Common", exact: true });
  sidebar = editor.getByRole("complementary", { name: "Notebook pages" });
  await expect(sidebar).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Original main page");
  await sidebar.getByRole("button", { name: /Release checklist/ }).click();
  await expect(editor.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Validate release notes");
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }]) {
  test(`tmux line buttons move one row without shell input at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await page.goto(sessionUrl);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    const controls = viewport.width > 1000
      ? page.getByRole("group", { name: "Terminal input shortcuts" })
      : page.getByRole("navigation", { name: "Terminal view controls" });
    const up = controls.getByRole("button", { name: "Tmux Line Up", exact: true });
    const down = controls.getByRole("button", { name: "Tmux Line Down", exact: true });
    await expect(up).toBeEnabled();
    await expect(down).toBeEnabled();
    await expect.poll(() => Number(paneFormat("#{history_size}"))).toBeGreaterThan(2);
    const before = execFileSync("tmux", [
      ...tmux, "capture-pane", "-p", "-t", paneId,
    ], { encoding: "utf8" });
    await up.click();
    await expect.poll(() => paneFormat("#{scroll_position}")).toBe("1");
    await up.click();
    await expect.poll(() => paneFormat("#{scroll_position}")).toBe("2");
    await down.click();
    await expect.poll(() => paneFormat("#{scroll_position}")).toBe("1");
    await controls.getByRole("button", { name: "Tmux Page Up", exact: true }).click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBeGreaterThan(1);
    const pagedPosition = Number(paneFormat("#{scroll_position}"));
    await up.click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBe(pagedPosition + 1);
    await down.click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBe(pagedPosition);
    await controls.getByRole("button", { name: "Tmux Page Down", exact: true }).click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBeLessThan(pagedPosition);
    const pagedDownPosition = Number(paneFormat("#{scroll_position}"));
    await up.click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBe(pagedDownPosition + 1);
    await down.click();
    await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBe(pagedDownPosition);
    const liveName = viewport.width > 1000 ? "Focus live terminal input" : "Return to live terminal";
    await controls.getByRole("button", { name: liveName }).click();
    await expect.poll(() => paneFormat("#{pane_in_mode}")).toBe("0");
    expect(execFileSync("tmux", [
      ...tmux, "capture-pane", "-p", "-t", paneId,
    ], { encoding: "utf8" })).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/line-scroll-${viewport.width}.png`, animations: "disabled" });
  });
}
