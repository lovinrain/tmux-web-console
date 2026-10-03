import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) {
  throw new Error("Fork-sync checks require the disposable Playwright socket");
}
const tmux = ["-L", socket];
const sessions = ["alpha", "beta", "gamma"].map((name) => `fork-sync-${process.pid}-${name}`);
const workspaceIds: string[] = [];
const sessionTab = (page: Page, name: string) => page.locator(`.workspace-tab[data-workspace-session-name="${name}"]`).getByRole("tab");
const panelTab = (page: Page) => page.locator('.workspace-tab[data-workspace-pane-layout-id="pair"]').getByRole("tab");

test.use({ viewport: { width: 1600, height: 900 } });

test.beforeAll(() => {
  for (const name of sessions) execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name, "bash", "--noprofile", "--norc"]);
});

test.beforeEach(async ({ context }) => {
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
  await context.addInitScript(() => localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical"));
});

test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
  for (const id of workspaceIds.splice(0)) {
    expect((await context.request.delete(`/mux/api/workspaces/${id}`)).ok()).toBe(true);
  }
});

test.afterAll(() => {
  for (const name of sessions) {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
  }
});

async function showControl(page: Page, name: string): Promise<void> {
  if (!await page.getByRole("link", { name, exact: true }).first().isVisible()) {
    await page.getByRole("button", { name: /Show all console controls/ }).click();
  }
}

async function forkSync(page: Page): Promise<Page> {
  const name = "Fork-sync current view in a new browser tab";
  await showControl(page, name);
  const opened = page.context().waitForEvent("page");
  await page.getByRole("link", { name, exact: true }).first().click();
  const child = await opened;
  await expect(child).toHaveURL(/fork-sync=/);
  expect(await child.evaluate(() => window.opener === null)).toBe(true);
  return child;
}

async function selectTheme(page: Page, name: string): Promise<void> {
  const choose = page.getByRole("button", { name: "Choose themes", exact: true });
  if (!await choose.isVisible()) await page.getByRole("button", { name: /Show all console controls/ }).click();
  await choose.click();
  await page.getByRole("dialog", { name: "Themes", exact: true }).getByRole("radio", { name, exact: true }).click();
  await page.keyboard.press("Escape");
}

test("linked tabs share session and panel selection while appearance, normal forks and unlink stay independent", async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  const created = await context.request.post("/mux/api/workspaces", {
    data: {
      name: "Fork-sync browser fixture", tabs: sessions, activeSession: sessions[0], groups: [],
      paneLayouts: [{ id: "pair", name: "Pair", root: {
        id: "split", kind: "split", direction: "horizontal", ratio: 0.5,
        first: { id: "left", kind: "pane", session: sessions[0] },
        second: { id: "right", kind: "pane", session: sessions[1] },
      } }],
    },
  });
  expect(created.ok()).toBe(true);
  const workspace = (await created.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  const query = new URLSearchParams({ workspace: workspace.id });
  for (const name of sessions) query.append("tab", name);
  await page.goto(`/mux/session/${sessions[0]}?${query}`);
  await expect(sessionTab(page, sessions[0])).toHaveAttribute("aria-selected", "true");
  const follower = await forkSync(page);
  await expect(sessionTab(follower, sessions[0])).toHaveAttribute("aria-selected", "true");
  expect(new URL(follower.url()).searchParams.get("fork-sync"))
    .toBe(new URL(page.url()).searchParams.get("fork-sync"));

  await sessionTab(follower, sessions[1]).click();
  await expect(sessionTab(page, sessions[1])).toHaveAttribute("aria-selected", "true");
  await sessionTab(page, sessions[2]).click();
  await expect(sessionTab(follower, sessions[2])).toHaveAttribute("aria-selected", "true");

  await selectTheme(page, "Nord");
  await selectTheme(follower, "Solarized Light");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await expect(follower.locator("html")).toHaveAttribute("data-palette", "solarized-light");
  await page.getByRole("textbox", { name: "Staged input", exact: true }).fill("source tab draft");
  await follower.getByRole("textbox", { name: "Staged input", exact: true }).fill("linked tab draft");
  await expect(page.getByRole("textbox", { name: "Staged input", exact: true })).toHaveValue("source tab draft");
  await follower.getByRole("button", { name: "Staged input", exact: true }).click();
  await expect(follower.getByRole("button", { name: "Staged input", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Staged input", exact: true })).toHaveAttribute("aria-pressed", "true");

  await expect(page.locator("#terminal-staged-input")).toHaveValue("source tab draft");
  await expect(follower.locator("#terminal-staged-input")).toHaveValue("linked tab draft");
  await Promise.all([page.reload(), follower.reload()]);
  for (const view of [page, follower]) await expect(sessionTab(view, sessions[2])).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await expect(follower.locator("html")).toHaveAttribute("data-palette", "solarized-light");
  await expect(follower.getByRole("button", { name: "Staged input", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Staged input", exact: true })).toHaveAttribute("aria-pressed", "true");

  await expect(page.locator("#terminal-staged-input")).toHaveValue("source tab draft");
  await expect(follower.locator("#terminal-staged-input")).toHaveValue("linked tab draft");
  await showControl(follower, "Fork current view in a new browser tab");
  const ordinaryOpened = context.waitForEvent("page");
  await follower.getByRole("link", { name: "Fork current view in a new browser tab" }).click();
  const ordinary = await ordinaryOpened;
  await expect(sessionTab(ordinary, sessions[2])).toHaveAttribute("aria-selected", "true");
  expect(new URL(ordinary.url()).searchParams.has("fork-sync")).toBe(false);
  await sessionTab(ordinary, sessions[0]).click();
  await expect(sessionTab(page, sessions[2])).toHaveAttribute("aria-selected", "true");
  await expect(sessionTab(follower, sessions[2])).toHaveAttribute("aria-selected", "true");
  await ordinary.close();
  // A stale deep link must restore the group's latest selection, even when the
  // saved workspace's last activity came from the independent fork.
  const staleUrl = new URL(page.url());
  staleUrl.pathname = `/mux/session/${sessions[0]}`;
  await page.goto(staleUrl.href);
  await expect(sessionTab(page, sessions[2])).toHaveAttribute("aria-selected", "true");

  await panelTab(follower).click();
  await expect(panelTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".workspace-pane-leaf")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Session shown in pane left" }).focus();
  await follower.getByRole("combobox", { name: "Session shown in pane right" }).click();
  await expect(page.locator('.workspace-pane-leaf[data-pane-id="right"]')).toHaveClass(/active/);
  await expect(page.getByRole("combobox", { name: "Session shown in pane left" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("fork-sync-panel.png"), animations: "disabled" });

  await page.locator(".workspace-pane-top-strip").getByRole("button", { name: "Unlink this browser tab" }).click();
  expect(new URL(page.url()).searchParams.has("fork-sync")).toBe(false);
  await sessionTab(follower, sessions[1]).click();
  await expect(sessionTab(follower, sessions[1])).toHaveAttribute("aria-selected", "true");
  await expect(panelTab(page)).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(panelTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
});

test("temporary pane views bootstrap a linked tab and survive reloading both views", async ({ page }) => {
  const query = new URLSearchParams();
  for (const name of sessions) query.append("tab", name);
  await page.goto(`/mux/session/${sessions[0]}?${query}`);
  await page.getByRole("button", { name: "Create multi-pane view", exact: true }).click();
  await expect(page.locator(".workspace-pane-leaf")).toHaveCount(1);
  await page.getByRole("button", { name: "Split this pane left and right" }).click();
  const panes = page.locator(".workspace-pane-leaf");
  await expect(panes).toHaveCount(2);
  await panes.nth(1).getByRole("combobox", { name: /Session shown in pane/ }).selectOption(sessions[1]);
  const follower = await forkSync(page);
  await expect(follower.locator(".workspace-pane-leaf")).toHaveCount(2);
  await expect(follower.locator(".workspace-pane-leaf").nth(1).getByRole("combobox", { name: /Session shown in pane/ })).toHaveValue(sessions[1]);
  await follower.locator(".workspace-pane-leaf").nth(1).getByRole("combobox", { name: /Session shown in pane/ }).selectOption(sessions[2]);
  await expect(panes.nth(1).getByRole("combobox", { name: /Session shown in pane/ })).toHaveValue(sessions[2]);
  await Promise.all([page.reload(), follower.reload()]);
  for (const view of [page, follower]) {
    await expect(view.locator(".workspace-pane-leaf")).toHaveCount(2);
    await expect(view.locator(".workspace-pane-leaf").nth(1).getByRole("combobox", { name: /Session shown in pane/ })).toHaveValue(sessions[2]);
  }
  await sessionTab(follower, sessions[0]).click();
  await expect(sessionTab(page, sessions[0])).toHaveAttribute("aria-selected", "true");
});

test("a browser without BroadcastChannel can unlink a pasted sync URL", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
  });
  await page.goto(`/mux/session/${sessions[0]}?tab=${sessions[0]}&fork-sync=unsupported`);
  const control = page.getByRole("button", { name: "Fork-sync current view in a new browser tab" });
  if (!await control.isVisible()) await page.getByRole("button", { name: /Show all console controls/ }).click();
  await expect(control).toBeDisabled();
  await page.getByRole("button", { name: "Unlink this browser tab" }).click();
  expect(new URL(page.url()).searchParams.has("fork-sync")).toBe(false);
  await expect(sessionTab(page, sessions[0])).toHaveAttribute("aria-selected", "true");
});
