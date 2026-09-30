import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) {
  throw new Error("Theme preset checks require the disposable Playwright socket");
}
const tmux = ["-L", socket];
const sessionName = `muxdeck-theme-presets-${process.pid}`;
const sessionUrl = `/mux/session/${sessionName}?tab=${sessionName}`;

async function choosePreset(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Choose themes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Themes", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name, exact: true }).check();
  await expect(dialog.getByRole("radio", { name, exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

async function expectTerminalColors(page: Page, background: string, foreground: string): Promise<void> {
  await expect(page.locator(".terminal-stage")).toHaveCSS("background-color", background);
  // Xterm 6 paints its active scroll layer; its legacy .xterm-viewport keeps
  // the default black CSS and is not the visible terminal background.
  await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", background);
  await expect(page.locator(".xterm-rows")).toHaveCSS("color", foreground);
}

function sessionIdentity(): string {
  return execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${sessionName}`,
    "-F", "#{session_id}:#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}",
  ], { encoding: "utf8" }).trim();
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(() => {
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", sessionName,
    "bash", "--noprofile", "--norc",
  ]);
});

test.beforeEach(async ({ context }) => {
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
});

test.afterAll(() => {
  try {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${sessionName}`]);
  } catch {
    // Only this exact fixture session on the required disposable socket is eligible.
  }
});

test("dark and light presets stay independent through toggles and reloads", async ({ page }, testInfo) => {
  await page.goto("/mux/");
  const canvas = page.locator(".dashboard-shell");
  const card = page.locator(".session-card").filter({ hasText: sessionName }).first();
  await expect(card).toBeVisible();

  await choosePreset(page, "Nord");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await expect(canvas).toHaveCSS("background-color", "rgb(46, 52, 64)");
  await expect(card).toHaveCSS("background-color", "rgb(59, 66, 82)");
  await expect(page.locator(".saved-workspaces-empty")).toHaveCSS("background-color", "rgb(59, 66, 82)");
  await page.screenshot({ path: testInfo.outputPath("dashboard-nord.png"), animations: "disabled" });

  await choosePreset(page, "Solarized Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "solarized-light");
  await expect(canvas).toHaveCSS("background-color", "rgb(253, 246, 227)");
  await expect(card).toHaveCSS("background-color", "rgb(255, 251, 239)");
  await expect(page.locator(".saved-workspaces-empty")).toHaveCSS("background-color", "rgb(255, 251, 239)");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("muxdeck-theme-palettes")!)))
    .toEqual({ dark: "nord", light: "solarized-light" });
  await page.screenshot({ path: testInfo.outputPath("dashboard-solarized-light.png"), animations: "disabled" });

  const toggle = page.getByRole("button", { name: "Light theme", exact: true });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await expect(canvas).toHaveCSS("background-color", "rgb(46, 52, 64)");
  await expect(card).toHaveCSS("background-color", "rgb(59, 66, 82)");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "solarized-light");
  await expect(card).toHaveCSS("background-color", "rgb(255, 251, 239)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "solarized-light");
  await expect(canvas).toHaveCSS("background-color", "rgb(253, 246, 227)");
  await page.getByRole("button", { name: "Choose themes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Themes", exact: true });
  await expect(dialog.getByRole("radio", { name: "Nord", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Solarized Light", exact: true })).toBeChecked();
  // Clicking an already checked radio must preview its mode too. check() would
  // skip the native click and would miss this browser interaction.
  await dialog.getByRole("radio", { name: "Nord", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await page.keyboard.press("Escape");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "solarized-light");
});

test("narrow theme chooser has accessible groups, keyboard selection, and Escape focus return", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mux/");
  const opener = page.getByRole("button", { name: "Choose themes", exact: true });
  await expect(opener).toBeInViewport();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Themes", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Dark themes", exact: true }).getByRole("radio"))
    .toHaveCount(4);
  await expect(dialog.getByRole("group", { name: "Light themes", exact: true }).getByRole("radio"))
    .toHaveCount(4);
  await expect(dialog.getByRole("radio", { name: "Rosé Pine Dawn", exact: true })).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);

  const nord = dialog.getByRole("radio", { name: "Nord", exact: true });
  await nord.focus();
  await page.keyboard.press("Space");
  await expect(nord).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "nord");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Dracula", exact: true })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dracula");
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("theme-chooser-narrow.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("live console applies presets without reconnecting, input, or tmux resizing", async ({ page }, testInfo) => {
  let terminalSocketCount = 0;
  let terminalSocketCloses = 0;
  const inputFrames: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal")) return;
    terminalSocketCount += 1;
    socket.on("close", () => { terminalSocketCloses += 1; });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") {
        try {
          const message = JSON.parse(payload);
          if (message.type === "resize" || message.type === "history") return;
        } catch {
          // Raw terminal input remains part of the assertion.
        }
      }
      inputFrames.push(String(payload));
    });
  });
  await page.goto(sessionUrl);
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await page.getByRole("button", { name: "Fit active", exact: true }).click();
  await expect(page.getByRole("button", { name: "Size protected", exact: true })).toBeVisible();
  await expect.poll(() => terminalSocketCount).toBe(2);
  await expect.poll(() => terminalSocketCloses).toBe(1);
  await expect(page.locator(".connection-badge")).toContainText("Live");
  const socketsBefore = terminalSocketCount;
  const closesBefore = terminalSocketCloses;
  const framesBefore = inputFrames.length;
  const identityBefore = sessionIdentity();

  await choosePreset(page, "Nord");
  await expectTerminalColors(page, "rgb(46, 52, 64)", "rgb(236, 239, 244)");
  await choosePreset(page, "Solarized Light");
  await expectTerminalColors(page, "rgb(253, 246, 227)", "rgb(88, 110, 117)");
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expectTerminalColors(page, "rgb(46, 52, 64)", "rgb(236, 239, 244)");
  await page.screenshot({ path: testInfo.outputPath("console-nord.png"), animations: "disabled" });
  expect(sessionIdentity()).toBe(identityBefore);

  // On narrower desktops the chooser lives in the control tray. Its portal
  // must own clicks/Escape and return focus without hiding that opener.
  await page.setViewportSize({ width: 1280, height: 900 });
  const trayToggle = page.getByRole("button", { name: /Show all console controls/ });
  await trayToggle.click();
  const tray = page.getByRole("group", { name: "All console controls", exact: true });
  const opener = tray.getByRole("button", { name: "Choose themes", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Themes", exact: true });
  const light = dialog.getByRole("radio", { name: "Solarized Light", exact: true });
  await expect(light).toBeChecked();
  await light.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectTerminalColors(page, "rgb(253, 246, 227)", "rgb(88, 110, 117)");
  await expect(tray).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(tray).toBeVisible();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tray).toHaveCount(0);
  await expect(trayToggle).toBeFocused();

  await expect(page.locator(".connection-badge")).toContainText("Live");
  expect(terminalSocketCount).toBe(socketsBefore);
  expect(terminalSocketCloses).toBe(closesBefore);
  expect(inputFrames).toHaveLength(framesBefore);
  expect(sessionIdentity().split(":").slice(0, 3)).toEqual(identityBefore.split(":").slice(0, 3));
});
