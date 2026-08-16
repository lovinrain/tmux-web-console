import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const sessionName = `muxdeck-browser-${process.pid}`;
const alternateSessionName = `${sessionName}-alternate`;
const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || "muxdeck-playwright-test";
const tmux = ["-L", socketName];
const titlesFile = process.env.MUXDECK_PLAYWRIGHT_TITLES_FILE;
const messagesFile = process.env.MUXDECK_PLAYWRIGHT_MESSAGES_FILE;
const snippetsFile = process.env.MUXDECK_PLAYWRIGHT_SNIPPETS_FILE;
const originalQueuedCommand = "printf 'MEMO_QUEUE_ORIGINAL\\n'";
const editedQueuedCommand = "printf 'MEMO_QUEUE_EDITED\\n'";
const CSS_PIXEL_TOLERANCE = 0.01;
let paneId = "";

async function expectRoute(
  page: Page,
  pathname: string,
  tabs: string[],
  query: Record<string, string> = {},
): Promise<void> {
  const queryKeys = Object.keys(query);
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      tabs: url.searchParams.getAll("tab"),
      query: Object.fromEntries(queryKeys.map((key) => [key, url.searchParams.get(key)])),
    };
  }).toEqual({ pathname, tabs, query });
}

if (!titlesFile || !messagesFile || !snippetsFile) {
  throw new Error("Playwright metadata paths were not configured");
}

test.beforeAll(() => {
  rmSync(titlesFile, { force: true });
  rmSync(messagesFile, { force: true });
  rmSync(snippetsFile, { force: true });
  try {
    execFileSync("tmux", [...tmux, "kill-server"], { stdio: "ignore" });
  } catch {
    // A clean test run has no isolated server yet.
  }
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", sessionName, "bash", "--noprofile", "--norc"]);
  paneId = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${sessionName}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  mkdirSync("artifacts", { recursive: true });
});

test.afterAll(() => {
  try {
    execFileSync("tmux", [...tmux, "kill-server"], { stdio: "ignore" });
  } catch {
    // The test session may already be gone after a failed attach.
  }
  rmSync(titlesFile, { force: true });
  rmSync(messagesFile, { force: true });
  rmSync(snippetsFile, { force: true });
});

test("desktop dashboard renders a three-column session grid", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/mux/");
  await expect(page.getByRole("heading", { name: "Muxdeck", exact: true })).toBeVisible();
  await expect(page.locator(".session-card").first()).toBeVisible();
  await expect(page.getByText(/1 sessions \/ live/i)).toBeVisible();
  const activeSessionGrid = page.locator(
    ".session-section:not(.ignored-section) .session-grid",
  ).first();
  const columns = await activeSessionGrid.evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.split(" ").length;
  });
  expect(columns).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/dashboard-desktop.png" });

  const desktopThemeToggle = page.getByRole("button", { name: "Light theme" });
  await desktopThemeToggle.click();
  await page.mouse.move(0, 0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(desktopThemeToggle).toHaveCSS("background-color", "rgb(230, 239, 215)");
  await expect(page.locator(".session-card").first()).toHaveCSS(
    "background-color",
    "rgba(255, 253, 248, 0.94)",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/dashboard-desktop-light.png" });

  await page.setViewportSize({ width: 1100, height: 900 });
  const mediumColumns = await activeSessionGrid.evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  ));
  expect(mediumColumns).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.setViewportSize({ width: 768, height: 900 });
  const tabletColumns = await activeSessionGrid.evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  ));
  expect(tabletColumns).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test("light theme persists across dashboard, snippets, overlays, and console", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mux/");
  await expect(page.locator(".session-card").first()).toBeVisible();

  const themeToggle = page.getByRole("button", { name: "Light theme" });
  await expect(themeToggle).toHaveAttribute("aria-pressed", "false");
  const darkToggleBox = await themeToggle.boundingBox();
  expect(darkToggleBox?.width).toBeGreaterThanOrEqual(40);
  expect(darkToggleBox?.height).toBeGreaterThanOrEqual(40);
  await themeToggle.click();
  await expect(themeToggle).toHaveAttribute("aria-pressed", "true");
  const lightToggleBox = await themeToggle.boundingBox();
  expect(lightToggleBox?.width).toBe(darkToggleBox?.width);
  expect(lightToggleBox?.height).toBe(darkToggleBox?.height);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f4f0e7");
  expect(await page.evaluate(() => window.localStorage.getItem("muxdeck-theme"))).toBe("light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/dashboard-mobile-light.png", fullPage: true });

  await page.getByRole("button", { name: "Snippets", exact: true }).click();
  await expect(page).toHaveURL("/mux/snippets");
  await expect(page.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "true");
  const libraryControls = page.getByLabel("Snippet library controls");
  await libraryControls.getByRole("button", { name: "New folder", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New folder" })).toBeVisible();
  await expect(page.locator(".snippet-editor-sheet")).toHaveCSS("opacity", "1");
  await expect(page.locator(".snippet-editor-backdrop")).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/snippet-editor-mobile-light.png" });
  await page.getByRole("button", { name: "Close snippet editor" }).click();

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: `Open ${sessionName}` }).click();
  await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".terminal-stage")).toHaveCSS("background-color", "rgb(251, 250, 245)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/console-mobile-light.png" });

  await page.getByRole("button", { name: "Pane scrollback" }).click();
  await expect(page.getByRole("heading", { name: "Scrollback" })).toBeVisible();
  await expect(page.locator(".history-panel")).toHaveCSS("opacity", "1");
  await expect(page.locator(".history-panel")).toHaveCSS("width", "390px");
  await expect(page.locator(".history-resize-handle")).toBeHidden();
  await expect(page.locator(".history-resize-handle")).toHaveAttribute("tabindex", "-1");
  await expect(page.locator(".history-backdrop")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "artifacts/history-mobile-light.png" });
  await page.getByRole("button", { name: "Close history" }).click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f4f0e7");
  await expect(page.getByRole("button", { name: "Light theme" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#151914");
  expect(await page.evaluate(() => window.localStorage.getItem("muxdeck-theme"))).toBe("dark");
});

test("shareable dashboard URL restores ordered sorting and fits narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/mux/?view=list&group=state&sort=state-change,tmux-name");
  await expect(page.locator(".session-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Group State / attention" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sort-priority-chip")).toHaveText([
    /01State changednewest first/,
    /02Tmux nameA-Z/,
  ]);
  const narrowThemeToggle = page.getByRole("button", { name: "Light theme" });
  await expect(narrowThemeToggle).toBeVisible();
  const narrowThemeToggleBox = await narrowThemeToggle.boundingBox();
  expect(narrowThemeToggleBox?.width).toBe(40);
  expect(narrowThemeToggleBox?.height).toBeGreaterThanOrEqual(40);
  await expect(page.locator(".dashboard-header-tools .server-pulse")).toBeHidden();
  await page.reload();
  await expect(page.locator(".sort-priority-chip")).toHaveText([
    /01State changednewest first/,
    /02Tmux nameA-Z/,
  ]);

  const rowMain = page.locator(".session-row .session-card-main").first();
  await expect(rowMain).toBeVisible();
  expect(await rowMain.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await expect(page.locator(".state-group-header").getByRole("heading", { name: "Other" })).toBeVisible();
  await page.getByRole("button", { name: "Group State / attention" }).click();
  await expect(page).toHaveURL(/\/mux\/\?view=list&sort=state-change,tmux-name$/);
  await expect(page.locator(".state-change-time")).toContainText("state");

  await page.getByRole("combobox", { name: "Add sort criterion" }).selectOption("title");
  await expect(page).toHaveURL(/sort=state-change,tmux-name,title$/);
  await page.getByRole("button", { name: "Move Title earlier" }).click();
  await expect(page).toHaveURL(/sort=state-change,title,tmux-name$/);
  await page.getByRole("button", { name: "Remove State changed sort" }).click();
  await expect(page.locator(".sort-priority-chip")).toHaveText([
    /01TitleA-Z/,
    /02Tmux nameA-Z/,
  ]);
  await expect(page).toHaveURL(/sort=title,tmux-name$/);

  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const sortBuilderFits = await page.locator(".sort-builder").evaluate((element) => {
    return element.scrollWidth <= element.clientWidth;
  });
  expect(sortBuilderFits).toBe(true);
});

test("dashboard query survives new-window and same-window console navigation", async ({ page }) => {
  const dashboardUrl = `/mux/?q=${encodeURIComponent(sessionName)}&kind=shells&state=other&view=list&group=state&sort=state,tmux-name`;
  const dashboardQuery = {
    q: sessionName,
    kind: "shells",
    state: "other",
    view: "list",
    group: "state",
    sort: "state,tmux-name",
  };
  await page.goto(dashboardUrl);
  await expect(page.getByRole("button", { name: `Open ${sessionName}` })).toBeVisible();
  await expect(page.getByLabel("Find a session")).toHaveValue(sessionName);
  await expect(page.getByRole("button", { name: "shells", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Other/ })).toHaveAttribute("aria-pressed", "true");

  const newWindowLink = page.getByRole("link", {
    name: `Open ${sessionName} in new window`,
  });
  await expect(newWindowLink).toHaveAttribute("target", "_blank");
  const [newWindow] = await Promise.all([
    page.waitForEvent("popup"),
    newWindowLink.click(),
  ]);
  await expectRoute(
    newWindow,
    `/mux/session/${sessionName}`,
    [sessionName],
    dashboardQuery,
  );
  await expect(newWindow.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await expect(page).toHaveURL(dashboardUrl);
  await newWindow.close();

  await page.getByRole("button", { name: `Open ${sessionName}` }).click();
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], dashboardQuery);
  await page.goBack();
  await expectRoute(page, "/mux/", [sessionName], dashboardQuery);
  await expect(page.getByLabel("Find a session")).toHaveValue(sessionName);
  await page.goForward();
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], dashboardQuery);
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expectRoute(page, "/mux/", [sessionName], dashboardQuery);

  await page.goto(`/mux/session/${sessionName}?kind=shells&view=list&sort=title,tmux-name`);
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], {
    kind: "shells",
    view: "list",
    sort: "title,tmux-name",
  });
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expectRoute(page, "/mux/", [sessionName], {
    kind: "shells",
    view: "list",
    sort: "title,tmux-name",
  });
  await expect(page.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
});

test("new session creation preserves SPA tabs and isolates a new browser window", async ({ page }) => {
  test.setTimeout(60_000);
  const createdSessions: string[] = [];
  let popup: Page | null = null;
  const dashboardQuery = { kind: "shells", view: "list" };

  const createdSessionName = async (target: Page): Promise<string> => {
    await expect.poll(() => new URL(target.url()).pathname).toMatch(/^\/mux\/session\/[^/]+$/);
    return decodeURIComponent(new URL(target.url()).pathname.replace("/mux/session/", ""));
  };

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mux/?kind=shells&view=list");
    await expect(page.getByRole("button", { name: `Open ${sessionName}`, exact: true })).toBeVisible();

    const primaryAction = page.getByRole("button", { name: "New session", exact: true });
    const windowAction = page.getByRole("link", { name: "Open new session in new window" });
    for (const action of [primaryAction, windowAction]) {
      const box = await action.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    // Seed this browser page with one real quick tab before opening the synthetic creation tab.
    await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expectRoute(page, "/mux/", [sessionName], dashboardQuery);

    const isolatedHref = new URL(
      await page.getByRole("link", { name: "Open new session in new window" }).getAttribute("href")
        || "",
      page.url(),
    );
    expect(isolatedHref.pathname).toBe("/mux/sessions/new");
    expect(isolatedHref.searchParams.getAll("tab")).toEqual([]);

    await page.getByRole("button", { name: "New session", exact: true }).click();
    await expectRoute(page, "/mux/sessions/new", [sessionName], dashboardQuery);
    const creationTab = page.getByRole("tab", { name: "New session, not created yet" });
    await expect(creationTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Start a new session." })).toBeFocused();
    await expect(page.locator(".new-session-card")).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: "artifacts/new-session-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    for (const action of ["Create session", "Cancel"]) {
      const box = await page.getByRole("button", { name: action }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("button", { name: "Create session" }).click();
    const createdInSpa = await createdSessionName(page);
    createdSessions.push(createdInSpa);
    await expectRoute(
      page,
      `/mux/session/${encodeURIComponent(createdInSpa)}`,
      [sessionName, createdInSpa],
      dashboardQuery,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });

    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expectRoute(page, "/mux/", [sessionName, createdInSpa], dashboardQuery);

    const [openedPopup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Open new session in new window" }).click(),
    ]);
    popup = openedPopup;
    await expectRoute(openedPopup, "/mux/sessions/new", [], dashboardQuery);
    await expectRoute(page, "/mux/", [sessionName, createdInSpa], dashboardQuery);

    await openedPopup.getByRole("button", { name: "Create session" }).click();
    const createdInWindow = await createdSessionName(openedPopup);
    createdSessions.push(createdInWindow);
    await expectRoute(
      openedPopup,
      `/mux/session/${encodeURIComponent(createdInWindow)}`,
      [createdInWindow],
      dashboardQuery,
    );
    await expect(openedPopup.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expectRoute(page, "/mux/", [sessionName, createdInSpa], dashboardQuery);
  } finally {
    if (popup && !popup.isClosed()) await popup.close();
    for (const createdSession of createdSessions) {
      try {
        execFileSync("tmux", [...tmux, "kill-session", "-t", `=${createdSession}`], {
          stdio: "ignore",
        });
      } catch {
        // Cleanup stays scoped to sessions created on this test's disposable socket.
      }
    }
  }
});

test("desktop scrollback width is adjustable for the current browser tab", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mux/session/${sessionName}`);
  await expect(page.getByRole("button", { name: "Pane scrollback" })).toBeEnabled();
  await page.getByRole("button", { name: "Pane scrollback" }).click();

  const panel = page.locator(".history-panel");
  const resizeHandle = page.getByRole("separator", {
    name: "Resize scrollback panel",
  });
  await expect(panel).toHaveCSS("width", "680px");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "680");

  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error("Scrollback resize handle has no bounding box");
  expect(handleBox.width).toBeGreaterThanOrEqual(44);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 140, startY, { steps: 4 });
  await page.mouse.up();
  await expect(panel).toHaveCSS("width", "820px");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "820");

  await resizeHandle.press("Shift+ArrowRight");
  await expect(panel).toHaveCSS("width", "756px");
  await page.screenshot({ path: "artifacts/history-desktop-resized.png" });
  await page.getByRole("button", { name: "Close history" }).click();
  await page.getByRole("button", { name: "Pane scrollback" }).click();
  await expect(panel).toHaveCSS("width", "756px");

  await page.getByRole("button", { name: "Close history" }).click();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
  await page.getByRole("button", { name: "Pane scrollback" }).click();
  await expect(panel).toHaveCSS("width", "756px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Close history" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Pane scrollback" })).toBeEnabled();
  await page.getByRole("button", { name: "Pane scrollback" }).click();
  await expect(panel).toHaveCSS("width", "680px");
});

test("mobile workspace quick-switches one live terminal and keeps a page-local visit trail", async ({ page }) => {
  test.setTimeout(60_000);
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    alternateSessionName,
    "bash",
    "--noprofile",
    "--norc",
  ]);

  const primaryTabName = new RegExp(`^${sessionName},`);
  const alternateTabName = new RegExp(`^${alternateSessionName},`);

  try {
    await page.addInitScript(() => {
      const sockets: WebSocket[] = [];
      Object.defineProperty(window, "__muxdeckTestSockets", {
        value: sockets,
        configurable: true,
      });
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket;
          sockets.push(socket);
          return socket;
        },
      });
    });
    const activeTerminalSockets = () => page.evaluate(() => {
      const sockets = (window as Window & { __muxdeckTestSockets: WebSocket[] })
        .__muxdeckTestSockets;
      return sockets
        .filter((socket) => socket.url.includes("/ws/terminal") && socket.readyState === WebSocket.OPEN)
        .map((socket) => socket.url);
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const dashboardUrl = "/mux/?kind=shells&view=list";
    const dashboardQuery = { kind: "shells", view: "list" };
    await page.goto(dashboardUrl);
    await expect(page.getByRole("button", { name: `Open ${sessionName}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Open ${alternateSessionName}`, exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(page.getByRole("tab", { name: primaryTabName })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName],
      dashboardQuery,
    );

    const consoleBars = page.getByRole("group", { name: "Console bars" });
    const sessionTabsToggle = consoleBars.getByRole("button", {
      name: "Session tabs",
      exact: true,
    });
    const stagedInputToggle = consoleBars.getByRole("button", {
      name: "Staged input",
      exact: true,
    });
    const terminalShortcutsToggle = consoleBars.getByRole("button", {
      name: "Terminal shortcut buttons",
      exact: true,
    });
    const sessionTabs = page.locator("#muxdeck-session-tabs");
    const stagedInputRegion = page.locator("#muxdeck-staged-input");
    const terminalShortcuts = page.locator("#muxdeck-terminal-shortcuts");

    await expect(consoleBars).toBeVisible();
    for (const [toggle, targetId] of [
      [sessionTabsToggle, "muxdeck-session-tabs"],
      [stagedInputToggle, "muxdeck-staged-input"],
      [terminalShortcutsToggle, "muxdeck-terminal-shortcuts"],
    ] as const) {
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveAttribute("aria-controls", targetId);
      const box = await toggle.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(sessionTabs).toBeVisible();
    await expect(stagedInputRegion).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();

    const recentsButton = page.getByRole("button", { name: /Open session switcher/ });
    const recentsBox = await recentsButton.boundingBox();
    expect(recentsBox?.width).toBeGreaterThanOrEqual(44);
    expect(recentsBox?.height).toBeGreaterThanOrEqual(44);
    await recentsButton.click();
    await expectRoute(
      page,
      `/mux/session/${sessionName}/recents`,
      [sessionName],
      dashboardQuery,
    );
    const switcher = page.getByRole("dialog", { name: "Switch sessions" });
    await expect(switcher).toBeVisible();
    const switcherBox = await switcher.boundingBox();
    expect(switcherBox?.width).toBeLessThanOrEqual(390);
    expect(switcherBox?.height).toBeLessThanOrEqual(844);

    await switcher.getByRole("button", { name: new RegExp(alternateSessionName) }).click();
    await expectRoute(
      page,
      `/mux/session/${alternateSessionName}`,
      [sessionName, alternateSessionName],
      dashboardQuery,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: alternateTabName })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const orderedTabSearch = `?kind=shells&view=list&tab=${encodeURIComponent(sessionName)}&tab=${encodeURIComponent(alternateSessionName)}`;
    const alternateUrl = `/mux/session/${alternateSessionName}${orderedTabSearch}`;
    const primaryUrl = `/mux/session/${sessionName}${orderedTabSearch}`;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab").nth(0)).toHaveAccessibleName(primaryTabName);
    await expect(page.getByRole("tab").nth(1)).toHaveAccessibleName(alternateTabName);
    await expect(page.getByRole("tab", { name: alternateTabName })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectRoute(
      page,
      `/mux/session/${alternateSessionName}`,
      [sessionName, alternateSessionName],
      dashboardQuery,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });

    const visibilityDraft = "visibility controls keep this staged draft";
    const alternateDraft = page.getByRole("textbox", { name: "Staged input" });
    await alternateDraft.fill(visibilityDraft);
    const terminalHeightWithAllBars = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );

    await stagedInputToggle.click();
    await expect(stagedInputToggle).toHaveAttribute("aria-pressed", "false");
    await expect(stagedInputRegion).toBeHidden();
    await expect(sessionTabs).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();
    await expect(page).toHaveURL(alternateUrl);
    await expect(stagedInputToggle).toBeFocused();
    await stagedInputToggle.click();
    await expect(stagedInputRegion).toBeVisible();
    await expect(alternateDraft).toHaveValue(visibilityDraft);

    await page.getByRole("button", { name: "Show other keys" }).click();
    await expect(page.getByRole("group", { name: "Other keys" })).toBeVisible();
    await terminalShortcutsToggle.click();
    await expect(terminalShortcutsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(terminalShortcuts).toBeHidden();
    await expect(page.getByRole("group", { name: "Other keys" })).toHaveCount(0);
    await expect(sessionTabs).toBeVisible();
    await expect(stagedInputRegion).toBeVisible();
    await expect(page).toHaveURL(alternateUrl);
    await terminalShortcutsToggle.click();
    await expect(terminalShortcuts).toBeVisible();
    await expect(page.getByRole("button", { name: "Show other keys" })).toBeVisible();

    await sessionTabsToggle.click();
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(sessionTabs).toBeHidden();
    await expect(stagedInputRegion).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();
    await expect(consoleBars).toBeVisible();
    await expect(page).toHaveURL(alternateUrl);
    await sessionTabsToggle.click();
    await expect(sessionTabs).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);

    await sessionTabsToggle.click();
    await stagedInputToggle.click();
    await terminalShortcutsToggle.click();
    await expect(sessionTabs).toBeHidden();
    await expect(stagedInputRegion).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    await expect(consoleBars).toBeVisible();
    await expect(page).toHaveURL(alternateUrl);
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${alternateSessionName}`);
    }).toBe(true);
    const terminalHeightWithBarsHidden = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(terminalHeightWithBarsHidden).toBeGreaterThan(terminalHeightWithAllBars);

    await page.goBack();
    await expectRoute(page, "/mux/", [sessionName, alternateSessionName], dashboardQuery);
    await page.goForward();
    await expect(page).toHaveURL(alternateUrl);
    await expect(page.getByRole("dialog", { name: "Switch sessions" })).toBeHidden();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(stagedInputToggle).toHaveAttribute("aria-pressed", "false");
    await expect(terminalShortcutsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(sessionTabs).toBeHidden();
    await expect(stagedInputRegion).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${alternateSessionName}`);
    }).toBe(true);

    await sessionTabsToggle.click();
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(sessionTabs).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page).toHaveURL(alternateUrl);

    const firstTab = page.getByRole("tab", { name: primaryTabName });
    const firstTabBox = await firstTab.boundingBox();
    expect(firstTabBox?.height).toBeGreaterThanOrEqual(44);
    await firstTab.focus();
    await firstTab.press("Enter");
    await expect(page).toHaveURL(primaryUrl);
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, alternateSessionName],
      dashboardQuery,
    );
    await expect(firstTab).toBeFocused();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${sessionName}&`);
    }).toBe(true);
    await expect(stagedInputToggle).toHaveAttribute("aria-pressed", "false");
    await expect(terminalShortcutsToggle).toHaveAttribute("aria-pressed", "false");
    await stagedInputToggle.click();
    await terminalShortcutsToggle.click();
    await expect(stagedInputRegion).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();

    await page.getByRole("button", { name: /Open session switcher/ }).click();
    await page.getByRole("dialog", { name: "Switch sessions" })
      .getByRole("button", { name: `Close ${sessionName} quick tab` })
      .click();
    const alternateOnlyUrl = `/mux/session/${alternateSessionName}?kind=shells&view=list&tab=${encodeURIComponent(alternateSessionName)}`;
    await expect(page).toHaveURL(alternateOnlyUrl);
    await expectRoute(
      page,
      `/mux/session/${alternateSessionName}`,
      [alternateSessionName],
      dashboardQuery,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(page.getByRole("textbox", { name: "Staged input" })).toHaveValue(visibilityDraft);

    await page.getByRole("button", { name: /Open session switcher/ }).click();
    await expect(page.getByRole("heading", { name: "Recently visited" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Switch sessions" }))
      .toContainText(sessionName);
    const workspaceSearch = switcher.getByRole("searchbox", { name: "Find a workspace session" });
    await workspaceSearch.fill(sessionName);
    const clearWorkspaceSearch = switcher.getByRole("button", { name: "Clear workspace search" });
    await clearWorkspaceSearch.focus();
    await clearWorkspaceSearch.press("Enter");
    await page.keyboard.press("Tab");
    expect(await switcher.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "artifacts/workspace-recents-mobile.png" });
    await page.getByRole("button", { name: "Close session switcher" }).click();
    await expect(page).toHaveURL(alternateOnlyUrl);

    await page.getByRole("button", { name: /Open session switcher/ }).click();
    await page.getByRole("button", { name: "Browse all" }).click();
    await expectRoute(page, "/mux/", [alternateSessionName], dashboardQuery);
    await page.goForward();
    await expect(page).toHaveURL(alternateOnlyUrl);
    await expect(page.getByRole("dialog", { name: "Switch sessions" })).toBeHidden();

    await sessionTabsToggle.click();
    await stagedInputToggle.click();
    await terminalShortcutsToggle.click();
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(stagedInputToggle).toHaveAttribute("aria-pressed", "false");
    await expect(terminalShortcutsToggle).toHaveAttribute("aria-pressed", "false");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(consoleBars).toBeVisible();
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(stagedInputToggle).toHaveAttribute("aria-pressed", "true");
    await expect(terminalShortcutsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(sessionTabs).toBeVisible();
    await expect(stagedInputRegion).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: alternateTabName })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goBack();
    await expectRoute(page, "/mux/", [alternateSessionName], dashboardQuery);
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${alternateSessionName}`]);
    } catch {
      // The isolated session may already have ended after a failed assertion.
    }
  }
});

test("snippet tree persists and stages exact input from cards and lists", async ({ page }) => {
  const snippetCommand = "printf 'SNIPPET_E2E_OK\\n'";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mux/");
  await page.getByRole("button", { name: "Snippets", exact: true }).click();
  await expect(page).toHaveURL("/mux/snippets");

  const libraryControls = page.getByLabel("Snippet library controls");
  await libraryControls.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Shared prompts");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Open folder Shared prompts" }).click();
  await libraryControls.getByRole("button", { name: "New snippet", exact: true }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("E2E status");
  const snippetEditor = page.getByRole("textbox", { name: "Snippet text" });
  await expect(snippetEditor).toHaveCSS("font-size", "16px");
  await snippetEditor.fill(snippetCommand);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit snippet E2E status" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Open folder Shared prompts" }).click();
  await expect(page.getByRole("button", { name: "Edit snippet E2E status" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/snippets-mobile.png", fullPage: true });

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page).toHaveURL("/mux/");
  await page.getByRole("button", { name: `Use snippet with ${sessionName}` }).click();
  await page.getByRole("searchbox", { name: "Search all snippets" }).fill("E2E status");
  await page.getByRole("button", { name: "Preview snippet E2E status" }).click();
  await page.screenshot({ path: "artifacts/snippet-picker-mobile.png" });
  await expect(page.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Insert", exact: true }).click();

  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName]);
  let stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toHaveValue(snippetCommand);
  expect(execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" }))
    .not.toContain("SNIPPET_E2E_OK");
  await expect(page.getByRole("button", { name: "Send + Enter" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(() => execFileSync(
    "tmux",
    [...tmux, "capture-pane", "-p", "-t", paneId],
    { encoding: "utf8" },
  )).toContain("SNIPPET_E2E_OK");

  await page.getByRole("button", { name: "Back to sessions" }).click();
  await page.getByRole("button", { name: "List" }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const rowSnippet = page.getByRole("button", { name: `Use snippet with ${sessionName}` });
  await expect(rowSnippet.locator("xpath=ancestor::article[contains(@class, 'session-row')]")).toBeVisible();
  await rowSnippet.click();
  await page.getByRole("searchbox", { name: "Search all snippets" }).fill("E2E status");
  await page.getByRole("button", { name: "Preview snippet E2E status" }).click();
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toHaveValue(snippetCommand);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile ignored sessions persist collapsed and remain recoverable", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  let restored = false;

  try {
    await page.goto("/mux/");
    const ignoredSection = page.locator("details.ignored-section");
    const ignoredSummary = ignoredSection.locator("summary");
    await expect(ignoredSection).toBeVisible();
    await expect(ignoredSection).not.toHaveAttribute("open", "");
    await expect(ignoredSection.locator(".ignored-section-count")).toHaveText("0");

    const ignoreButton = page.getByRole("button", { name: `Ignore ${sessionName}` });
    await expect(ignoreButton).toBeVisible();
    await expect(ignoreButton).toHaveAttribute("aria-pressed", "false");

    const ignoreButtonBox = await ignoreButton.boundingBox();
    expect(ignoreButtonBox?.width).toBeGreaterThanOrEqual(44 - CSS_PIXEL_TOLERANCE);
    expect(ignoreButtonBox?.height).toBeGreaterThanOrEqual(44 - CSS_PIXEL_TOLERANCE);
    await ignoreButton.click();

    await expect(ignoredSection).toBeVisible();
    await expect(ignoredSection).not.toHaveAttribute("open", "");
    await expect(ignoredSummary).toContainText("Ignored");
    await expect(ignoredSection.locator(".ignored-section-count")).toHaveText("1");
    await expect(page.getByText("0 starred / 0 filtered / 1 ignored")).toBeVisible();
    await expect(ignoredSection.getByRole("button", { name: `Open ${sessionName}` }))
      .toBeHidden();
    await expect(ignoredSection.locator(".session-ignore-toggle")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(ignoredSection).toBeVisible();
    await expect(ignoredSection).not.toHaveAttribute("open", "");
    await expect(ignoredSection.locator(".ignored-section-count")).toHaveText("1");
    await expect(page.getByText("0 starred / 0 filtered / 1 ignored")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const summaryBox = await ignoredSummary.boundingBox();
    expect(summaryBox?.height).toBeGreaterThanOrEqual(44);
    await ignoredSummary.click();
    await expect(ignoredSection).toHaveAttribute("open", "");
    const ignoredSectionBox = await ignoredSection.boundingBox();
    const ignoredGridBox = await ignoredSection.locator(".session-grid").boundingBox();
    expect(ignoredSectionBox).not.toBeNull();
    expect(ignoredGridBox).not.toBeNull();
    expect(ignoredGridBox!.x).toBeGreaterThan(ignoredSectionBox!.x);
    expect(ignoredGridBox!.x + ignoredGridBox!.width)
      .toBeLessThanOrEqual(ignoredSectionBox!.x + ignoredSectionBox!.width);
    const restoreButton = ignoredSection.getByRole("button", {
      name: `Remove ${sessionName} from ignored`,
    });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    await expect(ignoredSection).toBeVisible();
    await expect(ignoredSection.locator(".ignored-section-count")).toHaveText("0");
    await expect(page.getByText("0 starred / 1 filtered / 0 ignored")).toBeVisible();
    const restoredIgnoreButton = page.getByRole("button", { name: `Ignore ${sessionName}` });
    await expect(restoredIgnoreButton).toBeEnabled();
    await expect(restoredIgnoreButton).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    restored = true;
  } finally {
    if (!restored) {
      await request.put("/mux/api/session-ignored", {
        data: { session: sessionName, ignored: false },
      });
    }
  }
});

test("mobile dashboard manages memoranda and sends acknowledged staged input", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/mux/");
  await expect(page.getByRole("heading", { name: "Muxdeck", exact: true })).toBeVisible();
  await expect(page.locator(".session-card").first()).toBeVisible();
  await expect.poll(() => page.locator(".session-card").count()).toBe(1);
  await expect(page.getByRole("link", { name: `Open ${sessionName} in new window` })).toHaveCSS("height", "44px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/dashboard-mobile.png", fullPage: true });

  await page.getByRole("button", { name: "claude", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
  await page.getByRole("button", { name: "shells", exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${sessionName}` })).toBeVisible();
  await page.getByRole("button", { name: "all", exact: true }).click();

  const cardMemoButton = page.getByRole("button", { name: `Manage memoranda for ${sessionName}` });
  await cardMemoButton.click();
  await expect(page).toHaveURL(/\/mux\/$/);
  let queueDialog = page.getByRole("dialog", { name: "Queued messages" });
  await expect(queueDialog).toBeVisible();
  const addMessage = queueDialog.getByRole("textbox", { name: "Add a message" });
  await expect(addMessage).toHaveCSS("font-size", "16px");
  await addMessage.fill(originalQueuedCommand);
  await queueDialog.getByRole("button", { name: "Add to queue" }).click();
  await expect(queueDialog.locator(".mq-message-text")).toHaveText(originalQueuedCommand);
  await queueDialog.getByRole("button", { name: "Close queued messages" }).click();
  await expect(cardMemoButton.locator("span")).toHaveText("1", { timeout: 10_000 });

  await page.getByRole("button", { name: "List" }).click();
  await expect(page.locator(".session-row")).toHaveCount(1);
  const rowMemoButton = page.getByRole("button", { name: `Manage memoranda for ${sessionName}` });
  await rowMemoButton.click();
  await expect(page).toHaveURL(/\/mux\/\?view=list$/);
  queueDialog = page.getByRole("dialog", { name: "Queued messages" });
  await queueDialog.getByRole("button", { name: "Edit", exact: true }).click();
  const editMessage = queueDialog.getByRole("textbox", { name: "Edit queued message 1" });
  await expect(editMessage).toHaveCSS("font-size", "16px");
  await editMessage.fill(editedQueuedCommand);
  await queueDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(queueDialog.locator(".mq-message-text")).toHaveText(editedQueuedCommand);
  await queueDialog.getByRole("button", { name: "Close queued messages" }).click();
  await page.screenshot({ path: "artifacts/dashboard-mobile-list.png", fullPage: true });
  await page.getByRole("button", { name: "Group None" }).click();
  await expect(page.locator(".state-group-header").getByRole("heading", { name: "Other" })).toBeVisible();
  await page.screenshot({ path: "artifacts/dashboard-mobile-state-groups.png", fullPage: true });
  await page.getByRole("button", { name: "Cards" }).click();

  await page.getByLabel("Find a session").fill(sessionName);
  await page.getByRole("button", { name: `Add ${sessionName} to starred` }).click();
  await expect(page.getByRole("heading", { name: "Starred" })).toBeVisible();
  await page.getByRole("button", { name: `Remove ${sessionName} from starred` }).click();
  await expect(page.getByRole("heading", { name: "Starred" })).toBeHidden();
  await page.getByRole("button", { name: `Add ${sessionName} to starred` }).click();
  await expect(page.getByRole("heading", { name: "Starred" })).toBeVisible();
  await page.getByRole("button", { name: `Edit title for ${sessionName}` }).click();
  await page.getByRole("textbox", { name: "Human title" }).fill("Browser E2E");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("button", { name: "Open Browser E2E" })).toBeVisible();
  await page.getByRole("button", { name: "Open Browser E2E" }).click();
  await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Raw terminal keyboard" })).toBeEnabled();
  let stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toBeVisible();
  await expect(stagedInput).toHaveCSS("font-size", "16px");

  await page.getByRole("button", { name: "Edit display title" }).click();
  await page.getByRole("textbox", { name: "Human title" }).fill("Console E2E");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("heading", { name: "Console E2E" })).toBeVisible();

  const retainedCommand = "for i in $(seq 1 100); do echo BROWSER_E2E_OK_$i; done";
  await stagedInput.fill(retainedCommand);
  await expect.poll(() => page.evaluate(
    (key) => window.localStorage.getItem(key),
    `muxdeck-terminal-draft:${sessionName}`,
  )).toBe(retainedCommand);
  await page.reload({ waitUntil: "domcontentloaded" });
  stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toHaveValue(retainedCommand);
  const sendWithEnter = page.getByRole("button", { name: "Send + Enter" });
  await expect(sendWithEnter).toBeEnabled({ timeout: 10_000 });
  await expect(sendWithEnter).toHaveAttribute("aria-keyshortcuts", "Shift+Enter");
  await stagedInput.press("Shift+Enter");
  await expect(stagedInput).toHaveValue("");
  await expect(page.locator(".composer-status")).toContainText("Written once to the attached tmux PTY");
  await expect.poll(() => page.evaluate(
    (key) => window.localStorage.getItem(key),
    `muxdeck-terminal-draft:${sessionName}`,
  )).toBeNull();

  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("BROWSER_E2E_OK_100");

  await page.getByRole("button", { name: "Open memoranda" }).click();
  queueDialog = page.getByRole("dialog", { name: "Queued messages" });
  await queueDialog.getByRole("button", { name: "Use", exact: true }).click();
  await expect(queueDialog).not.toBeVisible();
  await expect(stagedInput).toHaveValue(editedQueuedCommand);
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect(stagedInput).toHaveValue("");
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("MEMO_QUEUE_EDITED");

  await page.getByRole("button", { name: "Open memoranda" }).click();
  queueDialog = page.getByRole("dialog", { name: "Queued messages" });
  await queueDialog.getByRole("button", { name: "Send now" }).click();
  await expect(queueDialog.locator(".mq-notice")).toContainText("Message sent");
  await expect.poll(() => {
    const captured = execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
    return captured.match(/MEMO_QUEUE_EDITED/g)?.length ?? 0;
  }).toBeGreaterThanOrEqual(2);
  await queueDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await queueDialog.getByRole("button", { name: "Confirm delete" }).click();
  await expect(queueDialog.getByText("The queue is empty.")).toBeVisible();
  await queueDialog.getByRole("button", { name: "Close queued messages" }).click();
  await expect(page.getByRole("button", { name: "Open memoranda" }).locator("span")).toHaveText("Memo", { timeout: 10_000 });

  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".staged-composer").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const terminalShortcuts = page.getByRole("group", { name: "Terminal input shortcuts" });
  expect(await terminalShortcuts.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const otherKeysToggle = terminalShortcuts.locator(".other-keys-toggle");
  await expect(otherKeysToggle).toHaveAccessibleName("Show other keys");
  await expect(otherKeysToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("group", { name: "Other keys" })).toHaveCount(0);
  await otherKeysToggle.click();
  const otherKeyPanel = page.getByRole("group", { name: "Other keys" });
  await expect(otherKeysToggle).toHaveAccessibleName("Hide other keys");
  await expect(otherKeysToggle).toHaveAttribute("aria-expanded", "true");
  await expect(otherKeyPanel.getByRole("button")).toHaveText(["Up", "Down", "Left", "Right"]);
  expect(await otherKeyPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/console-mobile-other-keys.png" });
  await otherKeysToggle.click();
  await expect(otherKeysToggle).toHaveAccessibleName("Show other keys");
  await expect(page.getByRole("group", { name: "Other keys" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open memoranda" }).click();
  queueDialog = page.getByRole("dialog", { name: "Queued messages" });
  expect(await queueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(queueDialog.getByRole("textbox", { name: "Add a message" })).toHaveCSS("font-size", "16px");
  await queueDialog.getByRole("button", { name: "Close queued messages" }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  await stagedInput.fill("IFS= read -rsn4 key; printf 'PAGE_UP_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("read -rsn4 key");
  await page.getByRole("button", { name: "PgUp" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain(String.raw`PAGE_UP_KEY=$'\E[5~'`);

  await stagedInput.fill("IFS= read -rsn4 key; printf 'PAGE_DOWN_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("PAGE_DOWN_KEY=%q");
  await page.getByRole("button", { name: "PgDn" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain(String.raw`PAGE_DOWN_KEY=$'\E[6~'`);

  await stagedInput.fill("IFS= read -rsn1 key; printf 'CTRL_A_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("CTRL_A_KEY=%q");
  await page.getByRole("button", { name: "Ctrl+A - move to start of input" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain(String.raw`CTRL_A_KEY=$'\001'`);

  await stagedInput.fill("IFS= read -rsn1 key; printf 'CTRL_E_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("CTRL_E_KEY=%q");
  await page.getByRole("button", { name: "Ctrl+E - move to end of input" }).click();
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain(String.raw`CTRL_E_KEY=$'\005'`);

  const paneFormat = (format: string) => execFileSync(
    "tmux",
    [...tmux, "display-message", "-p", "-t", paneId, format],
    { encoding: "utf8" },
  ).trim();
  await page.getByRole("button", { name: "Tmux Page Up" }).click();
  await expect.poll(() => paneFormat("#{pane_in_mode}")).toBe("1");
  await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBeGreaterThan(0);
  const scrollPosition = Number(paneFormat("#{scroll_position}"));
  await page.getByRole("button", { name: "Tmux Page Down" }).click();
  await expect.poll(() => Number(paneFormat("#{scroll_position}"))).toBeLessThan(scrollPosition);
  await page.getByRole("button", { name: "^C" }).click();
  await expect.poll(() => paneFormat("#{pane_in_mode}")).toBe("0");
  await page.screenshot({ path: "artifacts/console-mobile.png" });

  await page.getByRole("button", { name: "Pane scrollback" }).click();
  await expect(page.getByRole("heading", { name: "Scrollback" })).toBeVisible();
  await expect(page.locator(".history-scroll pre")).toContainText("BROWSER_E2E_OK_100");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/history-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Close history" }).click();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  const emptyMemoButton = page.getByRole("button", { name: "Manage memoranda for Console E2E" });
  await expect(emptyMemoButton).toBeVisible();
  await expect(emptyMemoButton.locator("span")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("native tmux rename preserves alias, workspace order, draft, and metadata", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const helperSession = `${sessionName}-rename-helper`;
  const renamedSession = `${sessionName}-renamed`;

  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    helperSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);

  try {
    await request.put("/mux/api/session-title", {
      data: { session: sessionName, title: "Rename E2E" },
    });
    await request.put("/mux/api/session-star", {
      data: { session: sessionName, starred: true },
    });
    const queued = await request.post(
      `/mux/api/sessions/${encodeURIComponent(sessionName)}/messages`,
      { data: { text: "Persist across native rename" } },
    );
    expect(queued.ok()).toBe(true);
    const queuedMessage = (await queued.json()).message;

    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(
      `/mux/?kind=shells&tab=${encodeURIComponent(sessionName)}`
      + `&tab=${encodeURIComponent(helperSession)}`,
    );
    await page.getByRole("button", { name: "Open Rename E2E" }).click();
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, helperSession],
      { kind: "shells" },
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    const stagedInput = page.getByRole("textbox", { name: "Staged input" });
    await stagedInput.fill("keep this unsent draft");
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      `muxdeck-terminal-draft:${sessionName}`,
    )).toBe("keep this unsent draft");

    const aliasButton = page.getByRole("button", { name: "Edit display title" });
    const renameButton = page.getByRole("button", { name: "Rename tmux session" });
    const primaryShortcuts = [
      aliasButton,
      renameButton,
      page.getByRole("button", { name: "Open memoranda" }),
      page.getByRole("button", { name: "Open snippets" }),
    ];
    const primaryShortcutBoxes = [];
    for (const button of primaryShortcuts) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      primaryShortcutBoxes.push(box!);
    }
    for (let index = 1; index < primaryShortcutBoxes.length; index += 1) {
      const previous = primaryShortcutBoxes[index - 1];
      const current = primaryShortcutBoxes[index];
      expect(previous.x + previous.width).toBeLessThanOrEqual(current.x);
    }
    const lastShortcut = primaryShortcutBoxes.at(-1)!;
    expect(lastShortcut.x + lastShortcut.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const historyLength = await page.evaluate(() => window.history.length);
    await renameButton.click();
    const renameDialog = page.getByRole("dialog", { name: "Rename tmux session" });
    await expect(renameDialog).toContainText("separate Muxdeck display title is preserved");
    await page.setViewportSize({ width: 320, height: 300 });
    const compactDialogBox = await renameDialog.boundingBox();
    expect(compactDialogBox).not.toBeNull();
    expect(compactDialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(compactDialogBox!.y + compactDialogBox!.height).toBeLessThanOrEqual(300);
    await expect(renameDialog.getByRole("button", { name: "Rename session" })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    await renameDialog.getByRole("textbox", { name: "Native tmux name" })
      .fill(renamedSession);
    await renameDialog.getByRole("button", { name: "Rename session" }).click();

    await expectRoute(
      page,
      `/mux/session/${renamedSession}`,
      [renamedSession, helperSession],
      { kind: "shells" },
    );
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
    await expect(page.getByRole("heading", { name: "Rename E2E" })).toBeVisible();
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect(page.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("keep this unsent draft");
    expect(await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `muxdeck-terminal-draft:${sessionName}`,
    )).toBeNull();
    expect(await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `muxdeck-terminal-draft:${renamedSession}`,
    )).toBe("keep this unsent draft");

    const sessionsPayload = await (await request.get("/mux/api/sessions")).json();
    const renamedRecord = sessionsPayload.sessions.find(
      (session: { name: string }) => session.name === renamedSession,
    );
    expect(renamedRecord).toMatchObject({
      customTitle: "Rename E2E",
      starred: true,
      ignored: false,
    });
    expect(sessionsPayload.sessions.some(
      (session: { name: string }) => session.name === sessionName,
    )).toBe(false);
    const migratedQueue = await (
      await request.get(
        `/mux/api/sessions/${encodeURIComponent(renamedSession)}/messages`,
      )
    ).json();
    expect(migratedQueue.messages).toEqual([queuedMessage]);

    const nativeNames = execFileSync(
      "tmux",
      [...tmux, "list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    ).trim().split("\n");
    expect(nativeNames).toContain(renamedSession);
    expect(nativeNames).not.toContain(sessionName);

    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expectRoute(
      page,
      "/mux/",
      [renamedSession, helperSession],
      { kind: "shells" },
    );
    await page.goForward();
    await expectRoute(
      page,
      `/mux/session/${renamedSession}`,
      [renamedSession, helperSession],
      { kind: "shells" },
    );

    // Reusing the released native name must not be swallowed by the old-name
    // browser-history redirect, because it now belongs to a different tmux ID.
    execFileSync("tmux", [
      ...tmux,
      "new-session",
      "-d",
      "-s",
      sessionName,
      "bash",
      "--noprofile",
      "--norc",
    ]);
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expectRoute(
      page,
      "/mux/",
      [renamedSession, helperSession],
      { kind: "shells" },
    );
    const reusedSessionButton = page.getByRole("button", {
      name: `Open ${sessionName}`,
      exact: true,
    });
    await expect(reusedSessionButton).toBeVisible({ timeout: 10_000 });
    await reusedSessionButton.click();
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [renamedSession, helperSession, sessionName],
      { kind: "shells" },
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${helperSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to this test's helper session on the disposable socket.
    }
  }
});
